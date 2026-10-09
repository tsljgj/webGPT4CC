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

Chrome slows down background tabs. With Energy Saver on, it can also freeze them after about 5 minutes. To avoid this:

- keep worker tabs in their own window, or
- add chatgpt.com under `chrome://settings/performance` → "Always keep these sites active".

After you reload or update the extension, reload the worker tabs and add them again. Chrome does not inject content scripts into tabs that were already open, and the worker list is cleared.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `tabs`, `alarms`. Hosts: chatgpt.com and loopback. |
| `background.js` | Service worker. It owns the bridge WebSocket (reconnects with backoff, pings every 20 s, and a 30 s alarm), the worker-tab registry (`chrome.storage.session`) and job orchestration (navigation, one job per tab), and sets the badge. |
| `content/stream-core.js` | Pure logic, loaded first into the MAIN world and also runnable in Node: SSE parser, delta-v1 reducer, answer selection, marker sanitizing, WebSocket item decoding, composer-text reader, error classifiers. |
| `content/page-agent.js` | MAIN world, `document_start`. Observe-mode `fetch`/`WebSocket` hooks and the DOM driver (chunked paste, verify, send, stop). All selectors are in `SELECTORS`. |
| `content/relay.js` | ISOLATED world. Relays between `window.postMessage` (same window, tagged channel) and a `chrome.runtime` port, and reconnects after service-worker restarts. |
| `popup.html/js/css` | Settings, connection status and the worker list. |
| `scripts/make-icons.mjs` | Regenerates `icons/*.png`. Uses Node built-ins only. |
| `test/` | Unit tests for `stream-core.js` plus static checks (`node --test extension/test/`). |

## When ChatGPT changes

- **The DOM changed** (the message box or the send button is not found): update `SELECTORS` at the top of `content/page-agent.js`. Update the fake page in `test/e2e/fake-chatgpt/` to match.
- **The stream format changed** (empty or garbled replies): turn on **Debug log** in the popup. The page agent then forwards the raw stream frames to the bridge log as `debug: N raw stream frame(s)` lines. Tokens are redacted, but the frames still contain the prompt and the reply. Attach those lines to a bug report.

## Automation hook

The service worker exposes `globalThis.webgpt4cc`. Tests use it through Playwright's `serviceWorker.evaluate`:

- `status()`
- `addWorker(tabId)`
- `releaseWorker(tabId)`
- `openWorkerTab()`
- `reconnect()`

These are the same operations as the popup buttons.
