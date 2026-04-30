# Sprint 44 — Orchestrator boot prompt (paste into the `claude-tg` panel)

This is the prompt to paste into the **orchestrator panel** — the Claude Code session that will fire the inject across the 4 worker terminals.

## How and where to start the orchestrator session

Open a new Terminal.app window (or a TermDeck-managed terminal panel — both work) and run:

```bash
claude-tg
```

The `claude-tg` alias (defined in `~/.zshrc`) expands to:

```bash
claude --channels plugin:telegram@claude-plugins-official
```

That starts a Claude Code session with the **Telegram listener active** for the `@JoshTermDeckBot` chat. You'll see `telegram channel: polling as @JoshTermDeckBot` on stderr within ~3 seconds.

**Important:** the listener is per-process. Joshua's regular `claude` session is NOT Telegram-listening. Only sessions started with `--channels` (or via the `claude-tg` alias) read inbound Telegram messages. `/reload-plugins` does NOT activate the listener — you have to start a new session with `--channels`.

## Paste-ready orchestrator boot prompt

Once `claude-tg` is at its first prompt, paste this block:

```
You are the orchestrator for TermDeck Sprint 44 — Multi-agent foundation: Grok install + AGENTS.md sync mechanism + adapter registry skeleton + AGENT-RUNTIMES.md canonical doc. Joshua may signal "go, inject" via Telegram (you're running with the @JoshTermDeckBot listener active) or via direct keyboard. Boot sequence:

1. Run `date` to time-stamp.
2. memory_recall(project="termdeck", query="Sprint 44 multi-agent foundation Grok CLI install SuperGrok Heavy AGENTS.md sync adapter registry Claude adapter migration AGENT-RUNTIMES.md")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate, 4+1 inject pattern)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (publish protocol — Passkey-not-OTP)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md (full design rationale + adapter contract + cross-CLI conventions + SuperGrok Heavy correction)
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/PLANNING.md (Sprint 44 plan — 4 lanes, target termdeck@0.13.0)
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/STATUS.md (lane status — should be empty before kickoff)

Then begin: 

(a) Run the pre-sprint substrate probe (PLANNING.md § "Pre-sprint substrate findings"). Five checks: termdeck npm version (expect 0.12.0 or higher), rumen-tick + graph-inference-tick crons active, TermDeck server alive on :3000 with PTY reaper running, flashback_events table exists in ~/.termdeck/termdeck.db, Telegram channel allowlist policy active. If any fail, flag to Joshua before injecting.

(b) Check current sessions: `curl -s http://127.0.0.1:3000/api/sessions | jq` — Joshua is opening 4 fresh sessions. Sort by meta.createdAt; the four newest are T1/T2/T3/T4.

(c) Wait for Joshua to signal "go, inject" (via Telegram or keyboard). When signaled, fire:

  SPRINT44_SESSION_IDS=<uuid1,uuid2,uuid3,uuid4> node /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-44-multi-agent-foundation/scripts/inject-sprint44.js

(d) After the script reports "all four panels reasoning" or completes its /poke cr-flood recovery, reply to Joshua with the four session IDs and their initial status.

(e) Stay in orchestrator mode until all four lanes report DONE in STATUS.md, then run close-out: bump versions (termdeck 0.12.0→0.13.0, termdeck-stack 0.4.7→0.4.8), update CHANGELOG, update Sprint 44 STATUS.md sprint-close summary, run docsite content sync, run full test suite (expect 544+ tests, additions from new T2/T3 tests; 0 fail), commit, push, draft session-end email, give Joshua publish commands. Do NOT publish to npm; do NOT push if tests have new failures.

(f) Sprint-44-specific close-out add-on (Joshua flagged at end of Sprint 43): refresh docs/INSTALL-FOR-COLLABORATORS.md to reflect post-v0.12.0 reality — the "DEFER Rumen tier" guidance flips to "do it" because Sprint 43 T3 fixed the wizard. Pin the doc to v0.13.0 / v0.4.8 versions.
```

## Expected timing

- Orchestrator boot (steps 1-9): ~30 seconds (memory recalls + 4 file reads)
- Substrate probe + session ID fetch: ~5 seconds
- "go, inject" → inject script wall-clock: ~12 seconds
- Lane execution (T1-T4 in parallel): ~10-25 minutes (Sprint 41 = 9 min, Sprint 42 = 12 min, Sprint 43 = 17 min)
- Close-out (tests + bumps + commit + push + docsite sync): ~3 minutes

**Total wall-clock from "go, inject" to "publish commands ready":** ~15-30 minutes.

## What you'll see

- Telegram channel listener: `[telegram channel] polling as @JoshTermDeckBot`
- Inject script output: paste-stage 4 lines + settle + submit-stage 4 lines + 8s verify + maybe `/poke` recovery + final "all four panels reasoning"
- Lane STATUS.md updates as the lanes append FINDING / FIX-PROPOSED / DONE
- Close-out commit + push to `github.com/jhizzard/termdeck`

## If things go sideways

- **Sessions don't show up:** GET `/api/sessions` returned `[]`. Joshua hasn't opened the 4 panels yet — wait or prompt him.
- **Inject fires but a panel stays idle:** the script's 8s verify catches this and fires `/poke cr-flood`. Watch for the recovery output.
- **A lane hits a substrate problem (cron broken, tests failing):** the lane's FINDING entry will document. Surface to Joshua via Telegram immediately if it blocks the rest of the sprint.
- **`claude-tg` doesn't load the channel:** `which bun` should return `/usr/local/bin/bun` (or wherever Bun lives). If empty, Bun isn't installed. Run `curl -fsSL https://bun.sh/install | bash` then `exec $SHELL -l`.

## Once you (orchestrator) finish close-out

Reply to Joshua via Telegram (he may be away from the keyboard) with the publish commands and verify URLs. The full template is in PLANNING.md § "Operational close-out remaining" once it's stamped.
