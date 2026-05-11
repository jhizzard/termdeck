# 🚨 CRITICAL — READ BEFORE ANY OTHER TASK — 2026-05-07

This file was written at the close of the 2026-05-07 session by Joshua's explicit
request. Two open investigations BLOCK normal work until resolved. They are not
bugs in the conventional sense — they are **silent data-loss vectors** that
compound across every sprint and every long session.

Both are P0. Both apply to TermDeck specifically AND to Joshua's broader workflow
across non-TermDeck terminals.

If you are reading this file as part of session boot-up, do NOT skip to other
work. Confirm in your first user-facing message that you have read this file,
state which of the two investigations you are taking on first, and proceed.

---

## Investigation 1 — Cross-agent Mnestra capture on close

**Question.** When a non-Claude terminal panel (Codex, Gemini, Grok) is closed —
either inside TermDeck (any tab/panel running one of those CLIs) or as a
standalone shell process running outside TermDeck — does the agent's session
content get committed to Mnestra?

**Suspected answer.** No, or at best partial. None of those CLIs natively know
that Mnestra exists, and TermDeck's panel-close handlers (last audit) did not
sweep adapter buffers into Mnestra on exit. This needs to be confirmed by code
review, not assumption.

**Why this matters.** If the answer is "no" or "partial," we are losing
enormous amounts of high-signal context every time a non-Claude panel closes:

- **Codex auditor findings during 3+1+1 sprints.** The auditor is structurally
  Codex per the global 3+1+1 mandate. The auditor's adversarial reasoning IS
  the value of the pattern; losing it post-close is catastrophic — every
  sprint's audit trail evaporates the moment Joshua closes that pane.
- **Gemini and Grok worker output** when used as sprint workers (Sprint 49
  pattern, pre-3+1+1).
- **Every standalone Codex / Gemini / Grok shell** Joshua runs outside
  TermDeck — the multi-week trail of side-investigations, one-off audits,
  consultations, etc.

The compound effect across months is enormous. We need a definitive answer
within the first hour of the next session, and a fix queued behind that answer
if it confirms the gap.

### What needs to happen

1. **Audit the close-out path for each non-Claude CLI inside TermDeck.**
   - Files of interest: `server/index.js` (panel exit handlers), the per-CLI
     adapter wrappers under `server/adapters/`, and any rolling-buffer logic
     used by the metadata overlay.
   - Specifically: when a panel running `codex` / `gemini` / `grok` exits
     (clean exit, killed, browser tab closed), is there ANY code path that
     calls `mcp__mnestra__memory_remember` or POSTs to Mnestra's REST surface
     with the buffer contents? Grep liberally; don't trust assumptions.

2. **Audit the close-out path for each non-Claude CLI outside TermDeck.**
   - These CLIs don't ship with Mnestra hooks. Confirm by reading their config
     surfaces; document the gap.
   - Standalone shell hooks are the only viable capture point — propose a
     wrapper script or shell `EXIT` trap that drains the most recent transcript
     into Mnestra.

3. **If any path is missing capture, design and ship a hook.**
   - TermDeck-side: panel-close handler that drains the rolling buffer +
     adapter session metadata into one or more `memory_remember` calls.
     Categorize by adapter (`codex-audit`, `gemini-worker`, `grok-worker`,
     etc.) so future recall can filter.
   - Standalone-shell-side: a thin wrapper or skill that wraps the CLI and
     captures stdout on close. (Lower priority than the TermDeck-side fix
     because TermDeck use is the dominant path during sprints.)

4. **Acceptance test.**
   - Open a Codex panel inside TermDeck, run a non-trivial conversation that
     names a concrete invented phrase (e.g. "audit-canary-2026-05-07-blue").
   - Close the panel.
   - In a new Claude session, call `mcp__mnestra__memory_recall(query="audit
     canary 2026-05-07 blue")`. The phrase MUST come back. If it doesn't, the
     hook is broken and ship is blocked.

---

## Investigation 2 — Auto-commit on context compaction (applies to me too)

**Rule.** Every agent — Claude (me), Codex, Gemini, Grok — MUST commit
memories to Mnestra automatically when nearing context compaction. Manual
reliance is unacceptable; it leaks state on every long session.

**Current state.** The global `~/.claude/CLAUDE.md` says:

> **Before Context Gets Long** — Call `memory_remember` with key findings as
> a safety net before context compaction might lose important details.

That sentence is advisory. It is not enforced. Across long sprints we have
proved that advisory rules of this shape are violated routinely.

### For Claude (me)

I have the surface to do this:

- The auto-memory system (`~/.claude/projects/<encoded>/memory/`) — pure
  filesystem writes, no MCP dependency.
- The `mcp__mnestra__memory_remember` tool — durable cross-project memory.

What I lack is a deterministic compaction-near signal. The harness compacts
when context approaches the cap; by the time that happens it's too late to
checkpoint. Options to investigate:

- Does Claude Code expose a pre-compaction hook (settings.json `hooks` block)
  that fires before the compaction event? If yes, wire it to a
  `memory_summarize_session` + `memory_remember` sweep.
- If no harness hook exists, fall back to a token-count proxy: at every Nth
  tool call (or every M minutes of wall-clock), spend a turn writing a
  compact session-state memory. This is wasteful but bounded.
- Promote the global CLAUDE.md "safety net" rule from advisory to enforcement:
  every long session ends with a state dump regardless of compaction.

### For Codex / Gemini / Grok

They don't natively know about Mnestra, so checkpointing must be external:

- TermDeck-side periodic capture: every N minutes of active output from a
  non-Claude panel, dump the rolling buffer to Mnestra under a session-tagged
  key. This complements Investigation 1's close-out capture — close-out
  handles clean exits, periodic capture handles compaction-mid-session.
