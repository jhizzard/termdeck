# Restart Prompt — TermDeck — 2026-04-27 13:15 ET

This file captures the state of the project so the next Claude Code session can pick up without losing context. Read it after the global + project CLAUDE.md, in the order described at the bottom.

## What just shipped (Sprint 35 — Reconciliation, v0.7.3)

**Live on npm at sprint close:**
- `@jhizzard/termdeck@0.7.3` (root)
- `@jhizzard/termdeck-stack@0.3.3` (audit-trail bump)
- `@jhizzard/mnestra@0.2.2` (unchanged)
- `@jhizzard/rumen@0.4.3` (unchanged)

**Origin commits pushed to `main`:**
- `c7cc5dc` — Sprint 35 release (4 lanes + packaging fix)
- `a2181ae` — close-out: stack-installer 0.3.3 audit-trail + docs engineering

**Lane-by-lane summary:**
- **T1** — `init --mnestra` defaults to `rag.enabled: false` (MCP-only mode). Wizard prints a 5-line "Setup mode: MCP-only (default)" block. `printNextSteps` restates it. File-header docstring, `--help`, and `printBanner` step 7 all rewritten to match.
- **T2** — Legacy RAG schema shipped as `008_legacy_rag_tables.sql` in `mnestra-migrations/`. `config/supabase-migration.sql` rewritten for idempotency: `CREATE EXTENSION IF NOT EXISTS pg_trgm` hoisted to top, all `CREATE INDEX` got `IF NOT EXISTS`, all `CREATE POLICY` got `DROP POLICY IF EXISTS` guards. `migration-runner.js` discovers via glob — no wiring change needed.
- **T3** — `termdeck doctor` extended with Supabase schema-check section + `--no-schema` flag. JSON output gained `schema` key. `pg_cron`/`pg_net` precondition hints now interpolate the user's project-specific Supabase dashboard URL when derivable.
- **T4** — Boot banner shows RAG state (CLI + direct-invoke coherent). Stale-port reclaim and transcript-table-missing hint ported from `scripts/start.sh`.
- **Packaging fix** — `config/transcript-migration.sql` added to root `package.json` `files` array. The runner's `fs.existsSync` guard had been silently skipping it on every fresh install since v0.6.8 (Brad's 2026-04-27 crash log surfaced it).

**Sprint 35 wall-clock:** ~17 minutes from kickoff (12:08 ET) to last lane DONE (T2 at 12:26). Orchestrator close-out 12:55 ET. Recovery from publish failure + docs engineering 12:55–13:15 ET.

## Meta-failures during close-out (lessons LOCKED IN)

The close-out itself surfaced three orchestrator failures. The fixes are now in three layers (memory + `docs/RELEASE.md` + project `CLAUDE.md`):

1. **Pushed before publishing.** Origin/main claimed v0.7.3 while npm still showed v0.7.2 for ~10 min. Convention: publish FIRST, push SECOND.
2. **Used `--otp=<code>` instead of `--auth-type=web`.** Joshua does NOT have an authenticator app for npm; `@jhizzard/*` publishes are Passkey-via-browser only. Three layers of redundancy now (memory entry, RELEASE.md "Authentication: Passkey, NOT OTP" section, CLAUDE.md hard rule).
3. **Forgot the stack-installer audit-trail bump.** Convention: every termdeck release gets a paired stack-installer patch bump even if the installer source is untouched.

Bonus issue: stale `_authToken` in `~/.npmrc` caused even `--auth-type=web` to fall back to OTP. Fix: `npm login --auth-type=web` first to refresh the token, then publish.

## Re-engineered CLAUDE.md system

The project `CLAUDE.md` was rewritten from 144 lines (mostly history + file map) to a 34-line ROUTER. It now points at:

- `docs/RELEASE.md` (NEW, 98 lines) — strict publish protocol with Passkey/auth-type=web rule, lessons-locked-in section
- `docs/ARCHITECTURE.md` (NEW, 124 lines) — extracted "Where code lives" + "Architecture decisions" + "Coding conventions" + "Known issues" + file map
- `~/.claude/CLAUDE.md` (global) — for 4+1 sprint mandate, never-copy-paste-messages rule, etc.
- Active sprint folders for in-flight work

