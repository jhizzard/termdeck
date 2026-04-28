# Sprint 41 — T3: Graph empty-state UX fix + "All projects" picker

**Lane goal:** Fix the graph view's persistent state-render race that shows "Loading graph…" + "No memories yet" simultaneously over rendered nodes. Add an "All projects" picker option that loads the full graph (with a node cap and toast warning for large corpora) so Joshua can finally see his cross-project knowledge graph as a single connected view.

**Target deliverable:**
1. `fetchGraph` resets state + clears SVG + hides both overlays at the START of every fetch (not just on success).
2. NEW "All projects" option in the project picker dropdown — triggers `/api/graph/all` (NEW endpoint) which returns the full graph capped at `MAX_NODES_GLOBAL = 2000`.
3. UX clarity: when nodes ARE rendered, the "No memories yet" overlay never shows. When the API hangs, the loading spinner shows clean (not overlapping the empty state).

## Why this lane exists

Joshua's screenshot 2026-04-28 shows the bug clearly: the graph view rendered ONE node ("TermDeck production shell spa…") but ALSO shows "Loading graph…" spinner AND "No memories yet" overlay — all three rendered simultaneously. Same bug pattern as 2026-04-27 evening's report. Two failure modes converge:

1. **Mode-switch race:** when fetchGraph switches from `mode='memory'` to `mode='project'` (or vice versa), the previous SVG render isn't cleared and the previous overlay state isn't reset. The new fetch's loading overlay fires while the old empty-state overlay is still visible from the previous query.
2. **Misleading empty-state copy:** "This project has no `memory_items` rows" appears when the API returned 0 nodes — but the fix-tagging issue means many projects look "empty" because their content is mis-tagged under chopin-nashville. The copy should say "No memories tagged with `<project>`. Did you mean a different project?" with a "Try All Projects" button.

## Concrete fixes in `packages/client/public/graph.js`

### Fix 1 — fetchGraph state reset at entry

Current shape:
```js
async function fetchGraph() {
  setLoading('Loading graph…');     // shows loading overlay, but doesn't clear empty
  try {
    const data = await api(...);
    hideLoading();
    if (state.nodes.length === 0) {
      showEmpty();
      return;
    }
    hideEmpty();
    renderGraph();
  } catch (err) {
    setLoading(`Failed: ${err.message}`);
  }
}
```

New shape:
```js
async function fetchGraph() {
  // Reset all stateful UI so a re-fetch from a different mode/project
  // starts from a clean slate.  This is the bug fix for the
  // "Loading + No memories yet + rendered nodes" three-way race.
  hideEmpty();
  clearGraphSvg();           // NEW helper — empties the <g> element holding nodes/edges
  state.nodes = [];
  state.edges = [];
  setLoading('Loading graph…');

  try {
    const data = await api(...);
    state.nodes = data.nodes || [];
    state.edges = data.edges || [];
    hideLoading();
    if (state.nodes.length === 0) {
      showEmpty();
      return;
    }
    hideEmpty();
    renderFilters();
    renderGraph();
    updateStats();
  } catch (err) {
    hideEmpty();              // Even on error, clear empty-state — show ONLY the failed-loading message
    setLoading(`Failed: ${err.message}`);
  }
}

function clearGraphSvg() {
  const stage = document.querySelector('#graphSvg g.graph-content');
  if (stage) stage.innerHTML = '';
}
```

### Fix 2 — "All projects" picker option

`packages/client/public/graph.html` — add to the picker dropdown:
```html
<select id="graphProjectPicker">
  <option value="__all__">All projects</option>
  <!-- existing dynamic project options -->
</select>
```

