# T3 — Typed expansion in error recall + consolidation + Obsidian read-only export

**Working dirs:** `~/Documents/Graciella/rumen` (consolidation edge fn) + `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` (flashback wiring, exporter). engram is read-only reference for you — ALL SQL goes to T1 via SCHEMA-REQUEST (I4).

## The problems you are fixing

The graph is written nightly and read ~never: `memory_recall_graph` (migration 010) has 2 recorded uses ever. "You solved something structurally similar before" never fires, because nothing at recall time walks the edges. And nothing surfaces commonalities BETWEEN solved problems — the consolidation/community layer doesn't exist. Sprint 82 gave you the entry points: the flashback path embeds the matched error line, is threshold-gated on `semantic_similarity`, and `p_decay_profile='solved-problem'` exists.

## Deliverables

1. **Recall-side typed expansion (1–2 hops) in the error-recall/flashback path** (termdeck `packages/server` — the flashback/proactive pipeline Sprint 82 T2 just overhauled; find the seam where hits return and expand there, server-side):
   - On an error-triggered recall whose top hits include solved-problem-class memories (use T2's `problem_signature` shape, I3, when present; fall back to source_type), call the typed-expansion SQL (I4 — request it from T1 in the first 30 min; 010 predates temporal validity, so you almost certainly need an upgraded function) restricted to `caused_by`/`fixed_by`/`supersedes`/`same_pattern_as` predicates and LIVE edges only.
   - Surface the expansion additively: the fix memory rides along marked as graph-derived (edge type + hop count in the payload), it never displaces or re-scores the hybrid ranking, and the whole step is feature-detected (pre-034 DB → exactly current behavior) and budget-bounded (strict hop/row caps, no recursion beyond 2).
   - **Expansion never writes.** Not an edge, not a row, not a counter. Read-only by construction.
2. **Consolidation job** (rumen — extend `supabase/functions/graph-inference/` or a sibling function; budget-isolated per the rumen pattern; runnable manually, cron-ready but NOT scheduled this sprint — ORCH schedules at close if ratified):
   - Entity resolution (merge duplicate entities the write-time extractor produced — merging ENTITY records only, never memories).
   - Community detection over live edges (connected components is adequate at 9k scale; note the option of Leiden later, don't build it).
   - One LLM-written community-summary memory per qualifying community — THIS is the "commonalities between solved problems" surfacing. Provenance-marked (metadata identifying it as a consolidation product + member ids + generation date) so it can never impersonate a primary memory; idempotent re-runs (re-summarize, don't duplicate).
   - **Consolidation writes ONLY new summary memories, new edges, and entity-record merges — it never mutates or deletes canonical memory content.**
3. **Obsidian vault exporter** (termdeck CLI surface, e.g. `termdeck vault export <dir>`): one md file per memory, wikilinks rendered from typed LIVE edges, edge type + validity + provenance in frontmatter; deterministic filenames; regenerate-on-demand (nightly-able — document the cron line, don't install it). **READ-ONLY projection: no import path, never a second source of truth** — say so in the generated vault's README.
4. **Tests:** green in both repos. Must include: expansion read-only proof (no write statements on the path — assert via the query log or code inspection test), feature-detection (pre-034 → current behavior byte-for-byte), consolidation idempotency + provenance, exporter golden-file test on a seeded fixture.

## Interfaces

- **I4:** post `### [T3] FINDING … SCHEMA-REQUEST` for the expansion SQL within the first 30 min — exact desired signature, predicates, hop semantics. T1 ships it in 034.
- **I3:** consume T2's `problem_signature` shape exactly as posted; feature-detect its absence.
- Wait for `^(### )?\[T1\] SCHEMA-READY\b` before wiring the expansion call; consolidation and exporter scaffolding can proceed before it.

## Boot + discipline

Boot: `memory_recall(project="termdeck", query="Sprint 83 graph expansion flashback solved problem recall")`, `memory_recall(query="community detection consolidation summary memories budget isolation")`, read `~/.claude/CLAUDE.md`, `./CLAUDE.md` (termdeck repo), this sprint's `PLANNING.md` + `STATUS.md`, then this brief. Stay in lane. Post `### [T3] <VERB> <ET timestamp> — <gist>`. No version bumps, no CHANGELOG, no commits, no migrations, no live-DB writes (read-only ground-truthing allowed).
