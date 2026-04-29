# Sprint 42 — T4: Dashboard housekeeping — project removal UI + PTY drag/drop reordering

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Two Joshua-flagged dashboard polish items paired into one lane.

**(a) Project removal.** NEW `DELETE /api/projects/:name` endpoint + modal with explicit "files-on-disk untouched" wording + 409 if live PTY sessions present unless `?force=true`.

**(b) PTY panel drag/drop reordering.** Pure CSS Grid + drag-handle work in `packages/client/public/app.js`. Inject identifier is the session UUID, not visual position, so drag-reorder doesn't break inject.

## Files
- `packages/server/src/index.js` — `DELETE /api/projects/:name`
- `packages/client/public/app.js` — project removal modal + drag-handle on `.term-panel`
- `packages/client/public/style.css` — drag-handle styling
- `packages/client/public/index.html` — remove button next to add-project +
- NEW `tests/projects-routes.test.js` — DELETE happy path / 404 / 409

## Acceptance criteria
1. Dashboard supports DELETE for a project (with the safety modal + 409 semantics).
2. Drag-and-drop reorder of PTY panels works without breaking inject identifiers.
3. Modal explicitly states "files on disk are untouched" so users don't fear data loss.
4. 409 response when live PTY sessions are present, overridable with `?force=true`.

## Lane discipline
- Append-only STATUS.md updates with `T4: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T4 owns project-removal endpoint + dashboard UI surface. Does NOT touch graph-inference (T1), pty-reaper observability route (T2), or stack-installer/Mnestra package.json (T3)

## Pre-sprint context
- Joshua's two dashboard-housekeeping asks (2026-04-27): remove a project, drag-to-reorder panels.
- Both ~150 LOC each. Pair into one lane.
- Sprint 41's project taxonomy is now canonical — T4's project removal UI consumes the taxonomy doc as its reference for valid project names.

## Coordination
- T2 ↔ T4 — both touch the dashboard server surface. T2 adds `/api/pty-reaper/status` (read-only); T4 adds `DELETE /api/projects/:name` (destructive, with 409 semantics). No route overlap. Coordinate on `packages/server/src/index.js` route registration ordering.
