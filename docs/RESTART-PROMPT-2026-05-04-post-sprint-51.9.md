# Restart prompt — post-Sprint-51.9 / pre-Sprint-52 (paste into a fresh Claude Code session 2026-05-04 evening or 2026-05-05)

You are opening a fresh TermDeck orchestrator session at the END of a 7-sprint v1.0.x cascade day. Sprint 52 is the LAST TermDeck sprint of 2026-05-04 — single-lane direct, ~1-2 hour scope, ships v1.0.7. After Sprint 52 closes, TermDeck transitions to weekly-bump cadence + memory-quality innovation focus.

## Boot sequence (do these in order, no skipping)

1. Run `date '+%Y-%m-%d %H:%M ET'` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 52 Edge Function pin drift rumen-tick deployed npm publish v1.0.7")`
3. `memory_recall(project="termdeck", query="Sprint 51.9 v1.0.6 memory_hybrid_search mig 016 cron-conditional guard")`
4. `memory_recall(query="3+1+1 hardening rules checkpoint discipline post shape uniform idle-poll regex")`
5. `memory_recall(query="Codex auto-accept approval mode 3+1+1 auditor delays")` — relevant if you re-engage with the Sprint 51.5b panels.
6. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules.
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router.
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md` ledger entries #15 (Class M, 51.6), #16 (Class N, 51.8), #17 (Class A, 52.1), #18 (Class A cousin, 51.9), #19 (Class A schema-availability, 51.9 fold-in). Pattern recognition for the new Class O ledger #20 you'll be authoring this sprint.
9. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — STRICT publish protocol.
10. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-52-edge-function-pin-drift/PLANNING.md` — full sprint scope + acceptance criteria + risks.
11. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-52-edge-function-pin-drift/T1-pin-drift-and-redeploy.md` — your full lane brief, end-to-end (Steps 1-9).
12. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-52-edge-function-pin-drift/STATUS.md` — substrate state at sprint open.
13. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-51.5b-dogfood-audit/STATUS.md` last 50 lines — check for T3 v2 draft post + T4-CODEX re-audit since 15:31 ET.

## What landed today (so you don't re-research)

Six sprints shipped 2026-05-04, closing the v1.0.x onion across 5 distinct failure classes:

| Wave | Sprint | Closes | Class | Commit |
|---|---|---|---|---|
| v1.0.4 | 51.8 | settings.json Stop→SessionEnd lockstep drift (Brad's catch) | N | `4d0ee98` |
| v1.0.5 | 52.1 | match_memories signature drift on long-lived installs (Codex deferred catch from 51.7) | A | `6b68177` |
| v1.0.6 | 51.9 | memory_hybrid_search 10-arg drift overload (Codex T4-CODEX live catch in 51.5b) | A (#18) | `12079cc` |
| v1.0.6 fold-in | 51.9 | mig 016 cron.* schema dependency on fresh-install (T3 RED in 51.5b) | A (#19) | `d291ecf` |

`origin/main` HEAD = `d291ecf`. `npm view @jhizzard/termdeck version` returns `1.0.6`. `npm view @jhizzard/termdeck-stack version` returns `0.6.6`. Both published 2026-05-04 ~15:35-15:40 ET.

**Sprint 51.5b dogfood audit final disposition (3+1+1 with Codex T4 auditor):**
- T1: PASS (all 5 phases green on petvetbid)
- T2: PASS-with-3-findings (doctor blindness on cron return_message; Rumen Edge Function pin drift; doctor env-var DX nit)
- T3: RED on fresh-install (mig 016 — folded into v1.0.6); REOPENed by T4 at 15:22 ET on Brad WhatsApp draft
- T4-CODEX: 3 phases verified; T3 redraft pending re-audit

T3 was nudged via orchestrator inject at 15:31:32 ET. By the time you boot, the redraft + re-audit may be complete; check Sprint 51.5b STATUS.md.

## First action this session

Verify Sprint 52 setup state:

```bash
date '+%Y-%m-%d %H:%M ET'
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')

