# Sprint 51.6 — Mini-sprint: Fix bundled session-end hook (memory_sessions branch + post-mig-015 verification)

**Status:** Mini-sprint authored 2026-05-03 19:18 ET in response to live psql probe revealing TWO independent bugs (not one) in the bundled session-end hook. Orchestrated from the active Sprint 51.5 wrap terminal (heavy context preserved). Target ship: v1.0.2 wave (termdeck@1.0.2 + termdeck-stack@0.6.2 + possibly mnestra@0.4.2 if mnestra-side change needed; rumen unchanged).

**This is a mini-sprint** — 4 lanes, tight scope, no new features, no architecture changes. Diagnose two bugs, fix both, ship v1.0.2, verify via row-count growth on petvetbid.

## Why this sprint (in two paragraphs)

Sprint 51.5 shipped v1.0.1 audit-upgrade + mnestra doctor + GRAPH_LLM_CLASSIFY + Class J. Mid-sprint, Codex's chopin-in-bohemia memory dump surfaced that Mnestra mig 015 (memory_items.source_agent column) was installed as a file but never applied to Joshua's daily-driver `petvetbid`. Codex applied mig 015 manually; 4 source_agent='claude' rows landed post-fix → memory_items branch CONFIRMED working again.

Live psql probe at 19:13 ET revealed `memory_sessions` table is STILL stuck at 289 rows with last write 2026-05-01 20:40 UTC — zero new rows during the entire Sprint 51.5 session despite the column fix. **The bundled hook has TWO independent failure modes:** (1) memory_items branch failed pre-Codex-fix because of mig 015 drift — now closed; (2) memory_sessions branch failed and is STILL failing — separate root cause not yet identified. We are 10 days behind release schedule because every hotfix surfaces the next layer of fundamental bug. Sprint 51.6 mini explicitly scoped to break the cycle: identify both bugs, fix both, ship v1.0.2, then move on to feature work.

## Lanes

