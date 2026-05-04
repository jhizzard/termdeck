# Sprint 51.5b — v1.0.1 Dogfood Audit (no new code)

**Status:** Plan stub authored 2026-05-03 19:07 ET in response to Codex's 2026-05-03 19:01 ET discovery that Joshua's daily-driver Mnestra (`petvetbid`, ref `luvvbrpaopnblvxdxwzb`) was missing the `memory_items.source_agent` column **despite** Mnestra migration 015 being installed as a file in `~/.npm-global/lib/node_modules/@jhizzard/mnestra/migrations/015_source_agent.sql`. Same Class A drift pattern Brad surfaced on `jizzard-brain` 2026-05-02. Surfacing on Joshua's own machine means v1.0.1 needs to be **dogfooded** before it's relied on as Brad's structural fix.

**Target ship:** No new package versions. Sprint closes when all four lane audits report green; if a lane reports red, a hotfix sprint (51.5c or 51.6) is triggered immediately.

**Canonical reference:** [`docs/INSTALLER-PITFALLS.md`](../INSTALLER-PITFALLS.md) § Failure-class taxonomy A–J + 11-item pre-ship checklist. Every audit lane traces back to a class.

## Why this sprint (in one paragraph)

Sprint 51.5 shipped v1.0.1 with audit-upgrade (T1), `mnestra doctor` (T2), GRAPH_LLM_CLASSIFY install-time prompt + per-secret CLI loop + Vault SQL-Editor URL pivot (T3), and Class J taxonomy (T4) — all written, tested in the lane suites, but **none exercised end-to-end against real production infrastructure on Joshua's box.** The mid-sprint discovery on Joshua's `petvetbid` (Class A drift identical to Brad's pattern, manifesting on the developer's own daily-driver) makes it concrete that v1.0.1 has bugs/gaps the lane tests didn't catch. Sprint 51.5b is an **audit-only dogfood pass**: every lane runs its v1.0.1 deliverable against Joshua's real Mnestra/Rumen infrastructure, documents what works, what surfaces a regression, and what UX rough edges show up that didn't surface in the unit-test sandbox. No code changes; no version bumps. Just exercise + document. If a lane finds a bug, that becomes Sprint 51.6's scope; if all four are green, Brad gets the green-light WhatsApp the next morning.

## Lanes

