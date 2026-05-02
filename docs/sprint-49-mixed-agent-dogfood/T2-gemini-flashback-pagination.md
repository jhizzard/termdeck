# Sprint 49 — T2 (Gemini): Flashback history pagination

**Lane scope:** Sprint 46 deferral. The flashback history panel is fine at the current ~33 rows but matters at multi-week scale (hundreds of rows). Add pagination so the panel paginates cleanly past 50 rows. Default page size 25; show pagination controls only when the row count exceeds the page size.

**Agent: Gemini.** This is a UI-with-careful-prose lane — Gemini's strengths (clear empty states, accessible controls, sensible defaults).

## Files

- EDIT `packages/client/public/app.js` — flashback history rendering section. Find the function that renders the flashback list (search for `flashback` or the table-row rendering logic). Add a `currentPage` state (module-scope or panel-scope as the existing pattern dictates), render only the current page slice, add prev/next buttons when total > pageSize.
- EDIT `packages/client/public/styles.css` (or wherever flashback styles live) — pagination control styling. Match the existing dashboard button + disabled-state styling.
- NEW `tests/flashback-pagination.test.js` if there's an existing flashback test pattern to extend; otherwise inline assertions in the existing `tests/flashback-*.test.js` family.

## Acceptance criteria

1. With ≤25 rows, no pagination controls visible — current behavior preserved.
2. With >25 rows, controls appear: "Page X of Y" + prev/next buttons. Disabled state on the boundary pages.
3. Page transitions don't refetch from the server — pagination is client-side over the already-loaded row set.
4. URL or panel state survives a page transition (clicking next/prev doesn't reset filters or scroll position).
5. No new dependencies; vanilla JS only.

## Open design questions (resolve in your FINDING post)

- Page size: default 25? 50? Match whatever the dashboard already uses elsewhere if there's a precedent; otherwise propose 25 in your FIX-PROPOSED.
- Should the page state survive a panel reload? Probably yes for the current session; localStorage is fine. Decide based on what's natural to users.
- What about filter changes (search, project, date range)? Page should reset to 1 — flag in your FIX-PROPOSED.

## Coordination

- Independent of T1/T3/T4. Different file regions, different concerns. T1 is also touching `app.js` but in a different section (the `escapeHtml` utilities at the top); merge conflicts unlikely.
- Watch T1's STATUS posts. If T1 ships and your branch needs a rebase, the change is small enough to handle inline.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 49 flashback history pagination dashboard panel UI Gemini")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md (Sprint 47 deferrals section, T2 bullet for the original audit framing)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
