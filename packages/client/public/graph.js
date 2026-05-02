/* TermDeck — Knowledge Graph view (Sprint 38 T4)
 *
 * D3.js v7 force-directed graph backed by /api/graph/project and
 * /api/graph/memory. Vanilla JS, no bundler — D3 is loaded via CDN <script>
 * tag in graph.html.
 *
 * View modes:
 *   ?project=<name>            — every memory_item in that project + edges
 *                                fully contained in the project's node set
 *   ?memory=<uuid>&depth=<N>   — N-hop neighborhood around a single memory
 *
 * Interactions:
 *   click node    → opens drawer with full content + neighbor list
 *   hover node    → dim non-incident edges + nodes
 *   click edge    → tooltip with kind / weight / inferredBy
 *   edge filter   → checkboxes per relationship_type, fade-out animation
 *   zoom + pan    → d3.zoom on <g class="graph-zoom-root">
 *   search        → input pulses matching node labels/content
 *   focus button  → re-center camera on a node, re-heat the simulation
 *
 * The 8-value relationship vocabulary maps to Tokyo-Night palette so node /
 * edge colors stay coherent with the rest of TermDeck.
 */

(() => {
  'use strict';

  // -------- Constants ------------------------------------------------------

  // Tokyo-Night-friendly hue cycle for project coloring. Hash project name →
  // index. Saturated enough to read on the dark backdrop, muted enough to
  // avoid the pure-red / pure-green pitfalls the lane brief warns about.
  const PROJECT_HUES = [
    '#7aa2f7', // accent blue
    '#bb9af7', // purple
    '#7dcfff', // cyan
    '#9ece6a', // soft green
    '#e0af68', // amber
    '#f7768e', // muted red
    '#73daca', // teal
    '#ff9e64', // coral
    '#c0caf5', // off-white
    '#9d7cd8', // dusty purple
    '#41a6b5', // sea
    '#b4f9f8', // pale cyan
  ];

  const EDGE_COLORS = {
    supersedes:         '#7aa2f7',
    contradicts:        '#f7768e',
    relates_to:         '#6b7089',
    elaborates:         '#9ece6a',
    caused_by:          '#bb9af7',
    blocks:             '#ff9e64',
    inspired_by:        '#73daca',
    cross_project_link: '#e0af68',
  };

  const EDGE_LABELS = {
    supersedes:         'supersedes',
    contradicts:        'contradicts',
    relates_to:         'relates to',
    elaborates:         'elaborates',
    caused_by:          'caused by',
    blocks:             'blocks',
    inspired_by:        'inspired by',
    cross_project_link: 'cross-project',
  };

  const RECENCY_HALF_LIFE_DAYS = 30;
  const NODE_MIN_RADIUS = 5;
  const NODE_MAX_RADIUS = 22;
  const EDGE_BASE_OPACITY = 0.55;
  const EDGE_DIM_OPACITY  = 0.08;
  const NODE_DIM_OPACITY  = 0.18;

  // -------- State ----------------------------------------------------------

  const GC = (typeof window !== 'undefined' && window.GraphControls) || null;

  const state = {
    mode: 'project', // 'project' | 'memory'
    project: null,
    memoryId: null,
    depth: 2,
    nodes: [],          // raw nodes from /api/graph/* — unfiltered
    edges: [],          // raw edges from /api/graph/* — unfiltered
    visibleNodes: [],   // post-filter, what the simulation sees
    visibleEdges: [],
    activeKinds: new Set(Object.keys(EDGE_COLORS)),
    controls: GC ? GC.defaultControls() : { hideIsolated: false, minDegree: 0, window: 'all', layout: 'force' },
    selectedNodeId: null,
    hoverNodeId: null,
    searchTerm: '',
    sim: null,
    width: 0,
    height: 0,
    zoom: null,
    nodeSel: null,
    edgeSel: null,
    labelSel: null,
    config: null,
    projects: [],
  };

  // -------- DOM refs -------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const stage = () => $('graphStage');
  const svg = () => $('graphSvg');
  const root = () => $('graphZoomRoot');

  // -------- Helpers --------------------------------------------------------

  function hashHue(s) {
    if (!s) return PROJECT_HUES[0];
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
    }
    return PROJECT_HUES[h % PROJECT_HUES.length];
  }

  function recencyFactor(ageDays) {
    if (ageDays == null || !Number.isFinite(ageDays)) return 0.6;
    // half-life decay; bounded so freshest never blow past 1.0
    return Math.min(1, Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS) * 0.6 + 0.4);
  }

  function nodeRadius(n) {
    const deg = Math.sqrt((n.degree || 0) + 1);
    const recency = recencyFactor(n.ageDays);
    const r = (NODE_MIN_RADIUS + deg * 3.5) * recency;
    return Math.max(NODE_MIN_RADIUS, Math.min(NODE_MAX_RADIUS, r));
  }

  function nodeColor(n) {
    return hashHue(n.project || 'global');
  }

  function edgeColor(e) {
    return EDGE_COLORS[e.kind] || '#6b7089';
  }

  function edgeStroke(e) {
    // weight ?? 0.5 → 1–4px
    const w = typeof e.weight === 'number' ? e.weight : 0.5;
    return 1 + Math.max(0, Math.min(1, w)) * 3;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
      if (days < 1) return 'today';
      if (days < 2) return 'yesterday';
      if (days < 30) return `${days}d ago`;
      const months = Math.floor(days / 30);
      if (months < 12) return `${months}mo ago`;
      return d.toISOString().slice(0, 10);
    } catch {
      return iso;
    }
  }

  function readUrlState() {
    const qs = new URLSearchParams(window.location.search);
    const project = qs.get('project');
    const memory = qs.get('memory');
    const depth = parseInt(qs.get('depth'), 10);
    if (memory) {
      state.mode = 'memory';
      state.memoryId = memory;
      state.depth = Number.isFinite(depth) ? Math.max(1, Math.min(4, depth)) : 2;
    } else if (project) {
      state.mode = 'project';
      state.project = project;
    }
    if (GC) state.controls = GC.decodeControls(qs);
  }

  function writeUrlState() {
    const qs = new URLSearchParams();
    if (state.mode === 'memory' && state.memoryId) {
      qs.set('memory', state.memoryId);
      if (state.depth !== 2) qs.set('depth', String(state.depth));
    } else if (state.project) {
      qs.set('project', state.project);
    }
    if (GC) GC.encodeControls(qs, state.controls);
    const url = qs.toString() ? `?${qs.toString()}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }

  // -------- Stateful UI reset (Sprint 41 T3) ------------------------------

  // Clear the SVG render and tear down the running simulation. Called at the
  // start of every fetchGraph so a re-fetch from a different mode/project
  // can't paint over a stale render.
  function clearGraphSvg() {
    if (state.sim) {
      state.sim.stop();
      state.sim = null;
    }
    const r = root();
    if (r) {
      while (r.firstChild) r.removeChild(r.firstChild);
    }
    state.nodeSel = null;
    state.edgeSel = null;
    state.labelSel = null;
  }

  // Ephemeral toast in the top-right of the graph stage. Used to surface
  // truncation warnings on the All Projects view. Auto-dismisses; calling
  // again before dismissal replaces the message and resets the timer.
  function showToast(msg, durationMs = 6000) {
    const stageEl = stage();
    if (!stageEl) return;
    let el = document.getElementById('graphToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'graphToast';
      el.className = 'graph-toast';
      stageEl.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    // Force a reflow so the .show transition fires when toggling rapid-fire.
    void el.offsetWidth;
    el.classList.add('show');
    if (showToast._timer) clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.classList.remove('show');
      // Hide after the transition completes so it can't catch clicks.
      setTimeout(() => { el.hidden = true; }, 220);
    }, durationMs);
  }

  // -------- API ------------------------------------------------------------

  async function api(path) {
    const res = await fetch(path, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
    return res.json();
  }

  async function loadConfig() {
    try {
      state.config = await api('/api/config');
      state.projects = Object.keys(state.config.projects || {});
    } catch {
      state.config = null;
      state.projects = [];
    }
  }

  async function fetchGraph() {
    // Sprint 41 T3 — reset all stateful UI before the new fetch starts so a
    // re-fetch from a different mode/project starts from a clean slate. Fixes
    // the three-way race where "Loading graph…" + "No memories yet" + a stale
    // node render all paint over each other after a mode/project switch.
    hideEmpty();
    clearGraphSvg();
    state.rawNodes = [];
    state.rawEdges = [];
    state.nodes = [];
    state.edges = [];
    setLoading('Loading graph…');
    try {
      let data;
      if (state.mode === 'project' && state.project === '__all__') {
        data = await api('/api/graph/all');
        if (data.enabled === false) return showDisabled(data);
        state.rawNodes = data.nodes || [];
        state.rawEdges = data.edges || [];
        if (data.truncated) {
          showToast(
            `Showing ${state.rawNodes.length} most-recent of ${data.totalAvailable} memories — narrow by project to see specific clusters.`,
          );
        }
      } else if (state.mode === 'memory') {
        data = await api(`/api/graph/memory/${encodeURIComponent(state.memoryId)}?depth=${state.depth}`);
        if (data.enabled === false) return showDisabled(data);
        state.rawNodes = data.nodes || [];
        state.rawEdges = data.edges || [];
        // Use the root memory's project as the view's "current project" for
        // the legend / drawer / fallback color when nodes span projects.
        if (data.root && data.root.project) state.project = data.root.project;
      } else {
        const name = state.project || (state.projects[0] || 'termdeck');
        state.project = name;
        data = await api(`/api/graph/project/${encodeURIComponent(name)}`);
        if (data.enabled === false) return showDisabled(data);
        state.rawNodes = data.nodes || [];
        state.rawEdges = data.edges || [];
      }
      writeUrlState();
      hideLoading();
      if (state.rawNodes.length === 0) {
        showEmpty();
        return;
      }
      hideEmpty();
      applyControlsAndRender();
    } catch (err) {
      // Even on error, drop the empty-state overlay so the failure message
      // shows alone instead of stacking on top of "No memories yet".
      hideEmpty();
      setLoading(`Failed: ${err.message}`);
    }
  }

  // Sprint 43 T1 — re-derive state.nodes/state.edges from the raw API result
  // and the four user controls, then drive the existing render pipeline.
  // Called after every fetch and after any control change.
  function applyControlsAndRender() {
    const raw = { nodes: state.rawNodes || [], edges: state.rawEdges || [] };
    let visible;
    if (GC) {
      visible = GC.applyControls(raw.nodes, raw.edges, state.controls);
    } else {
      visible = { nodes: raw.nodes.slice(), edges: raw.edges.slice() };
    }
    state.nodes = visible.nodes;
    state.edges = visible.edges;
    renderFilters();
    renderGraph();
    updateStats();
    updateControlStat(raw.nodes.length, visible.nodes.length);
  }

  function updateControlStat(total, visible) {
    const el = document.getElementById('ctlVisibleStat');
    if (!el) return;
    if (total === visible) {
      el.textContent = '';
    } else {
      el.textContent = `${visible} of ${total} visible`;
    }
  }

  // -------- Render --------------------------------------------------------

  function setLoading(msg) {
    const el = $('graphLoading');
    if (!el) return;
    el.hidden = false;
    $('graphLoadingMsg').textContent = msg;
  }
  function hideLoading() {
    const el = $('graphLoading');
    if (el) el.hidden = true;
  }
  function showEmpty() {
    $('graphEmpty').hidden = false;
    const allBtn = $('graphEmptyAllProjects');
    if (state.mode === 'project' && state.project === '__all__') {
      $('graphEmptyTitle').textContent = 'No memories yet';
      $('graphEmptyBody').innerHTML =
        'No <code>memory_items</code> rows in the database. Run a Claude Code session and the session-end hook will populate Mnestra; edges will be inferred on the next nightly cron.';
      if (allBtn) allBtn.hidden = true;
    } else if (state.mode === 'project') {
      $('graphEmptyTitle').textContent = `No memories tagged "${state.project}"`;
      $('graphEmptyBody').innerHTML =
        'Your <code>memory_items</code> may be mis-tagged under a parent directory. ' +
        'Try the All Projects view, or check the actual distribution with ' +
        '<code>SELECT project, count(*) FROM memory_items GROUP BY project</code>.';
      if (allBtn) allBtn.hidden = false;
    } else {
      $('graphEmptyTitle').textContent = 'No neighbors yet';
      $('graphEmptyBody').textContent =
        'This memory has no edges in memory_relationships. The next graph-inference cron run will infer them if any are warranted.';
      if (allBtn) allBtn.hidden = true;
    }
  }
  function hideEmpty() {
    $('graphEmpty').hidden = true;
    const allBtn = $('graphEmptyAllProjects');
    if (allBtn) allBtn.hidden = true;
  }
  function showDisabled(data) {
    hideLoading();
    $('graphEmpty').hidden = false;
    $('graphEmptyTitle').textContent = 'Graph backend not configured';
    $('graphEmptyBody').innerHTML = 'TermDeck cannot reach the Postgres database (<code>DATABASE_URL</code> is unset, or the pool is failing). The graph view needs the same Mnestra database used by Flashback.';
  }

  function updateStats() {
    $('graphStatNodes').textContent = `${state.nodes.length} nodes`;
    $('graphStatEdges').textContent = `${state.edges.length} edges`;
    if (state.mode === 'memory') {
      $('graphStatProject').textContent = `neighborhood · depth ${state.depth}`;
    } else {
      $('graphStatProject').textContent = state.project || 'project';
    }
  }

  function renderFilters() {
    const present = new Map();
    for (const e of state.edges) {
      present.set(e.kind, (present.get(e.kind) || 0) + 1);
    }
    const wrap = $('graphFilters');
    wrap.innerHTML = '';
    const keys = Object.keys(EDGE_COLORS).filter((k) => present.has(k));
    if (keys.length === 0) {
      wrap.style.display = 'none';
      updatePresetButtons();
      return;
    }
    wrap.style.display = '';
    for (const k of keys) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gf-chip';
      chip.dataset.kind = k;
      chip.style.borderColor = EDGE_COLORS[k];
      chip.innerHTML = `
        <span class="gf-chip-dot" style="background:${EDGE_COLORS[k]}"></span>
        <span class="gf-chip-label">${EDGE_LABELS[k]}</span>
        <span class="gf-chip-count">${present.get(k)}</span>
      `;
      if (state.activeKinds.has(k)) chip.classList.add('active');
      chip.addEventListener('click', () => {
        if (state.activeKinds.has(k)) state.activeKinds.delete(k);
        else state.activeKinds.add(k);
        chip.classList.toggle('active');
        updatePresetButtons();
        applyFilter();
      });
      wrap.appendChild(chip);
    }
    updatePresetButtons();
  }

  function isAllKindsActive() {
    return state.activeKinds.size === Object.keys(EDGE_COLORS).length;
  }

  function isNoKindsActive() {
    return state.activeKinds.size === 0;
  }

  function updatePresetButtons() {
    const allBtn = $('presetAll');
    const noneBtn = $('presetNone');
    if (allBtn) allBtn.disabled = isAllKindsActive();
    if (noneBtn) noneBtn.disabled = isNoKindsActive();
  }

  function applyFilter() {
    if (!state.edgeSel) return;
    state.edgeSel
      .transition()
      .duration(200)
      .attr('stroke-opacity', (e) => state.activeKinds.has(e.kind) ? EDGE_BASE_OPACITY : 0)
      .style('pointer-events', (e) => state.activeKinds.has(e.kind) ? 'all' : 'none');
  }

  function sizeStage() {
    const stageEl = stage();
    state.width = stageEl.clientWidth;
    state.height = stageEl.clientHeight;
    svg().setAttribute('viewBox', `0 0 ${state.width} ${state.height}`);
    svg().setAttribute('width', state.width);
    svg().setAttribute('height', state.height);
  }

  // Sprint 43 T1 — apply layout-specific forces to the simulation.
  //   force        — forceCenter at midpoint (default).
  //   hierarchical — forceY from BFS levels over directional edges (supersedes /
  //                  caused_by / blocks). Roots float top, leaves drift down.
  //   radial       — forceRadial centered at midpoint, radius from inverse
  //                  degree (high degree → near center).
  function applyLayoutForces(sim, nodes, links) {
    const cx = state.width / 2;
    const cy = state.height / 2;
    const layout = (state.controls && state.controls.layout) || 'force';

    sim.force('center', null);
    sim.force('hier-y', null);
    sim.force('hier-x', null);
    sim.force('radial', null);

    if (layout === 'hierarchical' && GC) {
      const levels = GC.computeHierarchyLevels(state.nodes, state.edges);
      let maxLevel = 0;
      for (const v of levels.values()) if (v > maxLevel) maxLevel = v;
      const denom = Math.max(1, maxLevel);
      const top = state.height * 0.10;
      const bottom = state.height * 0.90;
      sim.force('hier-y', window.d3.forceY((d) => {
        const lvl = levels.get(d.id) || 0;
        return top + (lvl / denom) * (bottom - top);
      }).strength(0.65));
      sim.force('hier-x', window.d3.forceX(cx).strength(0.04));
      return;
    }

    if (layout === 'radial' && GC) {
      const deg = GC.computeDegrees(state.nodes, state.edges);
      const rMax = Math.min(state.width, state.height) * 0.42;
      const radiusFn = GC.radialRadiusFn(deg, rMax);
      sim.force('radial', window.d3.forceRadial(radiusFn, cx, cy).strength(0.55));
      return;
    }

    sim.force('center', window.d3.forceCenter(cx, cy));
  }

  function renderGraph() {
    if (!window.d3) {
      setLoading('D3.js failed to load (CDN blocked?)');
      return;
    }
    sizeStage();

    // d3.forceSimulation mutates node/edge objects. We pass in shallow copies
    // keyed by id so we keep the original API payloads pristine for diffing.
    const nodes = state.nodes.map((n) => Object.assign({}, n));
    const links = state.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      weight: e.weight,
      inferredBy: e.inferredBy,
    }));

    if (state.sim) state.sim.stop();

    const sim = window.d3.forceSimulation(nodes)
      .force('link', window.d3.forceLink(links).id((d) => d.id).distance((l) => 60 + (1 - (l.weight ?? 0.5)) * 40))
      .force('charge', window.d3.forceManyBody().strength(-260))
      .force('collide', window.d3.forceCollide().radius((d) => nodeRadius(d) + 4))
      .alphaDecay(0.02);

    applyLayoutForces(sim, nodes, links);

    state.sim = sim;

    const rootSel = window.d3.select(root());
    rootSel.selectAll('*').remove();

    const edgesLayer = rootSel.append('g').attr('class', 'graph-edges');
    const nodesLayer = rootSel.append('g').attr('class', 'graph-nodes');
    const labelsLayer = rootSel.append('g').attr('class', 'graph-labels');

    state.edgeSel = edgesLayer.selectAll('line')
      .data(links, (d) => d.id)
      .join('line')
      .attr('stroke', edgeColor)
      .attr('stroke-width', edgeStroke)
      .attr('stroke-opacity', EDGE_BASE_OPACITY)
      .attr('stroke-linecap', 'round')
      .on('mouseenter', (event, d) => showEdgeTooltip(event, d))
      .on('mouseleave', hideTooltip);

    state.nodeSel = nodesLayer.selectAll('circle')
      .data(nodes, (d) => d.id)
      .join('circle')
      .attr('r', nodeRadius)
      .attr('fill', nodeColor)
      .attr('stroke', '#0a0c12')
      .attr('stroke-width', 1.2)
      .attr('filter', 'url(#nodeGlow)')
      .style('cursor', 'pointer')
      .on('mouseenter', (event, d) => { onNodeHover(d.id); showNodeTooltip(event, d); })
      .on('mouseleave', () => onNodeHover(null))
      .on('click', (event, d) => onNodeClick(d))
      .call(window.d3.drag()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    state.labelSel = labelsLayer.selectAll('text')
      .data(nodes, (d) => d.id)
      .join('text')
      .text((d) => truncate(d.label || '', 30))
      .attr('font-size', 10)
      .attr('font-family', 'var(--tg-mono, monospace)')
      .attr('fill', '#c8ccd8')
      .attr('text-anchor', 'middle')
      .attr('pointer-events', 'none')
      .attr('opacity', 0.7);

    sim.on('tick', () => {
      state.edgeSel
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      state.nodeSel
        .attr('cx', (d) => d.x)
        .attr('cy', (d) => d.y);
      state.labelSel
        .attr('x', (d) => d.x)
        .attr('y', (d) => d.y - nodeRadius(d) - 4);
    });

    // Zoom + pan.
    const zoom = window.d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        rootSel.attr('transform', event.transform);
      });
    state.zoom = zoom;
    window.d3.select(svg()).call(zoom);

    // Initial fit after a short delay (let the simulation settle a bit).
    setTimeout(() => fitToView(), 600);
  }

  function fitToView() {
    if (!state.nodes.length) return;
    const xs = state.nodes.map((n) => n.x).filter((v) => Number.isFinite(v));
    const ys = state.nodes.map((n) => n.y).filter((v) => Number.isFinite(v));
    if (!xs.length || !ys.length) return;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const pad = 0.05;
    const scale = Math.min(state.width / (w * (1 + pad * 2)), state.height / (h * (1 + pad * 2)));
    const k = Math.max(0.2, Math.min(1.5, scale));
    const tx = state.width / 2 - ((minX + maxX) / 2) * k;
    const ty = state.height / 2 - ((minY + maxY) / 2) * k;
    if (state.zoom) {
      window.d3.select(svg()).transition().duration(600)
        .call(state.zoom.transform, window.d3.zoomIdentity.translate(tx, ty).scale(k));
    }
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // -------- Hover / click -------------------------------------------------

  function onNodeHover(id) {
    state.hoverNodeId = id;
    if (!state.nodeSel) return;
    if (id == null) {
      state.nodeSel.attr('opacity', 1);
      state.edgeSel.attr('stroke-opacity', (e) => state.activeKinds.has(e.kind) ? EDGE_BASE_OPACITY : 0);
      state.labelSel.attr('opacity', 0.7);
      hideTooltip();
      return;
    }
    const incident = new Set();
    incident.add(id);
    for (const e of state.edges) {
      if (e.source === id || e.target === id) {
        incident.add(e.source);
        incident.add(e.target);
      }
    }
    state.nodeSel.attr('opacity', (d) => incident.has(d.id) ? 1 : NODE_DIM_OPACITY);
    state.edgeSel.attr('stroke-opacity', (d) => {
      if (!state.activeKinds.has(d.kind)) return 0;
      const sId = typeof d.source === 'object' ? d.source.id : d.source;
      const tId = typeof d.target === 'object' ? d.target.id : d.target;
      return (sId === id || tId === id) ? 0.95 : EDGE_DIM_OPACITY;
    });
    state.labelSel.attr('opacity', (d) => incident.has(d.id) ? 1 : 0.15);
  }

  async function onNodeClick(node) {
    state.selectedNodeId = node.id;
    openDrawer();
    try {
      const data = await api(`/api/graph/memory/${encodeURIComponent(node.id)}?depth=1`);
      renderDrawer(data);
    } catch (err) {
      $('gdContent').textContent = `Failed to load: ${err.message}`;
    }
  }

  function openDrawer() {
    $('graphDrawer').hidden = false;
    $('graphDrawer').classList.add('open');
  }
  function closeDrawer() {
    $('graphDrawer').classList.remove('open');
    setTimeout(() => { $('graphDrawer').hidden = true; }, 220);
    state.selectedNodeId = null;
  }

  function renderDrawer(data) {
    const root = data.root || {};
    $('gdProject').textContent = root.project || 'global';
    $('gdProject').style.color = hashHue(root.project || 'global');
    $('gdSourceType').textContent = root.source_type || 'fact';
    $('gdCreated').textContent = fmtDate(root.createdAt);
    $('gdContent').textContent = root.content || '(no content)';

    const neighbors = (data.nodes || []).filter((n) => n.id !== root.id);
    const list = $('gdNeighbors');
    list.innerHTML = '';
    if (neighbors.length === 0) {
      list.innerHTML = '<div class="gd-empty">No edges from this memory yet. Rumen will infer them on the next nightly run.</div>';
      return;
    }
    for (const n of neighbors) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gd-neighbor';
      const dot = document.createElement('span');
      dot.className = 'gd-neighbor-dot';
      dot.style.background = hashHue(n.project || 'global');
      const label = document.createElement('span');
      label.className = 'gd-neighbor-label';
      label.textContent = n.label || '(no content)';
      const meta = document.createElement('span');
      meta.className = 'gd-neighbor-meta';
      meta.textContent = `${n.project || 'global'} · ${fmtDate(n.createdAt)}`;
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(meta);
      row.addEventListener('click', () => {
        state.mode = 'memory';
        state.memoryId = n.id;
        fetchGraph();
        closeDrawer();
      });
      list.appendChild(row);
    }
  }

  // -------- Tooltip -------------------------------------------------------

  function showEdgeTooltip(event, edge) {
    const tip = $('graphTooltip');
    const meta = [];
    meta.push(`<strong style="color:${edgeColor(edge)}">${EDGE_LABELS[edge.kind] || edge.kind}</strong>`);
    if (typeof edge.weight === 'number') meta.push(`weight ${edge.weight.toFixed(2)}`);
    if (edge.inferredBy) meta.push(`by ${edge.inferredBy}`);
    tip.innerHTML = meta.join(' · ');
    tip.hidden = false;
    moveTooltip(event);
  }

  // Sprint 46 T1 — node hover tooltip. Shows project (color-coded) + a short
  // content snippet so the user can scan the graph without having to open the
  // drawer for every node. Click still opens the full detail drawer.
  function showNodeTooltip(event, node) {
    const tip = $('graphTooltip');
    if (!tip || !node) return;
    const proj = node.project || 'global';
    const text = escapeHtml(truncate(node.label || node.snippet || '(no content)', 80));
    const meta = node.source_type ? `<span style="opacity:0.7">${escapeHtml(node.source_type)}</span>` : '';
    tip.innerHTML = `<strong style="color:${hashHue(proj)}">${escapeHtml(proj)}</strong> ${meta} · ${text}`;
    tip.hidden = false;
    moveTooltip(event);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function moveTooltip(event) {
    const tip = $('graphTooltip');
    if (tip.hidden) return;
    tip.style.left = (event.clientX + 12) + 'px';
    tip.style.top = (event.clientY + 12) + 'px';
  }
  function hideTooltip() {
    const tip = $('graphTooltip');
    if (tip) tip.hidden = true;
  }

  // -------- Search -------------------------------------------------------

  function applySearch(term) {
    state.searchTerm = (term || '').trim().toLowerCase();
    if (!state.nodeSel) return;
    if (!state.searchTerm) {
      state.nodeSel.classed('graph-node-pulse', false);
      return;
    }
    const matches = (n) =>
      (n.label || '').toLowerCase().includes(state.searchTerm)
      || (n.snippet || '').toLowerCase().includes(state.searchTerm)
      || (n.category || '').toLowerCase().includes(state.searchTerm);
    state.nodeSel.classed('graph-node-pulse', (d) => matches(d));
  }

  // -------- Init ---------------------------------------------------------

  async function init() {
    readUrlState();
    await loadConfig();

    // Project picker. The "All projects" option is always present so the user
    // can recover from mis-tagged data (Sprint 41 T3); per-project options are
    // appended after it from /api/config.
    const sel = $('graphProject');
    sel.innerHTML = '';
    sel.disabled = false;
    const allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = 'All projects';
    sel.appendChild(allOpt);
    for (const p of state.projects) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    }
    // Pick state.project, or fall back to the first configured project, or to
    // __all__ when nothing is configured. Memory mode inherits its project
    // from the root node and skips this resolution.
    if (state.mode !== 'memory') {
      if (!state.project) {
        state.project = state.projects.length > 0 ? state.projects[0] : '__all__';
      }
    }
    if (state.project) sel.value = state.project;

    sel.addEventListener('change', () => {
      state.mode = 'project';
      state.project = sel.value;
      state.memoryId = null;
      fetchGraph();
    });

    const emptyAllBtn = $('graphEmptyAllProjects');
    if (emptyAllBtn) {
      emptyAllBtn.addEventListener('click', () => {
        state.mode = 'project';
        state.project = '__all__';
        state.memoryId = null;
        sel.value = '__all__';
        fetchGraph();
      });
    }

    $('graphSearch').addEventListener('input', (e) => applySearch(e.target.value));
    $('graphReheat').addEventListener('click', () => {
      if (state.sim) state.sim.alpha(0.6).restart();
    });
    $('graphFit').addEventListener('click', () => fitToView());

    // Sprint 49 T3 — chip filter presets (All/None). Wire once; renderFilters()
    // keeps their disabled state in sync with activeKinds boundary conditions.
    const presetAll = $('presetAll');
    const presetNone = $('presetNone');
    if (presetAll) {
      presetAll.addEventListener('click', () => {
        state.activeKinds = new Set(Object.keys(EDGE_COLORS));
        renderFilters();
        applyFilter();
      });
    }
    if (presetNone) {
      presetNone.addEventListener('click', () => {
        state.activeKinds = new Set();
        renderFilters();
        applyFilter();
      });
    }

    // Sprint 43 T1 — graph view-controls. Hydrate input values from state, then
    // wire change handlers that mutate state.controls + URL + re-render from
    // the cached raw fetch so toggling is fast (no API round-trip).
    const ctlHide = $('ctlHideIsolated');
    const ctlMin = $('ctlMinDegree');
    const ctlWin = $('ctlWindow');
    const ctlLay = $('ctlLayout');
    if (ctlHide) ctlHide.checked = !!state.controls.hideIsolated;
    if (ctlMin) ctlMin.value = String(state.controls.minDegree || 0);
    if (ctlWin) ctlWin.value = state.controls.window || 'all';
    if (ctlLay) ctlLay.value = state.controls.layout || 'force';

    function onControlChange() {
      state.controls = (GC ? GC.normalizeControls(state.controls) : state.controls);
      writeUrlState();
      if ((state.rawNodes || []).length === 0) return;
      applyControlsAndRender();
    }
    if (ctlHide) ctlHide.addEventListener('change', () => {
      state.controls.hideIsolated = !!ctlHide.checked;
      onControlChange();
    });
    if (ctlMin) ctlMin.addEventListener('change', () => {
      state.controls.minDegree = parseInt(ctlMin.value, 10) || 0;
      onControlChange();
    });
    if (ctlWin) ctlWin.addEventListener('change', () => {
      state.controls.window = ctlWin.value;
      onControlChange();
    });
    if (ctlLay) ctlLay.addEventListener('change', () => {
      state.controls.layout = ctlLay.value;
      onControlChange();
    });

    $('gdClose').addEventListener('click', closeDrawer);
    $('gdExpand').addEventListener('click', () => {
      if (!state.selectedNodeId) return;
      state.mode = 'memory';
      state.memoryId = state.selectedNodeId;
      closeDrawer();
      fetchGraph();
    });
    $('gdCopyId').addEventListener('click', () => {
      if (!state.selectedNodeId) return;
      navigator.clipboard.writeText(state.selectedNodeId).catch(() => {});
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });
    document.addEventListener('mousemove', moveTooltip);

    window.addEventListener('resize', () => {
      sizeStage();
      if (state.sim) {
        // Re-apply layout-specific forces with the new dimensions; this
        // handles all three layouts (force / hierarchical / radial).
        applyLayoutForces(state.sim, null, null);
        state.sim.alpha(0.3).restart();
      }
    });

    fetchGraph();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
