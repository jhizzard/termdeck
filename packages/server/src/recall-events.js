'use strict';

// packages/server/src/recall-events.js — Sprint 81 T4 (Part 2, the memory-proof
// surface). Pure grouping of public.memory_recall_log rows (engram, extended by
// migration 031) into "reinjection events": one recall_group_id = one recall
// CALL = the K hit-rows that were reinjected together. This is the observable
// unit of "which panel pulled which memories, grouped into which reinjection,
// at what token budget".
//
// The route in index.js does the fail-soft pg read and calls groupRecallEvents
// on the returned rows. Kept PURE + dependency-free so it unit-tests without a
// DB and never throws into the (already fail-soft) route.

const DEFAULT_MAX_EVENTS = 50;

function _num(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// pg returns timestamptz as a Date; normalize to ISO best-effort (never throw).
function _iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  try { return new Date(v).toISOString(); } catch (_e) { return null; }
}

function _str(v) {
  return (typeof v === 'string' && v.length) ? v : null;
}

// rows: array from memory_recall_log, expected ORDER BY created_at DESC, each:
//   { memory_id, query_preview, score, rank, surface, source_session_id,
//     source_agent, source_type, token_budget, recall_group_id, created_at,
//     memory_project, memory_preview }
// Returns events (most-recent group first — insertion order preserves the DESC
// input ordering), one per recall_group_id. Rows with a NULL recall_group_id
// become singleton events (honest: pre-031 rows lack the grouping id and can't
// be reassembled into their original recall). Never throws.
function groupRecallEvents(rows, opts = {}) {
  const maxEvents = (opts && opts.maxEvents && opts.maxEvents > 0) ? opts.maxEvents : DEFAULT_MAX_EVENTS;
  const list = Array.isArray(rows) ? rows : [];
  const byGroup = new Map(); // key -> event (Map preserves first-seen order)
  let nullSeq = 0;

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const gid = _str(r.recall_group_id);
    const key = gid || `__nogroup_${nullSeq++}__`;

    let ev = byGroup.get(key);
    if (!ev) {
      ev = {
        recallGroupId: gid,
        createdAt: _iso(r.created_at),
        surface: _str(r.surface),
        sourceSessionId: _str(r.source_session_id),
        sourceAgent: _str(r.source_agent),
        tokenBudget: _num(r.token_budget),
        queryPreview: _str(r.query_preview),
        hits: [],
        sourceTypeMix: {},
        hasDoctrine: false,
      };
      byGroup.set(key, ev);
    }

    const st = _str(r.source_type);
    ev.hits.push({
      memoryId: _str(r.memory_id),
      sourceType: st,
      score: _num(r.score),
      rank: _num(r.rank),
      project: _str(r.memory_project),
      preview: _str(r.memory_preview),
    });
    if (st) {
      ev.sourceTypeMix[st] = (ev.sourceTypeMix[st] || 0) + 1;
      if (st === 'doctrine') ev.hasDoctrine = true;
    }

    // Per-call fields are identical on every row of a group, but some rows can
    // carry NULLs (e.g. a surface that doesn't supply token_budget) — take the
    // first non-null seen so a partial row never blanks the event.
    if (ev.createdAt == null) ev.createdAt = _iso(r.created_at);
    if (ev.surface == null) ev.surface = _str(r.surface);
    if (ev.sourceSessionId == null) ev.sourceSessionId = _str(r.source_session_id);
    if (ev.sourceAgent == null) ev.sourceAgent = _str(r.source_agent);
    if (ev.tokenBudget == null) ev.tokenBudget = _num(r.token_budget);
    if (ev.queryPreview == null) ev.queryPreview = _str(r.query_preview);
  }

  const events = Array.from(byGroup.values());
  for (const ev of events) {
    ev.hitCount = ev.hits.length;
    // Rank ascending (rank 1 = top hit); NULL ranks sink to the bottom.
    ev.hits.sort((a, b) => {
      const ra = a.rank == null ? Infinity : a.rank;
      const rb = b.rank == null ? Infinity : b.rank;
      return ra - rb;
    });
  }
  return events.slice(0, maxEvents);
}

module.exports = { groupRecallEvents, DEFAULT_MAX_EVENTS };
