# Sprint 37 — T1: Orchestrator Guide doc + dashboard right-rail surface

**Lane goal:** Take the orchestration patterns Joshua uses every day (4+1 sprint, inject mandate, CLAUDE.md hierarchy, never-copy-paste rule, enforcement-vs-convention rule, project_facts.md / CONTRADICTIONS.md / restart-prompt rituals) and ship them as a first-class, readable, in-product reference. Other developers picking up TermDeck should learn *how to orchestrate* — not just *how to run terminals*.

**Target deliverable:**
1. NEW `docs/orchestrator-guide.md` — authoritative, standalone reference. Linkable from README, from `--help`, from the dashboard.
2. NEW dashboard right-rail Guide panel that surfaces relevant Guide sections contextually based on what the user is doing (focused panel = active sprint lane → show "4+1 sprint" section; project drawer open = show "CLAUDE.md hierarchy" section).

## Source material — read these first

The Guide is a re-engineering of content that already lives in three places:

1. `~/.claude/CLAUDE.md` — global rules. Sections to lift:
   - "MANDATORY: 4+1 sprint orchestration — always inject, never copy-paste" (the inject mandate + two-stage submit pattern)
   - "MANDATORY: Never present messages for copy-paste — always inject" (channel inject patterns)
   - "MANDATORY: Check Memory First" (memory-first discipline)
2. `./CLAUDE.md` (project router) — the read-order pattern + hard rules.
3. `docs/RELEASE.md` — Passkey-not-OTP, publish order, audit-trail bumps.
4. Project memories (cross-reference, do not duplicate):
   - `feedback_orchestrator_discipline.md` — TMR 4+1 over-cautiousness rule
   - `feedback_orchestrator_enforcement.md` — enforcement-vs-convention rule

## Required Guide sections

The Guide MUST cover, in this order:

1. **What is the 4+1 pattern?** Four parallel Claude Code panels (T1–T4) + a fifth orchestrator session. Why parallel beats serial. When to use 4+1 vs. a single session.
2. **The inject mandate.** No copy-paste of boot prompts. The two-stage submit pattern (paste, 400ms settle, `\r` alone) — why single-stage `<text>\x1b[201~\r` is banned. The cardinal sin: leaving a panel waiting for a human Enter press. Walk through the `/api/sessions/:id/input` and `/poke` endpoints with cURL examples.
3. **CLAUDE.md hierarchy.** Three layers: `~/.claude/CLAUDE.md` (global rules), `./CLAUDE.md` (project router — short, points elsewhere), session-prompt boot sequence. What goes in each layer. How read-order matters.
4. **Memory-first discipline.** `memory_recall` before any work. When to use `memory_remember`. When to write to project files instead. The cross-project search idiom (omit `project` parameter).
5. **Enforcement vs. convention.** The default-to-enforcement rule for security/correctness gaps. The three conditions that justify convention-only.
6. **Sprint discipline inside a lane.** No version bumps, no CHANGELOG edits, no commits. FINDING / FIX-PROPOSED / DONE entries in STATUS.md. Append-only.
7. **Restart-prompt rituals.** When to write a `RESTART-PROMPT-YYYY-MM-DD.md`. What it must contain (live state, what shipped, what's planned, read-order for the next session, paste-ready prompt block).
8. **Per-project scaffolding files.** What `CLAUDE.md`, `CONTRADICTIONS.md`, `project_facts.md`, `docs/orchestration/` each do. Forward-reference to T2 (the `termdeck init --project` command) and T3 (preview).
9. **Channel inject patterns** (brief). WhatsApp `wa.me`, iMessage MCP, the `to: "self"` convention. Lift from global CLAUDE.md.

Each section ends with a one-line "see also" linking to the canonical source (`~/.claude/CLAUDE.md § X` or memory entry name).

## Dashboard right-rail Guide panel

A collapsible right-rail panel in the dashboard (default collapsed). When expanded, shows:

- A search box that filters Guide sections by keyword.
- The full Guide section list, with the contextually-relevant section auto-expanded based on UI state:
  - Focused on a terminal panel → expand "4+1 pattern" section
  - Project drawer open → expand "CLAUDE.md hierarchy" + "per-project scaffolding"
  - Sprint runner open (T4's lane, may not exist yet at T1 write-time) → expand "inject mandate" + "sprint discipline"
- Each section is one click away. No modal. No new route — keeps the page weight low.

Render the Guide markdown client-side. No server endpoint required for v1; load `docs/orchestrator-guide.md` over a static file route the server already exposes (`/docs/orchestrator-guide.md`). If no static-docs route exists, add the smallest one possible (`app.use('/docs', express.static('docs'))`) and note it for orchestrator close-out review.

## Primary files

- NEW `docs/orchestrator-guide.md` — the canonical doc.
- `packages/client/public/app.js` — right-rail panel logic, contextual section expansion, search box.
- `packages/client/public/index.html` — right-rail container markup.
- `packages/client/public/style.css` — right-rail layout. Coordinate with existing orchestrator-grid CSS at `style.css:315–344` so the rail collapses cleanly when full-width orchestrator mode is active.
- (Possibly) `packages/server/src/index.js` — add `app.use('/docs', express.static('docs'))` if no docs static route exists. Smallest change possible — do not refactor.

## Coordination notes

- **T2** is creating templates in `packages/cli/templates/` for `termdeck init --project`. Cross-link the Guide to T2's templates ("the canonical CLAUDE.md template lives in `packages/cli/templates/CLAUDE.md.tmpl`"). Do NOT duplicate template content into the Guide; reference it.
- **T3** is building the orchestration-preview pane in the project drawer. The right-rail Guide panel and T3's preview pane both live in the dashboard; coordinate on z-index and which side of the screen each occupies. Preview pane is left/center, Guide is right rail. No overlap if both follow that layout split.
- **T4** is building the sprint runner UI. The Guide's "inject mandate" section should mention "or use the in-dashboard sprint runner (T4)" once T4 lands. T1 writes the section as if T4 exists; if T4 doesn't ship in this sprint, orchestrator strikes the line at close.

## Test plan

- Manual: open dashboard, expand right-rail. Search for "two-stage submit." Section is found, link works.
- Manual: focus a terminal panel; right-rail auto-expands "4+1 pattern" section.
- Read the Guide cold (pretend you're a new TermDeck user). Acceptance criterion #1: you understand how to run a 4+1 sprint without prior context.
- No automated tests required for the doc itself; lint with `bash scripts/lint-docs.sh` if it exists, otherwise spot-check links.

## Out of scope

- Don't build the `init --project` scaffolder — T2 owns that.
- Don't build the orchestration preview pane — T3 owns that.
- Don't build the sprint runner — T4 owns that.
- Don't migrate any global CLAUDE.md content out of `~/.claude/CLAUDE.md`. The Guide is a *reference*, not a *replacement*. Global rules stay where they are.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-37-orchestrator-product/STATUS.md` under `## T1`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
