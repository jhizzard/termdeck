# T3 — Investigation 2: auto-commit on context compaction-near

You are T3 in Sprint 64. Your lane **closes the still-open P0 from `docs/CRITICAL-READ-FIRST-2026-05-07.md`**. Every agent — Claude, Codex, Gemini, Grok — must commit memories to Mnestra automatically when nearing context compaction. The global `~/.claude/CLAUDE.md` "Before Context Gets Long" rule is advisory; long sessions still leak state on compact.

## Boot sequence

1. `memory_recall(query="context compaction PreCompact hook memory_summarize_session Claude Code 2.x harness hooks settings.json")`
2. `memory_recall(project="termdeck", query="non-Claude panels periodic capture rolling buffer codex gemini grok session_summary")`
3. `memory_recall(query="recent decisions and bugs 2026-05-11 through 2026-05-14")`
4. Read `~/.claude/CLAUDE.md` IN FULL — § "Before Context Gets Long" is the rule you're promoting from advisory to enforcement
5. Read `./CLAUDE.md` (TermDeck project read-order; P0 banner names this investigation)
6. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` IN FULL — both investigations; Investigation 2 is your scope
7. Read `docs/sprint-62-mnestra-session-end-coverage/PLANNING.md` (sister scope; how Sprint 62 closed Investigation 1)
8. Read `docs/sprint-64-install-polish-and-carveouts/PLANNING.md` § T3
9. Read `docs/sprint-64-install-polish-and-carveouts/STATUS.md`
10. Read this file in full

Then begin.

## The problem

The auto-memory system at `~/.claude/projects/<encoded-cwd>/memory/` is pure filesystem writes. The `mcp__mnestra__memory_remember` tool is durable cross-project memory. **Neither fires automatically when the harness is about to compact context.** When compaction happens, in-context state evaporates; advisory rules of the "remember to checkpoint" shape are violated routinely under long-sprint pressure.

This bites every long session — Sprint 51.6 + 51.7 documented Codex compacting mid-sprint; Sprint 62 + Sprint 63 had Claude lanes survive on STATUS.md as durable substrate but the loose conversational context did get truncated.

## Scope

Five sub-tasks. Sub-task 3.1 is research + decision; 3.2 is design; 3.3 is doc work; 3.4 is code; 3.5 is verification.

### 3.1 — Compaction-near signal for Claude

**Research first.** Determine whether Claude Code 2.x exposes a `PreCompact` hook in the `settings.json` hooks block. Sources of truth:

- `claude --help` — current CLI surface.
- WebFetch on `https://docs.claude.com/en/docs/claude-code/hooks` (or whatever the current canonical URL is).
- `~/.claude/settings.json` — inspect Joshua's existing hooks config for any pre-compaction-shaped entry.
- The `update-config` skill (per system skill listing) covers settings.json — invoke if useful.

Post a FINDING with the result:

- **(A) PreCompact hook exists.** Wire it. Path: `~/.claude/hooks/memory-pre-compact.js` (out-of-repo; bundled version at `packages/stack-installer/assets/hooks/memory-pre-compact.js` so fresh installs get it). Hook reads `STDIN` per existing memory-session-end.js pattern, calls `memory_summarize_session` + `memory_remember`, exits 0.

- **(B) PreCompact hook does NOT exist.** Fall back to a token-count proxy. Two flavor choices to pick from in your FINDING:
  - **B-i** Every Nth tool call (N suggest: 50), spend a turn writing a compact session-state memory. Tracked in-context via a counter.
  - **B-ii** Every M minutes of wall-clock (M suggest: 30), same. Tracked via `Date.now()`.
  - **B-iii** Hybrid: B-i + B-ii whichever fires first.

  None of these are deterministic — they're heuristics. Document the tradeoff in CLAUDE.md.

- **(C) Both hook AND proxy.** Belt-and-suspenders. Hook is primary; proxy is fallback if the hook ever fails to fire (e.g., on crash-near rather than compact-near).

**Recommended at scoping:** lean toward (A) if the hook exists. If not, (C) with hook=null falls back gracefully when Claude Code adds the hook later.

### 3.2 — Sweep-to-Mnestra routine

What gets captured when the signal fires:

