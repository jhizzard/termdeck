# Restart prompt — post-Sprint-51.7 (paste into a fresh Claude Code session 2026-05-04 or later)

You are opening a fresh TermDeck orchestrator session after Sprint 51.7 mini-sprint shipped 2026-05-04 ~12:00 ET (target). Sprint 51.5 (v1.0.1) shipped 2026-05-03 ~18:20 ET; Sprint 51.6 (v1.0.2) shipped same day ~20:50 ET; Sprint 51.7 (v1.0.3) is the wizard wire-up + transcript-metadata follow-up. **Second sprint to use canonical 3+1+1 (Orchestrator + 3 Claude Workers + 1 Codex Auditor) pattern; first sprint with Codex MCP wired (so Codex has memory_recall directly).**

## Boot sequence (do these in order, no skipping)

1. Run `date '+%Y-%m-%d %H:%M ET'` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 51.7 v1.0.3 wizard wire-up runHookRefresh transcript metadata Class A migration drift")`
3. `memory_recall(query="3+1+1 pattern auditor compaction-checkpoint discipline lane post-shape uniformity idle-poll regex hardening")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules. **Note new § "MANDATORY: Three hardening rules learned from Sprints 51.6 + 51.7"** (added 2026-05-04 ~11:35 ET) — checkpoint discipline for auditor + lane post-shape uniformity + tolerant idle-poll regex.
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router.
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md` ledger entries #15 (Class M, Sprint 51.6) + #16 if added by Sprint 51.7 close-out (Class A migration-replay drift in `match_memories`).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md` — every lane post + auditor catches + final disposition. Six T4-CODEX catches landed (root cause finding, dry-run audit, T2 parser pre-check, T2 WIP blocker, T3 CHANGELOG missing, T3 CHANGELOG accuracy). All resolved before publish.
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/PLANNING.md` — the next sprint, refreshed 2026-05-04 ~11:30 ET to v1.0.3 baseline + 3+1+1 pattern. Lane briefs: T1/T2/T3/T4 (T4 = Codex auditor with MCP now wired).

## First action this session

Verify Sprint 51.7 publish outcome. Probe:

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Verify v1.0.3 published
npm view @jhizzard/termdeck version              # expect 1.0.3
npm view @jhizzard/termdeck-stack version        # expect 0.6.3
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# expect: 1.0.3

# Verify bundled hook v2 in published tarball
grep -n "@termdeck/stack-installer-hook" /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js
# expect: line ~64 = "v2"

# Verify Joshua's installed hook landed v2 via wizard auto-refresh
grep -n "@termdeck/stack-installer-hook" ~/.claude/hooks/memory-session-end.js
# expect: line ~64 = "v2" if Joshua re-ran init --mnestra post-publish

# Verify memory_sessions writes with metadata
psql "$DATABASE_URL" -c "select count(*) total, max(ended_at) last, count(*) filter (where started_at is not null) any_started, count(*) filter (where facts_extracted > 0) any_facts from memory_sessions where ended_at >= '2026-05-04 12:00 ET'"

# Verify Brad got the green-light WhatsApp
ls /tmp/brad-whatsapp-v1-0-3-greenlight.txt 2>/dev/null
# expect: file exists; orchestrator sent via wa.me deep-link inject post-Codex-VERIFIED
```

## Decision tree

- **If v1.0.3 is published cleanly + Joshua's hook is v2 + memory_sessions has metadata-rich rows + Brad got WhatsApp:** Sprint 51.7 is closed. Proceed to Sprint 51.5b inject (next section).

- **If v1.0.3 is published but Joshua hasn't re-run `init --mnestra` yet:** prompt Joshua to run it. The wizard auto-refresh is the canonical Sprint 51.7 deliverable; verify it lands.

- **If a Codex catch surfaced post-publish (T4-CODEX] DONE — REOPEN T<n> in STATUS.md):** triage. Most likely cause: CHANGELOG accuracy issue or post-publish Phase B regression. Spin Sprint 51.7.1 with adjusted scope.

- **If publish never happened:** check whether T3 CHANGELOG corrections landed (T4-CODEX 11:38 ET catch). Push T3 to fix; orchestrator publishes Passkey.

## After Sprint 51.7 close + Sprint 51.5b inject

The four sprint queue ahead, in priority order:

1. **Sprint 51.5b dogfood audit** — REFRESHED 2026-05-04 ~11:30 ET to v1.0.3 baseline + 3+1+1. Plan + 4 lane briefs at `docs/sprint-51.5b-dogfood-audit/`. T4 = Codex (now MCP-wired). Inject script: generate at `/tmp/inject-sprint-51.5b-prompts.js` after panels open. Audit-only, no code, no version bumps. Acceptance closes when T1+T2+T3 DONE green AND T4-CODEX `DONE — VERIFIED`.

