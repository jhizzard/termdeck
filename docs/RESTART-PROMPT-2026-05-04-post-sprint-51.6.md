# Restart prompt — post-Sprint-51.6 (paste into a fresh Claude Code session 2026-05-04)

You are opening a fresh TermDeck orchestrator session after Sprint 51.6 mini-sprint shipped 2026-05-03 ~20:50 ET. Sprint 51.5 (v1.0.1) shipped earlier the same day. Sprint 51.6 (v1.0.2) was a mini-hotfix that fixed two architectural bugs (memory_sessions write path + Class M omission + 5-part fix wave). **First sprint to use the canonical 3+1+1 (Orchestrator + Workers + Codex Auditor) pattern.** Phase B verification was pending at end of session 2026-05-03 — first task this session is to confirm Phase B closed cleanly OR pick up wherever it stalled.

## Boot sequence (do these in order, no skipping)

1. Run `date '+%Y-%m-%d %H:%M ET'` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 51.6 v1.0.2 shipped Class M memory_sessions hook bundled fix postMemorySession refreshBundledHookIfNewer audit-upgrade 10 probes")`
3. `memory_recall(query="3+1+1 pattern Orchestrator Workers Codex Auditor compaction vulnerability Codex MCP not wired")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules (notably § Sprint role architecture which canonizes the 3+1+1 pattern as of 2026-05-03 20:17 ET).
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router.
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md` — canonical 14-entry incident ledger + Classes A–J failure taxonomy + 11-item pre-ship checklist (Class M from Sprint 51.6 will be appended at Sprint 51.6 final close-out — possibly already done; check the ledger).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.6-memory-sessions-hook-fix/STATUS.md` — every lane post + auditor catch + Phase B outcome. **This is the durable record of everything that happened.**
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/BACKLOG.md` § P0 + § D.5 — Sprint 52+ candidates (memory-budget tracking; active health dashboard; per-panel cwd switch; Mnestra topology routing layer; **NEW: 3+1+1 pattern compaction-vulnerability hardening + Codex MCP-not-wired gap**).

## First action this session

Verify Phase B outcome. Probe:

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2-)

# Did memory_sessions row count grow past 289 (the 2026-05-01 stalled baseline)?
psql "$DATABASE_URL" -c "select count(*), max(ended_at) from memory_sessions"
# If > 289 with a recent max(ended_at) → Phase B closed CLEAN; v1.0.2 wave is complete.
# If still 289 → Phase B never fired or fired but didn't write; investigate.

# Verify v1.0.2 actually installed
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# Expect: 1.0.2

# Verify hook refresh landed
diff ~/.claude/hooks/memory-session-end.js \
  /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js
# Expect: byte-identical (or near-identical post-refresh)

