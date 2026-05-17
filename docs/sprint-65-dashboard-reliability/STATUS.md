# Sprint 65 — STATUS

**Sprint:** Dashboard reliability + orch-panel awareness wave
**Pattern:** 3+1+1 (T1/T2/T3 Claude + T4 Codex auditor + Orchestrator)
**Authored:** 2026-05-14 (queued behind Sprint 64)
**Inject:** pending Sprint 64 close + Joshua's "terminals open" signal
**Wave target:** `@jhizzard/termdeck@1.4.0` + `@jhizzard/termdeck-stack@1.4.0`

---

## Post shape (mandatory)

`### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`

`### ` prefix REQUIRED on every lane. T4 uses `### [T4-CODEX] ...`.

Verbs: BOOTED / FINDING / FIX-PROPOSED / FIX-LANDED / DONE / (T4) CHECKPOINT / AUDIT-OK / AUDIT-CONCERN / AUDIT-RED / FINAL-VERDICT GREEN/YELLOW/RED / (ORCH) SCOPE / INJECT / SHIP.

---

## Orchestrator — Sprint context

- **Sprint 64** ships (or queued) — see `docs/sprint-64-install-polish-and-carveouts/PLANNING.md` § Resolution for status.
- **Sources for this sprint's scope:**
  - `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 entry (3 items) + 2026-05-13 v2 spec entry (chips + ORCH pin) + 2026-05-14 8-panel/multi-port entry (Path A fold-in candidate).
  - Existing P0 in BACKLOG § P0 — per-adapter idle/parked detection (Sprint 59-surfaced, bundled here per T2 sub-task 2.5).
- **Approach A decided** for orch identification (explicit `meta.role` flag) — see BACKLOG D.5 entry for full reasoning.
- **Path A fold-in (T1 sub-task 1.4)** — orchestrator adjudicates at inject based on T1's bandwidth estimate.

---

## Lane assignments

| Lane | Owner | Focus | Brief |
|------|-------|-------|-------|
| T1 | Claude | Client: chips + ORCH pin + tile auto-removal (+ optional Path A layouts) | `T1-client-chips-and-orch-pin.md` |
| T2 | Claude | Server: meta.role + exited filter + 410 Gone + panel_exited WS + idle/parked | `T2-server-meta-role-and-lifecycle.md` |
| T3 | Claude | Verification + Brad's 2a repro + 18-panel acceptance matrix | `T3-verification-and-repro.md` |
| T4 | Codex | Adversarial auditor — race conditions + schema + localStorage | `T4-codex-auditor.md` |

---

## Lane posts

_(lanes append here once injected)_

### [T4-CODEX] BOOTED 2026-05-16 19:40 ET — boot sequence complete; starting Phase 1 T2 schema/race-condition audit

### [T4-CODEX] CHECKPOINT 2026-05-16 19:40 ET — Phase 0 boot complete

- Verified: memory-first boot ran; global/project docs read; `docs/CRITICAL-READ-FIRST-2026-05-07.md` read and both original P0 investigations are closed in that doc. Sprint 65 STATUS currently defines T4 as adversarial auditor at lines 32-39 and had no lane posts before this entry at lines 43-45.
- Verified: T4 lane brief requires CHECKPOINT posts at phase boundaries and every 15 minutes (`docs/sprint-65-dashboard-reliability/T4-codex-auditor.md:32-44`) and Phase 1 starts with T2 race/schema audit (`T4-codex-auditor.md:62-82`).
- Pending: inspect current worker WIP/diff, then live-probe the TermDeck API at `127.0.0.1:3001` for `meta.role` schema validation, status_broadcast flow-through, `session_summary` role landing behavior, exited-session filtering, and dead-panel `410 Gone`.
- Most recent worker FIX-LANDED to verify: none present in STATUS.md as of this checkpoint.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 19:43 ET — pre-fix live probe shows role contract and dead-panel lifecycle still fully unwired

- Live probe against `127.0.0.1:3001` at 19:42 ET: `POST /api/sessions` with `role:"orchestrator"` returned `201` but response `meta` had no `role`; `POST /api/sessions` with `role:"bogus-role"` also returned `201` instead of required `400 invalid_role`.
- Source evidence matches the probe: `POST /api/sessions` destructures only `{ command, cwd, project, label, type, theme, reason }` and passes only those fields (`packages/server/src/index.js:1664-1668`); `spawnTerminalSession` accepts no `role` and passes no `role` to `sessions.create` (`packages/server/src/index.js:1251-1263`); `Session.meta` has no `role` field (`packages/server/src/session.js:161-184`); SQLite `sessions` has no `role` column or migration yet (`packages/server/src/database.js:56-70`, `database.js:128-138`).
- Live probe also confirms exited lifecycle is pre-fix: default `GET /api/sessions` still returned the exited probe sessions, and `POST /api/sessions/<exited-id>/input` returned `404 {"error":"Session is exited"}` rather than required `410 Gone` with `code:"panel_exited"`. Source evidence: route ignores `includeExited` (`packages/server/src/index.js:1241-1244`), `getAll()` returns every session (`packages/server/src/session.js:602-604`), and input-on-exited returns 404 (`packages/server/src/index.js:1729-1734`).
- Role-to-summary warning for T2: current `onPanelClose` payload carries `transcript_path`, `cwd`, `session_id`, `sessionType`, and `source_agent`, but no panel role (`packages/server/src/index.js:272-279`). The bundled session-end writer posts `memory_items` session summaries with `source_agent` only (`packages/stack-installer/assets/hooks/memory-session-end.js:654-672`) and posts `memory_sessions` without role or metadata (`memory-session-end.js:738-755`). If Sprint 65 acceptance requires role to land in session summary rows, T2 must wire it explicitly and add a fence test; do not confuse LLM `source_agent` with operator `meta.role`.
- Severity: AUDIT-CONCERN pre-fix because no T2 FIX-LANDED exists yet. This becomes AUDIT-RED if a T2 FIX-LANDED omits any of the role validation, flow-through, or session-summary landing gates above.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 19:44 ET — planned 410 body can be misreported as delivered by existing dashboard reply path

- Cross-lane trap: the client `api()` helper returns only `res.json()` and discards HTTP status / `res.ok` (`packages/client/public/app.js:31-37`). The reply path then treats any response with no `.error` property as delivered (`packages/client/public/app.js:1067-1078`).
- T2's brief proposes `410 Gone` with body `{ok:false, code:"panel_exited", message:...}` for dead-panel input (`docs/sprint-65-dashboard-reliability/T2-server-meta-role-and-lifecycle.md:115-130`). That body has no `error` key, so the current dashboard reply path would mark a dead-panel send as successful even though the HTTP status is 410.
- Required before GREEN: either T2 includes an `error` field in the 410 body for backward client compatibility, or T1 updates `api()` / `sendReply()` to preserve HTTP status and treat `{ok:false}` as failure. Add a regression test or acceptance step that sends to an exited panel from the dashboard reply UI, not only via raw curl.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 19:47 ET — live-probe target is running stale global package, not local WIP

- `127.0.0.1:3001` is listening as PID `95843`, but `lsof -a -p 95843 -d cwd` shows cwd `/Users/joshuaizzard`, not this repo. `lsof -a -p 95843 -d txt` shows native modules loaded from `/usr/local/lib/node_modules/@jhizzard/termdeck/...`.
- Package-version check: global `/usr/local/lib/node_modules/@jhizzard/termdeck/package.json` is `1.2.0`; local repo `./package.json` is `1.3.0`.
- Consequence: my live `:3001` probes are valid evidence of the current sprint instance state, but they cannot prove T1/T2/T3 WIP fixes until the instance is restarted from the local WIP tree or otherwise proven to be running the patched code. This becomes AUDIT-RED if any FIX-LANDED claims live green while `:3001` is still backed by the stale global package.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 19:48 ET — exited-session filtering can break missed-exit reconciliation

- Current server `status_broadcast` sends `sessions.getAll()` every 2s (`packages/server/src/index.js:2675-2676`). T2 is expected to make default `/api/sessions` exclude exited sessions unless `?includeExited=true`; if that is implemented by changing `SessionManager.getAll()` default behavior, the broadcast will also stop carrying exited sessions unless explicitly opted in.
- Current client `updateGlobalStats()` only updates panels that appear in the broadcast (`packages/client/public/app.js:2936-2952`). It has no "known panel disappeared from broadcast" reconciliation path today, and both main/reconnect WS handlers only mark a panel exited when they see the per-session `exit` frame (`app.js:502-504`, `app.js:1539-1541`).
- Acceptance requirement for GREEN: either keep a durable `panel_exited` broadcast plus reconnect/reload reconciliation, or make status broadcasts/reconcile logic strong enough that a dashboard which misses the exit frame cannot keep a dead tile forever. Do not rely on filtered status broadcasts alone as the 60s fallback.

### [T3] BOOTED 2026-05-16 19:49 ET — verification lane up; scaffolding 3.2 acceptance test + 3.1 hypothesis harness

- Boot sequence complete: memory-first ×5, global + project `CLAUDE.md`, `docs/CRITICAL-READ-FIRST-2026-05-07.md` (both P0 investigations confirmed closed — Inv 1 Sprint 62/63, Inv 2 Sprint 64), BACKLOG § P0 + § D.5, ARCHITECTURE § Known issues, PLANNING + STATUS + T1/T2/T3 briefs, canonical server-test harness (`adapter-session-end-writer.test.js` boot pattern: fake node-pty via `require.cache`, `createServer` + ephemeral port, tracked-`setInterval`).
- Plan: 3.2 `packages/server/tests/sprint-65-acceptance.test.js` (18-panel-2-project reproducer) — scaffolding NOW; runs end-to-end only after T1+T2 FIX-LANDED per the STATUS cross-lane dep. 3.1 2a "opens invisible" hypothesis harness — building the A-D analysis; NOT blocking on Brad's repro per ORCH intel (orchestrator chases the WhatsApp ask separately; I proceed with 3.2/3.3, fold Brad's reply if it lands mid-sprint, else defer 2a as a documented BACKLOG "needs repro" entry). 3.3 `ACCEPTANCE-CHECKLIST.md`. 3.4 `npm test` regression sweep at close.
- ORCH intel acknowledged: sprint instance on :3001, unrelated instance on :3000 — I probe NEITHER. The live destructive 18-panel repro uses a fresh isolated `termdeck --port 3002 --no-open`. The `sprint-65-acceptance.test.js` file itself is hermetic (in-process `createServer` + ephemeral port + fake node-pty) — needs no external instance, runs clean under `npm test`. (This sidesteps T4's 19:47 point that `:3001` runs the stale global `1.2.0`, not local WIP.)
- Folding two of T4-CODEX's six pre-fix posts (19:40-19:48) into the acceptance surface: (a) the 410-body-vs-client-`api()` trap (19:44) → an explicit ACCEPTANCE-CHECKLIST step that sends to a dead panel **from the dashboard reply UI**, not only curl; (b) the exited-filter-vs-`status_broadcast` reconciliation risk (19:48) → the acceptance test asserts a dashboard that misses the `panel_exited` frame still cannot keep a dead tile forever.

### [T3] FINDING 2026-05-16 19:49 ET — 18-panel fixture: "kill" must be PTY-exit, not DELETE (faithful to Brad's bug)

- The 3.2 brief fixture pseudocode kills 10 panels via `DELETE /api/sessions/:id`. But `DELETE` calls `sessions.remove()` → `this.sessions.delete(id)` — the session leaves the in-memory Map entirely (`index.js:1721` → `session.js:644-659`). A DELETE'd session is absent from `getAll()`, so `GET /api/sessions?includeExited=true` would return 9, not 19 — contradicting the assertion table.
- Brad's actual bug ("18 windows open, 10 dead codex cli") is PTY processes that EXITED (codex `/exit`, crash): `term.onExit` fires → `meta.status='exited'`, the session STAYS in the Map with a lingering tile. That's the dead-vs-live conflation Sprint 65 targets. DELETE is operator-initiated removal — a different, already-clean path.
- Resolution (in-lane, no ORCH action needed): `sprint-65-acceptance.test.js` kills the 10 via PTY-exit (`term._emitExit()` on the fake node-pty), faithfully reproducing Brad's shape. DELETE-removal is covered separately in `ACCEPTANCE-CHECKLIST.md`. Flagging so T2's `?includeExited` semantics are read correctly: they apply to PTY-exited (`status='exited'`, still in Map) sessions, not DELETE'd ones.

### [T3] FINDING 2026-05-16 19:49 ET — stale-status collision: T2 sub-task 2.5 vs pre-existing Sprint-60 toJSON guard

- T2 2.5 plans a stale-`lastActivity` heuristic flipping `thinking`/`reasoning` → `active` at 60000ms in the broadcast tick. But a Sprint-60 guard already exists in `Session.toJSON()` (`session.js:518-543`; `Session.STICKY_STATUSES = {thinking, editing}`, `STALE_STATUS_THRESHOLD_MS = 30000`) that flips `thinking`/`editing` → **`idle`** at 30s.
- Collision: for a `thinking` session the toJSON guard fires first (30s → `idle`); T2's 60s → `active` branch for `thinking` becomes partially dead code, and the two paths disagree on the canonical idle shape (`idle` vs `active`).
- For T2: please reconcile explicitly — e.g. (a) 2.5 handles only `reasoning` (not in STICKY_STATUSES) and defers `thinking`/`editing` to the existing guard, or (b) unify into one guard with one threshold + one target status. The acceptance test will assert the robust invariant — a stale parked panel must NOT report `thinking`/`reasoning`/`editing` (must not be misread as actively busy) — and tighten to the exact target string once T2 documents it in FIX-LANDED.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 19:50 ET — T3 acceptance fixture must fix the 9-codex/kill-10 mismatch too

- T3 correctly caught DELETE-vs-PTY-exit, but the 3.2 pseudo-code also creates only 9 codex + 9 grok + 1 orch sessions and then says to kill 10 codex panels (`docs/sprint-65-dashboard-reliability/T3-verification-and-repro.md:50-75`). There are only 9 codex panels in that fixture.
- Required before GREEN: the landed `packages/server/tests/sprint-65-acceptance.test.js` must use a coherent Brad-shape, e.g. 10 codex + 8 grok + 1 orch, then PTY-exit the 10 codex sessions and assert 8 workers + 1 orch remain. Do not let `sessions[9]` be a grok panel while the test description says it is killing the 10th codex panel.

### [T1] BOOTED 2026-05-16 19:50 ET — client lane up; 1.1-1.3 fully specced, starting now

Boot complete: 3× memory_recall, global+project CLAUDE.md, RESTART-PROMPT-2026-05-14, BACKLOG § D.5 (incl. the 2026-05-16 entry), PLANNING.md, STATUS.md, T1 brief + T2 brief (for the cross-lane contract). `docs/CRITICAL-READ-FIRST-2026-05-07.md` context confirmed via the restart prompt — both P0 investigations closed at Sprint 64.

**Architecture note (relevant to T4's audit + T2):** TermDeck does NOT re-render tiles per frame. Panels are persistent DOM + live xterm.js + per-panel WS, created once via `createTerminalPanel` (app.js:336), appended to `#termGrid` (app.js:436); `status_broadcast` only updates meta + counts via `updateGlobalStats` (app.js:2936) — it never recreates panels. So the brief's "iterate sessions to render tiles, check meta.role" model is adapted: ORCH-row routing happens at `createTerminalPanel` time + a cheap idempotent reconcile on `status_broadcast` (role is immutable post-spawn). The `panel_exited` handler goes in BOTH `ws.onmessage` switches — main (app.js:477) + reconnect (app.js:1521).

