/* TermDeck — Knowledge Graph view-controls (Sprint 43 T1)
 *
 * Pure functions for filtering and laying out the D3 force-directed graph.
 * Extracted from graph.js so the filter logic can be unit-tested under
 * `node --test` without a bundler.
 *
 * Dual-export pattern: in Node, `module.exports` returns the API object; in
 * the browser, the same API attaches to `window.GraphControls`. graph.html
 * loads this file with a plain <script> tag BEFORE graph.js so the IIFE in
 * graph.js can read `window.GraphControls.applyControls(...)`.
 *
 * The four user-visible controls are:
 *   1. hide-isolated  — drop nodes with degree 0
 *   2. min-degree     — keep nodes with degree >= N (N ∈ {0,1,2,3,5})
 *   3. time-window    — keep nodes with createdAt within last N days
 *   4. layout         — 'force' (default) | 'hierarchical' | 'radial'
 *
 * Filter precedence inside applyControls:
 *   time-window ⇒ degree.  Time-window first because dropping nodes by age
 *   also drops their edges, which changes the degree count for the survivors.
 */

(function (root) {
  'use strict';

  const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
  const LAYOUTS = ['force', 'hierarchical', 'radial'];
  const VALID_WINDOWS = ['all', '7d', '30d', '90d'];

  function edgeEndpointId(end) {
    return (end && typeof end === 'object') ? end.id : end;
  }

  function computeDegrees(nodes, edges) {
    const deg = new Map();
    for (const n of nodes) deg.set(n.id, 0);
    for (const e of edges) {
      const sId = edgeEndpointId(e.source);
      const tId = edgeEndpointId(e.target);
      // Only count edges where BOTH endpoints are in the node set; a half-known
      // edge is "broken" and shouldn't bump the survivor's degree.
      if (!deg.has(sId) || !deg.has(tId)) continue;
      deg.set(sId, deg.get(sId) + 1);
      deg.set(tId, deg.get(tId) + 1);
    }
    return deg;
  }

  function windowMinTime(windowKey, now) {
    const days = WINDOW_DAYS[windowKey];
    if (!days) return null;
    const ref = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
    return ref - days * 86_400_000;
  }

  function filterEdgesByNodeSet(edges, idSet) {
    const out = [];
    for (const e of edges) {
      const sId = edgeEndpointId(e.source);
      const tId = edgeEndpointId(e.target);
      if (idSet.has(sId) && idSet.has(tId)) out.push(e);
    }
    return out;
  }

  function applyControls(nodes, edges, controls, now) {
    const c = controls || {};
    let outNodes = Array.isArray(nodes) ? nodes.slice() : [];
    let outEdges = Array.isArray(edges) ? edges.slice() : [];

    const minTime = windowMinTime(c.window, now);
    if (minTime != null) {
      outNodes = outNodes.filter((n) => {
        if (!n.createdAt) return false;
        const t = Date.parse(n.createdAt);
        return Number.isFinite(t) && t >= minTime;
      });
      outEdges = filterEdgesByNodeSet(outEdges, new Set(outNodes.map((n) => n.id)));
    }

    const minDegreeRaw = Number.isFinite(c.minDegree) ? c.minDegree : 0;
    const minDegree = Math.max(0, Math.floor(minDegreeRaw));
    const hideIsolated = !!c.hideIsolated;
    const threshold = Math.max(minDegree, hideIsolated ? 1 : 0);

    if (threshold > 0) {
      const deg = computeDegrees(outNodes, outEdges);
      outNodes = outNodes.filter((n) => (deg.get(n.id) || 0) >= threshold);
      outEdges = filterEdgesByNodeSet(outEdges, new Set(outNodes.map((n) => n.id)));
    }

    return { nodes: outNodes, edges: outEdges };
  }

  function defaultControls() {
    return { hideIsolated: false, minDegree: 0, window: 'all', layout: 'force' };
  }

  function normalizeControls(c) {
    const def = defaultControls();
    const out = Object.assign({}, def, c || {});
    out.hideIsolated = !!out.hideIsolated;
    const md = Number(out.minDegree);
    out.minDegree = Number.isFinite(md) && md > 0 ? Math.max(0, Math.floor(md)) : 0;
    if (!VALID_WINDOWS.includes(out.window)) out.window = 'all';
    if (!LAYOUTS.includes(out.layout)) out.layout = 'force';
    return out;
  }

  function encodeControls(qs, controls) {
    const c = normalizeControls(controls);
    if (c.hideIsolated) qs.set('hideIsolated', '1');
    else qs.delete('hideIsolated');
    if (c.minDegree > 0) qs.set('minDegree', String(c.minDegree));
    else qs.delete('minDegree');
    if (c.window !== 'all') qs.set('window', c.window);
    else qs.delete('window');
    if (c.layout !== 'force') qs.set('layout', c.layout);
    else qs.delete('layout');
    return qs;
  }

  function decodeControls(qs) {
    const out = defaultControls();
    if (qs.get('hideIsolated') === '1') out.hideIsolated = true;
    const md = parseInt(qs.get('minDegree'), 10);
    if (Number.isFinite(md) && md > 0) out.minDegree = md;
    const win = qs.get('window');
    if (win && VALID_WINDOWS.includes(win)) out.window = win;
    const lay = qs.get('layout');
    if (lay && LAYOUTS.includes(lay)) out.layout = lay;
    return out;
  }

  // Hierarchical layering — assigns each node a "level" by BFS from roots
  // (nodes with no incoming `supersedes` / `caused_by` edges). Used by the
  // hierarchical layout to map level → y position. Falls back to a single
  // level when no directional edges are present.
  function computeHierarchyLevels(nodes, edges) {
    const directional = new Set(['supersedes', 'caused_by', 'blocks']);
    const incoming = new Map();
    const outgoing = new Map();
    for (const n of nodes) {
      incoming.set(n.id, []);
      outgoing.set(n.id, []);
    }
    for (const e of edges) {
      if (!directional.has(e.kind)) continue;
      const sId = edgeEndpointId(e.source);
      const tId = edgeEndpointId(e.target);
      if (incoming.has(tId)) incoming.get(tId).push(sId);
      if (outgoing.has(sId)) outgoing.get(sId).push(tId);
    }
    const levels = new Map();
    const roots = [];
    for (const n of nodes) {
      if ((incoming.get(n.id) || []).length === 0) {
        roots.push(n.id);
        levels.set(n.id, 0);
      }
    }
    if (roots.length === 0) {
      for (const n of nodes) levels.set(n.id, 0);
      return levels;
    }
    const queue = roots.slice();
    while (queue.length) {
      const id = queue.shift();
      const cur = levels.get(id) || 0;
      for (const next of (outgoing.get(id) || [])) {
        const prev = levels.get(next);
        const candidate = cur + 1;
        if (prev == null || candidate > prev) {
          levels.set(next, candidate);
          queue.push(next);
        }
      }
    }
    for (const n of nodes) {
      if (!levels.has(n.id)) levels.set(n.id, 0);
    }
    return levels;
  }

  // Radial radius helper — high degree → small radius (center). Returns a
  // function that takes a node and returns a target radius (0 < r ≤ rMax).
  function radialRadiusFn(degreesMap, rMax) {
    let maxDeg = 0;
    for (const v of degreesMap.values()) if (v > maxDeg) maxDeg = v;
    if (maxDeg === 0) return () => rMax * 0.5;
    return (n) => {
      const deg = degreesMap.get(n.id) || 0;
      const t = 1 - (deg / maxDeg);
      return rMax * (0.15 + 0.75 * t);
    };
  }

  const api = {
    LAYOUTS,
    VALID_WINDOWS,
    computeDegrees,
    windowMinTime,
    applyControls,
    defaultControls,
    normalizeControls,
    encodeControls,
    decodeControls,
    computeHierarchyLevels,
    radialRadiusFn,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.GraphControls = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
