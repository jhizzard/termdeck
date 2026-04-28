# Restart Prompt — TermDeck — 2026-04-28 (overnight orchestrator)

This document is the canonical hand-off for the next Claude Code session that will fire the Sprint 39 inject and orchestrate close-out overnight while Joshua sleeps. Joshua will paste the prompt block at the bottom of this file into a fresh Claude Code session that he will remote-control from his phone.

## Live state at hand-off (2026-04-27 ~20:15 ET)

### What just shipped today

- **`@jhizzard/termdeck@0.10.0`** (commit `b7353cc`, on github.com/jhizzard/termdeck) — Sprint 38 close.
- **`@jhizzard/mnestra@0.3.0`** (commit `52492c1`, on github.com/jhizzard/mnestra) — three new graph MCP tools + `memory_recall_graph`.
- **`@jhizzard/termdeck-stack@0.4.2`** — audit-trail patch bump.
- **Rumen graph-inference Edge Function** (commit `0a211d8`, on github.com/jhizzard/rumen) — `npm:postgres@3.4.4` swap from `npm:pg` (BOOT_ERROR fix). Function deployed to project `luvvbrpaopnblvxdxwzb`.
- **petvetbid Supabase migrations 009 + 010 + rumen 003** — applied. 778 edges preserved.
- **`graph_inference_service_role_key`** vault entry provisioned (cloned from `rumen_service_role_key`).
- **graph-inference-tick pg_cron** — UNSCHEDULED (manually disabled because the pairwise self-join times out on a 5,500-row corpus before the 150s Edge Function wall-clock; the SQL needs a LATERAL+HNSW rewrite — task #19).
- **Sprint 37/38 lane briefs + STATUS.md DONE entries** — at `docs/sprint-37-orchestrator-product/` and `docs/sprint-38-knowledge-graph/`.
- **Sprint 39 plan committed + pushed** (commit `61ef529`) — at `docs/sprint-39-flashback-resurrection/`.
- **Tour update** in `packages/client/public/app.js` — 16 steps now (was 13), covers v0.10.0 surface (sidebar Guide, sprint runner, knowledge graph, orchestration preview).
- **Bundled session-end hook (Sprint 38 P0)** — Mnestra-direct rewrite committed (`fb794df`) and shipped as part of `@jhizzard/termdeck-stack@0.4.2`. Closes Brad's empty-pgvector ingestion gap.

### What's open / NOT done yet

- **Server restart pending.** TermDeck server was DOWN at hand-off time (port 3000 unreachable). Joshua restarts via `./scripts/start.sh` or `npx @jhizzard/termdeck@0.10.0` BEFORE opening 4 fresh terminals for Sprint 39 inject. Until restarted, the new `/graph.html`, `/api/graph/*`, `/api/sprints*`, orchestration-preview, and `/docs/orchestrator-guide.md` routes are not surfaced in the browser.
- **graph-inference cron is DISABLED.** Until the LATERAL+HNSW SQL rewrite lands (task #19), the cron stays off to avoid wasted Edge Function invocations + database CPU. Edge Function code itself is deployed and idle (no cost).
- **Brad's WhatsApp** — deep link opened in Joshua's WhatsApp Desktop client. He'll press Send when ready. Message body in `/tmp/brad-whatsapp.sh`.
- **Email draft `r8645951193209057667`** — saved in Joshua's Gmail at `admin@nashvillechopin.org`. Subject: `TermDeck Wrap — Sprints 37+38 shipped (orchestrator-as-product + knowledge graph) — 2026-04-27 19:32 ET`. Should be updated with this restart-prompt's path.

### Sprint 39 — Flashback Resurrection 2.0 — ready to fire

Joshua flashback-blind in daily flow ~9 days (since Sprint 21 close 2026-04-18). Sprint 21 + Sprint 33 fix attempts both passed isolated e2e tests but missed the production-flow regression. Sprint 39 is **diagnostic-first**.

**Lanes:**

| Lane | Goal |
|---|---|
| **T1 — Daily-flow Flashback instrumentation** | Add structured logging at six decision points (PATTERNS.error match, onErrorDetected entry/exit with rate-limit state, bridge query/result, proactive_memory emit) into an in-memory ring buffer. NEW `GET /api/flashback/diag` endpoint. |
| **T2 — zsh/bash rcfile-noise filter audit** | Empirically test the strong hypothesis that PATTERNS.error matches rcfile noise burning the 30s rate limiter. Capture fixture corpus, tighten regex with regression tests. |
| **T3 — Project-tag write-path verification + chopin-nashville backfill** | Audit project-tag write paths AND ship `011_project_tag_backfill.sql` re-tagging the chopin-nashville tag's 1,090 mis-tagged rows. The chopin-nashville tag is **96% polluted** (only 49 of 1,139 are legitimate; 272 termdeck, 60 rumen, 48 podium, 7 PVB, 2 dor are mis-tagged). Lane writes SQL with `RAISE NOTICE` count probes; orchestrator applies at sprint close. |
| **T4 — Production-flow e2e test** | NEW `tests/flashback-production-flow.test.js` spawning real `/bin/zsh -i` with rcfile loading. Test fails on git stash baseline, passes after T2/T3 land. |

**Lane briefs at:** `docs/sprint-39-flashback-resurrection/T1-flashback-instrumentation.md` through `T4-production-flow-e2e.md`. STATUS.md template ready.

### Critical pre-sprint context

- **Live `petvetbid` substrate:** 5,530 memory_items, 778 memory_relationships edges. Mnestra ingestion +21 during Sprint 38 (5,455 → 5,476 → 5,530 by hand-off). Rumen `rumen-tick` cron green (every 15 min, last 5 runs all succeeded).
- **Project-tag distribution at hand-off** (full breakdown, run via `psql $DATABASE_URL -c "SELECT project, count(*) FROM memory_items GROUP BY project ORDER BY count(*) DESC"`):

  | project | count |
  |---|---|
  | pvb | 1,602 |
  | chopin-nashville | 1,139 |
  | chopin-scheduler | 996 |
  | gorgias | 468 |
  | termdeck | 457 |
  | global | 397 |
  | gorgias-ticket-monitor | 207 |
  | imessage-reader | 114 |
  | podium | 65 |
  | antigravity | 30 |
  | rumen | 16 |
  | claimguard | 15 |
  | (12 more under 10 rows each) | |

- **Pre-existing failing tests** (carry-over from prior sprints, NOT introduced by Sprint 38):
  - `tests/flashback-e2e.test.js: project-bound flashback…` — the P0 regression Sprint 39 is fixing.
  - 3 in `packages/server/tests/session.test.js` (stripAnsi CSI + two PATTERNS.error cases) — likely the same root cause as T2's hypothesis.
  - 1 in `tests/migration-loader-precedence.test.js` — assertion count, T1+T3 of Sprint 38 already addressed but may need re-check after migration 011 lands.

### Sprint 39 inject mechanism

**Two-stage submit pattern is MANDATORY** (per `~/.claude/CLAUDE.md` § 4+1 inject mandate). The inject script for Sprint 39 should be `/tmp/inject-sprint39-prompts.js`, mirroring the Sprint 37 + Sprint 38 inject scripts that worked. Pattern:

1. `GET /api/sessions` — fetch session IDs sorted by `meta.createdAt`. Map T1/T2/T3/T4 in creation order.
2. **Stage 1:** for each lane, POST `\x1b[200~<prompt>\x1b[201~` (paste-only, no submit) to `/api/sessions/:id/input` with 250ms gaps between sessions.
3. **Settle 400ms.**
4. **Stage 2:** for each lane, POST `\r` alone to `/api/sessions/:id/input` with 250ms gaps. This is the submit keystroke.
5. After 8 seconds, `GET /api/sessions/:id/buffer` for each panel; verify `status: 'thinking'` or `status: 'active'+'Using tools'`. If any panel shows `status: 'active'` with empty `inputBufferLength`, fire `/poke` with `methods: ['cr-flood']`.

**Single-stage `<text>\x1b[201~\r` injection is BANNED.** It causes stuck-paste-no-submit panels.

### Restart-prompt-doc cross-references

- **This file:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-04-28.md`
- **Prior restart prompt (today's afternoon):** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-04-27.md` — Sprint 35 close + Sprint 37/38 vision (now both shipped).
- **Older:** `RESTART-PROMPT-2026-04-26.md`, `RESTART-PROMPT-2026-04-19.md`, `RESTART-PROMPT-2026-04-18.md`.
- **Project router:** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md`.
- **Global rules:** `/Users/joshuaizzard/.claude/CLAUDE.md` — read it carefully for the two-stage submit pattern, never-copy-paste-messages, and session-end email mandate.

### Joshua-the-user context

- **Time zone:** US Eastern. Run `date` before any time-indicative phrasing.
- **Substrate:** petvetbid Supabase Pro tier $25/mo. Sprint 38 added zero recurring cost. Don't use scary "tens of millions of operations" framing without immediately quantifying as CPU-cycles vs dollars (memory entry recorded).
- **He'll be asleep.** No copy-paste prompts. No "should I..." questions for routine decisions. Apply enforcement-level fixes when failures converge (memory entries `feedback_orchestrator_discipline.md` + `feedback_orchestrator_enforcement.md`). Mid-sprint nudge T1/T2/T3/T4 if any panel goes stale 7+ minutes between turns. Auto-poke any panel that drops to `status: 'active'` with no input-box text after the inject.
- **Brad communicates via WhatsApp** at `+15127508576`. Don't use iMessage tools for him.

### Switching projects context

Joshua is switching to a different project before bed. Future Joshua sessions on the OTHER project (likely PVB or chopin-scheduler) should:

1. Run `memory_recall(project="<that project>", query="<topic>")` first.
2. The chopin-nashville tag is JUNK at the moment (96% polluted) — until T3's backfill runs at Sprint 39 close, expect cross-project memory leakage when filtering on chopin-nashville. After T3 close-out, chopin-nashville will have ~49 legitimately tagged rows and the rest re-tagged correctly.
3. The other-project session won't see TermDeck context unless it explicitly queries `memory_recall(project="termdeck", ...)`. The default per-project filter is correct for in-project work.

## Sprint 39 inject sequence — paste-ready

When Joshua signals "terminals open, inject" — or, if he's already asleep and 4 sessions exist that look fresh (< 30 seconds old, no PATTERNS.error matches yet, `inputBufferLength=0`) — the orchestrator should:

1. Run `date` to time-stamp the inject.
2. `GET /api/sessions` → identify the 4 fresh sessions sorted by `meta.createdAt`.
3. Build the inject script with all 4 prompts inlined (visible in transcript per sandbox preference).
4. Fire stage 1 (paste-only, 250ms gaps).
5. Settle 400ms.
6. Fire stage 2 (`\r` only, 250ms gaps).
7. Wait 8s; verify status across all four panels via `/api/sessions/:id/buffer`. Auto-poke if needed.
8. Mark inject complete; report status.

## Lane prompt content

Each lane gets a prompt of the shape:

```
You are T<n> in Sprint 39 (Flashback Resurrection 2.0). Boot sequence:
1. memory_recall(project="termdeck", query="<topic-specific>")
2. memory_recall(query="<broader>")
3. Read ~/.claude/CLAUDE.md and ./CLAUDE.md
4. Read docs/sprint-39-flashback-resurrection/PLANNING.md
5. Read docs/sprint-39-flashback-resurrection/STATUS.md
6. Read docs/sprint-39-flashback-resurrection/T<n>-<lane>.md (your full briefing)

Pre-sprint intel: Sprints 37 + 38 just shipped (v0.9.0 + v0.10.0 + mnestra@0.3.0 + termdeck-stack@0.4.2). Live state: 5,530 memory_items, 778 memory_relationships edges (rag-system-classifier-populated). chopin-nashville tag is 96% polluted (1,090 of 1,139 rows are mis-tagged). graph-inference cron disabled until LATERAL+HNSW SQL rewrite. Joshua flashback-blind ~9 days; this sprint is diagnostic-first, do NOT trust the existing synthetic e2e (it passes while production is silent).

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md under ## T<n>. Don't bump versions, don't touch CHANGELOG, don't commit.
```

Topics by lane:

- **T1:** "Flashback instrumentation diag log six decision points ring buffer PATTERNS.error onErrorDetected proactive_memory" / "structured logging observability /api/flashback/diag endpoint"
- **T2:** "zsh bash rcfile noise PATTERNS.error rate limit 30s false positive fixture corpus" / "regex tightening session.js error matcher rcfile startup"
- **T3:** "project-tag write path verification chopin-nashville backfill 96% pollution mis-tagged migration 011" / "memory_items legacy mnestra_* tables bridge filter session.meta.project"
- **T4:** "production-flow e2e test real zsh subprocess rcfile loading proactive_memory frame assertion" / "tests/flashback-production-flow.test.js fixture seed-memories cat error trigger"

## Close-out responsibilities (when all four lanes report DONE)

1. **Run full test suite:** `node --test 'tests/*.test.js'` — verify no regressions. Expect all of Sprint 38's pre-existing tests to remain passing; the 4 carry-over failures (3 analyzer-pattern + 1 flashback-e2e) should be reduced or eliminated.
2. **Apply migration 011** (T3's backfill) to live `petvetbid`. Use `psql "$DATABASE_URL" -f packages/server/src/setup/mnestra-migrations/011_project_tag_backfill.sql` after sourcing `~/.termdeck/secrets.env`. Inspect RAISE NOTICE counts; expected outcome: `chopin-nashville` count drops from 1,139 → ~750 (the 701 "other/uncertain" rows stay).
3. **Bump versions:**
   - Root `package.json`: `0.10.0 → 0.10.1` (patch — bug fix only).
   - `packages/stack-installer/package.json`: `0.4.2 → 0.4.3` (audit-trail patch).
   - `~/Documents/Graciella/engram/package.json`: NO bump (T1-T4 don't touch Mnestra unless audit surfaces a write-path bug there).
4. **Write CHANGELOG entry** for `[0.10.1]` describing the four lane deliverables.
5. **Commit + push** TermDeck repo. **DO NOT publish** — Joshua handles npm publishes himself in the morning. Leave a note for him in the morning's session that the publish is pending.
6. **Draft session-end email** at `admin@nashvillechopin.org` per `~/.claude/CLAUDE.md` mandate. Subject: `TermDeck Wrap — Sprint 39 (Flashback resurrection) shipped overnight — YYYY-MM-DD HH:MM ET`. HTML body required (not plain-text). Cover: what shipped, what's planned next (Sprint 40+ candidates), restart-prompt path, paste-ready prompt for the next session.

## Things to NOT do overnight

- Do NOT publish to npm. Joshua publishes via Passkey-not-OTP himself.
- Do NOT push if the test suite has new failures. Hold the commit; document in the morning's wrap.
- Do NOT enable the graph-inference cron. It stays disabled until task #19 lands.
- Do NOT modify `~/.termdeck/secrets.env` or the running TermDeck config.
- Do NOT spawn additional terminals for diagnosis — Joshua's 4 lane panels are the only inject targets.

## Paste-ready prompt block for the overnight orchestrator session

```
You are the overnight orchestrator for TermDeck Sprint 39 (Flashback Resurrection 2.0). Joshua started 4 fresh Claude Code panels in TermDeck and is going to sleep. He will remote-control this session from his phone.

Boot sequence:
1. Run `date` to time-stamp.
2. memory_recall(project="termdeck", query="Sprint 39 flashback resurrection diagnostic-first instrumentation rcfile noise project-tag backfill")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-04-28.md (your authoritative briefing for this session — covers live state, lane topics, inject sequence, close-out responsibilities, things-to-NOT-do)
7. Read docs/sprint-39-flashback-resurrection/PLANNING.md and the four T1-T4 lane briefs.
8. memory_recall(project="termdeck", query="flashback regression timeline Sprint 21 33 production-flow daily-flow toast silence")

Then begin: confirm 4 fresh sessions exist via GET /api/sessions sorted by meta.createdAt. If they look fresh (< 60s old, no PATTERNS.error matches yet, inputBufferLength=0 across all four), fire the Sprint 39 inject using the two-stage submit pattern documented in RESTART-PROMPT-2026-04-28.md "Sprint 39 inject sequence — paste-ready" section. Stay in orchestrator mode until all four lanes report DONE in STATUS.md, then run close-out per the same doc's "Close-out responsibilities" section.

When close-out completes: draft the mandatory session-end email per ~/.claude/CLAUDE.md. Do NOT publish to npm. Do NOT push if tests have new failures. Do NOT enable the graph-inference cron.
```

## Final checklist for Joshua before bed

- [ ] Server restarted (`./scripts/start.sh` or `npx @jhizzard/termdeck@0.10.0`)
- [ ] 4 fresh Claude Code panels open in TermDeck (any project, lanes self-navigate)
- [ ] WhatsApp message to Brad sent (or queued in Desktop)
- [ ] New Claude Code session opened with the paste-ready prompt block above
- [ ] Phone within reach if mid-sprint blocker requires Joshua's confirmation (rare; orchestrator is authorized to handle most things autonomously)
