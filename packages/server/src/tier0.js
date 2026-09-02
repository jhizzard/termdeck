'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Tier-0 objectives — the injection side (Sprint 71 B-T2).
//
// WHAT TIER 0 IS. A small per-project set (~5-15 rows) of ratified objectives:
// what the project is for, what must never happen, where it currently stands.
// Tier 1 is doctrine/kitchen, tier 2 is evidence. The whole point of the tier
// is that it is INJECTED, NEVER RETRIEVED — it is pinned above recall output
// rather than competing with it, so no ranking function, decay curve, or
// consolidation pass can ever bury the objectives under a pile of evidence.
// That is the property this module has to preserve at every surface it feeds.
//
// Concretely, "injected not retrieved" means: `tier0` is its own field, it is
// emitted FIRST, it is never merged into `memories`, and nothing downstream is
// allowed to sort/filter/score it. A consumer that flattens the two lists has
// silently deleted the feature.
//
// WHAT THIS FILE OWNS. Fetch + normalize + render, once, for every surface:
//   • the recall envelope (`POST /api/ai/query`)
//   • the WS `proactive_memory` frame
//   • `GET /api/tier0`
//   • the bundled PreCompact hook (vendored copy — see PARITY below)
//   • the vault exporter's Home.md / MOC headers
// One implementation means those five cannot drift on what an objective is.
//
// PARITY WITH THE BUNDLED HOOK. `renderTier0Block` is duplicated into
// packages/stack-installer/assets/hooks/memory-pre-compact.js. That is a
// deliberate INSTALLER-PITFALLS Class N acceptance, on the same reasoning as
// drain.js/redact.js in the shims: a file that gets vendored to
// ~/.claude/hooks/ must not `require()` across into the server package (that
// is Class E — the exact hidden-dependency failure that left Brad's store at
// zero rows for five days). The duplication is pinned by an OUTPUT-PARITY
// fence over a shared fixture set, not by eyeballing. Change one, change both,
// or the fence goes red.
//
// DEGRADATION IS THE NORMAL CASE, NOT THE ERROR CASE. This ships before engram
// migration 038 is live. Every path here returns `[]` rather than throwing:
// no RAG config, missing RPC, missing table, network failure, malformed body.
// A store without objectives yields an injection surface that emits nothing,
// which is exactly the pre-tier-0 behavior.
// ─────────────────────────────────────────────────────────────────────────────

// Bumped when the emitted payload shape changes in a way a consumer could
// observe. Travels on the envelope so a mixed-version deck is diagnosable.
const TIER0_PAYLOAD_VERSION = 1;

// B-T1 owns the store shape and had not posted its marker when this was
// written, so both names are overridable by env and neither is load-bearing:
// if B-T1's SCHEMA-READY names something else, these two constants change and
// nothing structural moves.
const TIER0_RPC_DEFAULT = 'objective_list';
const TIER0_TABLE_DEFAULT = 'memory_objectives';

// Objectives are meant to be few. The cap is a blast-radius guard against a
// store that accumulates them anyway — an unbounded tier-0 block would eat the
// context budget it exists to protect. Truncation is LOGGED, never silent:
// a quietly-capped list reads as "these are all the objectives" when it isn't.
const TIER0_MAX_ROWS = 25;

// Objectives are prose, not documents. A pathological row must not be able to
// push the injection block past the budget on its own.
const TIER0_MAX_TEXT_CHARS = 600;

const TIER0_HEADING = 'Objectives (tier 0)';

// Column-name tolerance. B-T1's marker is not frozen yet, and the cost of
// guessing wrong is an empty injection block that looks exactly like "this
// store has no objectives" — the single worst failure mode for this feature,
// because it is indistinguishable from correct degradation. Accepting a few
// synonyms per field is much cheaper than that ambiguity.
const TEXT_KEYS = ['text', 'objective', 'content', 'body', 'statement'];
const RANK_KEYS = ['rank', 'ordinal', 'position', 'sort_order', 'priority'];
const STATUS_KEYS = ['status', 'state'];

// Objectives mutate only by ratification, which means the store keeps the old
// row and marks it — a `supersedes` chain, per the sprint's schema. Injecting a
// superseded objective is strictly worse than injecting none: the agent would
// be handed a constraint the operator has explicitly retired, and would defend
// it. So the filter is DENY-LIST, not allow-list — an unrecognised or absent
// status passes through (B-T1 owns the vocabulary; guessing an allow-list
// wrong would silently blank the whole tier, which is the one failure mode
// indistinguishable from correct degradation).
const INACTIVE_STATUSES = new Set([
  'superseded', 'retired', 'archived', 'inactive', 'revoked', 'draft', 'deleted',
]);

