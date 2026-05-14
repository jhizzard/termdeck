# T3 — Verification + Brad's "opens invisible" repro + 18-panel acceptance matrix

You are T3 in Sprint 65 — Dashboard reliability + orch-panel awareness wave. Your lane is the test + verification surface, plus running down Brad's "opens invisible" sub-bug (2026-05-12 item 2a) — and authoring the operator-readable acceptance checklist.

## Boot sequence

1. `memory_recall(project="termdeck", query="Brad opens invisible dark veil stuck modal pointer events Sprint 36 2026-04-27")`
2. `memory_recall(project="termdeck", query="acceptance test matrix 18 panel 2 project chip filter orch pin")`
3. `memory_recall(query="recent decisions and bugs since Sprint 64 close")`
4. Read `~/.claude/CLAUDE.md`
5. Read `./CLAUDE.md`
6. Read `docs/BACKLOG.md` § D.5 — Brad's 2026-05-12 item 2 (sub-bugs 2a + 2b) + 2026-05-13 v2 spec entry
7. Read `docs/ARCHITECTURE.md` § Known issues (especially the 2026-04-27 "dark veil" pattern + hard-refresh-kills-PTYs)
8. Read `docs/sprint-65-dashboard-reliability/PLANNING.md`
9. Read `docs/sprint-65-dashboard-reliability/STATUS.md`
10. Read `docs/sprint-65-dashboard-reliability/T1-client-chips-and-orch-pin.md`
11. Read `docs/sprint-65-dashboard-reliability/T2-server-meta-role-and-lifecycle.md`
12. Read this file in full

Then begin.

## Scope

### 3.1 — Brad's "opens invisible" repro (2a)