| Lane | Goal | Probe surface | Failure class addressed |
|---|---|---|---|
| **T1 — petvetbid audit-upgrade dogfood** | Run `termdeck init --mnestra` against `petvetbid` (`luvvbrpaopnblvxdxwzb`). Verify v1.0.1's audit-upgrade detects the source_agent column gap (or confirms it's already fixed by Codex's manual mig 015 application 2026-05-03 19:01 ET); detects any other missing migrations from the bundled set (013, 014, 016); applies them idempotently; reports cleanly. Then run `termdeck init --rumen` against the same project; verify the same audit pass for Rumen schedule migrations 002, 003. Also run against a deliberately broken side branch: drop `memory_relationships.weight` and `cron.job WHERE jobname='graph-inference-tick'` on a test schema; re-run `init --rumen`; expect audit-upgrade detects both gaps and applies M-009 + TD-003. **Sprint 51.6 smoke-test absorbed here:** confirm memory_sessions row count grows after a Claude Code session ends (validates the source_agent hypothesis). | `petvetbid` Supabase (live), `~/.npm-global/lib/node_modules/@jhizzard/termdeck/`, `~/.claude/hooks/memory-session-end.js` exit codes (instrument with timestamp file). | **A — Schema drift** (primary). Plus **E — Hidden dependency** if the hook reveals a private-path import. |
| **T2 — mnestra doctor end-to-end dogfood** | Run `mnestra doctor` against `petvetbid` (post-Codex-mig-015-fix). Document the green/yellow/red output. Cross-check the cron-all-zeros probe against Joshua's actual `rumen_jobs` history (last 10 entries; should be all-zeros for the past ~2 days per the P0 finding). Verify the schema-drift probe surfaces any remaining gaps. Verify the MCP path parity probe correctly identifies `~/.claude.json` as canonical. Then run `mnestra doctor` against a deliberately broken project (drop `memory_relationships.weight` + suspend `graph-inference-tick`); expect 2 reds with specific recommendations citing M-009 + TD-003. **False-positive probe:** run against a fresh-provisioned project (no cron history yet); expect green or yellow on cron-all-zeros (≥6-cycle threshold), never red. | `petvetbid` (live, post-fix), `mnestra doctor` CLI surface, the migration-016 SECURITY DEFINER wrappers (mnestra_doctor_cron_runs, _cron_job_exists, _column_exists, _rpc_exists, _vault_secret_exists). | **I — Silent no-op** (primary; verifies the symptom-side detector works). |
| **T3 — GRAPH_LLM_CLASSIFY + per-secret CLI + Vault SQL-Editor URL dogfood** | Spin up a fresh Supabase test project (Joshua-side; could be a throwaway "termdeck-dogfood-2026-05" project, ~2 min to provision). Run `termdeck init --rumen` against it. Verify: (a) the GRAPH_LLM_CLASSIFY install-time prompt fires with the correct cost-explainer text; (b) Y-path sets both `GRAPH_LLM_CLASSIFY=1` and `ANTHROPIC_API_KEY` as Edge Function secrets via the per-secret CLI loop; (c) `supabase secrets list --project-ref <test-ref>` shows both keys present (the v2.90.0 multi-arg parse drift would have only landed one); (d) the Vault keys (`rumen_service_role_key` + `graph_inference_service_role_key`) auto-applied via pg-direct `vault.create_secret` — `select count(*) from vault.secrets where name in (...)` returns 2; (e) if the auto-apply path fails (simulate by withholding the SUPABASE_ACCESS_TOKEN), the SQL-Editor deeplink fallback emits with a clickable URL pre-filled with `vault.create_secret(...)`. **Manually fire `graph-inference` once** post-install; verify the response includes `summary.llm_classifications > 0` (the Y-path actually enables LLM classification). | A fresh Supabase project (Joshua provisions); `init-rumen.js` wizard surface; `supabase secrets list`; `petvetbid` SQL Editor for the deeplink test. | **D — Silent placeholder** (ANTHROPIC_API_KEY no longer expected-but-unprompted), **F — Default-vs-runtime asymmetry** (verifies the wizard default Y matches Joshua's actual desired-on state), **J — Multi-arg CLI parse drift** (per-secret refactor verified end-to-end against the live CLI v2.90.0). |
| **T4 — Vault SQL-Editor URL UX dogfood + cross-project pattern synthesis + Brad outreach prep** | Verify the wizard's Vault-pivot surfaces work in practice. Click through every SQL-Editor deeplink the wizard emits (preconditions.js audit hint, init-rumen.js printNextSteps, GETTING-STARTED.md). Confirm each pre-fills correctly. Verify `git grep -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/` returns zero hits in active wizard surface (existing in incident-history docs is fine). Then synthesize the cross-project audit pattern: write up what was found in T1-T3 as an **INSTALLER-PITFALLS.md ledger entry #15** if any new failure mode surfaced, OR as a "v1.0.1 dogfood — clean" note in STATUS.md if everything was green. Final deliverable: a one-paragraph WhatsApp-ready message for Brad summarizing what Joshua found on his own box (positive or negative; transparent either way). Joshua sends it via the standing wa.me deep-link inject pattern. | `packages/server/src/setup/preconditions.js`, `packages/cli/src/init-rumen.js:622-624` (printNextSteps), `docs/GETTING-STARTED.md:257`, `docs/INSTALLER-PITFALLS.md` for ledger entry #15 if needed. | **B — Path mismatch** (Vault dashboard removal), plus meta-coverage for any class T1-T3 surfaces fresh. |

## Acceptance criteria

1. **T1 audit-upgrade green.** `termdeck init --mnestra && termdeck init --rumen` against `petvetbid` exits clean. Audit reports either "nothing to do" (Codex's manual fix already closed the source_agent gap) OR detects the remaining gap and applies missing migrations idempotently. Re-run reports "nothing to do."
2. **T1 deliberately broken project green.** Audit detects the dropped `memory_relationships.weight` + suspended `graph-inference-tick`, applies M-009 + TD-003, exits clean.
3. **T1 hook hypothesis verified.** After Codex's mig 015 fix, the next Claude Code session that ends writes a row to `memory_sessions` (psql probe before/after; row count grew). Confirms the source_agent column was the silent-failure root cause.
4. **T2 mnestra doctor green on petvetbid.** Output shows accurate state — likely red on cron-all-zeros for 2+ days (the P0 symptom), recommendation cites `INSTALLER-PITFALLS.md ledger #13` correctly, suggests `termdeck init --rumen`.
5. **T2 mnestra doctor red on broken project.** Two specific reds with file/migration references in the recommendation strings.
6. **T2 cold-boot tolerance.** Fresh project (≤5 cron runs) does NOT fire red; matches the ≥6-cycle threshold.
7. **T3 GRAPH_LLM_CLASSIFY end-to-end.** Y-path on a fresh project lands both secrets via per-secret CLI; manually firing graph-inference returns `llm_classifications > 0`. N-path writes the README hint correctly.
8. **T3 Vault auto-apply path.** Both vault keys created via pg-direct on a fresh project. Withholding the PAT triggers the deeplink fallback; the deeplink works (opens SQL Editor with `vault.create_secret(...)` pre-filled).
9. **T4 wizard text clean.** `git grep -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/` returns zero hits in active wizard surface.
10. **T4 outreach prep.** WhatsApp-ready message drafted; Joshua sends via the standing wa.me deep-link inject. Brad gets a confirmation that Joshua dogfooded v1.0.1 and what the result was.

## Pre-sprint substrate findings (orchestrator probes at kickoff)

```bash
date '+%Y-%m-%d %H:%M ET'
npm view @jhizzard/termdeck version           # expect 1.0.1
npm view @jhizzard/mnestra version            # expect 0.4.1
npm view @jhizzard/rumen version              # expect 0.4.5
npm view @jhizzard/termdeck-stack version     # expect 0.6.1

# Confirm Codex's mig 015 fix held on petvetbid
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-) && \
  psql "$DATABASE_URL" -c "select column_name from information_schema.columns where table_name='memory_items' and column_name='source_agent'"

# Pre-test memory_sessions row count baseline (T1's hook hypothesis test)
psql "$DATABASE_URL" -c "select count(*) as rows, max(ended_at) as last from memory_sessions"

# Confirm rumen_jobs cron history (T2's all-zeros probe baseline)
psql "$DATABASE_URL" -c "select status, end_time - start_time as duration, end_time from cron.job_run_details where jobid in (select jobid from cron.job where jobname='rumen-tick') order by end_time desc limit 12"
```

## Risks

- **T3 needs a fresh Supabase test project.** Provisioning a throwaway adds ~2 min and consumes one of Joshua's free-tier project slots. Mitigation: name it `termdeck-dogfood-2026-05`, plan to delete after the audit. Alternative: T3 runs against a side branch on `petvetbid` itself (drop the GRAPH_LLM_CLASSIFY secret if present, re-run the wizard) — but that pollutes Joshua's daily-driver. Recommendation: throwaway project.
- **T1 deliberately broken side branch.** Mutating `petvetbid`'s schema even temporarily is risky if Joshua forgets to revert. Mitigation: T1 does the broken-project test on the same throwaway T3 provisions, not on `petvetbid`.
- **T2 against petvetbid will likely show red on cron-all-zeros.** That's expected — the P0 symptom should still fire even after Codex's mig 015 fix because the cron has been running zero-output for 2+ days. The doctor is correctly identifying the still-broken state. T1's hook fix should resolve it; T2 re-runs after T1 to confirm green.
- **Sprint 51.6 absorbed into 51.5b T1.** Originally Sprint 51.6 was scheduled as a separate hotfix; the source_agent hypothesis test fits cleanly into T1's scope. If T1 confirms the hypothesis, Sprint 51.6 closes inline. If T1 disproves it, Sprint 51.6 spins out as originally planned.

## Companion artifacts

- If T4 surfaces a fresh failure class, append ledger entry #15 + (if a new class) row K to the failure taxonomy in `docs/INSTALLER-PITFALLS.md`.
- If all four lanes are green, the green-light Brad WhatsApp goes out same-day — confirms v1.0.1 is dogfooded clean.
- Optional: a one-line CHANGELOG `[Unreleased]` note documenting the dogfood pass — useful for the v1.0.2 wave (when one ships) to reference what 51.5b validated.

## Lane discipline

This sprint is **audit-only**. No code changes, no version bumps, no CHANGELOG edits, no commits. Each lane runs probes, documents findings in STATUS.md FINDING posts, and posts a one-line PASS/FAIL verdict in DONE. The orchestrator decides at sprint close whether any FAIL surfaces a Sprint 51.6 / 51.6c hotfix.
