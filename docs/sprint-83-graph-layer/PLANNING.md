# Sprint 83 — Graph Layer + Label Producer

**Dispatched:** 2026-07-31 ~14:40 ET · 3+1+1 on :3001 · ORCH = fresh orchestrator session (arc Phase 3)
**Context:** Sprint 82 shipped calibrated, index-served recall (migration 033, flashback hygiene, confidence v3). Two things remain structurally broken: the 7,378-edge relationship graph is written nightly and read ~never, and the recall-telemetry label channel has NO producer on the dominant path (39k rows, 0 real positives post-purge — every data-driven threshold, pruning, and elevation decision is blocked on it).

## Why (the findings this sprint answers)

1. **The graph is dark.** `memory_relationships` holds ~7,378 edges (`relates_to` 5,841 avg weight .889, `supersedes` 927, `cross_project_link` 32, rest thin), written nightly 03:00 UTC by the `graph-inference` edge fn (rumen `supabase/functions/graph-inference/`, LATERAL+HNSW pairs ≥0.85 cosine, Haiku classifies into 8 edge types; live since Sprint 42). Read side: `memory_recall_graph` (engram migration 010) has **2 recorded uses ever**; `expand_memory_neighborhood` (009) is bidirectional and unused live.
2. **Edges have no temporal validity and no typed-predicate discipline.** Nothing distinguishes a still-true edge from one invalidated by later events; the vocabulary is whatever Haiku emitted. Community benchmarks rank temporal validity (`valid_at`/`invalid_at`, invalidate-don't-delete) the single highest-value edge semantic.
3. **The label channel is architecturally starved, not young.** `cited` is only ever set by `markRecallCited` (`engram/src/layered.ts:266` — the `memory_get` path) and webhook `op:'feedback'` (`engram/src/webhook-server.ts:92`). Ordinary `memory_recall` returns content INLINE, so the dominant path never cites. Assets already in place: migration 031 stamps `recall_group_id` per recall; Sprint 82's flashback funnel produces clicked/dismissed/expired; `engram/scripts/calibration/fit-platt.ts` reruns with zero code change once labels exist (EPV gate: ≥100 positives absolute, ≥20 per feature).
4. **Solved-problem recall inputs now exist (Sprint 82)** and want graph legs: `p_decay_profile='solved-problem'` flattens bug_fix decay; `semantic_similarity` is the cardinal signal; the flashback path embeds the matched error line and is threshold-gated; the 5 `err-*` entries in termdeck `doctrine/registry.jsonl` are the seed problem-class taxonomy for `metadata.problem_signature`.
5. **Community-consensus design (2026-07-30 graph-memory research):** stay in Postgres (no Neo4j/Graphiti); write-time entity/triple extraction with a small fixed predicate vocabulary; retrieval = hybrid recall as entry point + 1–2 hop typed expansion; periodic consolidation = entity resolution + community detection (connected components adequate at 9k scale) + an LLM-written summary memory per community; Obsidian vault as a generated READ-ONLY projection.

## Lanes

| Lane | Owner | Scope | Brief |
|---|---|---|---|
| T1 | Claude worker | engram migration 034: edge temporality + typed-predicate vocabulary + entity storage + citation RPC (all sprint SQL) + vendored copy + probes | `T1-graph-034.md` |
| T2 | Claude worker | Write-time extraction (entities/triples/`problem_signature`) + the label producer's client side (`memory_cite` tool, `recall_group_id` passthrough) — all engram/rumen TS | `T2-extraction-cite.md` |
| T3 | Claude worker | Recall-side 1–2 hop typed expansion in the error-recall/flashback path + consolidation job + Obsidian read-only exporter | `T3-expansion-consolidation.md` |
| T4 | Codex auditor | Adversarial verification of all three, scratch-DB 034 reproduction, CHECKPOINT discipline, FINAL-VERDICT | `T4-codex-auditor.md` |

## Cross-lane interfaces (the contract — do not drift)

- **I1 (T1 → T2, T3):** 034's surface frozen early. T1 posts `### [T1] SCHEMA-READY <date> — <gist>` containing: exact DDL for the temporal columns, the shipped predicate vocabulary (inventory-driven — every live edge type stays valid), the entity-storage shape, and the exact signatures of the citation RPC and (if requested per I4) the typed-expansion RPC. T2/T3 code against that post; it does not change after.
- **I2 (T2 → T1):** any SQL the extraction needs (entity columns, `problem_signature` storage decisions that touch schema) goes through `### [T2] FINDING … SCHEMA-REQUEST` within the first 30 min. T2 never writes migrations.
- **I3 (T2 → T3):** the `problem_signature` shape (field path, format, seed classes) is posted by T2 as part of its first FINDING; T3's expansion matches symptoms against exactly that shape.
- **I4 (T3 → T1):** if 1–2 hop typed+temporal expansion needs new/updated SQL beyond migration 010's `memory_recall_graph` (it almost certainly does — 010 predates `valid_at`), T3 posts `SCHEMA-REQUEST` within the first 30 min; the SQL lands in T1's 034. T3 never writes migrations.
- **I5 (T1 → T2):** the citation RPC's contract: T2's `memory_cite` tool and recall-output `recall_group_id` passthrough consume it. The RPC must write what `fit-platt.ts` reads (positive labels on `memory_recall_log` keyed by `recall_group_id`).

## Non-goals (do not touch)

- No auto-promote flip, no Sheets intake ramp, no `memory_session_record` (all Phase 4, gated ~2026-08-13). No standalone-shell capture (Sprint 68-redux).
- No Neo4j / Graphiti / framework adoption — Postgres-native only.
- No ranking changes driven by `score_calibrated` (display-only until a real fit exists) and no changes to 033's scoring semantics — graph expansion is additive surfacing, never a mutation of the hybrid ranking.
- The Obsidian vault is a generated read-only projection — no import path, never a second writable source of truth.
- No version bumps, no CHANGELOG edits, no commits, no `npm publish`, no live-DB writes — **ORCH owns all of those at close** (RELEASE.md discipline). Read-only live queries via `DATABASE_URL` from `~/.termdeck/secrets.env` are permitted for ground-truthing (never print values).

## Acceptance

- **T1:** clean-DB acceptance runs 001→034 (the Sprint 82 lesson — fixtures legal at every step); invalidate-don't-delete proven by test; predicate constraint proven backward-compatible against the live edge-type inventory (seeded legacy edges survive); citation RPC writes a positive label a rerun of `fit-platt.ts` can see; five hygiene gates + overload-drop guards on every function; vendored copy byte-identical + `MIGRATION_PROBES` entry + `BUNDLE_MAX` 34; `npm test` green.
- **T2:** extraction on `memory_remember`/`ingest_capture` writes vocabulary-conformant typed edges + entities, is budget-guarded, and **fails open** (a write never fails because extraction failed); `problem_signature` lands on bug_fix/debugging-class writes; `memory_cite` registered and `recall_group_id` carried in recall output end-to-end; everything feature-detects 034's absence (fail-soft). Acceptance bar: **a real positive label flows from an ordinary recall→cite round-trip in a DB-backed test.**
- **T3:** typed expansion wired into the error-recall/flashback path — a symptom match surfaces the FIX via `caused_by`/`fixed_by`/`supersedes` edges ("you solved this before" fires); expansion traverses only live (`invalid_at IS NULL`) edges and **never mutates canonical content**; consolidation job produces provenance-marked community-summary memories, budget-isolated per the rumen pattern; Obsidian exporter generates the vault read-only, regenerate-on-demand; tests green.
- **T4:** AUDIT-PASS per lane with file:line evidence, or AUDIT-FAIL with reproduction; FINAL-VERDICT posted.

## STATUS.md discipline (all lanes)

Post shape, exactly: `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
Verbs: FINDING · FIX-PROPOSED · FIX-LANDED · SCHEMA-READY · SCHEMA-REQUEST · BLOCKED · CHECKPOINT · AUDIT-PASS · AUDIT-FAIL · FINAL-VERDICT · DONE.
Waiting on another lane? Poll STATUS.md with the tolerant regex `^(### )?\[T<n>\] DONE\b` (or the verb you need) — never a brittle exact-prefix match. Parked lanes will be nudged by ORCH; end your turn cleanly with your state posted.

## Resolution (2026-07-31)

**FINAL-VERDICT GREEN at 15:14 ET, GREEN-REAFFIRMED at 15:18 ET** — inject 14:33, ~41 min inject→verdict, **zero RED verdict cycles** (contrast Sprint 82's three): every defect was caught in-flight by the T4 WIP-audit cadence + binding ORCH rulings and fixed pre-landing, so no verdict ever had to bounce. Full lane record in STATUS.md; this section is the close-out summary.

### Per-lane outcomes

- **T1 (engram migration 034) — AUDIT-PASS.** `034_graph_layer.sql` (2,137 lines): edge temporality (`valid_at`/`invalid_at`, history-preserving backfill, invalidate-don't-delete with a no-DELETE static fence), 14-predicate FK-governed vocabulary (`memory_relationship_types` + mechanical `SELECT DISTINCT` adoption — an unknown legacy predicate can't break an install), entity tables (RLS-on, zero-policy, service-role-only), `mark_recall_cited_group` + `group_resolved_at` observed negatives, REQ-1-verbatim `memory_expand_typed` (STABLE, receipt-enforced), batch `upsert_memory_edges`/`upsert_memory_entities`, §2c decay repair, problem-signature/community-key indexes, `consolidation_summary` CHECK widening (both-directions receipt). Headline catches: **the `xmax = 0::xid` cast bug that a bare `when others` converted into clean drops** → both batch RPCs now catch an enumerated data-error condition list and never `when others` (a broken function is loud; a broken edge is dropped); **the CI apply-split fixture design** (001→032 → 033a → 033 → **034a pre-034 legacy fixtures** → 034 → 034b — the only fixture shape that can prove "every pre-existing edge survives me", and deleting the adopt pass fails 034's own apply); the **§2c fold-in** proven by a `fact`+debugging fixture where the change is observable, with a `workflow` control that must not move. Vendored copy byte-identical (sha256 `118b0658…`), two-sided discriminating `MIGRATION_PROBES` entry, `BUNDLE_MAX` 34, 33/33 static hygiene tests. engram 407 (405 pass / 2 DB-skip).
- **T2 (write-time extraction + label producer client) — AUDIT-PASS.** The **`recall_group_id` structural fix**: the id was minted *inside* the fire-and-forget logger and never escaped, so no agent could physically name what it just recalled — now minted in `memoryRecall`/`memoryIndex`/`memoryTimeline`, threaded via `RecallLogContext`, returned on every surface, with `[n]` citation handles + cite-on-use prompt on the text surface. `memory_cite` MCP tool (rank/id-narrowed, honest-zero diagnostics). **Acceptance met the consumer's way**: DB-backed round-trip asserts fit-platt's own label query goes `positives` 0→1 on the cited rank specifically, **plus a negative control** seeding exactly the two fit-excluded shapes (`surface='graph'`, NULL score) and proving they stay outside the fit window — without it, a green test could not distinguish a working label channel from filters swallowing everything. `problem_signature` inline (object under one metadata key, atomic under dedup merge), dependency-free dual-export normalizer core + 12 golden vectors, `copy-js-assets.mjs` in build+test, extraction fail-open (11 cases) + budget-guarded + OFF by default. engram typecheck clean; 374/374 with DB.
- **T3 (expansion + consolidation + exporter) — AUDIT-PASS.** Typed expansion wired to BOTH flashback emit surfaces from one expander instance, placed after selection + funnel write (structurally additive), read-only proven three ways + STABLE server-side, 404-capability-latched, cross-project opt-in only. Headline catches: **the `ON CONFLICT DO UPDATE` owned-row guard** (034's partial unique index is metadata-only, so an unguarded upsert could rewrite a canonical row carrying the same metadata shape — now guarded on `source_type` + kind, with affected-row checks and a dedicated `summaries_conflict_unowned` counter so an unowned conflict is never counted as a write); **the live-DB-leaking test fix** (two vault-export tests deleted `DATABASE_URL` but still hit the production store through the `~/.termdeck/secrets.env` fallback — fixed with a `withoutCredentials()` HOME-override; kitchen lesson: unsetting an env var does not disable a credential path with a file-based fallback); **the client render** (a `related` payload nothing draws is a dead feature — `renderRelatedLine` wired at all four call sites, visually subordinate to the ranked hit). Consolidation refactored to the rumen src/-plus-thin-wrapper shape, both amplification defenses landed, exporter destructive-write-guarded. termdeck 1110 (1105 pass / 5 skip); rumen 197 (196 pass / 1 DB-skip).
- **T4 (Codex adversarial auditor) — the pattern earned its overhead again.** **9+ audit phases** with CHECKPOINT discipline held throughout, **3 independent disposable pgvector replays** (baseline 001→033; WIP 034; final 001→033→034a→034→034b), behavioral probes beyond the receipts (the `xmax` entity-drop bug was invisible to 034's own green receipt), file-diff-over-worker-prose ground truth (caught a claimed-but-not-landed `category` bridge field), the frame-shape leak, phantom test references, the stale entity-shape probe in consolidation, and the unguarded upsert arm — every one fixed pre-verdict. FINAL-AUDIT posted with file:line evidence per lane; GREEN-REAFFIRMED after independently re-verifying T1's packaging tail (cmp/shasum, two-sided probe, `BUNDLE_MAX`, 33/33 + 5/5).

### The six ORCH rulings

1. **14:42 — SCHEMA-READY-2 reconciliation.** T1's I1 freeze crossed T2/T3's I2/I4 SCHEMA-REQUESTs in flight; ruled that T1 adopts T3's REQ-1 expansion signature **verbatim** (PostgREST binds by param name), merges the citation RPC into ONE group-keyed function, and adds SR-2/SR-3 batch RPCs — a single re-frozen surface instead of three drifting contracts.
2. **14:47 — normalizer executable contract.** T4 proved the posted "T3 imports engram TS" contract impossible (TermDeck is CommonJS/no-TS, no mnestra dependency); ruled ONE dependency-free dual-export plain-JS core in engram + byte-identical vendored copy in TermDeck + shared golden vectors run by both suites.
3. **14:52 — I4-b option (a) + both amplification defenses.** `consolidation_summary` becomes a distinct `source_type` (enforcement, not metadata convention — T3's own acceptance argument), and BOTH self-amplification defenses ship: member-selection exclusion in consolidation AND the graph-inference candidate-query exclusion (posted as its own FIX-PROPOSED — a live nightly cron's behavior change deserves its own line).
4. **14:52 (same ruling) — T4 WIP findings made binding pre-FIX-LANDED remediation**, not advisories — the mechanism that produced zero RED verdict cycles.
5. **15:03 — 033-decay fold-in.** T3's finding that `solved-problem` decay reached 40% of its population was folded into 034 as T1 scope (the buried 379 debugging-class rows are this sprint's seed pool; shipping a graph layer whose entry profile misses 60% of its population undermines the headline acceptance), with silent deferral named the one forbidden outcome.
6. **15:19 — conditional GREEN.** T4's 15:14 GREEN accepted conditional on T1's packaging tail (vendored 034 + probes + `BUNDLE_MAX` + hygiene test); T1's 15:16/15:18 DONE landed it and T4 GREEN-REAFFIRMED in one line, no full re-audit.

### Shipped versions

| package | version | status |
|---|---|---|
| `@jhizzard/mnestra` | **0.11.0** | committed, publish pending operator Passkey gate |
| `@jhizzard/rumen` | **0.10.0** | committed, publish pending operator Passkey gate |
| `@jhizzard/termdeck` | **1.16.0** | committed, publish pending operator Passkey gate |
| `@jhizzard/termdeck-stack` | **1.14.0** | committed (audit-trail bump), publish pending |

### Open follow-ons

**Live apply / deploy tail (ORCH + operator, post-publish, in order):**
1. Publish wave (Passkey, npm-before-push per RELEASE.md), then apply engram 034 to the daily driver (§11 of the migration is the checklist, incl. the `get_advisors` five-gate sweep).
2. Deploy `graph-consolidation` **only after** `@jhizzard/rumen@0.10.0` is live on npm (the wrapper pins `npm:@jhizzard/rumen@0.10.0`; deploying against an unpublished pin is the Sprint-66 silent-no-op shape). First run in `GRAPH_CONSOLIDATION_DRY_RUN=1` and read the component size distribution BEFORE any cron; cron staggered vs graph-inference 03:00 and doctrine-scan 03:30 UTC.
3. Post-apply live verification: the expansion RPC against the real 034 store + a real browser toast with a `related` line (neither exercised live — stubbed-RPC/unit-tested only).
4. Install the cite-on-use CLAUDE.md snippet (T2's 15:09 post has the paste-ready block); decide `MNESTRA_EXTRACT_ENABLED` for the daily driver; global daily-driver mnestra upgrade + webhook bounce.

**BACKLOG'd (all under §A in `docs/BACKLOG.md`):** root `tests/` npm-glob gap (5 assertions stale since Sprint 81, verified pre-existing at HEAD); rumen alternate-guard test assertion weaker than source; `ingest_capture` extraction sweep (rumen phase); SR-7 entity↔entity edge table; giant-component measurement before any consolidation cron; 033 FTS-branch `embedding is not null` total-invisibility question; fit-platt rerun once real citations clear the EPV gate (producer now shipped — zero code change needed).
