---
sprint: 50.5
lane: T2
agent: gemini
---

# Sprint 50.5 — T2 (gemini): `approvalModel` adapter contract field (docs only)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § T2):** add `approvalModel: 'auto' | 'per-step'` as the 11th adapter contract field in `docs/AGENT-RUNTIMES.md` § 5. The field documents the Sprint 49 finding that Gemini's CLI requires explicit user approval for nearly every step, while Claude (auto mode), Codex, and Grok execute reasonable next steps autonomously. **This is docs-only** — no code, no tests. The smallest of the four Sprint 50.5 lanes by design (Gemini's approval-heavy lifecycle per `~/.claude/projects/.../memory/feedback_gemini_approval_heavy.md` means right-sizing the budget).

## Files

- EDIT `docs/AGENT-RUNTIMES.md` § 5 (the adapter contract section) — add the 11th field documentation row with:
  - Field name: `approvalModel`
  - Type: `'auto' | 'per-step'`
  - Per-adapter values: claude=`auto`, codex=`auto`, gemini=`per-step`, grok=`auto`.
  - Rationale paragraph: future orchestrator logic can right-size lane budgets (1.5-2× wall-clock for `per-step` agents) and flag operators when overnight orchestration includes a `per-step` lane.
  - Reference `~/.claude/projects/.../memory/feedback_gemini_approval_heavy.md` and Sprint 49 STATUS Orchestrator Note ORCH 14:14 ET as the source.

## Out of scope (do not touch)

- Adapter source files (`packages/server/src/agent-adapters/*.js`) — declaring the field in code is a follow-up sprint; this lane is doc-only.
- Tests — no code change means no test change.
- Other doc files. **Stay in `AGENT-RUNTIMES.md` only.**
- Do not grab unprompted Sprint 46 deferrals (Sprint 49 T2 grabbed two — acceptable then, forbidden now).

## Acceptance criteria

1. New row in § 5 contract table with `approvalModel` field, type, per-adapter values.
2. Rationale paragraph references the memory file + Sprint 49 STATUS note.
3. `git diff` shows changes only in `docs/AGENT-RUNTIMES.md`.
4. Use `date '+%Y-%m-%d %H:%M ET'` for STATUS timestamps (Sprint 49 timestamp drift correction).

## Worktree path

`.worktrees/sprint-50.5-T2/` (orchestrator creates with `git worktree add .worktrees/sprint-50.5-T2 main`).

## Boot

1. Run `date '+%Y-%m-%d %H:%M ET'` to time-stamp.
2. memory_recall (Mnestra MCP if wired) OR read `MEMORY.md` index for Sprint 49 Gemini-approval findings.
3. Read GEMINI.md (Gemini CLI's instructional file equivalent).
4. Read PLANNING.md and this brief.
5. Read `docs/AGENT-RUNTIMES.md` § 5 to understand the existing 10-field contract.
6. Read `~/.claude/projects/.../memory/feedback_gemini_approval_heavy.md` if accessible (otherwise skip).

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `docs/sprint-50.5-dogfood/STATUS.md` (append-only). **Do not bump versions, do not touch CHANGELOG, do not commit, do not edit any file other than `docs/AGENT-RUNTIMES.md`.** Orchestrator handles close-out.
