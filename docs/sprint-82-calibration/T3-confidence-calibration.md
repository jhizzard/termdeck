# T3 — Confidence recalibration: fix the ceiling, fit Platt on real telemetry, surface a calibrated score

**Working dirs:** `~/Documents/Graciella/rumen` (ceiling fix) + `~/Documents/Graciella/engram` (calibration constants + recall output). Coordinate with T1 via STATUS.md — you both touch engram TS; your files are NEW (`src/calibration.ts`) plus a small additive patch to recall output that T1 is also touching for `semantic_similarity`. Sequence: land your engram edits AFTER T1 posts SCHEMA-READY, rebasing on their TS changes if both touch `src/recall.ts` (talk via STATUS posts, not guesswork).

## Part A — the wrong constant (small, do first)

`rumen/src/confidence.ts:26-47`: `normalizeSimilarity` maps `[RRF_FLOOR=0.01, RRF_CEILING=0.3] → 0..1`. The DEPLOYED ceiling is ~**0.075** (live telemetry max 0.074 over 38.8k rows; theory: `2/61 × 1.5 × 1.5`). Result: normalized similarity saturates around 0.22 — the Sprint 81 "THING 1" recalibration is numerically inert. Fix: ceiling → 0.075 (name the constant for what it is — the deployed RRF band max — with a comment deriving it), bump `NORMALIZE_VERSION`, update every test that pins the old band, add a test asserting a live-p50-like input (0.0216) lands mid-band, not near-floor. `npm test` green in rumen.

## Part B — Platt calibration on the 38.8k labeled rows

The daily-driver's `memory_recall_log` (engram migrations 027/031) carries per-recall telemetry INCLUDING outcome labels (`cited` auto-population shipped Sprint 81; flashback funnel adds clicked/dismissed). That's a real training set nobody has fit.

1. **Script:** `engram/scripts/calibration/fit-platt.ts` (or .js, match repo conventions) — reads `memory_recall_log` over `DATABASE_URL` (READ-ONLY: SELECTs only), features: raw RRF score, rank position, source_type, age-at-recall, surface; label: cited/clicked (positive) vs surfaced-only/dismissed (negative). Fit logistic (Platt) — no ML deps; hand-rolled IRLS or gradient fit is fine at this size. Emit: coefficients, AUC/Brier on a held-out split, class balance, n. Write the human-readable report to `engram/docs/calibration-report-2026-07-30.md`.
2. **Run it against the live store, read-only.** Credentials: `~/.termdeck/secrets.env` has `DATABASE_URL` (source it; never print or commit values). If the pooler refuses or the table shape surprises you, post `### [T3] FINDING` with the discrepancy — do not guess.
3. **Constants:** `engram/src/calibration.ts` — exported fitted coefficients + `calibrateScore(features) → p_useful ∈ [0,1]` + `CALIBRATION_VERSION`. Deterministic, no runtime DB access.
4. **Wire-in (additive):** recall/search output gains `score_calibrated` when `calibration.ts` constants exist — alongside, never replacing, the raw score and T1's `semantic_similarity`. Do NOT change ranking/ordering with it this sprint (display-only; ranking changes need their own sprint + eval).
5. **Tests:** calibration function is monotonic in raw score for fixed features; version bump asserted; recall output includes the field.

## Boot + discipline

Boot: `memory_recall(project="termdeck", query="Sprint 82 calibration Platt telemetry recall log")`, `memory_recall(query="confidence normalizeSimilarity RRF ceiling")`, read `~/.claude/CLAUDE.md`, termdeck `./CLAUDE.md`, sprint `PLANNING.md` + `STATUS.md`, then this brief. Stay in lane (rumen + your named engram files only; no termdeck server/client, no migrations). Post `### [T3] <VERB> 2026-MM-DD HH:MM ET — <gist>`: FINDING / FIX-PROPOSED / FIX-LANDED / DONE. No version bumps, no CHANGELOG, no commits, no live-DB writes (SELECTs only).
