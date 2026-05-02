# Sprint 49 — T3 (Grok): Graph viewer chip filter "all on / all off" preset

**Lane scope:** Sprint 46 deferral (Surface 2). The graph viewer's chip filter (relationship-kind toggles — `causes`, `mentions`, etc.) currently has 5 chips. Users can toggle each individually but there's no quick way to clear all or set all. Add two preset buttons: "All" and "None" (or whatever vocabulary fits the existing UI). Cosmetic but high-value at higher chip counts (the planning notes "low value at 5-kind density" but Joshua can over-rule if it's nice to have).

**Agent: Grok.** This is a fast UI lane — Grok's strengths (responsive iteration, reasonable defaults).

## Files

- EDIT `packages/client/public/app.js` — graph viewer chip filter section. Find the chip rendering logic (search for `chip` or the relationship-kind filter controls). Add two preset buttons just above the chip row.
- EDIT `packages/client/public/styles.css` — preset button styling. Subtle variant of the chip-button look (smaller, secondary tint).
- NEW or EXTEND `tests/graph-chip-presets.test.js` (~40 LOC, ~4 tests) — assert that clicking "All" sets every chip enabled, "None" clears all, individual chip clicks still work after a preset action, preset buttons disabled when all/none is already the state.

## Acceptance criteria

1. Two preset buttons render above the chip row.
2. "All" → every chip becomes enabled; "None" → every chip becomes disabled.
3. Individual chip clicks still toggle independently after a preset action.
4. Preset buttons reflect current state — disabled when "all already enabled" or "none already enabled" (boundary state).
5. Visual style matches the existing chip language; no new colors / fonts / sizing.
6. No new dependencies; vanilla JS only.

## Bonus (only if main scope ships fast)

The PLANNING.md flagged 16-sub-agent observability as a Sprint 49 bonus that fits Grok specifically (since Grok's `task` tool emits `"Delegating to [agent] sub-agent: ..."` and `"[sub-agent complete]"` patterns). UI is a collapsible tree pane in `session.js` analyzer + a side-metadata panel showing color-coded agent pills. Bigger scope (~150 LOC across server + client + CSS); skip unless main scope closes in <12 min and the lane has 8+ minutes of budget.

## Coordination

- Independent of T1/T2/T4. T1 and T2 are also touching `app.js` but in different sections (utility extraction + flashback panel); merge conflicts unlikely.
- The graph viewer is at `http://127.0.0.1:3000/graph` — eyeball your work there as you go.

## Boot

```
1. Run `date`.
2. memory_recall(project="termdeck", query="Sprint 49 graph chip filter relationship kind preset all none Grok dashboard")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/PLANNING.md
7. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-49-mixed-agent-dogfood/STATUS.md
8. Read this brief
9. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md (Surface 2 in the original audit + Sprint 47 deferrals roll-forward)
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md`. Don't bump versions, don't touch CHANGELOG, don't commit.
