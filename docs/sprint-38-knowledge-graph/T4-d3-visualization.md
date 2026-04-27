# Sprint 38 — T4: D3.js v7 force-directed graph visualization

**Lane goal:** Ship a force-directed graph view in the dashboard that's both functionally useful AND marketing-screenshot-worthy. Per-project view (all memories tagged with project + their edges). Per-memory neighborhood view (one node + N-hop expansion). Click node → memory drawer. Click edge → kind + weight. Edge-type filter. Zoom/pan. Color-coded by project. Node size by recency × edge degree. D3 v7 from CDN to preserve zero-build-step.

**Target deliverable:**
1. NEW `packages/client/public/graph.html` (dedicated route) AND a Graph tab in the main dashboard SPA for in-app navigation.
2. NEW `packages/client/public/graph.js` — the D3 force-directed implementation.
3. NEW server endpoints: `GET /api/graph/project/:name`, `GET /api/graph/memory/:id`, `GET /api/graph/stats`.
4. **Marketing gate**: screenshots good enough to ship in a tweet announcing v0.10.0/v1.0.0 without polishing in Figma first.

## Pre-sprint context

- `memory_relationships` has **749 edges already populated** at sprint start (probe: 2026-04-27 17:25 ET). You can ship with real data on day one — no "we need to populate it first" delay. Distribution: supersedes 469, elaborates 167, relates_to 91, contradicts 14, caused_by 8.
- Schema column is `relationship_type` (not `kind`). T1 expands the CHECK to 8 values; your filter UI should support all 8.
- T2's cron may add `weight` per edge starting mid-sprint. Your visualization should handle `weight IS NULL` (use a default opacity/thickness) AND populated `weight` (vary opacity by weight).

## D3.js v7 specifics

CDN load:
```html
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
```

Force simulation:
```js
const sim = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(edges).id(d => d.id).distance(80))
  .force('charge', d3.forceManyBody().strength(-300))
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collide', d3.forceCollide().radius(d => d.size + 4));
```

**SVG vs Canvas decision:** PLANNING.md proposes SVG default. Stick with that — easier interaction binding, accessible by default, fine performance up to ~5k nodes. Revisit if perf hits a wall on actual user data (Joshua's box has 5,455 memory_items but most projects will have 100–1000 each).

## Server endpoints

```js
// packages/server/src/index.js (or NEW packages/server/src/graph-routes.js — preferred for separation)
app.get('/api/graph/project/:name', async (req, res) => {
  const { name } = req.params;
  // Fetch all memory_items for project + all edges where source OR target is in that set
  // Return: { nodes: [{id, label, project, recency, degree}], edges: [{source, target, kind, weight}] }
});

app.get('/api/graph/memory/:id', async (req, res) => {
  const { id } = req.params;
  const depth = parseInt(req.query.depth) || 2;
  // Use T1's expand_memory_neighborhood RPC + JOIN memory_items for content
});

app.get('/api/graph/stats', async (req, res) => {
  // Coordinate with T2 — if T2 ships this, you don't need to. Otherwise:
  // SELECT count(*) AS total_edges, count(DISTINCT project) AS projects FROM ...
});
```

**Coordinate with T2** on `/api/graph/stats` ownership. Whoever lands first owns it; the other lane consumes it.

## Visualization features

| Feature | Implementation note |
|---|---|
| Zoom/pan | `d3.zoom()` on the SVG root; transform a `<g>` group containing nodes+edges. |
| Node size | `Math.sqrt(edge_degree + 1) * recency_factor`. Recency factor: same exp-decay formula as T3's recall (`exp(-age_days / 30)`). |
| Node color | Hash of `project` → HSL palette. ~12 distinct hues, cycle for projects beyond. Tokyo-Night-friendly hues only (avoid pure red/green; use muted tones). |
| Edge color | One per `relationship_type`. supersedes = blue, contradicts = orange/red, relates_to = grey, elaborates = green, caused_by = purple, blocks = dark-orange, inspired_by = teal, cross_project_link = pink. |
| Edge thickness | `weight ?? 0.5` mapped to 1–4px stroke. |
| Edge filter | Toggle row at top with checkboxes per kind. Toggle off → fade edges to 0 opacity over 200ms (animate, not just hide — PLANNING.md acceptance criterion #6). |
| Click node | Open memory drawer (reuse existing `panel-drawer` style; right-side overlay). Show content, project tag, immediate-neighbors preview, edge kinds. |
| Click edge | Tooltip with kind + weight + inferred_by. |
| Hover node | Highlight all incident edges; dim the rest to 0.2 opacity. |
| Search | Top-bar search box; matches node labels; pulses matching nodes. |
| URL state | `?project=<name>` and `?memory=<id>` reflect current view; share-able links. |

## Polish gate (marketing-screenshot-worthy)

- Smooth force simulation (no jitter; `alphaDecay(0.02)` for graceful settle).
- Subtle background gradient (Tokyo-Night midnight blue → near-black radial).
- Edge labels appear on hover only (not always — preserves clarity).
- Node labels truncate to ~30 chars with ellipsis; full label on hover.
- Initial camera frames the full graph with 5% padding; user zoom overrides.
- Empty state for projects with 0 edges: "No connections yet — Rumen will infer them in the next nightly run." (Coordinate with T2's cron schedule.)
- Loading state: skeleton ghost-graph for ~200ms while data loads (skip if data is cached).

## Coordination notes

- **T1** ships `memory_link / memory_unlink / memory_related`. The memory drawer (click-node) can offer inline link/unlink buttons calling these tools — nice-to-have, not required for v0.10.0.
- **T2** populates `weight` and adds `inferred_by` data. Your visualization gracefully handles both populated and null values; nothing blocks on T2 finishing.
- **T3** ships `memory_recall_graph`. Your memory drawer can show "if you queried this memory, you'd also recall..." using T3's RPC. Nice-to-have.

## Test plan

- New `tests/graph-routes.test.js` — mock `pool.query`, verify `/api/graph/project/:name` returns the expected shape with mocked nodes + edges, verify project filter is applied, verify orphan handling.
- Manual: open `/graph?project=termdeck` in a browser. Verify 100+ nodes render, force settles in <2s, edge filter checkboxes work, click-node opens drawer.
- **Marketing gate manual**: take three screenshots (per-project, per-memory neighborhood, edge-filter active). Show to Joshua at sprint close. If the answer is "yes I'd tweet that" — pass. If "needs polish" — file a follow-up sprint item.
- Performance: open `/graph?project=pvb` (982 memories) and confirm initial render < 2s.

## Out of scope

- Realtime collaborative graph editing — PLANNING.md explicit.
- Other visualization modes (matrix, hierarchy, sankey) — PLANNING.md explicit.
- Edges to/from non-`memory_items` rows (e.g., `rumen_insights`) — PLANNING.md open question 5; defer to follow-up sprint unless trivially cheap.
- Mobile-responsive layout — desktop-first for v0.10.0; mobile is a follow-up.
- Don't bump versions, don't touch CHANGELOG, don't commit.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-38-knowledge-graph/STATUS.md` under `## T4`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