`packages/client/public/graph.js` — handle the special value:
```js
async function fetchGraph() {
  // ... reset UI ...
  if (state.project === '__all__') {
    data = await api('/api/graph/all');
    if (data.truncated) {
      showToast(`Showing first ${data.nodes.length} of ${data.totalAvailable} nodes — narrow by project to see specific clusters`);
    }
  } else if (state.mode === 'memory') {
    data = await api(`/api/graph/memory/${encodeURIComponent(state.memoryId)}?depth=${state.depth}`);
  } else {
    const name = state.project || (state.projects[0] || 'termdeck');
    state.project = name;
    data = await api(`/api/graph/project/${encodeURIComponent(name)}`);
  }
  // ... rest unchanged ...
}
```

### Fix 3 — empty-state copy improvements

`packages/client/public/graph.html`:
```html
<div class="graph-empty" id="graphEmpty" hidden>
  <h3 id="graphEmptyTitle">No memories yet</h3>
  <p id="graphEmptyBody">…</p>
  <button id="graphEmptyAllProjects" hidden>View All Projects</button>
</div>
```

`graph.js` — when `showEmpty` fires for project mode, surface the All Projects button:
```js
function showEmpty() {
  $('graphEmpty').hidden = false;
  if (state.mode === 'project') {
    $('graphEmptyTitle').textContent = `No memories tagged "${state.project}"`;
    $('graphEmptyBody').innerHTML =
      `Your <code>memory_items</code> may be mis-tagged. Try the All Projects view, or check ` +
      `<code>SELECT project, count(*) FROM memory_items GROUP BY project</code> for the actual distribution.`;
    $('graphEmptyAllProjects').hidden = false;
  } else {
    $('graphEmptyTitle').textContent = 'No neighbors yet';
    $('graphEmptyBody').textContent = 'This memory has no edges in memory_relationships.';
    $('graphEmptyAllProjects').hidden = true;
  }
}
```

## NEW server endpoint `GET /api/graph/all`

`packages/server/src/graph-routes.js` — add a sibling to `/api/graph/project/:name`:

```js
const MAX_NODES_GLOBAL = 2000;

app.get('/api/graph/all', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ enabled: false });
  try {
    const totalRes = await pool.query('SELECT count(*) AS c FROM memory_items');
    const totalAvailable = parseInt(totalRes.rows[0].c, 10);

    // Fetch the most recent MAX_NODES_GLOBAL memories + all edges between them.
    const nodesRes = await pool.query(
      `SELECT id, content, project, source_type, created_at
       FROM memory_items ORDER BY created_at DESC LIMIT $1`,
      [MAX_NODES_GLOBAL]
    );
    const nodes = nodesRes.rows.map(r => mapNodeRow(r));
    const ids = nodes.map(n => n.id);

    const edgesRes = await pool.query(
      `SELECT * FROM memory_relationships WHERE source_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[])`,
      [ids]
    );
    const edges = edgesRes.rows.map(r => mapEdgeRow(r));

    res.json({
      nodes,
      edges,
      totalAvailable,
      truncated: totalAvailable > MAX_NODES_GLOBAL,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

## Coordination notes

- **T1, T2, T4** are all about the data side; T3 is purely UX. No cross-coordination needed beyond T1's taxonomy informing the empty-state copy ("Try the All Projects view").

## Test plan

- Unit: `clearGraphSvg`, `setLoading`, `hideLoading`, `showEmpty`, `hideEmpty` — pin the DOM-mutation contracts.
- Integration: extend `tests/graph-routes.test.js` with a test for `/api/graph/all` — verify shape, MAX_NODES_GLOBAL cap, `truncated` flag.
- Manual reproduction: load `/graph.html?project=termdeck`, switch to `?project=chopin-nashville`, verify previous SVG is cleared. Verify the loading spinner appears alone (not overlapping empty-state). Try the "All projects" option and verify nodes load.

## Out of scope

- Don't redesign the picker UI; keep it the existing `<select>` element with one new option.
- Don't add a global graph "fly-to" interaction (that's a Sprint 42+ polish item).
- Don't modify the force-directed simulation — only the state-management around it.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-41-project-taxonomy/STATUS.md` under `## T3`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