2. **Sprint 52** — original Sprint 51 cost-monitoring expandable dashboard panel. PLANNING.md unchanged in `docs/sprint-51-cost-panel-and-polish/`; just renumber when 51.5b closes. Use 3+1+1.

3. **Sprint 52.1 (proposed) — match_memories return-type drift idempotency.** Codex T4-CODEX 11:38 ET flagged Class A migration-replay drift in `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-96`. Sprint 51.7 fixed Class M (DB failure no longer strands hook upgrade) but the underlying migration drift remains for any user re-running `init --mnestra` on existing v0.6.x-era installs. Mini-sprint: wrap in `DROP FUNCTION IF EXISTS match_memories(vector, ...) CASCADE;` OR add `do$$ ... end$$` signature-drift guard. Likely a single-lane fix. Could fold into Sprint 52 or ship as v1.0.4 hotfix.

4. **Sprint 24 (Maestro)** — chopin-scheduler SaaS readiness + WhatsApp Dispatch contract. Independent of TermDeck sprints. Plan + 4 lane briefs at `/Users/joshuaizzard/.gemini/antigravity/scratch/chopin_scheduler/docs/sprint-24-saas-readiness-and-dispatch-contract/`. Already designates T4 as Codex auditor per the canonical 3+1+1 pattern.

## Critical context to carry forward

- **3+1+1 pattern is the canonical default** going forward across ALL projects. Documented in `~/.claude/CLAUDE.md` § Sprint role architecture (added 2026-05-03 20:17 ET). Sprint 51.6 was the first sprint to use it; Sprint 51.7 the second. Three hardening rules added 2026-05-04 ~11:35 ET after lessons from both sprints.
- **Codex CLI now has Mnestra MCP wired** (added 2026-05-04 ~11:00 ET via `codex mcp add mnestra ... -- mnestra`). Same for Gemini (`gemini mcp add -t stdio -s user ...`) and Grok (direct edit of `~/.grok/user-settings.json` `mcp.servers[]` array). Cross-project memory `reference_mcp_wiring.md` documents the schemas. Sprint 51.6's "Codex MCP not wired" gap is closed; Sprint 51.5b T4 brief explicitly accommodates Codex's new memory_recall capability.
- **Sprint 51.7 surfaced TWO architectural issues** worth tracking:
  - Class M wire-up bug (root cause: DB-phase failure stranded hook refresh) — FIXED in v1.0.3 by moving `runHookRefresh()` upstream of DB work
  - Class A migration-replay drift in `match_memories` — STILL OPEN, deferred to Sprint 52.1 candidate
- **The 233-insights flatline Joshua flagged** (2026-05-04 ~10:50 ET) is a downstream symptom of the `memory_sessions` ingestion gap. Once v1.0.3 + post-publish init --mnestra lands the v2 hook, Rumen should start catching up next tick (~15 min cycles). Sprint 51.5b T2 has a Rumen recovery delta probe.
- **Codex compacted twice** during Sprint 51.6 + 51.7. Both times recovery was clean via STATUS.md substrate. Hardening rule 1 (CHECKPOINT discipline) baked into Sprint 51.5b T4 brief — pre-empt rather than recover.
- **Lane post-shape mismatch** (Sprint 51.7 T3 missed T1's `[T1] DONE` post for many minutes because regex required `### ` prefix) — hardening rule 2 + 3 baked into Sprint 51.5b lane briefs (uniform `### [T<n>]` shape + tolerant `^(### )?\[T<n>\] DONE\b` regex).

## Email reference

Most recent session-end email draft is in admin@nashvillechopin.org Gmail drafts. Subject prefix: "TermDeck Wrap — ...". Latest before this restart: TBD (orchestrator drafts at session end with rich-text HTML body per `~/.claude/CLAUDE.md` § Session-End Email mandate).

## Final wall-clock

- Sprint 51.5: plan 2026-05-02 21:14 ET → ship 2026-05-03 18:20 ET = ~21 hours.
- Sprint 51.6 mini: plan 2026-05-03 19:18 ET → ship 20:50 ET = 1.5 hours.
- Sprint 51.7 mini: plan 2026-05-04 ~10:30 ET → ship ~12:00 ET = ~1.5 hours target.
- Combined v1.0.x wave: 3 hotfix waves in ~38 hours. 6 T4-CODEX catches across 51.7 alone. 3 hardening rules canonized. MCP wired into all three non-Claude CLIs.
