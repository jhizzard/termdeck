# Sprint 49 — T1 (Codex): `escapeHtml` deduplication in client app.js

**Lane scope:** Sprint 46 audit caught two near-identical `escapeHtml` definitions in `packages/client/public/app.js` (around lines 2693 and 4296). Extract to a single canonical implementation at the top of the file (or in a small `client-utils` helper if scoping suggests it). Replace both call sites with the canonical reference. Confirm both definitions were behaviorally identical (no callers depended on a divergent shape).

**Agent: Codex.** This is a clean, contained refactor — Codex's strengths.

## Files

- EDIT `packages/client/public/app.js` — lift one canonical `escapeHtml` definition near the top of the module (early in the file, before any caller). Delete both duplicates. ~10-LOC net diff.
- IF the file already has a utility section, add it there. Otherwise create a clearly-commented "Utilities" block.
- NO new test file required if existing tests already exercise both call sites; a snapshot/assertion that escaped output remains identical for the most common cases (`<script>`, `&amp;`, `"`, `'`) is sufficient if you can find a target test file. If you can't, a short regression test in `tests/escapehtml-client.test.js` (~30 LOC, ~4 cases) is fine.

## Acceptance criteria

1. Only ONE `escapeHtml` (or equivalent) definition in `app.js`.
2. Both former call sites resolve to the canonical reference (use `grep -n 'escapeHtml' packages/client/public/app.js` to confirm zero duplicates).
3. No behavior change — escaping output identical for `<`, `>`, `&`, `"`, `'`, and the empty string.
4. No regressions to dashboard rendering (eyeball the dashboard at `http://127.0.0.1:3000` if the TermDeck server is running; otherwise rely on tests).
5. No new dependencies; vanilla JS only (project rule from CLAUDE.md).

## Coordination

- Independent of T2/T3/T4. Different file, different concerns.
- The dashboard at `:3000` may be open in another tab while you work. The change is non-breaking; user-facing behavior is byte-identical.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 49 escapeHtml dedup app.js client utility refactor")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/STATUS.md
8. Read this brief
9. grep -n 'escapeHtml' /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/client/public/app.js (locate both definitions and all call sites)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
