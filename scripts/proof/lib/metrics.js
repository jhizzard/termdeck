'use strict';

// scripts/proof/lib/metrics.js — the mechanical measurement + verdict core.
//
// Everything here is a PURE function of (probe, recall output, arm answers).
// No LLM judgement, no I/O, no randomness. That is deliberate: the "did recall
// change the work" question is reduced to a grep for a memory-resident fact
// (`factKey`), so the verdict cannot be fudged and an auditor (T8) can recompute
// it from the same inputs and get the same answer.
//
// Verdict space (reported for EVERY probe — nothing is filtered):
//   warm-wins  : cold answer LACKS factKey, warm answer HAS it  → recall changed the work
//   cold-wins  : cold HAS, warm LACKS                           → regression (should ~never happen)
//   no-delta   : both HAVE (fact wasn't memory-exclusive) or    → recall didn't change the outcome
//                both LACK (recall/answerer didn't surface it)
//
// Reporting no-delta and cold-wins honestly is the whole anti-cherry-pick
// guarantee. A harness that only counted warm-wins would be unfalsifiable.

const { measureReinjection } = require('./tokens');

/** lowercase + collapse whitespace — the comparison normal form. */
function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Does `answerText` contain the memory-resident fact described by `factKey`?
 * factKey forms (all case-insensitive, whitespace-normalized):
 *   "literal string"           → substring match
 *   { regex: "...", flags }    → RegExp test against the RAW answer
 *   { any: [ factKey, ... ] }  → at least one matches
 *   { all: [ factKey, ... ] }  → every one matches
 * Fail-closed: anything malformed → false (never a false "present").
 */
function factPresent(answerText, factKey) {
  const raw = typeof answerText === 'string' ? answerText : '';
  if (factKey == null) return false;
  if (typeof factKey === 'string') {
    if (!factKey.trim()) return false;
    return normalize(raw).includes(normalize(factKey));
  }
  if (Array.isArray(factKey)) {
    // bare array == "all" (every element must be present)
    return factKey.length > 0 && factKey.every((k) => factPresent(raw, k));
  }
  if (typeof factKey === 'object') {
    if (Array.isArray(factKey.any)) return factKey.any.some((k) => factPresent(raw, k));
    if (Array.isArray(factKey.all)) return factKey.all.length > 0 && factKey.all.every((k) => factPresent(raw, k));
    if (typeof factKey.regex === 'string') {
      try {
        return new RegExp(factKey.regex, factKey.flags || 'i').test(raw);
      } catch {
        return false; // bad pattern → not present (never throws into the run)
      }
    }
  }
  return false;
}

/** Human-readable rendering of a factKey for the report table. */
function describeFactKey(factKey) {
  if (factKey == null) return '(none)';
  if (typeof factKey === 'string') return `"${factKey}"`;
  if (Array.isArray(factKey)) return `all of [${factKey.map(describeFactKey).join(', ')}]`;
  if (typeof factKey === 'object') {
    if (Array.isArray(factKey.any)) return `any of [${factKey.any.map(describeFactKey).join(', ')}]`;
    if (Array.isArray(factKey.all)) return `all of [${factKey.all.map(describeFactKey).join(', ')}]`;
    if (typeof factKey.regex === 'string') return `/${factKey.regex}/${factKey.flags || 'i'}`;
  }
  return '(unrecognized)';
}

/** { source_type: count } over the returned hits. */
function sourceTypeMix(hits) {
  const mix = {};
  for (const h of Array.isArray(hits) ? hits : []) {
    const t = h && h.source_type != null ? String(h.source_type) : 'unknown';
    mix[t] = (mix[t] || 0) + 1;
  }
  return mix;
}

