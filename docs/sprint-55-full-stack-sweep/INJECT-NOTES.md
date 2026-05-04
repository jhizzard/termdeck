# Sprint 55 — Inject notes for orchestrator (Mode A overnight OR Mode B morning)

This doc is for the orchestrator (Claude Code session) that fires the Sprint 55 inject. Either Mode A (Joshua opens panels at bedtime, fires before sleep) or Mode B (fresh morning session, opens panels, fires when ready).

## Pre-fire check (60 seconds)

```bash
date '+%Y-%m-%d %H:%M ET'
npm view @jhizzard/termdeck version          # 1.0.9 expected
npm view @jhizzard/rumen version             # 0.5.2 expected
git -C ~/Documents/Graciella/rumen log --oneline -1   # 37c6bd2 expected
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"  # 233 baseline
curl -s --max-time 3 http://127.0.0.1:3000/api/sessions 2>&1 | head -1  # TermDeck server alive?
```

If TermDeck server is NOT running on `127.0.0.1:3000`:
```bash
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm start
# Wait ~5 seconds, then verify with the curl above.
```

## Panel boot commands (what Joshua types in each panel)

Joshua opens 4 panels in TermDeck. The order matters — the inject script maps lanes to panels by `meta.createdAt` ascending. So **open in T1 → T2 → T3 → T4 order.**

| Panel | Agent | Command Joshua types |
|---|---|---|
| T1 | Claude Code | `claude --dangerously-skip-permissions` |
| T2 | Claude Code | `claude --dangerously-skip-permissions` |
| T3 | Claude Code | `claude --dangerously-skip-permissions` |
| T4 | **Codex CLI** | `codex` (then run `/approvals` and set auto-review BEFORE the inject lands) |

**The `--dangerously-skip-permissions` flag is the unattended-mode key for the Claude lanes.** Without it, Claude prompts on certain tool calls (e.g. write to non-allowlisted paths) and an overnight run would stall.

**Codex's auto-review mode** is set inside the CLI via `/approvals` slash command (not a startup flag). The T4 lane brief restates this mandate as Step 0, but it's safer for Joshua to set it pre-inject so the brief lands cleanly.

## Inject script

Committed at `docs/sprint-55-full-stack-sweep/inject-script.js` (also pre-staged at `/tmp/inject-sprint-55-prompts.js`). The script:
1. GETs `/api/sessions`, sorts by createdAt ascending, takes the 4 most recent
2. Reads the 4 lane briefs from `docs/sprint-55-multi-lane-stack sweep/T{1,2,3,4}-*.md`
3. Stage 1: paste each brief into the corresponding panel's input box (bracketed-paste markers, no \r yet)
4. Settle 400ms
5. Stage 2: submit `\r` to each panel — the canonical two-stage pattern from `~/.claude/CLAUDE.md`
6. Wait 8 sec, verify each panel shows `status: thinking`
7. If any panel is idle, POST `/api/sessions/:id/poke` with `methods: ['cr-flood']` to recover (no human Enter needed)

The script is self-contained Node — no dependencies beyond Node 24 + globalThis fetch + fs.

If you (next-orchestrator) need to re-write the script from scratch, copy `/tmp/inject-sprint-53-prompts.js` and replace the docs path. Same pattern.

## Boot prompt content (per lane, tight, fits in bracketed-paste)

The script auto-generates these from the lane briefs. The shape per lane:

```
You are T<n> in Sprint 55 (multi-lane full stack sweep).
Boot sequence:
1. date '+%Y-%m-%d %H:%M ET'
2. memory_recall(project="termdeck", query="<lane-specific topic>")
3. memory_recall(project="termdeck", query="petvetbid externally facing scrub feedback codename")
4. memory_recall(query="3+1+1 hardening rules checkpoint post shape idle-poll regex")
5. Read ~/.claude/CLAUDE.md and ./CLAUDE.md
6. Read docs/sprint-55-multi-lane-stack sweep/PLANNING.md
7. Read docs/sprint-55-multi-lane-stack sweep/STATUS.md
8. Read docs/sprint-55-multi-lane-stack sweep/T<n>-<lane>.md (your full brief)

Pre-sprint intel: 9 sprints shipped 2026-05-04 (v1.0.4 → v1.0.9). Sprint
53 picker rewrite working (sessions_processed > 0). Sprint 54 closed
relate.ts 8-arg call but insights_generated=0 from sessions_processed=4
remains open — Sprint 55 Lane T3 Cell #1 diagnoses. Don't ship; don't
publish; READ-ONLY OVERNIGHT.

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in
docs/sprint-55-multi-lane-stack sweep/STATUS.md using the canonical
### [T<n>] (or [T4-CODEX]) shape. Move fast.
```