At sprint inject, orchestrator drafts a WhatsApp ask to Brad for repro steps for sub-bug 2a. While orchestrator is composing the message, you idle-poll for the response in STATUS.md (orchestrator will inject Brad's response when it arrives).

**Candidate causes per BACKLOG entry** (use these as hypothesis tree):

- **Hypothesis A — Off-screen grid slot.** Panel created in a grid slot that's off-screen in the current layout (e.g., 6-panel grid in a 4-slot `2x2` layout shows only 4). Verify: spawn 5 panels with current layout = `2x2`; the 5th panel exists in `/api/sessions` but renders off-grid.
- **Hypothesis B — `display: none` layout hangover.** Panel created with `display: none` from a stale CSS class. Could happen if the layout switcher applies `panel--filtered-out` (from T1's chip filter) before the new chip's project is registered.
- **Hypothesis C — Dark-veil modal overlay.** Panel rendered behind a stuck modal/overlay (2026-04-27 "dark veil" pattern, ARCHITECTURE.md § Known issues #8). Z-index over the xterm.js terminals blocks pointer events.
- **Hypothesis D — WS race.** Panel exists server-side but the client never received the create-frame (lost in a WS reconnect race). The client's view of `/api/sessions` lags.

**Verification harness:**

For each hypothesis, write a synthetic reproducer that asserts the bug shape, then verify whether the T1+T2 ship resolves it.

If Brad's repro lands and matches one of A-D, ship the fix in this sprint (T1 lane picks it up if client-side; T2 lane if server-side). If Brad's repro doesn't match: scope a new hypothesis and decide whether to fix-in-sprint or defer to Sprint 66 as "needs further repro."

If Brad's repro doesn't arrive by ~30 min into the sprint, post `### [T3] FINDING — Brad repro absent; deferring 2a as 'needs repro' BACKLOG entry; proceeding with 3.2 acceptance matrix.`

### 3.2 — Run T1+T2 against Brad's 18-panel-2-project repro shape

Brad's 2026-05-12 verbatim: *"at one point I had 18 windows open. 10 were dead codex cli."* Simulate this shape:

**Test fixture:**

```js
// Spawn 18 panels: 9 codex (aetheria) + 9 grok (structural360) + 1 orch
const sessions = [];
for (let i = 0; i < 9; i++) {
  sessions.push(await POST('/api/sessions', {
    type: 'codex', project: 'aetheria', label: `codex-${i}`,
  }));
}
for (let i = 0; i < 9; i++) {
  sessions.push(await POST('/api/sessions', {
    type: 'grok', project: 'structural360', label: `grok-${i}`,
  }));
}
sessions.push(await POST('/api/sessions', {
  type: 'claude', role: 'orchestrator', project: null, label: 'orch',
}));

// Total: 19 panels (Brad mentioned 18; orch counts as 19th)
expect((await GET('/api/sessions?includeExited=true')).length).toBe(19);

// Kill 10 of the codex panels
for (let i = 0; i < 10; i++) {
  await DELETE(`/api/sessions/${sessions[i].id}`);
}
```

**Assertions:**

| Check | Expected |
|-------|----------|
| `GET /api/sessions` (default) | 9 live (8 visible workers + 1 orch) → wait, 18−10=8 visible; +1 orch = 9 total. Actually 18 worker panels − 10 killed codex = 8 surviving workers + 1 orch = **9 total**. |
| `GET /api/sessions?includeExited=true` | All 19 (10 exited + 9 live). |
| Chip switch from `aetheria` to `structural360` | Visible panels flip in <100ms. |
| ORCH chip count | `(1)` always. |
| ORCH panel pinned regardless of chip | True. Verify by checking computed style: `#orch-pin-row` contains the orch tile DOM element under every chip selection. |
| `POST /api/sessions/<dead-id>/input` | Returns `410 Gone` with body `{ok:false, code:'panel_exited', ...}`. |
| Dead-panel tile auto-removes within 4s | After `panel_exited` WS frame + 3s grace + 1s render. |
| Idle codex panel reports `status: 'active'` with empty `statusDetail` after `Worked for Xm Ys` terminator | Verify via `analyzeOutput` fixture injection. |
| Stale-`lastActivity` heuristic | `status: 'thinking'` with `lastActivity` 65s ago → flips to `'active'` on next broadcast tick. |

**File:** `packages/server/tests/sprint-65-acceptance.test.js` (NEW; ~150-200 LOC).

### 3.3 — Author `ACCEPTANCE-CHECKLIST.md`

Operator-readable doc Joshua + Brad can run through post-ship. Path: `docs/sprint-65-dashboard-reliability/ACCEPTANCE-CHECKLIST.md`.

Structure:

```markdown
# Sprint 65 acceptance checklist

Run through these in order against a fresh `termdeck` install (or upgrade).

## Pre-flight

- [ ] `npm view @jhizzard/termdeck version` returns `1.4.0` (or higher).
- [ ] Open dashboard at `http://127.0.0.1:3000`.
- [ ] Confirm `#project-chips` row visible above the grid.
- [ ] Confirm `#orch-pin-row` is empty (no orch panel yet) — should collapse to zero height.

## Chips (T1.1)

- [ ] Spawn 3 panels with `project=alpha`, 2 panels with `project=beta`. Chips render: `[ All (5) ] [ alpha (3) ] [ beta (2) ]`.
- [ ] Click `alpha` chip. Only the 3 alpha panels visible; counts stay live.
- [ ] Refresh tab. Filter persists as `alpha`.
- [ ] Click `All`. All 5 panels visible.
- [ ] Spawn a 6th panel project=gamma. Chip `[ gamma (1) ]` appears live.

## ORCH pin (T1.2)

- [ ] Spawn a panel with `role=orchestrator`. Renders in `#orch-pin-row` above the grid with gold/amber border + ORCH badge.
- [ ] Click `alpha` chip. ORCH panel stays pinned visible above the filtered grid.
- [ ] Spawn a second orch panel. Both stack in the pin row (rare; defensible).
- [ ] Exit the orch panels (DELETE). Pin row collapses to zero height.

## Tile auto-removal (T1.3)

- [ ] Spawn a panel running `sh -c 'sleep 2; exit 0'`. After 2s + 3s grace, tile vanishes from grid.
- [ ] Spawn a panel; manually DELETE via API. Tile vanishes with grace period.
- [ ] Belt-and-suspenders: simulate a missed `panel_exited` frame (or force-set `meta.status='exited'` server-side without broadcast). Tile force-removes after ~60s.

## meta.role (T2.1)

- [ ] `POST /api/sessions {role: "orchestrator"}` → 200, panel renders in ORCH row.
- [ ] `POST /api/sessions {role: "invalid"}` → 400 with body `{code: "invalid_role", allowed: [...]}`.
- [ ] `POST /api/sessions {}` (no role) → 200, panel renders in standard grid; `meta.role: null`.

## Exited-session filtering (T2.2)

- [ ] Spawn 3 panels, exit 1. `GET /api/sessions` returns 2.
- [ ] `GET /api/sessions?includeExited=true` returns 3.

## 410 Gone on dead panel inject (T2.3)

- [ ] Spawn a panel, DELETE it. `POST /api/sessions/<id>/input {text: "hi"}` → `410 Gone` with `{code: "panel_exited"}`.

## Idle/parked detection (T2.5)

- [ ] Spawn a codex panel; let it finish a turn (output ends with `─ Worked for Xm Ys ─`). Within ~2s, `meta.status === 'active'` and `meta.statusDetail === ''`.
- [ ] Spawn a claude panel; let it finish a turn (output ends with idle-prompt cursor). Same.
- [ ] Stale heuristic: force `meta.status='thinking'` + `meta.lastActivity` 65s ago. Next broadcast tick flips to `'active'`.

## Brad's 18-panel-2-project shape (3.2)

- [ ] Run the synthetic reproducer from `packages/server/tests/sprint-65-acceptance.test.js`. All assertions pass.
```

### 3.4 — Regression sweep

Run `npm test` root from clean. Look for regressions in:
- `tests/cli-doctor.test.js` — schema-check probes if T2 added a migration.
- `tests/sessions-api.test.js` — likely T2's new fences live here; verify no other tests in the file break.
- `tests/agent-adapters.test.js` — T2's `idlePattern` additions; T2's `analyzeOutput` changes may shift existing pattern-detection counts.
- Any tests touching `app.js` (if a client-side test harness exists).

## Files of interest

- `packages/server/tests/sprint-65-acceptance.test.js` (NEW)
- `docs/sprint-65-dashboard-reliability/ACCEPTANCE-CHECKLIST.md` (NEW)
- `docs/sprint-65-dashboard-reliability/STATUS.md` (your FINDING / DONE posts)

## Acceptance criteria

For this lane to close (post `### [T3] DONE`):

- Sprint-65-acceptance test fixture green (covers Brad's 18-panel-2-project shape).
- `ACCEPTANCE-CHECKLIST.md` authored + readable by Joshua + Brad.
- 2a "opens invisible" sub-bug either fixed-in-sprint (with Brad's repro) or deferred with documented BACKLOG entry.
- `npm test` root green; no regressions in adjacent tests.
- No version bumps, no CHANGELOG edits, no commits.

## Post discipline

`### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`

Standard verbs. `### ` prefix on every post.

If 2a's repro lands and matches a fixable hypothesis, post `### [T3] FINDING — 2a repro matches hypothesis <A/B/C/D>; proposing fix at <file:line>; coordinating with T1/T2`. Then idle-poll for orchestrator SCOPE adjudication on whether to fix-in-sprint.
