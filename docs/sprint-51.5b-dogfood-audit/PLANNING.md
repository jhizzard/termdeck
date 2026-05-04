# Sprint 51.5b — v1.0.3 Dogfood Audit (3+1+1, no new code)

**Status:** Plan REFRESHED 2026-05-04 ~11:30 ET. Original v1.0.1-baseline plan (2026-05-03 19:07) is superseded — Sprints 51.6 (v1.0.2, Class M) and 51.7 (v1.0.3, wizard wire-up + transcript metadata) shipped between then and now. The dogfood target is now the **v1.0.3 wave** (termdeck@1.0.3 + termdeck-stack@0.6.3 + mnestra@0.4.2 from 51.6, rumen unchanged at 0.4.5).

**Pattern:** 3+1+1 (3 Claude workers + 1 Codex auditor). Sprint 51.6 was the first sprint to use this pattern; Sprint 51.7 the second. Both confirmed Codex catches gaps the all-Claude lanes share-blind on. Original 51.5b plan predates the canonization of 3+1+1 in `~/.claude/CLAUDE.md` § Sprint role architecture (added 2026-05-03 20:17 ET).

**Target ship:** No new package versions. Sprint closes when T1+T2+T3 report green AND T4-CODEX posts `DONE — VERIFIED`. If a lane reports red, a hotfix sprint (51.7.1 / 51.8) is triggered immediately.

