'use strict';

// Sprint 83 T3 — recall-side typed graph expansion for the error/flashback path.
//
// THE PROBLEM. The relationship graph is written nightly by rumen's
// `graph-inference` edge function (~7,378 edges) and read essentially never:
// `memory_recall_graph` (engram migration 010) has 2 recorded uses in its
// lifetime. So "you solved something structurally similar before" has never
// fired — nothing at recall time walks an edge.
//
// WHY NOT 010. `memory_recall_graph` re-ranks the union of vector hits and
// graph neighbors by `vector_score × edge_weight × recency_score`. That is a
// MUTATION of the hybrid ranking, which Sprint 83 forbids outright: 033's
// scoring semantics are the calibration substrate and nothing additive is
// allowed to perturb them. 010 also traverses untyped edges (5,841 of the
// 7,378 live edges are `relates_to`, so depth-2 untyped expansion returns a
// large fraction of the graph) and predates temporal validity entirely.
//
// WHAT THIS DOES INSTEAD. After the hybrid ranking has already chosen what to
// surface, expansion takes the CHOSEN hit plus other solved-problem-class
// candidates as seeds, walks 1–2 typed, live edges, and returns neighbors as a
// separate `related` payload. The ranking is never consulted, never recomputed,
// and never reordered. Remove this module and the flashback path behaves
// exactly as it did before it existed.
//
// THREE INVARIANTS, in priority order:
//
//   1. READ-ONLY BY CONSTRUCTION. Nothing here writes — not a row, not an
//      edge, not a counter. The RPC it calls is declared STABLE (Postgres
//      raises on a write attempt inside a STABLE function), this module holds
//      no SQLite handle, and the single outbound call is name-pinned to the
//      one read RPC. `tests/graph-expansion.test.js` asserts all three.
//   2. ADDITIVE ONLY. `related` rides alongside `hit`. It never replaces the
//      hit, never re-scores it, never changes which memory was selected, and
//      never suppresses a toast that would otherwise have fired.
//   3. FEATURE-DETECTED + BOUNDED. Against a pre-034 store the RPC is absent;
//      the first 404 latches the capability off for the process lifetime and
//      every subsequent error recall is byte-for-byte its current behavior.
//      Every call is hop-capped, row-capped, seed-capped and time-capped, and
//      a failure of any kind fails OPEN to `related: []`.
//
// Sizing note: the typed predicate set is deliberately narrow. `relates_to`
// (the 79%-of-the-graph bucket) is NOT traversable here — it means "these two
// memories are similar", which is what the vector search already told us. Only
// predicates that carry a causal or corrective claim are worth a hop.

// ── The I4 contract ────────────────────────────────────────────────────────
//
// T1's `SCHEMA-READY` post (interface I4) is the AUTHORITY for every name in
// this object. It is isolated here so that a vocabulary change in migration
// 034 is a one-object edit rather than a grep across the module. PostgREST
// binds RPC arguments by NAME and resolves overloads by the JSON key set, so
// these strings are a wire contract, not a convenience.
// The I3 normalizer, vendored byte-identically from engram (ORCH ruling
// 2026-07-31 14:47 ET; see `src/vendor/README.md`). Loaded defensively: a
// packaging miss must degrade expansion to seed-derived matching, never crash
// a server boot. `problemLookupKey` is the READ-side entry point — it turns the
// live error line into the same `{class, symptom_hash}` the write side stored.
let problemSignatureCore = null;
try {
  problemSignatureCore = require('./vendor/problem_signature_core.cjs');
} catch (err) {
  console.warn('[graph-expansion] vendored problem_signature core unavailable — signature matching degraded to seed-derived only:', err && err.message);
}

const CONTRACT = {
  rpc: 'memory_expand_typed',
  params: {
    seedIds: 'p_seed_ids',
    predicates: 'p_predicates',
    maxDepth: 'p_max_depth',
    maxRows: 'p_max_rows',
    project: 'p_project',
  },
  // Semantic roles, keyed by the role rather than the spelling so a rename in
  // 034 touches only the right-hand side.
  predicates: {
    fixedBy: 'fixed_by',            // A fixed_by B  ⇒ B is the fix for A
    causedBy: 'caused_by',          // A caused_by B ⇒ B is the cause of A
    samePatternAs: 'same_pattern_as', // symmetric
    supersedes: 'supersedes',       // A supersedes B ⇒ A is the newer truth
  },
};

