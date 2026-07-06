# T2 — Rumen improvement + recall-feedback loop · Sprint 81
**Deck :3001 · cwd `~/Documents/Graciella/rumen` · Model Opus 4.8**

## Boot
1. `memory_recall(project="termdeck", query="Rumen synthesize confidence recall-feedback reinforcement recall_count doctrine-clean")` then `memory_recall(query="recent decisions and bugs")`
2. Read `~/.claude/CLAUDE.md` (+ rumen `CLAUDE.md` if present)
3. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-81-recall-reinjection-proof/PLANNING.md` — **your charter is § T2**
4. Read the sibling `STATUS.md`

## Your work
**THING 1 — synthesis quality (independent, DO FIRST):** `src/synthesize.ts` + `src/confidence.ts` + `tests/synthesize.test.ts`. Recalibrate `computeConfidence` (`:579`) against the RRF band 0.01–0.3 (currently `0.5*maxSim` is drowned by `crossProjectBonus`); down-rank near-duplicate "prior art"; enrich `buildUserPrompt` with recency/age + cross-project spread.

**THING 2 — recall-feedback loop (depends on T1's 032 `recall_boost` column):** new `src/reinforce.ts` + a `rumen-reinforce` Edge Fn (thin-wrapper like `doctrine-scan`). Window over `memory_recall_log` + denorm `recall_count`/`last_recalled_at` (**read the denorm rollup — raw rows purge at 90d**), compute a **smoothed EWMA/decayed reinforcement weight** per memory, write it to `memory_items.recall_boost` via T1's `set_recall_boost` RPC.
- **Stay doctrine-clean:** write ONLY the reinforcement weight (like `doctrine_registry.occurrence_count`). NEVER ranking content, NEVER mutate existing memory rows. Today the only sanctioned `memory_items` writer is `src/promote.ts` — document your new bounded write in `docs/MNESTRA-COMPATIBILITY.md § What Rumen writes`.
- Build on `cited` (auto-populated), NOT `rumen_insights.acted_upon` (manual/sparse).
- Extend `tests/fixtures/mnestra-minimal.sql` with `memory_recall_log` rows + `recall_count` so it's offline-unit-testable.

## Order / deps
THING 1 has no upstream. THING 2 needs T1's `recall_boost` column contract — **you will park** waiting for T1's `FIX-LANDED` on 032; ORCH nudges you. Coordinate the column/RPC shape with T1 via STATUS.md. Do NOT author engram migrations.

## Discipline
- Post `### [T2] VERB 2026-07-05 HH:MM ET — gist`. No version bumps / CHANGELOG / commits / publish.
- File-only; defer live SQL/Supabase to ORCH close-out. rumen → 0.8.0 (ORCH bumps).