# Confirm v1.0.6 live + locally installed
npm view @jhizzard/termdeck version          # expect 1.0.6
npm view @jhizzard/termdeck-stack version    # expect 0.6.6
node -p "require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version"
# expect: 1.0.6

# Confirm pin drift is still real (Codex's 15:22 ET reading)
SUPABASE_ACCESS_TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"') \
  supabase functions download rumen-tick --project-ref luvvbrpaopnblvxdxwzb --use-api -o /tmp/sprint-52-deployed-rumen-tick
grep -E "npm:@jhizzard/rumen@" /tmp/sprint-52-deployed-rumen-tick/index.ts
# expect: 0.4.0 (will move to 0.4.5 only after Joshua runs init --rumen post-v1.0.7)

# Confirm rumen_insights flatline
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
# expect at boot: 321 / 2026-05-01 20:45 UTC
```

## Decision tree

- **If Sprint 52 hasn't been started:** proceed to T1 lane brief Step 1 (audit current `init --rumen` redeploy behavior). Single-lane direct — orchestrator codes, commits, hands publish to Joshua, pushes after.

- **If T3's Brad WhatsApp v2 draft + T4-CODEX re-audit are GREEN in Sprint 51.5b STATUS.md:** Step 8 of T1 brief (Brad WhatsApp send via wa.me deep-link inject) is unblocked. Can run in parallel with Sprint 52 code work, or ship Sprint 52 first then send. Joshua's preference: ship Sprint 52 first so the Brad message can mention v1.0.7's Edge Function pin drift detection too.

- **If T3 redraft hasn't landed yet** (no `### [T3] DRAFT — Brad WhatsApp v2` post in Sprint 51.5b STATUS.md): T3 panel might be stuck. Check via `curl -s http://127.0.0.1:3000/api/sessions/4d497a77-6bcb-4333-9f42-70abf753b905/buffer | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), d.get("statusDetail"), d.get("lastActivity"))'`. If genuinely stalled (no activity in >5 min), re-inject `/tmp/t3-reopen-nudge.txt` via the two-stage paste+\r pattern (see CLAUDE.md § "MANDATORY: 3+1+1 sprint orchestration"). If TermDeck server isn't running, Brad outreach is a separate-session task.

- **If TermDeck server isn't on `127.0.0.1:3000`:** that's expected if Joshua restarted his Mac since 15:40 ET. The 4 sprint-51.5b panels are gone with the server bounce. Brad WhatsApp send becomes a separate task that doesn't depend on the panels — pull the v1 + v2 drafts directly from `docs/sprint-51.5b-dogfood-audit/STATUS.md` and the `/tmp/sprint-51.5b-t3-brad-draft-v1.txt` file if it still exists.

## Key context to carry forward

### v1.0.x onion is structurally CLOSED
- All 5 onion classes (51.5/51.6/51.7/51.8/52.1/51.9) ship in v1.0.6.
- The remaining 233/321 rumen_insights flatline is NOT a v1.0.x onion bug — it's deployed-state Edge Function pin drift (this sprint's scope).
- After v1.0.7 + Joshua's `init --rumen --yes` against petvetbid, the Edge Function refreshes to 0.4.5 and insights should restart (caveat: rumen 0.4.5's picker may have its own shape mismatch with the new bundled hook's 1-row-per-session memory_items writes — see "Out of scope" section of PLANNING.md for the deeper Rumen-package work deferred to next week).

### Codex auditor has limited auto-accept
Joshua chose "Auto-review" mode for Codex (a happy medium between full-auto and prompt-on-everything). For future 3+1+1 sprints, the lane brief for the Codex auditor should explicitly specify the approval mode expectation. Sprint 51.5b T4-CODEX brief did NOT specify this; lesson canonized in cross-project memory `3+1+1 hardening rule candidate (Sprint 51.5b learning 2026-05-04)`.

### Single-lane direct is the right call for Sprint 52
Three single-lane direct sprints today (51.8, 52.1, 51.9) all shipped clean. The 3+1+1 ceremony is for sprints where adversarial review surfaces share-blind gaps; for narrow scope (single migration patch, single file, single SQL change), the orchestrator codes directly without panels. Sprint 52 is exactly that shape.

