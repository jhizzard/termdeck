# Sprint 65 — Dashboard reliability + orch-panel awareness wave

**Authored:** 2026-05-14 (queued behind Sprint 64).
**Inject:** pending Sprint 64 close + Joshua's "terminals open" signal.
**Pattern:** 3+1+1 — three Claude worker lanes (T1/T2/T3), one Codex auditor (T4), one orchestrator.
**Wave target:** `@jhizzard/termdeck@1.4.0` (minor — new `meta.role` field on `POST /api/sessions` is a public API surface change) + `@jhizzard/termdeck-stack@1.4.0` (audit-trail aligned). `@jhizzard/mnestra` unchanged unless companion patch surfaces.
**Acceptance:** T4-CODEX FINAL-VERDICT GREEN with file:line evidence for all three lanes; Brad's "opens invisible" repro adjudicated; chip switch <100ms; ORCH pin distinguishable from 6+ feet; panel-exit auto-removes tile within 1s; dead-panel inject returns `410 Gone`.

---

## Why this sprint exists

Three categories of dashboard-reliability + orchestrator-visibility asks accumulated across Brad's 2026-05-12 and 2026-05-13 feedback waves (captured verbatim in `docs/BACKLOG.md` § D.5). They all touch the same dashboard surface (`packages/client/public/app.js` + `packages/server/src/session.js`), so bundling them as one sprint is more efficient than three separate hotfixes.

The three categories:

1. **Per-product visibility filter + ORCH-pin (Brad 2026-05-13 v2 spec).** Project-filter chips at top of dashboard auto-discovered from `meta.project`; click filters the grid; selected state persists in `localStorage`. Plus the orchestrator panel always visible + visually distinct via gold/amber border + ORCH text badge + pinned top-left position. Identification via explicit `meta.role` flag (Approach A; recommended over cwd-inference Approach B per BACKLOG entry).

