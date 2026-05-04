# Sprint 52 — Edge Function pin drift detection + auto-redeploy (last TermDeck sprint of 2026-05-04)

**Status:** Plan authored 2026-05-04 15:42 ET by orchestrator at end of v1.0.6 publish wave. Single-lane direct (no 3+1+1 ceremony — scope is bounded, same-author memory warm from Sprint 51.9 fold-in earlier today).

**Pattern:** Single-lane, orchestrator-codes-directly. Same shape as Sprint 51.8 (settings.json migration), Sprint 52.1 (match_memories drift guard), and Sprint 51.9 (memory_hybrid_search drift + mig 016 fold-in). Three single-lane direct sprints today have all shipped clean; this is the fourth and last.

**Target ship:** `@jhizzard/termdeck@1.0.7` + `@jhizzard/termdeck-stack@0.6.7` (audit-trail bump). Mnestra and Rumen unchanged this wave. **This is the final TermDeck publish for 2026-05-04**; after Sprint 52 ships, the project transitions to weekly-bump cadence with focus on memory-quality innovation rather than pipeline-correctness fixes.

**Why this sprint exists.** The 2026-05-01 → 2026-05-04 `rumen_insights` flatline (321 rows, last write 2026-05-01 20:45 UTC) is NOT a v1.0.x onion bug. The v1.0.x cascade closed five drift classes (51.5/51.6/51.7/51.8 + 52.1/51.9), every wizard surface is now structurally clean. But Codex T4-CODEX's 15:22 ET independent probe revealed the daily-driver project's deployed `rumen-tick` Edge Function is pinned to `npm:@jhizzard/rumen@0.4.0` while the npm registry has `0.4.5`. Four minor versions of drift between published rumen and Joshua's deployed Edge Function. **`npm publish` doesn't update Supabase Edge Functions** — the function source lives on Supabase's infrastructure and only re-deploys when the wizard runs `supabase functions deploy`.

This is a NEW failure-class pattern: **deployed-state drift between npm-published packages and Supabase-deployed Edge Functions.** Distinct from the schema-drift class A onion just closed. Generalizes to any `init --rumen` install that hasn't been re-run since the last rumen package version bump. Brad's jizzard-brain almost certainly has the same drift. Sprint 52 closes it.

## Scope (single-lane direct)

T1 (orchestrator codes directly):

1. **Audit current `init --rumen` redeploy behavior.** Read `packages/cli/src/init-rumen.js` to determine whether `supabase functions deploy rumen-tick` runs unconditionally, only on first install, or conditional on some other gate. Document the answer; the pattern of fix depends on what's there.

2. **Patch `init --rumen` to always redeploy on every wizard pass.** `supabase functions deploy` is idempotent on Supabase's side (overwrites the function source); ~5s overhead per Edge Function deploy is acceptable for correctness. Force-redeploy on every run means `init --rumen --yes` after any rumen package version bump auto-refreshes the deployed source. **No new flag needed** — the deploy step becomes unconditional.

