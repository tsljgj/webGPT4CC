// Full chain: real `claude -p` -> bridge (in-process) -> webGPT4CC extension
// (unpacked, Chromium) -> fake chatgpt.com (Playwright routing).
//
// Skipped until extension/manifest.json exists (and when the claude CLI is missing).
// Scenarios share one browser, bridge and worker tab and run in order; the 429
// scenario must stay last because the bridge then fails fast for `clears_in`.
// SSE bodies stream in small slices over time (the fake's loopback stream server).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { ChatEvent } from '../../bridge/src/providers/types.ts';
import type { FakeLlm, RecordedRequest } from './fake-chatgpt/backend.ts';
import { reduceSse } from './fake-chatgpt/delta.ts';
import { chainSkipReason, type Chain, type ClaudeRun, runClaude, startChain, tempDir, waitForWorker } from './harness.ts';

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
  // Claude Code helper requests (titles, summaries...) that the bridge may forward as one-off temporary chats.
  const isHelperPrompt = (p: string) => !p.includes('# Bridge instructions') && !p.includes('<tool_result');

  // Scratch working directories for the claude runs (removed at the end).
  const workDirs: string[] = [];
  const workDir = () => {
    const d = tempDir('work');
    workDirs.push(d);
    return d;
  };

  before(async () => {
    // A short workerWaitMs keeps the logged-out scenario quick (one worker, so affinity waits do not matter).
    chain = await startChain({ fake: { llm: (prompt, ctx) => llm(prompt, ctx) }, bridge: { workerWaitMs: 8_000 } });
  });
  after(async () => {
    await chain?.close();
    for (const d of workDirs) rmSync(d, { recursive: true, force: true });
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
      const work = workDir();
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
      const main = requests.filter((r) => !isHelperPrompt(r.prompt));
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
      // The SSE body arrives in slices, so the first turn streams: the reasoning summary
      // as status "thinking" (never the answer), then growing `text` prefixes of the reply.
      // (Whole-body delivery, the no-openssl fallback, reaches the page in one read.)
      const streamed = r1.delivery === 'stream';
      const firstJob = events.find((e) => e.event.type === 'done')!.jobId;
      const thinking = events
        .filter((e) => e.jobId === firstJob && e.event.type === 'status' && e.event.status === 'thinking' && e.event.detail)
        .map((e) => (e.event as { detail: string }).detail);
      if (streamed) assert.ok(thinking.length >= 1, 'the reasoning summary was streamed as status "thinking"');
      for (const d of thinking) {
        assert.match(d, /^Reading the request/);
        assert.doesNotMatch(d, /<tool_call|Creating the file now\.\n.*I'll create/s);
      }
      const texts = events.filter((e) => e.jobId === firstJob && e.event.type === 'text').map((e) => (e.event as { text: string }).text);
      if (streamed) assert.ok(texts.length >= 1, 'text events streamed before done');
      texts.forEach((x, i) => {
        assert.ok(firstReply.startsWith(x), `text event ${i} is not a prefix of the final reply: ${JSON.stringify(x.slice(-60))}`);
        if (i) assert.ok(x.length >= texts[i - 1]!.length, `text event ${i} shrank`);
      });
      // The worker tab ends up on the conversation URL.
      assert.equal(new URL(chain.page.url()).pathname, `/c/${r1.responseConversationId}`);
    }),
  );

  it('scenario 2: reply delivered over the stream_handoff WebSocket', { timeout: 300_000 }, (t) =>
    scenario(t, async () => {
      const work = workDir();
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

        const main = requests.filter((r) => !isHelperPrompt(r.prompt));
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

  it('scenario 3: a stream that breaks mid-answer is recovered from the conversation API, then continued', { timeout: 300_000 }, (t) =>
    scenario(t, async () => {
      const work = workDir();
      const target = join(work, 'recovered.txt');
      const content = 'line 1\n  line 2 (indented)\n<tag> & "quotes"\n';
      const firstReply = `Writing the file.\n<tool_call name="Write">\n<param name="file_path">${target}</param>\n<param name="content">\n${content}</param>\n</tool_call>`;
      llm = (prompt) => {
        // The connection drops halfway through the tool call: the page only ever holds a truncated reply.
        if (prompt.includes('# Bridge instructions')) return { text: firstReply, cutStream: 'mid-answer' };
        if (prompt.includes('<tool_result')) return 'Recovered and done.';
        return 'OK';
      };
      const { result: run, requests, events } = await capture(() => runClaude({ config: chain.bridge.config, prompt: 'write recovered.txt', cwd: work }));
      t.diagnostic(summary(run).split('\n')[0]!);
      assert.equal(run.timedOut, false, summary(run));
      assert.equal(run.code, 0, summary(run));
      assert.equal(run.json?.result, 'Recovered and done.', summary(run));
      assert.equal(readFileSync(target, 'utf8'), content);

      const main = requests.filter((r) => !isHelperPrompt(r.prompt));
      assert.equal(main.length, 2, 'no retry: the broken turn was recovered, not re-sent');
      assert.equal(main[0]!.cut, true);
      assert.equal(reduceSse(main[0]!.responseBody!).complete, false, 'the wire only carried part of the reply');
      assert.equal(main[1]!.conversationId, main[0]!.responseConversationId, 'the recovered conversation is continued');
      assert.equal(main[1]!.parentMessageId, main[0]!.assistantMessageId);

      const firstJob = events.find((e) => e.event.type === 'done')!.jobId;
      assert.ok(
        events.some((e) => e.jobId === firstJob && e.event.type === 'status' && e.event.status === 'recovering'),
        'the extension reported status "recovering"',
      );
      const done = events.find((e) => e.jobId === firstJob && e.event.type === 'done')!.event as Extract<ChatEvent, { type: 'done' }>;
      assert.equal(done.text, firstReply, 'the full reply was read back from GET /backend-api/conversation/{id}');
      assert.equal(done.messageId, main[0]!.assistantMessageId);
    }),
  );

  it('scenario 4: `claude --continue` after another session navigates the tab back to the first ChatGPT conversation', { timeout: 300_000 }, (t) =>
    scenario(t, async () => {
      const workA = workDir();
      const workB = workDir();
      const homeA = workDir(); // session A's Claude Code state, kept for --continue
      llm = (prompt) => {
        if (prompt.includes('now say bye')) return 'A says bye.';
        if (prompt.includes('session B:')) return 'B says hi.';
        if (prompt.includes('session A:')) return 'A says hi.';
        return 'OK';
      };
      const { result: runs, requests, events } = await capture(async () => [
        await runClaude({ config: chain.bridge.config, prompt: 'session A: say hi', cwd: workA, home: homeA }),
        await runClaude({ config: chain.bridge.config, prompt: 'session B: say hi', cwd: workB }),
        await runClaude({ config: chain.bridge.config, prompt: 'now say bye', cwd: workA, home: homeA, args: ['--continue'] }),
      ]);
      for (const run of runs) t.diagnostic(summary(run).split('\n')[0]!);
      assert.deepEqual(
        runs.map((r) => [r.code, r.json?.result]),
        [
          [0, 'A says hi.'],
          [0, 'B says hi.'],
          [0, 'A says bye.'],
        ],
        runs.map(summary).join('\n'),
      );
      const find = (text: string) => {
        const r = requests.find((x) => x.prompt.includes(text));
        assert.ok(r, `a ChatGPT request containing ${JSON.stringify(text)}`);
        return r;
      };
      const a1 = find('session A:');
      const b1 = find('session B:');
      const a2 = find('now say bye');
      assert.equal(a1.conversationId, undefined);
      assert.equal(b1.conversationId, undefined, 'session B started its own chat');
      assert.notEqual(b1.responseConversationId, a1.responseConversationId);
      // The resumed session continues ChatGPT conversation A with only the new turn.
      assert.equal(a2.conversationId, a1.responseConversationId, 'resumed session A continues its ChatGPT conversation');
      assert.equal(a2.parentMessageId, a1.assistantMessageId);
      assert.equal(a2.parentIsCurrentNode, true);
      assert.doesNotMatch(a2.prompt, /# Bridge instructions|session A:/, 'only the new turn is sent');
      // The tab was on conversation B, so the extension navigated to /c/<A> and the page loaded it.
      const lastJob = events.findLast((e) => e.event.type === 'done')!.jobId;
      assert.ok(
        events.some((e) => e.jobId === lastJob && e.event.type === 'status' && e.event.status === 'navigating'),
        'the extension navigated for the continued conversation',
      );
      assert.equal(new URL(chain.page.url()).pathname, `/c/${a1.responseConversationId}`);
    }),
  );

  it('scenario 5: a logged-out worker tab fails the request after workerWaitMs instead of hanging', { timeout: 180_000 }, (t) =>
    scenario(t, async () => {
      const work = workDir();
      llm = () => 'should not be called';
      const provider = chain.bridge.provider;
      chain.fake.options.loggedIn = false;
      try {
        await chain.page.reload();
        // The extension keeps the tab registered but reports it as not ready (login screen).
        await waitForWorker(provider, (w) => !w.ready && !w.busy, 20_000);
        const { result: run, requests } = await capture(() => runClaude({ config: chain.bridge.config, prompt: 'say hi', cwd: work, timeoutMs: 150_000 }));
        t.diagnostic(summary(run).split('\n')[0]!);
        assert.equal(run.timedOut, false, summary(run));
        assert.ok(run.code !== 0 || run.json?.is_error === true, `claude should fail: ${summary(run)}`);
        assert.match(String(run.json?.result ?? run.stdout), /none is ready|logged out/i, summary(run));
        const waitMs = chain.bridge.config.workerWaitMs;
        assert.ok(run.durationMs < waitMs + 30_000, `took ${run.durationMs} ms (workerWaitMs ${waitMs})`);
        assert.equal(requests.length, 0, 'nothing was sent to ChatGPT');
      } finally {
        chain.fake.options.loggedIn = true;
        await chain.page.reload();
        await waitForWorker(provider);
      }
    }),
  );

  it('scenario 6: ChatGPT HTTP 429 becomes a quick, non-retried claude error (keep last)', { timeout: 180_000 }, (t) =>
    scenario(t, async () => {
      const work = workDir();
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
