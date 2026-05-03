# Restart prompt — Sprint 51.5 orchestrator (paste into a fresh Claude Code session)

You are the orchestrator for **TermDeck Sprint 51.5 — v1.0.1 hotfix: installer upgrade-aware migration detection + mnestra doctor**. This sprint was authored 2026-05-02 21:14 ET in response to Brad's same-day schema-vs-package-drift report on `jizzard-brain` (Supabase ref `rrzkceirgciiqgeefvbe`). Sprint 51 (cost-monitoring panel) is deferred to Sprint 52; you ship 51.5 first.

## Boot sequence (do these in order, no skipping)

1. Run `date '+%Y-%m-%d %H:%M ET'` to time-stamp.
2. `memory_recall(project="termdeck", query="installer pitfalls upgrade migration drift Brad jizzard-brain GRAPH_LLM_CLASSIFY mnestra doctor sprint 51.5")`
3. `memory_recall(query="installer failure-class taxonomy schema drift silent no-op")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules (time check, session-end email, memory-first, 4+1 inject mandate two-stage submit, never-copy-paste-messages).
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router (no TS, vanilla JS, CommonJS, RELEASE.md before publishing, **NEW: INSTALLER-PITFALLS.md mandatory before touching installer/wizard/migration runner**).
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md` — **canonical reference for this entire sprint**. 9-class failure taxonomy + 10-item pre-ship checklist + 13-entry incident ledger. Brad's bug is entry #13 (Class A schema drift + Class I silent no-op).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/PLANNING.md` — Sprint 51.5 plan (4 lanes T1-T4, all sketched, lane briefs not yet authored).
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5-installer-upgrade-and-doctor/STATUS.md` — substrate-finding seeds (SUPABASE_PAT_HERE on Josh's machine, GRAPH_LLM_CLASSIFY status unknown).
9. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — strict publish protocol (Passkey, NEVER `--otp`, publish before push, stack-installer audit-trail bump).
10. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/BACKLOG.md` § P0 — confirms the migration-drift entry is open.

## Then begin

### (a) Pre-sprint substrate probe

Execute the 10 standard checks from Sprint 50 plus the new probes seeded in `STATUS.md`:

```bash
date '+%Y-%m-%d %H:%M ET'
npm view @jhizzard/termdeck version             # expect 1.0.0 (target: bump to 1.0.1)
npm view @jhizzard/termdeck-stack version       # expect 0.6.0 (target: 0.6.1)
npm view @jhizzard/mnestra version              # expect 0.4.0 (target: 0.4.1)
npm view @jhizzard/rumen version                # expect 0.4.4 (target: 0.4.5)
curl -s http://127.0.0.1:3000/api/health        # TermDeck server alive?
gh issue list --repo jhizzard/termdeck --limit 10  # any v1.0.0 user-filed bugs since 2026-05-02?

# Sprint 51.5-specific substrate (resolve these BEFORE injecting lanes):

# (i) Confirm SUPABASE_ACCESS_TOKEN placeholder is still open on Josh's machine:
grep -c '"SUPABASE_PAT_HERE"' ~/.claude.json
# Non-zero → incident #8 still open on Josh's machine. T3 lane scope confirmed.

# (ii) Probe GRAPH_LLM_CLASSIFY status on petvetbid (luvvbrpaopnblvxdxwzb).
# Supabase MCP probably still broken (placeholder), so use the CLI:
supabase secrets list --project-ref luvvbrpaopnblvxdxwzb 2>&1 | grep -E 'GRAPH_LLM_CLASSIFY|ANTHROPIC_API_KEY' || echo "BLOCKED (sandbox or auth) — defer to T3"
# If BLOCKED, T3 lane authors a substrate-stage that requests user permission to set the secret directly.

# (iii) Confirm Brad's manual fix is still alive on jizzard-brain (informational; the soak-check agent fires 2026-05-09):
# Just check whether the migration-drift entry in BACKLOG.md has been struck through (not by you, by an interim session):
grep -c '~~.*Stack-installer has no upgrade-detection path~~' docs/BACKLOG.md
```

If `gh issue list` surfaces a P0 issue more urgent than Sprint 51.5's scope, re-evaluate — but the bar is high (Brad's drift bug is the current top-priority correctness issue).

### (b) Author the four lane briefs

Sprint 51.5's lane briefs do NOT yet exist. Author `docs/sprint-51.5-installer-upgrade-and-doctor/T{1,2,3,4}-*.md` based on the PLANNING.md sketch:

- **T1** — `T1-stack-installer-audit-upgrade.md` (~150 LOC NEW + ~10 LOC integration in 2 init scripts + ~10 tests). PRIMARY lane, biggest scope. Author first.
- **T2** — `T2-mnestra-doctor.md` (~120 LOC in mnestra repo at `~/Documents/Graciella/engram/src/cli/doctor.ts` + 6 tests). NEW subcommand.
- **T3** — `T3-graph-llm-classify-prompt.md` (~30 LOC in init-rumen.js + ~10 LOC install-output template + 3 tests). Smallest lane.
- **T4** — `T4-doc-propagation-verify.md` (no NEW code; verifies INSTALLER-PITFALLS.md is reachable from all 4 agents and Mnestra recall surfaces it). Smallest lane.

