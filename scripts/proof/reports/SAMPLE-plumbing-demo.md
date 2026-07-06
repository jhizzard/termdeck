# Cold-vs-Warm Recall→Reinjection Proof — `SAMPLE-plumbing-demo`

**Generated:** 2026-07-05T17:00:00Z · **Mode:** reinjection · **Recall:** fixture(scripts/proof/fixtures/recall) · **Answerer:** stub(worldKnowledge=0) · **Probes:** 6 (frozen set `5a42d3ae48c640a0`, lock ✓)

> **Honesty contract.** Every probe in the frozen set is run and reported below,
> regardless of verdict — no probe is dropped for showing no delta. The "did recall
> change the work" test is a mechanical grep for a memory-resident `factKey`, not a
> subjective read. Retrieval `score` is an **RRF value (0.01–0.3 band)**, not a 0–1
> cosine similarity. Reproduction command is at the bottom.
>
> ⚠️ **ANSWERER = stub → THIS RUN IS A PLUMBING DEMO, NOT EVIDENCE.** The stub can only
> surface facts already in its context, so warm-wins here proves the *harness wiring*,
> not the *claim*. Re-run with `--answerer="cmd:<model-cli>"` (or `anthropic`) for the
> real proof; an out-of-distribution model (Codex/T8) reproducing it is the anti-rig check.

## Headline

- **6** probes · **6** warm-wins · **0** no-delta (both-have 0 / both-lack 0) · **0** cold-wins
- **8** memory rows reinjected across the warm arms · **568** tokens (recall-reported) / **632** tokens (full block, via `ceil(len/4)`)
- **source_type mix** (all warm arms): decision 4, architecture 2, code_context 1, fact 1
- **provenance:** 6/6 warm recalls carried non-NULL caller attribution

> 6 probes run (6 scored, 0 errored); every probe is reported regardless of verdict (no filtering). warm-wins=6, no-delta=0 (both-have=0, both-lack=0), cold-wins=0.

## Per-probe results

| # | probe | query | rows | tokens | source_type mix | cold fact? | warm fact? | verdict |
|---|-------|-------|-----:|-------:|-----------------|:----------:|:----------:|---------|
| 1 | `sprint-role-architecture` | canonical sprint role architecture 3+1+1 or… | 2 | 127 | decision 2 | no | yes | ✅ warm-wins |
| 2 | `recall-token-heuristic` | Mnestra recall estimateTokens formula token… | 1 | 77 | code_context 1 | no | yes | ✅ warm-wins |
| 3 | `pruning-moratorium` | recall telemetry pruning moratorium recall_… | 1 | 63 | decision 1 | no | yes | ✅ warm-wins |
| 4 | `precompact-mechanism` | auto-commit context compaction PreCompact h… | 1 | 80 | architecture 1 | no | yes | ✅ warm-wins |
| 5 | `recall-boost-default` | migration 032 recall_boost default value no… | 2 | 143 | architecture 1, decision 1 | no | yes | ✅ warm-wins |
| 6 | `rrf-meaning` | memory_hybrid_search reciprocal rank fusion… | 1 | 78 | fact 1 | no | yes | ✅ warm-wins |

## Probe details — the reinjection, verbatim

### 1. `sprint-role-architecture` — ✅ warm-wins

- **Query:** canonical sprint role architecture 3+1+1 orchestrator workers auditor out-of-distribution (project: `termdeck`)
- **Why this probe is fair (a priori):** The '3+1+1' label (1 orchestrator + 3 Claude workers + 1 out-of-distribution non-Claude auditor) is a TermDeck-internal methodology decision recorded in Mnestra and the project CLAUDE.md. A base model has no way to know this exact term or composition — it is neither derivable from the code nor part of any training corpus. Expected: clear warm-win.
- **factKey (the memory-resident fact a correct answer must contain):** all of ["3+1+1"]
- **Reinjected:** 2 rows · 127 tokens (recall-reported) · 138 tokens (full block, 550 chars)
- **Provenance:** recall_group_id=`rg-sprint-role-architecture`, source_session_id=`proof-harness-fixture`, source_agent=`proof-harness` (origin: recall_log)

<details><summary>Reinjected memory block (what a warm session receives)</summary>

