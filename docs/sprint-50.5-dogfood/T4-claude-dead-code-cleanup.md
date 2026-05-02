---
sprint: 50.5
lane: T4
agent: claude
---

# Sprint 50.5 — T4 (claude): Dead `triggerProactiveMemoryQuery` cleanup

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § T4):** delete the dead `triggerProactiveMemoryQuery` path in `packages/client/public/app.js` (function defined at `:569`, sole call site at `:2610`). Sprint 46 T2 audit verdict: this client-side path is gated off when `aiQueryAvailable=false` (the default config) and returns early at `:565`. Server-side flashback path is the only producer of toasts in production and always inserts into `flashback_events` before WS-emit, so the funnel stays accurate without this code. Removing it reduces the audit-write-gap surface area to zero.

## Files

- EDIT `packages/client/public/app.js`:
  - Delete the function `triggerProactiveMemoryQuery(id)` at `:569` (and its body — about 30-40 LOC including any helper-only state tied to it).
  - Delete the call site at `:2610` (and any guard around it that becomes dead post-removal).
  - Verify no other call site references `triggerProactiveMemoryQuery` (`grep -n triggerProactiveMemoryQuery packages/client/public/app.js` should return zero hits after the edit).
- Search for any test or doc reference to `triggerProactiveMemoryQuery`. If present, remove or update.

## Acceptance criteria

1. `grep -rn "triggerProactiveMemoryQuery" packages/ tests/ docs/` returns zero hits after edit.
2. No regression: `node --test tests/launcher-resolver.test.js tests/escapehtml-client.test.js` (or the relevant client-side tests) stay green.
3. `node --check packages/client/public/app.js` parses clean (no syntax errors from incomplete delete).
4. Manual smoke: `npm run dev` (or equivalent) loads the dashboard; clicking around triggers no `triggerProactiveMemoryQuery is not defined` console errors.
5. No changes outside `packages/client/public/app.js` (and any test/doc files explicitly referencing the symbol).

## Worktree path

`.worktrees/sprint-50.5-T4/` (orchestrator creates with `git worktree add .worktrees/sprint-50.5-T4 main`).

## Boot

1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 46 T2 flashback audit triggerProactiveMemoryQuery audit-write-gap dead code")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md and /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read PLANNING.md and this brief.
6. Read `packages/client/public/app.js` lines 560-610 (function body) AND lines 2600-2620 (call site).
7. Read `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md` § "Audit-write gap verdict" for the verdict justifying this deletion.

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `docs/sprint-50.5-dogfood/STATUS.md` (append-only with timestamps). **Do not bump versions, do not touch CHANGELOG, do not commit.** Orchestrator handles close-out + worktree merge + v1.0.0 publish decision.
