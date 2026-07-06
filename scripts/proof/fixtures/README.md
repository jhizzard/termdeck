# Proof fixtures — probe selection criteria & provenance

The credibility of the cold-vs-warm proof lives or dies on the probe set being
chosen **honestly and a priori**. This file records why each probe is here so an
auditor (T8) can judge the selection, not just the run.

## Selection criteria (fixed before any run)

A probe qualifies only if **all** hold:

1. **Memory-resident.** A correct answer requires a fact that lives in Mnestra /
   the project's own decisions — not something a base model knows from training,
   and not trivially derivable from reading the repo alone.
2. **Mechanically checkable.** The fact reduces to a `factKey` (a string / regex
   / any-of / all-of) that either appears in an answer or doesn't — no
   subjective grading.
3. **Public-safe.** No PII, no third-party personal facts, and **none** of the
   forbidden internal identifiers (the internal Supabase project name or ref).
   These fixtures live in a public repo.
4. **Verifiable.** The fact is real and traceable to code, migrations, memory, or
   the project CLAUDE.md — listed below.

The set deliberately includes **one general-knowledge control** (`rrf-meaning`)
that a capable model already knows, so a real run scores it `no-delta` — proving
the harness reports non-wins rather than always claiming victory.

## The probes

| id | memory-resident fact | source | expected (real model) |
|---|---|---|---|
| `sprint-role-architecture` | the "3+1+1" sprint role architecture (1 orch + 3 workers + 1 out-of-distribution auditor) | project + global CLAUDE.md; Mnestra decisions | warm-win |
| `recall-token-heuristic` | `estimateTokens = Math.ceil(text.length / 4)`, default `token_budget` 2000 | `engram/src/recall.ts:49` | warm-win |
| `pruning-moratorium` | act on `recall_count=0` only after ≥ 1 full sprint cycle | `engram/migrations/027_recall_telemetry.sql`; Mnestra | warm-win |
| `precompact-mechanism` | the PreCompact hook (`memory-pre-compact.js` → `pre_compact_snapshot`) | Sprint 64; project CLAUDE.md | warm-win |
| `recall-boost-default` | migration 032 `recall_boost NUMERIC NOT NULL DEFAULT 1.0`, a no-op multiplier | Sprint 81 PLANNING §T1.2 (not yet shipped) | warm-win |
| `rrf-meaning` | RRF = Reciprocal Rank Fusion | general retrieval knowledge (**control**) | no-delta |

## The recall fixtures (offline path)

`recall/<id>.json` are **canned RecallOutputs** used only by the offline plumbing
run. They are generated from `recall-hits.json` by `build-recall-fixtures.js`,
which renders each block **through `scripts/proof/lib/tokens.js`** — the same
formatter the harness measures with — so `text` and `tokens_used` are faithful
to `engram/src/recall.ts` by construction, not hand-typed. The test
`committed recall fixtures are byte-faithful to the formatter` re-derives them
and fails on any drift or tampering.

Regenerate after editing `recall-hits.json`:

```bash
node scripts/proof/fixtures/build-recall-fixtures.js
```

The **real** proof does not use these — it recalls live (`--recall=http`) at
ORCH close-out. The fixtures exist so the harness is testable and reproducible
offline, and so the report shape is reviewable in the PR.

## Freezing the set

```bash
node scripts/proof/cold-vs-warm.js --write-lock   # writes probes.lock = <checksum>
```

Any later change to `probes.json` changes the checksum; the harness prints a WARN
and `--verify-frozen` exits non-zero until the change is reviewed and re-locked.
