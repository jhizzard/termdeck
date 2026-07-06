# Cold-vs-Warm Recall→Reinjection Proof Harness

*Sprint 81, lane T5. Repo-resident dev/proof tooling (not shipped in the npm
tarball — `scripts/` is not in `package.json` `files[]`, same as `demo.js`).*

## What this proves

The claim at the centre of Sprint 81 is **recall→reinjection**: that Mnestra
memories are pulled into a session and *change the work*. This harness makes
that observable and measurable. For a **frozen set of representative probes** it
runs the same task twice —

- **COLD** — the answerer gets the task with **no** memory reinjected.
- **WARM** — the answerer gets the task **plus** the output of `memory_recall`
  for that probe (the exact block a warm session receives at start).

— holding everything else identical, and reports the delta:

- **rows surfaced** (K) and **tokens reinjected** (T, via recall's own
  `ceil(len/4)` heuristic — see `lib/tokens.js`),
- **`source_type` mix** (decision / fact / architecture / …),
- **provenance** (`recall_group_id`, `source_session_id`, `source_agent` — what
  migration 031's `memory_recall_log` captures),
- and, mechanically, **whether the answer gained a memory-resident `factKey` it
  lacked cold** → verdict `warm-wins` / `no-delta` / `cold-wins`.

The output is a Markdown report a human reads as *"this session cold-started,
recalled N rows totalling T tokens, and here is how the answer changed"* plus a
JSON record a tool (or an auditor) consumes.

## Honesty contract (why this isn't riggable)

The credibility of the whole sprint rests on this proof being honest, so the
anti-rig guarantees are structural, not promises:

1. **Frozen probe set.** `fixtures/probes.json` is checksummed into
   `fixtures/probes.lock`; the harness WARNs (or `--verify-frozen` fails) if the
   set drifts. Probes were chosen *a priori* with documented rationale
   (`fixtures/README.md`) — not "queries where warm happens to win".
2. **Run-all, report-all.** Every probe runs and every verdict is reported —
   `no-delta` and `cold-wins` included. A harness that only counted warm-wins
   would be unfalsifiable. There is a deliberate general-knowledge probe
   (`rrf-meaning`) expected to score **no-delta** under a real model.
3. **Mechanical verdict.** "Did recall change the work" is a case-insensitive
   grep for a `factKey`, not a subjective read. An auditor recomputes it from the
   same inputs and gets the same answer.
4. **Answerer is named and stub runs are stamped non-evidence.** The default
   `stub` answerer knows nothing, so it only proves *wiring*; its report is
   banner-stamped **PLUMBING DEMO, NOT EVIDENCE**. The real proof needs a real
   answerer (below).
5. **Out-of-distribution reproduction.** The `cmd:` answerer is model-agnostic —
   the auditor (T8/Codex) reruns the proof with a *different* model. If an
   out-of-distribution model reproduces the warm-wins, the result isn't an
   artefact of one model's quirks. This is the strongest check.
6. **Threats to validity** are always emitted in the report, not buried here.

## Quick start (offline plumbing demo — no creds, no store, no model)

```bash
node scripts/proof/cold-vs-warm.js
# → writes scripts/proof/reports/<runId>.{md,json}; report is stamped PLUMBING DEMO
```

Defaults are `--recall=fixture --answerer=stub`, so a bare run touches nothing
live. See the committed `reports/SAMPLE-plumbing-demo.md` for the shape.

## The real proof (ORCH runs this at close-out — workers are file-only)

Swap in a live recall and a real answerer:

```bash
# recall against the live Mnestra webhook (supplies caller provenance so the
# recall lands NON-NULL source_session_id/source_agent in migration 031's log):
export TERMDECK_PROOF_RECALL_URL="http://127.0.0.1:37778/mnestra"   # mnestra serve
# export TERMDECK_PROOF_RECALL_KEY=...        # if the webhook requires a secret
# export TERMDECK_PROOF_RECALL_EVENTS_URL="http://127.0.0.1:3000/api/recall-events"  # optional: T4's route, to confirm recall_group_id

# answerer = any model CLI that reads a prompt on stdin and writes the answer on stdout:
node scripts/proof/cold-vs-warm.js --recall=http --answerer='cmd:claude -p'
# or the SDK convenience (temperature 0, pinned model), needs ANTHROPIC_API_KEY:
node scripts/proof/cold-vs-warm.js --recall=http --answerer=anthropic
```

**Auditor reproduction (T8):** rerun with a different model — e.g.
`--answerer='cmd:codex exec'` (any CLI reading stdin → writing stdout works).
Same frozen probes, same `factKey` grep, independent model.

## Adapters

| Flag | Values | Notes |
|---|---|---|
| `--recall` | `fixture` · `fixture:<dir>` · `http` · `http:<url>` | fixture = canned + offline; http = live Mnestra webhook (`{op:'recall',…}` → `{ok,hits,tokens_used,text}`). |
| `--answerer` | `stub` · `cmd:<command>` · `anthropic` | stub = non-evidence; cmd = model-agnostic (prompt→stdin, answer←stdout); anthropic = `@anthropic-ai/sdk`, needs `ANTHROPIC_API_KEY`. |
| `--mode` | `reinjection` · `boost` | reinjection = COLD vs WARM (headline). boost = recall_boost off vs on (axis 2; **parks on T1 032 + T2** — needs `<id>.boost-off.json` / `<id>.boost-on.json` fixtures or a boost-aware live endpoint). |

Other flags: `--probes`, `--out`, `--system`, `--session-id`, `--source-agent`,
`--run-id`, `--generated-at`, `--verify-frozen`, `--write-lock`, `--json-only`,
`--md-only`, `--quiet`, `--help`.

## File map

```
scripts/proof/
  cold-vs-warm.js          CLI entry (arg parse → run loop → report)
  lib/
    tokens.js              token accounting, byte-faithful to engram/src/recall.ts
    metrics.js             factKey verdict, source_type mix, aggregate, rankDelta
    recall-adapter.js      fixture | http recall
    answerer-adapter.js    stub | cmd | anthropic
    runner.js              per-probe orchestration (shared by CLI + tests)
    report.js              Markdown + JSON emitters
  fixtures/
    probes.json            the FROZEN probe set (+ probes.lock checksum)
    recall-hits.json       hit content per probe (source of the recall fixtures)
    build-recall-fixtures.js  regenerates recall/*.json THROUGH lib/tokens.js
    recall/<id>.json       canned RecallOutput per probe (offline path)
    README.md              probe selection criteria + provenance
  reports/
    SAMPLE-plumbing-demo.md  committed sample (stub run — the report shape)
```

Tests: `packages/server/tests/proof-cold-vs-warm.test.js` (runs under `npm test`).

## Notes for ORCH close-out

- The proof surface (T4's `/api/recall-events` + Memory tab) and the recall-ON
  path (T1 031) are the live dependencies. Once 031 is applied, run the http
  recall to capture the real, attributed record.
- Provenance caveat (T7 17:02 / T1 G2): this harness supplies caller provenance
  explicitly, so *its* recalls are attributable. The everyday MCP-stdio panel
  path stays NULL until T1 lands a trusted producer — the report says so.
- `--mode=boost` is wired but parked on T1 032 + T2 populating `recall_boost`.