```text
2 memories (127 tokens, project: termdeck):

- (decision/critical) TermDeck's canonical sprint role architecture is 3+1+1: 1 Orchestrator + 3 Claude workers on disjoint lanes + 1 non-Claude auditor (Codex preferred; Gemini/Grok also work) for adversarial, out-of-distribution review. Shared-model lanes share blind spots; the out-of-distribution auditor breaks the ti...
- (decision) Sprint 51.5 to 51.6 is the canonical case for the 3+1+1 audit pattern: an all-Claude sprint missed 4 bugs; adding Codex as the T4 auditor caught all 4 in ~14 minutes.
```
</details>

**COLD answer** (no reinjection):

```text
Based on my general knowledge: (no specific information available in my general knowledge)
```

**WARM answer** (recall reinjected):

```text
Based on the recalled context:
2 memories (127 tokens, project: termdeck):

- (decision/critical) TermDeck's canonical sprint role architecture is 3+1+1: 1 Orchestrator + 3 Claude workers on disjoint lanes + 1 non-Claude auditor (Codex preferred; Gemini/Grok also work) for adversarial, out-of-distribution review. Shared-model lanes share blind spots; the out-of-distribution auditor breaks the ti...
- (decision) Sprint 51.5 to 51.6 is the canonical case for the 3+1+1 audit pattern: an all-Claude sprint missed 4 bugs; adding Codex as the T4 auditor caught all 4 in ~14 minutes.
```

### 2. `recall-token-heuristic` — ✅ warm-wins

- **Query:** Mnestra recall estimateTokens formula token budget default recall.ts (project: `termdeck`)
- **Why this probe is fair (a priori):** The specific implementation (Math.ceil(text.length / 4), default token_budget 2000) lives in recall.ts. A cold model might guess the folk heuristic 'about 4 characters per token' but not the exact ceil(len/4) form the factKey requires. Expected: warm-win (the exact form is code-resident).
- **factKey (the memory-resident fact a correct answer must contain):** all of ["ceil", "4"]
- **Reinjected:** 1 rows · 77 tokens (recall-reported) · 88 tokens (full block, 352 chars)
- **Provenance:** recall_group_id=`rg-recall-token-heuristic`, source_session_id=`proof-harness-fixture`, source_agent=`proof-harness` (origin: recall_log)

<details><summary>Reinjected memory block (what a warm session receives)</summary>

```text
1 memories (77 tokens, project: termdeck):

- (code_context) Mnestra's recall path (engram/src/recall.ts) estimates a memory's token cost with estimateTokens(text) = Math.ceil(text.length / 4) — the ~4-characters-per-token heuristic. The recall token_budget defaults to 2000 (about 8000 characters); trimming happens after the minimum-result guarantee.
```
</details>

**COLD answer** (no reinjection):

```text
Based on my general knowledge: (no specific information available in my general knowledge)
```

**WARM answer** (recall reinjected):

```text
Based on the recalled context:
1 memories (77 tokens, project: termdeck):

- (code_context) Mnestra's recall path (engram/src/recall.ts) estimates a memory's token cost with estimateTokens(text) = Math.ceil(text.length / 4) — the ~4-characters-per-token heuristic. The recall token_budget defaults to 2000 (about 8000 characters); trimming happens after the minimum-result guarantee.
```

### 3. `pruning-moratorium` — ✅ warm-wins

- **Query:** recall telemetry pruning moratorium recall_count zero migration 027 sprint cycle (project: `termdeck`)
- **Why this probe is fair (a priori):** The pruning moratorium (act on recall_count=0 only after ≥ 1 full sprint cycle, because a fresh memory simply lacks telemetry) is a design decision in migration 027 and Mnestra memory. Not knowable from training. Expected: warm-win.
- **factKey (the memory-resident fact a correct answer must contain):** any of ["1 full sprint cycle", "one full sprint cycle", "≥ 1 full sprint"]
- **Reinjected:** 1 rows · 63 tokens (recall-reported) · 74 tokens (full block, 295 chars)
- **Provenance:** recall_group_id=`rg-pruning-moratorium`, source_session_id=`proof-harness-fixture`, source_agent=`proof-harness` (origin: recall_log)

<details><summary>Reinjected memory block (what a warm session receives)</summary>

```text
1 memories (63 tokens, project: termdeck):

- (decision) Mnestra recall telemetry (migration 027) pruning moratorium: nobody acts on recall_count=0 for at least 1 full sprint cycle. A freshly added memory simply lacks telemetry, so a zero count must never be read as 'unused' during that window.
```
</details>