// Traversable predicate list sent to the RPC. Order is irrelevant on the wire;
// PRIORITY (below) is what decides display order.
const EXPANSION_PREDICATES = [
  CONTRACT.predicates.fixedBy,
  CONTRACT.predicates.causedBy,
  CONTRACT.predicates.samePatternAs,
  CONTRACT.predicates.supersedes,
];

// Display priority. A fix outranks a cause outranks a pattern-sibling
// outranks a version bump — that is the order in which they answer the
// question the user actually has ("how do I get past this error").
const PREDICATE_PRIORITY = {
  [CONTRACT.predicates.fixedBy]: 0,
  [CONTRACT.predicates.causedBy]: 1,
  [CONTRACT.predicates.samePatternAs]: 2,
  [CONTRACT.predicates.supersedes]: 3,
};

// What counts as "a solved problem", per T2's I3 trigger (STATUS 14:38 ET):
//   source_type === 'bug_fix'  ||  category === 'debugging'
//
// The `category` half is load-bearing and easy to get wrong. `debugging` is a
// CATEGORY value, not a legal `source_type` — migration 028's
// `memory_items_source_type_check` (028:256-260) pins source_type to an
// 11-value allowlist that does not contain it. So a classifier keyed on
// `source_type ∈ {bug_fix, debugging}` silently degrades to bug_fix alone and
// misses every debugging-class memory written under a `decision` or `fact`
// type. Live corpus at time of writing: 252 bug_fix rows vs 550 rows with
// category='debugging', 379 of which are NOT bug_fix — i.e. the source_type
// half alone reaches 40% of the population it is supposed to reach.
const SOLVED_PROBLEM_SOURCE_TYPES = new Set(['bug_fix']);
const SOLVED_PROBLEM_CATEGORIES = new Set(['debugging']);

// I3 (FROZEN by T2's 14:38 ET FINDING) — the signature is ONE object under
// ONE metadata key, deliberately not sibling scalars: `remember.ts` shallow-
// merges metadata on a dedup reinforcement, so sibling keys can desync across
// two writes while a single object key stays atomic.
//
//   metadata.problem_signature = {
//     v, class, symptom, symptom_hash, extracted_by, extracted_at
//   }
//
// The key is ABSENT (never null, never "") when a write is not
// solved-problem-class, so every check here branches on PRESENCE.
const PROBLEM_SIGNATURE_KEY = 'problem_signature';

const DEFAULTS = {
  enabled: true,
  maxDepth: 2,
  maxRows: 5,
  maxSeeds: 5,
  timeoutMs: 1200,
};

