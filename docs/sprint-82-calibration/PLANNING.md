# Sprint 82 — Calibration & Solved-Problem Recall

**Dispatched:** 2026-07-30 ~20:00 ET · 3+1+1 on :3001 · ORCH = long-running orchestrator session
**Context:** Activation Day (2026-07-30) deployed rumen-reinforce / doctrine-scan / inbox-promote and enabled the web-propose channel (supervised). This sprint fixes the *scoring* layer those loops feed on.

## Why (the audit findings this sprint answers)

1. **RRF scores are ordinal, not cardinal.** `memory_hybrid_search` (owner: engram `migrations/032_recall_boost.sql:158-298`) fuses `1/(60+rank)` per branch: base ceiling `2/61 ≈ 0.0328`, ×1.5 type ×1.5 project = **0.074 hard max**. Live telemetry (~38.8k rows in `memory_recall_log`): p50 0.0216, max 0.074 — matches theory exactly. No weight tuning can calibrate an ordinal score.
2. **The function full-scans both branches** — neither the FTS GIN index nor the HNSW vector index is used (BACKLOG §A, verified 2026-07-06). Prime suspect for the 2026-07-28 recall statement timeouts.
3. **The cosine similarity is computed and thrown away** (candidates CTE, `032:196`) — the one absolute signal we already have.
4. **Flashbacks fire ungated:** no score threshold anywhere; query = raw `"<type> error <lastCommand> <tail>"` PTY noise; a toast that times out after 30 s is **permanently blacklisted globally** (timeout conflated with user dismissal — the useful pool drains monotonically); UI renders the RRF composite ×100 as a "similarity %" (a good hit displays "2%" — caused a false store-health alarm once already).
5. **`bug_fix`/`debugging` memories get a 30-day recency half-life** (`032:250-251`) — a six-month-old solved problem is multiplied by ~0.14, buried exactly when it's most valuable.
6. **Rumen's normalizer assumes an RRF ceiling of 0.3** (`rumen/src/confidence.ts:26-47`); the real deployed ceiling is ~0.075, so normalized confidence tops out ≈0.22.

## Lanes

| Lane | Owner | Scope | Brief |
|---|---|---|---|
| T1 | Claude worker | engram migration 033: two-phase top-k rewrite + `semantic_similarity` column + `p_decay_profile` param + grant/RLS re-pin + vendored copy | `T1-hybrid-search-033.md` |
| T2 | Claude worker | TermDeck Flashback hygiene: threshold, query construction, expired-vs-dismissed split + TTL, UI label | `T2-flashback-hygiene.md` |
| T3 | Claude worker | Rumen confidence ceiling fix + Platt-calibration fit on live telemetry + calibrated score surfaced in recall output | `T3-confidence-calibration.md` |
| T4 | Codex auditor | Adversarial verification of all three, CHECKPOINT discipline, FINAL-VERDICT | `T4-codex-auditor.md` |

## Cross-lane interfaces (the contract — do not drift)

- **I1 (T1 → T2, T3):** migration 033 keeps the existing `memory_hybrid_search` signature backward-compatible (all new params defaulted) and adds:
  - `semantic_similarity double precision` to RETURNS TABLE (raw `1 - (embedding <=> query_embedding)` of the returned row; NULL only if no query embedding).
  - `p_decay_profile text DEFAULT 'standard'` — `'standard'` = today's half-lives; `'solved-problem'` = `bug_fix`/`debugging` half-life flattened to 365d (other types unchanged).
  T1 posts `### [T1] SCHEMA-READY <date> — <exact signature>` to STATUS.md the moment the signature is frozen (before tests finish) so T2/T3 can code against it.
- **I2 (T2 → T1):** if the expired-vs-dismissed split needs ANY SQL schema change (e.g. a column on the flashback-events store), T2 posts `### [T2] FINDING … SCHEMA-REQUEST` within the first 30 min and T1 owns the SQL inside 033. T2 never writes migrations.
- **I3 (T3 → T2):** T3's calibration constants land in `engram/src/calibration.ts` (exported constants + `calibrateScore()`); recall output gains additive field `score_calibrated`. T2's UI consumes `semantic_similarity` (I1) directly this sprint — NOT `score_calibrated` — to avoid a hard T3 dependency.

## Non-goals (do not touch)

