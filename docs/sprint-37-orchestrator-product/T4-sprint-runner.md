# Sprint 37 — T4: In-dashboard 4+1 sprint runner with `--isolation=worktree` opt-in

**Lane goal:** Ship a UI in the TermDeck dashboard that lets a user define and kick off a 4+1 sprint without dropping to the CLI. The user names the sprint, defines T1–T4 lane goals, points to a `PLANNING.md` (or auto-generates one from a template), clicks "kick off." TermDeck spawns four panels, injects boot prompts via the existing inject API using the **two-stage submit pattern**, and tails STATUS.md in a sidebar.

This lane is the structural answer to the four cohort kills hit in Sprint 36 — `--isolation=worktree` is the durable fix. Lanes that work in isolated git worktrees can't stomp on each other's files; the orchestrator merges at close.

**Target deliverable:**
1. Sprint runner UI in the dashboard (lane definition form, kick-off action, live STATUS.md tail, FINDING/FIX-PROPOSED/DONE counts per lane).
2. Server endpoints: `POST /api/sprints` (create + spawn + inject), `GET /api/sprints/:name/status` (parse STATUS.md, return per-lane counts), `GET /api/sprints/:name/tail?lines=N` (live tail).
3. **`--isolation=worktree` opt-in** — when enabled, each lane spawns in a `git worktree` rooted at the sprint dir. Orchestrator merges at close. Off-by-default for v0.9.0; users opt in.

## Why now

Joshua's existing 4+1 inject works because Joshua himself runs an orchestrator Claude session, runs cURL commands, watches `/api/sessions`. Most users won't. Putting this in the UI:

