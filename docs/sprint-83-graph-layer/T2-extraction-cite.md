# T2 — Write-time extraction + the label producer's client side

**Working dirs:** `~/Documents/Graciella/engram` (TS only — T1 owns ALL SQL) and `~/Documents/Graciella/rumen` where the capture-ingest path lives. No termdeck code.

## The problems you are fixing

1. Memories are written flat: no entities, no typed triples, no problem classification — the graph only ever gets nightly cosine-similarity edges. Write-time is where the semantic knowledge exists and is cheapest to extract.
2. The label channel has no producer on the dominant path: ordinary `memory_recall` returns content inline and nothing ever cites. Sprint 82 T3's F1: 39k telemetry rows, ZERO real positives — `fit-platt.ts` refuses to fit (correctly). Everything data-driven is blocked on you.

## Deliverables

1. **Write-time extraction** on `memory_remember` and the capture-ingest path (`ingest_capture` — locate the canonical entry in engram/rumen and name it in your first FINDING):
   - Haiku extraction of entities + typed triples, predicates STRICTLY within T1's frozen vocabulary (I1). Anything out-of-vocabulary maps to `relates_to` or is dropped — never invent a predicate, never let a DB constraint rejection bubble.
   - Entity linking: light resolution at write time (normalize + exact/near match against existing entities); deep resolution belongs to T3's consolidation, not you.
   - **Fail-open, non-negotiable:** an extraction failure (no API key, timeout, budget exhausted, 034 absent) NEVER fails or delays the write beyond a tight budget. Follow the rumen budget-isolation pattern; feature-detect the 034 surface (the Sprint 82 404-capability-latch precedent).
2. **`problem_signature`** on solved-problem-class writes (`bug_fix` source_type; note the Sprint 82 finding that `debugging` is a Category, not a legal source_type — key off what is actually writable): `metadata.problem_signature` seeded from the 5 `err-*` classes in termdeck `doctrine/registry.jsonl` + a normalized free-form fallback. Post the exact shape (field path, format, examples) in your first FINDING — that is interface I3; T3 matches against exactly it.
3. **The label producer (headline deliverable):**
   - Recall output carries `recall_group_id` end-to-end (031 stamps it server-side; thread it through `src/recall.ts` / `src/layered.ts` / `src/webhook-server.ts` result shapes — additive fields only).
   - New MCP tool **`memory_cite`** (id or recall_group_id + memory ids) calling T1's citation RPC (I5). Tool description written so an agent naturally calls it when a recalled memory actually informed its work.
   - A paste-ready CLAUDE.md cite-on-use snippet (deliverable text in your FIX-LANDED post, NOT applied to `~/.claude/CLAUDE.md` — ORCH installs at close).
   - Weigh the candidate designs from PLANNING §Why-3 (cite tool + mandate; hook-side reuse detection; recall-group follow-up correlation) and record in one FINDING why you chose what you chose. **The acceptance bar is REAL positive labels flowing from ordinary CLI recall usage.**
4. **Tests:** engram + rumen suites green; a DB-backed round-trip test proving recall → `memory_cite` → positive label visible to the fit-platt query; fail-open tests (extractor killed / no key / pre-034 DB → write still succeeds, no edges, no crash).

## Interfaces

- **I2:** any schema need → `### [T2] FINDING … SCHEMA-REQUEST` within the first 30 min; T1 owns the SQL.
- **I3:** post the `problem_signature` shape early — T3 is coding against it.
- **I5:** consume T1's citation RPC exactly as posted in SCHEMA-READY; feature-detect its absence.
- Wait for `^(### )?\[T1\] SCHEMA-READY\b` before landing anything that touches the RPC or edge writes; extraction scaffolding and tests can proceed before it.

## Boot + discipline

Boot: `memory_recall(project="termdeck", query="Sprint 83 label producer memory_cite recall_group_id")`, `memory_recall(query="write-time entity extraction predicate vocabulary fail-open budget")`, read `~/.claude/CLAUDE.md`, `./CLAUDE.md` (termdeck repo), this sprint's `PLANNING.md` + `STATUS.md`, then this brief. Stay in lane. Post `### [T2] <VERB> <ET timestamp> — <gist>`. No version bumps, no CHANGELOG, no commits, no migrations, no live-DB writes.
