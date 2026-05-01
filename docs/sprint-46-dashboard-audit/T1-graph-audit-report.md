# T1 — Graph viewer audit report

**Audit window:** 2026-05-01 15:22 → 15:40 ET
**Substrate:** `@jhizzard/termdeck@0.14.0` running on `http://127.0.0.1:3000`; petvetbid Mnestra store with 6,120 active memories across 23 projects, 1,506 edges across 5 written kinds (vocabulary supports 8). graph-inference-tick last fired 2026-05-01 03:00 UTC.
**Approach:** static read of `graph.html` / `graph.js` / `graph-controls.js` / `graph-routes.js`, live `curl` probes against the five API endpoints, full-suite test run before and after. (Headless-browser DOM probing was not available in this lane; controls + state machine were verified by tracing the JS state-machine through the source rather than by clicking in a real browser. Joshua to spot-check the two fix-shipped surfaces in a live Chromium.)

## Roll-up

| # | Surface | Verdict | Fix this sprint? |
|---|---------|---------|------------------|
| 1 | Initial load — page renders, nodes appear, edges appear, force layout settles, empty-state correct on zero data | works | — |
| 2 | Toolbar row 1 — edge-type chip filters | works (chips); sub-optimal (no all-on/all-off preset) | defer → Sprint 47 |
| 3 | Toolbar row 2 — hide-isolated / min-degree / time-window / layout selector | works | — |
| 4 | "X of Y visible" pill | works | — |
| 5 | URL state codec round-trip | works (codec); sub-optimal (unknown-project URL leaves dropdown blank) | defer → Sprint 47 |
| 6 | Hover / click on nodes | works (click → drawer); **broken-vs-design** (no hover tooltip) | **fix shipped** |
| 7 | Hover / click on edges | works (hover tooltip); sub-optimal (no click handler) | defer → Sprint 47 |
| 8 | Cross-project edges visually distinct | sub-optimal (renders identically to same-project edges of same kind) | defer → Sprint 47 |
| 9 | Performance at scale (2000 nodes / 802 edges) | sub-optimal (likely visible jitter on settle) | defer → Sprint 47 |
| ✚ | Test coverage gap: HTML↔JS DOM-id wiring contract; live-shape integration; URL codec ↔ applyControls integration | **gap closed** | new `tests/graph-viewer-e2e.test.js` (+11 tests) |
| ⚠️ | Brief naming defect — PLANNING.md / T1 brief cite `/api/graph/nodes` + `/api/graph/edges` as endpoints; those don't exist | doc-only — code is correct | flag for orchestrator to patch in close-out |

**Net code change (graph viewer):** +21 LOC in `packages/client/public/graph.js` (node-hover tooltip + escapeHtml helper), +0 LOC in `graph-controls.js`, +211 LOC new test file. Well under the 150-LOC fix budget.

**Code that was tested but NOT changed:** initial-load empty-state race fix (Sprint 41 T3 still works), Sprint 43 T1 controls (all four wired correctly, all 22 unit tests still green), URL codec (round-trips defaults clean and rejects hostile inputs).

**Initial fix attempt that was reverted:** the audit's first pass flagged `EDGE_COLORS.blocks` / `inspired_by` / `cross_project_link` as dead UI affordances and removed them. On re-check those are the **migration-009 8-type vocabulary**, dormant only because `GRAPH_LLM_CLASSIFY=1` is unset and similarity-only inference produces `relates_to` (with a few legacy supersedes/elaborates/contradicts/caused_by). They're intentional pre-wired affordances that activate the moment the LLM classifier is enabled. The revert was correct. The new e2e test now ASSERTS the migration-009-vocabulary parity so a future "let's clean these up" sweep gets blocked at test time.

## Surface-by-surface

### 1. Initial load

**Verdict:** works.