2. **CLI panels must (a) open visible AND (b) auto-close (Brad 2026-05-12 item 2).** Two sub-bugs: (a) panels sometimes create off-screen / hidden / behind-modal (need Brad's repro to scope); (b) when a CLI panel's underlying process exits, the grid tile stays as "dead" until manually removed.

3. **Orchestrator-aware-of-dead-panels (Brad 2026-05-12 item 3).** `/api/sessions` returns dead panels indistinguishable from live ones. Brad's smoking gun: 18 windows open, 10 were dead Codex CLI. Extends the existing P0 idle/parked detection (Sprint 59-surfaced) — bundle here since they share the `session.js` status-flip surface.

**Why bundled in one sprint and not three.** The chips filter, the orch pin, the tile-auto-removal, the dead-panel filter, the role flag, and the idle/parked detection ALL converge on `meta.role` + `meta.status` lifecycle + WS frame shape. One sprint with coherent T1/T2 split is cleaner than three hotfixes that each re-litigate the same surfaces.

---

## Lane structure (3+1+1)

| Lane | Owner | Focus | Why this shape |
|------|-------|-------|----------------|
| T1 | Claude | **Client** — chips + ORCH visual + tile removal + `panel--role-orch` CSS + optional Path A 10/12-panel layouts | Single client-side surface (`app.js` + `style.css`); cohesive UI work |
| T2 | Claude | **Server** — `meta.role` + filter exited sessions + `410 Gone` on dead-panel inject + WS exit propagation + per-adapter idle/parked detection | Single server-side surface (`index.js` + `session.js` + agent-adapters); status-flip lifecycle |
| T3 | Claude | **Verification + 2a "opens invisible" repro + Brad's 18-panel-2-project repro shape** | Test lane; coordinates with Brad for the live repro |
| T4 | Codex | **Adversarial auditor** — race conditions, role-flag schema, localStorage hygiene | 3+1+1 mandate; especially load-bearing for the role-flag schema |
| Orch | Claude | **Path A fold-in adjudication + version bumps + commits + npm publishes + Brad WhatsApp at ship** | Cross-lane decisions + close-out |

---

## Scope

### T1 — Client (chips + ORCH visual + tile auto-removal)

**The biggest client-side surface this sprint.** Single lane in `packages/client/public/app.js` + `packages/client/public/style.css`. Coordinate with the existing V5-4 app.js feature-module split (BACKLOG § C) — if that split lands BEFORE Sprint 65 ships, this lane lands in `dashboard.js` / `chips.js` / `panel.js` instead of bloating `app.js`.

**1.1 — Project-filter chips at top of dashboard.**

- Horizontal row of chips above the panel grid. Container: new `<div id="project-chips" class="project-chips-row">` in `index.html` above the grid container.
- Chip content: project name + active panel count, e.g. `[ All (12) ] [ aetheria (3) ] [ structural360 (8) ] [ orch (1) ]`.
- Auto-discovery: dedupe `meta.project` across all sessions on each `status_broadcast` frame; drop `null` values (under Approach A, those become orch role; under fallback they're filtered).
- Click handler: single-select; clicking a chip filters the visible panel grid to only sessions where `meta.project === chip`. The "All" chip is the default / current behavior.
- Active-count per chip: client-side count over each `status_broadcast` frame. Renders parenthetical: `aetheria (3)`.
- Selected state persists in `localStorage` (key: `termdeck.dashboard.projectFilter`). Refresh / reconnect / new tab → restored.
- Filter mechanism: CSS class `panel--filtered-out` on hidden tiles (`display: none`) — don't tear down PTYs, just hide.

**1.2 — Orchestrator panel pin + visual distinction.**

- Panels where `meta.role === 'orchestrator'` get rendered in a dedicated row ABOVE the filtered panel grid. Pinned. Always visible regardless of which chip is selected.
- New CSS class `panel--role-orch` applied when role matches. Style:
  - Gold/amber border (suggest `border: 2px solid #d4a017;` or similar Tokyo-night-palette-aware accent).
  - Explicit `ORCH` text badge in the title bar slot adjacent to the project label.
  - Always-pinned top-left of the ORCH row (consistent position for muscle memory).
- The ORCH badge replaces the project label slot when both would render; ORCH always wins.
- If no panel has `meta.role === 'orchestrator'`, the ORCH row collapses (no empty pinned space).

**1.3 — Tile auto-removal on panel exit.**

- New WS frame handler: `case 'panel_exited':` in `app.js:230` ws.onmessage switch. Server-side T2 emits `{ type: 'panel_exited', sessionId, exitCode }` when `term.onExit` fires.
- Handler removes the tile from the DOM grid + closes the xterm.js viewport for that session id.
- Grace period: 3-second delay before tile removal so the user sees the final post-exit lines. Configurable via `TERMDECK_TILE_EXIT_GRACE_MS` env var (default 3000).
- For sessions whose `meta.status === 'exited'` AND `lastActivity` older than 60s without a corresponding `panel_exited` frame (delivery loss), auto-hide on client side as belt-and-suspenders.

**1.4 — OPTIONAL: Path A 10/12/16-panel layouts (fold-in candidate).**

Only if Sprint 65 T1 lane has bandwidth after 1.1-1.3 land cleanly. Orchestrator adjudicates at sprint inject based on T1's estimate.

- Add to `app.js:4368` layouts list: `'2x5', '5x2', '4x3', '3x4', '4x4'` for 10 / 10 / 12 / 12 / 16 panel grids.
- Add CSS Grid templates in `style.css` (precedent at lines 313-319 for the existing layouts).
- Bind keyboard shortcuts 8/9/0 to three of the new layouts (operator can override via the layout switcher).
- If skipped this sprint: re-queue as a Sprint 66 standalone.

### T2 — Server (meta.role + exited-session filtering + WS exit propagation)

Single server-side lane in `packages/server/src/session.js` + `packages/server/src/index.js` + per-adapter files. Status-flip lifecycle is the unifying surface.

**2.1 — `meta.role` field (Approach A).**

- New optional field on `POST /api/sessions` body: `role: "orchestrator" | "worker" | "reviewer" | "auditor" | null`. Default `null`.
- Wire through `spawnTerminalSession` at `packages/server/src/index.js:1118`. Add `role` to the destructure: `function spawnTerminalSession({ command, cwd, project, label, type, theme, reason, role })`.
- Persist in `sessions.create()` (`packages/server/src/session.js` — wherever the meta dict is constructed). `session.meta.role = role || null`.
- Flows through existing `status_broadcast` frame (line 2409 in index.js) unchanged — `allMeta` already serializes the full meta dict.
- Validation: reject unknown role values with `400 Bad Request`. Whitelist: `['orchestrator', 'worker', 'reviewer', 'auditor', null]`.

**2.2 — Filter exited sessions from `/api/sessions`.**

- Default behavior: `GET /api/sessions` excludes sessions where `meta.status === 'exited'`.
- Query param opt-out: `GET /api/sessions?includeExited=true` returns the legacy shape (for `termdeck doctor` + debug tooling).
- Update `sessions.getAll()` in `session.js` to accept an `includeExited` flag; default false from the route handler.

**2.3 — `410 Gone` on inject to dead panels.**

- At `POST /api/sessions/:id/input` (currently returns `200 {"ok":true,"bytes":N}` even when the underlying PTY has exited — silently no-ops, semantically wrong, debugging trap).
- Fix at `packages/server/src/index.js:1462-1512`: if `session.meta.status === 'exited'` OR `!session.pty`, return `410 Gone` with body `{ok: false, code: 'panel_exited', message: 'Panel ${id} has exited'}`.
- Cross-reference: Sprint 60's `POST /api/sessions/:id/resize` already returns `410 Gone` per same pattern (Brad's 2026-05-07 suggestion #3 fold-in). Mirror that.

**2.4 — WS `panel_exited` frame propagation.**

- When `term.onExit` fires (currently at `packages/server/src/index.js:1212-1218`), in addition to flipping `session.meta.status = 'exited'` and calling `onPanelClose`, also broadcast `{ type: 'panel_exited', sessionId, exitCode }` to all connected WS clients.
- Reuse the broadcast mechanism from `status_broadcast` (the WS hub at the top of `index.js`).

**2.5 — Per-adapter idle/parked status detection (existing P0 bundle).**

The existing P0 in BACKLOG § P0: orchestrator can't reliably tell when a panel has stopped vs. is actively reasoning. Sprint 59 documented this bit twice in 90 min. Bundle here because the fix shares `session.js` PATTERNS + agent-adapter status-flip surface.

- Add adapter-aware end-of-turn rules in `packages/server/src/agent-adapters/{codex,gemini,grok,claude}.js`:
  - **Codex:** `Worked for Xm Ys` terminator line (already documented in BACKLOG § P0).
  - **Claude Code:** idle-prompt-cursor pattern + Sprint 51 "thinking → idle" transition.
  - **Gemini / Grok:** similar terminator patterns — research at lane start.
- On detection, flip to `status: 'active'` with empty `statusDetail` (canonical idle shape).
- Plus a belt-and-suspenders 30-60s stale-`lastActivity` heuristic at the session-broadcast layer.

Cross-cutting with Sprint 64 T2's carve-out 2.4 (adapter.spawn): both touch agent-adapter files. If Sprint 65 ships after Sprint 64, the `adapter.spawn` field is already in place — extend with `adapter.idlePattern` for 2.5.

### T3 — Verification + 2a repro

**3.1 — Brad's "opens invisible" repro (2026-05-12 item 2 sub-bug 2a).**

Ask Brad for repro steps at sprint inject (orchestrator drafts the WhatsApp ask; T3 follows up if Brad's reply lands during sprint). Candidate causes (per BACKLOG entry):

- Panel created in grid slot off-screen (e.g., 6-panel grid in a 4-slot layout shows only 4).
- Panel created with `display: none` from a layout-state hangover.
- Panel rendered behind a stuck modal/overlay (2026-04-27 "dark veil" pattern, BACKLOG § A).

If Brad's repro lands: scope the fix, ship in this sprint. If not: defer 2a as a "needs repro" issue in BACKLOG and document the defer in STATUS.

**3.2 — Run T1+T2 against Brad's 18-panel-2-project repro shape.**

Brad's 2026-05-12 verbatim: "at one point I had 18 windows open. 10 were dead codex cli." Simulate:

- Spawn 18 panels: 9 codex (`type=codex`, `project=aetheria`), 9 grok (`type=grok`, `project=structural360`), 1 with `meta.role=orchestrator`.
- Kill 10 of the codex panels via `/api/sessions/:id` DELETE.
- Verify:
  - `GET /api/sessions` (default) returns 8 live panels (8 visible + 1 orch — wait, 18 - 10 = 8; plus the 1 orch is included since it's not exited; so 8 live + 1 orch = 9 panels).
  - `GET /api/sessions?includeExited=true` returns all 18.
  - Chip switch from `aetheria` to `structural360` flips visible panels in <100ms.
  - ORCH panel stays pinned visible regardless of chip selection.
  - `POST /api/sessions/<dead-id>/input` returns `410 Gone`.
  - Dead-panel tile auto-removes within 4s (3s grace + 1s render).
  - Idle/parked codex panels report `status: 'active'` with empty `statusDetail` after the `Worked for Xm Ys` terminator.

**3.3 — Acceptance checklist (operator-readable).**

Author `docs/sprint-65-dashboard-reliability/ACCEPTANCE-CHECKLIST.md` with the chip + orch + exit + dead-inject test matrix. Operator can run through it post-ship.

### T4-CODEX — Adversarial auditor

In scope:

- **Race condition audit of exit propagation.** PTY death → `term.onExit` → `session.meta.status = 'exited'` → `onPanelClose` → `panel_exited` WS broadcast → client tile removal. Walk through interleavings. What if a `status_broadcast` fires AFTER `meta.status = 'exited'` but BEFORE `panel_exited`? Does the client see a brief "exited" state in the chip count? Does it matter?
- **Role-flag schema review.** Does adding `meta.role` break the existing wizard? Does the dashboard's WS handler choke on unknown role values? Does `meta.role` land in `session_summary` rows correctly (cross-reference Sprint 62 + 63 close path)?
- **localStorage scope hygiene.** Verify the key namespace (`termdeck.dashboard.projectFilter`) doesn't collide with anything existing. Verify cross-tab behavior: open dashboard in two tabs, change filter in tab A, does tab B mirror it via the existing `projects_changed` WS broadcast or via storage event? If neither, that's expected per spec but worth documenting.
- **Count-update thrash resistance.** What happens when 18 panels spawn + 10 die in rapid succession? Does the chip count flicker? Is the count debounced?
- **CHECKPOINT discipline mandatory** per `~/.claude/CLAUDE.md` § Three hardening rules.

Out of scope: rubber-stamping. Same 3+1+1 pattern as Sprint 64 + Sprint 63.

### Orchestrator-side

- **Path A (Sprint 65 T1 sub-task 1.4) fold-in adjudication.** Decide at sprint inject whether T1's bandwidth supports 10/12/16-panel layouts. If yes, T1 ships them; if no, queue Sprint 66.
- **Brad WhatsApp at sprint open** for the "opens invisible" repro ask.
- **Brad WhatsApp at sprint close** with summary + Sprint 66 preview (likely BACKLOG D.5 deferred items or the cost-monitoring panel from `project_cost_monitoring_panel.md`).
- **Version bumps + CHANGELOG + commits + npm publishes** per the standard split (Joshua = `npm publish` Passkey; orchestrator = `git push`).
- **`gitleaks` pre-publish sweep.**
- **`docs/RESTART-PROMPT-2026-05-DD-post-sprint-65.md`** authored.

---

## Hardening rules (mandatory per global CLAUDE.md + project)

1. **Post-shape uniformity:** every lane uses `### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`. `### ` prefix REQUIRED. T4 uses `### [T4-CODEX] ...`.
2. **Auditor CHECKPOINT discipline:** T4 posts every 15 min + every phase boundary.
3. **Idle-poll regex hardening:** orchestrator uses `^(### )?\[T<n>\] DONE\b`.
4. **No forbidden literals externally.**
5. **No "pen-test" framing.**
6. **No version bumps / CHANGELOG edits / commits from lanes.**
7. **Supabase RLS hygiene** — no new functions in this sprint (client-side + server-side JS), so likely N/A. If a migration sneaks in, the 5 gates apply.

---

## Acceptance criteria

For sprint close (orchestrator scope):

- **T1:** chips render with auto-discovered project names + live counts; click filters grid; localStorage persists. ORCH panel pinned with gold/amber border + ORCH badge regardless of chip selection. Panels auto-remove from grid on exit (3s grace). Optional Path A layouts shipped if folded in.
- **T2:** `meta.role` accepted on `POST /api/sessions`; unknown values return 400. `GET /api/sessions` excludes exited by default; `?includeExited=true` returns legacy shape. `POST /api/sessions/:id/input` returns 410 on dead panels. `panel_exited` WS frame broadcast on `term.onExit`. Per-adapter idle/parked detection lands at least Codex + Claude.
- **T3:** Brad's 18-panel-2-project repro passes the acceptance matrix. `ACCEPTANCE-CHECKLIST.md` authored. 2a "opens invisible" repro either fixed-in-sprint or deferred with documented BACKLOG entry.
- **T4-CODEX:** FINAL-VERDICT GREEN with file:line evidence for all three lanes.

For ship:

- `@jhizzard/termdeck@1.4.0` published (Passkey by Joshua).
- `@jhizzard/termdeck-stack@1.4.0` published.
- Commits pushed; `git tag v1.4.0`.
- `docs/BACKLOG.md` § D.5 entries for Brad's 2026-05-12 + 2026-05-13 specs marked CLOSED; remaining D.5 carve-outs (Sprint 66+) regrouped.
- This file gains `## Resolution` section.
- `docs/RESTART-PROMPT-2026-05-DD-post-sprint-65.md` authored.

---

## Boot sequence (each lane reads this top-to-bottom)

1. `memory_recall(project="termdeck", query="<lane-specific topic>")`
2. `memory_recall(query="Brad 2026-05-13 v2 dashboard spec chips orch-pin Sprint 65 placement")`
3. `memory_recall(query="recent decisions and bugs since Sprint 64 close")`
4. Read `~/.claude/CLAUDE.md` (global rules)
5. Read `./CLAUDE.md` (TermDeck project read-order)
6. Read `docs/RESTART-PROMPT-2026-05-DD-post-sprint-64.md` (most-recent restart prompt — Sprint 64 close + Sprint 65 candidates)
7. Read `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 + 2026-05-13 entries authored 2026-05-14 + the 2026-05-14 8-panel/multi-port entry (for context on Path A fold-in)
8. Read `docs/sprint-65-dashboard-reliability/PLANNING.md` (this file)
9. Read `docs/sprint-65-dashboard-reliability/STATUS.md`
10. Read `docs/sprint-65-dashboard-reliability/T<n>-<lane>.md`

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE with the canonical `### [Tn] ...` shape. No version bumps, no CHANGELOG, no commits.

---

## Inject protocol

Same two-stage submit pattern as Sprint 64 (per `~/.claude/CLAUDE.md` § 3+1+1 sprint orchestration). One-shot Node script at `/tmp/inject-sprint-65-prompts.js`. Paste pass + 400ms settle + submit (`\r`) pass. POST `/api/sessions/:id/poke` with `methods: ['cr-flood']` if any panel idles after 8s.

---

## Resolution

**Sprint 65 closed GREEN — 2026-05-16 20:43 ET.** `### [T4-CODEX] FINAL-VERDICT GREEN`; ~65 min wall-clock inject → verdict. Wave: `@jhizzard/termdeck@1.3.0 → 1.4.0` + `@jhizzard/termdeck-stack@1.3.0 → 1.4.0` (audit-trail aligned); `@jhizzard/mnestra` unchanged at 0.4.9.

**Shipped — all four lanes DONE / GREEN:**

- **T1 client** — project-filter chips (auto-discovered, live counts, `localStorage`) + ORCH-pin row (`meta.role`-routed, gold border + ORCH badge) + tile auto-removal on `panel_exited` (3 s grace + reconcile sweep) + 1.3b status-aware `api()` (410-trap client layer) + born-hidden auto-switch (ruling F) + Path A layouts incl. `1×2`/`2x5`/`5x2`/`4x3`/`3x4`/`4x4` + global font-size stepper. `app.js +549 / index.html +34 / style.css +127`; client fence `dashboard-panels-client.test.js` (39 tests, moved in-glob).
- **T2 server** — `meta.role` field (whitelist-validated → `400 invalid_role`, SQLite-persisted with PRAGMA-guarded migration, `status_broadcast` flow-through) + exited-session filtering (`?includeExited=true` legacy restore) + `410 Gone` on dead-panel inject + `panel_exited` WS frame + per-adapter idle/parked detection verified (Sprint 60 mechanism, 7 regression tests). 29 fence tests.
- **T3 verification** — `sprint-65-acceptance.test.js` (11/11, Brad 18-panel-2-project repro) + `ACCEPTANCE-CHECKLIST.md` + `2A-OPENS-INVISIBLE-ANALYSIS.md` + `periodic-capture.test.js` date-rot fix. Root `npm test` 375/375, 0 skipped.
- **T4 Codex auditor** — 2 AUDIT-REDs (role-in-summary scope; SQLite-install migration gap) + multiple AUDIT-CONCERNs, all resolved pre-FIX-LANDED; FINAL-VERDICT GREEN with file:line evidence for all three worker lanes.

**ORCH SCOPE rulings (full text in STATUS.md):** SCOPE-1 (A–E) — Path A YES incl `1×2`, grid-resize DEFER → S66, font-size YES, dual-410 keep-both layers, 2.5 verify-only, `meta.role` dashboard-only, `:3001` stale-host do-not-restart. SCOPE-2 (F–G) — born-hidden gap in-scope → auto-switch, `periodic-capture` date-rot → T3. SCOPE-3 (H–I) — client test moved in-glob, legacy `orch` layout accepted-deferred.

**Deferred → Sprint 66** (all logged in `docs/BACKLOG.md` § D.5): draggable grid row/column resizing; 2a "opens invisible" hypotheses A/C/D (pending Brad's repro; B fixed in-sprint); `meta.role` persistence into `session_summary` rows; legacy `orch` layout gate/retire; repo-root `tests/` glob consolidation.
