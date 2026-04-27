# Sprint 37 — Orchestrator-as-product (Phase C part 1)

**Status:** Planned. Kickoff after Sprint 36 ships.
**Target version:** `@jhizzard/termdeck` v0.9.0 (minor bump — adds first-class orchestrator surface).

## Goal

Make the orchestration patterns Joshua uses (the 4+1 sprint, CLAUDE.md hierarchies, per-project memory architecture, restart-prompt rituals) into a first-class shipped product feature. Other developers should be able to pick up TermDeck and *learn how to orchestrate* — not just *run terminals*.

## Why now

After Sprints 35–36, TermDeck is a complete TMR stack with a sane install. But the actual product moat — the *way* Joshua works with it — lives only in his global CLAUDE.md and his memory. Shipping that as a guided product is what differentiates TermDeck from "another browser tmux." Brad's install pain made the plumbing visible; this sprint makes the orchestration patterns visible and scaffold-able.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Orchestrator Guide doc + dashboard surface** | Authoritative reference covering: 4+1 sprint pattern, inject mandate (no copy-paste), CLAUDE.md hierarchy (global / project / session), never-copy-paste-messages rule, enforcement-vs-convention rule, project_facts.md / CONTRADICTIONS.md / restart-prompt patterns, when to use memory_remember vs project files. Plus an in-dashboard right-rail panel that contextually surfaces relevant Guide sections based on what panel is focused. | NEW `docs/orchestrator-guide.md`, `packages/client/public/app.js` (right-rail Guide panel), `packages/client/public/index.html` |
| **T2 — Per-project scaffolding generator** | NEW `termdeck init --project <name>` subcommand creates a full project skeleton: `CLAUDE.md` (templated from a base + project name + path), `CONTRADICTIONS.md`, `project_facts.md`, `docs/orchestration/`, `RESTART-PROMPT.md` template, `.claude/settings.json` with sensible permission defaults. Templates live in `packages/cli/templates/`. User can preview before generation (dry-run flag). | NEW `packages/cli/src/init-project.js`, NEW `packages/cli/templates/` directory, `packages/cli/src/index.js` (subcommand registration) |
| **T3 — Orchestration document preview** | Dashboard surface that shows, for any project: "If you ran a 4+1 sprint here, here's what would be created." Renders the planning skeleton, what files would be touched, what STATUS.md template would shape, what restart-prompt would carry. Read-only preview. Optional generate button to commit. | `packages/client/public/app.js` (preview pane in project drawer), `packages/server/src/index.js` (NEW `/api/projects/:name/orchestration-preview`), shares templates with T2 |
| **T4 — In-dashboard 4+1 sprint runner** | UI to define and start a 4+1 sprint without dropping to the CLI: name the sprint, define T1–T4 lane goals, point to a PLANNING.md (or auto-generate from a template), click "kick off." TermDeck spawns four panels + injects boot prompts via the existing inject API. Live STATUS.md tail in a sidebar panel. View FINDING/FIX-PROPOSED/DONE counts per lane. | `packages/client/public/app.js` (sprint runner UI + STATUS.md tail), `packages/server/src/index.js` (orchestrator helper endpoints — `POST /api/sprints`, `GET /api/sprints/:name/status`) |

## Out of scope (Sprint 38)

- Knowledge graph and visualization

## Open design questions

1. **Where does the Orchestrator Guide live in the UI?** Right-rail panel? Modal? Dedicated `/guide` route? Probably right-rail with collapse, surfacing contextually but always one click away.
2. **Sprint runner scope** — does it run sprints only against the *current TermDeck instance's projects*, or can it spawn against arbitrary directories? Start with current-instance-only; arbitrary-directory is Sprint 38+.
3. **Template language for scaffolding** — handlebars-style placeholders in plain markdown files, or a JS template function? Plain markdown with `{{project_name}}` style placeholders is simplest and aligns with the no-build-step ethos.

## Acceptance criteria

1. A new TermDeck user reads `docs/orchestrator-guide.md` and understands how to run a 4+1 sprint without prior context.
2. `termdeck init --project hello-world` creates the full scaffolding; a developer reading the result understands the project structure and how to use it.
3. Dashboard's orchestration preview accurately shows what `init --project` would generate — preview matches actual output.
4. A user can kick off a 4+1 sprint from the dashboard end-to-end (define lanes → spawn panels → inject prompts → tail STATUS.md) without touching the CLI.

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.

## Dependencies on prior sprints

- Sprint 36 ships dashboard infrastructure (Settings panel, /api/config) that T1's right-rail and T4's sprint runner build on.
- Joshua's existing 4+1 patterns + CLAUDE.md content provide the source material for T1's Guide doc — orchestrator extracts from `~/.claude/CLAUDE.md` + project-level CLAUDE.md + memory.
