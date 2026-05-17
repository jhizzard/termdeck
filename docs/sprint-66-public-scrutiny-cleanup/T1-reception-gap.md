# T1 — Sprint-65 reception gap

**Mission:** Sprint 65's two headline features — the project-filter chip rail and the ORCH-pin — shipped correctly in 1.4.0 but are **invisible to Brad**, the user who requested them. Make both reachable in his actual setup.

You are T1 in Sprint 66 (3+1+1). Follow the boot sequence in `PLANNING.md`, then work this brief. Stay in your lane. Post `### [T1] ...` to `STATUS.md`. No version bumps, no CHANGELOG, no commits.

> Lane briefs are plans authored ahead of the work. **Verify every file path and line number against the live codebase at boot** — a brief↔code divergence is itself a FINDING to post, not something to silently work around.

---

## Verified context (do not re-litigate — this is established)

- 1.4.0 shipped the chip rail + ORCH-pin **correctly**. `npm view @jhizzard/termdeck@1.4.0 gitHead` = `cc883b7`; the published `app.js` is byte-identical to the repo. This is **not** a publish or packaging bug.
- Brad, on a fresh 1.4.0 install + restart + hard-refresh, sees **neither** feature. Two design decisions are why:
  1. **Chip rail:** `shouldShowChipRow()` (around `app.js:734`) returns false when there are fewer than 2 distinct projects. Brad's dead-panel reaper left him **1 live panel → 1 project → rail self-hides**. Brad's 2026-05-13 v2 spec asked for an *always-visible* chip rail across the dashboard top.
  2. **ORCH pin:** the gold border + `ORCH` badge + pinned row engage only for a panel whose `meta.role === 'orchestrator'` (`isOrchestratorRole()` ~`app.js:741`). `meta.role` is set at spawn and **immutable post-spawn** — see the comment around `app.js:916` ("meta.role is immutable post-spawn so this is a no-op"). There is **no UI** to set it. Brad's existing orchestrator panel (created before/without the role) can never show the treatment without being destroyed and recreated via the raw API.

The lesson: Sprint 65 solved the technical edge cases and missed the human-reception case. T1 closes that.

---

## Task 1.1 — Chip rail discoverable with a single project

- Change the chip rail so it renders whenever there is **≥1 project**, not ≥2. With one project it simply shows `[ All (n) ]` — harmless, and it makes the feature *discoverable* (Brad's "always-visible" intent).
- Inspect `shouldShowChipRow()` and the render path `renderProjectChips()` (~`app.js:819`) + the `#project-chips` container in `index.html`. Decide between: (a) always render with ≥1 project, or (b) render with a one-line empty-state hint when only 1 project ("filters appear here once you have panels from 2+ projects"). **Recommendation: (a)** — simplest, matches the spec word "always-visible", no empty-state copy to maintain.
- Confirm the always-visible rail does not cause a grid layout/height regression (the rail consumes vertical space — verify the grid still fits the standard layouts).

## Task 1.2 — Make `meta.role` mutable on a live session

- Add a server endpoint to change a live session's role. Suggested shape: `PATCH /api/sessions/:id` accepting `{ role }` (or `POST /api/sessions/:id/role` — pick one, justify in STATUS). Whitelist-validate exactly as `POST /api/sessions` does (`orchestrator|worker|reviewer|auditor|null`); reject unknown values with `400`. Persist the change to SQLite (`session.js` — the same meta-persist path Sprint 65 T2 added) and flow it through the existing `status_broadcast` frame.
- On the client, **remove the immutability assumption**. The `app.js:916`-area code currently treats `meta.role` as fixed and short-circuits the re-render. Find every place that assumed immutability and make the role-routing (`panel--role-orch` class apply/remove, ORCH row membership, badge) **re-evaluate** whenever a `status_broadcast` reports a changed role.
- Server files: `packages/server/src/index.js` (route), `packages/server/src/session.js` (persist). Client: `packages/client/public/app.js`.

## Task 1.3 — UI affordance to tag a panel as orchestrator

- Add a control so a user can mark an existing panel as the orchestrator (and unmark it). Natural homes: the panel's **Overview tab**, a title-bar control, or a panel context menu. Pick the one most consistent with existing dashboard UX; justify in STATUS.
- The control calls the Task 1.2 endpoint. On success the panel immediately gains the gold border + `ORCH` badge + moves to the pinned ORCH row — no reload, no recreate.
- Keep it single-orchestrator-sane: if marking a panel as orchestrator while another already is, decide and document the behavior (suggest: allowed — the ORCH row can hold more than one; or last-wins — your call, justify it).

## Tests

- Extend `packages/server/tests/dashboard-panels-client.test.js` (client behavior) and add server-side coverage for the new role-mutation endpoint (validation, persistence, broadcast) — mirror the Sprint 65 fence-test style.
- Root `npm test` must stay green (375/375 baseline) and grow, not shrink.

## Acceptance (what DONE means)

- Chip rail renders with 1 project (Brad-shape: one panel → `[ All (1) ]` visible).
- A live panel can be tagged orchestrator from the UI and immediately shows the gold border + `ORCH` badge + pinned row, with no recreate.
- The role change persists across reload and is reflected in `status_broadcast`.
- `npm test` green; post `### [T1] DONE ...` with file:line evidence.

## Lane discipline

Post `### [T1] FINDING/FIX-PROPOSED/FIX-LANDED/DONE 2026-05-17 HH:MM ET — <gist>` to STATUS.md as you go (the `### ` prefix is required). Read T2/T3 WIP if you need cross-lane consistency, but stay in the client + the one server endpoint. T4 (Codex) will audit your role-mutation endpoint for races and the removed-immutability assumption — make those easy to verify.