- **Decision log:** the last N `memory_remember` calls made this session (deduplicate via Mnestra's existing dedup).
- **Open task state:** if `TaskList` is callable in the hook context, capture pending + in-progress tasks. If not, fall back to the in-context conversation tail.
- **Sprint context:** if the cwd matches an active sprint directory (`docs/sprint-N-*/`), capture the most recent STATUS.md tail.
- **Pending findings:** text Joshua surfaced in the conversation that hasn't been captured as a memory yet. Heuristic: any user message containing "remember" / "note" / "important" / "for next time" that hasn't been mirrored to memory in the last 10 minutes.

Shape of the Mnestra write:
- `source_type: 'code_context'` for sprint-state checkpoints.
- `source_type: 'decision'` for new decisions surfaced mid-session.
- `category: 'workflow'` for state-snapshot; `category: 'debugging'` for finding-capture.
- One per memory item; let Mnestra's dedup handle near-duplicates.

### 3.3 — Codify in CLAUDE.md (global + project)

Promote the rule from advisory to enforcement.

**Global edit at `~/.claude/CLAUDE.md` § Before Context Gets Long:**
- Replace "as a safety net before context compaction might lose important details" with "MANDATORY: when the PreCompact hook fires (or the token-count proxy fires), call `memory_summarize_session` + `memory_remember` for each pending finding."
- Reference the bundled hook + the proxy as the enforcement mechanism.
- Cross-link to `docs/CRITICAL-READ-FIRST-2026-05-07.md` § Resolution — Investigation 2.

**Project edit at TermDeck's `CLAUDE.md`:**
- Add a sub-section under the hard rules: "Auto-commit on compaction-near is enforced via `~/.claude/hooks/memory-pre-compact.js` (Sprint 64). Non-Claude panels (Codex/Gemini/Grok) are covered by TermDeck's server-side periodic capture loop (also Sprint 64)."

### 3.4 — TermDeck-side periodic capture for non-Claude panels

Codex / Gemini / Grok don't natively know about Mnestra and have no PreCompact-equivalent. Build a server-side timer per active non-Claude panel that drains the rolling buffer to Mnestra every N minutes (suggest: 10 min).

**Design:**

- Per-panel timer registered in `packages/server/src/session.js` at panel creation; cleared at panel close.
- Every N minutes, the timer reads the panel's rolling buffer (already maintained by the metadata overlay layer; see `packages/server/src/agent-adapters/{codex,gemini,grok}.js` for buffer-extraction shape).
- Calls `mcp__mnestra__memory_remember` via the same path Sprint 50 T1 wired for `onPanelClose`.
- Tag with `source_type: 'code_context'`, `category: 'workflow'`, and `meta.is_periodic_checkpoint: true` so future filtering can distinguish from close-out captures.

**Cost-aware throttling:**
- Skip the periodic write if the buffer has fewer than 1 KB of new content since the last periodic write. (Mnestra writes have non-zero cost; don't write noise.)
- Skip if the panel's `meta.status === 'exited'` — close-out capture handles that.

**Cross-cutting with carve-out 2.4 (T2 lane):** T2 is adding `adapter.spawn` declarations; if T2 also threads a per-adapter `bufferExtract` declaration through, T3 can use it. Otherwise T3 reads buffers via the existing per-adapter shapes.

**Files of interest:**
- `packages/server/src/session.js` (per-panel timer registration; clear at close)
- `packages/server/src/agent-adapters/{codex,gemini,grok}.js` (buffer-extraction shape; coordinate with T2)
- `packages/server/src/index.js` (timer cleanup at panel destruction)
- `packages/server/tests/periodic-capture.test.js` (NEW)

### 3.5 — Acceptance test

A long synthetic session that crosses a compaction boundary loses zero substantive findings — verified by recalling pre-compaction content via `memory_recall` after compaction.

- **For Claude:** start a long synthetic session (test fixture; uses a small token-count proxy threshold to avoid actually waiting for real compaction). Drop 5 invented canary phrases at known offsets. Trigger the proxy. Verify all 5 phrases land in Mnestra. Trigger Claude Code compaction (or simulate via the proxy). Verify post-compaction `memory_recall` returns all 5 phrases.
- **For non-Claude panels:** spawn a TermDeck codex panel; drop 5 canary phrases over 12 minutes of synthetic activity (with the periodic-capture interval set to 2 min in test mode). Verify all 5 land in Mnestra after the 5th interval. Verify the throttle skips intervals where the buffer didn't grow.

Output artifact: `docs/sprint-64-install-polish-and-carveouts/INVESTIGATION-2-ACCEPTANCE.md` — operator-grade verification doc with the 5 canary phrases used, the timing of each, and the `memory_recall` output (sanitized).

## Files of interest

- `~/.claude/CLAUDE.md` (global rule promotion — out-of-repo edit; orchestrator commits to global)
- `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` (TermDeck mirror)
- `~/.claude/hooks/memory-pre-compact.js` (NEW; out-of-repo) AND `packages/stack-installer/assets/hooks/memory-pre-compact.js` (bundled)
- `packages/server/src/session.js` (per-panel periodic capture timer)
- `packages/server/src/agent-adapters/*.js` (buffer-extraction shapes; coordinate with T2)
- `packages/server/tests/periodic-capture.test.js` (NEW)
- `docs/sprint-64-install-polish-and-carveouts/INVESTIGATION-2-ACCEPTANCE.md` (NEW — your artifact)

## Acceptance criteria

For this lane to close (post `### [T3] DONE`):

- 3.1's research done; FINDING posted with chosen path (A/B/C).
- 3.2's sweep routine designed + implemented per chosen path.
- 3.3's CLAUDE.md edits drafted + posted in FIX-PROPOSED (orchestrator handles the out-of-repo commit to `~/.claude/CLAUDE.md` separately).
- 3.4's periodic capture loop ships with fence tests.
- 3.5's acceptance test runs green; `INVESTIGATION-2-ACCEPTANCE.md` written.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles those at sprint close.

## Post discipline

`### [T3] STATUS-VERB 2026-05-14 HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING (especially after 3.1 research) → FIX-PROPOSED → FIX-LANDED → DONE. Use `### ` prefix on every post. No bare `[T3]` posts.

The 3.1 FINDING is gating — post it BEFORE implementing 3.2. The orchestrator may want to weigh in on hook-vs-proxy before implementation hardens.

## Cross-cutting with T2

T3 and T2 both touch agent-adapter files. Coordinate to avoid merge conflicts: T2 owns the `spawn` declaration field; T3 may extend that file with a `bufferExtract` declaration (or read the existing buffer state without adding a field, your call). Post `### [T3] FINDING ... — cross-cutting with T2: <X>` if you need T2 to land first.