# Check STATUS.md for Codex's final post
grep -nE '\[T4-CODEX\] DONE' /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.6-memory-sessions-hook-fix/STATUS.md
# Expect: either DONE — VERIFIED (sprint clean) or DONE — REOPEN T3 (v1.0.3 needed)
```

## Decision tree

- **If Phase B closed CLEAN** (memory_sessions grew + Codex posted DONE — VERIFIED): close out the sprint. Append Class M ledger entry #15 to `docs/INSTALLER-PITFALLS.md` (pre-ship checklist may grow item #12). Update `docs/sprint-51.5b-dogfood-audit/PLANNING.md` from "deferred until 51.6 ships" to "ready for inject" — that's the next sprint, broad v1.0.2 dogfood pass before any feature work. Send Brad a WhatsApp via the standing wa.me deep-link inject pattern confirming v1.0.2 closed Class M + Bug C + Bug D.

- **If Phase B is mid-flight** (Codex's panel was active when the prior session closed; no DONE post yet): re-engage Codex. Check the panel state via `/api/sessions/fe831565-95d0-42c9-8392-ad05b5c55bf6/buffer` — if active, watch and let it finish. If stale, fire a `cr-flood` poke via `/api/sessions/.../poke` to nudge.

- **If Phase B failed** (Codex posted DONE — REOPEN T3 or memory_sessions didn't grow): triage. Most likely cause if it failed: hook-refresh didn't fire OR the bundled-hook signature comparison didn't trigger overwrite. Investigation steps in T3-fix-and-ship-v1-0-2.md if needed. Spin Sprint 51.7 with adjusted scope. Most-likely-not-a-failure outcome though — Codex pre-publish VERIFY at 20:42 ET caught everything important.

- **If Phase B never fired** (Joshua didn't run the install): kick it off. Joshua runs `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` then triggers a fresh `/exit` on any Claude Code session. Codex's panel (`fe831565-95d0-42c9-8392-ad05b5c55bf6`) is in standby with B1-B8 probe sequence loaded. After the install, ping the panel with `cr-flood` to wake it; it'll run the verification.

## After Phase B closes

The four sprint queue ahead, in priority order:

1. **Sprint 51.6 final close-out** (if not done) — INSTALLER-PITFALLS.md ledger #15 (Class M) + checklist item #12 if needed; CHANGELOG entry already lives in `1.0.2` block; Brad WhatsApp ping; deferred-from-51.5b dogfood plan unblocks.
2. **Sprint 51.5b dogfood audit** — broad v1.0.2 dogfood pass before any feature work. Plan + 4 lane briefs at `docs/sprint-51.5b-dogfood-audit/`. Use the 3+1+1 pattern (3 Claude workers + 1 Codex auditor) for the audit.
3. **Sprint 52** — original Sprint 51 cost-monitoring expandable dashboard panel. PLANNING.md unchanged; just renumber when Sprint 51.5b closes. Use 3+1+1.
4. **Sprint 24 (Maestro)** — chopin-scheduler SaaS readiness + WhatsApp Dispatch contract. Independent of TermDeck sprints. Plan + 4 lane briefs at `/Users/joshuaizzard/.gemini/antigravity/scratch/chopin_scheduler/docs/sprint-24-saas-readiness-and-dispatch-contract/`. Already designates T4 as Codex auditor per the canonical 3+1+1 pattern.

## Critical context to carry forward

- **3+1+1 pattern is the canonical default** going forward across ALL projects. Documented in `~/.claude/CLAUDE.md` § Sprint role architecture (added 2026-05-03 20:17 ET). Sprint 51.6 was the first sprint to use it; Codex caught 4 real bugs in T3's WIP that all-Claude lanes would have shipped.
- **Codex CLI in this setup does NOT have Mnestra MCP wired** (per Codex's own REBOOTSTRAPPED post 20:54 ET — `memory_recall` not exposed). Auditor lane briefs must mandate verbose STATUS.md posts as the durable substrate; phase-boundary checkpoint posts; explicit recovery-instruction at the top of each major audit phase. Sprint 52+ TODO: wire Mnestra MCP into `~/.codex/config.toml`.
- **Codex compacted mid-Sprint-51.6 at 20:53 ET** and recovered via orchestrator-side rebootstrap inject in ~30 sec. Recovery pattern: point the auditor at its own prior STATUS.md posts + lane brief. Document this in `~/.claude/CLAUDE.md` § Sprint role architecture as the canonical compact-mid-sprint recovery procedure.
- **Memory-budget tracking table + active health dashboard** are Sprint 52+ candidates that would have surfaced Sprint 51.6's two bugs proactively rather than via 2-day-stale live psql probes. See `docs/BACKLOG.md` § D.5.
- **The 22 pre-existing `tests/project-taxonomy.test.js` failures** should flip green post-Phase-B (Joshua's `termdeck init --mnestra` lands the new bundled hook with Sprint-41 PROJECT_MAP). If they don't flip, that's the canonical "Phase B failed" signal — investigate.

## Email reference

Most recent session-end email draft is in admin@nashvillechopin.org Gmail drafts (subject starting "TermDeck Wrap"). Latest before this restart prompt: `r-6012952721980957122` written 2026-05-03 19:18 ET (pre-Phase-B; talks about v1.0.2 mini-sprint in flight). After Phase B closes, draft a fresh wrap email reflecting the actual outcome.

## Final wall-clock

Sprint 51.5: plan 2026-05-02 21:14 ET → ship 2026-05-03 18:20 ET = ~21 hours.
Sprint 51.6 mini: plan 2026-05-03 19:18 ET → ship 20:50 ET = 1.5 hours (53 min inject-to-FIX-LANDED + ~30 min orchestrator close).
Combined: 2 hotfix waves in ~24 hours, 25+ memories landed, 4 auditor catches, 2 new structural-gap items banked.
