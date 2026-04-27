# Sprint 38 — Knowledge graph + visualization (Phase C part 2)

**Status:** Planned. Kickoff after Sprint 37 ships.
**Target version:** `@jhizzard/termdeck` v0.10.0 (or v1.0.0 if the surface lands polished — Joshua's call at sprint close).
**Mnestra package bump:** likely v0.3.0 (new MCP tools = breaking-or-additive feature).

## Goal

Bring the dormant `memory_relationships` table to life as a Supabase-native knowledge graph layer. Add edge-inference automation, graph-aware recall, and a **D3.js**-based interactive visualization that's both functionally useful and visually compelling for marketing screenshots.

Constraints (from Joshua, 2026-04-27):
- **Supabase-resident only.** No Obsidian. No external graph DB. No Apache AGE (not in Supabase managed extension list).
- **Karpathy aesthetic without the Obsidian dependency** — connect related memories across projects, live-search the graph during agent execution.
- **Visual impact matters** — the graph view doubles as marketing material. Worth investing in polish.

## Why now

After Sprints 35–37, TermDeck has plumbing parity, hooks bundled, and orchestration patterns shipped. The next-level value is helping users *see* their accumulated context — not just recall by query, but explore by relationship. The `memory_relationships` table has been shipped since v0.1 (`packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql`) and is doing nothing. Time to bring it to life.

## Orchestrator pre-sprint task — Brad's bundled-hook Mnestra-direct rewrite (P0)

**STATUS — DONE 2026-04-27 17:55 ET (orchestrator-applied during Sprint 37 close-out window while npm publish was blocked by an outage).** The rewrite landed at `packages/stack-installer/assets/hooks/memory-session-end.js` (~225 LOC including module-export contract for testability), `packages/stack-installer/assets/hooks/README.md` rewritten end-to-end, and `tests/stack-installer-hook-merge.test.js` extended with 22 new test cases covering env-var read, transcript-summary extraction, OpenAI call signature, Supabase POST shape, and end-to-end stdin payload processing — 49/49 tests pass. PROJECT_MAP defaults to empty (deliberate — fresh users add their own entries; previously hardcoded with Joshua-specific mappings). Module export contract: when `require.main === module`, runs as a hook (reads stdin); when imported, exposes `detectProject / readEnv / buildSummary / embedText / postMemoryItem / processStdinPayload / PROJECT_MAP / LOG_FILE` for tests. Ready for Sprint 38 cohort kickoff.

**Original framing (folded in 2026-04-27 16:55 ET per Joshua's call):** This is a release-quality deliverable that ships as part of v0.10.0/v1.0.0 alongside the graph work, but it is NOT one of the 4+1 lanes — orchestrator applies it directly before kickoff (single-track, ~120 LOC), so the lane structure stays 4+1 and the lanes ship in parallel as designed.

**Why P0:** Brad is the only outside TermDeck user besides Joshua. v0.8.0 ships a bundled `~/.claude/hooks/memory-session-end.js` that delegates to `~/Documents/Graciella/rag-system/src/scripts/process-session.ts` — Joshua's private repo. Fresh users (i.e., Brad) get a hook that runs but silent-fails because `rag-system` doesn't exist on their box. Net effect: Brad's `pgvector` stays at 0 memories despite MCP wired and webhook bridge alive. See `docs/BACKLOG.md` § P0 for full context.

**Scope:** rewrite `packages/stack-installer/assets/hooks/memory-session-end.js` to call OpenAI embeddings + Supabase REST `/rest/v1/memory_items` directly — no `rag-system` dependency. Brad's working workaround at `/tmp/brad-mnestra-hook.js` (~120 LOC, sent via WhatsApp 2026-04-27 15:30 ET) is the canonical reference; bring it home with three adjustments:

1. Generalize the project-detection map (Brad's workaround has only `structural360`; the bundled version should ship with a sensible default + extension instructions in the README).
2. Fail-soft logging (already present in the workaround) — preserve.
3. Env-var validation (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENAI_API_KEY`) at hook entry; clear log message if missing.

**Test additions:** extend `tests/stack-installer-hook-merge.test.js` to verify the new hook's structure (env-var read, transcript-summary extraction, OpenAI call signature, Supabase POST shape). Mock `fetch` at module boundary; no live network calls in tests.

**Validation gate:** Brad re-runs `npx @jhizzard/termdeck-stack` against his structural-mvp box; confirms a row lands in `memory_items` after the next Claude Code session close. Joshua confirms his daily-driver flow still works (his existing `~/.claude/hooks/memory-session-end.js` writes to `rag-system` and shouldn't be replaced — the bundled version is what new installs get; Joshua's existing personal hook is independent).

**Release timing:** orchestrator applies this before kicking off the 4+1 graph lanes, OR concurrent with T1's first phase. The 4+1 lanes don't depend on it — independent deliverable. At sprint close, both the hook rewrite and the graph work ship as v0.10.0 (or v1.0.0) in a single coordinated release.

**Acceptance criterion (added):** A fresh user running `npx @jhizzard/termdeck-stack` without `rag-system` on their box gets a working session-end ingestion path that fills `memory_items`. Verified end-to-end against Brad's box.

---

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Mnestra graph MCP tools + traversal RPC** | Three new MCP tools on the Mnestra package: `memory_link(source_id, target_id, kind, weight?)`, `memory_unlink(source_id, target_id)`, `memory_related(id, depth=2, kind=*)`. NEW migration `009_memory_relationship_metadata.sql` adds `weight`, `inferred_at`, `inferred_by`, `kind` columns if not already present. NEW SQL function `expand_memory_neighborhood(id uuid, max_depth int)` using a recursive CTE. | `~/Documents/Graciella/engram/src/tools/memory_link.ts` (NEW), `memory_unlink.ts` (NEW), `memory_related.ts` (NEW), Mnestra MCP server export, NEW `packages/server/src/setup/mnestra-migrations/009_memory_relationship_metadata.sql` |
| **T2 — Edge-inference cron job** | Background process (Rumen-extension OR new Mnestra-side cron) that runs nightly: pairwise cosine similarity in `memory_items` above a threshold (e.g., 0.85), inserts/updates edges in `memory_relationships`. Optionally classifies edge types via Haiku 4.5 LLM call (`relates-to / contradicts / supersedes / blocks / inspired-by / cross-project-link`). Per-edge `inferred_by: 'cron-2026-MM-DD'` for auditability + replay. Coverage stats endpoint (`GET /api/graph/stats`). | NEW `packages/server/src/setup/rumen/migrations/003_graph_inference_schedule.sql`, NEW Edge Function (Deno) for the inference logic, scheduling via existing pg_cron infrastructure |
| **T3 — Graph-aware recall** | NEW `memory_recall_graph(query, project?, depth=2)` RPC + Mnestra MCP tool. Runs vector recall (existing `match_memories`), expands top-K through `memory_relationships` to depth N, re-ranks the union by combined signal: `final_score = vector_score × edge_weight × recency_decay`. Update `rag.js` to optionally route via graph-recall (config flag `rag.graphRecall: true`). Update `preflight.js` to add a graph-health check (edge count, last inference run). | Mnestra package (RPC + new MCP tool), `packages/server/src/rag.js`, `packages/server/src/preflight.js` |
| **T4 — D3.js graph visualization** | Force-directed graph in dashboard. **Per-project view** (all memories tagged with project + their edges). **Per-memory neighborhood view** (one node + N-hop expansion). Interactions: click node → opens memory drawer with content; click edge → shows kind + weight; edge-type filter (toggle relates-to / contradicts / inspired-by); zoom/pan; color-coded by project; node size by recency × edge degree. D3 v7 loaded from CDN (jsdelivr) to preserve zero-build-step. **Polish target: marketing-screenshot-worthy.** | NEW `packages/client/public/graph.html` (dedicated page) AND a new `Graph` tab in `app.js` for in-app navigation, NEW `packages/client/public/graph.js`, additions to `packages/client/public/style.css`, `packages/server/src/index.js` (NEW `/api/graph/project/:name`, `/api/graph/memory/:id`, `/api/graph/stats`) |

## D3.js choice (Joshua wrote "D4.js" — assumed typo)

Alternatives considered:
- **D3.js v7** ✅ — most flexible, lowest-level, best polish ceiling. Force-directed via `d3-force`. Highest dev cost but matches the visual-impact-for-marketing angle. Single `<script>` tag from CDN. Vanilla JS-friendly.
- **Cytoscape.js** — purpose-built for graphs, less custom code, fewer marketing fireworks. Good engineering choice if marketing weight is low.
- **vis-network** — quick to set up, decent defaults, lower aesthetic ceiling.
- **sigma.js** — best for very large graphs (10k+ nodes), canvas/WebGL. Overkill for memory counts in the low thousands.
- **react-flow** ❌ — requires React; TermDeck is vanilla JS.

**Recommendation: D3.js v7.** The click-bait visual aesthetic Joshua referenced (Karpathy-vibe note graphs, Obsidian-style network views) is canonically a D3 force-directed look. More dev time than Cytoscape, but the polish ceiling is the deciding factor. Single CDN script tag preserves zero-build-step.

## Out of scope (future sprints)

- Realtime collaboration on the graph (multi-user editing)
- Graph version history beyond `inferred_by` audit column
- Other visualization modes (matrix, hierarchy, sankey) — only force-directed this sprint
- Edge inference for memories outside `memory_items` (legacy `mnestra_*_memory` tables, transcripts)
- Cross-Mnestra-instance graph federation

## Open design questions

1. **Edge weight semantics.** Cosine similarity 0–1, normalized? LLM-classified types get a `confidence` score? Pick a single normalized [0,1] weight per edge with optional `confidence_breakdown` JSONB.
2. **Inference threshold.** Cosine similarity ≥ 0.85? ≥ 0.80? Tunable per-deployment via config? Default 0.85, expose as `rag.graphInferenceThreshold` config setting.
3. **Edge classifier prompt.** What's the LLM prompt that turns "these two memories are similar" into "this is a `contradicts` edge"? Needs prompt design — see prior art in Rumen extract phase.
4. **D3 graph paint approach.** SVG (DOM-based, easier to interact with, slow above ~5k nodes) or Canvas (faster, harder click-handling)? Default SVG for the marketing aesthetic and dev simplicity; revisit if perf hits a wall.
5. **Should the graph view show Rumen insights as nodes too?** Probably yes — `rumen_insights` rows are first-class context. Means edges flow between `memory_items` and `rumen_insights`. May need a unified node type or composite endpoint.

## Acceptance criteria

1. `memory_link` / `memory_unlink` / `memory_related` MCP tools work from Claude Code in Joshua's daily flow.
2. Nightly inference cron creates edges; coverage statistic visible (e.g., "X edges across Y memories"). Re-runnable manually.
3. `memory_recall_graph` returns expanded neighborhood, re-ranked. `rag.js` graph-recall flag works end-to-end.
4. Dashboard `/graph` view loads in <2s for a project with up to 500 memories.
5. Click-to-recall works: click a node → drawer opens with memory content + immediate-neighbor previews.
6. Edge-type filter functional: toggle a type off → those edges fade out (not just hidden — animate).
7. **Marketing gate:** screenshots of the graph view are good enough to ship in a tweet announcing v0.10.0/v1.0.0 without polishing in Figma first.

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.

## Dependencies on prior sprints

- Sprints 35–36 must ship (install path solid).
- Sprint 37 (orchestrator-as-product) is independent — Sprint 38 could in theory ship before 37 if Joshua reorders priority. But the right product narrative is plumbing → orchestration → graph.
- Mnestra MCP server (`@jhizzard/mnestra`) needs a minor version bump and republish — coordinate with sprint 38 release.