Building against T2's contract from the T2 brief: `meta.role` ∈ {orchestrator,worker,reviewer,auditor,null}; `panel_exited` = `{type,sessionId,exitCode,signal,exitedAt}`. No blocker — landing client code now; end-to-end-meaningful once T2 lands.

**Re T4's 19:47 + 19:48 findings:** (19:47) the `:3001` instance runs the stale global 1.2.0 package, so my local `app.js`/`style.css`/`index.html` edits need the instance restarted from this WIP tree before T3/T4 can live-verify. (19:48) my 1.3 belt-and-suspenders is designed for the filtered-broadcast case — it reconciles on **"a known DOM panel is absent from the broadcast session list"** (with a grace timer), NOT on `meta.status === 'exited'` surviving the broadcast — so it holds whether or not T2 filters exited from `status_broadcast`. Primary path stays the durable `panel_exited` frame; full-reload reconciliation is automatic via the filtered `GET /api/sessions`.

Starting 1.1 (chips) → 1.2 (ORCH pin) → 1.3 (tile auto-removal) — all three fully specified, no open design questions.

### [T1] FINDING 2026-05-16 19:50 ET — 1.4 Path A bandwidth + estimates for Joshua's 2026-05-16 (b)/(c); taking T4's 19:44 410-trap client fix

Per ORCH intel — estimates for ORCH to adjudicate fold-in:

**1.4 — Path A layouts (incl. Joshua's "1×2").** FOLD-IN RECOMMENDED. `1x2` CSS already exists (style.css:315) — needs only a topbar button + keyboard-array entry (~2 LOC). `2x5/5x2/4x3/3x4/4x4`: 5 CSS grid templates + 5 buttons + keyboard bindings, ~35-45 LOC across index.html/style.css/app.js. All-in ~40-50 LOC, ~30-45 min, low risk, CSS-mechanical. Recommend YES — contingent on 1.1-1.3 landing clean first.

**(b) — Draggable grid row/column resizing.** RECOMMEND DEFER → Sprint 66. CSS Grid has no native draggable gutters: needs overlay drag-handles + pointer-drag logic + per-layout `fr`-track manipulation + per-layout localStorage persistence + preset-switcher interaction rules. ~200-350 LOC — larger than 1.1-1.3 combined; cousin of the deferred "PTY drag/drop window rearrangement" (BACKLOG § C); deserves its own scoping pass. Folding in risks the sprint timeline.

**(c) — Per-panel CLI font-size control.** FOLDABLE — ORCH's call. xterm.js supports live font-size (`terminal.options.fontSize = N; fitAddon.fit()`). Per-panel +/- stepper in the header (or Overview drawer) + apply + server resize + localStorage. ~70-100 LOC; touches the panel-header template I'm already editing for the ORCH badge, so marginal cost is lower. Recommend: fold in only if 1.1-1.4 land with time to spare; else Sprint 66.

**T4's 19:44 AUDIT-CONCERN (410-body trap):** confirmed in source — `api()` (app.js:32-37) discards HTTP status; `sendReply()` (app.js:1074) gates on `!result.error`, so T2's planned `410 {ok:false,code,message}` body (no `error` key) would be misreported as delivered. The client-side fix is in my lane and is the robust option (a status-aware `api()` fixes ALL non-2xx callers, not just this one). Taking it as sub-task **1.3b**: `api()` synthesizes an `error` field + attaches `_httpStatus` on non-2xx → `sendReply()` becomes correct automatically; +1 regression test sending to an exited panel via the reply UI. Redirect me if ORCH wants T2 to own it server-side instead — the two fixes are belt-and-suspenders-compatible, no conflict.

Holding 1.4/(b)/(c) for ORCH SCOPE. Proceeding with 1.1-1.3 + 1.3b now.

### [T4-CODEX] CHECKPOINT 2026-05-16 19:53 ET — Phase 1 audit active; no implementation diff landed yet

- Worker status observed: T3 BOOTED + two findings at 19:49; T1 BOOTED + scope finding at 19:50; T2 has not posted yet in `STATUS.md`.
- Worktree status at checkpoint: no Sprint 65 source/test files are modified yet; only pre-existing docs plus this `STATUS.md` have changed. T1/T3 claims remain unverified until the actual diffs land.
- T4 standing gates before GREEN: live `:3001` must be proven to run local WIP before live green claims; T2 must wire strict `role` validation + WS `panel_exited` + role landing in session-summary rows; T1 must implement status-aware `api()` and missed-exit reconciliation as posted; T3 must fix both DELETE-vs-PTY-exit and the 9-codex/kill-10 fixture mismatch.

### [T2] BOOTED 2026-05-16 19:59 ET — server lane up; codebase fully verified, 3 FINDINGs below

Boot complete: memory_recall ×4, global+project `CLAUDE.md`, `docs/CRITICAL-READ-FIRST-2026-05-07.md` (both P0 investigations confirmed closed — Inv 1 Sprint 62/63, Inv 2 Sprint 64), RESTART-PROMPT-2026-05-14, BACKLOG §P0+§D.5, PLANNING, STATUS, T2 brief. Read full server surface: `index.js` (2984 LOC), `session.js`, `database.js`, all 4 agent-adapters, `session.test.js` + `adapter-session-end-writer.test.js` (the route-level harness I'll reuse — hermetic `createServer`+fake-pty, sidesteps T4's stale-`:3001` 19:47 concern). Net-new lanes 2.1–2.4 confirmed unwired (matches T4's 19:43 probe). FINDINGs below don't block — landing code now.

### [T2] FINDING 2026-05-16 19:59 ET — SQLite migration path: brief's `setup/migrations/` dir does not exist

T2 brief 2.1 proposes `packages/server/src/setup/migrations/00<next>_session_role.sql`. **That dir does not exist** (only `setup/rumen/migrations/` — Rumen's, unrelated). TermDeck's SQLite migrations are **inline PRAGMA-guarded ALTERs in `database.js::initDatabase()`** — precedents `command_history.source` (database.js:108-118) + `sessions.theme_override` (database.js:128-138). Brief hedged this ("verify at lane boot"). **Resolution:** `role TEXT` added to the inline `CREATE TABLE sessions` block + a PRAGMA-guarded ALTER block mirroring `theme_override`. No new .sql file.

### [T2] FINDING 2026-05-16 20:00 ET — 2.5 (per-adapter idle/parked detection) already shipped Sprint 60 v1.0.14 — resolves T3 19:49

**Supersedes T3's 19:49 stale-status-collision FINDING** and answers its "please reconcile explicitly" ask. Sub-task 2.5's mechanism already exists in production — shipped Sprint 60 v1.0.14 (hotfix bundle item 3; Sprint 60 T4-CODEX recorded "Item 1 per-adapter idle detection passed"):
- **Codex end-of-turn:** `codex.js:81` `END_OF_TURN = /─\s*Worked for\s+(?:\d+m\s*)?\d+s\s*─/`, checked FIRST in `statusFor` → `{status:'idle'}`. Exactly the `Worked for Xm Ys` terminator BACKLOG §P0 names.
- **Idle branch in every adapter `statusFor`:** claude `/^>\s*$/m`, gemini `/^gemini>\s/m`, grok `/Message Grok[….]\s*$/m`, codex `/^codex\s*$/m` — all → `{status:'idle'}`.
- **Belt-and-suspenders:** `session.js::toJSON()` 518-543 — `STICKY_STATUSES={thinking,editing}`, 30000ms → flips stuck thinking/editing → `idle`.

The brief's proposed `adapter.idlePattern` field would be a **redundant 2nd copy of `END_OF_TURN`**; its proposed 60s broadcast-layer heuristic **duplicates** the existing 30s toJSON guard (and conflicts — brief flips→`active`, existing flips→`idle`; brief's `reasoning` is not a real status, Codex emits `status:'thinking'`). **Resolution:** 2.5 = verify + add regression test coverage pinning the shipped behavior; **no `idlePattern` field, no duplicate heuristic** — no collision because the colliding code is never added. **Canonical idle shape for T3's acceptance assertion:** a parked panel with `status∈{thinking,editing}` + `lastActivity` >30s old serializes via `toJSON()` to `status:'idle'`, `statusDetail:''`. T3 — assert that, not a 60s/`active` shape. Recommend ORCH strike the idle/parked entry from BACKLOG §P0 at wrap (Sprint 60 closed it; BACKLOG never updated). Open to ORCH override if a forward-compat reason for the explicit field is wanted.

### [T2] FINDING 2026-05-16 20:01 ET — status_broadcast / 410-body / role-vs-source_agent — resolves T4 19:43+19:44+19:48

Three cross-lane contract decisions, locked:

1. **status_broadcast (resolves T4 19:48 + confirms T1 19:50).** `SessionManager.getAll()` default stays **legacy (includes exited)** — only the `GET /api/sessions` route opts into the filtered view (default on; `?includeExited=true` = legacy). `status_broadcast` (index.js:2675, bare `getAll()`) and the projects-route live-PTY guard are **unchanged** → still carry exited sessions, so T1's missed-exit reconciliation keeps its data. Durable primary signal = the `panel_exited` WS frame (2.4); filtered-broadcast omission is NOT the fallback. T1's 19:50 reconcile-on-absent holds either way.

2. **410 body (resolves T4 19:44).** Dead-panel `POST /api/sessions/:id/input` returns `410` with body `{ok:false, code:'panel_exited', error:<msg>, message:<msg>, exitCode, exitedAt}` — **includes `error`** (backward-compat with the current client `api()`/`sendReply()` no-`.error`=success path) AND `code` (programmatic discriminator) AND `ok:false`. Belt-and-suspenders with T1's 1.3b status-aware `api()` — both coexist, no conflict.

3. **role vs source_agent (re T4 19:43 — ORCH scope call).** `meta.role` is operator-set panel identity for the **live dashboard** (Brad's spec: chips + ORCH pin); it flows through `status_broadcast`. `source_agent` (LLM identity: claude/codex/…) and `meta.role` (operator role) are distinct axes. Adding `meta.role` does **not break** the session-end path (`onPanelClose` builds its payload from an explicit field list — verified index.js:272-279). Persisting `role` *into* `session_summary`/`memory_sessions` rows is **not in Brad's spec and not in T2's 5 sub-tasks** — it touches the bundled hook in `packages/stack-installer/` (different package). I read T4's PLANNING scope line "does role land in session_summary correctly" as "adding meta.role must not corrupt session_summary" (it doesn't) — not "role must be persisted there." If ORCH wants role-in-summary analytics, that's an explicit scope add → flagging for ORCH SCOPE, not silently expanding or refusing.

### [T2] FIX-PROPOSED 2026-05-16 20:01 ET — implementing 2.1–2.4 now; 2.5 = verify+test per FINDING above

Landing order: 2.1 (`role` field + validation + migration) → 2.2 (`getAll` filter + route) → 2.3 (410) → 2.4 (`panel_exited` WS + `meta.exitedAt`). Then a hermetic route-level fence file + `session.test.js` extensions. Will post FIX-LANDED with the file:line map + `npm test` result.

### [T4-CODEX] AUDIT-RED 2026-05-16 19:57 ET — T2 FIX-PROPOSED excludes the mandatory role-in-session-summary gate

- Blocking scope mismatch: ORCH intel for T4 at sprint inject explicitly named T2's new `meta.role` as the load-bearing v1.4.0 public-API change and required audit of "whether it lands correctly in `session_summary` rows." T2's 20:01 FINDING says role-in-summary is not in Brad's spec / not in T2 scope and will not be implemented without ORCH SCOPE.
- Current architecture means this is not a harmless omission: non-Claude panels write session summaries through server `onPanelClose`, whose payload has no role today (`packages/server/src/index.js:272-279`); Claude panels are skipped there and use Claude's own SessionEnd hook, so an ORCH Claude panel has no obvious path for TermDeck `meta.role` to reach `memory_items` / `memory_sessions` at all. The bundled hook also currently ignores any role-like field (`packages/stack-installer/assets/hooks/memory-session-end.js:654-672`, `738-755`).
- Required to clear RED: ORCH must explicitly adjudicate one of two outcomes before T2 can be GREEN: (1) role-in-summary is in Sprint 65 scope, with a concrete write path + tests (prefer `metadata.role` in both `memory_items` and `memory_sessions`, since both tables already have `metadata jsonb`), or (2) role is dashboard-only for v1.4.0 and the `session_summary` gap is documented as an accepted limitation/backlog item. T2 cannot mark this "resolved" by interpreting the required audit gate away.

### [T4-CODEX] AUDIT-RED 2026-05-16 20:00 ET — current T2 WIP breaks existing SQLite installs

- Product blocker in the current diff: `packages/server/src/database.js` adds `role TEXT` only to the `CREATE TABLE IF NOT EXISTS sessions` shape, while `packages/server/src/session.js` now inserts into the `role` column. There is no PRAGMA-guarded `ALTER TABLE sessions ADD COLUMN role TEXT` migration in the diff.
- Existing daily-driver DB proof: `sqlite3 ~/.termdeck/termdeck.db 'pragma table_info(sessions);'` still has columns `id..theme_override` and no `role`. With the current WIP code, the first `sessions.create()` on an existing install will hit SQLite with `INSERT INTO sessions (..., role)` and fail `table sessions has no column named role`.
- Required before T2 FIX-LANDED: add the same idempotent PRAGMA migration pattern used for `command_history.source` and `sessions.theme_override` in `database.js`, and add a regression test that opens an old-shape temp DB then creates a session successfully.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 20:00 ET — new sprint acceptance test is red because its feature probe pollutes counts

- I ran `node --test packages/server/tests/sprint-65-acceptance.test.js` against the current WIP. Result: exit 1, 11 tests, 6 pass, 5 fail.
- Root cause: `probeT2Landed()` creates a live `td-t2-probe` session (`packages/server/tests/sprint-65-acceptance.test.js:240-242`) inside the same test server. The Brad repro then spawns 10 codex + 8 grok + 1 orch and asserts 19 total (`:328`), but the probe is still live, so the actual count is 20. Downstream assertions fail as 10 live vs expected 9 and two null-project panels vs expected one.
- Required before T3/T2 GREEN: make the feature probe non-mutating, run it in a separate throwaway server, or remove/exit/delete the probe session before the 19-panel fixture assertions. The test must be green with zero skips at sprint close.

### [T4-CODEX] CHECKPOINT 2026-05-16 20:02 ET — SQLite role migration blocker cleared in WIP; other blockers remain

- T2 added the PRAGMA-guarded `ALTER TABLE sessions ADD COLUMN role TEXT` path in `packages/server/src/database.js`.
- I verified it locally against an old-shape temp SQLite DB: `initDatabase()` added `role`, then `SessionManager.create({role:"orchestrator"})` inserted and persisted `role="orchestrator"` successfully (`role migration ok`).
- Clearing the 20:00 SQLite-install RED on current WIP. Still open: the 19:57 role-in-session-summary RED pending ORCH adjudication, and the 20:00 acceptance-test probe-pollution concern.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 20:04 ET — current T1 WIP defines helpers but does not wire the dashboard behavior yet

- Current `packages/client/public/app.js` WIP has the status-aware `api()` fix wired, but the core Sprint 65 dashboard helpers are mostly dead code so far: `placePanel()`, `handlePanelExited()`, `reconcileExitedPanels()`, `scheduleChromeRefresh()`, and `onProjectChipClick()` are definitions only.
- Evidence: `createTerminalPanel()` still appends every tile directly to `#termGrid` instead of `placePanel()`; the main and reconnect WS switches still have no `case 'panel_exited'`; `updateGlobalStats()` still only updates existing panels and stats, with no `reconcileExitedPanels()` or chrome refresh call.
- Also no `packages/client/public/index.html` / `style.css` diff is present yet, so `#project-chips`, `#orch-pin-row`, `.panel--role-orch`, `.panel--filtered-out`, `.project-chip`, and `.panel--exiting` do not exist in the DOM/CSS surface. This is fine as WIP, but it is not close to FIX-LANDED.

### [T3] FIX-LANDED 2026-05-16 20:07 ET — sprint-65-acceptance.test.js authored + 11/11 GREEN; resolves T4 19:50 + 20:00 concerns

- NEW `packages/server/tests/sprint-65-acceptance.test.js` (~345 LOC). `node --test packages/server/tests/sprint-65-acceptance.test.js` → **11 pass / 0 fail / 0 skipped**. Hermetic: fake node-pty via `require.cache` + in-process `createServer` + ephemeral port + tracked-`setInterval` (the `adapter-session-end-writer.test.js` harness). No dependency on :3001/:3000 — sidesteps T4's 19:47 stale-package point. tempHOME + stubbed session-end spawn + dropped `DATABASE_URL` → it cannot touch the real Mnestra DB.
- **Resolves T4 20:00 AUDIT-CONCERN (probe pollution).** T4 ran an interim version (6 pass / 5 fail) where `probeT2Landed()` left a live `td-t2-probe` session inflating every count by 1. FIXED: the probe now `DELETE`s its session before returning. Re-ran post-fix → 11 / 0 / 0. T4 — please re-verify against the current file.
- **Resolves T4 19:50 AUDIT-CONCERN + the 19:53 gate (9-codex/kill-10 mismatch + DELETE-vs-PTY-exit).** The landed test uses **10 codex (aetheria) + 8 grok (structural360) + 1 orchestrator = 19**, kills all 10 codex via **PTY-exit** (`term._emitExit`, not DELETE), asserts 9 live (8 grok + 1 orch) + 10 exited. Both corrections + rationale are documented in the file header.
- Verified GREEN — the SERVER half of the acceptance matrix: T2.1 role contract (4 roles round-trip, unknown→`400 invalid_role`, absent→`null`); `?includeExited=true`→19; default `GET /api/sessions`→9 (exited filtered out); `410 Gone` w/ `code:'panel_exited'` on dead-panel input + a live panel still 200; `panel_exited` WS frame broadcast per PTY exit; status_broadcast live-set == default GET (T4 19:48 reconciliation pin); codex `Worked for Xm Ys`→`status:'idle'`/`statusDetail:''`; 65s-stale `thinking`→`idle`.
- My 19:49 stale-collision FINDING — **T2's FINDING 20:00 supersedes it; accepted.** 2.5 already shipped Sprint 60 (codex.js `END_OF_TURN`); no `idlePattern` field / 60s heuristic is added, so there is no collision. I tightened the two idle assertions to T2's documented canonical shape — `status:'idle'`, `statusDetail:''` — and confirmed green. The codex-idle + stale-thinking tests are UNGATED (Sprint-60 behavior) → live regression fences.
- Scope notes: 11/11 GREEN is against T2's current working-tree code (T2 at FIX-PROPOSED) — I re-run at T2 FIX-LANDED + at sprint close. The CLIENT half of the matrix (chip switch <100ms, ORCH-pin DOM, tile-removal animation) is not automatable from a `packages/server/tests/` process → it goes into `ACCEPTANCE-CHECKLIST.md` (3.3, next) as operator steps + the live `termdeck --port 3002` repro. The T2↔T4 role-in-session-summary dispute (19:57) is outside T3's API-contract test scope — ORCH adjudicates.
- Next: 3.1 2a "opens invisible" hypothesis analysis, 3.3 `ACCEPTANCE-CHECKLIST.md`, then 3.4 full `npm test` regression sweep.

### [ORCH] SCOPE 2026-05-16 20:08 ET — 6 adjudications + clears T4 AUDIT-RED 19:57; Path A YES(incl 1x2) / grid-resize DEFER S66 / font-size YES-contingent / dual-410 keep-both / 2.5 verify-only / role=dashboard-only / :3001 stale-host do-not-restart

T4 audit status acknowledged: 20:00 SQLite-install RED — cleared by T2's PRAGMA-guarded ALTER + T4-verified (20:02 CHECKPOINT). 19:57 role-in-summary RED — cleared by ruling D below. 20:00 acceptance-probe-pollution CONCERN — T3 action, see marching orders.

**A. T1 1.4 + Joshua's 2026-05-16 (b)/(c) (re T1 FINDING 19:50).**
- **1.4 Path A layouts incl. `1x2` — APPROVED**, contingent on 1.1-1.3 landing clean first. T1's ~40-50 LOC / low-risk / CSS-mechanical estimate accepted; `1x2` ships (Joshua asked for it explicitly).
- **(b) draggable grid row/column resizing — DEFER -> Sprint 66.** Agreed with T1: ~200-350 LOC, larger than the sprint core, own scoping pass. Already in `docs/BACKLOG.md` D.5 (2026-05-16 entry) — no lane action.
- **(c) per-panel CLI font-size — APPROVED, contingent**, sequenced AFTER 1.1-1.4; drops to Sprint 66 if the sprint runs tight.

**B. 410-trap fix (re T1 1.3b + T2 FINDING 20:01 #2) — KEEP BOTH LAYERS.** T1's status-aware `api()` + T2's `error` key in the 410 body. Defense-in-depth, no conflict — both land, no redirect.

**C. 2.5 idle/parked (re T2 FINDING 20:00, supersedes T3 FINDING 19:49) — ENDORSED.** Sprint 60 v1.0.14 already shipped per-adapter idle detection. 2.5 = verify + pin with regression tests. NO new `adapter.idlePattern` field, NO 60s broadcast heuristic (collides with the existing 30s `toJSON` guard). T3: assert the canonical shape — a parked panel (`status in {thinking,editing}`, `lastActivity`>30s) serializes via `toJSON()` to `status:'idle'`, `statusDetail:''`. ORCH strikes the idle/parked entry from BACKLOG P0 at wrap.

**D. role vs session_summary — ADJUDICATED: `meta.role` is DASHBOARD-ONLY for v1.4.0 (clears T4 AUDIT-RED 19:57).** T4 correctly refused to let T2 narrow this by interpretation and demanded an explicit ORCH call — right behavior. Ruling = T4's option (2): `meta.role` is operator panel-identity for the LIVE dashboard only (Brad's chips + ORCH-pin spec). It is NOT persisted into `session_summary` / `memory_items` / `memory_sessions` rows in Sprint 65. Rationale: (a) Brad's v2 spec — this sprint's source of truth — is dashboard-only; (b) no consumer of role-in-summary exists, so persisting it now is speculative dead data; (c) it would expand T2's lane into the bundled session-end hook (`packages/stack-installer/`), a surface deliberately stabilized by Investigations 1+2 (Sprints 62-64) — out of bounds for a dashboard-reliability sprint. ORCH owns the ambiguity: my T4 inject intel said "whether `meta.role` lands correctly in `session_summary` rows" — that was imprecise. The intended gate is "adding `meta.role` must not CORRUPT the session-end / `session_summary` path" (T2 verified `onPanelClose` builds its payload from an explicit field list, index.js:272-279 — so it doesn't), NOT "role must persist in summary rows." ORCH will log "role-in-session-summary analytics — deferred, revisit when an analytics consumer exists" as a BACKLOG D.5 entry at wrap — the documented accepted limitation T4's option (2) requires. T4: re-audit against the corrected gate — verify `meta.role` does not corrupt session_summary; role-in-summary is explicitly descoped, not omitted-by-interpretation. 19:57 RED cleared.

**E. Stale :3001 (re T4 AUDIT-CONCERN 19:47) — :3001 is the live sprint host; DO NOT restart it.** :3001 runs the global `@jhizzard/termdeck` 1.2.0 AND hosts the four live sprint-panel PTYs — restarting it kills the sprint. Verification of record for WIP = hermetic `npm test` (T3's `sprint-65-acceptance.test.js` + T2's route-level fence file + `session.test.js` extensions — in-process server from local code). For any LIVE probe of WIP, launch a fresh instance FROM THE LOCAL REPO TREE on a clean port (e.g. `node packages/cli/src/index.js --port 3003 --no-open`) — NOT the global `termdeck` binary (1.2.0), NOT :3001. T4's prior :3001 probes stand as the valid PRE-FIX baseline. No FIX-LANDED may claim "live green" citing :3001.

Marching orders: **T1** — 1.1-1.3 -> 1.4 (incl `1x2`) -> (c) if bandwidth. **T2** — 2.1-2.4 + 2.5-as-verify-only; role is dashboard-only per D, do NOT wire role-in-summary. **T3** — fixture = 10 codex + 8 grok + 1 orch with PTY-exit kills (T4 19:50), AND make `probeT2Landed()` non-mutating / cleaned-up so it does not pollute the 19-panel count (T4 AUDIT-CONCERN 20:00); `sprint-65-acceptance.test.js` green with zero skips at close. **T4** — audit gates per D + E; 19:57 + 20:00-SQLite REDs cleared, re-audit on each FIX-LANDED.

### [ORCH] 2026-05-16 20:08 ET — Brad 2a "opens invisible" repro WhatsApp SENT (STATUS Brad-outreach item 1)

Sent to Brad via WhatsApp shortly before this post (osascript-confirmed: Return pressed in WhatsApp Desktop). Asked for: active grid layout, panel count, what spawned the invisible panel (codex/claude/shell), off-screen vs behind-modal vs blank, + a screenshot. T3 — proceed with 3.2/3.3 per your 19:49 plan; if Brad replies mid-sprint ORCH relays it here, else 2a defers as a documented BACKLOG "needs repro" entry.

### [T4-CODEX] CHECKPOINT 2026-05-16 20:08 ET — ORCH scope accepted; server/T3 targeted tests green; client CSS still pending

- ORCH SCOPE 20:08 clears my 19:57 role-in-`session_summary` RED by explicitly adjudicating `meta.role` as dashboard-only for v1.4.0 and requiring a documented deferred analytics limitation. I accept the corrected gate: verify `meta.role` does not corrupt session-end/session_summary flow; do not require role persistence in summary rows this sprint.
- Re-verified T3 FIX-LANDED: `node --test packages/server/tests/sprint-65-acceptance.test.js` passes 11/11 with 0 skips, so the 20:00 probe-pollution concern is cleared.
- Additional targeted verification green: `node --test packages/server/tests/session-lifecycle-api.test.js packages/server/tests/session.test.js tests/ws-handler-contract.test.js` passes 68/68. This covers role validation/round-trip, exited filtering, 410 body, `panel_exited` WS emission + client handler parity, SQLite role migration, and existing Session behavior.
- T1 WIP update: `app.js` now wires `placePanel`, both `panel_exited` switch paths, broadcast reconciliation, and status-aware `api()`; `index.html` now has `#orch-pin-row` and `#project-chips`. Remaining visible gap at this checkpoint: `style.css` has no project-chip / ORCH / filtered-out / exiting styles yet.

### [T3] FINDING 2026-05-16 20:10 ET — 2a: the chip filter (T1 1.1) manufactures a fresh "opens invisible" — needs in-sprint handling by T1

- 3.1 hypothesis analysis landed: `docs/sprint-65-dashboard-reliability/2A-OPENS-INVISIBLE-ANALYSIS.md`. Of the four 2a candidates (A off-screen slot, B `display:none`, C dark-veil modal #8, D WS race), three defer pending Brad's repro — but **Hypothesis B is a regression Sprint 65 itself introduces** and is actionable now, independent of Brad.
- Mechanism: T1 1.1's chip filter adds `panel--filtered-out` (`display:none`) to every tile whose `meta.project` ≠ the selected chip. **A panel spawned while a non-"All" chip is active is born hidden.** Operator has the `aetheria` chip selected → spawns a `structural360` panel → the new tile gets `panel--filtered-out` → `display:none` → the panel they just launched never appears. The filter persists in `localStorage`, so this also fires on the first panel spawned in a fresh tab when a filter was left selected.
- Not pre-existing — pre-Sprint-65 there were no chips. It is a poor outcome for the sprint partly meant to *fix* "opens invisible" to *manufacture* a fresh instance of it. The T1 1.1 brief + PLANNING § 1.1 spec the click-handler + `localStorage` but say nothing about a panel spawned under an active filter — that is the gap.
- For T1 (recommended — pick one): (1) **auto-switch the active chip to a newly-spawned panel's project** — most intuitive, matches operator intent; (2) flash the destination chip + bump its count; (3) a click-to-reveal toast. T3 verifies the invariant either way: **spawning a panel must never silently produce a tile the operator cannot see or reach.** An `ACCEPTANCE-CHECKLIST.md` step covers it. Flagging while T1's chip code is still WIP (per T4 20:04 / 20:08) so the mitigation is built in, not retrofitted. Not a scope expansion — it is a gap inside the locked 1.1 scope.

### [T4-CODEX] AUDIT-CONCERN 2026-05-16 20:11 ET — concur with T3: active chip filter can hide a newly spawned panel at birth

- I verified the mechanism in current T1 WIP, not just from the doc: `launchTerminal()` / sprint reload / tour auto-launch all call `createTerminalPanel(session)`, and `createTerminalPanel()` then calls `refreshDashboardChrome()` after mounting. That path calls `applyProjectFilter()`, which toggles `panel--filtered-out` when `entry.session.meta.project` does not match `state.projectFilter`.
- With `state.projectFilter="aetheria"` persisted in `localStorage`, a newly spawned `structural360` non-ORCH panel is immediately `display:none` even though the operator just asked for that panel. This directly recreates Brad's "opens invisible" class in the new chip surface.
- Required before T1 FIX-LANDED: choose an explicit reveal behavior for user-initiated new panels (prefer auto-switching the active chip to the new panel's project, except ORCH panels which already bypass the filter) and cover it in the acceptance checklist. This is AUDIT-CONCERN while T1 is WIP; it becomes blocking if T1 marks 1.1 done with silent hidden spawns still possible.

### [T4-CODEX] CHECKPOINT 2026-05-16 20:13 ET — client contract tests added/green; born-hidden spawn concern still open

- T3's `ACCEPTANCE-CHECKLIST.md` now exists and includes the required active-filter spawn regression step. I also see `docs/sprint-65-dashboard-reliability/2A-OPENS-INVISIBLE-ANALYSIS.md`, with Hypothesis B explicitly called in-sprint.
- New client test surface exists at `tests/dashboard-panels-client.test.js`; I ran `node --test tests/dashboard-panels-client.test.js tests/ws-handler-contract.test.js tests/escapehtml-client.test.js` and it passes 32/32. `node --check packages/client/public/app.js` also passes.
- Server/acceptance targeted rerun green: `node --test packages/server/tests/sprint-65-acceptance.test.js packages/server/tests/session-lifecycle-api.test.js packages/server/tests/session.test.js` passes 76/76 with 0 skips.
- Still open: current `app.js` still applies an active non-matching chip to newly spawned non-ORCH panels, so the 20:11 AUDIT-CONCERN is not cleared by the new tests/checklist alone. It needs a T1 code change or explicit ORCH waiver before T1 can be audited GREEN.

### [T2] FIX-LANDED 2026-05-16 20:17 ET — 2.1–2.4 landed + 2.5 verified; T2 fence files green

All five sub-tasks complete. ORCH SCOPE 20:08 rulings C (2.5 verify-only) + D (role dashboard-only) + B (dual-410 keep-both) match what landed. File:line map:

**2.1 — `meta.role` (Approach A).**
- `index.js:160` — `ALLOWED_SESSION_ROLES = ['orchestrator','worker','reviewer','auditor',null]` (module const; exported at `index.js:3052`).
- `index.js:1722-1725` — `POST /api/sessions` destructures `role`, validates `role !== undefined && !ALLOWED_SESSION_ROLES.includes(role)` → `400 {ok:false,code:'invalid_role',allowed}`. Case-sensitive exact match; absent → null; explicit `null` allowed.
- `index.js:1268` — `spawnTerminalSession({…,role})` signature + its `sessions.create({…,role: role||null})`.
- `session.js:171` — `Session` ctor `meta.role = options.role || null`.
- `session.js:585` — `sessions.create()` SQLite INSERT extended to 11 columns (`…,theme_override,role`).
- `database.js:70` — `role TEXT` in the `CREATE TABLE sessions` block (fresh-install path).
- `database.js:146-157` — PRAGMA-guarded `ALTER TABLE sessions ADD COLUMN role TEXT` migration (existing-install path), mirroring `theme_override`. No new `.sql` file (FINDING 19:59). Cleared T4 AUDIT-RED 20:00 (verified by T4 20:02).

**2.2 — exited-session filter.** `session.js:617` — `getAll(opts={})`, `includeExited = opts.includeExited !== false`. **Bare `getAll()` default = legacy include-all** — so `status_broadcast` (index.js:2675), the projects-route guard (~2109), `GET /api/status` (~2188) are unchanged. `index.js:1259` — `GET /api/sessions` is the only filtered caller (`?includeExited=true` opts back to legacy). R2 from FINDING 20:01 #1.

**2.3 — 410 Gone.** `index.js:1797-1808` — `POST /api/sessions/:id/input` returns `410 {ok:false,code:'panel_exited',error,message,exitCode,exitedAt}` for an exited/no-pty panel (was a silent `404`). Body carries **both** `error` (backward-compat) and `code` per ORCH ruling B. Never-existed session is still `404` — distinct from `410`-exited.

**2.4 — `panel_exited` WS frame.** `index.js:1494` — `term.onExit` stamps `meta.exitedAt`. `index.js:1509-1530` — broadcasts `{type:'panel_exited',sessionId,exitCode,signal,exitedAt}` to all `wss.clients` (inlined idiom, same as `status_broadcast`/`config_changed`/`projects_changed`). Distinct from the per-panel `exit` frame.

**2.5 — verify-only** (ORCH ruling C). No production change — per-adapter idle detection shipped Sprint 60 v1.0.14. Pinned with 7 regression tests.

**Tests — all green.** NEW `packages/server/tests/session-lifecycle-api.test.js` (14 tests — route role 201/400, includeExited filter, 410, `panel_exited` WS, status_broadcast-carries-exited, SQLite role column + migration; hermetic `createServer`+fake-pty, no `:3001` dependency per ORCH ruling E). `session.test.js` +15 (meta.role, getAll filter, 2.5 idle ×7). Independently confirmed by T4-CODEX CHECKPOINT 20:13 (`sprint-65-acceptance.test.js` + my two files → 76/76, 0 skips).

**For T4 re-audit (ORCH ruling D corrected gate):** `meta.role` does NOT corrupt the session-end path — `onPanelClose` builds its hook payload from an explicit field list (`index.js:272-279`) and never reads `session.meta.role`; adding the key to the meta dict is inert there. Role flows ONLY through `status_broadcast` (dashboard). **Exit-propagation race:** if a `status_broadcast` tick fires between `term.onExit`'s `meta.status='exited'` write and the `panel_exited` send, the session is broadcast once as `status:'exited'` — harmless + self-correcting (client renders the exited tile, then `panel_exited` removes it; T1's reconcile is the backstop). Test `2.4 — status_broadcast STILL carries exited` pins it.

### [T2] FINDING 2026-05-16 20:17 ET — 2 pre-existing `periodic-capture.test.js` failures (date-rot, NOT a Sprint 65 regression) — for T3 regression sweep

Full `npm test`: **334 pass / 2 fail**. Both failures are in `packages/server/tests/periodic-capture.test.js` (a Sprint 64 T3 file): `onPanelPeriodicCapture throttle…` + `onPanelPeriodicCapture payload carries mode…`. **Not a Sprint 65 regression — proven:** I `git stash`ed only my 3 source edits and re-ran — the clean v1.3.0 tree (`67b3ce5`) reproduces the identical 2/5 failure; restored my edits after.

**Root cause:** both tests hardcode a Codex transcript fixture under `~/.codex/sessions/2026/05/14/` (`periodic-capture.test.js:181,230`). The codex adapter's `resolveTranscriptPath`/`_codexCandidateDirs` only scans **today + yesterday (UTC)**. The fixture was authored 2026-05-14; today is 2026-05-16 → `2026/05/14` is outside the candidate window → `resolveTranscriptPath` returns null → `onPanelPeriodicCapture` finds no transcript → 0 spawns where the tests assert 1. The fixtures rot 1 day after authoring. (The other 3 tests in the file pass — they return early before `resolveTranscriptPath`.)

**Fix (~3 lines × 2, trivial):** compute the fixture day-dir from `new Date()` UTC components instead of hardcoded `'2026','05','14'`. **Owner:** flagging for T3 (owns the 3.4 `npm test` regression sweep per ORCH 20:08 marching orders) + ORCH — `periodic-capture.test.js` is outside T2's lane, so I am not editing it without ORCH SCOPE. Must be green for the "npm test root green" close-out gate. (My own fence files use only `Date.now()`-relative timestamps — no date-rot.)

### [T2] DONE 2026-05-16 20:17 ET — server lane complete

2.1–2.4 landed, 2.5 verified, 29 fence tests added (T4-verified 76/76 at 20:13 alongside T3's acceptance suite). Both T4 AUDIT-REDs on this lane cleared (19:57 by ORCH ruling D — `meta.role` is dashboard-only, does not touch `session_summary`; 20:00-SQLite by T4's own 20:02 re-verification of the PRAGMA migration). All 3 boot FINDINGs adjudicated by ORCH SCOPE 20:08. Cross-lane contract for T1 is stable and unchanged since 19:59: `meta.role ∈ {orchestrator,worker,reviewer,auditor,null}`, `panel_exited = {type,sessionId,exitCode,signal,exitedAt}`. No version bumps / CHANGELOG / commits — orchestrator close-out. One sprint-level open item (not T2 lane): the 2 pre-existing `periodic-capture.test.js` date-rot failures — see FINDING 20:17. Standing by for T4 re-audit on this FIX-LANDED.

### [T4-CODEX] AUDIT-OK 2026-05-16 20:20 ET — T2 FIX-LANDED passes corrected server gate; root blocker is outside T2

- Re-audited T2 against ORCH SCOPE 20:08 ruling D: `meta.role` is dashboard-only for v1.4.0. The server now validates the optional role whitelist with `400 invalid_role`, stores `meta.role`, returns it through `GET /api/sessions` / detail / `status_broadcast`, and does not mutate the explicit `onPanelClose` session-end payload. I do not require role persistence into `session_summary` this sprint.
- Targeted verification rerun: `node --test packages/server/tests/session-lifecycle-api.test.js packages/server/tests/session.test.js packages/server/tests/sprint-65-acceptance.test.js` passes 76/76 with 0 skips. This covers strict role contract, SQLite fresh+migration paths, default exited filtering with `?includeExited=true` legacy restore, structured `410 panel_exited`, `panel_exited` WS broadcast, and the Brad 10-dead-codex fixture.
- Independently reproduced T2's root-test note: `node --test packages/server/tests/periodic-capture.test.js` fails 3/5 with the two date-rot assertions T2 named (`fire after >= 1 KB growth lands`, `fire produced exactly one spawn`). That is a sprint-close blocker for root `npm test`, but not a T2 role/lifecycle regression.
- T2 lane status from T4: GREEN for server role/lifecycle scope. Sprint-level remaining blockers: T1 20:11 born-hidden active-filter concern, plus root `periodic-capture.test.js` date-rot until T3/ORCH fixes or waives it.

### [ORCH] SCOPE 2026-05-16 20:20 ET — SCOPE-2: born-hidden-spawn ruling F (T1) + periodic-capture date-rot owner ruling G (T3); T2 DONE acknowledged

T2 DONE 20:17 acknowledged — server lane complete (2.1-2.4 landed + 2.5 verify-only), 29 fence tests, rulings B/C/D all matched what landed. Standing by for T4 re-audit. Two new rulings:

**F. Born-hidden-spawn (re T3 FINDING 20:10 + T4 AUDIT-CONCERN 20:11) — IN SCOPE for 1.1; T1 implements auto-switch.** T3 + T4 both verified in T1's actual WIP: with a non-"All" chip active, a newly-spawned panel of a different project receives `panel--filtered-out` (`display:none`) at birth — Sprint 65 manufacturing a fresh "opens invisible." This is a gap INSIDE the locked 1.1 scope, NOT a scope expansion (T3's framing is correct). RULING: **T1 — on a user-initiated panel spawn, auto-switch the active chip to the new panel's `meta.project`** (option 1, the one both T3 and T4 recommend). ORCH-role panels are exempt — they render in the pinned ORCH row and bypass the chip filter already. Reload/restore of existing panels keeps the persisted filter (correct); only a user-initiated NEW spawn auto-switches. Invariant (already pinned in T3's `ACCEPTANCE-CHECKLIST.md`): a panel spawn must never silently produce a tile the operator cannot see or reach. T1 — build this into the 1.1 chip code now, not as a retrofit (T3 flagged it while your code is WIP precisely for that reason). T4 — clears the 20:11 AUDIT-CONCERN once T1's auto-switch lands; stays blocking if 1.1 is marked done with silent hidden spawns still possible.

**G. `periodic-capture.test.js` 2 failures (re T2 FINDING 20:17) — T3 owns the fix; IN SCOPE.** T2 proved via `git stash` that both failures reproduce on the clean v1.3.0 tree — a PRE-EXISTING date-rot in a Sprint 64 file, NOT a Sprint 65 regression: the tests hardcode the Codex fixture dir `~/.codex/sessions/2026/05/14/`, the codex adapter scans only today+yesterday UTC, so the fixture rotted on 2026-05-16. Sprint 65's close-out gate "`npm test` root green" inherits the obligation regardless of the bug's origin. RULING: **T3 fixes it within sub-task 3.4** (the npm-test regression sweep) — the trivial ~3-line x2 fix T2 specced: compute the fixture day-dir from `new Date()` UTC components instead of hardcoded `'2026','05','14'`. Explicitly authorized — T3 editing this Sprint-64 file is in-lane for 3.4 and required for the close-out gate. ORCH records it in the CHANGELOG at wrap as a test-hygiene fix (date-rot), distinct from the Sprint 65 feature set.

Sprint status: T2 DONE; T3 FIX-LANDED (acceptance 11/11) + ACCEPTANCE-CHECKLIST.md + 2a analysis done, now owns 3.4 incl. G; T1 client WIP — critical path, incl. ruling F; T4 re-auditing T2's FIX-LANDED. No other blockers.

### [T3] FIX-LANDED 2026-05-16 20:22 ET — ruling G executed: periodic-capture.test.js date-rot fixed; `npm test` root 336/336 GREEN

- ORCH SCOPE-2 ruling G + T2 FINDING 20:17 — done. My 3.4 sweep independently hit the same 2 `periodic-capture.test.js` failures (deterministic, 3/3 isolated runs) and reached the same diagnosis T2 proved by `git stash`: a pre-existing Sprint-64 date-rot, not a Sprint 65 regression. Concurring evidence: the full `index.js` + `session.js` WIP diffs are entirely role / 410 / `panel_exited` / `includeExited` / `exitedAt` and never touch `onPanelPeriodicCapture`, `AGENT_ADAPTERS`, or the resolver path; the test never inits a DB, so `database.js` is moot.
- **FIX LANDED** — `packages/server/tests/periodic-capture.test.js`, test-only, zero production code. New `codexTodayDir(home)` helper derives the fixture day-dir from `new Date()` UTC components (the same `getUTC*` shape as `_codexCandidateDirs` in `agent-adapters/codex.js`), replacing all 3 hardcoded `'2026','05','14'` literals (lines 132/181/230 — line 132's "skip exited" test had been passing only by the luck of an early return). An in-file comment documents the date-rot + the fix.
- **Verified:** `node --test packages/server/tests/periodic-capture.test.js` → 5/5. Full **`npm test` → 336 pass / 0 fail / 0 skipped** (T2's pre-fix run was 334/2; the delta is exactly these 2). Close-out gate "`npm test` root green" satisfied. T4 — re-verify against the current file.
- Secondary note for T1 / ORCH (not blocking): T1's new `tests/dashboard-panels-client.test.js` passes 27/27 run directly, but it lives in the repo-root `tests/` dir, which is OUTSIDE the `npm test` glob (`packages/{server,cli,stack-installer}/tests/**`) — so those 27 client tests do not fence regressions under the close gate. T1/ORCH: move it under `packages/server/tests/` or extend the glob. (Same glob gap the `adapter-session-end-writer.test.js` header documents for `tests/per-agent-hook-trigger.test.js`.)
- 3.4 sweep is GREEN as of now. I re-run `npm test` + `sprint-65-acceptance.test.js` once T1 posts FIX-LANDED (ruling F auto-switch) — T1 is the last critical-path lane — then post `### [T3] DONE`.

### [T4-CODEX] CHECKPOINT 2026-05-16 20:22 ET — born-hidden guard + periodic date-rot retested green; root sweep pending

- T1 has now wired the born-hidden guard in code: `createTerminalPanel()` calls `revealNewPanelIfFiltered(meta)` after storing the real session entry and before `refreshDashboardChrome()`. The pure helper switches a stale project filter to the newly-spawned panel's project, switches untagged panels to `All`, preserves the saved filter during initial restore, and exempts ORCH panels because they bypass the grid filter.
- The automated client tests now pin that helper directly: `tests/dashboard-panels-client.test.js` includes `filterValueRevealingPanel` in `PURE_HELPERS` plus six cases for initial restore, stale-filter reveal, untagged-to-All, already-visible, All-filter, and ORCH-bypass. This clears my 20:11 born-hidden concern on current WIP.
- T3/ORCH date-rot fix is also green under my local rerun: `node --test packages/server/tests/periodic-capture.test.js` passes 5/5.
- Narrowed Sprint 65 regression bundle green: `node --test packages/server/tests/session-lifecycle-api.test.js packages/server/tests/session.test.js packages/server/tests/sprint-65-acceptance.test.js packages/server/tests/periodic-capture.test.js tests/dashboard-panels-client.test.js tests/ws-handler-contract.test.js tests/escapehtml-client.test.js` passes 121/121 with 0 skips. Next gate: root `npm run test`.

### [T4-CODEX] CHECKPOINT 2026-05-16 20:25 ET — root test green; ORCH visual mostly clean; two non-blocking T1 concerns

- Root close gate re-verified by T4: `npm run test` passes 336/336 with 0 skips. This includes the new server role/lifecycle tests, T3's Brad repro, and the fixed periodic-capture suite.
- ORCH accent contrast is acceptable on the dashboard's actual dark chrome: `#d4a017` vs `--tg-surface #161821` is 7.45:1 and vs `--tg-bg #0f1117` is 7.94:1. The xterm theme list changes terminal colors only; it does not override the dashboard CSS vars, so the ORCH border/badge remains readable across the eight terminal themes.
- Client-specific fence remains outside root: `tests/dashboard-panels-client.test.js` is not in the `npm run test` glob. I am counting the explicit narrowed bundle above as the Sprint 65 client fence, but this is fragile for future close-outs unless ORCH extends the script or moves the file under a package test directory.
- Legacy `layout-orch` conflict: `.grid-container.layout-orch .term-panel:last-child` still assumes the last grid child is the orchestrator. With Sprint 65 role pinning, a `meta.role === "orchestrator"` tile is moved to `#orch-pin-row`, so selecting the old `orch` layout can make the last worker span the bottom of the worker grid. The ORCH panel is still pinned/visible, but the legacy layout button produces a misleading worker layout. Non-blocking if ORCH accepts the legacy `orch` layout as orthogonal/deferred; otherwise T1 should gate or adapt that layout when the ORCH pin row is populated.

### [T1] FIX-LANDED 2026-05-16 20:32 ET — 1.1-1.4 + 1.3b + born-hidden + (c) all landed; `npm test` 375/375

Entire T1 lane code-complete + verified. Diffstat: `app.js` +549 / `index.html` +34 / `style.css` +127 + new test file. ORCH SCOPE 20:08 (A/B/E) + SCOPE-2 20:20 (F) all honored.

**File:line map — `packages/client/public/` (for T4 audit):**

- **1.1 chips** — `app.js` pure helpers `discoverPanelProjects`:689 / `countPanelsForProject` / `isPanelVisibleUnderFilter` / `shouldShowChipRow`; `renderProjectChips`:819 (createElement build — no innerHTML/attr-escape; stale-chip→"All" fallback), `applyProjectFilter`:864 (`panel--filtered-out`, PTYs never torn down), `onProjectChipClick`:878. `state.projectFilter` hydrated in `init()`; click delegated-wired. `index.html` `#project-chips`. `style.css` `.project-chips-row`/`.project-chip`.
- **Born-hidden fix (ORCH ruling F / T3 20:10 / T4 20:11)** — `filterValueRevealingPanel`:777 (pure) + `revealNewPanelIfFiltered`:892, called in `createTerminalPanel`:634. A user-spawned panel auto-switches the active chip to its project (untagged→"All", ORCH exempt). Gated by `_initialLoadComplete` so reload honors the saved filter. Matches ruling F exactly; T4 already cleared this on WIP at 20:22.
- **1.2 ORCH pin** — `placePanel`:905 (routes `meta.role==='orchestrator'` → `#orch-pin-row`, called `createTerminalPanel`:467), `reconcileOrchRow`:919 (idempotent defensive recheck). `index.html` `#orch-pin-row`. `style.css` `.orch-pin-row` + `.term-panel.panel--role-orch` (gold border + ORCH `::before` badge; `:empty`→collapse). T4 verified `#d4a017` contrast 7.45:1 (20:25).
- **1.3 tile auto-removal** — `case 'panel_exited'`:533 (main) + :2060 (reconnect) — parity guard green. `handlePanelExited`:1000 (3s grace, `_exitScheduled` guard). `reconcileExitedPanels`:1022 belt-and-suspenders (orphan-from-broadcast 5s + stale-exited 60s), wired into `updateGlobalStats`:3487. Holds under T2's confirmed legacy-broadcast contract. `style.css` `.term-panel.panel--exiting`.
- **1.3b 410-trap (ORCH ruling B = keep both layers)** — `api()`:44 (`res.ok` path unchanged; non-2xx → `annotateApiFailure`:764 synthesizes `error` + `_httpStatus`). Client layer of the dual-410; coexists with T2's `error`-in-body.
- **1.4 Path A layouts (ruling A)** — `1x2` + `2x5/5x2/4x3/3x4/4x4`: `style.css` 5 grid templates, `index.html` 6 topbar buttons, `app.js` keyboard array:4914 → `Ctrl/Cmd+Shift+0-9` (keys 1-7 unchanged; 8/9/0 = `1x2`/`4x3`/`4x4`).
- **(c) terminal font-size (ruling A)** — shipped **global** (the BACKLOG's sanctioned "per-panel OR global"; global = simplest/lowest-risk for the contingent item — per-type sizing is a clean Sprint 66 refinement if wanted). `clampFontSize`:1077 (pure, [8,22]), `applyFontSizeToAll`:1105 (xterm `fontSize` + explicit refit/resize), `stepFontSize`:1127. Topbar `A−/A+` stepper; `state.fontSize` persisted in `localStorage`; new + restored panels inherit it.

**Verification.** `node --check app.js` clean. Test file **moved to `packages/server/tests/dashboard-panels-client.test.js`** so the root `npm test` glob fences it (resolves T3 20:22 + T4 20:25 — the top-level `tests/` glob gap; surgical move, not a glob widen that would surface ~90 other files). **`npm test` → 375 pass / 0 fail / 0 skipped** (T3's 336 + my 39 client tests). The 39 = pure helpers (vm-extract pattern, per `escapehtml-client.test.js`) + DOM-wiring contract. Per ORCH ruling E, no `:3001` touch — hermetic.

**Flag for ORCH — legacy `layout-orch` × ORCH-pin interaction (re T4 20:25, non-blocking).** The pre-Sprint-65 `orch` *grid layout* (`.grid-container.layout-orch .term-panel:last-child` spans the bottom) assumed the last grid child IS the orchestrator. With 1.2, a role-tagged orch panel is moved OUT of `#termGrid` into `#orch-pin-row` — so under the `orch` layout the last *worker* gets the bottom-span, and `setLayout`'s `workerCount = panelCount-1` also undercounts. Nothing breaks (the ORCH panel is correctly pinned + visible regardless) — it's cosmetic, and the `orch` layout still works correctly for the untagged-roles workflow. **Recommendation: accept as orthogonal for v1.4.0** — role-tagging + ORCH-pin supersedes the `orch` layout's original purpose; a proper reconcile (hide/relabel the `orch` layout when an ORCH panel is pinned) is Sprint 66 polish. ORCH's call — I'll adapt it this sprint if you'd rather.

**Noted, deferred (not in brief, non-blocking).** Orch panels still show their header focus/half buttons — moot for a pinned panel (clicking "focus" briefly hides the grid; Esc-recoverable). 2-line CSS hide available if T4/ORCH wants it; left out to keep the lane tight.

Standing by for T4 audit of this FIX-LANDED.

### [T1] DONE 2026-05-16 20:32 ET — client lane complete

1.1 chips + 1.2 ORCH pin + 1.3 tile auto-removal + 1.3b 410-trap + born-hidden auto-switch (ruling F) + 1.4 Path A layouts (incl `1x2`) + (c) global font-size — all landed + verified. `npm test` 375/375 (client fence now gated — test moved into `packages/server/tests/`). T3 20:10 / T4 20:11 born-hidden concern addressed (T4-cleared on WIP 20:22). One ORCH adjudication pending — the non-blocking legacy `layout-orch` interaction flagged above. No version bumps / CHANGELOG / commits — orchestrator close-out. Standing by for T4 re-audit + FINAL-VERDICT.

### [T3] DONE 2026-05-16 20:35 ET — verification lane complete; full acceptance matrix GREEN

T3 lane complete — all four sub-tasks closed. Re-verified against the final T1+T2-landed tree.

**Deliverables (3 new files + 1 test-hygiene fix):**
- `packages/server/tests/sprint-65-acceptance.test.js` (NEW, ~365 LOC) — hermetic server-contract acceptance suite for Brad's 18-panel-2-project repro. **11/11, 0 skipped.**
- `docs/sprint-65-dashboard-reliability/ACCEPTANCE-CHECKLIST.md` (NEW) — 11-section operator-runnable checklist (post-ship + pre-ship-WIP modes; incl. the dashboard-reply-UI 410 step and the born-hidden § 8 step).
- `docs/sprint-65-dashboard-reliability/2A-OPENS-INVISIBLE-ANALYSIS.md` (NEW) — Brad bug-2a A–D hypothesis analysis + paste-ready BACKLOG § D.5 defer entry.
- `packages/server/tests/periodic-capture.test.js` — ruling-G test-only date-rot fix.

**Verification verdict — GREEN.**
- **`npm test` root → 375 pass / 0 fail / 0 skipped** — re-run just now against the final tree (T3's 336 + T1's 39 client tests, now in-glob after T1's file move).
- `sprint-65-acceptance.test.js` 11/11 verifies the SERVER half of the matrix end-to-end: `meta.role` contract (4 roles round-trip; unknown→`400 invalid_role`; absent→`null`); `meta.role` flows through `status_broadcast` (the T2→T1 ORCH-pin data path); `?includeExited=true`→19 / default→9; `410 Gone` `code:'panel_exited'` on dead-panel input; `panel_exited` WS frame per PTY exit; status_broadcast live-set == default GET (missed-exit reconciliation pin); codex `Worked for Xm Ys`→`idle`/`''`; 65s-stale `thinking`→`idle`. Brad's exact shape: 10 codex (aetheria) + 8 grok (structural360) + 1 orch, 10 PTY-exits. T4-CODEX independently ran the suite (76/76 at 20:20; date-rot fix re-verified 5/5 at 20:22).

**Two T3 findings became ORCH rulings — both closed:**
- **Ruling F (born-hidden / Hypothesis B)** — T3 FINDING 20:10 caught that Sprint 65's chip filter manufactures a fresh "opens invisible" (a panel spawned under a non-`All` filter is born `display:none`); T4 concurred 20:11. T1 landed `filterValueRevealingPanel` + `revealNewPanelIfFiltered` (auto-switch the chip to a new panel's project; ORCH-exempt; reload honors the saved filter) with **6 dedicated test cases** in `dashboard-panels-client.test.js` — verified within the 375.
- **Ruling G (periodic-capture date-rot)** — T3 owned + fixed via a `codexTodayDir()` date-derivation helper. Was a pre-existing Sprint-64 date-bomb (hardcoded `2026/05/14`), not a Sprint 65 regression (proven independently by T3 + by T2's `git stash`). 5/5.

**2a adjudication:** Hypothesis B fixed in-sprint (ruling F). Hypotheses A (off-screen grid slot), C (dark-veil modal — `ARCHITECTURE.md` Known Issue #8), D (WS/cross-client spawn race) are DEFERRED — Brad's repro was not relayed during the sprint. `2A-OPENS-INVISIBLE-ANALYSIS.md` carries the full analysis + a paste-ready BACKLOG § D.5 "needs repro" entry for ORCH to fold in at wrap.

**For T4 FINAL-VERDICT:** all four T3 sub-tasks done; close-gate "`npm test` root green" satisfied (375/375); no version bumps / CHANGELOG / commits (orchestrator close-out). T3 standing by.

### [ORCH] SCOPE 2026-05-16 20:35 ET — SCOPE-3: ruling H (T1 moves client test into npm-test glob) + ruling I (legacy orch layout accepted-deferred) + status snapshot

Two lane-flagged items resolved, plus a status snapshot.

**H. Client test outside the npm-test close gate (re T3 FIX-LANDED 20:22 + T4 CHECKPOINT 20:25).** T1's `tests/dashboard-panels-client.test.js` lives in repo-root `tests/`, outside the `npm test` glob (`packages/{server,cli,stack-installer}/tests/**`) — so the ~27 client tests do not fence regressions under the close-out gate. RULING: **T1 — move `tests/dashboard-panels-client.test.js` into the glob, i.e. `packages/server/tests/dashboard-panels-client.test.js`**, as part of your FIX-LANDED (matches where every other Sprint 65 test file lives — T2's `session-lifecycle-api.test.js`, T3's `sprint-65-acceptance.test.js`). Surgical one-file move; fix the relative `require()` paths; T4 re-verifies it still passes in-glob. The broader pre-existing repo-root `tests/` glob gap (also strands `per-agent-hook-trigger.test.js`, `ws-handler-contract.test.js`, `escapehtml-client.test.js`) is NOT a Sprint 65 fix — ORCH logs it as a BACKLOG hygiene item at wrap.

**I. Legacy `orch` layout vs the new ORCH-pin row (re T4 CHECKPOINT 20:25) — ACCEPTED as-is for v1.4.0, deferred to Sprint 66.** The old `.grid-container.layout-orch .term-panel:last-child` rule assumes the last grid child is the orchestrator; with Sprint 65 role-pinning the ORCH tile moves to `#orch-pin-row`, so selecting the legacy `orch` layout makes the last worker span oddly. T4 confirmed NON-BLOCKING — the ORCH panel is still correctly pinned + visible; only the legacy layout button yields a cosmetically-odd worker grid. RULING: accept as-is for v1.4.0 — do NOT load the critical-path T1 lane with it. The legacy `orch` layout is functionally superseded by the ORCH-pin row; ORCH logs a BACKLOG item "gate or retire the legacy `orch` layout now that ORCH-pin ships" for Sprint 66. T4 — accepted deferral, not a FINAL-VERDICT blocker.

**Status snapshot @ 20:35 ET.** T2 — DONE (20:17, T4 AUDIT-OK 20:20). T3 — all deliverables landed (acceptance 11/11, ACCEPTANCE-CHECKLIST.md, 2a analysis, periodic-capture date-rot fix -> root `npm test` 336/336 green); holding its `[T3] DONE` post for one re-run after T1 FIX-LANDED. T1 — CRITICAL PATH, actively working; born-hidden guard wired (T4 cleared 20:22); FIX-LANDED pending (+ ruling H move). T4 — everything-landed-so-far audited GREEN, root 336/336 verified 20:25; FINAL-VERDICT gated on T1 FIX-LANDED. When T1 posts FIX-LANDED, ORCH nudges T3 (final re-run -> DONE) + T4 (final audit -> FINAL-VERDICT).

### [T4-CODEX] FINAL-VERDICT GREEN 2026-05-16 20:43 ET — Sprint 65 clear to close

- Final T1 client re-audit: GREEN. Evidence: chip/born-hidden guard is explicit and test-pinned (`packages/client/public/app.js:777`, `:892`, `:631-635`); ORCH pin routes by `meta.role` and has the required DOM/CSS surface (`app.js:905`, `:919`, `packages/client/public/index.html:86`, `packages/client/public/style.css:436`, `:450`); `panel_exited` is handled in both WS switches and reconciled from broadcasts (`app.js:533`, `:2060`, `:1000`, `:1022`, `:3484-3488`); 410 client annotation is present (`app.js:39-52`, `:764`); dense layouts + global font-size are wired (`index.html:38-50`, `:67-72`, `style.css:318`, `:473-494`, `app.js:1077`, `:4908-4916`). The moved in-glob client fence covers helpers, DOM/CSS contracts, WS parity, layouts, and font controls (`packages/server/tests/dashboard-panels-client.test.js:262-317`).
- Final T2 server re-audit remains GREEN under ORCH ruling D (`meta.role` dashboard-only for v1.4.0). Evidence: whitelist + strict `400 invalid_role` route validation (`packages/server/src/index.js:160`, `:1715-1727`), `Session.meta.role` serialization (`packages/server/src/session.js:161-172`), SQLite fresh + existing-install role persistence (`packages/server/src/database.js:57-70`, `:141-153`, `packages/server/src/session.js:584-599`), and `status_broadcast` flow-through via `sessions.getAll()` (`packages/server/src/index.js:2749-2752`, `packages/server/src/session.js:617-623`). Session-end summary writes are not corrupted because `onPanelClose` still builds an explicit payload and does not read `meta.role` (`packages/server/src/index.js:281-288`); role-in-summary analytics is explicitly descoped, not an omission.
- Final T3 verification lane accepted: root close gate now includes T1's moved client test and the Sprint 65 acceptance suite. T4 reran `node --check packages/client/public/app.js` clean and `npm run test` at 20:43 ET -> **375 pass / 0 fail / 0 skipped**.
- Accepted non-blockers: legacy `layout-orch` cosmetic interaction is ORCH ruling I deferred to Sprint 66; 2a hypotheses A/C/D remain deferred pending Brad repro while hypothesis B is fixed by born-hidden auto-switch; role-in-`session_summary` analytics is deferred per ORCH ruling D.

---

## Cross-lane dependencies

- **T2 → T1:** T1 expects `meta.role` in per-session meta + `panel_exited` WS frame shape. T2 must define both before T1's FIX-LANDED is meaningful.
- **T1 + T2 → T3:** T3's acceptance matrix exercises both lanes together. T3 starts test scaffolding early but can't run end-to-end until both T1 + T2 FIX-LANDED.
- **T2 → T3 (idle/parked):** T2's `idlePattern` declarations land in agent-adapter files; T3's acceptance for idle detection asserts the resulting status flip.
- **Sprint 64 → Sprint 65:** if Sprint 64 ships first, the `adapter.spawn` field is already on each adapter file. Sprint 65 T2 extends with `idlePattern` on the same files. Coordinate via FINDING if Sprint 64 hasn't shipped at inject.
- **T4 → all:** auditor reviews each FIX-LANDED before sprint close. FINAL-VERDICT gates SHIP.

---

## Brad outreach (orchestrator-side)

Two WhatsApp asks during this sprint:

1. **At sprint inject:** request Brad's "opens invisible" repro steps (T3 sub-task 3.1). Suggested message: *"Heading into Sprint 65 (chips + ORCH pin + dead-panel cleanup). For 2a (panels opening invisible from your 2026-05-12 list) — got repro steps? T3 lane has 4 hypothesis branches but Brad's actual repro path beats them all."*
2. **At sprint close:** ship summary with chips + ORCH visual + 18-panel-2-project repro proof.

Use the AppleScript-driven WhatsApp send pattern from global CLAUDE.md § Never present messages for copy-paste — always inject.

---

## Sprint close-out checklist (orchestrator)

- [ ] All four lanes posted `DONE` / `FINAL-VERDICT GREEN`.
- [ ] `npm test` root green.
- [ ] `ACCEPTANCE-CHECKLIST.md` exists; key matrix items pass.
- [ ] Brad's 2a repro adjudicated (fixed-in-sprint OR deferred with BACKLOG entry).
- [ ] `gitleaks` pre-commit clean.
- [ ] Version bumps: termdeck → 1.4.0, termdeck-stack → 1.4.0.
- [ ] CHANGELOG entries authored for both packages.
- [ ] Joshua publishes `@jhizzard/termdeck` + `@jhizzard/termdeck-stack` (Passkey, `--auth-type=web`).
- [ ] Orchestrator `git commit` + `git push origin main`.
- [ ] `git tag v1.4.0` + push.
- [ ] `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 + 2026-05-13 entries marked CLOSED; 8-panel/multi-port entry kept (Path B still pending).
- [ ] `PLANNING.md` gains `## Resolution` section.
- [ ] `docs/RESTART-PROMPT-2026-MM-DD-post-sprint-65.md` authored.
- [ ] Brad WhatsApp ship summary.
- [ ] Session-end email drafted.
