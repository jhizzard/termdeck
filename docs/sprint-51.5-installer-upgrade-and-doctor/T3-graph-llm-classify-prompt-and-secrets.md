# Sprint 51.5 — T3 (Claude): Install-time GRAPH_LLM_CLASSIFY prompt + per-secret CLI calls + Vault SQL-Editor URL

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T3; canonical reference in [docs/INSTALLER-PITFALLS.md](../INSTALLER-PITFALLS.md) § Failure-class taxonomy):**

Addresses **Class B (Path mismatch)** for the Vault UI removal, **Class D (Silent placeholder)** for the unprompted ANTHROPIC_API_KEY, **Class F (Default-vs-runtime asymmetry)** for the GRAPH_LLM_CLASSIFY toggle, and the **NEW Class J (Multi-arg CLI parse drift / multi-line clipboard shred)** introduced this sprint. Satisfies pre-ship checklist items #5 (path parity), #6 (no literal-placeholder writes), #9 (defaults match runtime), and #11 (one logical operation per CLI invocation).

Three sub-fixes ride this lane:

1. **GRAPH_LLM_CLASSIFY install-time prompt.** Wire the toggle into `init-rumen.js`. Today, the `graph-inference` Edge Function defaults edges to `relates_to` unless `GRAPH_LLM_CLASSIFY=1` AND `ANTHROPIC_API_KEY` are set as Edge Function secrets. No install path covers this — Joshua's daily-driver `petvetbid` may have it set manually; new installs definitely don't.

2. **Per-secret CLI calls.** Refactor `setFunctionSecrets` at `init-rumen.js:403-426` from a single multi-arg `supabase secrets set` invocation to one CLI call per secret. Brad's 2026-05-03 takeaway #3: v2.90.0 multi-arg parsing silently drops some secrets and materializes stray entries (Brad observed `brad.a.heath@gmail.com` parsed as a secret name). One logical operation per CLI invocation per checklist item #11.

3. **Vault SQL-Editor URL pivot.** Brad's 2026-05-03 takeaway #2: the Supabase Vault dashboard panel has been quietly removed/relocated. Wizard text instructing users to "click Vault" is broken. Replace with a SQL-Editor deeplink that pre-fills `select vault.create_secret('<key>', '<value>');` per required secret, OR run the call automatically via `supabase db query --linked` when the PAT path is available.

## Critical pre-lane substrate probe

```bash
# Confirm GRAPH_LLM_CLASSIFY status on petvetbid (Joshua's daily driver).
supabase secrets list --project-ref luvvbrpaopnblvxdxwzb 2>&1 | grep -E 'GRAPH_LLM_CLASSIFY|ANTHROPIC_API_KEY'
# If both present → Joshua's project has the flag; T3 wiring just needs to cover fresh installs.
# If absent → T3 prompt will set them on Joshua's project too on next init-rumen re-run; flag in FINDING.

# Confirm what's in ~/.termdeck/secrets.env (PAT availability for the auto-set path).
test -f ~/.termdeck/secrets.env && grep -E 'SUPABASE_ACCESS_TOKEN|ANTHROPIC_API_KEY' ~/.termdeck/secrets.env || echo "missing"

# Find every wizard text mentioning Vault dashboard.
grep -rn -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/ 2>/dev/null
```

If sandbox blocks `supabase secrets list`, document in FINDING and ask the orchestrator for an authorized run.

## Files

- EDIT `packages/cli/src/init-rumen.js`:
  - Add prompt block (~30 LOC) before `setFunctionSecrets()` is called: "Enable AI-classified graph edges? (uses Haiku 4.5; ~$0.003 per 1k edges classified) [Y/n]". On Y, capture `enableLlmClassify=true` and ensure `ANTHROPIC_API_KEY` is in `secrets`. On N, write `# GRAPH_LLM_CLASSIFY=0  # set to 1 to enable LLM edge classification` to the install-output README.
  - Refactor `setFunctionSecrets()` (lines 403-426) into a per-secret loop. Keep the existing dry-run + log shape, but issue N independent `supabase secrets set KEY=VAL` invocations (one per key). Check exit code per call. Surface stderr on per-call failure with the key name. Maintain ordering: DATABASE_URL first, ANTHROPIC_API_KEY, OPENAI_API_KEY (if present), GRAPH_LLM_CLASSIFY (if Y).
