# T1 — SERVER + FLASHBACK lane

**Role:** Claude worker, Sprint 57.
**Scope:** Flashback negative-feedback persistence (#4) + Flashback errorLineStart pattern tightening (F-T2-3).

## Goal

Stop low-confidence flashbacks from re-surfacing after the user marks them "useless." Tighten the `errorLineStart` pattern so it doesn't match the literal substring "Error" too aggressively.

## Pre-flight reads

1. `docs/sprint-57-cleanup-and-deferrals/PLANNING.md` (full sprint context)
2. `docs/sprint-57-cleanup-and-deferrals/STATUS.md` (post shape, discipline)
3. `docs/sprint-55-full-stack-sweep/T2-SWEEP-CELLS.md` (F-T2-3 full diagnosis from Sprint 55 T2)
4. `docs/sprint-55-full-stack-sweep/T4-SWEEP-CELLS.md` (Codex's flashback-persistence diagnosis addendum)
5. `packages/server/src/index.js:1058-1100` (the surface query at the heart of #4)
6. `packages/server/src/flashback/*` if it exists; otherwise grep for `errorLineStart` and `flashback_events`

## Tasks

### Task 1.1 — Flashback negative-feedback persistence (#4)

**Symptom (Sprint 55 T2 + T4-Codex):** User dismisses a flashback via the modal "Not relevant" button. The endpoint records dismissal into `flashback_events`, but the SURFACE-side query at `packages/server/src/index.js:1058-1100` doesn't consult `dismissed_at` history before emitting the next proactive hit. Same low-confidence flashback resurfaces immediately.

**Fix (preferred):** Add a `WHERE NOT EXISTS (SELECT 1 FROM flashback_events WHERE memory_id = X AND dismissed_at IS NOT NULL)` predicate to the surface query. Keep the existing scoring/ranking logic intact — this only filters at the tail.

**Alternative if dismissed_at column doesn't exist on flashback_events:** Wire the modal feedback ("Not relevant" / "This helped") to a durable endpoint that updates a `flashback_events.user_disposition` column (text: 'helpful' | 'dismissed' | NULL). Then filter on `user_disposition != 'dismissed'`.

**Verification:**
- Unit test: insert a flashback_events row with dismissed_at NOT NULL, confirm the surface query excludes that memory_id.
- Integration test (manual, server-only): start dev server, hit the flashback endpoint, dismiss a flashback, hit the endpoint again — confirm the same memory_id does NOT come back.
- Do NOT exercise the UI dimension — that's deferred to Sprint 58 #7 after Playwright `--isolated` lands.

### Task 1.2 — Flashback errorLineStart pattern tightening (F-T2-3)

**Symptom (Sprint 55 T2 cell F-T2-3):** The `errorLineStart` pattern matches the literal substring "Error" too aggressively, including in non-error contexts ("Error handling docs", "ErrorBoundary component name", etc.).

**Fix:** Locate the pattern (grep for `errorLineStart` across `packages/server/src/`). Tighten to one of:
- Anchor at start-of-line + word boundary: `^Error\b`
- Require trailing colon or space: `\bError:` or `^\s*Error\s`
- Whatever the surrounding context calls for — read the call site and pick the tightest correct pattern.

**Verification:**
- Unit test against a fixture that includes both true error lines (e.g. `Error: connection refused`) and false-positive substrings (e.g. `ErrorBoundary`, `Error handling docs`) — confirm only true errors match.

## Discipline (universal — read STATUS.md § Lane discipline)

- **Post shape:** `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (with the `### ` prefix — non-negotiable per global rule).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Orchestrator handles close.
- **Stay in lane.** Don't touch T2's API findings, T3's rumen/playwright work, or anything outside `packages/server/src/`. Cross-lane reads OK.
- **Append-only STATUS.md.** Never rewrite a prior post.
- **Test discipline:** Run `cd packages/server && npm test` before posting `### [T1] DONE`.

## Coordination notes

- T2's `#5 dashboard resize-recovery` is client-side (`packages/client/public/app.js`) — should not collide with your server work.
- F-T2-3 lives near the flashback emission code. If your scoping puts it in the same file as the #4 surface query, batch the edits in one commit-equivalent diff.
- T4-CODEX may audit your work in-progress. Welcome the scrutiny.

## Success criteria

1. `### [T1] FIX-LANDED` posts for both Task 1.1 and Task 1.2 with file:line evidence.
2. `cd packages/server && npm test` passes (existing tests + any new unit tests you add).
3. T4-CODEX confirms the diff via independent reproduction (you don't gate on this — keep moving — but expect their CHECKPOINT posts).
4. `### [T1] DONE 2026-05-05 HH:MM ET` posted to STATUS.md with summary of what shipped.
