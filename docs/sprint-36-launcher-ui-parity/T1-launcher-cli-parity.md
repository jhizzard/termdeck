# Sprint 36 — T1: Full `scripts/start.sh` parity in CLI

**Lane goal:** Port the remaining personal-vs-product behaviors from `scripts/start.sh` into the published CLI, so `npx @jhizzard/termdeck` matches Joshua's `./scripts/start.sh` step for step. After this lane lands, `scripts/start.sh` becomes a 5-line wrapper around `node packages/cli/src/index.js` (or it gets deleted — orchestrator decides at sprint close).

**Target deliverable:** A user running `npx @jhizzard/termdeck` on a fresh machine sees the same Step-1/4 → Step-4/4 boot choreography Joshua sees on his box, with all the same hints, same status indicators, same env-var nudges.

## What `scripts/start.sh` does that the CLI doesn't (yet)

Read `scripts/start.sh` end-to-end before touching code. The five behaviors that need porting:

1. **Mnestra autostart with secrets-reload-on-empty-store** (`scripts/start.sh:156–276`)
   - Detects whether Mnestra MCP is reachable; if not, starts it.
   - On empty pgvector store, reloads secrets (Supabase URL/key from env) and retries connection.
   - Why: fresh installs frequently hit a "configured but ingestion never happened" state. Reload-on-empty closes that gap automatically.

2. **MCP-config absence hint** (`scripts/start.sh:278–284`)
   - If `~/.claude.json` (or legacy `~/.claude/mcp.json`) has no Mnestra entry, print a clean hint: "TermDeck doesn't see Mnestra wired in Claude Code yet. Run `npx @jhizzard/termdeck-stack` to install."
   - Coordinate with **T2** (MCP path drift) — the path the CLI reads from must match the path T2 standardizes on.

3. **Rumen last-job age check** (`scripts/start.sh:286–307`)
   - Query Rumen Supabase Edge Function for last job timestamp. If > 24h, print "Rumen hasn't run in N days. Trigger one with `npx @jhizzard/rumen run`."
   - Non-blocking. Hint only.

4. **Step-1/4 through Step-4/4 launcher choreography**
   - Sprint 35 T4 added the boot banner with RAG state line + port reclaim + transcript-table hint. Extend that, do NOT replace.
   - Steps Joshua's start.sh shows:
     - Step 1/4 — Environment check (Node version, npm, env vars present)
     - Step 2/4 — Mnestra MCP reachability + autostart
     - Step 3/4 — Rumen last-job age + Supabase reachability
     - Step 4/4 — Server start (port reclaim if stale, transcript table check, RAG state line)

5. **Preserve Sprint 35 T4 work.** Do not regress: RAG state line, port reclaim logic, transcript-table-missing hint. These already live in `packages/cli/src/index.js`. Build on top.

## Primary files

- `packages/cli/src/index.js` — main entry. Boot choreography lives here.
- NEW (or extend existing) `packages/cli/src/stack.js` — helpers for MCP detection + Mnestra reachability + Rumen last-job age. If `stack.js` already exists, extend it; do not duplicate.
- READ-ONLY (for reference): `scripts/start.sh`, Sprint 35 T4 deliverables in `docs/sprint-35-reconciliation/T4-*.md` (banner state line context).

## Coordination notes

- **Hint-text coordination with Sprint 35 T3 (`termdeck doctor`).** The hints you print should match `doctor`'s wording. Don't say "Mnestra isn't reachable" in the launcher and "Mnestra MCP not connected" in `doctor`. Pick the doctor wording (it's already shipped) and mirror.
- **MCP path coordination with T2.** The path you READ for the absence hint must be the path T2 STANDARDIZES on. If T2 lands first, mirror their constant. If you land first, expose a constant T2 can import.

## Test plan

- Manual: fresh shell, `npx @jhizzard/termdeck` (or `node packages/cli/src/index.js` from worktree). All four steps print. Mnestra autostart works on empty store. Hints appear when expected.
- Diff against `scripts/start.sh` output side-by-side. Any visible difference is a regression unless explicitly justified.
- No new tests required for the start.sh-parity work itself (it's interactive boot output), but if you extract reusable functions (e.g., `getMnestraStatus()`), add unit tests.

## Out of scope

- Don't touch the dashboard UI. T3 owns dashboard.
- Don't touch hook bundling. T4 owns that.
- Don't migrate MCP path writes. T2 owns that.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-36-launcher-ui-parity/STATUS.md` under `## T1`. No version bumps. No commits. Stay in your lane.