### TermDeck cadence flips after Sprint 52
- **Today/tonight (Sprint 52):** v1.0.7 ships with Edge Function pin drift detection + auto-redeploy. Brad's WhatsApp goes out (post-T3 redraft + T4-VERIFIED). Joshua re-runs `init --rumen` against petvetbid; insights restart.
- **Next week+:** weekly bumps for security/critical-only. Memory-quality innovation is the focus — Rumen picker rewrite (memory_sessions-direct), doctor blindness fix (Mnestra), better insight surfacing in dashboard, cost-monitoring panel (original Sprint 51 vision), etc. Sprint 24 (Maestro / chopin-scheduler) starts after Joshua's mail merge completes.

## Sprint queue ahead (post-Sprint-52)

1. **Sprint 53 — Rumen picker rewrite + doctor blindness fix** (next week). Rumen-package change at `~/Documents/Graciella/rumen/src/extract.ts:55-77` (pivot to memory_sessions-direct picker). Mnestra-package change at `~/Documents/Graciella/engram/...` (DoctorDataSource.rumenJobsRecent API addition). Two-package publish wave. Bigger scope than the daily mini-sprints; ~half-day.
2. **Sprint 54 — Cost-monitoring expandable dashboard panel** (original Sprint 51 vision). Per-agent subscription-vs-per-token billing exposure. Plan unchanged in `docs/sprint-51-cost-panel-and-polish/` — renumber when 53 closes.
3. **Sprint 24 (Maestro)** — chopin-scheduler SaaS readiness + WhatsApp Dispatch contract. Independent of TermDeck. Starts after Joshua's mail merge.

## Email reference

Most recent session-end email draft is in `admin@nashvillechopin.org` Gmail drafts. Subject prefix: "TermDeck Wrap — ...". The session-end email mandate from `~/.claude/CLAUDE.md` applies: when this Sprint 52 wraps, draft a session-end email with rich-text HTML body covering (1) what was done today across the 7 sprints, (2) what's queued, (3) absolute paths to RESTART-PROMPTs, (4) paste-ready restart prompt for the next session.

## Final wall-clock arc for 2026-05-04

| Time (ET) | Event |
|---|---|
| ~10:30 | Sprint 51.7 (v1.0.3) plan |
| ~12:00 | Sprint 51.7 ships |
| ~13:30 | Brad's settings.json bug report → Sprint 51.8 plan |
| ~14:00 | Sprint 51.8 (v1.0.4) ships |
| ~14:00-14:20 | Sprint 52.1 (v1.0.5) plan + ship — match_memories drift |
| ~14:30 | Joshua's `init --mnestra` against petvetbid succeeds first time post-onion-close |
| ~14:35 | Sprint 51.5b dogfood inject (3+1+1 — T1/T2/T3 Claude + T4 Codex) |
| ~14:42 | Codex T4 catches `memory_hybrid_search` drift cousin |
| ~14:55 | T3 catches mig 016 fresh-install RED |
| ~14:56 | Sprint 51.9 (v1.0.6) plan + code start |
| ~15:09-15:17 | T1/T2/T3 DONE in 51.5b |
| ~15:22 | T4-CODEX REOPEN T3 (Rumen pin claim wrong) |
| ~15:25 | Joshua approves v1.0.6 fold-in path (b) — both fixes in one wave |
| ~15:31 | T3 nudged for redraft |
| ~15:35-15:40 | v1.0.6 publish + push |
| ~15:42 | Sprint 52 plan authored |
| **TBD (you)** | **Sprint 52 code, ship, push, Brad WhatsApp send** |

Combined: 7 sprints in ~5 hours; 5 distinct failure classes closed; 4 ledger entries (#16/#17/#18/#19); 4 npm publish waves; 1 Class O failure class about to be canonized.

Begin Sprint 52 by reading the lane brief at `docs/sprint-52-edge-function-pin-drift/T1-pin-drift-and-redeploy.md` end-to-end, then execute Steps 1-9 in order.