- Codex specifically compacts during long sprints (documented in global
  CLAUDE.md, Sprints 51.6 + 51.7). The CHECKPOINT discipline rule covers
  STATUS.md but NOT Mnestra. We need both — STATUS.md for in-sprint recovery,
  Mnestra for cross-session recovery.

### What needs to happen

1. Define a compaction-near signal for Claude (harness hook if available,
   token-count proxy if not).
2. Design the sweep-to-Mnestra routine that runs on the signal: what gets
   captured, in what shape, with what categorization.
3. Codify in BOTH `~/.claude/CLAUDE.md` (so it applies across every project)
   AND the project `CLAUDE.md` (so it's enforced in TermDeck specifically).
   Promote from advisory to enforcement.
4. For non-Claude panels in TermDeck, build the periodic capture loop
   (server-side, fires on a timer per active panel).
5. **Acceptance test.** A long Sprint-style session that crosses a
   compaction boundary loses zero substantive findings — verified by
   recalling pre-compaction content via `memory_recall` after compaction.

---

## Why this file exists

Both gaps were identified at the END of session 2026-05-07. There was not
time within that session to ship the fixes. Joshua asked for a note loud
enough that the next session cannot ignore it.

Treat this file as a P0 work-item that supersedes whatever else is on the
backlog. The cost of skipping it is silent and accumulating.

When you've shipped the fixes (or established that no fix is needed for one
of the two), update this file with a `## Resolution` section and the date.
Don't delete it — the next future session may want to read why we treated
this as P0.

---

## Resolution — Investigation 1 — 2026-05-08

**Investigation 1 closed by Sprint 62 (`docs/sprint-62-mnestra-session-end-coverage/`).**

The gap was empirically confirmed by Joshua's parallel ClaimGuard Sprint 8.0
Pipeline Compliance Audit: three TermDeck panels (Codex/Gemini/Grok) `/exit`'d
cleanly at sprint close, zero `session_summary` rows landed in Mnestra.
`mcp__mnestra__memory_status` showed `session_summary=97 / sessions_processed=359
= 27%` coverage — the missing 73% were non-Claude panels.

Sprint 62 was 3+1+1 (T1/T2/T3 Claude + T4 Codex auditor), ~80 min wall-clock
from inject (20:34 ET) to FINAL-VERDICT GREEN (21:54 ET). Outcomes:

- **Wire-up was already shipped (Sprint 50 T1)** — `onPanelClose` at
  `packages/server/src/index.js:192-223` registered to `term.onExit` at
  `:1163`, called from `DELETE /api/sessions/:id` at `:1353-1363`, with
  the bundled hook tri-format parsers (Sprint 45 T4 + Sprint 50 T1's
  `parseGrokJson`) and `ALLOWED_SOURCE_AGENTS = {claude,codex,gemini,grok,
  orchestrator}` whitelist already in place. The 27% coverage was driven by
  silent-skip surface in `processStdinPayload` (5 KB `MIN_TRANSCRIPT_BYTES`
  at hook line 795, `<5 messages` threshold at line 576), NOT a wire-up gap.
- **What Sprint 62 added:** production-wiring fence tests in the npm-test
  glob (`packages/server/tests/adapter-session-end-writer.test.js`, 8 tests)
  proving the close path fires for non-Claude adapters end-to-end — boot a
  real Express app with a fake PTY injected via `require.cache`, fire
  `term._emitExit` and `DELETE /api/sessions/:id`, assert the spawn helper
  fires once with the canonical `source_agent`, plus a negative shell-session
  case. T4-CODEX raised the test-coverage gap as a FINAL-VERDICT RED at
  21:03 ET; T1 closed it in re-engage cycle at 21:34 → DONE 21:36; FINAL-
  VERDICT GREEN at 21:54.
- **Two adjacent issues fixed in the same sprint:** project-tag drift
  (claimguard / gorgias / gorgias-ticket-monitor) closed by migration
  `021_project_tag_canonicalize_claimguard.sql` (786-row merge, conservation
  exact); pre-Sprint-50 NULL `source_agent` rows (~98% of corpus) backfilled
  by migration `022_source_agent_backfill.sql` to 4.36% residual NULL
  (deliberately preserved 283-row provenance-uncertain slice; recoverable
  via new `include_null_source` recall flag).

**The 27% coverage metric is expected to recover** once `@jhizzard/termdeck@1.1.1`
+ `@jhizzard/mnestra@0.4.9` ship and a few sessions complete on Joshua's
machine. The 5 KB MIN_TRANSCRIPT_BYTES + <5-messages skip surfaces flagged
by T1's FINDING are NOT in Sprint 62 scope — Sprint 63 candidate.

**Standalone-shell capture** (Codex/Gemini/Grok run outside TermDeck) was
deliberately deferred from Sprint 62 (per its PLANNING.md §6 "Out of scope").
Sprint 63 candidate.

## Resolution — Investigation 2 — STILL OPEN as of 2026-05-08

**Investigation 2 (auto-commit on context compaction-near) remains open.**
Sprint 64 (or 63) candidate. The gap surfaced again during Sprint 62 itself —
T4-CODEX checkpoint discipline mitigated the worst of compaction-near data
loss within the sprint substrate (STATUS.md as durable storage), but the
broader rule from this doc — "every agent MUST auto-commit memories on
compaction-near" — has no enforcement mechanism yet.

Until Sprint 64 ships, the ~/.claude/CLAUDE.md "Before Context Gets Long"
rule remains advisory. Long sessions still leak state on compact.