// Hard ceilings. The RPC clamps server-side too (I4 REQ-1h) — this is the
// caller half of the same belt-and-suspenders, so a mis-set env var cannot
// turn a toast enrichment into a graph crawl.
const LIMITS = {
  maxDepth: 2,
  maxRows: 25,
  maxSeeds: 10,
  timeoutMs: 5000,
};

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// Resolves the effective knobs from env. Every value is clamped; nothing here
// can be set to "unbounded" from the outside.
//
//   TERMDECK_GRAPH_EXPANSION           '0' / 'false' / 'off' ⇒ hard-disabled
//   TERMDECK_GRAPH_EXPANSION_MAX_DEPTH 1..2   (default 2)
//   TERMDECK_GRAPH_EXPANSION_MAX_ROWS  1..25  (default 5)
//   TERMDECK_GRAPH_EXPANSION_MAX_SEEDS 1..10  (default 5)
//   TERMDECK_GRAPH_EXPANSION_TIMEOUT_MS 1..5000 (default 1200)
function resolveExpansionSettings(env) {
  const source = env || process.env;
  const rawEnabled = source.TERMDECK_GRAPH_EXPANSION;
  const enabled = (rawEnabled === undefined || rawEnabled === null || String(rawEnabled).trim() === '')
    ? DEFAULTS.enabled
    : !/^(0|false|off|no)$/i.test(String(rawEnabled).trim());
  return {
    enabled,
    maxDepth: clampInt(source.TERMDECK_GRAPH_EXPANSION_MAX_DEPTH, DEFAULTS.maxDepth, 1, LIMITS.maxDepth),
    maxRows: clampInt(source.TERMDECK_GRAPH_EXPANSION_MAX_ROWS, DEFAULTS.maxRows, 1, LIMITS.maxRows),
    maxSeeds: clampInt(source.TERMDECK_GRAPH_EXPANSION_MAX_SEEDS, DEFAULTS.maxSeeds, 1, LIMITS.maxSeeds),
    timeoutMs: clampInt(source.TERMDECK_GRAPH_EXPANSION_TIMEOUT_MS, DEFAULTS.timeoutMs, 1, LIMITS.timeoutMs),
    // TERMDECK_GRAPH_EXPANSION_CROSS_PROJECT — send `p_project: null` so
    // expansion may return fixes that live in ANOTHER project.
    //
    // Default OFF, deliberately. The recall that produced the seeds was
    // project-scoped (`searchAll: false`), so letting expansion return
    // out-of-project memories would make the toast wider than the search
    // behind it — surprising, and a quiet cross-project disclosure on a
    // machine where projects are separate clients' work. The cost of OFF is
    // real and worth naming: a shared-stack error solved under a different
    // project tag (the same Supabase permission error fixed in mnestra, hit
    // in termdeck) stays out of reach. Exposed as a knob so that trade is an
    // explicit choice rather than an accident of which value got hardcoded.
    crossProject: /^(1|true|yes|on)$/i.test(String(source.TERMDECK_GRAPH_EXPANSION_CROSS_PROJECT ?? '').trim()),
  };
}

// ── Seed classification (I3) ───────────────────────────────────────────────

// The whole `problem_signature` object for a memory, or null when the key is
// absent (the documented "not solved-problem-class" state) or the blob is
// malformed. Never throws.
function problemSignatureOf(memory) {
  const meta = memory && memory.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const sig = meta[PROBLEM_SIGNATURE_KEY];
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) return null;
  return sig;
}

// The two match keys T2 specified for expansion: exact on `symptom_hash`
// (same error at two sites ⇒ same hash, because `normalizeSymptom` is
// deterministic), class-level on `class`.
function problemClassOf(memory) {
  const sig = problemSignatureOf(memory);
  const cls = sig && sig.class;
  return (typeof cls === 'string' && cls.trim()) ? cls.trim() : null;
}

function symptomHashOf(memory) {
  const sig = problemSignatureOf(memory);
  const h = sig && sig.symptom_hash;
  return (typeof h === 'string' && h.trim()) ? h.trim() : null;
}

// "Is this memory a solved problem?" — presence of a `problem_signature` is
// the strong signal (T2 writes it on exactly the solved-problem-class writes).
// The fallback is T2's own trigger predicate, and it is what actually fires
// today: no signature exists on any row until T2's extractor has run over a
// corpus, so for the entire back-catalogue this fallback IS the classifier.
function isSolvedProblemClass(memory) {
  if (!memory) return false;
  if (problemSignatureOf(memory)) return true;
  if (SOLVED_PROBLEM_SOURCE_TYPES.has(memory.source_type)) return true;
  return SOLVED_PROBLEM_CATEGORIES.has(memory.category);
}

// Picks the seed set for one expansion. Pure.
//
// The emitted hit always leads: it is the memory the user is about to see, so
// anything hanging off it is the most attributable enrichment available. The
// remaining slots go to other solved-problem-class candidates in rank order —
// they are already-ranked hits, so using them as seeds borrows the hybrid
// ranking's judgment without altering it.
//
// Returns [] when nothing in the candidate set is solved-problem-class, which
// short-circuits the whole feature for ordinary non-debugging errors and keeps
// the common case at zero added round-trips.
function selectSeeds({ hit, memories, maxSeeds } = {}) {
  const cap = Number.isFinite(maxSeeds) ? Math.max(1, maxSeeds) : DEFAULTS.maxSeeds;
  const list = Array.isArray(memories) ? memories : [];
  const pool = hit ? [hit, ...list.filter((m) => m && m !== hit)] : list;

  const anySolved = pool.some((m) => isSolvedProblemClass(m));
  if (!anySolved) return [];

  const seen = new Set();
  const seeds = [];
  for (const m of pool) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    if (seen.has(m.id)) continue;
    // The hit seeds unconditionally (it is what the user sees); everything
    // else must earn its slot by being solved-problem-class.
    if (m !== hit && !isSolvedProblemClass(m)) continue;
    seen.add(m.id);
    seeds.push(m);
    if (seeds.length >= cap) break;
  }
  return seeds;
}

