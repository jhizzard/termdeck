# Sprint 51.5b — T3 (Claude): GRAPH_LLM_CLASSIFY + per-secret CLI + Vault SQL-Editor URL dogfood

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes T3):**

Provision a fresh throwaway Supabase project. Run `termdeck init --rumen` against it end-to-end. Verify every Sprint 51.5 T3 deliverable works in production: GRAPH_LLM_CLASSIFY install-time prompt, per-secret CLI loop, pg-direct vault.create_secret auto-apply, SQL-Editor deeplink fallback. **Audit-only.**

## Sequence

### 1. Substrate

```bash
date '+%Y-%m-%d %H:%M ET'
which supabase && supabase --version          # confirm CLI is available
which termdeck && termdeck --version          # expect 1.0.1
echo "$ANTHROPIC_API_KEY" | head -c 12        # confirm Anthropic key is in env (don't print full key)
echo "$SUPABASE_ACCESS_TOKEN" | head -c 8     # confirm PAT is in env
```

If any required env var is missing, document and either source from `~/.termdeck/secrets.env` (Joshua's preferred location) or pause and ask.

### 2. Provision a throwaway Supabase project

Joshua-side action: provision a new Supabase project named `termdeck-dogfood-2026-05` (any region; ~2 min). Capture the project ref. Add to `~/.termdeck/secrets.env` temporarily under a distinct key (e.g., `DOGFOOD_PROJECT_REF` and `DOGFOOD_DATABASE_URL`).

If Joshua doesn't want to consume a free-tier slot, the alternative is to run T3 against a side branch of `petvetbid` itself — but that mutates Joshua's daily-driver, which is risky. **Recommendation: throwaway project**. The slot can be deleted after the audit (Supabase free tier permits delete + recreate without long cooldown).

### 3. Run `termdeck init --rumen` against the throwaway

```bash
DATABASE_URL=$DOGFOOD_DATABASE_URL termdeck init --rumen --project-ref $DOGFOOD_PROJECT_REF
```

**What to verify during the wizard run (capture screenshots or stdout transcripts):**

#### 3a. GRAPH_LLM_CLASSIFY prompt (T3-Sprint-51.5 deliverable)

The wizard should surface:

```
Enable AI-classified graph edges? (uses Haiku 4.5; ~$0.003 per 1k edges classified) [Y/n]
```

Verify:
- The cost-explainer text matches exactly.
- The default is Y (Enter without typing accepts).
- Y-path captures `secrets.GRAPH_LLM_CLASSIFY = '1'` and `secrets.ANTHROPIC_API_KEY` in memory.
- N-path leaves GRAPH_LLM_CLASSIFY unset and the wizard's printNextSteps emits the manual-flip command.

Run twice — once accepting Y, once rejecting N — to confirm both paths.

#### 3b. Per-secret CLI loop (T3-Sprint-51.5 deliverable)

During the secrets-setting step, the wizard should run multiple `supabase secrets set KEY=VAL` invocations (one per key), not one multi-arg call. Watch the stdout / strace if available.

```bash
# Post-wizard verify both secrets landed (the v2.90.0 multi-arg parse drift would have only landed one):
supabase secrets list --project-ref $DOGFOOD_PROJECT_REF | grep -E 'GRAPH_LLM_CLASSIFY|ANTHROPIC_API_KEY|DATABASE_URL'
# Expected: 3 lines (DATABASE_URL, ANTHROPIC_API_KEY, GRAPH_LLM_CLASSIFY).
```

If only one or two of the three are present, the per-secret refactor regressed.

#### 3c. Vault auto-apply via pg-direct (T3-Sprint-51.5 deliverable)

Post-wizard verify both vault keys exist:

```bash
DATABASE_URL=$DOGFOOD_DATABASE_URL psql "$DATABASE_URL" -c "select name from vault.secrets where name in ('rumen_service_role_key', 'graph_inference_service_role_key')"
# Expected: 2 rows.
```

If either is missing, the pg-direct auto-apply regressed.

#### 3d. SQL-Editor deeplink fallback (T3-Sprint-51.5 deliverable)

Simulate the auto-apply failure path. Easiest way: revoke `vault.create_secret` privilege from the wizard's connecting role for one second, run the wizard, watch for the deeplink fallback emit, restore the privilege.

Alternative (less destructive): inspect the wizard's printNextSteps output for the deeplink template — confirm it builds `https://supabase.com/dashboard/project/<ref>/sql/new?content=<encoded vault.create_secret call>` correctly. Click the URL; confirm it opens SQL Editor with the call pre-filled.

### 4. Manually fire graph-inference

```bash
curl -X POST "https://$DOGFOOD_PROJECT_REF.supabase.co/functions/v1/graph-inference" \
  -H "Authorization: Bearer $DOGFOOD_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected response (Y-path enabled):** `{"ok":true,"candidates_scanned":N,"edges_inserted":M,"summary":{"llm_classifications":>0,...}}` (the `llm_classifications` count > 0 confirms the LLM path is firing).

**Expected response (N-path):** `summary.llm_classifications` should be 0 or absent; edges still get inserted but with default `relates_to` type.

If `llm_classifications` is 0 on a Y-path run, the GRAPH_LLM_CLASSIFY env var didn't propagate to the Edge Function — that's a regression in the per-secret CLI loop.

### 5. SUPABASE_DB_URL fallback verification

The bundled Edge Function source carries `Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL')` (T1's Sprint 51.5 patch). Verify on the deployed function:

