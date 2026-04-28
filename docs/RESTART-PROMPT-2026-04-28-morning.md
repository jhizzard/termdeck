# Restart Prompt — TermDeck — 2026-04-28 morning (post-Sprint-39 + Sprint-40)

This document is the canonical hand-off for the next Claude Code session that Joshua opens after waking from the overnight orchestration. **Two sprints shipped overnight** — Sprint 39 (Flashback Resurrection 2.0, commit `bfff819`, `v0.10.1`) and Sprint 40 (Defensive Hardening, commit `17186a0`, `v0.10.2`). npm publishes are pending Joshua's manual action (Passkey-not-OTP).

## Sprint 40 addendum (commit 17186a0, v0.10.2, 2026-04-27 ~22:30 ET)

After Sprint 39 close, Joshua approved continuing through Sprint 40 in single-orchestrator mode (lane panels were still doing post-DONE work and weren't safe to inject). Three lanes shipped:

- **T1 — WS handler contract smoke test**: NEW `tests/ws-handler-contract.test.js` (3 tests, all pass). Statically scans server JS for every `JSON.stringify({type:'X'})` emit and every `case 'X':` in app.js ws.onmessage switches; asserts every emit has a handler in every switch + parity guard. **Would have caught Sprint 39's 9-day silence on first CI run.** Surface fix: reconnect WS at `app.js:1245+` was missing `case 'config_changed':` — added.
- **T2 — Analyzer broadening**: closed all 3 pre-existing PATTERNS.error case-sensitivity gaps (uppercase ERROR:, ENOENT/EACCES/ECONNREFUSED colon shapes, HTTP 5xx server log via new `pythonServer.serverError` pattern, `npm ERR!` and mixed-case `Fatal:` in errorLineStart). `packages/server/tests/session.test.js`: 32/35 → **35/35**. Sprint 39 fixture corpora still green.
- **T4 — Sprint 39 postmortem + WS message contract docs**: NEW `docs/POSTMORTEM-sprint-39.md` (timeline, root cause analysis, 5 lessons learned). NEW `docs/WS-MESSAGE-CONTRACT.md` (source-of-truth for the 6 WS types).
- **T3 — `/api/flashback/diag` dashboard UI**: deferred to Sprint 41 (UI work needs browser verification per CLAUDE.md; Joshua asleep).

Test status after Sprint 40: top-level `tests/` 394/391/0/3 (+3 net new). server `tests/` 35/35. Zero new failures across both sprints.

Sprint 40 made **zero database writes**, **no migration**, **no companion releases** (`@jhizzard/termdeck-stack@0.4.3` unchanged from Sprint 39 close).

Pending publishes have been bumped: `@jhizzard/termdeck@0.10.2` (was @0.10.1 at Sprint 39 close); `@jhizzard/termdeck-stack@0.4.3` (unchanged).

## Live state at hand-off (2026-04-27 22:00 ET, post-commit-bfff819)

### What just shipped overnight

- **Commit `bfff819`** on `origin/main` (github.com/jhizzard/termdeck) — Sprint 39 close, `v0.10.1`. 36 files changed, 2,652 insertions.
- **`@jhizzard/termdeck@0.10.1`** — version bumped in `package.json`. **NOT published to npm.** Joshua's morning action.
- **`@jhizzard/termdeck-stack@0.4.3`** — audit-trail patch bump in `packages/stack-installer/package.json`. **NOT published to npm.** Joshua's morning action.
- **Migration 011 applied to live `petvetbid`** (commit `bfff819` content). Counts: chopin-nashville 1,237 → 947 (-290). Per-bucket: termdeck +146, rumen +83, podium +56, pvb +3, dor +2.
- **391 top-level tests, 388 pass, 0 fail, 3 skipped.** Previously-failing `project-bound flashback` test now passes via the orchestrator-applied e2e assertion-shape fix.
- **3 server-side `packages/server/tests/session.test.js` failures persist** — same case-sensitivity gaps T2 documented; orthogonal to Sprint 39's scope; Sprint 40 candidate.

### THE SMOKING GUN (Sprint 39 T4 finding 2)

`packages/client/public/app.js` had no `case 'proactive_memory':` branch in either of its two `ws.onmessage` switches. Server-side WS-push works correctly end-to-end (T4 verified via real zsh + bash subprocess tests, both pass). Every emitted `proactive_memory` frame went into the void. The fallback path (`status_broadcast` polling for `meta.status === 'errored'`) only catches the ~10–50 ms errored window inside a 2000 ms broadcast cycle (~2.5 %), so the client transitions `active → idle` skipping `errored` and `triggerProactiveMemoryQuery` is never invoked. **9-day silence explained.**

The 3-line fix (× 2 sites) is in `bfff819` at `app.js:237` + `app.js:1245`. **Requires server restart to surface in Joshua's running TermDeck.**

### What's open / NOT done yet (Joshua's morning action items)

1. **Restart TermDeck server.** The orchestrator did NOT restart the server. The new `/api/flashback/diag` route, the `case 'proactive_memory':` client handler, and T2's tightened `PATTERNS.shellError` regex all require a restart to surface. Use `./scripts/start.sh` or `npx @jhizzard/termdeck@0.10.0` (or `@0.10.1` once published).
2. **Verify Flashback fires in real flow.** After restart, trigger any error in a TermDeck session (e.g., `cat /nonexistent`) and confirm a toast surfaces. If it doesn't, `curl http://localhost:3000/api/flashback/diag?sessionId=<your-session-id>` to read T1's structured event log and diagnose at the gate that dropped it.
3. **Publish the new versions to npm.** Passkey-not-OTP per `docs/RELEASE.md`. Order: `@jhizzard/termdeck-stack@0.4.3` first (audit-trail bump from Sprint 39), then `@jhizzard/termdeck@0.10.2` (Sprint 39 + 40 combined). Do NOT use `--otp` (the `@jhizzard/*` org auths via web Passkey). Note: v0.10.1 was bumped in `bfff819` and v0.10.2 in `17186a0` — only the latest needs publishing; npm doesn't gate-check intermediate version skips for the same package.
4. **Forward-fix the harness hook PROJECT_MAP.** `~/.claude/hooks/memory-session-end.js` is OUT OF REPO (your harness, not the bundled hook). Its PROJECT_MAP at lines 14–28 has no entries for termdeck/mnestra/rumen/podium/dor; without a forward-fix, new sessions in those projects continue to land under `chopin-nashville` even after the 011 backfill heals the historical rows. Add entries like:
   ```js
   { pattern: /SideHustles\/TermDeck/i, project: 'termdeck' },
   { pattern: /Graciella\/engram/i, project: 'mnestra' },
   { pattern: /Graciella\/rumen/i, project: 'rumen' },
   { pattern: /ChopinInBohemia\/podium/i, project: 'podium' },
   { pattern: /Documents\/DOR/i, project: 'dor' },
   ```
   These should fire BEFORE the `/ChopinNashville/i` catch-all.
5. **(Optional) Send Brad the WhatsApp message** if you didn't last night — see `RESTART-PROMPT-2026-04-28.md` for the prior context.

### What's still queued (Sprint 40+ candidates)

- **Sprint 40 P0 candidate:** Server-restart hot-reload — the `proactive_memory` handler being missing for 9 days is a class of bug a server-restart wouldn't catch even after the fix lands. Consider an end-to-end smoke probe that hits the bridge + WS path on every server start and self-checks the toast emit.
- Analyzer broadening for the 3 case-sensitivity gaps + 2 claude-code-matcher gaps T2 documented (uppercase `ERROR:`, lowercase `no such file or directory` / `ENOENT:` shape, HTTP 5xx server log shape; `npm ERR!` not in `errorLineStart`, mixed-case `Fatal:` not covered).
- LLM-classification backfill pass for the ~876 chopin-nashville "other/uncertain" rows that 011 deliberately left untouched (no clear single-project keyword signal).
- T1 `/api/flashback/diag` UI surface (today: curl-only — could be a sidebar in the dashboard's Memory tab).
- Server-side `onStatusChange` per-session `meta` push as defense-in-depth alongside the client handler (both could ship; today only the client handler is in `bfff819`).
- Sprint 38 follow-up: graph-inference SQL rewrite (LATERAL + HNSW) — pre-existing, deferred because the 5,500-row pairwise self-join times out before the 150 s Edge Function wall-clock. Cron is still UNSCHEDULED.

### Sprint 39 STATUS.md per-lane summary

| Lane | Verdict | Key deliverable |
|---|---|---|
| T1 — instrumentation | DONE 21:36 | `/api/flashback/diag` + 6-event ring buffer + 17 tests |
| T2 — rcfile-noise | DONE 21:46 | Hypothesis REFUTED for Joshua's flow; tightened `PATTERNS.shellError` + 8 fixtures + 8 tests |
| T3 — project-tag | DONE 21:43 | Bridge mismatch REFUTED; corpus mis-tag CONFIRMED; 011 backfill (290 rows moved) + 5 tests |
| T4 — production-flow e2e | DONE 21:49 | NEW `tests/flashback-production-flow.test.js` (357 LOC) — caught the smoking gun client-side handler gap |

### Substrate state

- petvetbid: 5,631 memory_items (was 5,530 at sprint kickoff). 778 memory_relationships unchanged. chopin-nashville count after migration 011: 947 (was 1,237).
- Rumen `rumen-tick` cron: green throughout (last 5 runs all succeeded as of 22:00 ET).
- Mnestra ingestion +101 during the 22-min sprint window (lane workers were actively calling memory_remember alongside file work).

## Restart-prompt-doc cross-references

- **This file:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-04-28-morning.md`
- **Overnight orchestrator briefing (predecessor, now historical):** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-04-28.md`
- **Older:** `RESTART-PROMPT-2026-04-27.md`, `RESTART-PROMPT-2026-04-26.md`, `RESTART-PROMPT-2026-04-19.md`, `RESTART-PROMPT-2026-04-18.md`.
- **Sprint 39 docs:** `docs/sprint-39-flashback-resurrection/PLANNING.md`, `STATUS.md` (full DONE entries from all four lanes), `T1-flashback-instrumentation.md` through `T4-production-flow-e2e.md`.
- **Project router:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md`.
- **Global rules:** `/Users/joshuaizzard/.claude/CLAUDE.md`.
- **CHANGELOG:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CHANGELOG.md` — `[0.10.1]` entry.
- **Release process:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — STRICT (Passkey-not-OTP, publish before push, audit-trail bumps).

## Paste-ready prompt block for the morning post-Sprint-39 session

```
You are the morning post-Sprint-39 session for TermDeck. Sprint 39 (Flashback Resurrection 2.0) shipped overnight in 22 minutes wall-clock; commit bfff819 is on origin/main. npm publishes are pending. The smoking gun (T4 finding 2): packages/client/public/app.js had no `case 'proactive_memory':` branch in its ws.onmessage switches — every push frame went into the void for ~9 days. The 3-line fix (× 2 sites) is in bfff819. THE SERVER MUST BE RESTARTED for the fix to surface in Joshua's running TermDeck.

Boot sequence:
1. Run `date` to time-stamp.
2. memory_recall(project="termdeck", query="Sprint 39 flashback resurrection client-side smoking-gun proactive_memory case missing")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — time check, session-end email, memory-first, never copy-paste)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-04-28-morning.md (this file — your authoritative briefing for what's open/done)
7. memory_recall(project="termdeck", query="<the topic Joshua signals at session start>")

Joshua's morning checklist (covered in detail in the RESTART-PROMPT-2026-04-28-morning.md doc above):
1. Restart TermDeck server (./scripts/start.sh or npx @jhizzard/termdeck@0.10.1 once published).
2. Verify Flashback fires in real flow (cat /nonexistent in a TermDeck session → toast).
3. Publish v0.10.1 + termdeck-stack@0.4.3 to npm via web Passkey (NOT --otp).
4. Forward-fix ~/.claude/hooks/memory-session-end.js PROJECT_MAP (out-of-repo; without it new mis-tagged rows continue landing under chopin-nashville). Pattern entries needed: termdeck, mnestra, rumen, podium, dor — must fire BEFORE the /ChopinNashville/i catch-all.
5. (Optional) Sprint 40 P0 candidate planning: end-to-end startup smoke probe so the client-handler-gone-missing class of bug surfaces on next restart.

Then begin whatever Joshua signals.
```

## Things to NOT do this morning

- Do NOT restart the server BEFORE Joshua signals readiness — restart is his action so he can confirm the smoke check live.
- Do NOT publish to npm — Joshua publishes via Passkey-not-OTP himself; orchestrator is forbidden from running `npm publish` per docs/RELEASE.md.
- Do NOT enable the graph-inference cron — task #19 (LATERAL+HNSW SQL rewrite) is still open; cron stays UNSCHEDULED.
- Do NOT run additional migrations against live `petvetbid` — 011 is applied; nothing else is queued.
- Do NOT modify `~/.termdeck/secrets.env`.
