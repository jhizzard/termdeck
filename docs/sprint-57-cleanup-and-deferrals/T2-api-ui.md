# T2 — API + UI lane

**Role:** Claude worker, Sprint 57.
**Scope:** Sprint 55 Tier 3 API findings (F-T2-2, F-T2-4, F-T2-6 + costBand doc fix) + dashboard resize-recovery (#5).

## Goal

Close 4 of the 5 Sprint 55 Phase A API findings (F-T2-3 errorLineStart is owned by T1) plus the doc-only costBand correction in the SWEEP-CELLS matrix, and add a layout-health guard to the dashboard for post-resize recovery.

## Pre-flight reads

1. `docs/sprint-57-cleanup-and-deferrals/PLANNING.md`
2. `docs/sprint-57-cleanup-and-deferrals/STATUS.md`
3. `docs/sprint-55-full-stack-sweep/T2-SWEEP-CELLS.md` (full diagnosis of all 5 deferred F-T2-* findings + costBand inaccuracy noted by Codex)
4. `docs/sprint-55-full-stack-sweep/T4-SWEEP-CELLS.md` (Codex's audit notes on the resize-recovery refined proposal — explicitly says fix shape is the layout-health guard, NOT another resize listener)
5. `packages/server/src/index.js` (graph endpoints + RAG state surface)
6. `packages/client/public/app.js` (existing `window.resize` → debounced `fitAll()` + per-terminal `ResizeObserver`)

## Tasks

### Task 2.1 — RAG state model unification (F-T2-2 + F-T2-6) — DESIGN-DECISION-FIRST

**Symptom:** API exposes 2-state RAG model (boolean enabled/disabled). UI surfaces 3-state (off / read-only / read-write OR similar — read T2-SWEEP-CELLS.md for the exact UI semantics). Mismatch is invisible to existing users but blocks any UI/API contract clarification.

**Required first step (before code):** Post `### [T2] FINDING 2026-MM-DD HH:MM ET — RAG state model proposal` to STATUS.md with:
- Current API contract (file:line)
- Current UI contract (file:line)
- THREE proposed unification directions: (a) API → 3-state to match UI, (b) UI → 2-state to match API, (c) introduce explicit translation layer keeping both
- Your recommendation with rationale (1-2 sentences)
- Wait for orchestrator post `### [ORCH] GREEN-LIGHT T2 RAG state direction <a|b|c>` before writing code.

This avoids a 30-min refactor in the wrong direction.

### Task 2.2 — `/api/graph/all` pagination (F-T2-4)

**Symptom:** Endpoint returns 1.2 MB / 862 ms payload. Single response. Pages off the screen on slow connections.

**Fix (one of):**
- **Option A (cursor pagination):** Add `?cursor=<base64-encoded-id>&limit=N` (default N=200). Return `{ items, nextCursor }`.
- **Option B (streaming):** Switch the response to JSONL streamed chunks. Update the client at `packages/client/public/app.js` to consume the stream.

Pick whichever fits the existing codebase pattern best (grep how other endpoints handle large payloads). If both are equally invasive, prefer Option A — simpler client change.

**Verification:** Unit test confirming N+1 page chunks cover the same set as the current single-shot response.

### Task 2.3 — costBand doc fix in T2-SWEEP-CELLS.md

**Symptom:** Codex caught an inaccuracy in the T2 matrix's `costBand` annotation for one of the agents (Grok, per sprint-55 audit). Doc-only fix in `docs/sprint-55-full-stack-sweep/T2-SWEEP-CELLS.md`.

**Fix:** Open the file, find Codex's correction note in the audit log, apply the corrected `costBand` value. No code touched.

### Task 2.4 — Dashboard resize-recovery layout-health guard (#5)

**Symptom (Sprint 55 T2 cells):** Rapid Playwright resize chain crushed the panel grid into the corner. Manual window-resize did NOT trigger reflow. Codex's refined proposal in T4-SWEEP-CELLS.md is explicit: fix shape is a **post-resize layout-health assertion + forced reflow**, NOT just another resize listener (the existing one is fine).

**Fix:**
- Add a `verifyLayoutHealth()` function to `packages/client/public/app.js` that runs ~250 ms after the existing debounced `fitAll()` completes. The function checks:
  - `#termGrid` `getBoundingClientRect().width` is within 90 % of `window.innerWidth - <known-chrome-width>` (find the actual chrome width in the existing code).
  - Each terminal container has `getBoundingClientRect().width > 0` and `> 0` height.
- If health check fails, force a recovery: trigger a synthetic resize event OR re-call the layout function with `force=true` flag.
- Do NOT add a second `window.resize` listener — extend the existing one's debounced callback to also call `verifyLayoutHealth()` at the tail.

**Verification:** Manual browser test if you have a dev server already running in this session. Otherwise document the verification plan in your `### [T2] FIX-PROPOSED` post and let T4-CODEX or orchestrator drive the post-Playwright-`--isolated`-lands re-verification (Sprint 58 #7 follow-up).

## Discipline (universal — read STATUS.md § Lane discipline)

- **Post shape:** `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (with the `### ` prefix).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`.
- **Stay in lane.** Don't touch T1's flashback work or T3's cross-repo edits. Cross-lane reads OK.
- **Append-only STATUS.md.**
- **Design-decision gating on Task 2.1.** Don't write code until orchestrator posts GREEN-LIGHT.
- **Test discipline:** `cd packages/server && npm test` before posting DONE for Tasks 2.2; manual UI sanity-check for Task 2.4.

## Success criteria

1. `### [T2] FINDING` post for Task 2.1 (RAG state direction proposal) before any code lands.
2. `### [T2] FIX-LANDED` posts for Tasks 2.1 (after GREEN-LIGHT), 2.2, 2.3, 2.4 with file:line evidence.
3. T4-CODEX audits at least the API contract change (Task 2.1) and the pagination semantics (Task 2.2) — independent reproduction expected.
4. `### [T2] DONE 2026-05-05 HH:MM ET` posted with summary.
