// Self-test of the fake chatgpt.com (no extension, no bridge): drives the fake
// the way the extension is specified to (docs/EXTENSION.md) and checks that it
// behaves like the 2026-09 site where it matters.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { FAKE_CONTEXT_OPTIONS, FakeChatGPT, type FakeOptions, parseSseEvents } from './fake-chatgpt/backend.ts';
import { DeltaReducer, reduceSse } from './fake-chatgpt/delta.ts';
import { chromiumSkipReason, HERMETIC_ARGS } from './harness.ts';

const COMPOSER = 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]';
const SEND = 'form button[aria-label="Send prompt"]';
const STOP = 'form button[aria-label="Stop"]';
const CHIP = 'form button[aria-label^="Remove Pasted text"]';
const ANSWER = '[data-content-search-unit-key$=":assistant"] [data-markdown-text-style="assistant-message"]';

let browser: Browser;
const contexts: BrowserContext[] = [];
const fakes: FakeChatGPT[] = [];
const skip = chromiumSkipReason();

async function launchBrowser(): Promise<void> {
  // The same full Chromium build the extension tests use (and that chromiumSkipReason checks).
  browser = await chromium.launch({ channel: 'chromium', args: HERMETIC_ARGS });
}
async function closeAll(): Promise<void> {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  for (const f of fakes) await f.close();
}

async function openFake(opts: Partial<FakeOptions> = {}, url = 'https://chatgpt.com/', initScript?: () => void): Promise<{ fake: FakeChatGPT; page: Page; context: BrowserContext }> {
  const fake = new FakeChatGPT({ hydrationDelayMs: 50, ...opts });
  fakes.push(fake);
  const context = await browser.newContext(FAKE_CONTEXT_OPTIONS);
  contexts.push(context);
  await fake.install(context);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await page.goto(url);
  if (opts.loggedIn !== false) await page.waitForSelector(COMPOSER);
  return { fake, page, context };
}

/** Paste like the extension spec: focus, caret to end, chunks of <= `chunk` chars with text/plain + pre-wrap text/html. */
async function paste(page: Page, text: string, opts: { chunk?: number; html?: 'pre-wrap' | 'plain-p' | false } = {}): Promise<void> {
  await page.evaluate(
    ({ selector, text, chunk, html }) => {
      const editor = document.querySelector(selector) as HTMLElement;
      editor.focus();
      const sel = getSelection()!;
      const r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      for (let i = 0; i < text.length; ) {
        let end = Math.min(i + chunk, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        const part = text.slice(i, end);
        const dt = new DataTransfer();
        dt.setData('text/plain', part);
        if (html) {
          const p = document.createElement('p');
          if (html === 'pre-wrap') p.style.whiteSpace = 'pre-wrap';
          p.textContent = part;
          dt.setData('text/html', p.outerHTML.replace(/\n/g, '<br>'));
        }
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        i = end;
      }
    },
    { selector: COMPOSER, text, chunk: opts.chunk ?? 4000, html: opts.html === undefined ? 'pre-wrap' : opts.html },
  );
}

/** Composer text read from the DOM as the extension verifies it (<br> = \n except trailing breaks, blocks = lines). */
function editorText(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const editor = document.querySelector(selector)!;
    const text = (node: Node): string => {
      let s = '';
      for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === Node.TEXT_NODE) s += (c as Text).data;
        else if (c.nodeName === 'BR') s += (c as Element).classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
        else s += text(c);
      }
      return s;
    };
    return Array.from(editor.children)
      .map((b) => text(b))
      .join('\n');
  }, COMPOSER);
}

async function send(page: Page): Promise<void> {
  await page.locator(SEND).click();
}

async function waitIdle(page: Page): Promise<void> {
  await page.waitForSelector(SEND, { timeout: 15_000 });
}

const TRICKY = [
  'Line one with  two spaces and a tab\tend',
  '',
  '    indented code(); // <tool_call name="Write"> & </param> "quotes"',
  'emoji 😀 and CJK 中文 and combining é',
  '',
  '',
  'trailing spaces   ',
  ' nbsp',
].join('\n');