/** Sum two source_type-mix objects into a new one. */
function mergeMix(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** Format a mix object compactly: "decision 3, fact 2, doctrine 1". */
function formatMix(mix) {
  const entries = Object.entries(mix || {}).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(', ') : '(none)';
}

function verdictFor(coldHasFact, warmHasFact) {
  if (warmHasFact && !coldHasFact) return 'warm-wins';
  if (coldHasFact && !warmHasFact) return 'cold-wins';
  return 'no-delta';
}

// Provenance is either (a) what T1's migration 031 memory_recall_log captured
// for this recall (preferred — proves the real telemetry path) or (b) what the
// harness supplied as an explicit caller (proves the plumbing when the panel
// path can't yet, per T7 17:02 / T1 G2). Either way we report exactly what we
// have and flag NULLs rather than papering over them.
function extractProvenance(recall) {
  const log = (recall && recall.log) || {};
  const sid = log.source_session_id != null ? log.source_session_id : null;
  const agent = log.source_agent != null ? log.source_agent : null;
  return {
    recall_group_id: log.recall_group_id != null ? log.recall_group_id : null,
    source_session_id: sid,
    source_agent: agent,
    token_budget: log.token_budget != null ? log.token_budget : null,
    origin: log.origin || (sid || agent ? 'recall_log' : 'unattributed'),
    attributed: !!(sid || agent),
  };
}

/**
 * The full per-probe result. `coldAnswer`/`warmAnswer` are { text } from the
 * answerer; `recall` is the RecallOutput-shaped object for the WARM arm.
 */
function computeProbeResult({ probe, recall, coldAnswer, warmAnswer }) {
  const hits = (recall && recall.hits) || [];
  const measure = measureReinjection(recall || {});
  const coldText = (coldAnswer && coldAnswer.text) || '';
  const warmText = (warmAnswer && warmAnswer.text) || '';
  const coldHasFact = factPresent(coldText, probe.factKey);
  const warmHasFact = factPresent(warmText, probe.factKey);
  const verdict = verdictFor(coldHasFact, warmHasFact);
  const noDeltaReason = verdict === 'no-delta'
    ? (warmHasFact ? 'both-have' : 'both-lack')
    : null;
  return {
    id: probe.id,
    query: probe.query,
    project: probe.project || null,
    rationale: probe.rationale || '',
    factKey: describeFactKey(probe.factKey),
    rowsSurfaced: hits.length,
    tokensReinjected: measure.tokens_used,
    tokensReinjectedSource: measure.tokens_used_source,
    tokensReinjectedBlock: measure.block_tokens,
    reinjectionChars: measure.chars,
    sourceTypeMix: sourceTypeMix(hits),
    provenance: extractProvenance(recall),
    reinjectionText: (recall && recall.text) || '',
    coldAnswer: coldText,
    warmAnswer: warmText,
    coldHasFact,
    warmHasFact,
    verdict,
    noDeltaReason,
    hits: hits.map((h, i) => ({
      id: h.id, source_type: h.source_type, project: h.project,
      score: h.score, rank: i + 1,
    })),
  };
}

/** Whole-run rollup. Honest by construction: counts EVERY result. */
function aggregate(results) {
  const list = Array.isArray(results) ? results : [];
  let warmWins = 0, coldWins = 0, noDelta = 0, bothHave = 0, bothLack = 0, errors = 0;
  let totalRows = 0, totalTokens = 0, totalBlockTokens = 0;
  let mix = {};
  let attributed = 0;
  for (const r of list) {
    if (r.verdict === 'error') { errors++; continue; } // a failed probe has no verdict; never counted as no-delta
    if (r.verdict === 'warm-wins') warmWins++;
    else if (r.verdict === 'cold-wins') coldWins++;
    else {
      noDelta++;
      if (r.noDeltaReason === 'both-have') bothHave++;
      else bothLack++;
    }
    totalRows += r.rowsSurfaced || 0;
    totalTokens += r.tokensReinjected || 0;
    totalBlockTokens += r.tokensReinjectedBlock || 0;
    mix = mergeMix(mix, r.sourceTypeMix);
    if (r.provenance && r.provenance.attributed) attributed++;
  }
  const scored = list.length - errors;
  return {
    probes: list.length,
    scored,
    errors,
    warmWins, coldWins, noDelta, bothHave, bothLack,
    totalRowsSurfaced: totalRows,
    totalTokensReinjected: totalTokens,
    totalTokensReinjectedBlock: totalBlockTokens,
    sourceTypeMix: mix,
    provenanceAttributed: attributed,
    honestyNote:
      `${list.length} probes run (${scored} scored, ${errors} errored); every probe is reported regardless of verdict (no filtering). ` +
      `warm-wins=${warmWins}, no-delta=${noDelta} (both-have=${bothHave}, both-lack=${bothLack}), cold-wins=${coldWins}.`,
  };
}

/**
 * Boost-mode (axis 2) helper: the ranking delta between a recall with
 * recall_boost inert (1.0) and one with boost applied. Parks until T1's 032 +
 * T2's population land; wired now so the boost run is a config flip for ORCH.
 */
function rankDelta(recallOff, recallOn) {
  const off = ((recallOff && recallOff.hits) || []).map((h) => h.id);
  const on = ((recallOn && recallOn.hits) || []).map((h) => h.id);
  const offSet = new Set(off);
  const onSet = new Set(on);
  const entered = on.filter((id) => !offSet.has(id));       // surfaced only with boost
  const left = off.filter((id) => !onSet.has(id));          // dropped out with boost
  const offRank = new Map(off.map((id, i) => [id, i + 1]));
  const onRank = new Map(on.map((id, i) => [id, i + 1]));
  const moved = [];
  for (const id of on) {
    if (offRank.has(id) && offRank.get(id) !== onRank.get(id)) {
      moved.push({ id, from: offRank.get(id), to: onRank.get(id) });
    }
  }
  const union = new Set([...off, ...on]);
  const inter = off.filter((id) => onSet.has(id)).length;
  const jaccard = union.size ? inter / union.size : 1;
  return { entered, left, moved, jaccard };
}

module.exports = {
  normalize,
  factPresent,
  describeFactKey,
  sourceTypeMix,
  mergeMix,
  formatMix,
  verdictFor,
  extractProvenance,
  computeProbeResult,
  aggregate,
  rankDelta,
};
