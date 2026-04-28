# Sprint 41 — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

## Pre-sprint context (orchestrator, 2026-04-28 morning)

- **chopin-nashville is NOT a code project.** It's a directory containing 30+ subdirectories, mostly non-code (Performances/, Sponsors/, Media/, JoshPhotos/, etc.). The current PROJECT_MAP regex `/ChopinNashville|ChopinInBohemia/i` matches every cwd under that tree, polluting the chopin-nashville tag with content from TermDeck, ClaimGuard, Chopin in Bohemia, the SchedulingApp, etc.
- **Post-Sprint-39 baseline:** 947 rows still tagged chopin-nashville. Sprint 39 T3's content-keyword backfill caught 192 rows (1,139 → 947). Sprint 41 finishes the job with: T1 new taxonomy, T2 broader deterministic re-tag, T4 LLM classification of residue.
- **Acceptance:** chopin-nashville count drops from 947 → < 100 (only legitimate competition-management work). Termdeck, podium, claimguard, etc. all climb correspondingly.
- **Joshua's roadmap after Sprint 41:** 1-2 ClaimGuard-AI sprints → Chopin in Bohemia → re-start Maestro. The taxonomy fix MUST land before the project switches or the junk drawer re-pollutes.
- **Bonus lane:** T3 fixes the graph-view UX bug where "Loading graph…" + "No memories yet" overlays render simultaneously over visible nodes. Adds an "All projects" picker option.

Format:
```
## T<n> — <lane name>

### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
```

---

## T1 — Project taxonomy authoring + PROJECT_MAP overhaul

_(awaiting first entry)_

---

## T2 — Re-tag migration with new taxonomy

_(awaiting first entry)_

---

## T3 — Graph empty-state UX fix + "All projects" picker

_(awaiting first entry)_

---

## T4 — LLM-classification of residual uncertain rows

_(awaiting first entry)_