The new short CLAUDE.md instructs the read order so future sessions get everything they need without re-reading 200 lines of architecture doc on every boot.

## What is planned next

### Sprint 36 — Launcher + UI parity (Phase B)
**Plan doc:** `docs/sprint-36-launcher-ui-parity/PLANNING.md`
**Target:** `@jhizzard/termdeck@0.8.0` (minor bump). Phase 0 dogfood gate at end — Joshua switches daily driver from `scripts/start.sh` to `npx @jhizzard/termdeck`.

Lanes:
- **T1** — Full `scripts/start.sh` parity in CLI (Mnestra autostart with secrets-reload-on-empty-store, MCP-config absence hint, Rumen last-job age check, full Step 1/4–4/4 choreography).
- **T2** — MCP config path drift fix. Migrate writes from `~/.claude/mcp.json` (legacy) to `~/.claude.json` (current Claude Code reads here).
- **T3** — Dashboard RAG toggle UI. New `PATCH /api/config` endpoint. Live-updates the boot banner state line (Sprint 35 T4 work).
- **T4** — Hook bundling. Stack-installer drops `~/.claude/hooks/memory-session-end.js` and merges the `Stop` hook block into `~/.claude/settings.json`. Idempotent. **Discovery from Sprint 35:** Joshua has only ONE hook (the user-global one) — no project-level hooks across his 10 `.claude/` directories. Simpler than expected.

**Two HIGH-priority bugs added to Sprint 36 / Phase B:**
- **Dashboard "dark veil"** — stuck modal/overlay blocks pointer events to xterm.js terminals. Both Joshua and Brad have hit it independently.
- **Hard-refresh kills server-side PTYs** — `Cmd+Shift+R` causes `/api/sessions` to drop to 0 immediately. WebSocket close handler is misinterpreting client-disconnect as session shutdown.

### Sprint 37 — Orchestrator-as-product (Phase C part 1)
**Plan doc:** `docs/sprint-37-orchestrator-product/PLANNING.md`
**Target:** `@jhizzard/termdeck@0.9.0`.

Make the orchestration patterns Joshua uses (4+1 sprint, CLAUDE.md hierarchies, project_facts.md, restart-prompt rituals) into a first-class shipped product feature.

