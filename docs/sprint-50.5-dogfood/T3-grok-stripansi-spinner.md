---
sprint: 50.5
lane: T3
agent: grok
---

# Sprint 50.5 — T3 (grok): TUI spinner spam stripping (`stripAnsi` extension)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § T3):** Sprint 46 T3 audit flagged that stored transcript content includes Claude's TUI spinner spam (`\r✻\r\n…` repeated). The existing `stripAnsi` removes CSI/OSC escape sequences but not the spinner glyphs themselves. Search results highlight noise rows. Fix: extend `stripAnsi` in `packages/server/src/session.js` (line 22) to also strip the `✻` glyph + redundant `\r\n` adjacent to it.

## Files

- EDIT `packages/server/src/session.js` `stripAnsi` function (around line 22) — extend the regex set to also strip:
  - `✱` (heavy asterisk `✻` — Claude's spinner glyph)
  - The `\r\n` immediately preceding/following a stripped `✻` so we don't leave blank lines.
  - Aim ~5-10 LOC including a comment explaining the source (Claude TUI spinner per Sprint 46 T3 audit).
- EXTEND `tests/session.test.js` (or whichever existing test file covers `stripAnsi`) — add one fixture that contains the `\r✻\r\n` sequence and asserts the output strips to clean text.

## Acceptance criteria

1. `stripAnsi("\r✻\r\nHello")` returns `"Hello"` (or equivalent clean output).
2. `stripAnsi("normal text")` is unchanged (no regression on the common path).
3. Existing `stripAnsi` tests stay green (run `node --test tests/session.test.js`).
4. No changes outside `session.js` + `tests/session.test.js`.

## Worktree path

`.worktrees/sprint-50.5-T3/` (orchestrator creates with `git worktree add .worktrees/sprint-50.5-T3 main`).

## Boot

1. Run `date`.
2. memory_recall (filesystem fallback to `MEMORY.md` if MCP not wired): Sprint 46 T3 transcripts audit, TUI spinner stripping deferral.
3. Read AGENTS.md (Grok uses AGENTS.md per Sprint 47).
4. Read PLANNING.md and this brief.
5. Read `packages/server/src/session.js` (focus on `stripAnsi`, line 22).
6. Read `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md` § "Stored content includes Claude TUI spinner spam".
7. Read existing test fixtures in `tests/session.test.js` to model the new fixture.

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `docs/sprint-50.5-dogfood/STATUS.md` (append-only with timestamps). **Do not bump versions, do not touch CHANGELOG, do not commit.** Orchestrator handles close-out + worktree merge.