function isRetiredObjective(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.superseded_by != null && row.superseded_by !== '') return true;
  if (row.is_active === false || row.archived === true) return true;
  const status = firstKey(row, STATUS_KEYS);
  return status != null && INACTIVE_STATUSES.has(String(status).trim().toLowerCase());
}

function firstKey(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return null;
}

function clampText(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.length <= TIER0_MAX_TEXT_CHARS) return s;
  return `${s.slice(0, TIER0_MAX_TEXT_CHARS - 1)}…`;
}

// One store row → the frozen normalized shape. Returns null for anything
// without objective text: a row we cannot render is worse than absent, because
// it occupies a rank slot and prints as a blank bullet.
function normalizeObjective(row) {
  if (!row || typeof row !== 'object') return null;
  if (isRetiredObjective(row)) return null;
  const text = clampText(firstKey(row, TEXT_KEYS));
  if (!text) return null;
  // `rawRank == null` is checked BEFORE the Number() coercion on purpose:
  // Number(null) is 0 and Number.isFinite(0) is true, so a coercion-first
  // reading silently promotes every unranked objective to rank 0 — i.e. to
  // the TOP of the pinned block, ahead of the operator's actual rank-1. An
  // unranked row must sort last, which is what sortObjectives does with null.
  const rawRank = firstKey(row, RANK_KEYS);
  const rank = (rawRank != null && rawRank !== '' && Number.isFinite(Number(rawRank)))
    ? Number(rawRank)
    : null;
  return {
    id: row.id != null ? String(row.id) : null,
    project: row.project != null ? String(row.project) : null,
    rank,
    text,
    status: (() => { const s = firstKey(row, STATUS_KEYS); return s == null ? null : String(s); })(),
    ratified_by: row.ratified_by != null ? String(row.ratified_by) : null,
    ratified_at: row.ratified_at != null ? String(row.ratified_at) : null,
    supersedes: row.supersedes != null ? String(row.supersedes) : null,
  };
}