| Lane | Owner | Goal | Primary surface |
|---|---|---|---|
| **T1 — Hook instrumentation + bundled-vs-installed diff** | Claude | Diff `~/.claude/hooks/memory-session-end.js` (installed) against `packages/stack-installer/assets/hooks/memory-session-end.js` (bundled). Document the byte-exact deltas. Then instrument the installed hook with an un-swallowed-error stderr writer + a timestamp file (write to `/tmp/hook-fired-<timestamp>.log` on every fire so we have a fire-vs-write record). Fire `/exit` from a test Claude Code session; capture EXACTLY where the memory_sessions INSERT path fails (or skips). Restore the original hook before posting DONE. | `~/.claude/hooks/memory-session-end.js` (installed), `packages/stack-installer/assets/hooks/memory-session-end.js` (bundled), `/tmp/hook-fired-*.log` (instrumentation output). |
| **T2 — memory_sessions schema audit + manual SQL reproduction** | Claude | Query `petvetbid` for the actual `memory_sessions` table schema (`\d memory_sessions` equivalent via `information_schema`). Compare against what Sprint 47-era successful writes implied (the 289 existing rows). Identify any column the hook expects to write that doesn't exist OR any NOT NULL column without a default that the hook isn't populating. Run the hook's exact INSERT statement manually with verbose error output (`set client_min_messages=debug2`). Document the failure mode verbatim. | `memory_sessions` schema on petvetbid; the bundled hook's SQL for memory_sessions writes; ledger reference for any schema-vs-hook drift. |
| **T3 — Fix + ship v1.0.2 wave** | Claude | Based on T1 + T2 findings, implement the fix. If schema gap: write Mnestra migration 017 (or fix mig 015's incomplete state) AND extend audit-upgrade probe set to cover the new column/constraint. If hook code bug: fix `packages/stack-installer/assets/hooks/memory-session-end.js`, add a regression test in `packages/stack-installer/tests/`. Run `npm run sync:agents` if CLAUDE.md routing changes. Bump versions: termdeck@1.0.1 → 1.0.2; termdeck-stack@0.6.1 → 0.6.2 (audit-trail); mnestra@0.4.1 → 0.4.2 if a mnestra-side migration ships; rumen unchanged. CHANGELOG entry. Run full test suite — must stay at 950+ pass with no new failures. | `packages/stack-installer/assets/hooks/memory-session-end.js`, `packages/server/src/setup/audit-upgrade.js` (extend probe set if needed), `packages/server/src/setup/mnestra-migrations/017_*.sql` (new, only if needed), root + stack-installer + (maybe) engram `package.json`, `CHANGELOG.md`. |
| **T4 — Codex independent audit + verification harness** | **Codex** (auditor role) | Run independent verification against T1, T2, T3 findings. (a) Re-do T2's schema diff from a fresh psql session; confirm or contradict. (b) Re-run T1's instrumentation pattern from a NEW Claude Code session ending; confirm the hook's failure mode matches T1's writeup. (c) After T3 ships v1.0.2, install via `npm install -g @jhizzard/termdeck@1.0.2`, run `termdeck init --mnestra` against petvetbid, end a fresh session, verify `memory_sessions` row count grew. (d) Verify source_agent='claude' rows continue landing (mig 015 still applied). (e) Codex writes findings to STATUS.md as `[T4-CODEX] FINDING/AUDIT/VERIFY/DONE` posts; orchestrator reads. | All of T1/T2/T3's deliverables — Codex audits from outside the lane that built each. |

## Acceptance criteria

1. **T1 finds the failure mode.** A clear writeup of WHERE the memory_sessions write fails (line number, error message, stack trace).
2. **T2 reproduces it via manual SQL.** The exact INSERT statement that fails in production fails the same way when run via psql with verbose errors. Failure cause documented (schema gap, constraint violation, etc.).
3. **T3 ships v1.0.2.** Versions bumped, CHANGELOG entry, test suite green, tarballs verified via `npm pack --dry-run`. Orchestrator handles publishes (Joshua's Passkey).
4. **T4 verifies.** After v1.0.2 install, ending a fresh Claude Code session writes 1 new row to memory_sessions on petvetbid (psql probe before/after; row count grows). source_agent='claude' rows continue landing.
5. **No regressions.** Sprint 51.5's 950-pass / 22-fail (pre-existing project-taxonomy.test.js) suite stays at 950+ / 22-fail. New tests (T3's regression test for the hook fix) are additive.
6. **Brad re-pinged on WhatsApp** if v1.0.2 changes anything user-visible (probably yes — "v1.0.2 fixes a hook bug that prevented session summaries from landing; re-run termdeck init --mnestra to pick up any new migrations"). Joshua sends via wa.me deep-link inject.

## Pre-sprint substrate (orchestrator probes before inject)

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Confirm baseline state
psql "$DATABASE_URL" -c "select count(*) total, max(ended_at) last from memory_sessions"
# Expected: 289 / 2026-05-01 20:40

# Confirm Codex's mig 015 fix held
psql "$DATABASE_URL" -c "select column_name from information_schema.columns where table_name='memory_items' and column_name='source_agent'"
# Expected: 1 row

# Confirm bundled hook ships in v1.0.1 termdeck-stack tarball
cd packages/stack-installer && npm pack --dry-run 2>&1 | grep memory-session-end | head -5
cd ../..

# Confirm installed hook exists
ls -la ~/.claude/hooks/memory-session-end.js
diff ~/.claude/hooks/memory-session-end.js packages/stack-installer/assets/hooks/memory-session-end.js | head -30
```

## Risks

- **T3's fix may need a Mnestra migration.** That ships from `~/Documents/Graciella/engram` and bumps mnestra@0.4.2. If T3 finds the bug is purely in the bundled hook (no schema change), the wave is termdeck@1.0.2 + termdeck-stack@0.6.2 only. Either way, RELEASE.md publish order applies (Passkey, never --otp, publish before push).
- **T1's instrumentation could leak past sprint close.** The lane brief explicitly requires restoring the original hook before posting DONE. T4 verifies the restore happened by diffing post-T1 hook against `packages/stack-installer/assets/hooks/memory-session-end.js`.
- **The "two bugs" framing might be wrong** — it's possible the second bug is a downstream effect of mig 015 drift (e.g., a transaction rolled back BOTH writes when the source_agent INSERT failed; now that source_agent works, the next /exit will write memory_sessions cleanly without any code fix). T1's instrumentation will reveal this. If it turns out to be a non-bug, T3 closes with a one-line "no fix needed; resolved by v1.0.1 audit-upgrade application; v1.0.2 not shipped" note.
- **Codex availability.** T4 requires Codex available in a separate panel. If Codex isn't available, Claude can run T4 lane instead (less independent but still useful). Joshua's call.

## Boot for the orchestrator (this terminal)

The orchestrator continues from the existing TermDeck server on `127.0.0.1:3000` (PIDs from Sprint 51.5 inject still alive). No fresh `termdeck` boot needed — just open 4 NEW Claude Code panels (3 Claude + 1 Codex if assigning T4 to Codex) in the existing dashboard. Then the orchestrator fires the inject script using the same two-stage submit pattern.

## Boot for the four lanes

Each lane brief includes a customized boot block. The mini's lane briefs are tighter than Sprint 51.5's — fewer reads required because the heavy context already lives in this orchestrator session, and lane briefs cite the parent Sprint 51.5 docs rather than re-explaining everything.

## Companion artifacts

- After v1.0.2 ships: append ledger entry #15 to `docs/INSTALLER-PITFALLS.md` documenting Bug #2 (whatever its root cause). Update Class taxonomy if a new failure mode surfaces. The pre-ship checklist may grow item #12.
- After v1.0.2 ships: deferred Sprint 51.5b dogfood audit becomes UNBLOCKED — runs immediately to validate the v1.0.2 wave end-to-end.
- After v1.0.2 ships: Sprint 52 (cost-monitoring panel) and Sprint 24 (Maestro SaaS readiness) become UNBLOCKED for parallel execution.

## Lane discipline

Standard 4+1 rules: no version bumps inside lanes (orchestrator handles at sprint close), no CHANGELOG edits inside lanes, no commits inside lanes. T3 is the exception — its scope IS the version bump + CHANGELOG + ship — but only at the very end of the lane, after T1+T2 have posted DONE and T4 has signed off on the diagnosis. T3 still doesn't commit until orchestrator close.