```bash
# Don't set DATABASE_URL; rely on auto-injected SUPABASE_DB_URL.
supabase secrets unset DATABASE_URL --project-ref $DOGFOOD_PROJECT_REF

# Re-fire graph-inference; it should still work (fall back to SUPABASE_DB_URL).
curl -X POST "https://$DOGFOOD_PROJECT_REF.supabase.co/functions/v1/graph-inference" \
  -H "Authorization: Bearer $DOGFOOD_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: still 200 with valid response.

# Restore DATABASE_URL.
supabase secrets set DATABASE_URL=$DOGFOOD_DATABASE_URL --project-ref $DOGFOOD_PROJECT_REF
```

If the function 500s after `unset DATABASE_URL`, the fallback didn't ship correctly.

### 6. Throwaway cleanup

After the audit completes (or T2 finishes its broken-project test on the same throwaway), delete the project:

```bash
# Joshua-side via Supabase dashboard (project settings → delete project).
```

Document the deletion in your DONE post so the slot doesn't linger.

## Acceptance criteria

1. **GRAPH_LLM_CLASSIFY prompt fires correctly.** Both Y-path and N-path paths verified.
2. **Per-secret CLI loop intact.** All 3 secrets land in `supabase secrets list` post-wizard.
3. **Vault auto-apply via pg-direct.** Both vault keys present post-wizard.
4. **SQL-Editor deeplink fallback works.** URL opens correct SQL Editor with `vault.create_secret(...)` pre-filled.
5. **graph-inference Y-path returns `llm_classifications > 0`.** End-to-end LLM classification working.
6. **SUPABASE_DB_URL fallback works.** Function returns 200 even when DATABASE_URL is unset.
7. **Throwaway deleted.** Free-tier slot freed.

## Boot

```
1. Run `date '+%Y-%m-%d %H:%M ET'`.
2. memory_recall(project="termdeck", query="Sprint 51.5b dogfood T3 GRAPH_LLM_CLASSIFY per-secret CLI Vault SQL-Editor pg-direct vault.create_secret throwaway project")
3. memory_recall(project="termdeck", query="Sprint 51.5 T3 init-rumen.js setFunctionSecrets ensureVaultSecrets vaultSqlEditorUrl")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md (Class B + Class D + Class F + Class J)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/PLANNING.md + STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/cli/src/init-rumen.js (the v1.0.1 deliverable you're exercising; especially lines 403-636 for setFunctionSecrets + ensureVaultSecrets + vaultSqlEditorUrl + promptGraphLlmClassify)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/rumen/functions/graph-inference/index.ts (verify SUPABASE_DB_URL fallback at line 350)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. **Audit-only — no code edits, no commits.**
