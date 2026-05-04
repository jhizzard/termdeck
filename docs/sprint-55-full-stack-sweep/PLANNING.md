# Sprint 55 — Full multi-lane full stack sweep + Sprint 54 synthesis-bug followthrough

**Status:** Authored 2026-05-04 18:49 ET. Stage-set tonight; fires either when Joshua goes to bed (autonomous overnight execution) or when Joshua wakes up (interactive). Same plan, two firing modes.

**Pattern:** 3+1+1 expanded scope — same shape as Sprint 53 (T1/T2/T3 Claude workers + T4 Codex auditor + orchestrator) but covering the FULL TermDeck surface area, not a single bug. Estimated wall-clock: 90-180 min depending on cell density.

**Why this sprint exists.** Joshua's framing at v1.0.7 commit window crystallized the meta-pattern from today's 9-sprint daily-onion cascade — reactive triage where every hotfix exposed the next layer. Sprint 53 was a partial stack sweep (5 cells, install path only). Sprint 55 is the FULL adversarial sweep across every functional surface area:

- Every wizard step (init --mnestra, init --rumen, termdeck-stack)
- Every API endpoint (/api/*)
- Every UI surface (dashboard, panels, settings, graph view, flashback)
- Every Edge Function (rumen-tick, graph-inference)
- Every MCP tool (memory_recall, memory_remember, memory_forget, memory_search, memory_status)
- Every cron schedule
- Every agent adapter (Claude, Codex, Gemini, Grok integrations)

**Goal:** find every silent-failure / share-blind / drift-class bug BEFORE Joshua posts to HN/Twitter. The deliverable is an honest stack sweep report that says either "fully functional, non-erring" (post + market) or "N gaps remaining, here's the priority list" (close them, then post).

This is what Joshua actually asked for at the start of the day. Today's 9 sprints were emergency triage; Sprint 55 is the structural close.

## Scope

### Lane T1 — Install + wizard stack sweep (Claude worker)

Brief: `T1-install-sweep.md`. Covers every wizard step × every starting state combination that surfaced bugs today, plus 10-15 new cells targeting code paths NOT exercised by Sprint 53.

Cells (target ~20):
1. Fresh tmp HOME, no existing config — full `init --mnestra` end-to-end
2. Fresh tmp HOME — `init --rumen` end-to-end (with all required env vars)
3. v1.0.0 first-install state with `Stop`-wired settings.json (Brad's repro shape)
4. Contaminated repo-cwd `<repo>/supabase/functions/` (Sprint 52 ledger #21 bug 3)
5. Stale supabase CLI 2.75 vs current 2.98+ (verify --use-api fix from v1.0.8)
6. macOS + Docker + /var/folders staging (Class O #21 verification)
7. Linux container baseline (no Docker; --use-api should still work)
8. SUPABASE_ACCESS_TOKEN missing (precondition gate fires)
9. OPENAI_API_KEY missing (Rumen falls to keyword-only — does it work end-to-end?)
10. ANTHROPIC_API_KEY missing (Edge Function should fail-soft)
11. GRAPH_LLM_CLASSIFY=1 path (Sprint 51.5 T3 — does graph-inference produce classified edges?)
12. `init --rumen --skip-schedule` (cron schedule path bypassed)
13. `--dry-run` for both wizards (touches nothing; reports the plan)
14. Vault SQL Editor deeplinks fallback (vault.create_secret permission denied)
15. Multi-arg `supabase secrets set` regression check (Class J #14)
16. Re-run idempotency: run init --mnestra twice back-to-back
17. Re-run idempotency: run init --rumen twice back-to-back
18. `termdeck --version` actually prints version (Sprint 53 T1 finding-micro)
19. `termdeck --help` exhibits all subcommands
20. `termdeck doctor` parity with `mnestra doctor` (or absent — flag the gap)

For each cell: command, expected, observed, ledger candidate. Write to `SWEEP-CELLS.md`.

### Lane T2 — API + UI stack sweep (Claude worker)

Brief: `T2-api-ui-sweep.md`. Covers every HTTP endpoint of the TermDeck server + every UI interaction of the dashboard.

API cells (target ~15):
- /api/sessions GET (list)
- /api/sessions POST (create)
- /api/sessions/:id GET
- /api/sessions/:id DELETE
- /api/sessions/:id/input POST (the inject path — verified today, but with malformed payloads?)
- /api/sessions/:id/buffer GET
- /api/sessions/:id/poke POST (cr-flood mode)
- /api/sessions/:id/meta PATCH (whitelist enforcement)
- /api/ai/query POST (mnestra bridge — note the "zero hits" pre-existing flake)
- /api/graph GET (with various query params)
- /api/flashback GET (history)
- /api/flashback POST (manual trigger)
- /api/config GET / PATCH
- /api/health
- Malformed JSON body to each POST endpoint (input validation)

UI cells (target ~10):
- Dashboard renders with 0 panels
- Dashboard renders with 1 / 4 / 16 panels
- Settings dialog — every toggle (rag.enabled, etc.)
- Graph view — controls, layout selector, time-window slider
- Flashback overlay — trigger from panel error
- Panel labels editable (updateMeta)
- Project tag rendered correctly per panel
- Cost monitoring panel (NOT YET SHIPPED — flag absence as Sprint 56)
- Mobile/narrow viewport responsive behavior
- Keyboard shortcuts (if any)

For each cell: same matrix output. Write to `T2-SWEEP-CELLS.md`.

### Lane T3 — Edge Functions + Cron + MCP stack sweep (Claude worker)

Brief: `T3-backend-sweep.md`. **Includes the Sprint 54 synthesis-bug followthrough as Cell #1.**

Cells (target ~20):
1. **Sprint 54 synthesis bug diagnosis.** Pull rumen-tick function logs (upgrade supabase CLI to 2.98+ first), identify why `insights_generated: 0` from `sessions_processed: 4`. Propose fix. Specifically:
   - Is embedding generation succeeding in production?
   - Is memory_hybrid_search returning rows above minSimilarity (0.01)?
   - Is synthesize.ts Anthropic call succeeding or falling to placeholder?
   - Is surface.ts writing insights to memory_items?
2. rumen-tick manual fire — happy path
3. rumen-tick manual fire — empty memory_sessions (0 candidates expected)
4. rumen-tick manual fire — every session has rumen_processed_at set (0 candidates)
5. rumen-tick manual fire — ANTHROPIC_API_KEY missing (placeholder fallback)
6. graph-inference manual fire — happy path
7. graph-inference — GRAPH_LLM_CLASSIFY=0 (every edge defaults to relates_to)
8. graph-inference — GRAPH_LLM_CLASSIFY=1 (Haiku-classified types)
9. memory_hybrid_search via PostgREST/MCP — 8-arg canonical signature
10. memory_hybrid_search via PostgREST — what happens with 10-arg drift call (verify Sprint 51.9 closed it)
11. memory_recall MCP tool — happy path with 8-arg backend
12. memory_remember MCP tool — write a test memory
13. memory_forget MCP tool — soft-delete the test memory
14. memory_search MCP tool — keyword + semantic hybrid
15. memory_status MCP tool — system stats render correctly
16. cron.job table — verify rumen-tick + graph-inference-tick are scheduled
17. cron.job_run_details — verify recent ticks logged
18. mig 018 rumen_processed_at column present + indexed
19. memory_sessions.session_id column present (mig 017)
20. Schema-drift sweep — every overload of every public function (`pg_proc` enumeration); look for stale 10-arg shapes, unused functions, etc.

Write to `T3-SWEEP-CELLS.md`.

### Lane T4 — Codex auditor + Agent integration stack sweep (Codex)

Brief: `T4-codex-auditor.md`. Codex with `auto-review` approval mode preset (today's hardening rule — closes 51.5b approval-mode gap).

**Dual role:** auditor for T1/T2/T3 work AS IT LANDS, plus a small set of agent-integration cells T4 owns directly:

1. SessionEnd hook fires from a Claude Code session — verify memory_sessions row + memory_items session_summary row written
2. SessionEnd hook fires from a Codex CLI session — does it write? (probably NO; Codex doesn't use Claude's hook)
3. SessionEnd hook handles malformed/empty session content gracefully
4. ~/.claude/settings.json wiring stays intact across init --mnestra re-runs
5. ~/.claude.json mcpServers entry preserved across init --rumen
6. Multi-agent adapter registry — verify Claude / Codex / Gemini / Grok adapter exports
7. Cross-agent STATUS.md merger (Sprint 47 T4 — does it still parse all 4 lane shapes uniformly?)
8. Agent costBand declarations — ready for Sprint 56 cost-monitoring panel

Plus T4 audits T1/T2/T3 WIP per the standard 3+1+1 hardening rules:
- CHECKPOINT every 15 min OR phase boundary
- Uniform `### [T4-CODEX]` post shape
- Adversarial review: independent reproduction of every claim, file:line evidence
- AUDIT REOPEN BEFORE FIX-LANDED (not after)

Write to `T4-SWEEP-CELLS.md` for own cells; standard STATUS.md for audit posts.

## Acceptance criteria

1. **All 4 lanes complete their cell matrices.** Output: 4 SWEEP-CELLS.md files + 1 STATUS.md log.
2. **Every novel failure has a ledger candidate.** Class A/B/C/D/.../O continuation.
3. **Sprint 54 synthesis bug is diagnosed.** Whether or not fixed in Sprint 55, the diagnosis (root cause + proposed fix) is on disk by sprint close.
4. **`rumen_insights` count moves past 233 OR a clear blocker is documented.** This is the user-visible end-result test. If the synthesis bug fix lands during Sprint 55, count growth is the verification. If the fix is queued for Sprint 56, the blocker doc lives at `docs/sprint-56-synthesis-fix-followup/PLANNING.md`.
5. **Stack sweep report ready for HN/Twitter posting.** Either:
   - **GREEN POST:** "TermDeck v1.0.X is fully functional, non-erring across N stack sweep cells. We caught Y issues proactively before posting." (HN-shareable evidence.)
   - **YELLOW POST:** "TermDeck v1.0.X is mostly functional with N known gaps documented at <link>. Closing them in Sprint 56." (Honest; acceptable for a soft launch.)
   - **RED POST:** Defer posting; cycle through Sprint 56-58 first. Triggers if more than 5 high-severity bugs surface.

## Firing modes

### Mode A — Autonomous overnight (fire when Joshua goes to bed)

Pre-conditions:
- Both Claude and Codex CLIs preset to permissive approval modes (no human press-enter required)
- All 4 panels boot via TermDeck inject (existing two-stage paste+\r pattern)
- Lanes write to STATUS.md only — NO npm publish, NO git push, NO destructive psql writes overnight
- Joshua wakes up to a STATUS.md mega-report; he + I (next-morning session) ship the fixes interactively

Approval mode setup (in lane briefs):
- **T1/T2/T3 Claude lanes:** boot via `claude --dangerously-skip-permissions` (or whatever the current Claude Code CLI flag is for "auto-approve all tools"). The TermDeck panel command line sets this at panel-spawn time.
- **T4 Codex lane:** lane brief explicitly mandates `auto-review` approval mode set as step 0 BEFORE any tool call (today's hardening rule).
- **No Gemini, no Grok this sprint.** Their CLIs are approval-heavy without good unattended-mode flags. Adding them requires remote-poke infrastructure (TermDeck mobile UI exposing /api/sessions/:id/input — separate Sprint 56+ candidate).

Read-only-only invariant for overnight:
- Lanes MAY: read files, query DB read-only (SELECT, EXPLAIN), curl Edge Functions (POST {} is non-destructive on rumen-tick, just emits a tick — though does mutate rumen_processed_at and rumen_jobs).
- Lanes MAY NOT: npm publish, git push, drop/alter/insert/update/delete on prod DB without user authorization, modify supabase function source.
- This is enforced by lane briefs telling each lane explicitly: "if you find a bug that needs a fix, write a FIX-PROPOSED post and STOP. Orchestrator (Joshua + Claude) ships in the morning."

**Fire mechanism for overnight:** Joshua opens 4 TermDeck panels at bedtime, says "terminals open, inject" or equivalent, the orchestrator fires the inject script (same as Sprint 53), then orchestrator panels go to sleep. Workers run autonomously. By 8am ET tomorrow, STATUS.md should have ~80-120 cell results.

### Mode B — Interactive morning (fire when Joshua wakes up)

Same setup, same lanes, same scope. Difference: orchestrator (me, in a fresh morning Claude Code session) is awake to monitor STATUS.md, narrate findings, and apply fixes in real time. Lane discipline same as Sprint 53 — workers post FIX-PROPOSED, orchestrator commits + ships.

This mode is faster overall (~90 min vs autonomous overnight which takes 6-8 hours of wall clock) and produces more coverage because lanes can iterate on findings in real time.

## Pre-sprint substrate (must verify before fire)

```bash
date '+%Y-%m-%d %H:%M ET'

# All packages live + at expected versions
npm view @jhizzard/termdeck version          # expect 1.0.9
npm view @jhizzard/termdeck-stack version    # expect 0.6.9
npm view @jhizzard/mnestra version           # expect 0.4.3
npm view @jhizzard/rumen version             # expect 0.5.2

# Supabase CLI upgraded to current (lets T3 pull function logs)
supabase --version  # want >= 2.98

# Origin/main HEAD is post-Sprint-54 (commit 37c6bd2 on rumen)
git -C ~/Documents/Graciella/rumen log --oneline -1
git -C ~/Documents/Graciella/engram log --oneline -1
git -C ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck log --oneline -1

# The daily-driver project state
DATABASE_URL=$(grep '^DATABASE_URL=' ~/.termdeck/secrets.env | cut -d= -f2- | tr -d '"' | sed 's/?pgbouncer.*//')
psql "$DATABASE_URL" -c "select count(*), max(created_at) from rumen_insights"
# expect: 233 (current) — Sprint 55's deliverable is to make this number move
```

## The "press enter remotely" question

For Sprint 55 specifically: **NO remote-press-enter needed** because we use only Claude (--dangerously-skip-permissions) + Codex (auto-review). Both have unattended-friendly flags / modes that the lane brief sets at boot.

For future multi-LLM expansion (Gemini + Grok), the engineering ask is:
1. **TermDeck mobile UI panel** showing all active panels with "Inject \r" buttons per panel — Joshua taps to "press enter" remotely on his phone via Tailscale exposure.
2. **Approval-prompt detector** in the panel-status pipeline — recognize when an agent is waiting on a "yes/no" prompt vs. a freeform input box, and surface that with a one-tap approve action.
3. **Pulse-poker daemon** (riskier) that auto-injects \r into any panel idle for >N seconds. Risky because it auto-approves destructive ops too. Would need approval-prompt detection (see #2) to gate which panels get the auto-poke.

Sprint 56+ candidate. Not in Sprint 55 scope.

## Out of scope

- **Cost-monitoring panel** (original Sprint 51 vision) — separate sprint after Sprint 55 closes the synthesis bug + full stack sweep.
- **Migration-authoring linter** (multiple Sprint 51.x sister incidents canonized this pattern) — Sprint 56+ polish.
- **Maestro / chopin-scheduler** — independent of TermDeck; resumes after Joshua's mail merge.
- **Brad outreach** — Brad already has v1.0.9 + v1.0.5+v0.6.8 stack via today's WhatsApp. Don't message Brad again until Sprint 55 results are in. Brad-as-QA stops here per Joshua's explicit framing.

## After Sprint 55 closes

If GREEN: Joshua drafts an HN/Twitter post leveraging the stack sweep report as evidence. TermDeck flips from "active development" to "stable product, weekly bumps, memory-quality innovation focus."

If YELLOW: Sprint 56-N closes the documented gaps in priority order. Each is a single-lane direct mini-sprint (same shape as today's 51.7 / 51.8 / 52.1 / 51.9 / 52 / 52-fold-in / 53 / 54).

If RED: Sprint 55 itself failed acceptance. Investigate what made the full stack sweep insufficient before retrying.

## Lane brief shape (binding for ALL lanes)

Per the 3+1+1 hardening rules canonized 2026-05-04:

1. **Auditor (T4) compaction-checkpoint discipline:** post `### [T4-CODEX] CHECKPOINT 2026-05-04 HH:MM ET — phase X — verified Y / pending Z` at every phase boundary AND at least every 15 min of active work. STATUS.md is the durable substrate; on compact, T4 self-orients by reading its most recent CHECKPOINT.
2. **Uniform post-shape across all lanes:** `### [T<n>] STATUS-VERB 2026-05-04 HH:MM ET — <gist>`. T4 uses `### [T4-CODEX]`. The `### ` prefix is mandatory.
3. **Tolerant idle-poll regex:** `^(### )?\[T<n>\] DONE\b` (matches with or without `### ` prefix).
4. **No version bumps. No CHANGELOG edits. No commits during lane work.** Orchestrator (Joshua + me) ships at sprint close.
5. **Codename scrub rule (today's feedback memory):** never reference "petvetbid" in STATUS.md or any externally-facing surface. Use "the daily-driver project" or elide entirely.

## Companion artifacts

- `T1-install-sweep.md` — full T1 lane brief with cells 1-20 + boot sequence
- `T2-api-ui-sweep.md` — full T2 lane brief
- `T3-backend-sweep.md` — full T3 lane brief (synthesis bug Cell #1!)
- `T4-codex-auditor.md` — Codex auditor brief with auto-review mandate
- `STATUS.md` — append-only log
- `SWEEP-CELLS.md` (4 — one per worker lane) — structured cell results matrix for HN/Twitter post-evidence