## Sprint close (when all 4 lanes DONE)

Orchestrator (Claude Code session, either same-session-overnight or fresh-morning):
1. Read STATUS.md final state — verify all 4 DONE posts.
2. Read 4 SWEEP-CELLS.md files — count cells, identify failures.
3. Categorize: GREEN POST / YELLOW POST / RED defer (per PLANNING.md acceptance criterion #5).
4. **If T3 Cell #1 yielded a synthesis-bug fix:** apply the FIX-PROPOSED diff to `~/Documents/Graciella/rumen/src/<file>.ts`, bump rumen 0.5.2 → 0.5.3, hand to Joshua for `npm publish --auth-type=web` + `init --rumen --yes`, then manually fire rumen-tick + verify rumen_insights count grows past 233. THIS IS THE END-RESULT METRIC. Don't claim Sprint 55 is GREEN until the count moves.
5. **If FIX-PROPOSED is in a different package** (mnestra / termdeck), follow same publish pattern in correct order.
6. Commit + push origin/main per repo. Same shape as Sprint 53 wave.
7. Send Brad WhatsApp ONLY when count moves. Joshua's WhatsApp auto-send memory means draft = sent — don't open the URL until you have empirical evidence.
8. Draft session-end email update covering Sprint 55 outcome.

## Mode-specific notes

### Mode A (overnight)
- Workers run autonomously while Joshua sleeps. STATUS.md is the morning artifact.
- NO publishes, NO commits overnight. Workers post FIX-PROPOSED only.
- Orchestrator (= you, next-morning session) ships the fixes interactively.
- Wake-up signal: Joshua reads STATUS.md, sees lane DONE posts, knows stack sweep ran.

### Mode B (morning)
- Workers run with orchestrator monitoring in real time.
- Lanes can iterate FIX-PROPOSED → AUDIT → FIX-LANDED in flight (T4 audits, workers absorb).
- Faster overall (~90 min) and produces more coverage because of iteration.
- Orchestrator ships at sprint close, same as Sprint 53.

## Failure recovery

If the inject script returns "panel still idle after 8s":
- POST `/api/sessions/:id/poke` with `methods: ['cr-flood']` — already in the script.
- If `cr-flood` fails too, manual debug: read the panel's buffer via GET `/api/sessions/:id/buffer`, see what state it's in.

If the agent CLI itself doesn't boot (e.g. Codex auth expired):
- Joshua re-auths in that panel.
- Re-inject the affected lane's brief manually via `/api/sessions/:id/input` POST.

If TermDeck server crashes mid-sprint:
- All 4 panels are killed.
- STATUS.md preserves whatever was already posted.
- Restart server, restart panels, re-inject (the lane brief boot sequence is idempotent — workers re-read STATUS.md and resume from where they left off).

## Don'ts

- **Don't open Gemini or Grok panels for Sprint 55.** Their CLIs are approval-heavy without unattended-mode flags. Adding them needs remote-press-enter infrastructure that's a separate Sprint 56+ engineering ask.
- **Don't fire the inject if any panel hasn't booted to its agent CLI prompt.** The two-stage paste+\r assumes the panel is at a fresh prompt waiting for input. If a panel is still loading, the paste lands in the wrong place.
- **Don't fire the inject if `npm start`-style services (TermDeck server, Mnestra MCP) aren't healthy.** Pre-fire check covers this.
- **Don't message Brad until the rumen_insights count actually moves.** Joshua's auto-send WhatsApp means every wa.me URL = a sent message. Hold the message until empirical evidence is in.
