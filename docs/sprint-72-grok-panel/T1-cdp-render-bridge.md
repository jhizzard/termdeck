# T1 — CDP / Render Bridge

You are **T1** in Sprint 72 (Grok web-chat panel). You build the bridge that lets a real, logged-in Chrome be (a) seen + driven by the human and (b) injected/read by the orchestrator — over **CDP (Chrome DevTools Protocol)**.

## Boot
1. `memory_recall(project="termdeck", query="Grok web-chat panel CDP screencast input forwarding connectOverCDP")`
2. `memory_recall(query="chat-UI automation technical attach real browser persistent profile")`
3. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. Read `docs/sprint-72-grok-panel/PLANNING.md` + `STATUS.md`
5. Read `docs/sprint-72-grok-panel/T1-cdp-render-bridge.md` (this)
6. **Read the current CDP + Playwright `connectOverCDP` / `Page.startScreencast` / `Input.dispatch*` docs before coding — do NOT rely on memorized APIs.**

## Lane scope (own these)
`packages/web-chat-driver/src/cdp/*` — the transport + render bridge:
- `attach({userDataDir, port})` — launch (or connect to) a **headful real Chrome** with `--remote-debugging-port=<port>` and a **dedicated `--user-data-dir`** (Chrome 136+ blocks CDP on the *default* profile — use a separate dir; the human logs into Grok there once). Attach via Playwright `connectOverCDP` or raw CDP. Bind the debugging port to **localhost only**.
- `screencast(handle, onFrame)` — `Page.startScreencast`; stream frames to a channel the client canvas consumes.
- `sendInput(handle, evt)` — forward mouse/keyboard via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` so the human drives the same tab.
- profile/session helpers (persist the dir so login stays warm across restarts).

## Tasks
1. `npm install` inside `packages/web-chat-driver` (Playwright or CDP client). **Do NOT touch the root `package.json`/lockfile** (Sprint 71 shares this repo).
2. Build `attach` / `screencast` / `sendInput` and a tiny **local fixture page** (`test/fixtures/echo.html`) that echoes typed input, to prove the round-trip without any external site.
3. Unit-test: frames stream, human input forwards, programmatic input lands — first against the local fixture.
4. **✅ Browser launch APPROVED (Joshua, 2026-06-08).** Bring up + unit-test against the local fixture first, then validate live on grok.com — real Chrome, dedicated logged-in profile, headful (posture per PLANNING). The prior colliding ClaimGuard Chrome was killed, so the resource is free.

## Provide (contracts T2/T3 consume)
`driver.cdp.attach`, `driver.cdp.screencast(onFrame)`, `driver.cdp.sendInput(evt)`, frame-channel shape.

## Do NOT
Touch the TermDeck server/client (T2/T3), Grok selectors/detection (T3), `grok-models.js`, or the root lockfile. Run headless, stealth-patch, or use the default Chrome profile. No version bumps / CHANGELOG / commits.

## Post shape
`### [T1] FINDING|FIX-PROPOSED|FIX-LANDED|BLOCKED|DONE 2026-MM-DD HH:MM ET — <gist>` in STATUS.md.

## Done when
`attach`/`screencast`/`sendInput` work against the local fixture (unit-green), then validated live on grok.com; contracts published for T2/T3.
