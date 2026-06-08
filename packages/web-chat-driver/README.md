# @jhizzard/termdeck-web-chat-driver

CDP transport + render bridge for TermDeck **web-chat panels** (Sprint 72 / Workstream B).

It lets a **real, logged-in, headful Chrome** be:

- **seen + driven by the human** — `Page.startScreencast` streams the tab to a client `<canvas>`, and `Input.dispatch*` forwards the human's mouse/keyboard so the same tab responds; and
- **injected / read by the orchestrator** — T3's selector layer drives the composer through the Playwright `Page`; `Input.insertText` types prompts; completion detection reads the response.

This is **interactive co-pilot automation, not scraping.** Grok-only, headful, dedicated profile, human-present, low-volume. Never headless, never stealth, never the default Chrome profile.

> **Lane ownership (Sprint 72):** T1 owns `src/cdp/*` (this transport). T3 owns `src/grok/*` (selectors + completion). T2 owns the server seams + `web-chat-grok` adapter. This README is the **published contract** T2/T3 consume.

## Architecture — real Chrome + `connectOverCDP` + raw-CDP bridge

Per the ORCH Blocker-2 ruling, the transport **spawns a real, independent headful Chrome** (the actual Google Chrome binary, launched with only our flags — *no* Playwright-managed `--enable-automation` infobar, so the human genuinely co-owns the window) on a dedicated profile + localhost `--remote-debugging-port`, then attaches **Playwright via `connectOverCDP`**. The returned `handle` exposes **both**:

- **`handle.page`** — the Playwright `Page`. T3's resilient selector path (`page.locator`, `composer.fill()`, role/aria snapshots, self-heal) runs on this.
- **`handle.cdp`** — a `CDPSession` from `page.context().newCDPSession(page)`. The render bridge runs `Page.startScreencast` + `Input.dispatch*` over this — the parts Playwright doesn't wrap.

Only dependency is **`playwright-core`** (no bundled-browser download — we drive *real* Chrome). It installs **locally** in this package, so it never churns the repo-root lockfile (Guardrail 5 — the parallel Sprint 71 deck shares the repo).

## Install

```bash
cd packages/web-chat-driver && npm install   # local node_modules only — never the repo root
```

## Quick start

```js
const { cdp, grok } = require('@jhizzard/termdeck-web-chat-driver');

// Spawn a real headful Chrome on a dedicated, persistent profile + localhost debug port,
// then connectOverCDP. (mode:'connect' instead attaches to a Chrome the human already launched.)
const handle = await cdp.attach({ userDataDir: 'grok', port: 9333, startUrl: 'https://grok.com' });

// (a) stream the tab to the client canvas  — over handle.cdp
const sc = handle.screencast((frame) => {
  broadcastToClient(frame);          // frame.dataUrl → <img>.src / canvas (see frame-channel shape)
}, { quality: 60, maxWidth: 1280, maxHeight: 800 });

// (b) forward a human mouse click coming from the canvas — over handle.cdp
await handle.sendInput({ type: 'mousePressed',  x: 120, y: 240, button: 'left', clickCount: 1 });
await handle.sendInput({ type: 'mouseReleased', x: 120, y: 240, button: 'left', clickCount: 1 });

// (c) orchestrator injects a prompt — T3 drives handle.page's composer + reads the response
const finalText = await grok.inject(handle, 'summarize my last session');

await sc.stop();
await handle.close();   // launch mode: awaits + kills the Chrome we spawned. connect mode: just disconnects.
```

## API

### `cdp.attach(opts) → Promise<handle>`

