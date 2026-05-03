# Sprint 51.5 — T1 (Claude): Stack-installer schema-introspection audit-upgrade + Edge Function env fallback

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T1; canonical reference in [docs/INSTALLER-PITFALLS.md](../INSTALLER-PITFALLS.md) § Failure-class taxonomy):**

PRIMARY scope of Sprint 51.5. Addresses **Class A (Schema drift)** + **Class H (Migration-runner blindness)**, satisfies pre-ship checklist items #1 (upgrade path tested), #2 (idempotent re-runs), and #11 (one logical operation per CLI invocation).

Add an `auditUpgrade()` step that runs at the top of every `termdeck init --mnestra` and `termdeck init --rumen` re-run. Probe the existing install for Sprint-38-onward artifacts that may be missing despite npm packages being current. Apply each missing artifact via the bundled migration / function source / vault clone. Idempotent — second run reports "nothing to do." Plus: patch the bundled Edge Function source to fall back from `DATABASE_URL` to `SUPABASE_DB_URL` so users on fresh installs don't need to set the secret manually.

## Why this lane exists

Brad's 2026-05-02 report (INSTALLER-PITFALLS.md ledger #13): `jizzard-brain` was provisioned 2026-04-25, Brad ran `npm install -g @latest` for all four packages, but everything added Sprint 38 onward never landed on his database. `init-rumen.js::applySchedule` correctly applies migrations 002 and 003 with templating but only on the *fresh-install* path. There is no code that diffs an existing install against the bundled migration set. After `npm install -g @latest`, the npm packages are current, the database is frozen at first-kickstart.

Brad's 2026-05-03 follow-up (INSTALLER-PITFALLS.md ledger #14, takeaway #1): bundled Edge Function source at `packages/server/src/setup/rumen/functions/{rumen-tick,graph-inference}/index.ts` reads `Deno.env.get('DATABASE_URL')` only. Supabase Edge Runtime auto-injects `SUPABASE_DB_URL` as a built-in env var; the source should fall back. Brad hand-patched all 4 deployed copies to `Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL')`.

Brad's 2026-05-03 bonus finding: Rumen migration 002 ships with raw `<project-ref>` placeholder. The fresh-install schedule path at `init-rumen.js:472-505` already calls `applyTemplating()` for both 002 and 003, but the new audit-upgrade applier MUST mirror that templating — silently re-applying mig 002 without templating would push the literal placeholder string to the database.

## Critical pre-lane substrate probe

Before writing code, verify the audit-target probes work against a real Supabase project. Joshua's daily-driver project is `petvetbid` (ref `luvvbrpaopnblvxdxwzb`). The Supabase MCP path is currently broken on Josh's machine (placeholder PAT — see Sprint 51.5 STATUS.md), so use the Supabase CLI:

```bash
# Probe each audit target. All should be present on a current install.
supabase db query --linked --project-ref luvvbrpaopnblvxdxwzb \
  "select column_name from information_schema.columns where table_name='memory_relationships' and column_name='weight'"
supabase db query --linked --project-ref luvvbrpaopnblvxdxwzb \
  "select column_name from information_schema.columns where table_name='memory_items' and column_name='source_agent'"
supabase db query --linked --project-ref luvvbrpaopnblvxdxwzb \
  "select proname from pg_proc where proname='memory_recall_graph'"
supabase db query --linked --project-ref luvvbrpaopnblvxdxwzb \
  "select jobname from cron.job where jobname='graph-inference-tick'"
supabase db query --linked --project-ref luvvbrpaopnblvxdxwzb \
  "select name from vault.secrets where name='graph_inference_service_role_key'"
