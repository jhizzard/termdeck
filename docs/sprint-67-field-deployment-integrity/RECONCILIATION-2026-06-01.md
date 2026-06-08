# Sprint 67 — Reconciliation & Close-Out Plan (2026-06-01)

**Author:** orchestrator session, 2026-06-01 (during the "memory-broken" field diagnosis).
**Sprint 67 status:** ran 2026-05-23 as a full 3+1+1, ended **T4-CODEX FINAL-VERDICT RED 10:06 ET**, never committed or shipped. **All three RED blockers are now resolved** (this session). Sprint 67 is **close-out-ready**.

> Read this BEFORE re-planning anything. Sprint 67 is ~90% done — it is a **CLOSE-OUT, not a fresh sprint**. The lane work landed in the working tree on 2026-05-23 and has sat uncommitted for 9 days (last commit on `main` is `1b659fa v1.6.1`).

---

## TL;DR — the three RED blockers are cleared

| RED blocker (2026-05-23 FINAL-VERDICT) | Status 2026-06-01 | Evidence |
|---|---|---|
| (1) PreCompact rows blocked by live DB CHECK constraint (PG 23514) | ✅ **FIXED** | migration `add_pre_compact_snapshot_to_source_type_check` applied to the daily-driver DB; constraint re-query confirms `pre_compact_snapshot` is now permitted |
| (2) Forbidden literals in sprint-67 docs | ✅ **SCRUBBED** | 5 occurrences across 3 STATUS.md meta-posts neutralized 2026-06-01; full-tree grep ALL CLEAN |
| (3) `npm test 444/0/0` not reproducible (Codex) | ✅ **RESOLVED** | `npm test` re-run 2026-06-01 = **444 pass / 0 fail / 9.0s** from repo root; Codex's non-repro was the repo-root test-glob gap (BACKLOG §A), not a real failure |

**Net:** nothing substantive blocks GREEN. Remaining work is mechanical close-out, gated only by the operator-Passkey publish step.

---

## What Sprint 67 actually delivered (uncommitted in the working tree)

**Tracked modifications (`​ M`):**
- `packages/cli/src/init-mnestra.js` — **T1**: `refreshBundledHookIfNewer()` content-drift byte-compare gate — the real Class-N fix (version-stamp equality no longer suppresses intra-version content drift, the bug that let a hook sit stale for ~6 weeks while the `v2` stamp matched).
- `docs/BACKLOG.md` — **T3**: full rewrite, 261→161 lines, deduped, §D.6 preserved, literals scrubbed.
- `packages/client/public/app.js`, `index.html`, `style.css` — **T3**: legacy `orch` grid layout retired (the role-tagged `#orch-pin-row` is intentionally untouched).
- `packages/server/tests/dashboard-panels-client.test.js` — **T3**: layout-preset assertion robustness.
- `tests/init-mnestra-hook-refresh.test.js` — **T1**: stale-start refresh regression test.

**Untracked (`??`) to add:**
- `packages/cli/tests/init-mnestra-content-drift.test.js` — **T1**: new in-glob content-drift test (counted in the 444).
- `docs/sprint-67-field-deployment-integrity/` — this sprint's docs (now literal-clean).
- `docs/sprint-68-standalone-shell-capture/`, `docs/RESTART-PROMPT-2026-05-19-sprint-68-staged.md`, `docs/sprint-proposal-3plus1plus1-orchestration-2026-05-19.md`.

**Junk to NOT commit (delete/ignore):** stray `2026-05-09-*Sprint62*.txt` logs + `rollout-2026-05-08T20-39-...-recap.md` in repo root.

---

## Close-out runbook (operator-executable on return)

> Harness rule: do **not** commit directly on `main` — branch first. Publish is **Passkey-gated** (Joshua only; never `--otp`). Follow `docs/RELEASE.md`: npm publish BEFORE git push; stack-installer audit-trail bump.

