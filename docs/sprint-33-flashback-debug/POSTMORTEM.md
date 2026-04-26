# Flashback silence — postmortem

**Sprint 33 — Flashback debug · 4+1 orchestration**
**Date:** 2026-04-26 (sprint opened 21:25Z, lanes converged 21:49Z — ~25 min wall)
**Author:** T4 (synthesis) · audits by T1 / T2 / T3
**Build under test:** `@jhizzard/termdeck@0.7.0` (commit 41170ae) against live Mnestra (petvetbid, 4,889 memory_items)

---

## What was reported

> "It is almost as if Flashbacks are vaporware. They never happen, never any suggestions."
> — Josh, 2026-04-26

Flashback is the headline feature: when a panel hits an error, similar past memories should pop as a toast within ~1s. The pipeline shipped end-to-end in Sprint 10, was patched in Sprint 21 (the famous queryDirect 8-arg RPC fix, silent for 15 sprints), and was assumed working since v0.4.5. Josh reported it had gone silent again — no toasts, no suggestions, even on errors with obvious historical matches in his 4,889-row store.

`tests/flashback-e2e.test.js` reproduces the silence cleanly: the pipeline test (`error in PTY → output analyzer → mnestra-bridge query pipeline fires`) times out at 8.6s waiting for a `status_changed→errored` row in `rag_events`. The bridge contract test (`mnestra bridge returns well-shaped response when there are zero hits`) passes — so Sprint 21's fix held; this is something else.

## What was found

| Lane | Verdict | One-line diagnosis |
|------|---------|---------------------|
| **T1** — analyzer / error detection | **BROKEN-AT** | `PATTERNS.error` regex does not match the most common Unix shell-error shape (`<cmd>: <path>: No such file or directory`). The session.js comment block claims coverage; the regex doesn't enforce it. |
| **T2** — bridge wiring + WS emit | **CONFIRMED-OK** | RAGIntegration unconditional, `onErrorDetected` wired at index.js:781, queryDirect builds the 8-key body, bridge contract test green, proactive_memory frame emit checks `readyState===1`. Bridge layer is intact end-to-end. |
| **T3** — Mnestra query path | **BROKEN-AT** | Project-tag regression: `chopin-nashville` accumulated 1,126 rows of TermDeck content vs `termdeck` at 68. The strict `WHERE project = filter_project` clause in `memory_hybrid_search` then walls TermDeck panels off from their own memories. Sprint 21 T2 was supposed to fix this; the fix never landed in the writer (or regressed). |
| **T4** — e2e probe + synthesis | **BROKEN-AT analyzer** (Phase A) | Instrumentation captured the canonical reproduction: bash emits `cat: /nonexistent/file/path: No such file or directory` cleanly at 521ms; analyzer flips status `active → idle`, never `errored`; zero `proactive_memory` frames; no `error_detected` rag_event. Confirms T1 from the e2e angle. |

## Root cause

**Two independent, converging bugs were both required for the silence Josh observed.**

