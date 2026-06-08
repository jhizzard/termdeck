# T3 — Completion Detection, Selectors, Client Panel

You are **T3** in Sprint 72. You make the panel know when Grok is done, find the right DOM bits resiliently, and render the live chat in the TermDeck client.

## Boot
1. `memory_recall(project="termdeck", query="Grok web chat completion detection selectors client canvas web-chat panel render")`
2. `memory_recall(query="chat-UI automation completion detection MutationObserver accessibility role locators")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-72-grok-panel/PLANNING.md` + `STATUS.md`
5. Read `docs/sprint-72-grok-panel/T3-detection-selectors-client.md` (this)
6. Read `packages/client/public/app.js` around `createTerminalPanel` (~437-654) + the WS `case 'output'` dispatch (~509). **Read current MutationObserver + Playwright ARIA/role-locator docs before coding.**

## Lane scope (own these)
- `packages/web-chat-driver/src/grok/*` — `inject(handle, text)`, completion detection, selector/extract logic for grok.com.
- `packages/client/public/app.js` — the `web-chat` canvas panel. **You are the SOLE owner of this file** (single big file; no other lane touches it).

## Tasks
1. **Layered completion detection** (no `sleep`): (1) composer **stop↔send button flip** (primary, portable), (2) **MutationObserver "quiet for ~500–800ms"** on the response container (backstop), (3) copy/regenerate affordance as confirmation.
2. **Selectors:** hand-authored `data-testid` + `getByRole`/`getByLabel` for grok.com composer/send/stop/response; an **accessibility-snapshot self-heal fallback** when a locator misses. Develop against a saved grok.com DOM fixture; capture a fresh fixture from the live site (browser launch approved) if needed.
3. `inject(handle, text)` — type into composer + send via T1's `sendInput`/CDP. `onComplete(handle, cb)` — fire with the final assistant text when detection says done.
4. **Client:** branch `createTerminalPanel` on `type==='web-chat'` → mount a `<canvas>` consuming T1's screencast frames + an input box that sends `{type:'input', data}` over the existing WS. Reuse the grid/sidebar wrapper. **Leave the xterm path untouched for all other panel types.**

## Provide (contracts T2 consumes)
`driver.grok.inject(handle, text)`, `driver.grok.onComplete(handle, cb)`.

## Consume
`driver.cdp.*` (T1).

## Do NOT
Touch the server `index.js` (T2), the CDP transport (T1), or `grok-models.js`. Break the xterm render path for non-web-chat panels. No version bumps / CHANGELOG / commits.

## Post shape
`### [T3] FINDING|FIX-PROPOSED|FIX-LANDED|BLOCKED|DONE 2026-MM-DD HH:MM ET — <gist>` in STATUS.md.

## Done when
Completion detection + selectors work on the fixture and live grok.com; `inject`/`onComplete` published; the client renders a `web-chat` panel without breaking the grid or any existing panel type.
