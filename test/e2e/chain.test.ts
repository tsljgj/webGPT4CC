// Full chain: real `claude -p` -> bridge (in-process) -> webGPT4CC extension
// (unpacked, Chromium) -> fake chatgpt.com (Playwright routing).
//
// Skipped until extension/manifest.json exists (and when the claude CLI is missing).
// Scenarios share one browser, bridge and worker tab and run in order; the 429
// scenario must stay last because the bridge then fails fast for `clears_in`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { ChatEvent } from '../../bridge/src/providers/types.ts';
import type { FakeLlm, RecordedRequest } from './fake-chatgpt/backend.ts';
import { chainSkipReason, type Chain, type ClaudeRun, runClaude, startChain, tempDir } from './harness.ts';

const skip = chainSkipReason();

/** Exact text comparison with a readable report of the first difference. */
function assertSameText(actual: string, expected: string, label: string): void {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const a = norm(actual);
  const e = norm(expected);
  if (a === e) return;
  let i = 0;
  while (i < a.length && i < e.length && a[i] === e[i]) i++;
  const show = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 80), i + 80));
  assert.fail(`${label}: texts differ at index ${i} (actual ${a.length} chars, expected ${e.length})\n  actual:   ${show(a)}\n  expected: ${show(e)}`);
}

function summary(run: ClaudeRun): string {
  return `claude exit=${run.code} signal=${run.signal} timedOut=${run.timedOut} ${run.durationMs}ms\nstdout: ${run.stdout.slice(0, 1500)}\nstderr: ${run.stderr.slice(0, 1500)}`;
}

