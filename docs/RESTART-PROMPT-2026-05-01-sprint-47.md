# Restart prompt — Sprint 47 orchestrator (paste into a fresh Claude Code session)

You are the orchestrator for TermDeck Sprint 47 — Mixed 4+1 infrastructure (per-lane agent assignment + Sprint 46 deferrals). Joshua will signal "go, inject" via Telegram (the @JoshTermDeckBot listener should be running via `claude-tg` if the Telegram MCP is connected; otherwise he'll signal directly via keyboard).

## Boot sequence (do these in order, no skipping)

1. Run `date` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 47 mixed 4+1 frontmatter boot-prompt-resolver inject mixed-agent dispatch status-merger Sprint 46 deferrals v1.0.0")`
3. `memory_recall(query="recent decisions and bugs across projects")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules. **MANDATORY** sections to internalize: time check, session-end email, memory-first, 4+1 inject mandate (two-stage submit pattern), never-copy-paste-messages.
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router (no-TypeScript, vanilla JS, CommonJS, RELEASE.md before publishing).
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — strict publish protocol (Passkey, NEVER `--otp`).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md` — multi-agent design rationale (the *why* behind the 7-field adapter contract; Sprint 47 extends it to 8 fields with `acceptsPaste`).
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md` — Sprint 44 T4 canonical reference (adapter contract spec, how-to-add-a-new-agent worked example).
9. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md` — the 14 deferred sub-optimal items orchestrator picks up opportunistically during Sprint 47.
10. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/PLANNING.md` — Sprint 47 plan (4 lanes, target termdeck@0.16.0 or 1.0.0).
11. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md` — should be empty before kickoff.
12. Read all four lane briefs at `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/T{1,2,3,4}-*.md` so you know what each lane is about to do.

## Then begin

### (a) Run the pre-sprint substrate probe (PLANNING.md § "Pre-sprint substrate findings")

Seven checks: (1) `npm view @jhizzard/termdeck version` should be 0.15.0 and `@jhizzard/termdeck-stack` should be 0.4.10. (2) Server alive on :3000. (3) `/api/agent-adapters` returns 4 adapters. (4) All four CLI binaries on PATH (`which claude codex gemini grok`). (5) Rumen + graph-inference crons active. (6) Sprint 46's inject script is the cleanest reference for cloning. (7) `packages/server/src/sprint-inject.js` is the canonical helper. If any fail, flag to Joshua before injecting.

### (b) Check current sessions

`curl -s http://127.0.0.1:3000/api/sessions | jq` — Joshua is opening 4 fresh sessions. Sort by `meta.createdAt`; the four newest are T1 (Frontmatter parser) / T2 (Boot-prompt templates) / T3 (Inject mixed-agent) / T4 (Status merger) in creation order.

### (c) Wait for Joshua to signal "go, inject" (via Telegram or keyboard)

When signaled, fire:

```bash
SPRINT47_SESSION_IDS=<uuid1>,<uuid2>,<uuid3>,<uuid4> \
  node /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/scripts/inject-sprint47.js
```

The script implements the **mandatory two-stage submit** (paste then 400ms settle then `\r` alone). NEVER append `\r` to the bracketed-paste payload in the same POST. If any panel is stuck after 8s verify, the script auto-fires `/poke cr-flood` recovery.

### (d) After inject succeeds, reply to Joshua

Confirm the four session IDs and their initial status (all should be `thinking` "Claude is reasoning..." or `active` "Using tools" within 8s).

### (e) During sprint execution, run THREE side-tasks in parallel (orchestrator-only, NOT in any lane)

1. **Pick up Sprint 46 deferrals opportunistically.** From `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md` § Sprint 47 deferrals, pick the 3-5 smallest. Recommended targets (each ≤30 LOC):
   - **Cosmetic title gaps on `btn-status` / `btn-config`** in `packages/client/public/index.html`. Add `title="..."` attributes.
   - **Regex-escape defensive helper** for `^${binary}\b` in `packages/client/public/launcher-resolver.js`. Add a `regexEscape(str)` helper; use it when building the binary regex.
   - **`escapeHtml` deduplication** in `packages/client/public/app.js` (identical bodies at :2693 and :4296). Move to a shared helper.
   - **`stripAnsi` extension for Claude TUI spinner glyphs** in `packages/server/src/transcripts.js`. Add a regex pass for `\r✻\r\n` patterns.
   - **T2 audit-write-gap cleanup** in `app.js:562` (`triggerProactiveMemoryQuery`). Either delete the dead client-side path OR wire it to call `recordFlashback` so the funnel stays accurate when `aiQueryAvailable=true`. The DELETE option is easier; the WIRE option is the architecturally-correct fix.
2. **Mixed-agent smoke test.** After T1+T2+T3 close, fire ONE non-Claude lane in a side-panel (open a fresh Codex panel, send it a synthetic boot prompt via the new infrastructure, observe whether it posts a FINDING via the merger). Document outcome in STATUS.md.
3. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh** at sprint close. Pin to v0.16.0 (or v1.0.0). Update only if any user-visible UX shifts from the lane work.

### (f) Stay in orchestrator mode until all four lanes report DONE in STATUS.md

Then run close-out:

1. **v1.0.0 decision.** Evaluate: does multi-agent + cron + observability + audited-dashboard + mixed-4+1 infrastructure read as production-ready for outside users? If yes, target v1.0.0; if no, target v0.16.0. Document the decision in CHANGELOG.
2. **Bump versions** (root package.json: 0.15.0 → 0.16.0 or 1.0.0; stack-installer: 0.4.10 → 0.4.11 audit-trail).
3. **Update CHANGELOG.md** with the chosen version.
4. **Update STATUS.md** sprint-close summary.
5. **Run `npm run sync-rumen-functions`** (RELEASE.md step 1).
6. **Run full test suite.** Expect 806+ root tests / 0 fail / 3 skipped (existing baseline) plus ~50 new from T1-T4 + any orchestrator side-task tests. Target ~860 total / 0 fail.
7. **`npm pack --dry-run`** to verify both tarballs.
8. **Commit** with HEREDOC commit message following Sprint 45 / 46 patterns.
9. **Push** to origin/main.
10. **DO NOT publish to npm.** Hand publish commands to Joshua per RELEASE.md (Passkey via `--auth-type=web`).
11. **Draft session-end email** to `admin@nashvillechopin.org` with htmlBody per the global mandate. Subject: `TermDeck Wrap — Sprint 47 mixed 4+1 infrastructure — YYYY-MM-DD HH:MM ET` (use actual local time from `date`).

### (g) If Joshua chooses v1.0.0, also do this

- Update `package.json` keywords / description to reflect production status.
- Add a `## [1.0.0] - 2026-XX-XX` heading in CHANGELOG with a migration-and-readiness note.
- Update `docs/INSTALL-FOR-COLLABORATORS.md` audience line from "experienced engineers" to "anyone running the stack."
- Consider a fresh blog post at `docs-site/src/content/docs/blog/v1.0-RELEASE.mdx` (RELEASE.md says optional; for v1.0 it's worth doing).

## Reference: where things live

- **Orchestrator session** runs the `claude-tg` Telegram-listening process if the MCP is up. Joshua's Telegram chat ID is in `~/.cache/claude-tg/access.json`.
- **Lane briefs:** `docs/sprint-47-mixed-4plus1/T{1,2,3,4}-*.md`.
- **Inject script:** `docs/sprint-47-mixed-4plus1/scripts/inject-sprint47.js`.
- **STATUS.md:** `docs/sprint-47-mixed-4plus1/STATUS.md`.
- **AUDIT-FINDINGS.md (Sprint 46 deferrals):** `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md`.
- **Two-stage submit reference:** `~/.claude/CLAUDE.md` § "MANDATORY: 4+1 sprint orchestration — always inject, never copy-paste".

## Final note from the previous orchestrator

Sprint 46 closed clean — 5 silent-regression bugs caught + fixed in ~16 minutes wall-clock. The dashboard is in known-clean state for outside users. Sprint 47's job is to ship the rails for mixed 4+1; Sprint 48 (or whenever Joshua next runs a sprint) actually dogfoods them. After Sprint 47, Joshua's expected to pivot away from TermDeck for some weeks toward TheHarness / BHHT / other queue items.

If the v1.0.0 decision is YES, frame it accordingly: this is the inflection from "Joshua's daily-driver tool" to "production-ready for outside users." Brad-tier feedback should drive whether the answer is yes today or wait-one-more-sprint.

Good luck. — Previous orchestrator (Sprint 46 close, 2026-05-01 ~15:42 ET).
