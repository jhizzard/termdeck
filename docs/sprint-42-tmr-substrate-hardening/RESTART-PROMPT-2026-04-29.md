# Restart Prompt — 2026-04-29 (Sprint 42 morning-after / next session)

Paste this prompt block into the next Claude Code session you fire up tomorrow. Verbatim.

```
Boot sequence:

1. Run `date` to time-stamp.

2. memory_recall(project="termdeck", query="Sprint 42 graph-inference LATERAL HNSW PTY orphan reaper migration 003 Mnestra main field project removal drag drop")

3. memory_recall(query="recent decisions and bugs across projects")

4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — time-check mandate, session-end email, memory-first, 4+1 inject pattern, never copy-paste messages, two-stage submit pattern)

5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)

6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (publish protocol — Passkey-not-OTP, npm publish before push, audit-trail bumps)

7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-42-tmr-substrate-hardening/PLANNING.md (Sprint 42 plan — four lanes, target v0.11.0)

8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-42-tmr-substrate-hardening/STATUS.md (lane status from last night's overnight inject — read this FIRST before deciding what comes next)

9. memory_recall for the specific topic Joshua signals at session start.

Then begin.

Context heading into this session — what the prior session shipped and what's pending:

- Mnestra v0.3.2 was published to npm (live) — migration 014 (explicit GRANTs schema-wide) + remember.ts now throws on insert errors instead of silently returning 'skipped'. Resolves Brad's permission-denied incident from 2026-04-28 morning. Commit aa49b9c, pushed to jhizzard/mnestra.

- TermDeck v0.10.4 + termdeck-stack v0.4.5 — committed (be6013b) and pushed to jhizzard/termdeck. PUBLISH STATUS UNCERTAIN as of restart prompt write time (2026-04-28 ~20:45 ET) — Joshua may have tapped Passkey already, may not have. Verify with: npm view @jhizzard/termdeck version (expect 0.10.4) and npm view @jhizzard/termdeck-stack version (expect 0.4.5). If still 0.10.3 / 0.4.4, run from /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck:
    npm publish --auth-type=web
  then from packages/stack-installer:
    npm publish --auth-type=web

- Sprint 42 inject was fired overnight from the orchestrator session running on Joshua's machine. Lane status is in STATUS.md. If all four lanes report DONE, run close-out: bump versions per PLANNING.md (termdeck 0.10.4→0.11.0, mnestra 0.3.2→0.3.3 only if T3 touched it, termdeck-stack 0.4.5→0.4.6), update CHANGELOG, draft session-end email, commit + give Joshua publish commands.

- Brad outstanding follow-up: WhatsApp injected 2026-04-28 ~20:35 ET with the v0.10.4 + v0.3.2 summary. He may have replied overnight; check WhatsApp before assuming the issues are closed.

- Auto-mode-on-Opus question Brad raised earlier (2026-04-28 ~13:50 ET) is still unanswered — claude-code-guide agent 529'd at the time. If Brad re-raises it, retry the agent or answer from the official Claude Code docs (auto mode requires Opus-class reasoning; Sonnet is currently gated on the standard Pro plan).

- Brad's "mnestra doctor" subcommand suggestion is deferred to Sprint 43+ (open backlog item).
```

## Notes for tomorrow-Claude

- The "Sprint 42 inject was fired overnight" line above assumes the orchestrator successfully injected the four lanes tonight. If STATUS.md is empty (no FINDING/FIX-PROPOSED/DONE entries), the inject failed or didn't happen — flag that to Joshua and ask before acting.
- Two-stage submit pattern is mandatory for any TermDeck inject: paste + 400ms settle + submit-alone. Single-stage `<text>\x1b[201~\r` is BANNED (cost Joshua broken sleep twice — 2026-04-26 and 2026-04-27).
- "Last seen running" baseline at 2026-04-28 evening: TermDeck server alive on :3000, memory_items 5,825, memory_relationships 901, chopin-nashville 40, graph-inference cron disabled, PTY count 100.
