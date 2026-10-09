// The extension against a fake chatgpt.com in the shape the primary user sees:
// a Simplified Chinese UI on the 2026-09 layout. No data-testid anywhere, every
// label localized, and one primary composer button (type="button", no id) whose
// label cycles voice -> send -> stop. The send and stop labels are overridden
// with texts no selector can know, and synthetic Enter is ignored, so these
// scenarios only pass when the extension works from structure and network state.
//
// Jobs are driven through the bridge's provider directly (no claude CLI needed).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChatEvent } from '../../bridge/src/providers/types.ts';
import type { FakeLlm } from './fake-chatgpt/backend.ts';
import {
  type Chain,
  describeEvents,
  extensionSkipReason,
  fakePageState,
  finalEvent,
  newJob,
  runProviderJob,
  startChain,
  waitFor,
  waitForWorker,
} from './harness.ts';

// `chrome` and the automation hook only exist inside the extension's service worker.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const skip = extensionSkipReason();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Done = Extract<ChatEvent, { type: 'done' }>;
type Failed = Extract<ChatEvent, { type: 'error' }>;

describe('zh-CN UI on the 2026-09 composer (structure- and network-based extension)', { skip, timeout: 600_000 }, () => {
  let chain: Chain;
  let llm: FakeLlm = (p) => `Echo: ${p.slice(0, 40)}`;

  before(async () => {
    chain = await startChain({
      fake: {
        llm: (p, c) => llm(p, c),
        locale: 'zh-CN',
        composerButton: 'cycle',
        trustedEnterOnly: true,
        // Labels nobody can know in advance (no "发送", no "停止").
        labels: { send: '提交', stop: '结束回复' },
        hydrationDelayMs: 100,
      },
      bridge: { workerWaitMs: 6_000 },
    });
  });
  after(async () => {
    await chain?.close();
  });

  const provider = () => chain.bridge.provider;
  async function reloadWorker(): Promise<void> {
    await chain.page.reload();
    await waitForWorker(provider());
  }
  async function workerStatus(): Promise<Any> {
    const st = (await chain.sw.evaluate(() => (globalThis as Any).webgpt4cc.status())) as Any;
    return st.workers[0];
  }
  async function scenario(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(chain.diagnostics());
      throw e;
    }
  }

  it('sends with the cycling primary button: no test ids, unknown labels, synthetic Enter ignored, voice never started', () =>
    scenario(async () => {
      const job = newJob({ prompt: 'zh send\n\tindented line\n<tag> & "quotes" 中文 😀' });
      const r0 = chain.fake.requests.length;
      const events = await runProviderJob(provider(), job);
      const fin = finalEvent(events);
      assert.equal(fin.type, 'done', describeEvents(events));
      assert.equal(chain.fake.requests.length, r0 + 1);
      assert.equal(chain.fake.requests.at(-1)!.prompt, job.prompt);
      const at = (s: string) => events.find((e) => e.ev.type === 'status' && e.ev.status === s)?.t ?? NaN;
      // The old selector chain found no send button here and waited 5 s before an Enter that this page ignores.
      assert.ok(at('submitted') - at('typing') < 3000, `typing -> submitted took ${at('submitted') - at('typing')} ms: ${describeEvents(events)}`);
      assert.equal((await fakePageState(chain.page)).voiceStarts, 0, 'voice mode was never started');
      // The page loads Cloudflare's bot-management script like the real site: not a challenge.
      assert.equal((await workerStatus()).cloudflare, false);
    }));

  it('switches a localized Work composer (输入框模式: 聊天 / 工作) to Chat before sending', () =>
    scenario(async () => {
      chain.fake.options.composerMode = 'work';
      try {
        await reloadWorker();
        const events = await runProviderJob(provider(), newJob({ prompt: 'in chat please' }));
        assert.equal(finalEvent(events).type, 'done', describeEvents(events));
        assert.equal(chain.fake.requests.at(-1)!.composerMode, 'chat');
      } finally {
        chain.fake.options.composerMode = 'chat';
      }
    }));

  it('stops and refuses a turn that ChatGPT sends in Work mode (an unrecognizable Chat/Work switch)', () =>
    scenario(async () => {
      chain.fake.options.composerMode = 'work';
      chain.fake.options.labels = { send: '提交', stop: '结束回复', chat: '模式甲', work: '模式乙' };
      try {
        await reloadWorker();
        const stops0 = (await fakePageState(chain.page)).stops;
        const r0 = chain.fake.requests.length;
        const events = await runProviderJob(provider(), newJob({ prompt: 'should not run in work' }));
        const fin = finalEvent(events) as Failed;
        assert.equal(fin.type, 'error', describeEvents(events));
        assert.equal(fin.code, 'aborted');
        assert.match(fin.message, /ran this turn in Work mode/);
        // The request body gave it away (before any reply token): conversation_mode "work".
        await waitFor('the Work request at the fake', () => chain.fake.requests.length > r0, 10_000);
        assert.equal(chain.fake.requests.at(-1)!.composerMode, 'work');
        await waitFor('the Work reply to be stopped', async () => (await fakePageState(chain.page)).stops > stops0, 10_000);
        assert.equal((await fakePageState(chain.page)).voiceStarts, 0);
      } finally {
        chain.fake.options.composerMode = 'chat';
        chain.fake.options.labels = { send: '提交', stop: '结束回复' };
        await reloadWorker();
      }
    }));

  it('cancel stops the reply without knowing the stop label, and the next job runs at once', () =>
    scenario(async () => {
      llm = (p) => (p.includes('SLOW') ? { text: 'slow reply that should have been stopped', delayMs: 12_000 } : `Echo: ${p.slice(0, 30)}`);
      try {
        const first = await runProviderJob(provider(), newJob({ prompt: 'first turn' }));
        const conv = { kind: 'continue' as const, conversationId: (finalEvent(first) as Done).conversationId };
        const stops0 = (await fakePageState(chain.page)).stops;
        const r0 = chain.fake.requests.length;
        const ac = new AbortController();
        const second = runProviderJob(provider(), newJob({ prompt: 'second turn SLOW', conversation: conv }), ac.signal);
        await waitFor('the slow request', () => chain.fake.requests.length > r0, 20_000);
        await sleep(500);
        ac.abort();
        await second;
        await waitFor('ChatGPT to stop generating', async () => !(await fakePageState(chain.page)).generating, 8_000);
        const st = await fakePageState(chain.page);
        assert.equal(st.stops, stops0 + 1, 'the reply was stopped once');
        assert.equal(st.voiceStarts, 0);
        const t0 = Date.now();
        const third = await runProviderJob(provider(), newJob({ prompt: 'third turn', conversation: conv }));
        assert.equal(finalEvent(third).type, 'done', describeEvents(third));
        assert.ok(Date.now() - t0 < 10_000, `the next job took ${Date.now() - t0} ms`);
      } finally {
        llm = (p) => `Echo: ${p.slice(0, 40)}`;
      }
    }));

  it('a dropped stream is read back once ChatGPT has finished, even when that takes longer than 15 s', () =>
    scenario(async () => {
      const reply = `Long answer.\n${'Line of the answer.\n'.repeat(30)}`;
      llm = () => ({ text: reply, cutStream: 'mid-answer' });
      chain.fake.options.answerInProgressForMs = 17_000;
      try {
        const events = await runProviderJob(provider(), newJob({ prompt: 'cut me off' }));
        const fin = finalEvent(events) as Done;
        assert.equal(fin.type, 'done', describeEvents(events));
        assert.equal(fin.text, reply);
        assert.ok(events.some((e) => e.ev.type === 'status' && e.ev.status === 'recovering'));
        assert.ok(events.at(-1)!.t >= 15_000, 'the answer was in progress for 17 s');
      } finally {
        chain.fake.options.answerInProgressForMs = 0;
        llm = (p) => `Echo: ${p.slice(0, 40)}`;
      }
    }));

  it('a localized usage-limit banner becomes rate_limited with its reset time', () =>
    scenario(async () => {
      chain.fake.options.uiBanner = '你已达到 GPT-5 Thinking 的使用上限。你的限额将在 20 分钟后重置。';
      try {
        await reloadWorker();
        const r0 = chain.fake.requests.length;
        const events = await runProviderJob(provider(), newJob({ prompt: 'over the limit' }));
        const fin = finalEvent(events) as Failed;
        assert.equal(fin.code, 'rate_limited', describeEvents(events));
        assert.equal(fin.retryAfterMs, 20 * 60_000);
        assert.equal(chain.fake.requests.length, r0, 'nothing was sent');
      } finally {
        chain.fake.options.uiBanner = null;
        await reloadWorker();
      }
    }));

  it('a 429 from Sentinel (the send is refused before any conversation request) becomes rate_limited at once', () =>
    scenario(async () => {
      chain.fake.options.rateLimit = { clearsInSec: 120 };
      chain.fake.options.rateLimitAt = 'sentinel';
      try {
        const r0 = chain.fake.requests.length;
        const t0 = Date.now();
        const events = await runProviderJob(provider(), newJob({ prompt: 'throttled' }));
        const fin = finalEvent(events) as Failed;
        assert.equal(fin.code, 'rate_limited', describeEvents(events));
        assert.equal(fin.retryAfterMs, 120_000);
        assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
        assert.equal(chain.fake.requests.length, r0);
      } finally {
        chain.fake.options.rateLimit = null;
        chain.fake.options.rateLimitAt = 'conversation';
        await reloadWorker(); // clear the error turn
      }
    }));

  it('a logged-out page with a guest composer and localized login buttons (no test ids) never gets the prompt', () =>
    scenario(async () => {
      chain.fake.options.loggedIn = false;
      chain.fake.options.guestComposer = true;
      try {
        await chain.page.reload();
        await waitFor('the worker to report the login', async () => (await workerStatus()).loginRequired === true, 20_000);
        const events = await runProviderJob(provider(), newJob({ prompt: 'my private source code' }));
        const fin = finalEvent(events) as Failed;
        assert.equal(fin.type, 'error', describeEvents(events));
        assert.ok(['no_worker', 'not_logged_in'].includes(fin.code), describeEvents(events));
        assert.equal(chain.fake.anonRequests.length, 0, 'nothing was sent as a guest');
        assert.equal((await fakePageState(chain.page)).anonSends, 0);
      } finally {
        chain.fake.options.loggedIn = true;
        chain.fake.options.guestComposer = false;
        await reloadWorker();
      }
    }));
});
