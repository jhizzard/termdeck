# T3 — Fresh-project end-to-end + Brad outreach prep

You are T3 in Sprint 51.5b (v1.0.5 dogfood audit, 3+1+1, audit-only).

## Boot sequence

1. `memory_recall(project="termdeck", query="Sprint 51.5 GRAPH_LLM_CLASSIFY per-secret CLI Vault SQL Editor deeplink T3")`
2. `memory_recall(project="termdeck", query="Sprint 51.8 settings.json migration Sprint 52.1 match_memories do$$ guard v1.0.4 v1.0.5 Brad jizzard-brain")`
3. `memory_recall(query="Brad install pass jizzard-brain v1.0.2 v1.0.3 v1.0.4 wa.me deep-link inject")`
4. Read `~/.claude/CLAUDE.md` — note the three hardening rules at the top.
5. Read `./CLAUDE.md`
6. Read `docs/sprint-51.5b-dogfood-audit/PLANNING.md`
7. Read `docs/sprint-51.5b-dogfood-audit/STATUS.md`
8. Read this brief end-to-end.
9. Read `packages/cli/src/init-rumen.js` lines 403-636 (setFunctionSecrets + ensureVaultSecrets + vaultSqlEditorUrl + promptGraphLlmClassify — Sprint 51.5 T3's deliverables).

## Pre-sprint intel

T3 has THREE responsibilities in this sprint:

1. **Provision a throwaway Supabase project** (`termdeck-dogfood-2026-05-04`) and run `termdeck init --mnestra && termdeck init --rumen` against it. Verify v1.0.1's GRAPH_LLM_CLASSIFY + per-secret + Vault paths still work end-to-end on a fresh install AND v1.0.5's full new-install path lands cleanly on a clean HOME.
2. **Verify the Vault SQL-Editor URL UX surfaces** (folded from old T4 lane): every deeplink works, no stale "click Vault tab" wording lingers in active wizard surface.
3. **Draft a one-paragraph WhatsApp message for Brad** summarizing what dogfood found. Orchestrator already sent a v1.0.4 green-light at 13:50 ET (file at `/tmp/brad-v1-0-4-greenlight.txt`); your draft updates it to v1.0.5 (which closes the migration-001 drift Brad's jizzard-brain hits when he runs `init --mnestra`). Orchestrator sends post-Codex-VERIFIED.

## Probe sequence

Phase A — Provision throwaway project + connect:

```bash
date '+%Y-%m-%d %H:%M ET'
# Joshua-side: provision via Supabase dashboard OR CLI; name it termdeck-dogfood-2026-05-04
# Get DATABASE_URL + SERVICE_ROLE_KEY + ANON_KEY + PROJECT_REF; save to /tmp/sprint-51.5b-t3-secrets.env
# Either prompt Joshua to provision and post the connection details, OR provision via the CLI if you have access.
```

Coordinate via STATUS.md if you need Joshua to provision manually. Once provisioned, post `### [T3] FINDING — fresh project ready DATABASE_URL=<scrubbed>` so T1 + T2 can reach the same fixture for their broken-side-branch probes (Phase E in T1, Phase B in T2).

Phase B — `termdeck init --mnestra` against fresh project (clean HOME path):

```bash
mkdir -p /tmp/sprint-51.5b-t3-home/.claude/hooks
HOME=/tmp/sprint-51.5b-t3-home DATABASE_URL=$DOGFOOD_DB \
  SUPABASE_URL=$DOGFOOD_URL SUPABASE_SERVICE_ROLE_KEY=$DOGFOOD_SVC_KEY OPENAI_API_KEY=$OPENAI_API_KEY \
  termdeck init --mnestra --from-env 2>&1 | tee /tmp/sprint-51.5b-t3-init-mnestra.log
```

Verify in stdout (this is a clean install — no prior anything):
- `→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ installed v2 (no prior copy)` — status = `installed`, NOT `refreshed` (no prior file).
- `→ Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ installed (SessionEnd)` — status = `installed`, NOT `migrated-from-stop` (no prior settings.json).
- `→ Applying migration 001_mnestra_tables.sql... ✓ (~80-200ms)` — fast on fresh DB; do$$ loop iterates ZERO times (no prior match_memories), then CREATE OR REPLACE lands canonical.
- All migrations apply cleanly; audit-upgrade passes; exit 0.

Verify on disk:
- `cat /tmp/sprint-51.5b-t3-home/.claude/hooks/memory-session-end.js` exists, ~898 LOC, stamp `v2`
- `cat /tmp/sprint-51.5b-t3-home/.claude/settings.json` exists with `hooks.SessionEnd[0].hooks[0].command = 'node ~/.claude/hooks/memory-session-end.js'`

Phase C — `termdeck init --rumen` against fresh project (GRAPH_LLM_CLASSIFY + Vault):

```bash
HOME=/tmp/sprint-51.5b-t3-home DATABASE_URL=$DOGFOOD_DB \
  termdeck init --rumen --from-env 2>&1 | tee /tmp/sprint-51.5b-t3-init-rumen.log
```

When the GRAPH_LLM_CLASSIFY prompt fires, choose Y. Verify:
- Cost-explainer text appears with correct token estimate
- Per-secret CLI loop sets BOTH `GRAPH_LLM_CLASSIFY=1` AND `ANTHROPIC_API_KEY` as Edge Function secrets
- `supabase secrets list --project-ref $DOGFOOD_REF` shows both keys present
- Vault keys (`rumen_service_role_key` + `graph_inference_service_role_key`) auto-applied via pg-direct `vault.create_secret`:
  ```bash
  psql "$DOGFOOD_DB" -c "select count(*) from vault.secrets where name in ('rumen_service_role_key','graph_inference_service_role_key')"
  # expect: 2
  ```

Phase D — Vault SQL-Editor deeplink fallback (PAT withhold):

```bash
HOME=/tmp/sprint-51.5b-t3-home DATABASE_URL=$DOGFOOD_DB unset SUPABASE_ACCESS_TOKEN; \
  termdeck init --rumen --from-env --skip-vault-pg 2>&1 | tee /tmp/sprint-51.5b-t3-deeplink.log
```

Verify the deeplink emits with a clickable URL pre-filled with `vault.create_secret(...)`. Click through (manually) — confirm Supabase SQL Editor opens with the SQL pre-populated.

Phase E — graph-inference Y-path validation:

```bash
SUPABASE_URL=$DOGFOOD_URL SUPABASE_SERVICE_ROLE_KEY=$DOGFOOD_SVC_KEY \
  curl -s -X POST "$DOGFOOD_URL/functions/v1/graph-inference" \
  -H "Authorization: Bearer $DOGFOOD_SVC_KEY" -H "Content-Type: application/json" \
  -d '{"manual": true}' | tee /tmp/sprint-51.5b-t3-graph-inf.json
```

Parse the response — verify `summary.llm_classifications > 0` (proves the Y-path actually enabled LLM classification, not just wrote the secret without using it).

Phase F — Vault wizard text grep:

```bash
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
git grep -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/
```

Verify zero hits in active wizard surface (`packages/cli/src/init-*.js`, `packages/server/src/setup/preconditions.js`, `docs/GETTING-STARTED.md`). Hits in `CHANGELOG.md` or `docs/sprint-*` historical docs are fine.

Phase G — Brad WhatsApp draft (v1.0.5 follow-up):

After T1 + T2 + T3 phases A-F all green, draft a one-paragraph message for Brad. The v1.0.4 message orchestrator sent at 13:50 ET (file at `/tmp/brad-v1-0-4-greenlight.txt`) closed the settings.json wiring bug. v1.0.5 closes the migration-001 drift that would have given his jizzard-brain wizard an exit-5 even on v1.0.4. Pre-staged template lives at `/tmp/brad-whatsapp-v1-0-5-greenlight.txt` (orchestrator stages this in parallel; if it doesn't exist, draft from scratch).

Adapt to actual dogfood findings:

- **If all green:** v1.0.5 closes the last v0.6.x→v1.0.x onion ring (match_memories migration-001 drift). When Brad runs `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` on jizzard-brain, the wizard now exits 0 instead of 5. Mig 001 will run slow (~9s on his install — same as Joshua's 14:26 ET case) as the do$$ guard rebuilds match_memories with the canonical signature; subsequent re-runs are sub-200ms.
- **If any RED:** draft a "v1.0.5 dogfood found <X>; Sprint 51.9 hotfix in flight; hold on running init --mnestra on jizzard-brain until v1.0.6."

Post the draft to STATUS.md as `### [T3] DRAFT — Brad WhatsApp v1.0.5` so T4-CODEX can audit before orchestrator sends.

## Cross-lane idle-poll (CLAUDE.md hardening rule 3)

T3 idle-polls until T1 posts DONE AND T2 posts DONE. **Use a tolerant regex:**

```bash
grep -E "^(### )?\[T(1|2)\] DONE\b" docs/sprint-51.5b-dogfood-audit/STATUS.md
```

Note the `(### )?` — matches BOTH `### [T1] DONE` AND `[T1] DONE`. Sprint 51.7 T3 missed T1's bare-prefix `[T1] DONE` post for many minutes because their regex required `### `. Don't repeat that.

If both T1 and T2 have posted DONE, proceed to Brad outreach prep (Phase G). Until then, post `### [T3] STANDBY 2026-05-04 HH:MM ET — awaiting T1 + T2 DONE; polling tolerant regex` and idle-poll every 2 min.

## Lane discipline + post shape

- **No code changes.** No version bumps. No CHANGELOG edits. No commits.
- **Post shape:** every STATUS.md post starts with `### [T3] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>`. The `### ` prefix is REQUIRED.
- Stay in lane: do NOT touch the bundled hook (T2's domain via the metadata work), do NOT touch petvetbid (T1's surface), do NOT actually send Brad anything (orchestrator sends post-VERIFY).

## When you're done

Post `### [T3] DONE 2026-05-04 HH:MM ET — <PASS or RED on phase X>` with full evidence dump AND the Brad WhatsApp draft inline.

Begin.
