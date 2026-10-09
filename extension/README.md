# webGPT4CC browser extension

Chrome / Edge (MV3) extension that turns logged-in chatgpt.com tabs into workers
for the local webGPT4CC bridge. Plain JavaScript, no build step.
Design: [docs/EXTENSION.md](../docs/EXTENSION.md). Wire protocol: [docs/PROTOCOL.md §2](../docs/PROTOCOL.md).

## Install

1. Start the bridge: `webgpt4cc serve`. Then run `webgpt4cc pair` to see the bridge URL and pairing token.
2. Open `chrome://extensions` and turn on **Developer mode**. Click **Load unpacked** and choose this `extension/` folder.
3. Click the toolbar icon. Enter the bridge URL and the token, then click **Save**.
4. Open a worker tab:
   - **Open worker tab** opens a pinned chatgpt.com tab, or
   - go to a chatgpt.com tab you are logged in to and click **Use this tab as a worker**.

   The badge shows:

   | Badge | Meaning |
   |---|---|
   | green **on** | connected, with a ready worker |
   | yellow | connected, but no worker is ready |
   | red **off** | not connected |

Each worker tab runs one job at a time. The default limit is 3 worker tabs (`maxWorkers`); more parallel chats can trigger ChatGPT's "Too many requests" throttle.

Chrome slows down background tabs. With Energy Saver on, it can also freeze them after about 5 minutes. Worker pages hold a Web Lock (which exempts them) and send a heartbeat every 10 s; a worker tab that Chrome froze anyway, or that stopped responding for 75 s, is shown as not responding and its running job fails with a hint instead of hanging. To avoid this:

- keep worker tabs in their own window, or
- add chatgpt.com under `chrome://settings/performance` → "Always keep these sites active".

After a browser restart, or after you reload or update the extension, the worker tabs are adopted again: any restored pinned chatgpt.com tab for a pinned worker ("Open worker tab"), and a tab at exactly the same URL for a "Use this tab" worker. Tabs without the content scripts (open before the extension loaded) are reloaded once.

The bridge URL must be on this computer (`127.0.0.1`, `::1`, `localhost`), or use `wss://` / `https://`. A plain `ws://` / `http://` bridge on another computer needs the popup's "Allow an unencrypted bridge on another computer" (prompts and replies then cross the network unencrypted). The pairing token itself never crosses the wire: the extension and the bridge prove they know it to each other (challenge-response) before anything else is exchanged.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `alarms` (no `tabs`: the chatgpt.com host permission reveals the URLs needed). Hosts: chatgpt.com and loopback. |
| `background.js` | Service worker. It owns the bridge WebSocket (pairing handshake, reconnects with backoff, pings every 20 s, and a 30 s alarm), the worker-tab registry (`chrome.storage.session`, intent in `chrome.storage.local`) and job orchestration (navigation, one job per tab, reloads before sending, frozen tabs), and sets the badge. |
| `content/stream-core.js` | Pure logic, loaded first into the MAIN world and also runnable in Node: SSE parser, delta-v1 reducer, answer selection, marker sanitizing, WebSocket item decoding, composer-text reader, error classifiers (English, zh, ja), prompt-fidelity comparison, Work-mode and Cloudflare verdicts. |
| `content/page-agent.js` | MAIN world, `document_start`. Observe-mode `fetch`/`WebSocket` hooks (in worker tabs: every conversation stream, so "generating" never depends on a localized label) and the DOM driver (chunked paste, verify, send, stop). All selectors are in `SELECTORS`. |
| `content/relay.js` | ISOLATED world. Relays between `window.postMessage` (same window, tagged channel) and a `chrome.runtime` port, and reconnects after service-worker restarts. |
| `popup.html/js/css` | Settings, connection status and the worker list. |
| `scripts/make-icons.mjs` | Regenerates `icons/*.png`. Uses Node built-ins only. |
| `test/` | Unit tests for `stream-core.js` and for the service worker (`background.js` in `node:vm` with a mocked `chrome.*`), plus static checks (`node --test extension/test/`). |

## When ChatGPT changes

- **The DOM changed** (the message box or the send button is not found): update `SELECTORS` at the top of `content/page-agent.js`. Update the fake page in `test/e2e/fake-chatgpt/` to match. Prefer structure and attributes over labels: labels follow the account's language.
- **The text ChatGPT received differs from the prompt**: the bridge log shows `the text ChatGPT received differs from the prompt ({"offset":…,"kinds":[…]})`. The kinds say what the composer changed (`backslash-escape`, `tabs-or-spaces`, …).
- **The stream format changed** (empty or garbled replies): turn on **Debug log** in the popup. The page agent then forwards the raw stream frames to the bridge log as `debug: N raw stream frame(s)` lines. Tokens are redacted, but the frames still contain the prompt and the reply. Attach those lines to a bug report.

## Automation hook

The service worker exposes `globalThis.webgpt4cc`. Tests use it through Playwright's `serviceWorker.evaluate`:

- `status()`
- `addWorker(tabId)`
- `releaseWorker(tabId)`
- `openWorkerTab()`
- `reconnect()`

These are the same operations as the popup buttons.