// ── Result shaping ─────────────────────────────────────────────────────────

// User-facing phrasing for one edge. `direction` is the RPC's report of which
// endpoint the seed was on for the LAST edge in the path ('outbound' ⇒ seed
// was source_id). Every asymmetric predicate reads differently from each end,
// and guessing gets it backwards half the time — which is why I4 asks for
// `direction` explicitly rather than inferring it.
function relationLabel(edgeType, direction) {
  const outbound = direction !== 'inbound';
  switch (edgeType) {
    case CONTRACT.predicates.fixedBy:
      return outbound ? 'You fixed this before' : 'This fixed a similar problem';
    case CONTRACT.predicates.causedBy:
      return outbound ? 'Root cause found previously' : 'This caused a similar failure';
    case CONTRACT.predicates.samePatternAs:
      return 'Same failure pattern';
    case CONTRACT.predicates.supersedes:
      return outbound ? 'Earlier version of this note' : 'Updated version of this note';
    default:
      return 'Related by graph';
  }
}

function privacyTagged(row) {
  const tags = row && row.privacy_tags;
  return Array.isArray(tags) && tags.length > 0;
}

// Normalizes RPC rows into the `related` payload shape and applies caller-side
// filtering the RPC is also expected to apply. Duplicating the exclusions is
// deliberate: expansion reaches memories the hybrid search never scored, so a
// silent regression in the SQL half would otherwise surface privacy-tagged or
// seed-echo content in a user-visible toast.
//
// Pure — no I/O, no clock.
function shapeExpansion(rows, { seedIds, excludeIds, maxRows, seeds, lookupKey } = {}) {
  const exclude = new Set([...(seedIds || []), ...(excludeIds || [])].filter(Boolean));
  const cap = Number.isFinite(maxRows) ? Math.max(1, maxRows) : DEFAULTS.maxRows;
  const list = Array.isArray(rows) ? rows : [];

  // I3 match keys. Two independent sources, and the second is the one that
  // actually works today:
  //   • SEED-derived — requires the already-stored memory to carry a
  //     signature. Nothing in the back-catalogue does until T2's extractor has
  //     run over it, so this yields nothing for a long while.
  //   • LOOKUP-KEY-derived — the LIVE error line, normalized and hashed
  //     through the vendored core. Always available, because it is computed
  //     from the error that just happened rather than read from storage.
  // Both are annotation only: a signature match never gates a row in or out.
  // Gating on it would surface nothing at all during exactly the period the
  // feature most needs to prove itself.
  const seedHashes = new Set();
  const seedClasses = new Set();
  for (const s of (seeds || [])) {
    const h = symptomHashOf(s); if (h) seedHashes.add(h);
    const c = problemClassOf(s); if (c) seedClasses.add(c);
  }
  if (lookupKey) {
    if (lookupKey.symptom_hash) seedHashes.add(lookupKey.symptom_hash);
    if (lookupKey.class) seedClasses.add(lookupKey.class);
  }

  const seen = new Set();
  const shaped = [];
  for (const row of list) {
    if (!row || typeof row.memory_id !== 'string' || !row.memory_id) continue;
    if (exclude.has(row.memory_id) || seen.has(row.memory_id)) continue;
    // Privacy parity with recall (I4 REQ-1e): the RPC hands back the column,
    // this side decides. Default is exclude, matching `memory_recall`'s
    // default posture — a graph hop must not become a privacy bypass.
    if (privacyTagged(row)) continue;
    if (!EXPANSION_PREDICATES.includes(row.edge_type)) continue;
    seen.add(row.memory_id);
    shaped.push({
      id: row.memory_id,
      seed_id: row.seed_id || null,
      content: row.content,
      source_type: row.source_type,
      project: row.project,
      created_at: row.created_at,
      // Provenance, so nothing downstream can mistake a graph neighbor for a
      // ranked hit: these carry no similarity score of any kind, because they
      // were never scored against the query.
      graph_derived: true,
      hops: Number.isFinite(row.depth) ? row.depth : null,
      edge_type: row.edge_type,
      edge_path: Array.isArray(row.edge_path) ? row.edge_path : null,
      direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
      edge_weight: (typeof row.edge_weight === 'number' && Number.isFinite(row.edge_weight))
        ? row.edge_weight : null,
      relation_label: relationLabel(row.edge_type, row.direction),
      problem_class: problemClassOf(row),
      // 'symptom' (same normalized error, T2's exact key) > 'class' (same
      // doctrine err-* family) > null. Annotation only — see above.
      signature_match: (() => {
        const h = symptomHashOf(row);
        if (h && seedHashes.has(h)) return 'symptom';
        const c = problemClassOf(row);
        if (c && seedClasses.has(c)) return 'class';
        return null;
      })(),
    });
  }

  const MATCH_RANK = { symptom: 0, class: 1 };
  shaped.sort((a, b) => {
    // A confirmed same-symptom neighbor outranks edge type: "this is literally
    // the same error you hit before" beats "this is a fix for something
    // adjacent", whatever predicate carried it.
    const ma = MATCH_RANK[a.signature_match] ?? 2;
    const mb = MATCH_RANK[b.signature_match] ?? 2;
    if (ma !== mb) return ma - mb;
    const pa = PREDICATE_PRIORITY[a.edge_type] ?? 99;
    const pb = PREDICATE_PRIORITY[b.edge_type] ?? 99;
    if (pa !== pb) return pa - pb;
    const da = a.hops ?? 99;
    const db = b.hops ?? 99;
    if (da !== db) return da - db;
    return (b.edge_weight ?? 0) - (a.edge_weight ?? 0);
  });

  return shaped.slice(0, cap);
}