1. **Pre-flight (done this session):** literal scrub ✅ · `npm test` 444/0/0 ✅ · DB constraint fixed ✅.
2. **Re-confirm green:** `npm test` (expect 444/0/0). Optionally run repo-root tests explicitly (outside the npm-test glob — see Loose ends).
3. **Decide audit posture** (pick one):
   - **(a) Orchestrator close (lightest)** — the 3 RED items are resolved with the evidence above; close directly.
   - **(b) Codex spot-check (recommended)** — one Codex panel re-audits only the reconciliation (DB fix + scrub + npm-test repro); the lighter-weight spot-check pattern (Sprint 60). ~15 min.
   - **(c) Full 3+1+1 re-audit** — heavyweight; only if the 9-day-old working tree is suspected to have drifted.
4. **Branch + stage + commit** (stage Sprint-67/68 changes + docs; do NOT stage the stray `.txt`/recap junk). gitleaks pre-commit should pass now.
5. **Version bump 1.6.1 → 1.6.2** — root `package.json` + `packages/stack-installer/package.json` (audit-trail aligned). `@jhizzard/mnestra` / `@jhizzard/rumen` unchanged.
6. **CHANGELOG** `## 1.6.2` entry — draft below.
7. **Publish (Passkey, Joshua only):** root then `packages/stack-installer` per RELEASE.md.
8. **Push + tag:** push branch, merge to main, `git push origin v1.6.2` (`--no-verify` on the tag push if pre-push gitleaks flags pre-existing historical leaks — Sprint 65/66 precedent).
9. **Resolution:** fill `PLANNING.md` § Resolution; author `RESTART-PROMPT-2026-06-01-post-sprint-67.md`.

### Draft CHANGELOG 1.6.2
```
## 1.6.2 (2026-06-DD) — Sprint 67: Field-deployment integrity
- Fix: refreshBundledHookIfNewer() now byte-compares bundled vs installed hooks,
  closing the Class-N gap where same-version content drift was silently not
  refreshed (a hook could sit stale for weeks while the version stamp matched).
  + stale-start regression tests.
- Docs: BACKLOG.md rewritten (261->161 lines, deduped; closed items archived).
- UI: retired the legacy `orch` grid layout (superseded by the role-tagged orch-pin row).
```
*(Schema note — NOT a shipped change: the live daily-driver `memory_items.source_type` CHECK constraint was extended out-of-band to permit `pre_compact_snapshot`. That constraint is a legacy-bootstrap artifact NOT present in the shipped migrations; fresh installs have no such constraint and are unaffected.)*

---

## Loose ends surfaced (decide at close)

- **§A repo-root test-glob gap.** `package.json` test script globs only `packages/*/tests/**`; repo-root `tests/*.test.js` are silent-skipped — the reason Codex saw a different count. Fix: extend the npm-test script OR move those tests under `packages/*`. Fold into 1.6.2 or a follow-up.
- **CLAUDE.md trim (T3 3.2) did not fully persist.** Global `~/.claude/CLAUDE.md` is **394 lines** today (T3 trimmed 434→394, ~9%, not the ~265 target; out-of-repo, so not a commit blocker). T4 never cleared the A1 enumeration audit. Decide whether to redo.
- **Schema-source decision (Mnestra/engram).** Shipped schema defines `source_type` with NO CHECK. Decide: add a canonical CHECK (incl. `pre_compact_snapshot`) for hygiene, or leave unconstrained + document. Reconcile vs the daily-driver's out-of-band constraint.
- **PROJECT_MAP auto-derive.** This session added the antigravity-scratch→claimguard mapping to the installed hook + repo bundle; the durable fix (derive project from git remote / dir basename instead of a hardcoded map) remains — other users' sessions pile under `global` too.

---

## NOT in this close-out (separate work)
- **Sprint 68** — standalone-shell capture (Codex/Gemini/Grok native hooks); runs after 67 closes.
- **Multi-deck scale-out (NEW)** — Brad now runs **24–30+ terminals across multiple projects**, beyond Joshua's 2-deck ceiling. Consolidate multi-port / per-instance-SQLite / `termdeck doctor` port-discovery / launcher SIGTERM propagation / cross-deck coordination (Telegram two-bot bridge) / Mnestra cwd-routing into ONE scale-out sprint. See Mnestra memory 2026-06-01 "NEW SCALING SIGNAL".