- Makes the orchestration pattern visible (acceptance criterion #4).
- Encodes the two-stage submit pattern correctly (no user can accidentally single-stage and ghost-trap a panel).
- Sets up worktree isolation as the going-forward protocol — per Joshua's 2026-04-27 decision (`memory_recall` "Sprint 37 Phase C should ship worktree-based 4+1 sprint orchestration protocol").

## UI design

A new top-level dashboard section "Sprints" (alongside the existing Projects view). Or a "Run a sprint" button in the project drawer (T3 forward-references this). Either is fine; pick whichever fits the existing nav.

Sprint definition form:

```
Sprint name:        [_______________________]   (becomes docs/sprint-N-<name>/)
Target version:     [_______________________]
Goal (1 line):      [_______________________]
─────────────────────────────────────────────
T1 lane name:       [_______________________]
T1 goal:            [_______________________]
T2 lane name:       [_______________________]
T2 goal:            [_______________________]
T3 lane name:       [_______________________]
T3 goal:            [_______________________]
T4 lane name:       [_______________________]
T4 goal:            [_______________________]
─────────────────────────────────────────────
[ ] Use git worktrees for lane isolation (recommended)
[ ] Auto-inject boot prompts on lane spawn (default ON)

[Generate PLANNING.md & lane briefs]    [Cancel]
```

After "Generate" → preview screen showing the would-be `docs/sprint-N-<name>/PLANNING.md`, `T1.md`, `T2.md`, `T3.md`, `T4.md`, `STATUS.md`. Confirm → write files. Then "Kick off" button becomes active.

Kick off:

1. Spawn 4 fresh terminal panels (use existing `/api/sessions` create endpoint).
2. If `--isolation=worktree`: for each lane, `git worktree add <sprint_dir>/worktrees/T<n> <branch_name>`. Set the panel's CWD to that worktree.
3. Inject boot prompts via two-stage submit (described below).
4. Open a sidebar pane that polls `/api/sprints/:name/status` every 3s, rendering FINDING/FIX-PROPOSED/DONE counts per lane.

## Two-stage submit — server-side enforcement

The two-stage pattern is non-negotiable (per `~/.claude/CLAUDE.md` § 4+1 inject mandate). Implement it server-side so users can't accidentally bypass:

```js
// packages/server/src/sprint-inject.js (new)
async function injectSprintPrompts(sessionIds, prompts) {
  // Stage 1: paste-only across all 4 sessions, 250ms gaps
  for (let i = 0; i < sessionIds.length; i++) {
    await postInput(sessionIds[i], `\x1b[200~${prompts[i]}\x1b[201~`);
    if (i < sessionIds.length - 1) await sleep(250);
  }
  // Settle
  await sleep(400);
  // Stage 2: submit-only across all 4 sessions, 250ms gaps
  for (let i = 0; i < sessionIds.length; i++) {
    await postInput(sessionIds[i], '\r');
    if (i < sessionIds.length - 1) await sleep(250);
  }
}
```

After all submits, verify via `GET /api/sessions/:id/buffer` that each panel reports `status: 'thinking'` within 8 seconds. If any panel is `status: 'active'` (idle), POST `/api/sessions/:id/poke` with `methods: ['cr-flood']` automatically. **Never page the user; recover silently.** This is the cardinal rule from the inject mandate.

## Worktree isolation

Off-by-default for v0.9.0. When the checkbox is on:

```bash
# At kickoff, for each lane:
git -C <project_path> worktree add <sprint_dir>/worktrees/T<n> -b sprint-<sprint_name>-T<n>
```

Each panel's CWD is set to its lane worktree. Lane workers see only their worktree; can't accidentally touch other lanes' files via relative paths.

At sprint close (orchestrator action, NOT this lane's responsibility): orchestrator merges each lane's branch into `main`, removes the worktrees with `git worktree remove`. Document this close-out flow in the lane brief but do NOT implement merge-at-close UI — that's a Sprint 38+ refinement.

## Status parsing

`GET /api/sprints/:name/status` reads `docs/sprint-N-<name>/STATUS.md` and returns:

```json
{
  "sprintName": "orchestrator-product",
  "lanes": {
    "T1": { "finding": 1, "fixProposed": 1, "done": 0, "lastEntryAt": "2026-04-27T16:50:00Z" },
    "T2": { ... },
    "T3": { ... },
    "T4": { ... }
  },
  "lastModifiedAt": "2026-04-27T16:51:23Z"
}
```

Parse by counting `### FINDING —` / `### FIX-PROPOSED —` / `### DONE —` headers under each `## T<n>` section. Cheap regex match; no markdown AST library needed.

## Primary files

- NEW `packages/server/src/sprint-inject.js` — two-stage submit + verify-and-poke logic.
- NEW `packages/server/src/sprint-routes.js` — endpoints (`POST /api/sprints`, `GET /api/sprints/:name/status`, `GET /api/sprints/:name/tail`).
- `packages/server/src/index.js` — wire the sprint-routes module. Keep the wiring thin; logic lives in the new modules.
- `packages/client/public/app.js` — sprint runner UI (form, preview, kick-off, status sidebar).
- `packages/client/public/index.html` — sprint runner markup.
- `packages/client/public/style.css` — sprint runner layout.

## Coordination notes

- **T1** writes the Orchestrator Guide. Its "inject mandate" section should mention the in-dashboard sprint runner once you ship. T1's brief notes this.
- **T2** ships templates. The sprint runner's "Generate PLANNING.md" should ideally reuse a `PLANNING.md.tmpl` if T2 ships one. If T2 doesn't, inline a minimal template here and note it for orchestrator factor-out at close.
- **T3** builds the orchestration preview pane. T3 forward-references your "Run a sprint here" deep-link from the project drawer. Provide a stable URL hash (e.g., `#/sprints/new?project=<name>`) that T3 can link to.

## Test plan

- New `tests/sprint-inject.test.js`:
  - `injectSprintPrompts` calls postInput in two phases (stage 1 paste with bracketed-paste markers, stage 2 `\r` alone). Verify with mocked postInput.
  - 400ms settle window between phases.
  - 250ms inter-session gap.
- New `tests/sprint-routes.test.js`:
  - `POST /api/sprints` writes expected files.
  - `GET /api/sprints/:name/status` parses sample STATUS.md correctly.
- Manual: open dashboard sprint runner, fill in a test sprint, generate, kick off, watch STATUS.md tail update as you write to the file.
- Worktree path manual: with checkbox on, verify `git worktree list` shows four worktrees after kickoff. Verify each panel's CWD matches.

## Out of scope

- Don't implement worktree-merge-at-close. Orchestrator does that manually at sprint close for v0.9.0; automation is Sprint 38+.
- Don't write the Orchestrator Guide — T1 owns it.
- Don't write templates — T2 owns them.
- Don't build the orchestration preview pane in the project drawer — T3 owns it.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-37-orchestrator-product/STATUS.md` under `## T4`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