Lanes:
- **T1** — Orchestrator Guide doc + dashboard right-rail surface (4+1 pattern, inject mandate, CLAUDE.md hierarchy, never-copy-paste, enforcement-vs-convention, project_facts.md / CONTRADICTIONS.md / restart-prompt patterns).
- **T2** — Per-project scaffolding generator (`termdeck init --project <name>` creates `CLAUDE.md`, `CONTRADICTIONS.md`, `project_facts.md`, `docs/orchestration/`, `RESTART-PROMPT.md` template, `.claude/settings.json` defaults).
- **T3** — Per-project orchestration document preview ("If you ran a 4+1 sprint here, here's what would be created"). Read-only preview before commit.
- **T4** — In-dashboard 4+1 sprint runner. UI to define lanes, kick off, tail STATUS.md. Should support **`--isolation=worktree`** opt-in (per Joshua's 2026-04-27 decision: worktree-based 4+1 sprint orchestration is the protocol going forward; saved as Sprint 37 design decision).

### Sprint 38 — Knowledge graph + visualization (Phase C part 2)
**Plan doc:** `docs/sprint-38-knowledge-graph/PLANNING.md`
**Target:** `@jhizzard/termdeck@0.10.0` (or v1.0.0 if polished).

Bring the dormant `memory_relationships` table to life as a Supabase-native knowledge graph layer.

Lanes:
- **T1** — Three new MCP tools: `memory_link(source_id, target_id, kind, weight?)`, `memory_unlink`, `memory_related(id, depth=2, kind=*)`. NEW migration `009_memory_relationship_metadata.sql`. NEW SQL function `expand_memory_neighborhood(id, max_depth)` using recursive CTE.
- **T2** — Background edge-inference cron (Rumen-extension). Pairwise cosine similarity in `memory_items` ≥ 0.85 → insert edges. Optional Haiku 4.5 LLM classification of edge types (`relates-to / contradicts / supersedes / blocks / inspired-by`). Per-edge `inferred_by: 'cron-2026-MM-DD'` for auditability.
- **T3** — `memory_recall_graph(query, project?, depth=2)` RPC. Vector recall → N-hop graph expansion → re-rank by `vector_score × edge_weight × recency_decay`. Update `rag.js` with `rag.graphRecall: true` config flag.
- **T4** — **D3.js v7** force-directed graph visualization in dashboard. Per-project view, per-memory neighborhood view, click-to-recall, edge-type filter, zoom/pan. D3 loaded from CDN to preserve zero-build-step. **Marketing-screenshot-worthy polish target** — visual impact for clicks.

**D3 was chosen over Cytoscape.js / vis-network / sigma.js / react-flow.** Reasoning in the Sprint 38 plan doc; key constraint was visual ceiling + vanilla-JS.

**Constraints:** Apache AGE ruled out (Supabase managed Postgres doesn't ship it). NO Obsidian. Pure pgvector + recursive CTEs + LLM-classified edges. Andrej Karpathy aesthetic without the Obsidian dependency.

## Backlog (Sprint 36+ candidate, not yet scoped)

- **PTY drag/drop window rearrangement** (Joshua's 2026-04-27 ask). Inject identifier is the session UUID, not visual position, so drag-reorder shouldn't break inject. Pure CSS Grid + drag-handle work in `packages/client/public/app.js`. Light lift.

## Brad-side context

- Brad's WhatsApp got a summary at 2026-04-27 12:30 ET: empty-pgvector ingestion gap is root-caused (rag.js writes to legacy tables Brad's Supabase doesn't have, plus he doesn't have Joshua's session-end hook). Fix lands when Sprint 36 ships and Brad re-runs `npx @jhizzard/termdeck-stack`.
- Brad's Structural360 Sprint 1 finalization on his `/opt/structural-mvp` box may still be in flight (T2/T3/T4 merge sequence). His orchestrator owns it; no Joshua action required.

## New principles locked in this session

1. **Build every project to ship from day one.** Personal-vs-product asymmetry is a recurring failure mode. Memorialize local settings/paths/hooks/scripts in the codebase from project inception. Saved as global preference.
2. **Worktree-based 4+1 sprint orchestration** is the going-forward protocol. Today's all-lanes-on-main pattern means orchestrator close-out has to manually verify cross-lane file stomping. Worktrees enforce lane discipline via git. Sprint 37 ships the dashboard support.
3. **Passkey, not OTP, for `@jhizzard/*` npm publishes.** Three-layer redundancy now in place. Run `npm login --auth-type=web` first to refresh stale tokens; then `npm publish --auth-type=web`.
4. **Short CLAUDE.md as router.** Identity + read-order + hard rules + current-state pointer. Detailed reference content extracted to `docs/RELEASE.md` and `docs/ARCHITECTURE.md`. The router stays cheap to load on every session.

## Open issues at session close

- Joshua's TermDeck dashboard had a "dark veil" overlay incident; he hard-refreshed and lost all four T1–T4 terminals (`/api/sessions` returned 0). PTYs are gone server-side, not just visually missing. Workaround: spawn fresh terminals from the dashboard.
- Pre-existing test failures in `packages/server/tests/session.test.js` (3 `Error detection` cases asserting `'errored'` but getting `'active'`). Reproducible against `HEAD` via stash-and-rerun. Last commit on file: v0.2.5. Flagged for a future analyzer-pattern fix sprint.
- `npm profile get` returns 403 — npm session may need refresh. Workflow: `npm login --auth-type=web` → re-auth via Passkey → publish flows work.

## Read order for the next session

(This section IS the restart prompt; see paste-ready block at the bottom of the email body.)

1. `memory_recall(project="termdeck", query="<topic Joshua signals>")` — always first.
2. `memory_recall(query="recent decisions and bugs across projects")` — broad recency sweep.
3. Read `~/.claude/CLAUDE.md` (global instructions).
4. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` (project router; very short — points at `docs/RELEASE.md`, `docs/ARCHITECTURE.md`, sprint-N folders).
5. Read THIS file (`RESTART-PROMPT-2026-04-27.md`).
6. If Joshua signals a specific topic, `memory_recall` with that topic.
7. Then begin.