// Rank ascending is the pin order. Rows without a rank sort AFTER ranked ones
// (a missing rank is "unspecified", not "first"), ties broken by ratification
// time then id so the order is total and therefore stable across calls — an
// injection block that reshuffles between compactions reads as drift.
function sortObjectives(rows) {
  return rows.slice().sort((a, b) => {
    const ar = a.rank == null ? Number.POSITIVE_INFINITY : a.rank;
    const br = b.rank == null ? Number.POSITIVE_INFINITY : b.rank;
    if (ar !== br) return ar - br;
    const at = a.ratified_at || '';
    const bt = b.ratified_at || '';
    if (at !== bt) return at < bt ? -1 : 1;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

// normalizeObjectives(rows, { onTruncate? }) → sorted, capped, normalized list.
function normalizeObjectives(rows, opts = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .map(normalizeObjective)
    .filter(Boolean);
  const sorted = sortObjectives(list);
  if (sorted.length > TIER0_MAX_ROWS && typeof opts.onTruncate === 'function') {
    opts.onTruncate(sorted.length, TIER0_MAX_ROWS);
  }
  return sorted.slice(0, TIER0_MAX_ROWS);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RENDER — the one block a human reads in the vault and an agent reads at
// boot and at compaction. Kept deliberately boring: plain markdown, no fences,
// no JSON. It survives an embed round-trip, a terminal paste, and a Google
// Sheets cell without changing meaning.
//
// ⚠ BYTE-PARITY CONTRACT: duplicated in
// packages/stack-installer/assets/hooks/memory-pre-compact.js. Any edit here
// must be mirrored there or `tier0-hook-parity.test.js` goes red. See the
// PARITY note in this file's header for why the duplication exists.
// ─────────────────────────────────────────────────────────────────────────────
function renderTier0Block(objectives, opts = {}) {
  const rows = Array.isArray(objectives) ? objectives : [];
  if (rows.length === 0) return '';
  const heading = opts.heading || TIER0_HEADING;
  const lines = [];
  lines.push(`## ${heading}`);
  lines.push('');
  // Said plainly and up front, because the whole tier is an enforcement
  // mechanism and an agent that treats these as suggestions has defeated it.
  lines.push('These are ratified, standing objectives for this project. They are pinned above');
  lines.push('recall results and are not retrieved, ranked, or decayed. Treat them as binding');
  lines.push('constraints on this session; they change only by explicit operator ratification.');
  lines.push('');
  rows.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.text}`);
  });
  const ratified = rows.filter((o) => o.ratified_at).length;
  lines.push('');
  lines.push(
    `_${rows.length} objective${rows.length === 1 ? '' : 's'}`
    + `${ratified > 0 ? `, ${ratified} carrying a ratification stamp` : ''}._`,
  );
  return lines.join('\n');
}

// The empty envelope. A single constructor so no surface can invent its own
// "nothing here" shape — `tier0` is always an array, never null, never absent.
function emptyTier0Payload(source = 'unavailable') {
  return { tier0: [], tier0_source: source, tier0_version: TIER0_PAYLOAD_VERSION };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH
// ─────────────────────────────────────────────────────────────────────────────

// The RPC's project-argument name is unknown until B-T1 posts. Rather than
// guess once and fail silently, probe: send `p_project`, and on the SPECIFIC
// PostgREST "could not find the function" 404 retry once with `project`, then
// latch the verdict for the process lifetime.
//
// This is not defensive over-engineering; it is the exact bug this repo has
// already paid for. An unconditional extra/renamed key made PostgREST fail to
// resolve the overload and 404 — which killed every Flashback query for
// fifteen sprints without a single error surfacing to anyone. See the
// p_decay_profile probe in mnestra-bridge/index.js for the same shape.
const ARG_SHAPES = ['p_project', 'project'];

function isOverloadMiss(status, bodyText) {
  return status === 404 && /could not find the function/i.test(bodyText || '');
}

// createTier0Provider({ config, fetchImpl?, now?, ttlMs?, env?, log? })
//   → { fetch({ project }) → Promise<{tier0, tier0_source, tier0_version}>,
//       invalidate(), _peek() }
//
// Cached per project. Objectives change only on an operator ratification, so
// a short TTL is generous — but it is a TTL rather than a permanent cache
// because a ratification that takes 60s to become visible is fine, and one
// that requires a server restart is not.
function createTier0Provider(opts = {}) {
  const config = opts.config || {};
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 60_000;
  const log = opts.log || ((msg) => console.log(`[tier0] ${msg}`));
  const rpcName = env.TERMDECK_TIER0_RPC || TIER0_RPC_DEFAULT;
  const tableName = env.TERMDECK_TIER0_TABLE || TIER0_TABLE_DEFAULT;
  const fetchTimeoutMs = Number.isFinite(Number(env.TERMDECK_TIER0_TIMEOUT_MS))
    ? Math.max(500, Number(env.TERMDECK_TIER0_TIMEOUT_MS))
    : (Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000);

  // null = unprobed; a string = the arg name this store accepted; false = the
  // RPC does not exist here at all, stop paying for the round-trip.
  let rpcArgShape = null;
  let rpcAvailable = null;
  const cache = new Map(); // projectKey → { payload, atMs }

  function creds() {
    const supabaseUrl = config.rag && config.rag.supabaseUrl;
    const supabaseKey = config.rag && config.rag.supabaseKey;
    if (!supabaseUrl || !supabaseKey) return null;
    return { supabaseUrl, supabaseKey };
  }

  function headers(key) {
    return {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    };
  }

  // BOUNDED. Every tier-0 read sits on the critical path of a request the user
  // is waiting on — `/api/ai/query` awaits it before responding, and the
  // PreCompact hook awaits it during a compaction. An unbounded fetch against a
  // wedged objectives store converts "no objectives" (a fine outcome) into "the
  // recall endpoint hangs" (not one). B-T4 caught this: the hook copy had a
  // timeout from the start and this one did not.
  function doFetch(url, init) {
    const f = opts.fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') throw new Error('fetch unavailable');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
    return Promise.resolve(f(url, { ...init, signal: ac.signal }))
      .finally(() => clearTimeout(timer));
  }

  async function viaRpc({ supabaseUrl, supabaseKey }, project) {
    if (rpcAvailable === false) return null;
    const shapes = rpcArgShape ? [rpcArgShape] : ARG_SHAPES;
    for (const argName of shapes) {
      let res;
      try {
        res = await doFetch(`${supabaseUrl}/rest/v1/rpc/${encodeURIComponent(rpcName)}`, {
          method: 'POST',
          headers: headers(supabaseKey),
          body: JSON.stringify({ [argName]: project || null }),
        });
      } catch (err) {
        log(`rpc ${rpcName} threw: ${err && err.message ? err.message : String(err)}`);
        return null;
      }
      if (res.ok) {
        rpcArgShape = argName;
        rpcAvailable = true;
        let body;
        try { body = await res.json(); } catch (_) { return null; }
        return Array.isArray(body) ? body : (body && Array.isArray(body.objectives) ? body.objectives : null);
      }
      const text = await res.text().catch(() => '');
      if (isOverloadMiss(res.status, text)) {
        // Wrong arg name for this store — try the next shape before giving up.
        continue;
      }
      if (res.status === 404) {
        rpcAvailable = false;
        log(`rpc ${rpcName} not deployed (404) — falling back to table read`);
      }
      return null;
    }
    // Every shape 404'd as an overload miss ⇒ the function genuinely isn't here.
    rpcAvailable = false;
    log(`rpc ${rpcName} did not resolve under any known arg shape — falling back to table read`);
    return null;
  }

  async function viaTable({ supabaseUrl, supabaseKey }, project) {
    // NO PROJECT ⇒ NO OBJECTIVES. This mirrors `objective_list(null)`, which
    // returns zero rows by design (B-T1, migration 038 smoke group 7).
    //
    // The bug this replaces: the RPC path sent `p_project: null` and got
    // nothing, while this path simply omitted the filter and returned EVERY
    // project's objectives — flat-sorted by rank, so every project's rank-1
    // clustered at the top, truncated at 25, and wrapped in the renderer's
    // "these are binding constraints on this session" framing. An agent in an
    // unresolved-project panel would have been handed three dozen projects'
    // constraints and told to defend them.
    //
    // Latent today (the table path is only reached when the RPC is absent, i.e.
    // pre-038, where the table is absent too) — but it goes live the moment a
    // transient 404 latches `rpcAvailable = false` on a 038 store. Caught by
    // B-T1 reading the two paths against each other; the tests on each path
    // individually were green.
    if (!project) return [];
    const params = new URLSearchParams();
    params.set('select', '*');
    params.set('project', `eq.${project}`);
    // Match the RPC's active-only contract at the query, not just in the JS
    // deny-list filter downstream. Both layers stay: this one keeps the payload
    // small, `normalizeObjectives` is what actually guarantees a superseded
    // objective is never injected.
    params.set('status', 'eq.active');
    params.set('order', 'rank.asc');
    let res;
    try {
      res = await doFetch(
        `${supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}?${params.toString()}`,
        { method: 'GET', headers: headers(supabaseKey) },
      );
    } catch (err) {
      log(`table ${tableName} threw: ${err && err.message ? err.message : String(err)}`);
      return null;
    }
    if (!res.ok) {
      // 404 here is the expected pre-038 state, not an incident.
      if (res.status !== 404) log(`table ${tableName} read failed: HTTP ${res.status}`);
      return null;
    }
    try {
      const body = await res.json();
      return Array.isArray(body) ? body : null;
    } catch (_) {
      return null;
    }
  }

  async function fetchTier0({ project } = {}) {
    const key = project || '__all__';
    const cached = cache.get(key);
    if (cached && now() - cached.atMs < ttlMs) return cached.payload;

    let payload = emptyTier0Payload('unavailable');
    const c = creds();
    if (c) {
      let rows = await viaRpc(c, project);
      let source = 'rpc';
      if (rows === null) {
        rows = await viaTable(c, project);
        source = 'table';
      }
      if (rows !== null) {
        const objectives = normalizeObjectives(rows, {
          onTruncate: (total, cap) => log(
            `project="${project || 'ALL'}" has ${total} objectives; injecting the first ${cap} `
            + 'by rank. Tier 0 is meant to hold ~5-15 — the rest are NOT being injected.',
          ),
        });
        payload = { tier0: objectives, tier0_source: source, tier0_version: TIER0_PAYLOAD_VERSION };
      }
    }
    cache.set(key, { payload, atMs: now() });
    return payload;
  }

  return {
    fetch: fetchTier0,
    invalidate() { cache.clear(); rpcArgShape = null; rpcAvailable = null; },
    _peek: () => ({ rpcArgShape, rpcAvailable, cacheSize: cache.size }),
  };
}

module.exports = {
  TIER0_PAYLOAD_VERSION,
  TIER0_RPC_DEFAULT,
  TIER0_TABLE_DEFAULT,
  TIER0_MAX_ROWS,
  TIER0_MAX_TEXT_CHARS,
  TIER0_HEADING,
  normalizeObjective,
  normalizeObjectives,
  sortObjectives,
  isRetiredObjective,
  INACTIVE_STATUSES,
  renderTier0Block,
  emptyTier0Payload,
  createTier0Provider,
};
