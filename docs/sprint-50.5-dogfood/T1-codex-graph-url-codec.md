---
sprint: 50.5
lane: T1
agent: codex
---

# Sprint 50.5 — T1 (codex): URL state codec edge case (graph viewer)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § T1):** small fix in `packages/client/public/graph.js` at the `applyControls` site (~line 178). Sprint 46 T1 audit flagged Surface #5 as sub-optimal: when the URL contains `?project=foo` for a project NOT in `/api/config`'s list, `sel.value = 'foo'` silently fails (option absent), the dropdown reads back blank, but `state.project` retains `'foo'` and subsequent fetches still target the unknown project. Result: stale or empty graph with no diagnostic. Brief calls for graceful fallback + console warning when the param doesn't match.

## Files

- EDIT `packages/client/public/graph.js` (~10-15 LOC) — at the `applyControls` site, validate the requested project against `state.projects` (populated from `/api/config`). If unknown:
  - Log `console.warn` with the unknown name + the available list.
  - Reset `state.project` to the default (first entry in `state.projects` or `'termdeck'`).
  - Re-render with the corrected value so URL/dropdown/state stay in sync.
- EXTEND `tests/graph-viewer-e2e.test.js` — add one test (~20 LOC) that constructs a URL with `?project=does-not-exist`, runs `applyControls(state)`, asserts state.project resets to the default + console.warn fires.

## Acceptance criteria

1. URL `?project=valid-name` still applies `state.project = 'valid-name'` cleanly (no regression).
2. URL `?project=unknown-foo` resets to default + emits one `console.warn`.
3. Test added covering the bad-param path.
4. `node --test tests/graph-viewer-e2e.test.js` green (full file).
5. No changes outside `graph.js` + the e2e test file.

## Worktree path

`.worktrees/sprint-50.5-T1/` (orchestrator creates with `git worktree add .worktrees/sprint-50.5-T1 main`).

## Boot

1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 46 graph viewer URL state codec edge case applyControls deferral")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read AGENTS.md (Codex CLI uses AGENTS.md, not CLAUDE.md).
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/AGENTS.md
6. Read PLANNING.md and this brief.
7. Read packages/client/public/graph.js (focus around `applyControls` near line 178).
8. Read docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md § "URL state codec edge case (Surface 5)".

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `docs/sprint-50.5-dogfood/STATUS.md` (append-only, with `date '+%Y-%m-%d %H:%M ET'` timestamps). Don't bump versions, don't touch CHANGELOG, don't commit. Don't drift outside graph.js + the e2e test file. Orchestrator handles all close-out + worktree merge.