describe('fake chatgpt.com', { skip }, () => {
  before(launchBrowser);
  after(closeAll);

  it('renders the 2026-09 composer, a disabled send button and the Chat/Work switch', async () => {
    const { page } = await openFake();
    const ed = page.locator(COMPOSER);
    assert.equal(await ed.getAttribute('class'), 'ProseMirror');
    assert.equal(await ed.getAttribute('aria-label'), 'Ask ChatGPT');
    assert.equal(await page.locator(`${COMPOSER} p.placeholder > br.ProseMirror-trailingBreak`).count(), 1);
    assert.equal(await page.locator(SEND).isDisabled(), true);
    assert.equal(await page.locator('[role="group"][aria-label="Composer mode"] button[aria-pressed="true"]').textContent(), 'Chat');
    assert.equal(await page.locator(STOP).count(), 0);
  });

  it('round-trips a chunked multi-line paste exactly and streams the SSE reply', async () => {
    const reply = 'Sure. Here is **bold** and code:\n\n```js\n  const x = 1;\n```\n- item';
    const { fake, page } = await openFake({ llm: () => reply });
    const text = (TRICKY + '\n').repeat(40).slice(0, 9_500) + 'END';
    await paste(page, text);
    assert.equal(await editorText(page), text);
    assert.equal(await page.evaluate(() => (window as unknown as { __fakeChatGPT: { composerText(): string } }).__fakeChatGPT.composerText()), text);
    assert.equal(await page.locator(SEND).isDisabled(), false);
    const respP = page.waitForResponse((r) => new URL(r.url()).pathname === '/backend-api/f/conversation');
    await send(page);
    const resp = await respP;
    await waitIdle(page);

    const [req] = await fake.waitForRequests(1);
    // (The page aborts the read after message_stream_complete, so take the body from the fake's record.)
    assert.equal(req!.prompt, text);
    assert.equal(req!.conversationId, undefined);
    assert.equal(req!.parentMessageId, 'client-created-root');
    assert.equal(req!.status, 200);
    // The SSE body decodes to the scripted reply.
    assert.match(resp.headers()['content-type'] ?? '', /text\/event-stream/);
    const body = req!.responseBody!;
    const events = parseSseEvents(body);
    assert.deepEqual(events[0], { event: 'delta_encoding', data: '"v1"' });
    assert.equal(events.at(-1)!.data, '[DONE]');
    assert.ok(events.some((e) => e.data.includes('"message_stream_complete"')));
    assert.ok(events.filter((e) => /^\{"v":"/.test(e.data)).length > 3, 'implicit-path appends are used');
    const turn = reduceSse(body);
    assert.equal(turn.answer, reply);
    assert.equal(turn.complete, true);
    assert.equal(turn.finishReason, 'stop');
    assert.equal(turn.conversationId, req!.responseConversationId);
    assert.equal(turn.messageId, req!.assistantMessageId);
    // Same result when the bytes arrive in awkward pieces.
    const r = new DeltaReducer();
    for (let i = 0; i < body.length; i += 7) r.feedSse(body.slice(i, i + 7));
    assert.equal(r.turn.answer, reply);

    // DOM: the answer unit is rendered (lossy markdown, so DOM text != raw reply), the URL moved to /c/<id>.
    const dom = await page.locator(ANSWER).last().innerText();
    assert.match(dom, /Here is bold and code/);
    assert.notEqual(dom, reply);
    assert.equal(await page.locator('.turn-action-controls button[aria-label="Copy"]').count(), 1);
    assert.equal(new URL(page.url()).pathname, `/c/${req!.responseConversationId}`);
    assert.equal(await editorText(page), '');
    assert.equal(await page.locator('[role="status"]').textContent(), 'Response complete');
  });

  it('turns a single paste over 10000 characters into a "Pasted text" chip', async () => {
    const { page } = await openFake();
    const big = 'x'.repeat(12_000);
    await paste(page, big, { chunk: 20_000 });
    assert.equal(await page.locator(CHIP).count(), 1);
    assert.equal(await editorText(page), '');
    // The same text in 4000-char chunks stays inline and adds no chip.
    await paste(page, big);
    assert.equal(await page.locator(CHIP).count(), 1);
    assert.equal((await editorText(page)).length, 12_000);
    await page.locator(CHIP).click();
    assert.equal(await page.locator(CHIP).count(), 0);
  });

  it('continues a conversation in the same tab with conversation_id and parent_message_id', async () => {
    const seen: Array<{ prompt: string; history: number; turn: number }> = [];
    const { fake, page } = await openFake({
      llm: (prompt, ctx) => {
        seen.push({ prompt, history: ctx.history.length, turn: ctx.turn });
        return `reply ${ctx.turn}`;
      },
    });
    await paste(page, 'first');
    await send(page);
    await waitIdle(page);
    await paste(page, 'second');
    await send(page);
    await waitIdle(page);
    const [a, b] = await fake.waitForRequests(2);
    assert.equal(b!.conversationId, a!.responseConversationId);
    assert.equal(b!.parentMessageId, a!.assistantMessageId);
    assert.equal(b!.parentIsCurrentNode, true);
    assert.deepEqual(seen, [
      { prompt: 'first', history: 0, turn: 0 },
      { prompt: 'second', history: 1, turn: 1 },
    ]);
    assert.equal(await page.locator(ANSWER).count(), 2);
    assert.equal(await page.locator(ANSWER).last().innerText(), 'reply 1');
  });

  it('streams reasoning and a commentary preamble that are not part of the answer', async () => {
    const { fake, page } = await openFake({ llm: () => ({ text: 'The answer.', thoughts: ['Reading', 'Planning'], preamble: 'Let me check that first.' }) });
    await paste(page, 'think');
    await send(page);
    await waitIdle(page);
    const body = (await fake.waitForRequests(1))[0]!.responseBody!;
    assert.match(body, /"content_type":"thoughts"/);
    assert.match(body, /"content_type":"reasoning_recap"/);
    assert.match(body, /"is_thinking_preamble_message":true/);
    const turn = reduceSse(body);
    assert.equal(turn.answer, 'The answer.');
    assert.equal(turn.messageId, fake.requests[0]!.assistantMessageId);
    assert.equal(await page.locator(ANSWER).last().innerText(), 'The answer.');
    // GET /backend-api/conversation/{id} carries the reasoning messages too (the extension must filter them).
    const conv = fake.conversationJson(fake.conversations.get(turn.conversationId!)!);
    const types = Object.values(conv.mapping as Record<string, { message: { content: { content_type: string } } | null }>)
      .map((n) => n.message?.content.content_type)
      .filter(Boolean);
    assert.deepEqual(types, ['text', 'text', 'thoughts', 'reasoning_recap', 'text', 'text']);
    assert.equal(conv.current_node, fake.requests[0]!.assistantMessageId);
  });

  it('loads /c/<id> from GET /backend-api/conversation/<id> and continues it', async () => {
    const { fake, page, context } = await openFake({ llm: (p) => `answer to ${p}` });
    await paste(page, 'hello');
    await send(page);
    await waitIdle(page);
    const first = fake.requests[0]!;
    const page2 = await context.newPage();
    const convResp = page2.waitForResponse((r) => new URL(r.url()).pathname === `/backend-api/conversation/${first.responseConversationId}`);
    await page2.goto(`https://chatgpt.com/c/${first.responseConversationId}`);
    const conv = (await (await convResp).json()) as { current_node: string; mapping: Record<string, unknown> };
    assert.equal(conv.current_node, first.assistantMessageId);
    await page2.waitForSelector(COMPOSER);
    assert.equal(await page2.locator(ANSWER).last().innerText(), 'answer to hello');
    await paste(page2, 'again');
    await send(page2);
    await waitIdle(page2);
    const second = fake.requests[1]!;
    assert.equal(second.conversationId, first.responseConversationId);
    assert.equal(second.parentMessageId, first.assistantMessageId);
    assert.equal(await page2.locator(ANSWER).last().innerText(), 'answer to again');
    // Unknown ids: a toast, and the composer still works.
    const page3 = await context.newPage();
    await page3.goto('https://chatgpt.com/c/00000000-0000-4000-8000-000000000000');
    await page3.waitForSelector(COMPOSER);
    await page3.waitForSelector('[role="alert"]');
  });

  it('keeps temporary chats out of the URL and marks the request', async () => {
    const { fake, page } = await openFake({}, 'https://chatgpt.com/?temporary-chat=true&model=gpt-5-6-thinking');
    // ?model= is consumed and dropped from the URL, temporary-chat stays.
    assert.equal(page.url(), 'https://chatgpt.com/?temporary-chat=true');
    await paste(page, 'temp one');
    await send(page);
    await waitIdle(page);
    await paste(page, 'temp two');
    await send(page);
    await waitIdle(page);
    const [a, b] = fake.requests;
    assert.equal(a!.temporary, true);
    assert.equal(a!.model, 'gpt-5-6-thinking');
    assert.equal(b!.conversationId, a!.responseConversationId);
    assert.equal(page.url(), 'https://chatgpt.com/?temporary-chat=true');
    assert.equal(fake.conversations.get(a!.responseConversationId!)!.temporary, true);
  });

  it('hands the stream off to a ws.chatgpt.com WebSocket topic (with catch-ups and duplicates)', async () => {
    const reply = 'Handed off:\n<tool_call name="Bash">\n<param name="command">echo "a  b" && ls -la</param>\n</tool_call>';
    // Record WebSocket frames the way the extension's MAIN-world wrapper would.
    const { fake, page } = await openFake({ transport: 'ws', llm: () => reply }, 'https://chatgpt.com/', () => {
      const frames: string[] = [];
      (window as unknown as { __frames: string[] }).__frames = frames;
      const Native = window.WebSocket;
      window.WebSocket = new Proxy(Native, {
        construct(t, args, nt) {
          const ws = Reflect.construct(t, args, nt) as WebSocket;
          if (String(args[0]).startsWith('wss://ws.chatgpt.com/')) ws.addEventListener('message', (e) => frames.push(String(e.data)));
          return ws;
        },
      });
    });
    await paste(page, 'go');
    await send(page);
    await waitIdle(page);
    const httpBody = fake.requests[0]!.responseBody!;
    // HTTP part: handoff and [DONE], but no answer and no message_stream_complete.
    const http = reduceSse(httpBody);
    assert.ok(http.handoffTopic?.startsWith('conversation-turn-'));
    assert.equal(http.answer, '');
    assert.equal(http.complete, false);
    assert.match(httpBody, /data: \[DONE\]/);
    assert.deepEqual(fake.wsSubscriptions.map((s) => s.topicId), [http.handoffTopic]);
    // WS part: decode with dedupe by stream_item_id.
    const frames = await page.evaluate(() => (window as unknown as { __frames: string[] }).__frames);
    const r = new DeltaReducer();
    const seen = new Set<string>();
    let dupes = 0;
    let done = false;
    for (const f of frames) {
      const msg = JSON.parse(f) as unknown;
      const entries = (Array.isArray(msg) ? msg : [msg]) as Array<Record<string, any>>;
      for (const e of entries.flatMap((x) => (x.type === 'reply' ? (x.reply?.catchups ?? []) : [x]))) {
        const p = e.payload?.payload;
        if (!p) continue;
        if (p.type === 'done') done = true;
        if (p.type !== 'stream-item') continue;
        if (seen.has(p.stream_item_id)) {
          dupes++;
          continue;
        }
        seen.add(p.stream_item_id);
        r.feedSse(p.encoded_item);
      }
    }
    assert.ok(dupes >= 1, 'the fake repeats at least one stream item');
    assert.ok(done);
    assert.ok(frames.some((f) => f.startsWith('[')), 'one frame carries an array of envelopes');
    assert.equal(r.turn.answer, reply);
    assert.equal(r.turn.complete, true);
    assert.match(await page.locator(ANSWER).last().innerText(), /Handed off:/);
  });

  it('answers HTTP 429 when rate limited and shows the error', async () => {
    const { fake, page } = await openFake({ rateLimit: { clearsInSec: 1234 } });
    await paste(page, 'hi');
    const respP = page.waitForResponse((r) => new URL(r.url()).pathname === '/backend-api/f/conversation');
    await send(page);
    const resp = await respP;
    assert.equal(resp.status(), 429);
    assert.equal(((await resp.json()) as { detail: { clears_in: number } }).detail.clears_in, 1234);
    await page.waitForSelector('[role="alert"].text-token-text-error');
    assert.match(await page.locator('[role="alert"].text-token-text-error').innerText(), /limit/);
    await waitIdle(page);
    assert.equal(fake.requests[0]!.status, 429);
  });

  it('shows Stop while generating and stops on click', async () => {
    const { fake, page } = await openFake({ llm: (p) => ({ text: `slow ${p}`, delayMs: p === 'stop me' ? 5000 : 800 }) });
    await paste(page, 'wait');
    await send(page);
    await page.waitForSelector(STOP);
    assert.equal(await page.locator(SEND).count(), 0);
    await waitIdle(page);
    assert.equal(await page.locator(ANSWER).last().innerText(), 'slow wait');
    await paste(page, 'stop me');
    await send(page);
    await page.locator(STOP).click();
    await waitIdle(page);
    assert.equal(await page.locator(STOP).count(), 0);
    assert.equal(fake.requests.length, 2);
  });

  it('accepts execCommand("insertText") and submits on Enter', async () => {
    const { fake, page } = await openFake();
    await page.evaluate((selector) => {
      const ed = document.querySelector(selector) as HTMLElement;
      ed.focus();
      document.execCommand('insertText', false, 'hello world');
    }, COMPOSER);
    await page.waitForFunction((s) => !document.querySelector<HTMLButtonElement>(s)!.disabled, SEND);
    assert.equal(await editorText(page), 'hello world');
    await page.locator(COMPOSER).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
    await fake.waitForRequests(1);
    assert.equal(fake.requests[0]!.prompt, 'hello world');
    // Clearing with select-all + delete restores the placeholder paragraph.
    await waitIdle(page);
    await paste(page, 'to be cleared');
    await page.evaluate((selector) => {
      (document.querySelector(selector) as HTMLElement).focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
    }, COMPOSER);
    await page.waitForFunction((s) => document.querySelector<HTMLButtonElement>(s)!.disabled, SEND);
    assert.equal(await editorText(page), '');
  });

  it('parses pastes like ProseMirror: plain text splits into paragraphs, HTML without pre-wrap collapses spaces', async () => {
    const { page } = await openFake();
    // text/plain only: one paragraph per line, blank lines dropped (lossy).
    await paste(page, 'a\n\n  b', { html: false });
    assert.equal(await editorText(page), 'a\n  b');
    assert.equal(await page.locator(`${COMPOSER} > p`).count(), 2);
    await page.evaluate((s) => {
      (document.querySelector(s) as HTMLElement).focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
    }, COMPOSER);
    // text/html without white-space:pre-wrap: whitespace collapses (lossy).
    await paste(page, 'x   y\n    z', { html: 'plain-p' });
    assert.equal(await editorText(page), 'x y\nz');
  });

  it('shows a login CTA and no composer when logged out', async () => {
    const { page } = await openFake({ loggedIn: false });
    await page.waitForSelector('a[href*="/auth/login"]');
    assert.equal(await page.locator(COMPOSER).count(), 0);
  });

  it('starts in Work mode when configured; Work turns stream over WebSocket', async () => {
    const { fake, page } = await openFake({ composerMode: 'work' });
    const group = page.locator('[role="group"][aria-label="Composer mode"]');
    assert.equal(await group.locator('button[aria-pressed="true"]').textContent(), 'Work');
    await paste(page, 'in work');
    await send(page);
    await waitIdle(page);
    await group.locator('button', { hasText: 'Chat' }).click();
    assert.equal(await group.locator('button[aria-pressed="true"]').textContent(), 'Chat');
    await paste(page, 'in chat');
    await send(page);
    await waitIdle(page);
    assert.deepEqual(
      fake.requests.map((r) => [r.composerMode, r.transport]),
      [
        ['work', 'ws'],
        ['chat', 'sse'],
      ],
    );
  });

  it('can answer GET /backend-api/conversation with a Cloudflare challenge', async () => {
    const { fake, page } = await openFake({ conversationApi: 'cloudflare' });
    const r = await page.evaluate(async (token) => {
      const res = await fetch('/backend-api/conversation/abc', { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, type: res.headers.get('content-type'), cf: res.headers.get('cf-mitigated') };
    }, fake.accessToken);
    assert.deepEqual(r, { status: 403, type: 'text/html; charset=UTF-8', cf: 'challenge' });
  });
});