supabase functions list --project-ref luvvbrpaopnblvxdxwzb | grep graph-inference
```

If any probe fails (sandbox or auth), document in your FINDING post and adjust the audit accordingly. Joshua's project is the canary — Brad's `jizzard-brain` already had Brad's manual fix applied 2026-05-02, so it's no longer a clean drift target.

## Files

- NEW `packages/server/src/setup/audit-upgrade.js` (~150 LOC). Exports `auditUpgrade({ pgClient, projectRef, supabasePat })` returning `{ probed, missing, applied, errors }`. Each probe maps to exactly one bundled migration / function / vault clone. Apply via the existing `pgRunner` + `applyTemplating` for SQL; via the Supabase Management API (or `supabase functions deploy`) for Edge Functions; via `vault.create_secret(...)` SQL for vault clones. **MUST call `applyTemplating()` on Rumen 002 AND 003** — mirror the fresh-install path at `init-rumen.js:472-505`.
- EDIT `packages/cli/src/init-mnestra.js` — call `auditUpgrade()` near the top, before the fresh-install path. If `missing.length === 0`, log "✓ install up to date" and continue with normal flow (idempotent for fresh installs). If applied non-empty, log per-artifact ("applied migration 009: graph metadata", etc.) and continue.
- EDIT `packages/cli/src/init-rumen.js` — same wiring as init-mnestra.
- EDIT `packages/server/src/setup/rumen/functions/rumen-tick/index.ts` line 34 — `Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL')`. Update the comment on line 14 to mention the fallback.
- EDIT `packages/server/src/setup/rumen/functions/graph-inference/index.ts` line 346 — same fallback. Update line 17 comment.
- After Edge Function source edits, run `npm run sync-rumen-functions` to keep the bundled-stack copy in lock-step. **Verify with `npm pack --dry-run | grep rumen-tick` and `| grep graph-inference` that both files ship in the tarball.**
- NEW `tests/audit-upgrade.test.js` (~10 tests). Mock the pg client + Management API. Cover: each probe (6 missing artifacts → 6 apply paths), idempotent second run (all probes return "present" → applied=[]), partial-apply scenarios (e.g., weight column exists but source_agent doesn't), Rumen 002 templating regression guard (applying with raw `<project-ref>` would surface in the test), SUPABASE_DB_URL fallback fixture (mock both env paths and assert the function picks up either).

## API contract

```js
// audit-upgrade.js
async function auditUpgrade({ pgClient, projectRef, supabasePat }) {
  const probed = [];
  const missing = [];
  const applied = [];
  const errors = [];

  const targets = [
    { name: 'memory_relationships.weight',    migration: '009', kind: 'sql' },
    { name: 'memory_recall_graph RPC',         migration: '010', kind: 'sql' },
    { name: 'memory_taxonomy reclass',          migration: '012', kind: 'sql' },
    { name: 'memory_items audit cols',          migration: '013', kind: 'sql' },
    { name: 'explicit grants',                  migration: '014', kind: 'sql' },
    { name: 'memory_items.source_agent',        migration: '015', kind: 'sql' },
    { name: 'graph-inference-tick cron',        migration: 'TD-003', kind: 'sql', templated: true },
    { name: 'graph-inference Edge Function',    kind: 'function' },
    { name: 'graph_inference_service_role_key', kind: 'vault' },
  ];

  for (const t of targets) {
    probed.push(t.name);
    const present = await probe(pgClient, t);
    if (present) continue;
    missing.push(t.name);
    try {
      await apply(pgClient, t, { projectRef, supabasePat });
      applied.push(t.name);
    } catch (e) {
      errors.push({ name: t.name, error: e.message });
    }
  }

  return { probed, missing, applied, errors };
}
```

Each probe is a single SQL statement or a single Management API call. No batching — per pre-ship checklist item #11. Pure functions for the templated SQL apply path: `applyTemplating(rawSql, { projectRef })` then `pgClient.query(substituted)`.

## Acceptance criteria

1. **Audit-upgrade probes all 9 targets.** Re-run `termdeck init --mnestra && termdeck init --rumen` against a project with all 9 missing — audit applies them in order, exits clean. Order: M-009 → 010 → 012 → 013 → 014 → 015 → TD-003 (templated) → graph-inference function → vault clone. Each apply is logged with a one-line "✓ applied <target>" message.
2. **Idempotent re-run.** Second run reports "✓ install up to date" with `applied=[]`. No errors. No state changes.
3. **Partial-apply correctness.** Project with M-009 already applied but M-010 missing — audit applies only the missing ones, doesn't re-run M-009.
4. **Rumen 002 templating regression guard.** A unit test asserts that the audit-upgrade applier passes `Rumen-002` SQL through `applyTemplating()`. If a future refactor bypasses templating, the test fails.
5. **Edge Function env fallback.** `rumen-tick/index.ts:34` and `graph-inference/index.ts:346` read `Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL')`. Fixture test mocks both env paths and asserts the function picks up either. After source edits, `npm run sync-rumen-functions` produces a clean diff in the bundled-stack copy. `npm pack --dry-run | grep rumen-tick && | grep graph-inference` both succeed.
6. **No regressions.** Sprint 50's 428/428 tests stay green. Fresh-install path on a clean Supabase project still works end-to-end (audit reports "nothing missing on fresh DB after migrations 001-007 + 009-015 + Rumen 001-002 + TD-003 land via the existing path"; or audit lands the artifacts and the existing path becomes a no-op — either is acceptable as long as the end state is correct).

## Coordination

- **T2 (mnestra doctor) delegates the deeper schema check to your audit logic.** T2's "Edge Function presence vs bundled migration set" probe should call into `auditUpgrade({ pgClient, ..., dryRun: true })` and report `missing.length > 0` as a yellow/red. Export an opt-in dry-run mode that returns the missing[] list without applying. Coordinate the API shape with T2 in your FINDING post.
- **T3 (GRAPH_LLM_CLASSIFY prompt + per-secret CLI) edits the same `init-rumen.js`.** T3's per-secret refactor of `setFunctionSecrets` (lines 403-426) and your `auditUpgrade()` wiring near the top of the file are non-conflicting in different sections, but coordinate via STATUS.md FINDING posts to avoid merge headaches at sprint close.
- **T4 (docs propagation) consumes your work for the INSTALLER-PITFALLS.md ledger entry #14 follow-up notes.** Just post your `applied=[]` count + any unexpected probes in DONE so T4 can cite exact numbers.

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="termdeck", query="Sprint 51.5 audit-upgrade schema introspection diff Brad jizzard-brain SUPABASE_DB_URL DATABASE_URL Edge Function fallback Rumen 002 templating placeholder")
3. memory_recall(query="installer failure-class taxonomy schema drift migration runner blindness")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (your canonical reference — failure-class taxonomy + pre-ship checklist + ledger entries #13 + #14)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/STATUS.md
9. Read this brief
10. **Run substrate probe FIRST** (the bash block above against `petvetbid`).
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/cli/src/init-rumen.js (especially lines 403-505 for setFunctionSecrets + applySchedule + SCHEDULE_MIGRATIONS).
12. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/cli/src/init-mnestra.js.
13. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/migration-templating.js.
14. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/rumen/functions/rumen-tick/index.ts (lines 1-50).
15. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/rumen/functions/graph-inference/index.ts (lines 340-360).
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