**What I observed.** `GET /graph.html` returns 200 with the SPA shell. `<script src="graph-controls.js">` is synchronous, `<script src="graph.js" defer>` is deferred — the order is correct (controls module attaches `window.GraphControls` before `graph.js`'s IIFE runs). `init()` calls `readUrlState()` → `loadConfig()` → wires controls + drawer + zoom + resize → `fetchGraph()`. The Sprint 41 T3 race fix (`fetchGraph` resets state + clears SVG + hides empty-state BEFORE awaiting the API) is still in place at lines 263–268. Empty-state messages branch correctly on (`__all__` → "No memories yet"), (per-project → "No memories tagged X" + All Projects button), (memory → "No neighbors yet").

**Reproducer.** `open http://127.0.0.1:3000/graph.html`. Stops at "All projects" by default (per-project picker only contains entries from `/api/config`'s projects list, which is shorter than the 23 projects in `/api/graph/stats.byProject`). Loading message clears once the 670ms /api/graph/all fetch returns; D3 force layout begins settling.

**Fix shipped.** None — surface works.

### 2. Toolbar row 1 — edge-type chip filters

**Verdict:** works individually; sub-optimal — no "all on / all off" preset.

**What I observed.** `renderFilters()` (graph.js:403) builds a chip per edge-kind PRESENT in the current edge set, color-coded from `EDGE_COLORS`. Click toggles `state.activeKinds` membership and runs `applyFilter()` (line 438) which transitions `stroke-opacity` 0 ↔ 0.55 with a 200ms easing. Pointer-events flip in lockstep so a faded edge can't catch hover. Today's data exposes 5 chips (supersedes / contradicts / relates_to / elaborates / caused_by); `blocks` / `inspired_by` / `cross_project_link` chips will appear automatically the moment LLM classification writes those edge types.

**Reproducer.** Open `/graph.html?project=__all__`, click any chip — corresponding edges fade out in 200ms. Click again, fade in. Reload preserves no chip state (chips always start "all on" because `state.activeKinds = new Set(Object.keys(EDGE_COLORS))` and chip state is not part of the URL codec).

**Fix shipped.** None. **Defer:** an "all on / all off" preset button + a per-chip "solo" mode are both ≤30 LOC additions, but with only 5 chips visible on today's data, the value of a preset is low. Sprint 47+ candidate.

### 3. Toolbar row 2 — Sprint 43 T1 controls

**Verdict:** works.

**What I observed.** All four controls (`#ctlHideIsolated`, `#ctlMinDegree`, `#ctlWindow`, `#ctlLayout`) are wired in `init()` at graph.js:826–857. Each fires `onControlChange()` which normalizes via `GraphControls.normalizeControls`, persists to URL via `writeUrlState`, then re-renders from the cached `rawNodes`/`rawEdges` (no API round-trip on toggle — confirmed at line 309 `applyControlsAndRender`). The 22 unit tests in `graph-controls.test.js` cover every filter combination including the realistic-density assertion (1042 nodes / 392 edges → ~323 visible after hide-isolated). `applyLayoutForces` correctly swaps between `forceCenter` (default), `forceY` driven by BFS hierarchy levels (hierarchical), and `forceRadial` driven by inverse degree (radial). Resize handler (line 877) re-applies the active layout's forces with the new dimensions, so reflow works for all three layouts.

**Reproducer.** Tick "hide isolated" — visible count pill shows `X of Y` where Y is `state.rawNodes.length` and X is the post-filter count. Switch layout from `force` to `hierarchical` — D3 selection is recreated from scratch (full `selectAll('*').remove()` + `join`), simulation alpha re-heats, BFS levels assign nodes to vertical bands.

**Fix shipped.** None — surface works.

### 4. "X of Y visible" pill

**Verdict:** works.

**What I observed.** `updateControlStat(total, visible)` at graph.js:337 hides the pill when `total === visible` and shows `${visible} of ${total} visible` otherwise. Wired into every `applyControlsAndRender` call. `total` is the raw API node count (post-truncation if `/api/graph/all` clipped at 2000) — not the database total. That's correct: the pill describes the FILTER's effect, not the corpus's.

**Reproducer.** With "All projects" + min-degree=2: pill shows `(N of 2000 visible)`. Reset to defaults: pill empty.

**Fix shipped.** None.

### 5. URL state codec

**Verdict:** works for controls; sub-optimal for unknown-project edge case.

**What I observed.** `encodeControls` strips defaults so the URL stays clean (only non-default params appear). `decodeControls` rejects bogus values (`window=forever`, `layout=cubist`, `minDegree=-3`, `hideIsolated=lol` all sanitize to defaults — covered by both the unit test at graph-controls.test.js:272 AND the new e2e test). Round-trip is symmetric for all valid inputs. **Sub-optimal:** if the URL contains `?project=foo` for a project not in `/api/config`'s configured-projects list, `init()` at line 798 sets `sel.value = 'foo'` which silently fails (the `<option>` doesn't exist) and reads back as empty. `state.project` retains 'foo' so the fetch still proceeds correctly — the user just sees a blank dropdown.

**Reproducer.** Apply `?project=termdeck&hideIsolated=1&window=30d&layout=hierarchical` in one tab; copy URL; paste in a fresh tab — same view restores. Apply `?project=fakeproject` to an install where 'fakeproject' isn't in `/api/config` — fetch goes through, dropdown shows blank.

**Fix shipped.** None. **Defer:** add a synthetic `<option>` for unknown projects so the dropdown reflects state. ~5 LOC. Low impact.

### 6. Hover / click on nodes

**Verdict:** click works; **hover broken-vs-design — fix shipped.**

**What I observed.** Click handler at graph.js:557 opens the side drawer, fetches `/api/graph/memory/:id?depth=1`, renders root content + neighbor list. Drawer close + escape-key + copy-id + focus-this-node are all wired (line 859–874). **But:** the brief specifies "Hover tooltip shows project + content snippet" — and pre-fix the `mouseenter` on circles only called `onNodeHover(d.id)` which dimmed non-incident nodes/edges. **No tooltip** showed on node hover, only on edge hover. That's a documented gap against design intent.

**Reproducer.** Pre-fix: hover any node — non-incident edges/nodes dim, but no tooltip text appears. Click any node — drawer slides in, content + neighbors render correctly.

**Fix shipped.**

```diff
-      .on('mouseenter', (event, d) => onNodeHover(d.id))
-      .on('mouseleave', () => onNodeHover(null))
+      .on('mouseenter', (event, d) => { onNodeHover(d.id); showNodeTooltip(event, d); })
+      .on('mouseleave', () => onNodeHover(null))
```

Plus a new `showNodeTooltip(event, node)` (graph.js:760) that reuses the existing `#graphTooltip` element. The tooltip body is `<strong>{project}</strong> {source_type} · {label-snippet, 80 chars}`, with the project name colored by the same hash function that colors the node fill, so the tooltip is visually paired with the node it describes. A small `escapeHtml` helper guards against literal `<` / `>` / `&` / `"` in user content (memory snippets can carry HTML-shaped tokens). `mouseleave` already hides the tooltip via `onNodeHover(null) → hideTooltip()`, so cleanup is idempotent.

Net: +21 LOC in graph.js. No graph-controls.js change.

### 7. Hover / click on edges

**Verdict:** hover works; click sub-optimal (not implemented).

**What I observed.** `mouseenter` on edges at line 543 calls `showEdgeTooltip` which renders `<strong>{kind}</strong> · weight {N.NN} · by {inferredBy}`. `mouseleave` hides. The global `mousemove` listener at line 875 keeps the tooltip glued to the cursor. **No click handler on edges.** The brief flags this directly: "click edge → tooltip with kind / weight / inferredBy" appears in the JSDoc at graph.js:14 but no code implements it.

**Reproducer.** Hover any edge — tooltip appears. Click any edge — nothing. The brief itself anticipated this: "this may not be implemented — flag as sub-optimal if the design intent was missing."

**Fix shipped.** None. **Defer:** the design intent is ambiguous (pin the tooltip until next click? open the source memory's drawer? open both endpoints in split view?) and any choice is ≥30 LOC plus a UX call. Sprint 47+ candidate; needs Joshua's input on the desired behavior.

### 8. Cross-project edges

**Verdict:** sub-optimal — no visual distinction.

**What I observed.** Today's 1,506 edges include some that span projects (the graph-inference cron writes them under standard relationship types like `relates_to`, with no `kind=cross_project_link` entries). `edgeColor(e)` in graph.js:141 colors edges purely by `e.kind`. There is no comparison of `e.source.project` vs `e.target.project` at render time, so a cross-project `relates_to` looks identical to a same-project `relates_to`. The DESIGN intent (per memory and per the `cross_project_link` vocabulary entry in migration-009) is that cross-project edges should render distinctly — perhaps with the `cross_project_link` kind assigned by the LLM classifier, OR with a render-time check that overrides the color when endpoints' projects differ.

**Reproducer.** With "All projects" view: scan the rendered edges. Same-project + cross-project edges of the same kind look identical.

**Fix shipped.** None. **Defer:** two paths forward:
(a) Wait for `GRAPH_LLM_CLASSIFY=1` to be enabled — once the classifier writes `cross_project_link` rows, the `EDGE_COLORS.cross_project_link` amber will activate automatically (no client-side code change needed).
(b) Render-time override: in `edgeColor`, if the resolved source/target nodes have different projects, return the cross-project-link amber instead of the kind color. ~5 LOC, but introduces a special case that competes with the LLM-classified kind. Recommend (a).

### 9. Performance at scale

**Verdict:** sub-optimal — likely visible jitter on settle.

**What I observed.** With 2000 nodes + 802 edges + labels, every simulation tick writes ~4800 SVG attributes (`cx`/`cy` on 2000 circles, `x1`/`y1`/`x2`/`y2` on 802 lines, `x`/`y` on 2000 labels). D3's default Barnes-Hut quadtree (`theta=0.9`) keeps charge force at O(n log n) but the per-tick DOM cost dominates at this density. `alphaDecay(0.02)` (slower than the 0.0228 default) means longer settle but more interactive frames during settle. No throttling, no level-of-detail (e.g. dropping labels at high node count), no requestAnimationFrame batching. The 600ms `setTimeout(fitToView, 600)` initial-fit timing is reasonable but arbitrary.

**Reproducer.** Open `/graph.html?project=__all__` — initial load shows all 2000 nodes; settle takes several seconds; drag-pan is jerky during settle.

**Fix shipped.** None. **Defer:** a proper performance pass would profile in Chromium DevTools first. Cheap improvements that might help: (a) `state.labelSel` only rendered for nodes with `radius > 8` (drops ~half the labels), (b) `.attr('cx', ...)` calls batched via `merge`, (c) `alphaMin(0.01)` to stop the simulation sooner. None of these are 1-line fixes — they need a real profiling pass to know if they help. Sprint 47+ candidate.

## New e2e test coverage

Added `tests/graph-viewer-e2e.test.js` (+211 LOC, 11 tests, all pass; full suite went 769 → 806 — net +37 due to T2/T3/T4 lanes also adding tests). Coverage breakdown:

| # | Test | Closes which gap |
|---|------|------------------|
| 1 | every getElementById in graph.js points at an element in graph.html | a future rename of any control element id breaks test, not the page silently |
| 2 | the four Sprint 43 T1 control element ids exist in graph.html | regression guard for control wiring |
| 3 | graph-controls.js loads BEFORE graph.js in graph.html | order matters — `window.GraphControls` must exist when graph.js's IIFE runs |
| 4 | EDGE_COLORS keys match migration-009 8-type vocabulary | a future schema vocabulary bump must touch graph.js too; blocks accidental "dead vocabulary cleanup" PRs (the kind I almost shipped) |
| 5 | EDGE_LABELS keys mirror EDGE_COLORS keys | parity between the two maps |
| 6 | applyControls preserves all fields graph.js downstream renderers consume | a future graph-controls refactor that strips fields breaks test, not the rendered page |
| 7 | hide-isolated drops zero-degree node from live-shape fixture | sanity on the realistic schema |
| 8 | time-window=7d retains recent + cascades old edges out | sanity on cascading filters |
| 9 | decodeControls → applyControls accepts hand-encoded URL cleanly | guarantees `applyControls` won't throw on URL-shaped inputs |
| 10 | hostile URL params sanitize to defaults | belt-and-suspenders on the existing decode unit tests |
| 11 | encode round-trips through applyControls without losing information | round-trip stability under full controls state |

## Sprint 47+ deferred items (T1 lane)

1. **Edge click handler** — design call needed. Pin tooltip? Open drawer? Open both endpoints?
2. **Cross-project edge visual distinction** — wait for `GRAPH_LLM_CLASSIFY=1` to activate the existing amber, OR ship a render-time project-comparison override in `edgeColor`.
3. **Performance pass at 2000+ nodes** — profile in DevTools, then likely some combination of label-LOD, alphaMin tightening, batched attr writes.
4. **All-on / all-off chip preset** — low value while only 5 kinds are present in live data; revisit after LLM classification fills out the other 3.
5. **Unknown-project URL graceful fallback** — synthesize a `<option>` so the dropdown reflects `state.project` even when it's outside the configured set.

## Files touched

- `packages/client/public/graph.js` — +21 LOC (node hover tooltip + `escapeHtml` helper). One initially-attempted change (EDGE_COLORS / EDGE_LABELS trim) was reverted after re-checking that the "dead" entries are migration-009 vocabulary intentionally pre-wired against the 8-type schema.
- `tests/graph-viewer-e2e.test.js` — new file, +211 LOC, 11 tests (HTML↔JS DOM-id wiring, edge-vocabulary parity, live-shape integration, URL-codec ↔ applyControls integration).
- `docs/sprint-46-dashboard-audit/STATUS.md` — append-only T1 entries with timestamps.
- `docs/sprint-46-dashboard-audit/T1-graph-audit-report.md` — this file.

## Sign-off

Live audit: substrate healthy, dashboard works, one design-vs-implementation gap closed (node hover tooltip), four sub-optimal items documented and deferred to Sprint 47, +11 e2e tests added covering previously-untested wiring contracts. No regressions: full suite 806/3-skip/0-fail (was 769/3/0 pre-sprint, the +37 is T1's +11 plus +26 from sibling lanes). Joshua should spot-check the node-hover tooltip in a live Chromium before the orchestrator stamps DONE on the lane.
