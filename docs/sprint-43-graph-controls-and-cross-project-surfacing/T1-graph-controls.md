# Sprint 43 — T1: Graph viewer controls (hide isolated, min-degree, time window, layout)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

The graph viewer at `/graph.html` currently shows ALL nodes — including the 719/1042 isolated ones in the termdeck project (69% with zero edges). Joshua's 2026-04-29 morning screenshot shows a sea of disconnected purple dots with two visible clusters; the visualization is technically correct but not navigationally useful. Add four first-class controls.

## Files
- `packages/client/public/graph.html` — toolbar additions next to existing edge-type filters at `#graphFilters`
- `packages/client/public/graph.js` — filter pure functions, state hooks, URL state propagation, layout switch
- `packages/client/public/style.css` — control styling (mirror `.graph-filters` style for visual continuity)
- NEW `tests/graph-controls.test.js` — pure-function tests for filter logic (hermetic, stubbed node/edge data)

## Controls to add

1. **Hide isolated nodes** (toggle, default OFF) — drops nodes with zero edges from the rendered set. Acceptance: at default density (1042 nodes / 392 edges) toggling reduces visible nodes to ~323 (only the 31% that have at least one edge).
2. **Min-degree filter** (slider, values 1 / 2 / 3+ / 5+) — keeps nodes with at least N edges. Subsumes (1) at min-degree=1; goes further at higher values.
3. **Time window** (select, values "all time" / "last 7 days" / "last 30 days" / "last 90 days") — filters by `memory_items.created_at`. Default "all time" matches current behavior. Recent-window mode is useful for "what have I been working on this week" navigation.
4. **Layout selector** (select, values "force-directed" / "hierarchical" / "radial") — switches D3 layout algorithm. Force-directed is current default. Hierarchical is useful for `supersedes` chains. Radial puts highly-connected hubs in the center.

## URL state

Existing `writeUrlState()` handles `project` + `mode`. Extend to handle the four new controls: `?project=termdeck&hideIsolated=1&minDegree=2&window=30d&layout=hierarchical`. Reload should restore the full state.

## Acceptance criteria
1. At default density, toggling "hide isolated" reduces visible nodes from 1042 → ~323.
2. Min-degree=2 reduces further to ~120 visible nodes.
3. Time-window=last 7 days shows recent-only subset.
4. Layout switcher visibly changes node arrangement (visual smoke test).
5. URL state persists across page reload.
6. Tests pass deterministically with stubbed node/edge data.

## Lane discipline
- Append-only STATUS.md updates with `T1: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T1 owns the graph viewer client-side. Does NOT touch flashback (T2), init-rumen (T3), or Telegram (T4)

## Pre-sprint context

- Sprint 42 close: graph-inference cron added 368 edges (45 cross-project) on first manual tick. Cron is active at `0 3 * * *` UTC.
- Termdeck-project edge breakdown: supersedes 215, relates_to 106, elaborates 61, contradicts 7, caused_by 3.
- 719/1042 termdeck nodes isolated. The cron will close some of this gap over time (cross-project edges are sparse by definition because termdeck-only sessions don't trigger cross-project similarity), but UI controls are the bigger lever.
- Current toolbar already has edge-type filter checkboxes at `#graphFilters` (Sprint 38). T1 adds four more controls in the same toolbar.