3. **Add audit-upgrade probe `probeKind: 'edgeFunctionPin'`** to `packages/server/src/setup/audit-upgrade.js`. The probe:
   - Downloads the deployed Edge Function source via Supabase Management API (`supabase functions download <name> --use-api`)
   - Greps for `npm:@jhizzard/rumen@<version>` (or `npm:<pkg>@<version>` shape generally — same probe handles graph-inference too)
   - Compares against the bundled `__RUMEN_VERSION__` substitution from `packages/server/src/setup/rumen/functions/<name>/index.ts`
   - When drift detected, returns YELLOW (not RED — drift is non-blocking for the wizard, just stale runtime) with explicit recommendation: "Run `termdeck init --rumen --yes` to refresh the deployed Edge Function from `<deployed_version>` to `<bundled_version>`."
   - When deployed source is unreachable (Management API auth fail, function not deployed yet, etc.), returns `unknown` band (existing pattern for Sprint 51.6 T3's functionSource probe).

4. **Surface the probe in BOTH `init --mnestra` and `init --rumen` audit-upgrade phases** (the existing audit-upgrade probe set already runs in both). Users running `init --mnestra` to upgrade hooks also get told about Edge Function drift — they don't have to remember to also run `init --rumen`.

5. **Test additions.**
   - `tests/audit-upgrade-edge-function-pin.test.js` — fixture-based test using a mock Management API. Cases: in-sync (green), 1-version-drift (yellow with recommendation), download-fails (unknown), function-not-deployed-yet (unknown).
   - Update existing `tests/audit-upgrade.test.js` if any aggregation logic changes.

6. **CHANGELOG `[1.0.7]` block + INSTALLER-PITFALLS.md ledger #20** documenting the new failure class (call it Class **O — Deployed-state drift between npm-published packages and Supabase Edge Functions**). Pre-ship checklist update: "every Edge Function shipped by `init --rumen` should have a corresponding pin-drift probe in audit-upgrade."

7. **Version bump.** Root `package.json` 1.0.6 → 1.0.7. `packages/stack-installer/package.json` 0.6.6 → 0.6.7 (audit-trail).

## Acceptance criteria

1. **`init --rumen --yes` against any project re-deploys both Edge Functions** (rumen-tick + graph-inference) regardless of prior deploy state. Verified on the daily-driver project by tailing `supabase functions logs rumen-tick` and confirming the new bundle's `__RUMEN_VERSION__` substitution shows up at next tick.
2. **Audit-upgrade probe detects pin drift end-to-end.** Probe against the daily-driver project pre-Sprint-52 returns YELLOW with `deployed=0.4.0, bundled=0.4.5`. Probe against post-redeploy the daily-driver project returns GREEN.
3. **Tests pass.** Full hook + migration matrix continues to pass (currently 158/158 across migration shape + hook tests at HEAD `d291ecf`). New audit-upgrade test pins the probe behavior across 4+ cases.
4. **`npm pack --dry-run`** shows the updated `audit-upgrade.js` + `init-rumen.js` ship. No regression in `files` glob.
5. **Joshua's daily-driver post-publish flow.** Run `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra --yes` against the daily-driver project; expect audit-upgrade YELLOW on rumen-tick pin drift. Then `termdeck init --rumen --yes`; expect both Edge Functions redeploy. After 1-2 ticks (15-30 min wall-clock), `select count(*), max(created_at) from rumen_insights` shows count > 321 OR max_created_at > 2026-05-01.
6. **(Conditional) Brad's jizzard-brain unblocking.** If `rumen_insights` count starts growing on the daily-driver project post-redeploy, Brad's WhatsApp draft (post-T3-redraft + T4-VERIFIED) gets a confirmed "run init --rumen too" caveat and orchestrator can send.

## Pre-sprint substrate (orchestrator probes before coding)

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')

# Confirm v1.0.6 live + the daily-driver project is on it locally
npm view @jhizzard/termdeck version           # expect 1.0.6
npm view @jhizzard/termdeck-stack version     # expect 0.6.6
npm view @jhizzard/rumen version              # expect 0.4.5 (unchanged)
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"

# Confirm pin-drift state on the daily-driver project (Codex's 15:22 ET reading)
SUPABASE_ACCESS_TOKEN=<from-secrets> supabase functions download rumen-tick --project-ref <project-ref> --use-api -o /tmp/rumen-tick-deployed
grep -E "npm:@jhizzard/rumen@" /tmp/rumen-tick-deployed/index.ts
# expect: 0.4.0 (or whatever's actually deployed)

# Confirm bundled __RUMEN_VERSION__ substitution
grep -E "__RUMEN_VERSION__|@jhizzard/rumen@" /usr/local/lib/node_modules/@jhizzard/termdeck/packages/server/src/setup/rumen/functions/rumen-tick/index.ts

# Confirm rumen_insights flatline persists
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
# expect: 321 / 2026-05-01 20:45 (will move once redeploy lands and a tick fires post-fix)
```

## Risks

- **Mock Management API in tests.** The audit-upgrade probe depends on Supabase's `functions download --use-api` flow, which is hard to mock cleanly. Test pattern: shape-test the probe's parsing logic with a synthetic deployed-source string fixture (no actual Management API call); rely on integration testing (live the daily-driver project) for end-to-end correctness. Sprint 51.6 T3's `probeFunctionSource` precedent already does this.
- **Force-redeploy adds ~5s per Edge Function on every `init --rumen` run.** Acceptable for correctness; Joshua and Brad are the only frequent re-runners. Document as expected behavior in init-rumen's banner.
- **Pin format detection must handle both substituted (`npm:@jhizzard/rumen@0.4.5`) and placeholder (`npm:@jhizzard/rumen@__RUMEN_VERSION__`).** Edge Function source on Supabase is post-substitution; bundled source on disk is pre-substitution. Probe parses both shapes.
- **Class O classification is debatable.** Could fold into existing Class H (migration-runner blindness) or Class M (architectural omission). New letter feels right because the failure mode is genuinely different — neither schema nor write-path, but a runtime-deployed-state drift. T1 (orchestrator) decides at ledger #20 write-up time.

## Companion artifacts

- **Brad WhatsApp v1.0.7 follow-up draft.** Sprint 51.5b T3's redraft is currently in flight (T3 was nudged at 15:31:32 ET re Codex's 15:22 ET REOPEN constraints). Once T3 posts `### [T3] DRAFT — Brad WhatsApp v2 ...` AND T4-CODEX posts `### [T4-CODEX] AUDIT — T3 redraft VERIFIED`, orchestrator fires the draft via wa.me deep-link inject. The draft will mention v1.0.6 (drift onion closed) AND v1.0.7 (Edge Function pin drift detection + auto-redeploy). Single message covers both fixes plus the explicit Brad action: `init --mnestra --yes` (gets v1.0.6 invariants) then `init --rumen --yes` (gets v1.0.7 redeploy, refreshes his stale rumen-tick on jizzard-brain).
- **Optional v1.0.7 blog post.** Per RELEASE.md companion-artifact convention. Lead with the failure class O story: "We thought we shipped a fix at 11am. Codex caught a cousin at 2pm. T3 caught a third at 3pm. The deployed Edge Function on the daily-driver was four minor versions stale and nobody knew until 4pm." Six-incident closeout for the day. Optional; orchestrator decides at sprint close.
- **No 3+1+1 substrate this sprint.** Single-lane direct. Orchestrator codes; no panels needed.

## Out of scope (deferred to next-week+)

- **Doctor blindness on cron return_message** (T2 #1 from Sprint 51.5b). Mnestra-package change at `~/Documents/Graciella/engram/...` requiring `DoctorDataSource.rumenJobsRecent(limit)` API addition. Bigger scope, separate publish wave (mnestra package). Defer to next week as part of memory-quality work.
- **Rumen picker shape mismatch on memory_items 1-row-per-session.** Rumen-package change at `~/Documents/Graciella/rumen/src/extract.ts:55-77`. Picker assumes pre-Sprint-51.6 multi-row-per-session pattern; new bundled hook writes one row per session. Pivot to read from `memory_sessions` directly (now authoritative post-mig-017). ~30 LOC change. Different repo + publish wave. Defer to next week.
- **Doctor env-var discoverability nit** (T2 #3). DX polish; Sprint 53+ candidate.
- **Migration-authoring linter** flagging `CREATE OR REPLACE FUNCTION` without drift-tolerant prelude OR migrations referencing non-default schemas without conditional guard. Two Class A drift cousins + one Class A schema-availability ledgered today (#17/#18/#19) — pattern is now well-canonized. Sprint 53+ candidate.

## After Sprint 52 ships

The TermDeck product cadence flips:
- **Today/tonight:** Brad's WhatsApp goes out (post-T3-redraft + T4-VERIFY). Brad upgrades, runs both wizards, confirms working. Joshua confirms `rumen_insights` recovers on the daily-driver project post his own re-runs.
- **Next week:** weekly bumps only for security/critical hotfixes. Memory-quality innovation is the focus — Rumen picker rewrite (memory_sessions-direct), doctor blindness fix (Mnestra), better surfacing of insights in the dashboard, cost-monitoring panel (original Sprint 51 vision). Sprint 24 (Maestro) starts after Joshua's mail merge completes.

The v1.0.x onion is the proof point: TermDeck's installer is now self-healing across 7 ledgered failure classes (#1-#19, including new Classes M/N/O surfaced today). Forward work is primarily about making memories more useful, not making the install path more correct.