| opt | default | meaning |
|---|---|---|
| `userDataDir` / `profile` | `'default'` | dedicated profile. Bare name → `~/.termdeck/web-chat-profiles/<name>`; absolute path used verbatim. Override root via `TERMDECK_WEB_CHAT_PROFILES_DIR`. |
| `port` | `9333` | localhost CDP debug port. T2 allocates a distinct port per panel. |
| `mode` | `'auto'` | `'auto'` connect-if-up-else-spawn · `'connect'` require a running Chrome (co-drive the human's) · `'launch'` always spawn ours. |
| `startUrl` | `'about:blank'` | initial URL (e.g. `https://grok.com`). |
| `headful` | `true` | **posture: hard-locked to `true`.** An explicit `false` is **rejected** — `transport.js` throws (`headless is not permitted`); the driver never emits `--headless`. For a display-less / CI box, skip the browser tests with `WEB_CHAT_DRIVER_NO_BROWSER=1` instead of going headless. |
| `detached` | `false` | spawn Chrome detached so it survives a server restart (then reattach via `mode:'connect'`). |
| `chromePath` | auto-detected | real Chrome binary. Also via `TERMDECK_CHROME_PATH`. |
| `args` | `[]` | extra Chrome flags. |

**`handle`** exposes:

- `handle.page` — **Playwright `Page`** (T3's selector/aria/fill path).
- `handle.cdp` — **`CDPSession`** (`send(method, params)` / `on(event, fn)` / `off`) for screencast + input + anything else.
- `handle.screencast(onFrame, opts?) → { started, stop() }` — alias for `cdp.screencast(handle, …)`.
- `handle.sendInput(evt) → Promise` — alias for `cdp.sendInput(handle, evt)`.
- `handle.insertText(text) → Promise` — alias for `cdp.insertText(handle, text)`.
- `handle.navigate(url, { waitUntil='load' }) → Promise<handle>` — `page.goto`.
- `handle.evaluate(expr, { returnByValue=true }) → Promise<any>` — page read over CDP `Runtime.evaluate` (string expression).
- `handle.close()` — **launch** mode awaits + kills the Chrome we spawned; **connect** mode only disconnects (never the human's browser).
- `handle.mode | port | userDataDir | context | browser | proc`.

### `cdp.screencast(handle, onFrame, opts?) → { started, stop }`

Runs `Page.startScreencast` on `handle.cdp`. **Every frame is `Page.screencastFrameAck`'d internally** (ack-first, before your consumer runs) — without this, Chrome stops emitting after a few frames. A throwing/slow `onFrame` can never stall the stream.

`opts`: `format` `'jpeg'|'png'` (default `jpeg`), `quality` 0–100 (default 60), `maxWidth` (1280), `maxHeight` (800), `everyNthFrame` (1).

**Frame-channel shape** — the object `onFrame` receives (T2 broadcasts as `{type:'web-chat-frame', frame}`, T3's canvas renders):

```js
{
  format,          // 'jpeg' | 'png'
  data,            // base64 image bytes
  dataUrl,         // 'data:image/<format>;base64,<data>' — straight into <img>.src / canvas
  deviceWidth,     // DIP — size the canvas backing store to this
  deviceHeight,    // DIP
  offsetTop, pageScaleFactor, scrollOffsetX, scrollOffsetY,
  timestamp,       // frame swap time
  frame,           // CDP frame number (the acked sessionId)
}
```

### `cdp.sendInput(handle, evt) → Promise`

Forwards **one** raw input event over `handle.cdp`. The client turns a DOM `MouseEvent`/`KeyboardEvent` into one of:

```js
// mouse
{ kind?:'mouse', type:'mousePressed'|'mouseReleased'|'mouseMoved'|'mouseWheel',
  x, y, button?:'none'|'left'|'middle'|'right'|'back'|'forward',
  buttons?, clickCount?, modifiers?, deltaX?, deltaY?, pointerType? }

// keyboard
{ kind?:'key', type:'keyDown'|'keyUp'|'rawKeyDown'|'char',
  key?, code?, text?, unmodifiedText?, windowsVirtualKeyCode?|keyCode?,
  nativeVirtualKeyCode?, modifiers?, autoRepeat?, isKeypad?, location? }
```

`button` defaults to `'none'`, `clickCount` to 1 for press/release. `keyCode` is shorthand for `windowsVirtualKeyCode`/`nativeVirtualKeyCode`. Type is inferred as mouse when `type` matches a mouse event. (This is the `web-chat-input` path T2 routes from the client.)

### `cdp.insertText(handle, text) → Promise`

`Input.insertText` — inserts `text` at the focused element as if typed/IME'd. A clean primitive for inject; T3 composes it with the composer selector.

### `cdp.typeKey(handle, { key, code, text, keyCode, modifiers }) → Promise`

Convenience: a full printable keystroke (`keyDown` carrying `text`, then `keyUp`). Also handy for Enter/Tab.

### `cdp.profile` helpers

`resolveProfileDir(nameOrPath)`, `profilesRoot()`, `ensureDir(p)`, `DEFAULT_PORT`.

## Posture & security (release-blocking)

- **Real, independent Chrome via `connectOverCDP`.** We spawn the actual Chrome binary (not a Playwright-managed browser), so there is **no `--enable-automation` infobar** and the human genuinely co-owns the window — the most ToS-defensible "normal paying subscriber" shape. Playwright merely attaches over CDP.
- **Headful, dedicated profile.** Chrome 136+ blocks CDP on the *default* profile, so each session uses its own persistent `--user-data-dir`; the human logs into Grok there once and the login stays warm across restarts.
- **Localhost-only debug port.** We never pass `--remote-debugging-address`, so Chrome binds the DevTools endpoint to `127.0.0.1` and rejects non-localhost connections. `connectOverCDP`'s Node client sends no `Origin` header, so **no `--remote-allow-origins` loosening is required** — verified against the fixture.
- **Keep-alive flags.** `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`, `--disable-background-timer-throttling` keep frames flowing while the human looks at the TermDeck canvas (the source window is usually backgrounded).
- **No secrets, no scraping, Grok-only.** This transport never reads cookies/tokens and is provider-neutral; the Grok-specific layer (and the never-claude.ai/gemini/chatgpt rule) lives in T3.

## Tests

```bash
cd packages/web-chat-driver && npm test
```

Round-trips against `tests/fixtures/echo.html` (no external site): the handle exposes a real Playwright `Page` + `CDPSession`; screencast streams ≥2 distinct frames; `insertText` lands; a forwarded mouse click hit-tests onto the input; forwarded key events type characters. Spawns a real headful Chrome on a throwaway profile and **awaits its exit on close** so the profile dir cleans up. This package is **not** in the repo's root test glob, so root `npm test` never launches a browser. On a display-less box: `WEB_CHAT_DRIVER_NO_BROWSER=1 npm test` to skip.

## Env vars

| var | effect |
|---|---|
| `TERMDECK_CHROME_PATH` | path to the real Chrome binary |
| `TERMDECK_WEB_CHAT_PROFILES_DIR` | root for dedicated profiles (default `~/.termdeck/web-chat-profiles`) |
| `WEB_CHAT_DRIVER_NO_BROWSER=1` | skip the browser-launching test |
