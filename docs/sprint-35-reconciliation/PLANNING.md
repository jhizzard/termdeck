# Sprint 35 — Reconciliation (v0.7.3 hotfix)

**Sprint kicked off:** 2026-04-27 12:08 ET

## Goal

Make the published TermDeck install experience match what Joshua actually runs daily, with **MCP-only as the default RAG mode** and a clear opt-in path to full RAG via the dashboard.

## Why now

Brad's overnight crash (2026-04-27, /opt/structural-mvp box) revealed an asymmetry that's been latent for months:

- **Joshua's box:** `~/.termdeck/config.yaml` has `rag.enabled: false`. He runs in MCP-only mode — Mnestra's `memory_items` table is filled by Claude Code's `memory_remember` calls and his personal `~/.claude/hooks/memory-session-end.js`. He has never exercised the `rag.js` → legacy-table write path.
- **Fresh installer's box:** `termdeck init --mnestra` writes `rag.enabled: true` (init-mnestra.js:414–417). The first session event triggers `rag.js` to push to `mnestra_session_memory` / `mnestra_project_memory` / `mnestra_developer_memory` / `mnestra_commands` — tables defined in `config/supabase-migration.sql` ("Legacy v0.1 — kept for reference") but **never auto-applied by any init path**. Result: 404 cascade, circuit breaker opens, all RAG silently drops.

This sprint fixes the asymmetry from both ends: change the default mode to match Joshua's, and ship the legacy schema as a real migration so the opt-in path also works.

## Sprint output

- **`@jhizzard/termdeck` 0.7.3** (orchestrator publishes at sprint close)
- No stack-installer bump expected unless T3's doctor command warrants

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1** | Flip init wizard default to `rag.enabled: false`; add MCP-only-as-default messaging in the wizard and final summary | `packages/cli/src/init-mnestra.js` |
| **T2** | Convert `config/supabase-migration.sql` into shipped migration `008_legacy_rag_tables.sql`; ensure idempotency; wire into runner | `packages/server/src/setup/mnestra-migrations/`, `packages/server/src/setup/migration-runner.js`, `config/supabase-migration.sql`, `CLAUDE.md` (file-map line) |
| **T3** | `pg_cron`/`pg_net` precondition checks in `init --rumen` with dashboard link; NEW `termdeck doctor` diagnostic command | `packages/cli/src/init-rumen.js`, `packages/server/src/setup/preconditions.js`, NEW `packages/cli/src/doctor.js`, `packages/cli/src/index.js` (subcommand registration only) |
| **T4** | Boot banner shows RAG state; port stale-port reclaim + transcript-table-missing hint from `scripts/start.sh` | `packages/cli/src/index.js` (banner area, port reclaim, hints), `packages/server/src/index.js` (banner region only) |

The fifth role (orchestrator) writes planning docs, watches `STATUS.md`, coordinates lane handoffs, and at sprint close handles the version bump, CHANGELOG, commit, and publish.

## Out of scope (deferred to later phases)

**Phase B / Sprint 36** — full launcher parity + product UI:
- Bundling `~/.claude/hooks/` into the stack-installer payload (memory-session-end + any project-level hooks discovered)
- MCP config path drift fix (`~/.claude.json` vs `~/.claude/mcp.json`)
- Dashboard RAG toggle UI (the user-facing half of MCP-only-as-default)
- Mnestra autostart, secrets-reload-on-empty, MCP-config-hint parity from `scripts/start.sh`

**Phase C / Sprint 37+** — orchestrator-as-product:
- Orchestrator Guide (docs + interactive in-dashboard surface)
- Per-project scaffolding (`CLAUDE.md`, `CONTRADICTIONS.md`, `project_facts.md`, `docs/sprint-N-<name>/` skeletons)
- Per-project orchestration document preview ("here's what running a 4+1 sprint will create")
- Knowledge graph layer for Mnestra (Supabase-resident; no Obsidian dependency)

**Backlog**:
- PTY drag/drop window rearrangement in dashboard

## Acceptance criteria

A user running `npx @jhizzard/termdeck-stack` then `termdeck init --mnestra --yes` against a fresh Supabase project ends up with:

1. `~/.termdeck/config.yaml` containing `rag: { enabled: false, ... }`
2. All Mnestra migrations applied: 001–007 + new 008 (legacy RAG schema) + transcript-migration.sql
3. A wizard final summary explaining MCP-only default and the dashboard toggle path
4. `termdeck` boots with a banner line showing RAG state
5. `termdeck init --rumen` against a project without `pg_cron` / `pg_net` enabled produces a hard-stop precondition error with a dashboard link, NOT silent failure
6. `termdeck doctor` runs and reports install-state with no edits made

## Sprint contract

- Each lane: post **FINDING / FIX-PROPOSED / DONE** entries (append-only) to `STATUS.md`
- **Stay in your lane** — do not edit files outside your declared file list
- **No version bumps, no CHANGELOG edits, no commits** — orchestrator does at sprint close
- Test each change locally before posting DONE
- If you find a blocker that requires another lane's work, post a FINDING and tag the other lane (e.g., `[T4 FINDING] hint copy references termdeck doctor — depends on T3 DONE`)

## Versioning + publishing (orchestrator-only)

At sprint close, orchestrator:
1. Bumps `packages/cli/package.json`, `packages/server/package.json`, `packages/client/package.json`, root `package.json` to 0.7.3
2. Drafts CHANGELOG.md `[0.7.3]` block summarizing all four lanes
3. Commits with one logical commit per lane (or one bundled commit, depending on diff size)
4. Publishes `@jhizzard/termdeck@0.7.3`
5. Updates the running TermDeck on Joshua's box to verify upgrade path works for an existing user (Joshua's box becomes the first dogfood test)
