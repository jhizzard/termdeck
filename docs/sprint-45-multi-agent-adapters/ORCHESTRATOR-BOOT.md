# Sprint 45 — Orchestrator boot prompt (paste into the `claude-tg` panel)

This is the prompt to paste into the **orchestrator panel** — the Claude Code session that will fire the inject across the 4 worker terminals.

## How and where to start the orchestrator session

Open a new Terminal.app window (or a TermDeck-managed terminal panel) and run:

```bash
claude-tg
```

The `claude-tg` alias (defined in `~/.zshrc`) expands to:

```bash
claude --channels plugin:telegram@claude-plugins-official
```

That starts a Claude Code session with the **Telegram listener active** for the `@JoshTermDeckBot` chat. You'll see `telegram channel: polling as @JoshTermDeckBot` on stderr within ~3 seconds. From this point, you can DM the bot from your phone and the orchestrator will read + act + reply.

**Important:** the listener is per-process. Standard `claude` sessions do NOT get the Telegram listener. Only sessions started with `claude-tg` (or directly with `--channels`) read inbound Telegram messages. `/reload-plugins` does NOT activate the listener.

## Paste-ready orchestrator boot prompt

Once `claude-tg` is at its first prompt, paste this block:

```
You are the orchestrator for TermDeck Sprint 45 — Multi-agent adapter implementations: Codex + Gemini + Grok + launcher refactor. Joshua may signal "go, inject" via Telegram (you're running with the @JoshTermDeckBot listener active) or via direct keyboard. Boot sequence:

1. Run `date` to time-stamp.
2. memory_recall(project="termdeck", query="Sprint 45 multi-agent adapters Codex Gemini Grok launcher refactor PATTERNS shim removal cross-adapter parity")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate, 4+1 inject pattern)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md (publish protocol — Passkey-not-OTP)
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md (multi-agent design rationale + 7-field adapter contract + cross-CLI conventions)
8. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md (Grok session-context resolution + chooseModel heuristic + 5 lane-time open questions — REQUIRED reading)
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md (Sprint 44 T4 canonical reference doc — § 6 has worked example for adding an adapter)
10. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-45-multi-agent-adapters/PLANNING.md (Sprint 45 plan — 4 lanes, target termdeck@0.14.0)
11. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-45-multi-agent-adapters/STATUS.md (lane status — should be empty before kickoff)

Then begin: 

(a) Run the pre-sprint substrate probe (PLANNING.md § "Pre-sprint substrate findings"). Five checks: termdeck npm version (expect 0.13.0), rumen-tick + graph-inference-tick crons active, Grok CLI on PATH and verified, GROK_API_KEY env loaded, agent-adapters/{claude.js,index.js} from Sprint 44 intact. If any fail, flag to Joshua before injecting.

(b) Check current sessions: `curl -s http://127.0.0.1:3000/api/sessions | jq` — Joshua is opening 4 fresh sessions. Sort by meta.createdAt; the four newest are T1 (Codex) / T2 (Gemini) / T3 (Grok) / T4 (launcher refactor) in creation order.

(c) Wait for Joshua to signal "go, inject" (via Telegram or keyboard). When signaled, fire:

  SPRINT45_SESSION_IDS=<uuid1,uuid2,uuid3,uuid4> node /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-45-multi-agent-adapters/scripts/inject-sprint45.js

(d) After the script reports "all four panels reasoning" or completes its /poke cr-flood recovery, reply to Joshua with the four session IDs and their initial status.

(e) During sprint execution, run THREE side-tasks in parallel with the lanes (orchestrator-only, NOT in any lane):

  Side-task 1: DNS-resilience fix in rumen pool client. Add pg connection retry with exponential backoff (jittered: 100ms / 500ms / 2s / 5s caps), DNS-cache TTL respect, structured log levels by failure recency (first failure warn; consecutive within 60s window debug; recovery info). Files: packages/server/src/health.js (or wherever getRumenPool lives), NEW tests/rumen-pool-resilience.test.js. ~50-80 LOC. Per Joshua's directive 2026-05-01: "comprehensive, most architecturally correct fix."
  
  Side-task 2: Rumen-tick stale-job investigation. last_job_completed_at: 2026-04-16T03:30:00.956Z (2+ weeks old) but insights still landing daily. Hypotheses: (a) graph-inference cron writes edges but doesn't touch rumen_jobs; (b) rag-system MCP-side classifier writes insights at ingest; (c) rumen-tick partial-succeeding silently. Investigate via Supabase Edge Function logs + rag-system source + rumen_insights audit columns. Document findings in docs/sprint-45-multi-agent-adapters/SIDE-TASK-rumen-tick-stale-job.md.
  
  Side-task 3: docs/INSTALL-FOR-COLLABORATORS.md refresh post-publish. Pin to v0.14.0 + v0.4.9. Add multi-agent capability now that Codex/Gemini/Grok are first-class lane agents.

(f) Stay in orchestrator mode until all four lanes report DONE in STATUS.md AND all three side-tasks are resolved/documented, then run close-out: bump versions (termdeck 0.13.0→0.14.0, termdeck-stack 0.4.8→0.4.9), update CHANGELOG.md, update Sprint 45 STATUS.md sprint-close summary, run docsite content sync, run full test suite (expect 600+ tests, additions from T1/T2/T3/T4 new test files; 0 fail), commit, push, draft session-end email, give Joshua publish commands. Do NOT publish to npm; do NOT push if tests have new failures.
```

## Expected timing

- Orchestrator boot (steps 1-11): ~45 seconds (memory recalls + 6 file reads — heavier than Sprint 44 because more pre-reading)
- Substrate probe + session ID fetch: ~5 seconds
- "go, inject" → inject script wall-clock: ~12 seconds
- Lane execution (T1-T4 in parallel, plus side-tasks in orchestrator): ~15-25 minutes
- Close-out (tests + bumps + commit + push + docsite sync + INSTALL-FOR-COLLABORATORS refresh): ~5 minutes

**Total wall-clock from "go, inject" to "publish commands ready":** ~20-30 minutes.

## What you'll see

- Telegram channel listener: `[telegram channel] polling as @JoshTermDeckBot`
- Inject script output: paste-stage 4 lines + settle + submit-stage 4 lines + 8s verify + maybe `/poke` recovery + final "all four panels reasoning"
- Lane STATUS.md updates as the lanes append FINDING / FIX-PROPOSED / DONE
- Side-task progress in the same STATUS.md under "Side-task progress" section
- Close-out commit + push to `github.com/jhizzard/termdeck`

## If things go sideways

- **Sessions don't show up:** GET `/api/sessions` returned `[]`. Joshua hasn't opened the 4 panels yet — wait or prompt him.
- **Inject fires but a panel stays idle:** the script's 8s verify catches this and fires `/poke cr-flood`.
- **A lane hits a substrate problem:** the lane's FINDING entry will document. Surface to Joshua via Telegram immediately if it blocks the rest of the sprint.
- **Two adapters' index.js merges conflict:** orchestrator de-duplicates manually at sprint close. T1/T2/T3 each register their adapter; merge order: claude (Sprint 44) → codex → gemini → grok (alphabetical).
- **DNS side-task makes the rumen pool too aggressive:** fall back to the pre-fix behavior if the resilience layer causes new errors. Captured in the side-task's tests.