describe('full chain: claude CLI -> bridge -> extension -> fake chatgpt.com', { skip, timeout: 900_000 }, () => {
  let chain: Chain;
  // The fake's scripted LLM delegates to this, so each scenario can script its own replies.
  let llm: FakeLlm = () => 'OK';
  const bridgeOnly = (p: string) => !p.includes('# Bridge instructions') && !p.includes('<tool_result');

  before(async () => {
    chain = await startChain({ fake: { llm: (prompt, ctx) => llm(prompt, ctx) } });
  });
  after(async () => {
    await chain?.close();
  });

  /** Run a scenario; on failure print every component's logs. */
  async function scenario(t: TestContext, fn: () => Promise<void>): Promise<void> {
    t.diagnostic(`worker tab ${chain.tabId} registered via ${chain.registeredVia}; extension ${chain.extensionId}`);
    try {
      await fn();
    } catch (e) {
      console.error(chain.diagnostics());
      throw e;
    }
  }

  /** Requests/jobs/events produced while `fn` runs. */
  async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; requests: RecordedRequest[]; jobs: typeof chain.bridge.provider.recordedJobs; events: Array<{ jobId: string; event: ChatEvent }> }> {
    const r0 = chain.fake.requests.length;
    const j0 = chain.bridge.provider.recordedJobs.length;
    const e0 = chain.bridge.provider.recordedEvents.length;
    const result = await fn();
    return {
      result,
      requests: chain.fake.requests.slice(r0),
      jobs: chain.bridge.provider.recordedJobs.slice(j0),
      events: chain.bridge.provider.recordedEvents.slice(e0),
    };
  }

  it('scenario 1: Write tool round trip over SSE, continued in the same ChatGPT conversation', { timeout: 300_000 }, (t) =>
    scenario(t, async () => {
      const work = tempDir('work');
      const target = join(work, 'hello.txt');
      // Characters that rendered DOM text would lose or mangle: markdown, indentation, tabs, HTML-ish text, a surrogate pair.
      const content = 'Hello from **webGPT4CC**\n  indented line\twith a tab\n\n<not-a-tag> & "quotes" 😀 中文\n';
      const firstReply = `I'll create the file.\n<tool_call name="Write">\n<param name="file_path">${target}</param>\n<param name="content">\n${content}</param>\n</tool_call>`;
      llm = (prompt) => {
        if (prompt.includes('# Bridge instructions')) return { text: firstReply, thoughts: ['Reading the request', 'Choosing the Write tool'], preamble: 'Creating the file now.' };
        if (prompt.includes('<tool_result')) return 'Done.';
        return 'OK';
      };
      const { result: run, requests, jobs, events } = await capture(() => runClaude({ config: chain.bridge.config, prompt: 'create hello.txt', cwd: work }));
      t.diagnostic(summary(run).split('\n')[0]!);

      assert.equal(run.timedOut, false, summary(run));
      assert.equal(run.code, 0, summary(run));
      assert.equal(run.json?.is_error, false, summary(run));
      assert.equal(run.json?.result, 'Done.', summary(run));
      assert.ok(existsSync(target), 'hello.txt was created');
      assert.equal(readFileSync(target, 'utf8'), content);

      // Two ChatGPT turns in ONE conversation: the second is a continuation carrying the tool result.
      const main = requests.filter((r) => !bridgeOnly(r.prompt));
      assert.equal(main.length, 2, `expected 2 ChatGPT turns, got ${requests.length}: ${JSON.stringify(requests.map((r) => r.prompt.slice(0, 60)))}`);
      const [r1, r2] = main as [RecordedRequest, RecordedRequest];
      assert.equal(r1.conversationId, undefined, 'first turn starts a new chat');
      assert.match(r1.prompt, /# Bridge instructions/);
      assert.equal(r2.conversationId, r1.responseConversationId, 'second turn continues the same conversation');
      assert.equal(r2.parentMessageId, r1.assistantMessageId, 'second turn answers the first reply');
      assert.match(r2.prompt, /<tool_result name="Write"/);
      assert.doesNotMatch(r2.prompt, /# Bridge instructions/);
      assert.equal(r1.composerMode, 'chat');

      // What reached ChatGPT is exactly what the bridge asked the extension to type.
      const mainJobs = jobs.filter((j) => j.purpose === 'main');
      assert.equal(mainJobs.length, 2);
      assert.equal(mainJobs[0]!.conversation.kind, 'new');
      assert.deepEqual(
        { kind: mainJobs[1]!.conversation.kind, id: mainJobs[1]!.conversation.kind === 'continue' ? mainJobs[1]!.conversation.conversationId : '' },
        { kind: 'continue', id: r1.responseConversationId },
      );
      assertSameText(r1.prompt, mainJobs[0]!.prompt, 'first prompt (bridge -> composer -> request)');
      assertSameText(r2.prompt, mainJobs[1]!.prompt, 'second prompt');

      // The extension reported the raw final-channel text (not thoughts, not the preamble, not DOM text).
      const dones = events.filter((e) => e.event.type === 'done').map((e) => e.event as Extract<ChatEvent, { type: 'done' }>);
      assert.equal(dones.length, 2);
      assert.equal(dones[0]!.text, firstReply);
      assert.equal(dones[0]!.conversationId, r1.responseConversationId);
      assert.equal(dones[0]!.messageId, r1.assistantMessageId);
      assert.equal(dones[1]!.text, 'Done.');
      assert.ok(
        events.some((e) => e.event.type === 'status' && e.event.status === 'submitted'),
        'the extension reports status "submitted"',
      );
      // The worker tab ends up on the conversation URL.
      assert.equal(new URL(chain.page.url()).pathname, `/c/${r1.responseConversationId}`);
    }),
  );

  it('scenario 2: reply delivered over the stream_handoff WebSocket', { timeout: 300_000 }, (t) =>
    scenario(t, async () => {
      const work = tempDir('work');
      const intro = 'Running the command now. '.repeat(30).trim();
      const firstReply = `${intro}\n<tool_call name="Bash">\n<param name="command">printf 'ws-%s\\n' ok > ws.txt</param>\n<param name="description">Write ws.txt</param>\n</tool_call>`;
      llm = (prompt) => {
        if (prompt.includes('# Bridge instructions')) return firstReply;
        if (prompt.includes('<tool_result')) return 'Handoff done.';
        return 'OK';
      };
      chain.fake.options.transport = 'ws';
      const subs0 = chain.fake.wsSubscriptions.length;
      try {
        const { result: run, requests, events } = await capture(() => runClaude({ config: chain.bridge.config, prompt: 'write ws.txt using bash', cwd: work }));
        t.diagnostic(summary(run).split('\n')[0]!);
        assert.equal(run.timedOut, false, summary(run));
        assert.equal(run.code, 0, summary(run));
        assert.equal(run.json?.result, 'Handoff done.', summary(run));
        assert.equal(readFileSync(join(work, 'ws.txt'), 'utf8'), 'ws-ok\n');

        const main = requests.filter((r) => !bridgeOnly(r.prompt));
        assert.equal(main.length, 2);
        assert.ok(main.every((r) => r.transport === 'ws'));
        assert.equal(main[0]!.conversationId, undefined, 'a new claude session starts a new chat');
        assert.equal(main[1]!.conversationId, main[0]!.responseConversationId);
        assert.ok(chain.fake.wsSubscriptions.length - subs0 >= 2, 'the page subscribed to the WebSocket topic for each turn');
        const dones = events.filter((e) => e.event.type === 'done').map((e) => e.event as Extract<ChatEvent, { type: 'done' }>);
        assert.equal(dones[0]!.text, firstReply, 'WS stream items were decoded once each (duplicates dropped)');
        assert.equal(dones[0]!.conversationId, main[0]!.responseConversationId);
        // The WS frames arrive over seconds, so the reply must stream as growing `text` events
        // (whole text so far; the bridge diffs them, so each must extend the previous one).
        const firstJob = events.find((e) => e.event.type === 'done')!.jobId;
        const texts = events.filter((e) => e.jobId === firstJob && e.event.type === 'text').map((e) => (e.event as { text: string }).text);
        assert.ok(texts.length >= 2, `expected streamed text events before done, got ${texts.length}`);
        texts.forEach((x, i) => {
          assert.ok(firstReply.startsWith(x), `text event ${i} is not a prefix of the final reply: ${JSON.stringify(x.slice(-60))}`);
          if (i) assert.ok(x.length >= texts[i - 1]!.length, `text event ${i} shrank`);
        });
      } finally {
        chain.fake.options.transport = 'sse';
      }
    }),
  );

  it('scenario 3: ChatGPT HTTP 429 becomes a quick, non-retried claude error (keep last)', { timeout: 180_000 }, (t) =>
    scenario(t, async () => {
      const work = tempDir('work');
      llm = () => 'should not be called';
      chain.fake.options.rateLimit = { clearsInSec: 3600 };
      try {
        const { result: run, requests, events } = await capture(() => runClaude({ config: chain.bridge.config, prompt: 'say hi', cwd: work, timeoutMs: 150_000 }));
        t.diagnostic(summary(run).split('\n')[0]!);
        assert.equal(run.timedOut, false, summary(run));
        assert.ok(run.code !== 0 || run.json?.is_error === true, `claude should fail: ${summary(run)}`);
        assert.equal(run.json?.api_error_status, 429, summary(run));
        assert.match(String(run.json?.result ?? ''), /usage limit|rate.?limit|429/i, summary(run));
        assert.ok(run.durationMs < 60_000, `took ${run.durationMs} ms (should fail fast, without retries)`);
        assert.equal(requests.length, 1, 'exactly one ChatGPT request (no retries)');
        assert.equal(requests[0]!.status, 429);
        const err = events.find((e) => e.event.type === 'error')?.event as Extract<ChatEvent, { type: 'error' }> | undefined;
        assert.equal(err?.code, 'rate_limited');
        assert.equal(err?.retryAfterMs, 3_600_000, 'detail.clears_in is reported as retryAfterMs');
      } finally {
        chain.fake.options.rateLimit = null;
      }
    }),
  );
});
