# Restart Prompt — 2026-05-01 (Sprint 44 morning / next-session start)

Paste this prompt block into the next Claude Code session you fire up tomorrow. Verbatim.

```
Boot sequence:

1. Run `date` to time-stamp.

2. memory_recall(project="termdeck", query="Sprint 44 multi-agent foundation Grok CLI install SuperGrok Heavy AGENTS.md sync adapter registry Claude adapter migration AGENT-RUNTIMES.md")

3. memory_recall(query="recent decisions and bugs across projects")

4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate, 4+1 inject pattern, never copy-paste messages)

5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)

6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (publish protocol — Passkey-not-OTP, npm publish before push, audit-trail bumps)

7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md (THE design rationale for Sprints 44/45/46)

8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/PLANNING.md (Sprint 44 plan)

9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/ORCHESTRATOR-BOOT.md (the paste-ready prompt for the claude-tg orchestrator panel)

10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/STATUS.md (lane status — should be empty if Sprint 44 hasn't fired yet; populated if it did)

11. memory_recall for the specific topic Joshua signals at session start.

Then begin.

Context heading into this session — what last session shipped and what's pending:

- Sprint 43 (graph viewer controls + flashback persistence + init-rumen wizard repair + Telegram orchestration) closed 2026-04-30 17:42 ET. Wall-clock ~17 min. All 4 lanes DONE on first attempt. 544/541 tests passing (4 skipped, 0 fail).

- v0.12.0 + termdeck-stack@0.4.7 committed (e1fc5ea) and pushed at session close. PUBLISH STATUS UNCERTAIN as of restart prompt write time (2026-04-30 21:55 ET). Joshua may have tapped Passkey already, may not have. Verify with: `npm view @jhizzard/termdeck version` (expect 0.12.0) and `npm view @jhizzard/termdeck-stack version` (expect 0.4.7). If still 0.11.0/0.4.6, the publish commands are documented in CHANGELOG.md and ORCHESTRATOR-BOOT.md.

- Sprint 44 docs are FULLY INJECT-READY at docs/sprint-44-multi-agent-foundation/: PLANNING.md, T1-T4 lane briefs, STATUS.md template, scripts/inject-sprint44.js, ORCHESTRATOR-BOOT.md (paste-ready for claude-tg session), and this RESTART-PROMPT.

- Telegram channel is LIVE: bot @JoshTermDeckBot, paired user ID <chat-id-redacted>, allowlist policy active. Listener requires a `claude-tg` (= `claude --channels plugin:telegram@claude-plugins-official`) session — `/reload-plugins` does NOT activate it. Memory entry at ~/.claude/projects/.../memory/reference_telegram_channel.md.

- Three concerns Joshua flagged at end of Sprint 43:
  (a) "No flashbacks visible" — explanation: ~/.termdeck/termdeck.db hasn't been re-init'd against the v0.12.0 source, so flashback_events table doesn't exist locally yet. Resolution: restart the TermDeck server on local v0.12.0 source → migration 001_flashback_events.sql runs automatically → table exists → future fires log to it. He may also genuinely not have hit error-pattern thresholds during Sprint 43 lanes (clean execution = no fires).
  (b) "Not sure about clean install for SWE" — INSTALL-FOR-COLLABORATORS.md is pinned to v0.11.0 + tells testers to skip Rumen tier. Sprint 43 T3 fixed the wizard so the "DEFER Rumen" guidance flips to "do it" once v0.12.0 is published. Sprint 44 close-out has a queued add-on (per ORCHESTRATOR-BOOT.md step f) to refresh the doc.
  (c) "Rumen connection" — verified at session close: rumen-tick cron */15 * * * * active=true, graph-inference-tick 0 3 * * * active=true, 304 rumen_insights in store. RUMEN IS ALIVE AND PRODUCING. The concern was unfounded.

- Sprint 45 + 46 (Codex / Gemini / Grok adapter implementations + mixed-agent 4+1) follow Sprint 44 in the trilogy. Designs at docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md.

- Sprint 47+ candidates: TheHarness as a TermDeck lane agent (BHHT-economy unlock); flashback client-side audit-write gap (Sprint 43 T2 finding); mnestra doctor subcommand (Brad's third upstream suggestion).

- BHHT side-stack (Brook Hiddink High Ticket): 23/23 Module 2 video transcriptions stored in Supabase project bhht-video-extractor table ht_video_extractions via Vertex AI Gemini 2.5 Flash. Architecture doc + project prompt at /Users/joshuaizzard/.claude/plans/that-should-do-it-flickering-rain.md (the multi-agent plan, indirectly relevant) and a separate Claude.ai project Joshua maintains. Convention: Claude as autonomous executor, Playwright MCP for browser ops, Supabase for state, no custom web app.

When you're ready to fire Sprint 44:
1. Joshua opens 4 fresh `claude` worker terminals in TermDeck.
2. Joshua opens an orchestrator session by running `claude-tg` (alias for `claude --channels plugin:telegram@claude-plugins-official`) in any terminal — this starts a Claude Code session with the Telegram listener active for @JoshTermDeckBot.
3. Joshua pastes the ORCHESTRATOR-BOOT.md "paste-ready prompt" block into the orchestrator session.
4. Joshua signals "go, inject" via Telegram or keyboard.
5. Orchestrator session fires `node docs/sprint-44-multi-agent-foundation/scripts/inject-sprint44.js` with the four session UUIDs.
6. Two-stage submit pattern fires: paste 4 prompts → 400ms settle → submit \r alone → 8s verify → /poke cr-flood recovery for any stuck panel.
7. All four lanes execute in parallel; orchestrator monitors STATUS.md for DONE entries; runs close-out when all four ship.
```

## Notes for tomorrow-Claude

- The `claude-tg` alias (in `~/.zshrc`) is `claude --channels plugin:telegram@claude-plugins-official`. Listener is per-process; standard `claude` doesn't get it.
- Two-stage submit pattern is mandatory for any inject. Single-stage `<text>\x1b[201~\r` is BANNED (cost Joshua broken sleep multiple times).
- Last seen substrate at 2026-04-30 evening: TermDeck server alive on :3000 with v0.12.0 source running (PTY reaper enabled, tickCount 29 at last check). 5,891 memory_items. 1,302 memory_relationships. 304 rumen_insights. chopin-nashville=40 (Sprint 41 acceptance held). Telegram channel allowlist policy active.
- The MEMORY.md index at ~/.claude/projects/.../memory/MEMORY.md was updated to reference reference_telegram_channel.md. Memory recall queries on "Telegram channel" or "@JoshTermDeckBot" surface the bot details.
- If the orchestrator panel needs to send a Telegram message, that capability is auto-available via the `/notifications/claude/channel` MCP — no separate wiring needed.
