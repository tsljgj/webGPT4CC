// Worker-tab lifecycle against the fake chatgpt.com: a navigation that first lands
// on a self-reloading Cloudflare interstitial, a person typing into the worker tab
// while a job sends, and a job cancelled while its navigation is still loading.
// Jobs are driven through the bridge's provider directly (no claude CLI needed).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChatEvent } from '../../bridge/src/providers/types.ts';
import type { FakeLlm } from './fake-chatgpt/backend.ts';
import { type Chain, describeEvents, extensionSkipReason, finalEvent, newJob, runProviderJob, startChain, waitFor } from './harness.ts';

const skip = extensionSkipReason();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Done = Extract<ChatEvent, { type: 'done' }>;
type Failed = Extract<ChatEvent, { type: 'error' }>;

describe('worker-tab lifecycle', { skip, timeout: 600_000 }, () => {
  let chain: Chain;
  let llm: FakeLlm = (p) => `Echo: ${p.slice(0, 60)}`;

  before(async () => {
    chain = await startChain({ fake: { llm: (p, c) => llm(p, c), hydrationDelayMs: 100 }, bridge: { workerWaitMs: 15_000 } });
  });
  after(async () => {
    await chain?.close();
  });

  const provider = () => chain.bridge.provider;
  async function scenario(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(chain.diagnostics());
      throw e;
    }
  }

  it('a navigation that first lands on a self-reloading Cloudflare check still runs the job (once)', () =>
    scenario(async () => {
      let armed = true;
      const challenge = `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser…</div><script>setTimeout(() => location.reload(), 2000)</script></body></html>`;
      const pattern = /^https:\/\/chatgpt\.com\/(\?.*)?$/;
      const handler = async (route: import('playwright').Route) => {
        if (armed && route.request().resourceType() === 'document') {
          armed = false;
          await route.fulfill({ status: 403, contentType: 'text/html', headers: { 'cf-mitigated': 'challenge' }, body: challenge });
          return;
        }
        await route.fallback();
      };
      await chain.browser.context.route(pattern, handler);
      try {
        const r0 = chain.fake.requests.length;
        // A model makes the URL differ from the tab's, so the job navigates.
        const events = await runProviderJob(provider(), newJob({ prompt: 'through the interstitial', model: 'gpt-5-6-thinking' }));
        assert.equal(finalEvent(events).type, 'done', describeEvents(events));
        assert.equal(armed, false, 'the interstitial was served');
        assert.equal(chain.fake.requests.length, r0 + 1, 'sent exactly once');
      } finally {
        await chain.browser.context.unroute(pattern, handler);
      }
    }));

  it('text typed into the worker tab while a job sends is never sent with the prompt', () =>
    scenario(async () => {
      await chain.page.bringToFront();
      const prompt = 'tool result: 42';
      const r0 = chain.fake.requests.length;
      const p = runProviderJob(provider(), newJob({ prompt }));
      await waitFor(
        'the pasted prompt',
        () => chain.page.evaluate(() => (window as unknown as { __fakeChatGPT: { composerText(): string } }).__fakeChatGPT.composerText().includes('tool result')),
        15_000,
        10,
      );
      await chain.page.keyboard.type(' and rm -rf /tmp/x');
      const events = await p;
      const fin = finalEvent(events) as Failed;
      assert.equal(fin.type, 'error', describeEvents(events));
      assert.equal(fin.code, 'ui_error');
      assert.match(fin.message, /changed before sending/);
      assert.equal(chain.fake.requests.length, r0, 'nothing was sent');
      // The tab works again once the person stops typing.
      await sleep(500);
      const next = await runProviderJob(provider(), newJob({ prompt: 'after the typing' }));
      assert.equal(finalEvent(next).type, 'done', describeEvents(next));
      assert.equal(chain.fake.requests.at(-1)!.prompt, 'after the typing');
    }));

  it("a workspace account's conversation is read back with the page's own Chatgpt-Account-Id", () =>
    scenario(async () => {
      chain.fake.options.accountId = 'ws-account-1';
      const reply = `Workspace answer.\n${'More of it.\n'.repeat(20)}`;
      llm = () => ({ text: reply, cutStream: 'mid-answer' });
      try {
        await chain.page.reload();
        await waitFor('the worker', () => chain.bridge.provider.status().workers.some((w) => w.ready), 20_000);
        const events = await runProviderJob(provider(), newJob({ prompt: 'workspace question' }));
        const fin = finalEvent(events) as Done;
        assert.equal(fin.type, 'done', describeEvents(events));
        assert.equal(fin.text, reply, 'read back from GET /backend-api/conversation/{id}');
      } finally {
        chain.fake.options.accountId = null;
        llm = (p) => `Echo: ${p.slice(0, 60)}`;
        await chain.page.reload();
        await waitFor('the worker', () => chain.bridge.provider.status().workers.some((w) => w.ready), 20_000);
      }
    }));

  it('a model the page did not apply (?model= ignored) is reported to the bridge', () =>
    scenario(async () => {
      chain.fake.options.ignoreModelParam = true;
      try {
        const events = await runProviderJob(provider(), newJob({ prompt: 'which model?', model: 'gpt-5-6-thinking' }));
        const fin = finalEvent(events) as Done & { requestedModel?: string; actualModel?: string };
        assert.equal(fin.type, 'done', describeEvents(events));
        assert.equal(fin.requestedModel, 'gpt-5-6-thinking');
        assert.equal(fin.actualModel, 'auto');
        assert.ok(events.some((e) => e.ev.type === 'status' && e.ev.status === 'model_mismatch'), describeEvents(events));
        assert.match(chain.bridge.logs.tail(200), /requested "gpt-5-6-thinking", the ChatGPT page sent "auto"/);
      } finally {
        chain.fake.options.ignoreModelParam = false;
      }
    }));

  it('the text ChatGPT received is compared exactly: an escaping composer is reported to the bridge', () =>
    scenario(async () => {
      chain.fake.options.sendTransform = 'escape-markdown';
      try {
        await chain.page.reload();
        await waitFor('the worker', () => chain.bridge.provider.status().workers.some((w) => w.ready), 20_000);
        const prompt = 'old_string: a * b \\ c_d';
        const events = await runProviderJob(provider(), newJob({ prompt }));
        const fin = finalEvent(events) as Done & { promptMismatch?: { kinds: string[]; offset: number } };
        assert.equal(fin.type, 'done', describeEvents(events));
        assert.deepEqual(fin.promptMismatch?.kinds, ['backslash-escape']);
        assert.equal(fin.promptMismatch?.offset, prompt.indexOf('_'), 'first change: old_string -> old\\_string');
        assert.ok(events.some((e) => e.ev.type === 'status' && e.ev.status === 'prompt_mismatch'));
        assert.match(chain.bridge.logs.tail(200), /the text ChatGPT received differs from the prompt/);
      } finally {
        chain.fake.options.sendTransform = 'none';
      }
    }));

  it('a large prompt that ChatGPT received cut short is stopped and fails as too_long', () =>
    scenario(async () => {
      chain.fake.options.sendTransform = 'truncate-half';
      llm = () => ({ text: 'a reply to half a prompt', delayMs: 3000 });
      try {
        await chain.page.reload();
        await waitFor('the worker', () => chain.bridge.provider.status().workers.some((w) => w.ready), 20_000);
        const stops0 = (await chain.page.evaluate(() => (window as unknown as { __fakeChatGPT: { state: { stops: number } } }).__fakeChatGPT.state.stops));
        const prompt = Array.from({ length: 600 }, (_, i) => `line ${i}: some tool output to read`).join('\n');
        const events = await runProviderJob(provider(), newJob({ prompt }));
        const fin = finalEvent(events) as Failed;
        assert.equal(fin.code, 'too_long', describeEvents(events));
        assert.match(fin.message, /sent only \d+ of the \d+ characters/);
        await waitFor(
          'the reply to be stopped',
          async () => (await chain.page.evaluate(() => (window as unknown as { __fakeChatGPT: { state: { stops: number } } }).__fakeChatGPT.state.stops)) > stops0,
          10_000,
        );
      } finally {
        chain.fake.options.sendTransform = 'none';
        llm = (p) => `Echo: ${p.slice(0, 60)}`;
        await chain.page.reload();
        await waitFor('the worker', () => chain.bridge.provider.status().workers.some((w) => w.ready), 20_000);
      }
    }));

  it('a job cancelled while its navigation loads does not hand the tab to the next job too early', () =>
    scenario(async () => {
      const y = (finalEvent(await runProviderJob(provider(), newJob({ prompt: 'conversation Y' }))) as Done).conversationId;
      const x = (finalEvent(await runProviderJob(provider(), newJob({ prompt: 'conversation X' }))) as Done).conversationId;
      assert.equal(new URL(chain.page.url()).pathname, `/c/${x}`);
      const pattern = new RegExp(`^https://chatgpt\\.com/c/${y}`);
      const handler = async (route: import('playwright').Route) => {
        if (route.request().resourceType() === 'document') await sleep(1500); // a slow document load
        await route.fallback();
      };
      await chain.browser.context.route(pattern, handler);
      try {
        const ac = new AbortController();
        const a = runProviderJob(provider(), newJob({ prompt: 'A on Y', conversation: { kind: 'continue', conversationId: y } }), ac.signal);
        await sleep(200);
        ac.abort();
        await a;
        // B continues X, the conversation the old (about to be replaced) document still shows.
        const r0 = chain.fake.requests.length;
        const b = await runProviderJob(provider(), newJob({ prompt: 'B on X', conversation: { kind: 'continue', conversationId: x } }));
        assert.equal(finalEvent(b).type, 'done', describeEvents(b));
        const sent = chain.fake.requests.slice(r0);
        assert.equal(sent.length, 1, 'B was sent once');
        assert.equal(sent[0]!.conversationId, x);
        assert.equal(new URL(chain.page.url()).pathname, `/c/${x}`);
      } finally {
        await chain.browser.context.unroute(pattern, handler);
      }
    }));
});