- EDIT install-output README template (likely at `packages/cli/templates/` or wherever the wizard's post-install summary is written — grep for the existing "click Vault" text to find it):
  - Replace any "click Vault in the dashboard" instruction with a SQL-Editor deeplink: `https://supabase.com/dashboard/project/<project-ref>/sql/new?content=<url-encoded-vault.create_secret-call>` per required secret.
  - Alternative path: if `~/.termdeck/secrets.env` has a usable `SUPABASE_ACCESS_TOKEN` (not the literal `SUPABASE_PAT_HERE` placeholder), run `supabase db query --linked` automatically and skip the deeplink path.
- EDIT any wizard prompt text in `packages/stack-installer/` referencing "click Vault" — search-and-replace with the SQL-Editor pivot.
- NEW `tests/init-rumen-graph-llm.test.js` (~3 tests). Mock `prompts` (or whatever the wizard uses) and `runShellCaptured`. Cover: Y-path sets both secrets via per-secret calls, N-path writes the README comment, prompt-default behavior.
- NEW `tests/init-rumen-secrets-per-call.test.js` (~3 tests). Simulate a v2.90.0-style multi-arg drop by mocking `runShellCaptured` to "succeed but only land 1 of 3 secrets" — verify the per-call refactor lands all 3. Verify exit-code-per-call surfacing on partial failure. Verify ordering.

## API contract

```js
// init-rumen.js — replace the existing setFunctionSecrets
function setFunctionSecrets(secrets, dryRun) {
  const orderedKeys = ['DATABASE_URL', 'ANTHROPIC_API_KEY'];
  if (secrets.OPENAI_API_KEY) orderedKeys.push('OPENAI_API_KEY');
  if (secrets.GRAPH_LLM_CLASSIFY) orderedKeys.push('GRAPH_LLM_CLASSIFY');

  step(`Setting function secrets (${orderedKeys.join(', ')})...`);
  if (dryRun) { ok('(dry-run)'); return true; }

  for (const key of orderedKeys) {
    const value = secrets[key];
    if (value === undefined || value === null || value === '') {
      fail(`secret ${key} missing from in-memory secrets map — wizard wiring bug`);
      return false;
    }
    const r = runShellCaptured('supabase', ['secrets', 'set', `${key}=${value}`]);
    if (!r.ok) {
      fail(`secrets set ${key} failed (exit ${r.code})`);
      if (r.stderr) process.stderr.write(r.stderr + '\n');
      return false;
    }
  }
  ok(secrets.OPENAI_API_KEY ? '(hybrid mode)' : '(keyword-only mode — OPENAI_API_KEY not set)');
  return true;
}
```

```js
// install-output README — Vault SQL-Editor URL builder
function vaultSqlEditorUrl(projectRef, secretName, secretValue) {
  const sql = `select vault.create_secret('${secretValue.replace(/'/g, "''")}', '${secretName}');`;
  const encoded = encodeURIComponent(sql);
  return `https://supabase.com/dashboard/project/${projectRef}/sql/new?content=${encoded}`;
}
```

(Argument order is `vault.create_secret(secret_value, secret_name)` — verify against the Supabase docs in your boot sequence; the API signature has flipped at least once historically.)

## Acceptance criteria

1. **GRAPH_LLM_CLASSIFY prompt fires.** Fresh `termdeck init --rumen` on a clean project surfaces the toggle. Y-path sets both `GRAPH_LLM_CLASSIFY=1` and `ANTHROPIC_API_KEY` as Edge Function secrets via per-secret calls; manually firing graph-inference returns `summary.llm_classifications > 0` on a candidate edge. N-path writes a README line explaining the flip command (`supabase secrets set GRAPH_LLM_CLASSIFY=1`).
2. **Per-secret CLI calls.** `setFunctionSecrets` issues N independent `supabase secrets set KEY=VAL` invocations. Test simulates v2.90.0-style multi-arg drop and verifies the per-call path still lands every secret. Exit code per call is checked; stderr surfaced on per-call failure with the key name.
3. **Vault SQL-Editor URL.** `git grep -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/` returns zero hits. Wizard install-output README contains a SQL-Editor deeplink per required secret. URL passes a smoke test (open in browser → SQL Editor opens with the `vault.create_secret` call pre-filled).
4. **Auto-set path when PAT available.** When `~/.termdeck/secrets.env` has a non-placeholder `SUPABASE_ACCESS_TOKEN`, the wizard runs `supabase db query --linked` for vault.create_secret automatically and skips the deeplink. When the PAT is missing or is the literal `SUPABASE_PAT_HERE` placeholder, the deeplink is emitted instead.
5. **No regressions.** Sprint 50's 428/428 tests stay green. Existing fresh-install path on a clean Supabase project still works end-to-end.

## Coordination

- **T1 also edits `init-rumen.js`** (calling `auditUpgrade()` near the top). Your edits are in `setFunctionSecrets` (lines 403-426) and a new prompt block (likely before the call to `setFunctionSecrets`). Different sections. Coordinate via STATUS.md FINDING posts; merge order is up to the orchestrator.
- **T2 + T4 are independent of T3.**
- **Joshua's project (`petvetbid`) is the canary.** If the substrate probe shows `GRAPH_LLM_CLASSIFY` is NOT set on Joshua's project today, your prompt's Y-path will set it on his next `init-rumen` re-run — flag this in FINDING so the orchestrator can confirm before merge.

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="termdeck", query="Sprint 51.5 GRAPH_LLM_CLASSIFY prompt per-secret CLI calls Supabase secrets set v2.90.0 Vault dashboard removed Brad")
3. memory_recall(query="installer failure-class taxonomy silent placeholder default-vs-runtime")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (Class B, D, F, J)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/PLANNING.md
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/STATUS.md
9. Read this brief
10. **Run substrate probe FIRST** (the bash block above).
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/cli/src/init-rumen.js (full file; especially lines 403-426 for setFunctionSecrets and the surrounding prompt flow).
12. grep for the install-output README template (likely in packages/cli/templates/ or packages/cli/src/init-output.js).
13. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/rumen/functions/graph-inference/index.ts (the env vars it reads — confirms what GRAPH_LLM_CLASSIFY guards).
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