The dominant cause for the e2e test (and for any error chunk that doesn't start with a structured `Error:` / `Traceback` / `npm ERR!` keyword) is **T1's regex coverage gap.** A line like `cat: /nonexistent/file/path: No such file or directory` carries the human-readable phrase mid-line, prefixed by `<cmd>: <path>:`. The current `PATTERNS.error` matches only structured prefixes (Error / error / Traceback / npm ERR! / error[Ennn] / Uncaught Exception / Fatal). The mid-line "No such file or directory" / "Permission denied" / "command not found" / "Could not resolve host" / "Segmentation fault" shapes — which dominate real terminal usage — silently miss. The session.js comment promises coverage of these, but only `PATTERNS.errorLineStart` (Claude Code's variant) carries the phrase, and it's `^\s*` line-anchored, so even there a `<cmd>: <path>:` prefix prevents the match. Pure documentation-is-not-verification: a known gap stayed in the comment and was never enforced by code.

The contributing cause for Josh's day-to-day silence (even on the rare error shape the analyzer DOES match) is **T3's project-tag regression.** TermDeck's `resolveProjectName` (suspected: deepest-config-path-segment match against `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`) lands on the `chopin-nashville` ancestor before reaching the `termdeck` leaf. Rumen synthesis then writes 200+ TermDeck-content rows per week to `project='chopin-nashville'`. The bridge sends `filter_project='termdeck'` for any panel with `meta.project='termdeck'`; `memory_hybrid_search` strictly equality-filters; the 1,126 chopin-nashville-tagged TermDeck rows are walled off; the 68 surviving `termdeck` rows are mostly version-history postmortems and don't match operational error queries. So even on error shapes the analyzer catches today, the toast content would be near-useless.

The interaction is asymmetric: **T1's bug bites the e2e test AND Josh's daily workflow.** T3's bug bites only Josh — not the e2e test, because the e2e test creates a freshly-spawned `bash` session with `meta.project=null`, which T2 noted causes the bridge to drop to `filter_project=null` (search-all). Search-all sidesteps T3's wall and surfaces the chopin-nashville-tagged content as if it were correctly filed. So T1's fix alone makes the e2e test green; T3's fix is independently required for Josh to see useful toast content on real workflows.

## Fix

**Status as of POSTMORTEM write: nothing committed, nothing shipped.** Three uncommitted FIX-PROPOSED entries on STATUS.md, awaiting orchestrator integration:

1. **T1 — analyzer regex gap** (`packages/server/src/session.js` +14 LOC, `tests/analyzer-error-fixtures.test.js` +48 LOC).
   Add `PATTERNS.shellError` with branches for: `<cmd>: <path>: (No such file or directory|Permission denied|Is a directory|Not a directory|command not found)`, `curl: (NN) Could not resolve host`, `ModuleNotFoundError:`, `Segmentation fault`, lowercase `fatal:`. Update `_detectErrors` to fall through to `shellError` when the primary `PATTERNS.error` misses. Adversarial prose suite locks in: 10 SHOULD_TRIGGER fixtures + 7 SHOULD_NOT_TRIGGER prose fixtures (so Claude Code panels narrating "no such file or directory" don't false-positive). Net test impact is positive — `'zsh: command not found: kubectl'` flips from red to green; no previously-green test breaks.

2. **T3 — Mnestra project-tag backfill** (~10 LOC SQL, dry-run gate recommended).
   ```sql
   UPDATE memory_items SET project = 'termdeck'
    WHERE project = 'chopin-nashville'
      AND (content ILIKE '%termdeck%' OR ILIKE '%mnestra%' OR ILIKE '%rumen%'
           OR ILIKE '%flashback%' OR ILIKE '%xterm.js%' OR ILIKE '%node-pty%'
           OR ILIKE '%@jhizzard/%');
   ```
   Run `SELECT count(*)` first, post the count to STATUS, then `UPDATE`. Reversible via `superseded_by` if any row mis-classifies.

3. **T3 — upstream writer fix** (`packages/server/src/rag.js`'s `resolveProjectName`, plus Rumen extract-stage tagging).
   Without this, the backfill repeats every day. Targeted audit: confirm `resolveProjectName` walks the path **leaf-first** (deepest match first), not ancestor-first, against config.yaml's known projects. Same logic needs to live in Rumen's synthesis path. T2's CONFIRMED-OK was scoped to bridge wiring; project-resolution is a separate function that didn't get audited then.

**T4 (this lane) shipped one piece in-place, uncommitted:** Phase A instrumentation in `tests/flashback-e2e.test.js`. The instrumentation is test-only (no source touched), captures WS-frame timeline + `session.meta` samples + all rag_events for the session + a transcript snapshot, and dumps a labeled diagnostic block when the assertion fails or succeeds. Without this, Sprint 33 would have spent a full debug pass guessing which layer broke; with it, the next regression of any layer surfaces in the diagnostic dump, named.

## Why it stayed silent

Three reinforcing reasons the silence persisted from Sprint 21 (v0.4.5) through v0.7.0:

1. **The contract test passed.** `tests/flashback-e2e.test.js`'s second test (`mnestra bridge returns well-shaped response when there are zero hits`) hits `/api/ai/query` directly and bypasses the analyzer. It went green every CI run. The pipeline test was the failing one, but it's marked to skip when Mnestra is unreachable, and CI typically lacks a live Mnestra — so it skipped silently in CI for sprints on end. Sprint 21's lesson ("don't trust test pass without a real-corpus probe") was not internalized into a `npm run test:flashback-live` gate.

2. **The analyzer comment lied.** session.js:64-67 documented coverage of `cat`/`ls`/`cd`/`rm` ENOENT in plain English, citing a 2026-04-15 Rumen insight. The regex itself was never updated to add the phrase. Anyone reading the comment would have moved on; only the code-vs-comment audit T1 ran today caught the divergence.

3. **The project-tag bug got laundered through Rumen.** Rumen synthesizes new memories every 15 minutes and writes them with whatever project the session emitted. As long as TermDeck sessions kept emitting `project='chopin-nashville'`, the corpus gradually filled with the wrong tag. The mis-tag wasn't observable from the TermDeck UI (which never asks "what project is this row tagged?"), only from a direct SQL probe of the live store. Sprint 21 T2's writer fix either didn't land or got reverted; the regression was invisible until T3 ran the pivot today.

The structural lesson: silent test skips + an unenforced comment + an invisible upstream tag-drift add up to a feature claimed to work and silently shipping vaporware for ~5 sprints.

## Regression defense

**Already landed (T4 Phase A — uncommitted, in `tests/flashback-e2e.test.js`):** the instrumentation block converts a black-hole timeout into a labeled, fault-isolating diagnostic. Future Flashback breakage will report exactly which of [bash spawn / WS open / input post / bash output / analyzer status flip / rag_events insert / proactive_memory frame] fell over. This alone would have made the original Sprint 21 ↔ now five-sprint gap impossible.

**Recommended for next sprint (Sprint 34) when integrating fixes:**

1. **Add an analyzer-shape matrix test to `tests/flashback-e2e.test.js`** that creates one bash session per error shape (cat ENOENT, ls cannot access, bash command not found, curl resolve, python ModuleNotFoundError, segfault) and asserts the `status_changed→errored` row appears for each. Catches future `PATTERNS.error` coverage regressions live, not just at the unit-fixture level.
2. **Add a project-tag invariant probe** (Mnestra-side, runnable locally): `SELECT project, count(*) FROM memory_items WHERE content ILIKE '%termdeck%' GROUP BY 1 ORDER BY 2 DESC` — assert `termdeck` is the top project, not `chopin-nashville`. Could ship as a quarterly Rumen audit job rather than a per-CI test.
3. **Promote the contract test from "skip when Mnestra unreachable" to "fail loud when Mnestra unreachable."** Or: keep the skip, but ship a separate `npm run test:flashback-live` script that Josh runs locally after every `npm publish`. The skip-on-no-mnestra default is what let the pipeline test go silent for 5 sprints.
4. **Track the analyzer's claimed-vs-actual coverage in code, not in a comment.** A `tests/analyzer-coverage.test.js` that asserts `PATTERNS.error` and `PATTERNS.shellError` collectively match every shape in a documented list, parsed from a fixtures file. Comment drifts; tests don't.

## Timeline

| Time (Z) | Event |
|----------|-------|
| 21:25 | Sprint opened. PLANNING.md + four briefings written. |
| 21:38 | Orchestrator pre-sprint intel: pipeline test fails at 8.7s, contract test passes. |
| 21:40–21:43 | T1, T2, T3 CLAIM their lanes. |
| 21:43 | T2 FINDING — CONFIRMED-OK (bridge intact) + minor `cwd` observation. |
| 21:43 | T2 DONE. |
| 21:43 | T4 CLAIM tests/flashback-e2e.test.js for Phase A instrumentation. |
| 21:46 | T3 FINDING — BROKEN-AT project-tag regression; FIX-PROPOSED backfill SQL + writer audit; DONE. |
| 21:46 | T1 FINDING — BROKEN-AT analyzer regex gap; FIX-PROPOSED PATTERNS.shellError + fixtures; DONE. |
| 21:48 | T4 FINDING — Phase A instrumentation captures the analyzer-skips-errored signal directly. T4 DONE Phase A. |
| 21:49 | T4 writes POSTMORTEM.md (this document). Phase B complete. |

Wall clock: 24 minutes from sprint open to converged diagnosis. Two independent bugs found, three uncommitted surgical fixes proposed, one regression-defense instrumentation landed.

## Decision needed (orchestrator)

This sprint's output is diagnosis + uncommitted fixes. Three options for what ships next:

- **A — bundle everything as v0.7.1.** T1 src+tests, Phase A instrumentation, optionally T2's `cwd` one-liner. Backfill SQL + Rumen writer audit slip to Sprint 34 (they're not packaged in npm anyway). Lowest-risk patch, smallest blast radius.
- **B — split.** v0.7.1 = T1 fix + T4 instrumentation (the e2e-test-greens-up patch). Sprint 34 = T3 backfill + writer fix. Cleaner narrative, two release-notes events.
- **C — Sprint 34 ships everything together** as v0.8.0 with proper writer-side `resolveProjectName` audit and a Rumen tagging fix landed as well. Higher confidence but slower to relieve Josh's silence.

T4 recommendation: **Option A.** Josh's complaint is "Flashback never fires"; T1's fix moves the pipeline from 0% → ~80% (the analyzer now catches the shapes that dominate real usage); T3's fix is about *content quality* of the toast, which we can iterate on in Sprint 34 without leaving Josh in vaporware-land for another release cycle.