// ── The expander ───────────────────────────────────────────────────────────

// Creates one expander bound to a config. Holds a single piece of mutable
// state: the tri-state capability latch, exactly mirroring the bridge's
// `decayProfileSupported` probe (mnestra-bridge/index.js) —
//   null  = unknown, probe on next call
//   true  = the store has migration 034
//   false = pre-034 store, never call again this process
//
// `fetchImpl` is injectable so tests exercise the real request-building and
// error-latching code paths without a network or a database.
function createExpander(config, { fetchImpl, env } = {}) {
  const settings = resolveExpansionSettings(env);
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const state = { supported: null, lastError: null };

  const supabaseUrl = config?.rag?.supabaseUrl || null;
  const supabaseKey = config?.rag?.supabaseKey || null;

  // Expansion talks PostgREST directly, so it needs Supabase credentials
  // regardless of which mode the recall bridge is in. A webhook-only or
  // MCP-only install simply doesn't get expansion — it does not get an error,
  // and it does not get a degraded toast.
  const configured = !!(supabaseUrl && supabaseKey);

  function available() {
    return settings.enabled && configured && state.supported !== false;
  }

  async function callRpc(body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${supabaseUrl}/rest/v1/rpc/${CONTRACT.rpc}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Runs one expansion. ALWAYS resolves — never rejects, never throws. The
  // caller is on the toast path; a graph enrichment that can break a flashback
  // is worse than no graph enrichment.
  //
  // Returns { related, reason, seedCount, durationMs }. `reason` names why an
  // empty result is empty, which is the difference between "the graph had
  // nothing" and "we never asked".
  async function expand({ hit, memories, project, sessionId, errorText } = {}) {
    const t0 = Date.now();
    const empty = (reason, extra) => ({
      related: [], reason, seedCount: 0, durationMs: Date.now() - t0, ...(extra || {}),
    });

    if (!settings.enabled) return empty('disabled');
    if (!configured) return empty('not_configured');
    if (state.supported === false) return empty('unsupported');

    const seeds = selectSeeds({ hit, memories, maxSeeds: settings.maxSeeds });
    if (seeds.length === 0) return empty('no_solved_problem_seeds');

    const seedIds = seeds.map((s) => s.id);

    // Hash the LIVE error through the vendored I3 normalizer, so a neighbor
    // that carries the same `symptom_hash` is provably the same error rather
    // than merely a near neighbor in embedding space. Never throws
    // (`problemLookupKey` swallows its own errors and returns null) and never
    // gates — a null key just means matches fall back to seed-derived.
    let lookupKey = null;
    if (problemSignatureCore && typeof errorText === 'string' && errorText.trim()) {
      lookupKey = problemSignatureCore.problemLookupKey(errorText) || null;
    }

    let res;
    try {
      res = await callRpc({
        [CONTRACT.params.seedIds]: seedIds,
        [CONTRACT.params.predicates]: EXPANSION_PREDICATES,
        [CONTRACT.params.maxDepth]: settings.maxDepth,
        [CONTRACT.params.maxRows]: settings.maxRows,
        // T1's §1 clarification (confirmed): `p_project` filters the RETURNED
        // node only — a path may route through another project to reach an
        // in-project neighbor. That is the semantics I want; see the
        // crossProject note in resolveExpansionSettings for why the filter is
        // applied at all by default.
        [CONTRACT.params.project]: settings.crossProject ? null : (project || null),
      }, settings.timeoutMs);
    } catch (err) {
      // Abort (timeout) and transport failures are transient — do NOT latch
      // the capability off for them, or one slow night permanently disables
      // the feature for the process.
      const message = err && err.name === 'AbortError'
        ? `timeout after ${settings.timeoutMs}ms`
        : (err && err.message) || String(err);
      state.lastError = message;
      console.warn(`[graph-expansion] call failed (fail-open): ${message}`);
      return { ...empty('error'), seedCount: seeds.length, error: message };
    }

    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      let text = '';
      try { text = res && typeof res.text === 'function' ? await res.text() : ''; } catch (_e) { /* body already consumed */ }
      // The one durable verdict: PostgREST answers 404 "Could not find the
      // function" when migration 034 has not been applied. Latch off so a
      // pre-034 store pays exactly one wasted round-trip, ever — the same
      // deal the bridge's p_decay_profile probe strikes.
      if (status === 404 && /could not find the function/i.test(text || '')) {
        state.supported = false;
        console.log('[graph-expansion] memory_expand_typed absent (pre-034 store) — typed expansion disabled for this process');
        return { ...empty('unsupported'), seedCount: seeds.length };
      }
      state.lastError = `HTTP ${status}`;
      console.warn(`[graph-expansion] RPC returned ${status} (fail-open)`);
      return { ...empty('error'), seedCount: seeds.length, error: `HTTP ${status}` };
    }

    state.supported = true;

    let rows;
    try {
      rows = await res.json();
    } catch (err) {
      state.lastError = 'unparseable response';
      return { ...empty('error'), seedCount: seeds.length, error: 'unparseable response' };
    }

    const related = shapeExpansion(rows, {
      seedIds,
      seeds,
      lookupKey,
      excludeIds: hit && hit.id ? [hit.id] : [],
      maxRows: settings.maxRows,
    });

    if (sessionId && related.length > 0) {
      console.log(`[graph-expansion] ${related.length} graph-derived neighbor(s) for session ${sessionId} from ${seeds.length} seed(s) (depth<=${settings.maxDepth})`);
    }

    return {
      related,
      reason: related.length > 0 ? 'ok' : 'no_edges',
      seedCount: seeds.length,
      durationMs: Date.now() - t0,
    };
  }

  return {
    expand,
    available,
    settings,
    // Test/diagnostic surface only.
    _state: state,
  };
}

module.exports = {
  createExpander,
  resolveExpansionSettings,
  selectSeeds,
  shapeExpansion,
  relationLabel,
  problemSignatureOf,
  problemClassOf,
  symptomHashOf,
  isSolvedProblemClass,
  CONTRACT,
  EXPANSION_PREDICATES,
  SOLVED_PROBLEM_SOURCE_TYPES,
  SOLVED_PROBLEM_CATEGORIES,
  PROBLEM_SIGNATURE_KEY,
  DEFAULTS,
  LIMITS,
};