**Canonical reference:** [`docs/INSTALLER-PITFALLS.md`](../INSTALLER-PITFALLS.md) § Failure-class taxonomy A–M + 12-item pre-ship checklist (Class M added by Sprint 51.6, item #12 added by Sprint 51.6 close-out, ledger entry #16 likely added by Sprint 51.7 if Codex's migration-001 return-type-drift finding surfaces a new class).

## Why this sprint

The v1.0.3 wave fixes the structural memory-ingestion chain end-to-end:
- **v1.0.2 (Sprint 51.6):** Closed Class M — bundled session-end hook gained `postMemorySession()` write path + Mnestra mig 017 reconciles canonical engram schema with rag-system writer's richer column set + `refreshBundledHookIfNewer()` helper added to `init-mnestra.js`.
- **v1.0.3 (Sprint 51.7):** Closed wizard wire-up bug — `termdeck init --mnestra` actually fires the hook refresh on existing installs (root cause: `applyMigrations()` was throwing on migration-001 return-type drift before line 675 ever executed; T1 to land the fix). Plus transcript-derived metadata population (started_at / duration_minutes / facts_extracted) and bundled-hook stamp v1 → v2.

But every prior structural fix on this codebase has had at least one bug the lane unit tests didn't catch. Sprint 51.6 had three (idempotency, packaging gap, overwrite-safety) caught by Codex pre-publish, plus the wizard wire-up that surfaced ONLY in Phase B live verification. Sprint 51.7 is fixing the wizard wire-up — but until v1.0.3 has been **dogfooded end-to-end against Joshua's daily-driver `petvetbid` AND a fresh Brad-shape install**, we cannot tell Brad "v1.0.3 closes the structural gap" with confidence.

**This sprint exercises every v1.0.3 promise against real production infrastructure**, documents what works, and surfaces any v1.0.3-broke-something-else regressions before Brad re-runs `termdeck init --mnestra` on jizzard-brain. Audit-only — no code, no version bumps, no commits. If a lane finds a bug, that becomes Sprint 51.8's scope.

## Lanes

| Lane | Owner | Goal | Primary surface | Failure classes |
|---|---|---|---|---|
| **T1 — petvetbid audit-upgrade + hook-refresh dogfood** | Claude | Run `termdeck init --mnestra` against `petvetbid` (`luvvbrpaopnblvxdxwzb`) on the fresh v1.0.3 install. Verify (a) audit-upgrade probe set still detects all 10 mig drifts idempotently (Sprint 51.6 ext), (b) Sprint 51.7 wizard wire-up actually refreshes `~/.claude/hooks/memory-session-end.js` to bundled v2 — NO MANUAL `node -e` dance needed, (c) backup file written with timestamp, (d) memory_sessions row count grows after a fresh `/exit` AND the row has `started_at` / `duration_minutes` / `facts_extracted` populated (Sprint 51.7 T2 metadata work), (e) `tests/project-taxonomy.test.js` stays at 25/25 pass post-refresh, (f) re-run is idempotent (`up-to-date` not `refreshed`). Then run against deliberately broken side-branch (drop `memory_relationships.weight` AND `cron.job WHERE jobname='graph-inference-tick'` on a throwaway test schema/project); expect audit-upgrade detects + applies M-009 + TD-003 cleanly. | `petvetbid` Supabase (live), `~/.npm-global/lib/node_modules/@jhizzard/termdeck/`, `~/.claude/hooks/memory-session-end.js`, `tests/project-taxonomy.test.js`. | **A — Schema drift**, **M — Architectural omission** (regression check). |
| **T2 — mnestra doctor + metadata completeness dogfood** | Claude | Run `mnestra doctor` against `petvetbid` (post-v1.0.3, post-T1-refresh). Document green/yellow/red output; cross-check cron-all-zeros probe against actual `rumen_jobs` history (should now be RECOVERING — first new memory_sessions writes in 3 days unblock Rumen's chew). Verify schema-drift probe shows nothing (audit-upgrade already healed). Verify MCP path parity probe still identifies `~/.claude.json` as canonical AND now ALSO shows the three new MCP wirings (codex/gemini/grok mnestra entries from this morning's wiring — see `~/.claude/projects/.../memory/reference_mcp_wiring.md`). Run against deliberately broken project (drop `memory_relationships.weight` + suspend `graph-inference-tick`); expect 2 reds with M-009 + TD-003 recommendations. False-positive probe: fresh-provisioned project (no cron history); expect green or yellow on cron-all-zeros (≥6-cycle threshold), never red. **Plus Sprint 51.7 metadata verification:** confirm new memory_sessions rows on petvetbid carry non-NULL `started_at` / `duration_minutes` AND `facts_extracted ≥ 0` (parser counts BOTH `mcp__mnestra__memory_remember` AND legacy `mcp__memory__memory_remember`, per Codex's 11:09 ET finding). | `petvetbid` (live, post-v1.0.3), `mnestra doctor` CLI, mig 016 SECURITY DEFINER wrappers, fresh memory_sessions rows. | **I — Silent no-op** (regression check), **G — Metadata parity** (new). |
| **T3 — Fresh-project end-to-end + Brad outreach prep** | Claude | Spin up a fresh Supabase test project (Joshua-side, name it `termdeck-dogfood-2026-05-04`, ~2 min). Run `termdeck init --mnestra && termdeck init --rumen` against it. Verify: (a) GRAPH_LLM_CLASSIFY install-time prompt fires with correct cost-explainer text; (b) Y-path sets BOTH `GRAPH_LLM_CLASSIFY=1` AND `ANTHROPIC_API_KEY` as Edge Function secrets via per-secret CLI loop (Sprint 51.5 T3); (c) `supabase secrets list --project-ref <test-ref>` shows both keys present; (d) Vault keys (`rumen_service_role_key` + `graph_inference_service_role_key`) auto-applied via pg-direct `vault.create_secret` — `select count(*) from vault.secrets where name in (...)` returns 2; (e) if auto-apply fails (simulate by withholding `SUPABASE_ACCESS_TOKEN`), SQL-Editor deeplink fallback emits with clickable URL pre-filled with `vault.create_secret(...)`. Manually fire `graph-inference` once post-install; verify response includes `summary.llm_classifications > 0`. **Verify Sprint 51.7 wire-up on a clean install too:** the bundled hook should land via `init --mnestra` first-run (no upgrade case) — `installed` status, not `refreshed`. **Folded from old T4:** verify Vault SQL-Editor deeplinks work in practice (preconditions.js audit hint, init-rumen.js printNextSteps, GETTING-STARTED.md); `git grep -i "click.*vault\|vault.*tab\|vault.*dashboard" packages/ docs/` returns zero hits in active wizard surface. **Final deliverable:** one-paragraph WhatsApp-ready message for Brad summarizing what dogfood found (positive or negative). Orchestrator sends via wa.me deep-link inject (auto-authorized). | Fresh Supabase project (Joshua provisions), `init-rumen.js` wizard, `supabase secrets list`, Vault SQL Editor deeplinks. | **D — Silent placeholder**, **F — Default-vs-runtime asymmetry**, **J — Multi-arg CLI parse drift**, **B — Path mismatch** (Vault dashboard removal). |
| **T4 — Codex independent audit (Brad-shape reproduction + adversarial verification)** | **Codex** (auditor role) | Independently reproduce T1/T2/T3 findings using a separate fixture path. **Specifically: simulate Brad's jizzard-brain shape** — provision OR adopt a side project that does NOT have Joshua's deep `~/.claude.json` MCP wiring, has a fresh-ish but non-empty `~/.claude/hooks/memory-session-end.js` (use a stale 508-LOC pre-Sprint-50 fixture), and was originally provisioned weeks ago (so it has the kind of long-lived schema drift Brad exhibits). Run `npm install -g @jhizzard/termdeck@1.0.3 && termdeck init --mnestra` against it. Verify (independently from T1's claims): (a) refresh actually fires (status=`refreshed`, backup created), (b) installed hook lands at v2 byte-identical to bundled, (c) memory_sessions row writes after `/exit` with full metadata, (d) audit-upgrade probe set covers the v2 column shape AND mig 017 self-heals if missing. Audit T2's `mnestra doctor` claims by running it independently on the same Brad-shape fixture. Audit T3's fresh-project claims — were the Vault deeplinks pre-filled correctly OR did the URL-encoded payload truncate? Audit T3's WhatsApp draft for accuracy + tone — does it match what dogfood actually surfaced? **Post `[T4-CODEX]` entries with file:line evidence on every claim.** Final: `[T4-CODEX] DONE — VERIFIED` (sprint clean) or `[T4-CODEX] DONE — REOPEN T<n>` (specific lane has unresolved gap). | Brad-shape fixture (separate from petvetbid), independent reproduction of T1/T2/T3 surfaces, Joshua's published v1.0.3 binary post-publish. | **Cross-cutting** — Codex catches the gaps the three Claude lanes share-blind on. |

## Acceptance criteria

1. **T1 audit-upgrade + refresh green on petvetbid.** `termdeck init --mnestra` exits clean. Audit reports nothing-to-do (mig 017 already applied via Sprint 51.6 manual). Hook refreshes from v1 to v2 (status=`refreshed`); backup file written; re-run reports `up-to-date`.
2. **T1 memory_sessions write + metadata green.** Fresh `/exit` writes a row to `memory_sessions` with `started_at` IS NOT NULL, `duration_minutes` IS NOT NULL, `facts_extracted >= 0`.
3. **T1 deliberately-broken side-branch green.** Audit detects dropped column + suspended cron, applies M-009 + TD-003 idempotently.
4. **T2 mnestra doctor accurate on petvetbid.** Schema-drift probe shows nothing. Cron-all-zeros probe shows recovery (rumen_jobs running again with non-zero output as fresh memory_sessions rows arrive). MCP path parity probe identifies `~/.claude.json` as canonical.
5. **T2 mnestra doctor red on broken project.** Two specific reds with M-009 + TD-003 recommendations.
6. **T2 cold-boot tolerance.** Fresh project (≤5 cron runs) does NOT fire red on cron-all-zeros (≥6-cycle threshold).
7. **T2 metadata parity verified.** New memory_sessions rows have non-NULL started_at/duration_minutes; facts_extracted is sane.
8. **T3 GRAPH_LLM_CLASSIFY end-to-end on fresh project.** Y-path lands both secrets; manual graph-inference fire returns `llm_classifications > 0`.
9. **T3 Vault auto-apply path green.** Both vault keys created via pg-direct on fresh project. PAT-withhold test triggers deeplink fallback; deeplink works.
10. **T3 fresh-install hook landed.** `init --mnestra` on a clean HOME (no prior hook) writes the bundled v2 hook (status=`installed`, not `refreshed`).
11. **T3 Vault wizard text clean.** `git grep` returns zero hits in active wizard surface.
12. **T3 Brad outreach prep.** WhatsApp-ready message drafted; ready for orchestrator wa.me inject.
13. **T4-CODEX independent reproduction green.** Brad-shape fixture replicates T1/T2/T3's findings. No new failure modes surface. Codex posts `DONE — VERIFIED`.
14. **T4-CODEX flags any gap pre-WhatsApp.** If T3's draft over-promises (e.g., claims metadata works when fixture shows it doesn't), Codex blocks send via `DONE — REOPEN T3`. The orchestrator does not send Brad anything until T4-CODEX signs off.

## Pre-sprint substrate (orchestrator probes before inject)

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Confirm v1.0.3 is live + installed locally
npm view @jhizzard/termdeck version           # expect 1.0.3
npm view @jhizzard/termdeck-stack version     # expect 0.6.3
npm view @jhizzard/mnestra version            # expect 0.4.2 (unchanged from 51.6)
npm view @jhizzard/rumen version              # expect 0.4.5 (unchanged from 51.5)
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"

# Confirm bundled hook is v2 in published tarball
grep -n "@termdeck/stack-installer-hook" /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js
# expect: line ~54 = "v2"

# Confirm post-Sprint-51.7 baseline state
psql "$DATABASE_URL" -c "select count(*), max(ended_at), bool_or(started_at is not null) any_started, bool_or(duration_minutes is not null) any_duration from memory_sessions"
# expect: count >= 290 + the v1 hook's row from 2026-05-04 01:19 ET (started_at NULL/duration_minutes NULL)

# Confirm Joshua's installed hook NOT yet refreshed to v2 (T1 will do that)
grep -n "@termdeck/stack-installer-hook" ~/.claude/hooks/memory-session-end.js
# expect: line ~54 = "v1" (Sprint 51.6 manual refresh landed v1; this dogfood verifies wizard auto-refreshes to v2)

# Confirm rumen_jobs cron history baseline
psql "$DATABASE_URL" -c "select status, end_time - start_time as duration, end_time from cron.job_run_details where jobid in (select jobid from cron.job where jobname='rumen-tick') order by end_time desc limit 12"

# Confirm 233-insights flatline Joshua flagged
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
```

## Risks

- **T3 needs a fresh Supabase test project.** ~2 min to provision, consumes one of Joshua's free-tier slots. Name `termdeck-dogfood-2026-05-04`, plan to delete after the audit. Alternative: T3 runs against a side branch on petvetbid — but that pollutes Joshua's daily-driver. Recommendation: throwaway project.
- **T1 deliberately-broken side branch.** Mutating petvetbid's schema even temporarily is risky if Joshua forgets to revert. Mitigation: T1 does the broken-project test on the same throwaway T3 provisions, not on petvetbid.
- **T1 hook-refresh test depends on Joshua's pre-state.** Joshua's installed hook was MANUALLY refreshed to v1 last night (Sprint 51.6 21:19 ET). v1.0.3's wire-up should refresh v1 → v2 because T2 bumped the bundled stamp. If the manual refresh somehow got reverted, the test still works but the path is `installed` not `refreshed`.
- **T4-CODEX needs the published v1.0.3 binary.** Sprint must wait until after orchestrator publishes v1.0.3 + git push. T4 inject can pre-stage but actual probes block on publish.
- **The 233-insights flatline (Joshua noted in 51.7) may not recover within sprint window.** Rumen's tick is 15 min; even if memory_sessions starts writing again, 1-2 ticks may not show meaningful insight count growth. T2 should report "delta visible" / "delta NOT visible — needs longer observation window," not pass/fail.

## Companion artifacts

- If T4 surfaces a fresh failure class, append ledger entry #16 + (if a new class) row N to the failure taxonomy in `docs/INSTALLER-PITFALLS.md`.
- If all four lanes are green, the green-light Brad WhatsApp goes out same-day. Pre-drafted text at `/tmp/brad-whatsapp-v1-0-3-greenlight.txt` (orchestrator stages this in parallel).
- Optional: a one-line CHANGELOG `[Unreleased]` note documenting the dogfood pass — useful for v1.0.4 (when one ships) to reference what 51.5b validated.

## Boot for the orchestrator

The orchestrator continues from the existing TermDeck server on `127.0.0.1:3000`. Joshua opens 4 NEW Claude Code panels (T1/T2/T3 = Claude; T4 = Codex CLI in a separate panel). Inject script template at `/tmp/inject-sprint-51.5b-prompts.js` (orchestrator generates after panels open) using the canonical two-stage submit pattern (paste-then-`\r`, never combined).

## Boot for the four lanes

Each lane brief (T1-*.md / T2-*.md / T3-*.md / T4-*.md) contains a customized boot block. T4 brief explicitly accommodates Codex's runtime — **as of 2026-05-04 ~11:00 ET Codex DOES have Mnestra MCP wired** (this morning's `codex mcp add mnestra` from this orchestrator session). Codex T4 in this sprint CAN call `memory_recall`. STATUS.md remains the durable substrate, but boot can use MCP recall too.

## Lane discipline

This sprint is **audit-only**. No code changes, no version bumps, no CHANGELOG edits, no commits. Each lane runs probes, documents findings in STATUS.md FINDING posts, and posts a one-line PASS/FAIL verdict in DONE. Orchestrator decides at sprint close whether any FAIL surfaces a Sprint 51.8 hotfix.
