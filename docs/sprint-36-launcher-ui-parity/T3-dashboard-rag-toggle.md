# Sprint 36 — T3: Dashboard RAG toggle UI + HIGH-priority bug supplements

**Lane goal:** Add an in-product way to flip `rag.enabled` without editing `~/.termdeck/config.yaml` by hand, AND fix the two HIGH-priority dashboard bugs surfaced at Sprint 35 close.

This is the heaviest lane this sprint. Three deliverables; sequence them in the order below.

---

## Deliverable A — Dashboard RAG toggle UI (primary)

### Acceptance behavior

1. Dashboard exposes a `Settings` panel (or extends the existing config drawer if there is one) with a toggle for `rag.enabled`.
2. New endpoint `PATCH /api/config` accepts `{ "rag": { "enabled": true|false } }`, validates, writes to `~/.termdeck/config.yaml`, returns the updated config.
3. Toggle live-updates the boot banner state line (the one Sprint 35 T4 added) WITHOUT requiring a server restart. Either:
   - On PATCH, broadcast a config-changed event over the existing WebSocket so the banner re-renders, OR
   - Have the banner poll/SSE every 5s for state changes.
   - Pick whichever is cheaper; document the choice in STATUS.
4. UI explains MCP-only mode in plain English ("Memory tools available; CLI search disabled. Faster boot, slimmer surface.") AND what flipping ON does ("Enables `termdeck flashback` and the in-CLI hybrid search at the cost of a Mnestra connection at boot.").

### Primary files

- `packages/client/public/app.js` — settings panel + PATCH client + WS handler for config-changed
- `packages/client/public/style.css` — settings panel styling, toggle visuals
- `packages/client/public/index.html` — markup for the settings panel (likely a drawer)
- `packages/server/src/index.js` — `PATCH /api/config` endpoint, validation, write-through to `~/.termdeck/config.yaml`, WS broadcast

### Test plan

- Manual: open dashboard, toggle RAG ON → banner state line updates within 5s. Toggle OFF → updates back. Refresh dashboard → toggle reflects file state.
- Unit: validate PATCH endpoint rejects malformed bodies (extra keys, wrong types).
- Edge case: two browser tabs open. Toggle in tab A → tab B's banner updates via WS broadcast.

---

## Deliverable B — Dashboard "dark veil" bug (HIGH priority)

### Symptom

Stuck modal/overlay on the dashboard. Z-index is over xterm.js panels. Blocks pointer events and keyboard focus. Both Joshua and Brad have hit it independently. Joshua's workaround was hard-refresh — which then caused Deliverable C's bug.

### Diagnosis (do this first)

Reproduce locally in a fresh dashboard window. Suspected causes:
1. A modal-overlay element doesn't get `display: none` (or pointer-events: none) on close. Likely an element like `.modal`, `.overlay`, `.dialog`, `.scrim`, or similar in `index.html` / `app.js`.
2. A class toggle (e.g., `.is-open`) is being added but not removed, so the stylesheet keeps the overlay layered over the panels.
3. A z-index regression. Some element has `z-index` higher than the xterm.js panels' container without a corresponding close path.

Investigate by:
- Loading the dashboard, reproducing the bug, then in DevTools inspecting the topmost element under the cursor — that's your culprit.
- Search `app.js` for `addEventListener` patterns that toggle a class on but never off.
- Search `style.css` for `position: fixed` or `position: absolute` rules with high z-index.

### Fix approach

Once located:
- Ensure the overlay has a single source-of-truth state (e.g., `dashboard.overlay = { kind: 'modal' | 'none', ... }`) and a single close path that resets it.
- ESC key should always dismiss any modal — wire it as a global handler if it isn't already.
- The xterm.js panels should always have `pointer-events: auto` regardless of overlay state. If you need an actual modal (no panel interaction), close it on ESC AND on background click.

### Test plan

- Manual reproduction → fix → confirm fix.
- Regression test: open the modal kind that triggered it (likely the inject-prompt drawer or sprint-runner UI), close it, confirm no veil. Open it again, ESC out, confirm no veil. Open it, click background, confirm no veil.

### Primary files

- `packages/client/public/app.js`
- `packages/client/public/style.css`
- `packages/client/public/index.html`

---

## Deliverable C — Hard-refresh kills server-side PTYs (HIGH priority)

### Symptom

`Cmd+Shift+R` on the dashboard causes `/api/sessions` to drop to 0 IMMEDIATELY. PTYs are gone server-side, not just visually missing. The WebSocket close handler is misinterpreting client-disconnect as session shutdown.

This was repro'd at Sprint 35 close — Joshua hard-refreshed to escape the dark-veil bug, came back to an empty dashboard.

### Diagnosis (do this first)

In `packages/server/src/index.js` (or wherever the WS handlers live), find the `ws.on('close', ...)` handler. It's likely calling `pty.kill()` or `session.destroy()` directly. The handler can't distinguish:
- A client tab was closed permanently (intent: maybe kill PTY after grace period, but probably not — sessions should outlive pages)
- A client did a hard-refresh (intent: keep PTY alive, client will reconnect in <5s)
- The server itself is shutting down (intent: kill all)

### Fix approach

Two-stage close:
1. On `ws.on('close')`, mark the session `disconnected` with a timestamp. Do NOT kill the PTY.
2. Run a janitor that kills sessions still `disconnected` after a grace period (suggest **30s** for this sprint; tune later). Janitor runs every 10s.
3. On a new WebSocket connection, look up the session ID from the URL/handshake and re-attach to the existing PTY if `disconnected` flag is set. Clear the flag.

This also fixes the case where a user accidentally closes a tab and reopens — they get their PTY back as long as they're under the grace period.

If a session ID was never sent on reconnect (unlikely — the dashboard URL routing should preserve it), the new connection becomes a fresh session.

### Test plan

- Manual: open dashboard, spawn 4 PTYs, hard-refresh. After the page reloads, `/api/sessions` should still return 4. Re-attaching to the WebSocket should resume the PTY where it left off.
- Edge: close all browser tabs for 35s (past grace period). PTYs get reaped. Confirm.
- Edge: close one tab while another is still connected to the same session (multi-tab fan-out). PTY stays alive; the other tab keeps streaming.

### Primary files

- `packages/server/src/index.js` (WS close handler, janitor, session lifecycle)
- `packages/client/public/app.js` (reconnect logic — confirm session ID is sent on reconnect)

### Coordination notes

- This bug is not in the original PLANNING.md. It's a HIGH-priority supplement added at sprint kickoff because Joshua hit it at Sprint 35 close and dashboard work is already this lane's primary domain.
- If Deliverable A or B blow up the lane budget, document in STATUS and stop at A-only or A+B. C can fast-follow as Sprint 36.5.

---

## Out of scope

- Don't touch the CLI launcher. T1 owns that.
- Don't touch MCP path code. T2 owns that.
- Don't touch hooks. T4 owns that.

## Sequence

1. **Deliverable A** first (PATCH /api/config + RAG toggle UI). Primary lane goal.
2. **Deliverable B** second (dark veil). Likely small fix once located.
3. **Deliverable C** third (hard-refresh PTY loss). Bigger; if running short, document state and let it fast-follow.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-36-launcher-ui-parity/STATUS.md` under `## T3`, separated by deliverable (A/B/C). No version bumps. No commits. Stay in your lane.