Each lane brief MUST cite the failure class(es) it addresses (per INSTALLER-PITFALLS.md § Failure-class taxonomy) AND confirm which pre-ship-checklist item(s) it satisfies. This is the new convention — every installer-adjacent lane brief from now on.

### (c) Sprint 51.5 PLANNING.md frontmatter (already in PLANNING.md, but worth re-checking)

```yaml
---
sprint: 51.5
lanes:
  - tag: T1
    agent: claude
    project: termdeck
  - tag: T2
    agent: claude
    project: mnestra      # cross-repo lane — operates in ~/Documents/Graciella/engram
  - tag: T3
    agent: claude
    project: termdeck
  - tag: T4
    agent: claude
    project: termdeck
---
```

All-Claude per Sprint 50 close pattern.

### (d) Inject + monitor

Same two-stage submit pattern as Sprint 50/51. `/tmp/inject-sprint51.5-prompts.js`. Verify all 4 show `status: 'thinking'` within 8s; if any stays `active`, fire `/api/sessions/:id/poke` with `methods: ['cr-flood']`.

### (e) Sprint close (v1.0.1 wave)

Per RELEASE.md strict protocol:

1. `npm run sync-rumen-functions` (must run before `npm pack`)
2. `npm pack --dry-run` for each package — verify all NEW migration files / NEW Edge Function source / NEW doctor.ts ship in the tarballs
3. Publish in this order (Passkey, NOT --otp):
   - `@jhizzard/mnestra@0.4.1` (T2's doctor subcommand lives here)
   - `@jhizzard/rumen@0.4.5` (audit-trail bump only unless T1's audit-upgrade also patches rumen migrations)
   - `@jhizzard/termdeck@1.0.1` (T1 + T3 land here)
   - `@jhizzard/termdeck-stack@0.6.1` (audit-trail bump — versions in the meta-installer JSON)
4. Then `git push` (NEVER push before publish per the Sprint 35 close-out incident).
5. CHANGELOG entry shape: small, hotfix-flavored — name Brad's report, list the 4 lanes, link INSTALLER-PITFALLS.md ledger entry #13 + Sprint 51.5 PLANNING.md.
6. Post-publish verification: re-run `termdeck init --mnestra && termdeck init --rumen` against a deliberately-broken test project (drop migrations 009-015 + the graph-inference function on a side branch). Expected: audit-upgrade detects all gaps, applies them in order, exits clean. Idempotent on second run.

If T3 successfully wires GRAPH_LLM_CLASSIFY end-to-end on Josh's petvetbid project, manually fire graph-inference once and confirm `llm_classifications > 0` in the response.

## Pre-sprint context (carry-forward)

- v1.0.0 release wave shipped 2026-05-02 15:48 ET. Sprint 51.5 is the FIRST hotfix off v1.0.0 — bar shifts back to "trigger criteria" because outside-user-blocking is involved. Brad's report at 2026-05-02 ~21:00 ET surfaced the schema-drift class that motivated this whole sprint AND opened the canonical INSTALLER-PITFALLS.md doc.
- The 1-week soak-check agent for Brad's manual fix fires 2026-05-09 09:30 ET (`trig_015tnq25GSHj9TFJp6Jfbubu`). If Sprint 51.5 ships before then, the soak-check will see the audit-upgrade path landed and Brad's drift is structurally prevented. Good outcome.
- Class D failure (incident #8) confirmed open on Josh's own machine 2026-05-02 21:18 ET — `~/.claude.json` has literal `"SUPABASE_PAT_HERE"`. T3 of this sprint owns the fix.

## Carry-forward TODO list

- [ ] T1/T2/T3/T4 lane briefs (orchestrator authors at kickoff per § (b))
- [ ] Decide whether to fold Sprint 51 carry-overs (mnestra doctor was already on the Sprint 51 list as a side-task) — answer: T2 of THIS sprint absorbs it. Strike from Sprint 51.
- [ ] After ship: WhatsApp Brad confirming v1.0.1 landed and his drift bug is structurally prevented going forward (`open "https://wa.me/15127508576?text=..."` per global CLAUDE.md mandate).
- [ ] After ship: re-arm or clear the soak-check routine if Sprint 51.5 ships ahead of 2026-05-09.
- [ ] `docs/INSTALL-FOR-COLLABORATORS.md` refresh — Sprint 48 → 49 → 50 → 51 → 51.5 carry-over. Probably ships in Sprint 52 (cost-panel sprint) since 51.5 is hotfix-shaped.
- [ ] Sprint 52 = the original Sprint 51 cost-panel + UX polish quartet. PLANNING.md unchanged; just renumber when 51.5 closes.
