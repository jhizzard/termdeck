# RESTART PROMPT — 2026-07-01 evening (rumen hotfix + Brad queue triage + Sprint 80 authored)

State snapshot for the next orchestrator session. Authored autonomously (Josh away, standing execute-everything authorization this session).

## What happened this session (2026-07-01, ~18:30–18:55 ET)

1. **Rumen outage on Brad's Mnestra project FIXED in code, publish pending.** rumen-tick had 504'd at exactly the Supabase 150s edge wall every ~15 min since 06-28 ~17:00 UTC. Root cause: zero bounded I/O in the tick path — node-postgres pool defaults (connect/query = wait forever), Anthropic SDK defaults (10 min + 2 retries), no job-level budget. Fix: rumen `ed5e233` = **v0.6.1** (job budget `RUMEN_TICK_BUDGET_MS` 110s w/ graceful degradation in relate+synthesize, DB 15s connect / 30s query, LLM 30s / maxRetries 1, wrapper 140s watchdog race; 87/87 tests green, pushed to rumen main). termdeck `564e788` = bundled wrapper watchdog (pushed to termdeck main).
2. **⚠ BLOCKED: `@jhizzard/rumen@0.6.1` npm publish needs Josh's Passkey** (`npm whoami` = E401). The rumen-repo wrapper pins `0.6.1` — unresolvable on npm until published. Publish rumen FIRST in the next Passkey session, then termdeck 1.12.0 + stack 1.10.0.
3. **WhatsApp sent to Brad 18:47 ET** (auto-sent, final): fix status + interim instructions (deploy wrapper from rumen main with pin flipped to `0.6.0` for watchdog + real logs today; flip to `0.6.1` + redeploy once published = full fix) + BR-1 confirmation + sprint promise.
4. **All 10 unread Brad emails read + triaged** (June 9 → June 26): BR-1 inject/body-parser root cause (his diagnosis confirmed against our tree — express 5 shipped in v1.11.0, handler at `packages/server/src/index.js:661-680` 400s correctly but agent callers swallow it), BR-2 cascade postmortem (4 orchs at 356K–999K ctx, host crash), FR-1..6, June 9 v1.8.0 cutover questions (STILL unanswered — fold into Sprint 80 close-out Brad email), June 24 orch self-monitor/PreCompact co-design note.
5. **Sprint 80 authored DISPATCH-READY** at `docs/sprint-80-brad-queue/` (PLANNING + T1-T4 briefs + STATUS scaffold). NOT injected — no panels were open. T1 = BR-1 `\xNN` normalization + FR-4 inject-vs-typing queue; T2 = FR-5 ctx counter + FR-6 maxContextK enforcement; T3 = FR-1/2/3 + release staging; T4 = Codex adversarial audit.
6. **Sprint 79 (elevation capture) was NEVER dispatched** — `docs/sprint-79-elevation-capture/DISPATCH-GUIDE.md` still queued, runs AFTER Sprint 80.

## Next actions (ordered)

1. Josh at keyboard → publish `@jhizzard/rumen@0.6.1` (Passkey, from rumen root). Then confirm Brad redeployed + ticks complete (his edge logs / rumen_jobs rows).
2. Open 4 panels at this cwd → dispatch Sprint 80 per `docs/sprint-80-brad-queue/PLANNING.md` §5 (two-stage inject).
3. Sprint 80 close-out: publish termdeck 1.12.0 + stack 1.10.0 (rides `d5436cf` + `564e788`), send Brad the consolidated reply email (queue disposition + June 9 cutover answers).
4. Then Sprint 79.

## Boot sequence for the next session

1. `memory_recall(project="termdeck", query="session 443c5f5e rumen tick 150s Sprint 80 Brad queue")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md`, then `./CLAUDE.md`, then this file
4. Read `docs/sprint-80-brad-queue/PLANNING.md`

---

## PART 2 — Evening update (Sprint 80 RAN and CLOSED GREEN, ~20:40–22:00 ET)

Everything in "Next actions" above HAPPENED: rumen 0.6.1 published (live on npm); Brad WhatsApp'd twice (interim + go); Josh's own rumen-tick redeployed v65 (0.6.1 pin + watchdog, first tick 200 in 2.4s); Sprint 80 dispatched on :3001 → **mid-sprint the deck crashed** (unhandled node-pty 'error' re-throw — root-caused, fixed, audited AS PART of the sprint) → fleet respawned via `claude --resume` on :3002 → **FINAL-VERDICT GREEN** 21:39 ET, 512/512 server suite.

Close-out state: CHANGELOGs written (root 1.12.0 + stack-installer 1.10.0 with version-history pointer), versions bumped, rumen functions synced (watchdog + placeholder verified), BACKLOG/PLANNING-Resolution updated. **PENDING at time of writing: Josh's 2 Passkey publishes (termdeck root, then packages/stack-installer) → THEN ORCH push + tag v1.12.0 (publish-before-push, unconditional) → Brad reply email (skeleton in docs/sprint-80-brad-queue/RELEASE-STAGING.md §5, needs the two-instance answer scoped to port-isolation-only) → deck restart onto fixed tree (lifts the submit:true relay ban).**
