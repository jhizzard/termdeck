# Sprint 51.5 — T2 (Claude, cross-repo): `mnestra doctor` zero-cycle warning

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T2; canonical reference in [docs/INSTALLER-PITFALLS.md](../INSTALLER-PITFALLS.md) § Failure-class taxonomy):**

Addresses **Class I (Silent no-op)**, satisfies pre-ship checklist item #10 (silent no-op detection).

**Cross-repo lane.** You operate in `~/Documents/Graciella/engram` (the on-disk path for the `mnestra` project, renamed from Engram in Sprint 3). NEW `mnestra doctor` subcommand. Brad's outstanding suggestion 2026-04-28; promoted from Sprint 51 carry-over.

## Why this lane exists

Brad's `rumen-tick` cron kept successfully running every 15 minutes with `sessions_processed=0, insights_generated=0` for ~6 days. Looked healthy in the cron logs. Wasn't — schema gaps caused by the upgrade-detection bug (T1's primary scope) silently produced zero work, no error. The fix is symptom-side: a `mnestra doctor` subcommand that surfaces "all-zeros for N consecutive cycles" as a warning. T1 fixes the cause; T2 prevents the next cause from hiding for 6 days.

## Files

- NEW `~/Documents/Graciella/engram/src/cli/doctor.ts` (~120 LOC). Exports a CLI command function. Reads connection details from existing config loader.
- EDIT `~/Documents/Graciella/engram/src/cli/index.ts` — register the `doctor` subcommand (alongside the existing `serve`, `recall`, etc.).
- NEW `~/Documents/Graciella/engram/tests/doctor.test.ts` (~6 tests).
- After implementation, bump `~/Documents/Graciella/engram/package.json` from `0.4.0` → no, **don't bump** in-lane (orchestrator handles versions at sprint close).

## Probes

`mnestra doctor` runs 4 probes and prints green / yellow / red per probe + a one-line recommendation per finding.

1. **Cron all-zeros probe.** Query `cron.job_run_details` for `rumen-tick` and `graph-inference-tick` over the last 10 runs. For each job: count `status='succeeded'` AND result `(sessions_processed=0 AND insights_generated=0)` (rumen-tick) or `(candidates_scanned=0 AND edges_inserted=0)` (graph-inference). If ≥6 of the last 10 runs match, **red** with: "rumen-tick has run N consecutive cycles with no work — likely schema drift. Run `termdeck init --rumen` to audit; reference `docs/INSTALLER-PITFALLS.md` ledger #13." (Match Brad's 6-day window — at 15-min cadence, 6 of 10 runs = 90 minutes minimum; cron run cadence varies, so use count-of-last-N rather than time-window.)

2. **Per-tick latency probe.** Query `cron.job_run_details` for the last 10 runs of each cron. Compute p95 of `end_time - start_time`. If p95 > 5s on either, **yellow** with: "rumen-tick p95 latency is N s — investigate Edge Function logs for slow embedding calls or pg query plans."

3. **Edge Function presence vs bundled migration set.** Delegates to T1's `auditUpgrade()` in dry-run mode (T1 will export an opt-in `{ dryRun: true }` flag that returns the `missing[]` list without applying). If `missing.length > 0`, **red** with: "Schema drift detected — N artifacts missing from bundled set: <list>. Run `termdeck init --rumen` to apply." If T1 isn't merged when you ship, fall back to running the same probes inline (single SQL queries — copy the probe list from T1's brief, no apply path).

4. **MCP config path parity.** Read `~/.claude.json` (canonical) and `~/.claude/mcp.json` (legacy). Confirm `mcpServers.mnestra` exists in `~/.claude.json`, doesn't exist in legacy. If only legacy: **red** with: "MCP config is at the deprecated path — re-run `termdeck init --mnestra` to migrate (Sprint 36 v0.8.0 forward-migration applies)." If neither: **red** with: "Mnestra MCP not registered — run `termdeck init --mnestra`." If both: **yellow** with: "Mnestra registered in both paths; remove legacy entry."

Output format:

```
$ mnestra doctor
✓ MCP config path parity (canonical only)
✓ rumen-tick latency (p95 = 2.3s)
✗ rumen-tick all-zeros for 7 of last 10 runs
  → Likely schema drift. Run `termdeck init --rumen` to audit.
  → Reference: docs/INSTALLER-PITFALLS.md ledger #13.
✗ Schema drift detected — 6 artifacts missing:
    M-009 (memory_relationships.weight)
    M-010 (memory_recall_graph RPC)
    ...
  → Run `termdeck init --rumen`.

Doctor complete. 2 reds, 0 yellows, 2 greens. Exit 1.
```

Exit code: 0 if all green, 1 if any red, 2 if any yellow but no red. Suitable for CI.

## Acceptance criteria

1. **All-green path.** `mnestra doctor` against Brad's project (post his manual fix, all migrations applied + cron healthy) exits 0 with all 4 probes green.
2. **All-zeros detection.** Against a deliberately broken project (`update cron.job_run_details set ... where jobname='rumen-tick'` to simulate all-zeros for 7 of last 10 runs), exits 1 with the all-zeros red firing and the recommendation citing `docs/INSTALLER-PITFALLS.md` ledger #13.
3. **Schema-drift detection.** Against a project with `memory_relationships.weight` dropped + `graph-inference-tick` cron suspended, exits 1 with the schema-drift red listing both missing artifacts.
4. **MCP path parity.** Three test fixtures (canonical only, legacy only, both) → green / red / yellow respectively.
5. **Latency probe.** Mocked `cron.job_run_details` with p95 = 7s → yellow.
6. **Cold-boot tolerance (anti-false-positive).** A project where the cron has only run 2-3 times so far (≤5 runs) does NOT fire all-zeros red even if all are zero — require ≥6 cycles before flagging. Match Brad's 6-day soak window.
7. **No-regressions.** Mnestra existing tests stay green. New tests pass.

## Coordination

- **Depends on T1 for the `auditUpgrade` dry-run export** for probe #3. If T1 hasn't merged when you start, implement probe #3 inline with the same SQL probes (copy from T1 brief). When T1 merges, refactor to call into `auditUpgrade({ dryRun: true })`. Document the dependency in your FINDING post.
- **T3 + T4 are independent of T2.**

## Cross-repo workflow

1. `cd ~/Documents/Graciella/engram` to operate.
2. Verify you're on a clean branch — `git status` should be clean. If not, ask in STATUS.md before proceeding.
3. Use the existing TypeScript build (`npm run build`) and test (`npm test`) workflow. Mnestra is TypeScript, unlike TermDeck.
4. Don't `git push` or bump version. Orchestrator handles release at sprint close.

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="mnestra", query="mnestra doctor subcommand silent no-op cron all-zeros")
3. memory_recall(project="termdeck", query="Sprint 51.5 mnestra doctor zero-cycle warning Brad jizzard-brain rumen-tick")
4. memory_recall(query="installer failure-class taxonomy silent no-op")
5. Read /Users/joshuaizzard/.claude/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/STATUS.md
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/T1-stack-installer-audit-upgrade.md (your dependency)
10. Read this brief
11. cd ~/Documents/Graciella/engram
12. Read engram/CLAUDE.md (if it exists; otherwise skip)
13. Read src/cli/index.ts (registry shape — model the new subcommand on existing ones)
14. Read package.json (current version + scripts)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in TermDeck `docs/sprint-51.5-installer-upgrade-and-doctor/STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
