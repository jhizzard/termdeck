# TermDeck / Mnestra / Rumen Coverage-Gap Sprint — Shareable Brief

**Authored:** 2026-05-08
**For:** the next TermDeck sprint that Joshua is about to kick off (likely Sprint 62 or sub-sprint of 61).
**Origin repo:** `gorgias-ticket-monitor` (ClaimGuard) — gap surfaced during Sprint 8.0 ClaimGuard Pipeline Compliance Audit.
**TermDeck repo target:** `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/reports/sprint-NN-mnestra-session-end-coverage/PLANNING.md`

This brief is self-contained — paste any section directly into a TermDeck panel.

---

## 1. The headline finding

The Mnestra session-end writer hook only fires for **Claude Code** sessions. When Joshua fired `/exit` in three Codex / Gemini / Grok TermDeck panels post-Sprint-8.0, the CLIs exited gracefully but **zero `session_summary` rows landed in Mnestra**. The Sprint 8.0 lane work (~50 KB of findings + Python prototype scripts + an §20.4-schema bias_audit_report.json) is durable on disk but invisible to `mcp__mnestra__memory_recall` until either manual capture OR a TermDeck product fix.

This is not a Sprint-8.0-specific issue — it has been silently underwriting Mnestra since the Sprint 38 hook rewrite (which only addressed Claude Code) and amplified by the Sprint 45 adapter additions (Codex / Gemini / Grok adapters store session JSONL but don't trigger writes).

## 2. Evidence (taken 2026-05-08 from `mcp__mnestra__memory_status`)

```
Total active memories:    6,474
Sessions processed:         359
session_summary memories:    97   ← 27% coverage; the missing 73% are non-Claude-Code panels
```

Three nested problems:

1. **Adapter session-end → no Mnestra write.** Codex (`~/.codex/sessions/`), Gemini (`~/.gemini/...`), Grok (`~/.grok/...`) store session JSONL files but `/exit` does not call `mnestra-bridge.embedAndWrite`. The Sprint 38 hook (`packages/stack-installer/assets/hooks/memory-session-end.js`) is wired exclusively to Claude Code's `SessionEnd` event.

2. **Project-tag drift.** Same ClaimGuard project tagged THREE ways across history:
   - `claimguard` — 29 rows (newest tag)
   - `gorgias-ticket-monitor` — 245 rows (middle tag, the repo's actual git remote name)
   - `gorgias` — 541 rows (oldest tag)
   Per existing memory: "Sprint 21 T2's gorgias→claimguard rename never landed in `memory_items` table — flagged for T1/T4 but not in v0.7.2 scope". The rename was scoped-out and never finished. Result: `memory_recall(project="claimguard")` misses ~88% of project history.

3. **Source-agent silent drop.** Per Mnestra's `memory_recall` tool docstring: "NULL-source-agent rows (historical, pre-Sprint-50) are excluded when this filter is set." Sprint 50 introduced `source_agent`. Pre-Sprint-50 rows have `source_agent = NULL` and are silently dropped from filtered queries — likely 3,000+ rows invisible.

## 3. Sprint 8.0 lanes that produced no Mnestra row (until orchestrator manually captured)

Three panels, all `/exit`'d cleanly, all produced substantive outputs, all left zero session_summary rows:

| Lane | Output file (durable on disk) | What was lost from Mnestra |
|---|---|---|
| T2-Codex | `T2-CODEX-PIPELINE-FINDINGS.md` (27 KB) | 14-stage compliance matrix, 8 evidence-backed findings, V13.X cross-references, draft V14.X new entries |
| T3-Gemini-3.1-Pro-Preview | `T3-GEMINI-REGISTRY-FINDINGS.md` (11 KB) | §18 Violations Registry walk, §22 Data-Prep Registry refresh, §19 Regulatory Mapping audit, charter v0.7→v0.8 amend candidates |
| T4-Grok | `T4-GROK-BIAS-RUNTIME-FINDINGS.md` (4 KB) + `bias_audit_report.json` (5 KB) + Python prototypes | 8 parallel subagent reports, §20 trigger run results, live_claim audit (0 annotations found), §17 freshness verification |

The orchestrator manually captured all three lanes' summaries via `mcp__mnestra__memory_remember` post-discovery — the four memory texts are appended in §6 below.

## 4. Proposed TermDeck Sprint scope (3+1+1)

### T1 — Adapter session-end Mnestra writer

**Mission:** wire Codex / Gemini / Grok adapter `/exit` events to Mnestra `session_summary` writes.

**Surfaces:**
1. Audit each adapter's session-close mechanism (graceful `/exit`, SIGTERM on panel close, JSONL-no-longer-appended).
2. Author per-adapter `memory-session-end-<adapter>.js` (or unify under one filesystem watcher) that detects close, reads transcript, calls `mnestra-bridge.embedAndWrite` with `source_type=session_summary`, `source_agent` set to adapter name, project resolved via PROJECT_MAP.
3. Test against synthetic + real Codex sessions; verify a single row lands per `/exit`.
4. Ship in `packages/stack-installer/assets/hooks/`.

**Acceptance:** session_summary count : sessions processed ratio rises from 27% to >80%.

### T2 — Project-tag canonicalize migration

**Mission:** finish the Sprint 21 T2 `gorgias` + `gorgias-ticket-monitor` → `claimguard` rename.

**Surfaces:**
1. Author migration `0NN_project_tag_canonicalize_claimguard.sql`: `UPDATE memory_items SET project = 'claimguard' WHERE project IN ('gorgias', 'gorgias-ticket-monitor')` (with appropriate scoping per existing project-tag-invariant tests).
2. Verify the 4 existing content-vs-tag invariant tests stay green.
3. Update PROJECT_MAP in the hook so future writes from `gorgias-ticket-monitor` CWD also tag as `claimguard`.

**Acceptance:** `memory_recall(project="claimguard")` returns all ~815 historical rows (29 + 245 + 541 minus invariant violators).

### T3 — Source-agent backfill

**Mission:** backfill `source_agent` for pre-Sprint-50 rows where inferable; document residuals.

**Surfaces:**
1. Predicate-based backfill SQL: `session_summary` rows from JSONL path; orchestrator-authored `decision`/`bug_fix` rows likely `claude` or `orchestrator`; conservative — leave residuals NULL with documented reason.
2. Update `memory_recall` tool description to remove "silently excluded" semantics OR add `include_null_source` flag.
3. CHANGELOG entry documenting which rows were backfilled vs left NULL.

**Acceptance:** NULL-source-agent rows < 5% of corpus.

### T4-CODEX — Independent auditor

**Mission:** verify T1 fires on actual `/exit` (not false-positive on JSONL rotation); T2 migration is reversible + RLS-respecting; T3 backfill doesn't create cross-tenant leakage. Spot-check three different projects (claimguard, pvb, termdeck-dogfood).

### Orchestrator (Claude Opus, separate session)

Standard close-out: CHANGELOG + BACKLOG + version bumps (mnestra + termdeck + termdeck-stack as needed) + Passkey npm publish + `git push origin main` after Codex GREEN.

## 5. Where to point the TermDeck sprint

```
~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/
  reports/
    sprint-62-mnestra-session-end-coverage/   ← new
      PLANNING.md  ← copy this brief into here as kickoff
```

(Substitute the next free sprint number — likely 62 if Sprint 61 is the most recent shipped per existing Mnestra memories.)

## 6. The four memories captured in Mnestra during this discovery (verbatim, for reference)

The orchestrator captured these via `mcp__mnestra__memory_remember` after discovering the gap. Including them here so the TermDeck sprint has the full Sprint 8.0 context in one place:

### Memory 1 — Mnestra session-end coverage gap (project=termdeck, source_type=bug_fix, category=architecture)

> Mnestra session-end coverage gap (discovered 2026-05-08 post-Sprint-8.0 ClaimGuard pipeline audit). Joshua fired /exit in three TermDeck panels (Codex/Gemini/Grok) running Sprint 8.0; expected three session_summary rows; got zero. Three-part gap: (1) the ~/.claude/hooks/memory-session-end.js hook only fires on Claude Code SessionEnd events, NOT on Codex/Gemini/Grok adapter session-close — Sprint 45 added the adapters at ~/.codex/sessions/, ~/.gemini/..., ~/.grok/... but never wired the writer; (2) project-tag drift: same ClaimGuard project tagged 3 ways across history — claimguard (29 rows, newest), gorgias-ticket-monitor (245 rows), gorgias (541 rows) — Sprint 21 T2 gorgias→claimguard rename was scoped-out per existing memory; (3) source_agent silent drop: pre-Sprint-50 rows have source_agent=NULL and are silently excluded from filtered recall queries. Total impact: memory_status shows session_summary count=97 across all projects vs 359 sessions processed = 27% coverage. Full report at reports/sprint-8.0-pipeline-audit/MNESTRA-SESSION-END-COVERAGE-GAP.md (the gorgias-ticket-monitor repo). Should be next TermDeck sprint (likely Sprint 62) targeting termdeck repo at ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck. Proposed 3+1+1 lanes: T1 per-adapter session-end writer; T2 project-tag canonicalize migration; T3 source_agent backfill SQL; T4-CODEX auditor. Closes coverage gap that has been silently underwriting Mnestra since Sprint 38 hook rewrite (which only addressed Claude Code).

### Memory 2 — Sprint 8.0 T2-Codex pipeline lane (project=claimguard, source_type=decision, category=technical)

> Sprint 8.0 ClaimGuard Pipeline Compliance Audit (vs ML Methodology Charter v0.7) — T2-CODEX lane summary 2026-05-08 18:50 ET. Verdict SHIP-MATRIX. 14-stage compliance count: 2 LIVE / 5 PARTIAL / 7 VIOLATED / 0 DEAD-CODE. 8 findings authored: T2-S8-F1 PII redaction CRITICAL absent from hot path (V13.3) — src/lib/ingestion.ts:229-233 builds raw fullText then sends to generateEmbedding(:323), analyzeTicketForKeywords(:478), evaluateSeverityForOrg(:542), batchGenerateEmbeddings(:671) without redactPII; F2 centroid splits HIGH (V13.1, V13.13) — train_classifier.ts:170-192 fits + validates on same examples; F3 conformal calibration HIGH (V13.2, V13.7, V13.14, V13.15) — production has RAG, calibration has no RAG (calibrate_conformal.ts:346-361); F4 Platt scoring-source HIGH (V13.10) — run-platt-fit.ts:298-340 fits on contaminated centroid scores, no manifest spec; F5 anomaly methodology HIGH (drafted V14.1) — anomaly.ts threshold from training set, no one-class SVM/isolation forest baselines; F6 MMD bursty falsifier HIGH (drafted V14.2) — drift-detector.ts:232-265 persists MMD only, no daily_std/daily_mean>1.5 trigger; F7 federated MED (V13.5, V13.11) — 0 contributors, no 3-tenant gate; F8 eval-run CI gate machinery absent MED — no scripts/audit-eval-run-id.ts, classifier_model.json lacks methodology_version. Output: reports/sprint-8.0-pipeline-audit/_owned/T2-CODEX-PIPELINE-FINDINGS.md (27 KB).

### Memory 3 — Sprint 8.0 T3-Gemini registry walk (project=claimguard, source_type=decision, category=workflow)

> Sprint 8.0 ClaimGuard Pipeline Compliance Audit — T3-GEMINI registry walk 2026-05-08 19:15 ET. Verdict NEEDS-V0.8-CHARTER-AMEND. §18 walk: 1 CLOSED (V13.12 anomaly addendum, closed by v0.7 §9.7) / 14 OPEN / 0 SILENTLY-FIXED — registry tracks reality, no drift. Each existing V13.X verified against current code (V13.1 train=test still in train_classifier.ts:182-192; V13.2 RAG mismatch confirmed; V13.3 PII redactPII absent from hot path; V13.4 cost-cascade gate covers 3/8 stages; V13.5 federated not wired; V13.6 single tenant; V13.7 cron not scheduled; V13.8 no pre-registration; V13.9 hash-mod-20 holdout not implemented in training-corpus.ts:333-342; V13.10 Platt scoring-source open; V13.11 federated privacy overclaim; V13.13 frozen JSON model lacks provenance; V13.14 prompt not version-locked; V13.15 SLM endpoint swap unprotected). §22 row drift candidates: §9.5 says 101 TP/101 FP but data/classifier_model.json has 124/124; §9 MMD-RFF "YES Compliant" contradicted by T2-S8-F6 finding. §19 Regulatory Mapping: no label changes — all NAIC + NIST labels remain accurate. Charter amend candidates for v0.8: V14.1 (anomaly impl noncompliance) + V14.2 (MMD bursty omission) drafted by T2 for promotion. Output: reports/sprint-8.0-pipeline-audit/_owned/T3-GEMINI-REGISTRY-FINDINGS.md (11 KB).

### Memory 4 — Sprint 8.0 T4-Grok bias audit (project=claimguard, source_type=decision, category=technical)

> Sprint 8.0 ClaimGuard Pipeline Compliance Audit — T4-GROK §20 bias + runtime audit 2026-05-08 19:15 ET. Verdict NEEDS-V0.7-CHARTER-AMEND. 8 parallel subagents dispatched; 8/8 delivered. §20 trigger results: 7 PMI proxy triggers (construction/family terms PMI>1.0, no smoothing-sensitivity flips at pseudocount {0.5,1,2} per Bouma 2009); subgroup-gap BCa DATA-UNAVAILABLE (Customer/Ticket/Alert tables at prisma/schema.prisma:169/187/235 lack state, industry, age_bracket fields); 3 counterfactual divergence triggers (cosine median 0.095>0.05, Platt-prob 0.109>0.05, set-symmetric-difference 1>0; class-flip and rank-delta did NOT trigger); 2 MMD bursty windows on synthetic 30-day series. live_claim audit: ZERO annotations across the entire codebase — every "live"/"in production"/"wired" claim in CLAUDE.md, ingestion.ts, vercel.json crons fails §3.3 rule 8 reachability-with-annotation. §17 References: 5/5 spot-checked DOIs resolve. Production data unavailable — synthetic 50-row manifest used (41 FP / 9 TP, [REDACTED-NAME] PII redaction confirmed per §11.5). Outputs: reports/sprint-8.0-pipeline-audit/_owned/T4-GROK-BIAS-RUNTIME-FINDINGS.md (4 KB) + bias_audit_report.json (5 KB, §20.4 schema-compliant) + compute_pmi_subagent_b.py + compute_counterfactual_subagent_d.py. 10 triggered_flags total. Cross-lane convergent with T2-S8-F1 PII finding + T3 V13.3.

## 7. Closing reasoning for the TermDeck reviewers

Mnestra is the project's institutional memory. Right now it's writing only the orchestrator's view (Claude Code sessions), missing the per-lane DETAIL — the file:line evidence Codex digs up, the verbatim citations Gemini extracts, Grok's parallel-subagent reports. Multi-lane sprints currently rely on the orchestrator's post-sprint integration to land any record at all, and even then the rich per-lane evidence is summarized away. Closing this coverage gap means future Claude Code sessions can `memory_recall` a Codex finding directly — including its file:line + grep evidence + KILL/CHANGE/CONFIRM verdict — without needing the orchestrator's interpretation.

The same disciplines apply here that the ClaimGuard methodology charter §3.2 requires for ML claims: every reported number needs a reproducible artifact. Per-lane Mnestra writes ARE the reproducible artifact for sprint findings.
