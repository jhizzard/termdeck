# Sprint 46 — T1: Graph viewer audit

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Confirm `/graph.html` works end-to-end against today's data. Open the page, exercise every control, document what works / what's broken / what's sub-optimal, fix anything broken, add e2e tests for any control without coverage. Sprint 38 D3 v7 baseline + Sprint 41 empty-state UX + Sprint 43 T1 controls all in scope.

## Files

- `packages/client/public/graph.html` (page shell, control toolbar)
- `packages/client/public/graph.js` (D3 v7 force layout, node/edge rendering, hover/click handlers, "X of Y visible" pill)
- `packages/client/public/graph-controls.js` (Sprint 43 T1 — degree counting, time window, BFS hierarchy, radial layout, URL state codec)
- `packages/client/public/style.css` (graph-related rules)
- Server endpoints (corrected post-T1 audit): `GET /api/graph/all`, `GET /api/graph/project/:name`, `GET /api/graph/memory/:id`, `GET /api/graph/stats`, `GET /api/graph/stats/inference` (in `packages/server/src/graph-routes.js`). The original brief cited `/api/graph/nodes` + `/api/graph/edges`; those paths do not exist. Code is correct; only the brief was wrong.
- RPC: `POST /api/memory_recall_graph` (Mnestra side, exposed via TermDeck server)
- Existing tests: `tests/graph-controls.test.js`, `graph-routes.test.js`, `graph-inference.test.js`, `memory_recall_graph.test.js`

## Audit framework

For each surface below, classify as **works / broken / sub-optimal**. Capture a one-line verdict + (if broken or sub-optimal) the exact reproducer + the smallest fix that closes it.

### Surfaces under test

1. **Initial load.** Open `http://127.0.0.1:3000/graph.html`. Does the page render? Do nodes appear? Do edges appear? Does the force-directed layout settle (no infinite jitter)? Empty-state message visible if zero data?
2. **Toolbar row 1 — edge-type chip filters** (Sprint 38). Click each chip on/off; do edges of that type appear/disappear? Does the "all on" / "all off" preset work?
3. **Toolbar row 2 — controls** (Sprint 43 T1):
   - **Hide isolated** checkbox: ticking should remove nodes with degree=0; unticking restores them.
   - **Min-degree** numeric input: setting to 2 should hide nodes with degree<2.
   - **Time window** selector (`7d` / `30d` / `90d` / `all`): should filter nodes/edges by their `created_at` against the window.
   - **Layout** selector (`force` / `hierarchical` / `radial`): switching should re-layout without reload.
4. **"X of Y visible" pill.** Lights up only when filters are active; numbers match actual visible-vs-total counts.
5. **URL state codec.** Apply some filters; copy the URL; paste in a new tab — same view should restore. Default values stripped from URL.
6. **Hover / click on nodes.** Hover tooltip shows project + content snippet. Click opens a detail panel or surfaces the memory's full content.
7. **Hover / click on edges.** Tooltip shows edge type + weight + source-target relationship. (Verify expected behavior; this may not be implemented — flag as sub-optimal if the design intent was missing.)
8. **Cross-project edges.** Verify edges that span projects (Sprint 42's 45 cross-project edges + ongoing graph-inference cron output) render distinctly per the design.
9. **Performance at scale.** With 1300+ nodes / 2000+ edges (current petvetbid density), does the layout settle in reasonable time? Is the page interactive while layout is settling?

## Deliverable

NEW `docs/sprint-46-dashboard-audit/T1-graph-audit-report.md` — a structured report with one section per surface above. Each section: **Verdict** (works / broken / sub-optimal), **What I observed**, **Reproducer** (URL + steps), **Fix shipped** (or **Deferred to Sprint 47** with rationale). Plus a roll-up table at top.

## Coordination

- T1 ↔ T2/T3/T4 are independent (different surfaces). No file overlap.
- Existing tests stay green. NEW e2e tests added for any uncovered control. The bar: any "broken" finding gets either a fix-this-sprint commit or a Sprint 47 deferral with explicit rationale.
- Don't bump versions. Don't touch CHANGELOG. Don't commit. Orchestrator handles close-out.

## Boot

```
1. memory_recall(project="termdeck", query="Sprint 38 graph viewer D3 force layout Sprint 43 T1 controls hide isolated min-degree time window layout selector URL codec")
2. memory_recall(query="recent decisions and bugs")
3. Read /Users/joshuaizzard/.claude/CLAUDE.md
4. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/PLANNING.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/STATUS.md
7. Read this brief
8. Open http://127.0.0.1:3000/graph.html in your browser (or via `open` on macOS) and start exercising controls
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md` with timestamps. Detailed walkthrough goes in `T1-graph-audit-report.md`, NOT inline in STATUS.
