# T1 — Edge Function pin drift detection + auto-redeploy (single lane)

You are T1 in Sprint 52 (Edge Function pin drift, single-lane direct, code-changes welcome). This is the LAST TermDeck sprint of 2026-05-04 — the goal is to ship v1.0.7 cleanly tonight, after which TermDeck flips to weekly-bump cadence + memory-quality innovation focus.

**No 3+1+1 ceremony.** Orchestrator codes directly. Same shape as Sprints 51.8, 52.1, and 51.9 earlier today — three single-lane direct sprints that all shipped clean.

## Boot sequence (do these in order, no skipping)

1. `date '+%Y-%m-%d %H:%M ET'` — wall-clock timestamp.
2. `memory_recall(project="termdeck", query="Sprint 52 Edge Function pin drift rumen-tick deployed npm publish")`
3. `memory_recall(project="termdeck", query="Sprint 51.5b T2 Codex 0.4.0 vs 0.4.5 rumen-tick deployed Edge Function pin")`
4. `memory_recall(query="3+1+1 hardening rules checkpoint discipline post shape uniform idle-poll regex")`
5. Read `~/.claude/CLAUDE.md` — global rules.
6. Read `./CLAUDE.md` — project router.
7. Read `docs/sprint-52-edge-function-pin-drift/PLANNING.md` — sprint scope (you've already seen the gist; re-read for the full acceptance criteria + risks).
8. Read `docs/sprint-52-edge-function-pin-drift/STATUS.md` — substrate state.
9. Read `docs/RELEASE.md` — STRICT before any publish work. v1.0.7 publish is Joshua's job; orchestrator does code + commit + push-after-publish.
10. Read `docs/INSTALLER-PITFALLS.md` ledger entries #18 + #19 (today's Class A cousins) and the chronological pattern for ledger #20 (Class O — deployed-state drift between npm-published and Supabase-Edge-Function-deployed).

## Pre-sprint intel — what landed earlier today

| Wave | Sprint | Closes | Class |
|---|---|---|---|
| v1.0.4 | 51.8 | settings.json Stop→SessionEnd lockstep drift | N |
| v1.0.5 | 52.1 | match_memories signature drift on long-lived installs | A (#17) |
| v1.0.6 commit `12079cc` | 51.9 (mid-Sprint-51.5b) | memory_hybrid_search 10-arg drift overload | A (#18) |
| v1.0.6 commit `d291ecf` | 51.9 fold-in | mig 016 cron.* schema dependency on fresh-install | A (#19) |

**v1.0.6 published 2026-05-04 ~15:35-15:40 ET.** `npm view @jhizzard/termdeck version` returns `1.0.6`; `npm view @jhizzard/termdeck-stack version` returns `0.6.6`. `origin/main` at HEAD `d291ecf`. Sprint 51.5b lanes T1/T2/T3/T4 all DONE; T3 was REOPENed by T4-CODEX at 15:22 ET for a Brad WhatsApp redraft and was nudged at 15:31:32 ET — by the time you boot, T3 may have posted v2 draft and T4 may have re-audited.

**The 233/321 rumen_insights flatline persists** at v1.0.6 publish time. Codex T4-CODEX's 15:22 ET independent probe via `supabase functions download rumen-tick --project-ref <project-ref> --use-api` revealed the daily-driver project's deployed `rumen-tick` is at `npm:@jhizzard/rumen@0.4.0` while npm current is `0.4.5`. The flatline is NOT a v1.0.x onion bug — it's deployed-state drift. v1.0.6 published doesn't touch deployed Edge Functions.

This sprint closes that drift detection + auto-redeploy. After v1.0.7 ships AND Joshua re-runs `init --rumen --yes` against the daily-driver project, the Edge Function refreshes to current and the next 1-2 ticks (15-30 min) should restart insight flow.

## Probe sequence

Pre-state baseline (run at boot):

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')

# Confirm v1.0.6 globally installed locally
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# expect: 1.0.6

# Confirm rumen_insights flatline still in effect
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
# expect at boot: 321 / 2026-05-01 20:45 (will move post-v1.0.7-publish + post-init-rumen-rerun)

# Confirm the daily-driver project's deployed rumen-tick pin (Codex's 15:22 ET reading)
SUPABASE_ACCESS_TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"') \
  supabase functions download rumen-tick --project-ref <project-ref> --use-api -o /tmp/sprint-52-deployed-rumen-tick
grep -E "npm:@jhizzard/rumen@" /tmp/sprint-52-deployed-rumen-tick/index.ts
# expect: 0.4.0 (per Codex 15:22 ET)

# Confirm bundled __RUMEN_VERSION__ substitution shape
grep -nE "__RUMEN_VERSION__|@jhizzard/rumen@" /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/rumen/functions/rumen-tick/index.ts
```

## Implementation steps

### Step 1 — Audit current `init --rumen` redeploy behavior

Read `packages/cli/src/init-rumen.js` end-to-end. Find the section that calls `supabase functions deploy rumen-tick` (or whatever the actual command is). Document in your scratchpad:
- Does it run unconditionally on every `init --rumen` invocation?
- Or is it gated on first-install only / version comparison / skip-if-exists?
- What's the substitution mechanism for `__RUMEN_VERSION__` → concrete version?

The fix shape depends on the answer. If it's already unconditional, focus the sprint on the audit-upgrade probe (Step 3). If it's conditional, force-unconditional in Step 2.

### Step 2 — Force-redeploy on every `init --rumen` run

If Step 1 found conditional logic:
- Remove the gate (no flag, no version check). `supabase functions deploy` is idempotent on Supabase's side; ~5s overhead per Edge Function deploy is acceptable for correctness.
- Update the wizard's banner / step output to reflect: "Re-deploying Edge Functions (rumen-tick + graph-inference) ... ✓".
- Verify the existing tests in `tests/init-rumen-*.test.js` still pass (or update them to assert unconditional redeploy).

If Step 1 found it's already unconditional, skip Step 2. Document in CHANGELOG that the existing behavior already covers redeploy and Sprint 52 is purely audit-upgrade probe coverage.

### Step 3 — Add `probeKind: 'edgeFunctionPin'` to audit-upgrade

Read `packages/server/src/setup/audit-upgrade.js` to understand the existing probe shape (Sprint 51.6 T3's `probeKind: 'functionSource'` is the closest precedent — line ~174 of audit-upgrade.js). The new probe:

```js
// In audit-upgrade.js's PROBES array:
{
  id: 'rumen-tick-pin',
  description: 'rumen-tick Edge Function deployed source pin matches bundled rumen package',
  probeKind: 'edgeFunctionPin',
  edgeFunctionName: 'rumen-tick',
  bundledPath: 'packages/server/src/setup/rumen/functions/rumen-tick/index.ts',
  yellowOnDrift: true,
  recommendation: 'Run `termdeck init --rumen --yes` to refresh the deployed Edge Function from <deployed_version> to <bundled_version>.',
},
{
  id: 'graph-inference-pin',
  description: 'graph-inference Edge Function deployed source pin matches bundled rumen package',
  probeKind: 'edgeFunctionPin',
  edgeFunctionName: 'graph-inference',
  bundledPath: 'packages/server/src/setup/rumen/functions/graph-inference/index.ts',
  yellowOnDrift: true,
  recommendation: '...',
},
```

Probe implementation (`probeEdgeFunctionPin(target, { projectRef, accessToken, fetchImpl })`):

1. Download deployed source via Supabase Management API: `GET https://api.supabase.com/v1/projects/<ref>/functions/<name>/body` (or whatever the canonical Management API endpoint is — check Sprint 51.6 T3's `probeFunctionSource` for the exact URL pattern).
2. Parse the deployed source, extract the `npm:@jhizzard/rumen@<version>` import line. Regex: `/npm:@jhizzard\/rumen@([\d.]+(?:-[a-z0-9.]+)?)/`.
3. Read bundled source from `bundledPath`. Find `__RUMEN_VERSION__` placeholder OR the substituted concrete version (the bundle should be in placeholder form on disk; substitution happens at deploy time). To compare against current published, run `npm view @jhizzard/rumen version` (or read from a cached value); the bundled `__RUMEN_VERSION__` substitutes to current published at deploy time.
4. Compare deployed_version vs current_published_version. If equal → green. If different → yellow with recommendation. If download fails → unknown band.

### Step 4 — Test additions

`tests/audit-upgrade-edge-function-pin.test.js` (NEW):

- Shape-test: probe parses synthetic deployed-source string with `npm:@jhizzard/rumen@0.4.0` → returns `{deployed: '0.4.0'}`.
- Shape-test: probe parses synthetic deployed-source missing the pin → returns `{deployed: null, status: 'unknown'}`.
- Shape-test: drift detection: deployed=0.4.0, bundled=0.4.5 → returns `yellow` with recommendation containing both versions.
- Shape-test: in-sync: deployed=0.4.5, bundled=0.4.5 → returns `green`.
- Shape-test: function not deployed (Management API 404) → returns `unknown` with `error` field.

Use the same mocking pattern as Sprint 51.6 T3's `probeFunctionSource` test if one exists; otherwise create a minimal `fetchImpl` stub.

### Step 5 — CHANGELOG + ledger #20

- CHANGELOG.md: add `[1.0.7]` block above `[1.0.6]`. Lead with the Class O story. Sections: Added (probe + redeploy), Changed (audit-trail bump), Fixed (the flatline diagnosis), Notes (suite results, out-of-scope items).
- INSTALLER-PITFALLS.md: ledger #19 just landed; #20 is yours. Add Class O to the failure-class taxonomy table. Update pre-ship checklist with item #14: "every Edge Function shipped by `init --rumen` must have a corresponding pin-drift probe in audit-upgrade."

### Step 6 — Version bumps

- root `package.json`: 1.0.6 → 1.0.7
- `packages/stack-installer/package.json`: 0.6.6 → 0.6.7

### Step 7 — Commit, hand to Joshua for publish, push after

Per RELEASE.md strict order:
1. `npm pack --dry-run` shows the updated audit-upgrade.js + init-rumen.js + new test file.
2. Test suite green (158/158 → ~165/165 with new tests).
3. Commit with full Class O explanation (mirror the v1.0.6 fold-in commit shape).
4. Tell Joshua to publish: `npm publish --auth-type=web` from root, then `cd packages/stack-installer && npm publish --auth-type=web`.
5. After both publishes succeed, `git push origin main`.
6. Verify `npm view @jhizzard/termdeck version` returns 1.0.7.

### Step 8 — Brad WhatsApp send (if T3 redraft + T4 re-audit are GREEN)

Independent of Sprint 52 code work. Pre-condition: T3 has posted `### [T3] DRAFT — Brad WhatsApp v2 ...` AND T4-CODEX has posted `### [T4-CODEX] AUDIT — T3 v2 redraft VERIFIED` (or equivalent green disposition).

When green:
1. Pull T3's v2 draft text from STATUS.md.
2. Update the draft to mention v1.0.7 ALSO closes the Edge Function pin drift (so Brad's `init --rumen --yes` will auto-refresh his stale pin).
3. URL-encode + open via `wa.me/15127508576?text=<encoded>` per the standing wa.me deep-link inject pattern (CLAUDE.md "Never present messages for copy-paste").
4. Update T4 panel via STATUS.md `[orchestrator] BRAD-SENT 2026-05-04 HH:MM ET` post.

When NOT green: leave Brad outreach for the next session. Sprint 52 publishing without the WhatsApp send is acceptable — Joshua's mail merge is the priority, Brad outreach is async.

### Step 9 — Post-publish dogfood on the daily-driver project

After v1.0.7 lands + push completes:

```bash
npm install -g @jhizzard/termdeck@latest
termdeck init --mnestra --yes
# expect: audit-upgrade probe surfaces YELLOW on rumen-tick pin (deployed 0.4.0 vs bundled/current 0.4.5)

termdeck init --rumen --yes
# expect: redeploys both Edge Functions; ~5s each

# Wait 15-30 min for the next rumen-tick + 1 cycle
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
# expect (if the picker on rumen 0.4.5 also works): count > 321 OR max_created_at > 2026-05-01
# if still flat: the rumen picker mismatch (memory_items 1-row-per-session) is the deeper bug; document and defer to Sprint 53+
```

## Lane discipline

- This is a code-shipping lane. Version bumps + CHANGELOG + commits ARE in scope (you're the orchestrator; the "no version bumps in lane" rule is for 3+1+1 worker lanes, not single-lane direct sprints).
- Post shape: STATUS.md gets `### [T1]` posts in the canonical uniform shape. CHECKPOINTs every 30 min OR phase boundary (this isn't 3+1+1 with a Codex auditor, but the discipline still helps if the orchestrator session compacts mid-work).
- Stay in TermDeck. Don't touch mnestra-package or rumen-package source — those are deferred to next-week+ sprints per PLANNING.md out-of-scope list.
- Dogfood verification on the daily-driver project is part of the sprint, not optional.

## When you're done

Post `### [T1] DONE 2026-05-04 HH:MM ET — <PASS or RED on phase X>` in STATUS.md with full evidence dump including:
- Commit SHAs (probably 2-3 commits)
- npm view version confirmations
- Audit-upgrade YELLOW evidence on the daily-driver project pre-redeploy
- Audit-upgrade GREEN evidence on the daily-driver project post-redeploy
- rumen_insights count delta (will be >321 if 0.4.5's picker works, OR still 321 with deeper bug documented)
- Brad WhatsApp send disposition (sent / pending T3 redraft / deferred to next session)

Then draft the session-end email per `~/.claude/CLAUDE.md` mandate. Subject: `TermDeck Wrap — Sprint 52 v1.0.7 Edge Function pin drift detection — 2026-05-04 HH:MM ET`. The next-restart-prompt section explicitly notes Sprint 53+ is memory-quality innovation focus, not pipeline-correctness fixes.

Begin.