- No graph/edge-expansion work (that's Sprint 83). No entity extraction. No Obsidian export.
- No changes to `smartRank`'s type-first display ordering (documented risk: a calibrated score displayed next to type-first ordering can look mis-sorted — T2 labels the UI value as "match" quality, not rank).
- No version bumps, no CHANGELOG edits, no commits, no `npm publish`, no live migration apply — **ORCH owns all of those at close** (RELEASE.md discipline).
- Web-propose / inbox machinery: hands off (activated today, supervised).

## Acceptance

- T1: EXPLAIN ANALYZE evidence that BOTH the FTS GIN and HNSW indexes are used by the rewritten function; all existing callers (`src/recall.ts:141-150`, `src/search.ts:27-36`, `src/layered.ts:104-113`) pass unmodified-call-shape tests; five RLS hygiene gates hold; vendored migration byte-identical.
- T2: error-triggered flashback uses the matched error line; sub-threshold hits suppress the toast (feature-detected); an unattended timeout no longer permanently blacklists; dismissed entries expire (TTL 14d); UI never renders an RRF composite as a percentage.
- T3: `npm test` green in rumen with recalibrated ceiling; a committed calibration report (fit metrics, coefficients, n) + `calibration.ts` constants; `score_calibrated` present in recall output when constants exist, absent otherwise.
- T4: AUDIT-PASS per lane with file:line evidence, or AUDIT-FAIL with reproduction; FINAL-VERDICT posted.

## STATUS.md discipline (all lanes)

Post shape, exactly: `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
Verbs: FINDING · FIX-PROPOSED · FIX-LANDED · SCHEMA-READY · SCHEMA-REQUEST · BLOCKED · CHECKPOINT · AUDIT-PASS · AUDIT-FAIL · FINAL-VERDICT · DONE.
Waiting on another lane? Poll STATUS.md with the tolerant regex `^(### )?\[T<n>\] DONE\b` (or the verb you need) — never a brittle exact-prefix match. Parked lanes will be nudged by ORCH; end your turn cleanly with your state posted.

## Resolution (2026-07-30)

**FINAL-VERDICT-4 GREEN at 21:01 ET** — after three RED cycles (20:31, 20:43, 20:49), ~60 min inject→GREEN. Full lane record in STATUS.md; this section is the close-out summary.

### Per-lane outcomes

- **T1 (engram 033) — AUDIT-PASS on the fourth cycle.** Migration `033_two_phase_hybrid_search.sql` shipped: two-phase index-served top-k, `memory_items_content_fts_gin` CREATED (T1's opening finding: no FTS-servable index ever existed — 001's is trigram-only; the FTS branch has seq-scanned since 002, the documented 57014 cause per 024's header), partial `memory_items_embedding_hnsw_live_idx`, `semantic_similarity` col 10, `p_decay_profile`/`p_branch_limit`, deterministic tiebreaks, NULL-embedding honest degradation, explain-sibling 10-arg lockstep with grant re-pin, hard-failing receipt. TS pass-through + vendored copy byte-identical (sha256 `d803267…` both sides) + `MIGRATION_PROBES` dual probe + `BUNDLE_MAX` 33. DB-backed acceptance (`tests/sql/033a`+`033b`) wired into ci.yml against real pgvector. engram 332/332.
- **T2 (flashback hygiene) — AUDIT-PASS on the second cycle.** All four briefed defects + three adjacent (dead `top_hit_id`/blacklist, click-through-blacklists, webhook zero-hits) fixed; expired≠dismissed≠clicked split + TTL 14d; threshold gate on `semantic_similarity` only; honest UI on five surfaces; unified `mapMemoryRow`; solved-problem passthrough with 404-capability-latch; client proactive path server-gated + funnel-recorded via `/api/ai/query proactive:true`. Flashback suites 112/112; server 595/595.
- **T3 (confidence calibration) — AUDIT-PASS on the first cycle.** Rumen confidence v3 (derived `RRF_BAND_MAX` 0.0737704918, 14-knot quantile map, `NORMALIZE_VERSION` 3; p50 similarity contribution 0.041→0.489, median confidence 0.023→0.275); engram `calibration.ts` label-gated contract + read-only `fit-platt.ts` harness with EPV-gated refuse-to-fit → honest `INSUFFICIENT LABELS` verdict instead of a fabricated fit. Rumen 161/161.
- **T4 (Codex adversarial auditor)** — independent scratch-DB reproduction (disposable pgvector:pg16 + 001→032→033a→033→033b), SELECT-only live-telemetry reproduction to the digit, CHECKPOINT discipline held throughout. The 3+1+1 pattern earned its ~25% overhead four times over (below).

### The blocking T4 findings and their fixes

1. **T2's client-originated toast path was unrecorded** (verdict-1 RED): `triggerProactiveMemoryQuery` raised real toasts with no `flashback_events` row — a visible surface invisible to the exact funnel T3 needs as its future label producer. Fix: PERSIST, not suppress — server-owned `proactive: true` mode mints the row, shared `classifyDrop`, `source: ws|http` tagging; T2's own client-side threshold mirror deleted (two implementations of one gate drift).
2. **T1's 033a fixture was illegal under the pre-033 schema** (verdict-1 RED): seeded `source_type='debugging'`, forbidden by 028's CHECK. Fix: fixture legalised + a parsed-allow-list static guard (reads the CHECK out of 028, so widening it later auto-widens the guard). The diagnosis surfaced the bigger latent defect — `debugging`/`convention` are Category values, not legal source_types, so their decay arms have been dead code since 002 and `solved-problem` only reaches `bug_fix`. ORCH ruled Option A (leave-documented); BACKLOG'd.
3. **§1 equivalence failed at 1e-9** (verdict-2 RED): 3 rows over tolerance. T1's diagnosis: not float noise but **transaction-clock drift** — scores are functions of `now()` across three transactions; the three failures were exactly the three highest ∂score/∂t rows. Fix: equivalence restructured to exact rank-order identity (zero tolerance, clock-immune) as the load-bearing claim + an elapsed-derived score tolerance with a vacuousness self-check; §4/§5 had the same latent bug and were fixed pre-failure.
4. **§7 vector index assertion failed** (verdict-3 RED): the planner chose 005's partial `source_type` index + top-N sort — correctly, on a 1.2k-row fixture. T1's concession: the test asserted a planner *choice* where only *servability* is guaranteeable. Fix: partial `memory_items_embedding_hnsw_live_idx` (predicate = exactly the live-row conditions every vector query applies) + §7 split into hard-asserted servability (`enable_sort=off`), hard-asserted 032-regression, and recorded-not-asserted planner choice.

Pre-verdict catches also worth the record: T4's 20:20 finding that the vector branch's inner `, m.id` tiebreak broke HNSW entirely (fixed before it shipped, mutation-guarded); T4's 20:12 quantile-reproducibility finding → the knots became a pinned snapshot (2026-07-30 20:11 ET, n=39,048) with a self-measuring drift section in the script-generated report.

### Shipped versions

`@jhizzard/mnestra` **0.10.0** · `@jhizzard/rumen` **0.9.0** · `@jhizzard/termdeck` **1.15.0** · `@jhizzard/termdeck-stack` **1.13.0** (audit-trail).

### Live apply (ORCH, post-verdict)

- **Migration 033 applied to the daily driver 2026-07-30**: hard-failing receipt green; both EXPLAIN plans **index-served at ~9.3k rows** — FTS branch on `memory_items_content_fts_gin`, vector branch on the partial HNSW at **3.1 ms** (closing T1's honestly-open question: the planner does choose HNSW at real scale).
- **73 polluting telemetry rows deleted** from `memory_recall_log` (the 027/031 post-apply smoke payloads T3 flagged as F2).

### Open follow-ons

- The four new BACKLOG §A items: **recall-citation label producer** (P1, Sprint-83 candidate — T3's headline finding: 39k telemetry rows, 0 real positives, the label channel has no producer on the dominant path), **Category-vs-SourceType vocabulary drift**, **001-unqualified-HNSW redundancy measurement**, **fit-platt rerun once labels exist**.
- **Global daily-driver mnestra upgrade + webhook bounce post-publish** (T3-F4: the running install was 0.7.0 while 0.9.0 was published — Sprint-81 provenance recorded all-NULL; upgrade to 0.10.0 closes both generations).
- Known pre-existing failure `tests/project-tag-invariant.test.js` — unrelated, verified against a stashed clean tree, carried forward.