**COLD answer** (no reinjection):

```text
Based on my general knowledge: (no specific information available in my general knowledge)
```

**WARM answer** (recall reinjected):

```text
Based on the recalled context:
1 memories (63 tokens, project: termdeck):

- (decision) Mnestra recall telemetry (migration 027) pruning moratorium: nobody acts on recall_count=0 for at least 1 full sprint cycle. A freshly added memory simply lacks telemetry, so a zero count must never be read as 'unused' during that window.
```

### 4. `precompact-mechanism` — ✅ warm-wins

- **Query:** auto-commit context compaction PreCompact hook memory-pre-compact pre_compact_snapshot (project: `termdeck`)
- **Why this probe is fair (a priori):** The PreCompact harness hook (memory-pre-compact.js writing a source_type='pre_compact_snapshot' row) is a TermDeck implementation detail from Sprint 64. A cold model cannot name it. Expected: warm-win.
- **factKey (the memory-resident fact a correct answer must contain):** any of ["PreCompact", "memory-pre-compact", "pre_compact_snapshot"]
- **Reinjected:** 1 rows · 80 tokens (recall-reported) · 91 tokens (full block, 364 chars)
- **Provenance:** recall_group_id=`rg-precompact-mechanism`, source_session_id=`proof-harness-fixture`, source_agent=`proof-harness` (origin: recall_log)

<details><summary>Reinjected memory block (what a warm session receives)</summary>

```text
1 memories (80 tokens, project: termdeck):

- (architecture) Auto-commit on context-compaction-near: Claude Code panels fire the PreCompact harness hook (memory-pre-compact.js), which writes a source_type='pre_compact_snapshot' row to Mnestra before the context is compacted. Non-Claude panels (Codex/Gemini/Grok) have no PreCompact equivalent, so TermDeck's se...
```
</details>

**COLD answer** (no reinjection):

```text
Based on my general knowledge: (no specific information available in my general knowledge)
```

**WARM answer** (recall reinjected):

```text
Based on the recalled context:
1 memories (80 tokens, project: termdeck):

- (architecture) Auto-commit on context-compaction-near: Claude Code panels fire the PreCompact harness hook (memory-pre-compact.js), which writes a source_type='pre_compact_snapshot' row to Mnestra before the context is compacted. Non-Claude panels (Codex/Gemini/Grok) have no PreCompact equivalent, so TermDeck's se...
```

### 5. `recall-boost-default` — ✅ warm-wins

- **Query:** migration 032 recall_boost default value no-op bounded multiplier ranking (project: `termdeck`)
- **Why this probe is fair (a priori):** recall_boost NUMERIC NOT NULL DEFAULT 1.0 as a strict no-op multiplier is a Sprint 81 design decision (migration 032, not yet shipped at authoring time). Cannot be known from training. Expected: warm-win. Doubles as proof the harness surfaces facts about not-yet-shipped work that live only in memory/planning.
- **factKey (the memory-resident fact a correct answer must contain):** all of ["recall_boost", "1.0"]
- **Reinjected:** 2 rows · 143 tokens (recall-reported) · 154 tokens (full block, 614 chars)
- **Provenance:** recall_group_id=`rg-recall-boost-default`, source_session_id=`proof-harness-fixture`, source_agent=`proof-harness` (origin: recall_log)

<details><summary>Reinjected memory block (what a warm session receives)</summary>

```text
2 memories (143 tokens, project: termdeck):

- (decision/important) Migration 032 adds memory_items.recall_boost numeric NOT NULL DEFAULT 1.0 — a bounded multiplicative ranking factor that is a strict no-op at 1.0. Rumen's recall-feedback loop populates it; the ranking effect stays inert until then. The pruning moratorium still holds: never penalize recall_count=0.
- (architecture) recall_boost is written ONLY by Rumen (doctrine-clean, like doctrine_registry.occurrence_count); it never mutates memory content or embeddings, and memory_hybrid_search multiplies it into the score bounded so 1.0 changes nothing.
```
</details>

**COLD answer** (no reinjection):

```text
Based on my general knowledge: (no specific information available in my general knowledge)
```

**WARM answer** (recall reinjected):

```text
Based on the recalled context:
2 memories (143 tokens, project: termdeck):

- (decision/important) Migration 032 adds memory_items.recall_boost numeric NOT NULL DEFAULT 1.0 — a bounded multiplicative ranking factor that is a strict no-op at 1.0. Rumen's recall-feedback loop populates it; the ranking effect stays inert until then. The pruning moratorium still holds: never penalize recall_count=0.
- (architecture) recall_boost is written ONLY by Rumen (doctrine-clean, like doctrine_registry.occurrence_count); it never mutates memory content or embeddings, and memory_hybrid_search multiplies it into the score bounded so 1.0 changes nothing.
```

### 6. `rrf-meaning` — ✅ warm-wins

- **Query:** memory_hybrid_search reciprocal rank fusion RRF score band ranking (all projects)
- **Why this probe is fair (a priori):** DELIBERATE no-delta control. RRF = Reciprocal Rank Fusion is general retrieval knowledge a capable model already has, so a live run should score this both-have → no-delta, proving the harness does not simply always report warm-wins. (Under the offline stub answerer, which knows nothing, this shows as a warm-win in the plumbing demo; the real answerer reveals the honest no-delta.)
- **factKey (the memory-resident fact a correct answer must contain):** any of ["reciprocal rank fusion"]
- **Reinjected:** 1 rows · 78 tokens (recall-reported) · 87 tokens (full block, 348 chars)
- **Provenance:** recall_group_id=`rg-rrf-meaning`, source_session_id=`proof-harness-fixture`, source_agent=`proof-harness` (origin: recall_log)

<details><summary>Reinjected memory block (what a warm session receives)</summary>

```text
1 memories (78 tokens, all projects):

- (fact) [termdeck] Mnestra's memory_hybrid_search combines full-text and semantic ranking via Reciprocal Rank Fusion (RRF) with rrf_k=60. The resulting RRF score sits in the 0.01 to 0.3 band, not a 0 to 1 cosine similarity — a distinction that matters when weighting similarity against other ranking signals.
```
</details>

**COLD answer** (no reinjection):

```text
Based on my general knowledge: (no specific information available in my general knowledge)
```

**WARM answer** (recall reinjected):

```text
Based on the recalled context:
1 memories (78 tokens, all projects):

- (fact) [termdeck] Mnestra's memory_hybrid_search combines full-text and semantic ranking via Reciprocal Rank Fusion (RRF) with rrf_k=60. The resulting RRF score sits in the 0.01 to 0.3 band, not a 0 to 1 cosine similarity — a distinction that matters when weighting similarity against other ranking signals.
```

## Threats to validity / limitations

- Answerer model choice matters: a stronger model may already know a "memory-resident" fact from training, turning a warm-win into an honest no-delta (both-have). The frozen probe set targets session/project-specific, post-cutoff facts to minimize this, but it cannot be eliminated — hence no-delta is reported, not hidden.
- MCP-stdio panel provenance flows through TermDeck's panel-spawn env producer (MNESTRA_SESSION_ID / MNESTRA_SOURCE_AGENT) into engram's recall_log env-reader — both landed file-only (T1 031 reader + T4 producer), live once ORCH applies 031 and a panel runs. Claude panels inherit the env into their MCP server; Codex-panel inheritance to its static-config MCP is an open verification item. This harness supplies caller provenance EXPLICITLY over the webhook path, so ITS recalls are attributable regardless of the panel path. NULLs above are reported as NULL, never inferred.
- Token counts use the recall path's own ceil(len/4) heuristic, not a provider tokenizer — consistent and honest for comparison, but an approximation of true billed tokens.
- factKey is a necessary-condition check (the fact must appear), not a full-answer-quality judgement. A warm answer could contain the fact and still be worse elsewhere; a human read of the verbatim answers above is the backstop.
- The COLD arm withholds recall entirely; it does not model a session that recalled and ignored the result. This isolates the reinjection variable cleanly but is a stronger contrast than every real session.
- Recall is non-deterministic against a live store (embedding + RRF + a moving corpus). For a fixed record, run against the frozen fixtures; a live run captures a point-in-time snapshot and should record the corpus size/date.

## Reproduction

```bash
node scripts/proof/cold-vs-warm.js --recall=fixture --answerer="stub" --mode=reinjection
```

Frozen probe-set checksum: `5a42d3ae48c640a0` (matches lock).
