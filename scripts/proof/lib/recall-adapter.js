'use strict';

// scripts/proof/lib/recall-adapter.js — pluggable "how do we run a recall".
//
// Two adapters, one interface:
//
//   fixture — reads a canned RecallOutput from scripts/proof/fixtures/recall/.
//             Deterministic, offline, zero-credential. This is what the unit
//             tests and any auditor (T8) use to reproduce a run bit-for-bit.
//
//   http    — POSTs { op:'recall', ... } to the live Mnestra webhook
//             (engram/src/webhook-server.ts:145-163 → { ok, hits, tokens_used,
//             text }) and supplies source_session_id / source_agent so the
//             recall lands NON-NULL provenance in migration 031's
//             memory_recall_log. ORCH runs this at close-out; a worker lane
//             never fires it (file-only discipline).
//
// The interface both satisfy:
//   adapter.recall(probe, { variant, sessionId, sourceAgent }) -> Promise<{
//     hits: [{ id, content, source_type, project, score, metadata? }],
//     tokens_used: number,
//     text: string,                 // the reinjection block, verbatim
//     log: {                        // provenance (migration 031 shape)
//       recall_group_id, source_session_id, source_agent, token_budget, origin
//     }
//   }>
//
// `variant` selects which recall to run: 'warm' (recall-ON, the headline arm),
// 'boost-off' / 'boost-on' (axis-2 recall_boost A/B, parks on T1 032 + T2).
// The COLD arm never calls recall — it is the absence of reinjection.

const fs = require('fs');
const path = require('path');

const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'recall');

function fixtureFileFor(dir, probeId, variant) {
  const v = variant || 'warm';
  const withVariant = path.join(dir, `${probeId}.${v}.json`);
  if (fs.existsSync(withVariant)) return withVariant;
  // 'warm' is the default variant → allow the bare <id>.json form too.
  const bare = path.join(dir, `${probeId}.json`);
  if (v === 'warm' && fs.existsSync(bare)) return bare;
  return withVariant; // return the canonical name so the error message is useful
}

function makeFixtureAdapter({ dir = DEFAULT_FIXTURE_DIR } = {}) {
  return {
    name: `fixture(${path.relative(process.cwd(), dir) || dir})`,
    live: false,
    async recall(probe, { variant = 'warm' } = {}) {
      const file = fixtureFileFor(dir, probe.id, variant);
      if (!fs.existsSync(file)) {
        // Fail LOUD, not soft: a missing recall fixture would silently produce
        // an empty warm arm and fake a "no-delta". A proof must never degrade
        // to a false negative in silence.
        throw new Error(`[proof] recall fixture not found: ${file} (probe "${probe.id}", variant "${variant}")`);
      }
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`[proof] recall fixture is not valid JSON: ${file}: ${err.message}`);
      }
      const hits = Array.isArray(raw.hits) ? raw.hits : [];
      return {
        hits,
        tokens_used: Number.isFinite(raw.tokens_used) ? raw.tokens_used : null,
        text: typeof raw.text === 'string' ? raw.text : '',
        log: raw.log || {
          recall_group_id: null,
          source_session_id: null,
          source_agent: null,
          token_budget: probe.token_budget || null,
          origin: 'fixture(no-log)',
        },
      };
    },
  };
}

function selectHeader(env) {
  const name = (env.TERMDECK_PROOF_RECALL_HEADER || 'authorization').toLowerCase();
  const key = env.TERMDECK_PROOF_RECALL_KEY || '';
  if (!key) return {};
  const value = name === 'authorization' ? `Bearer ${key}` : key;
  return { [name]: value };
}

function makeHttpAdapter({ env = process.env } = {}) {
  const url = env.TERMDECK_PROOF_RECALL_URL || '';
  const eventsUrl = env.TERMDECK_PROOF_RECALL_EVENTS_URL || ''; // optional: T4's /api/recall-events
  return {
    name: `http(${url || '<TERMDECK_PROOF_RECALL_URL unset>'})`,
    live: true,
    async recall(probe, { variant = 'warm', sessionId = null, sourceAgent = null } = {}) {
      if (!url) {
        throw new Error('[proof] http recall adapter needs TERMDECK_PROOF_RECALL_URL (the Mnestra webhook, e.g. http://127.0.0.1:37778/mnestra)');
      }
      const body = {
        op: 'recall',
        query: probe.query,
        project: probe.project || null,
        token_budget: probe.token_budget || undefined,
        min_results: probe.min_results || undefined,
        // Explicit caller provenance — the whole point of the http path. The
        // webhook threads these into migration 031's memory_recall_log
        // (webhook-server.ts:157-159), so the recall is attributable.
        source_session_id: sessionId,
        source_agent: sourceAgent,
        // Axis-2 hook: once T1's 032 + T2 land, boost-off/on is a request knob
        // (or two live states). Passed through for the live endpoint to honor.
        recall_boost: variant === 'boost-off' ? 'off' : variant === 'boost-on' ? 'on' : undefined,
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...selectHeader(env) },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        throw new Error(`[proof] recall webhook error (${res.status}): ${json.error || res.statusText}`);
      }
      const out = {
        hits: Array.isArray(json.hits) ? json.hits : [],
        tokens_used: Number.isFinite(json.tokens_used) ? json.tokens_used : null,
        text: typeof json.text === 'string' ? json.text : '',
        // We report what we KNOW we sent (caller-supplied); recall_group_id is
        // server-generated and not echoed by the fire-and-forget webhook, so it
        // stays null unless the optional events lookup below fills it in.
        log: {
          recall_group_id: null,
          source_session_id: sessionId,
          source_agent: sourceAgent,
          token_budget: probe.token_budget || null,
          origin: sessionId || sourceAgent ? 'caller-supplied' : 'unattributed',
        },
      };
      // Optional upgrade: if T4's /api/recall-events is reachable, fetch the
      // just-written rows for this session and confirm recall_group_id +
      // per-row source_type from the ACTUAL log (strongest attribution). Purely
      // additive — a failure here never fails the recall.
      if (eventsUrl && sessionId) {
        try {
          const evRes = await fetch(`${eventsUrl}/${encodeURIComponent(sessionId)}?limit=50`, {
            headers: { ...selectHeader(env) },
          });
          const ev = await evRes.json().catch(() => ({}));
          const rows = (ev && (ev.events || ev.rows || ev.data)) || [];
          if (Array.isArray(rows) && rows.length) {
            const groups = [...new Set(rows.map((r) => r.recallGroupId).filter(Boolean))];
            if (groups.length) out.log.recall_group_id = groups[groups.length - 1];
            out.log.origin = 'recall_log';
          }
        } catch {
          // additive only — keep the caller-supplied provenance
        }
      }
      return out;
    },
  };
}

/**
 * makeRecallAdapter('fixture' | 'fixture:<dir>' | 'http' | 'http:<url>', opts)
 * Defaults to the fixture adapter (offline, safe) so an accidental bare run
 * never touches the live store.
 */
function makeRecallAdapter(spec = 'fixture', { env = process.env } = {}) {
  const s = String(spec || 'fixture').trim();
  if (s === 'fixture') return makeFixtureAdapter({});
  if (s.startsWith('fixture:')) return makeFixtureAdapter({ dir: path.resolve(s.slice('fixture:'.length)) });
  if (s === 'http') return makeHttpAdapter({ env });
  // A full URL as the spec (or 'http:<url>') overrides TERMDECK_PROOF_RECALL_URL.
  if (s.startsWith('http://') || s.startsWith('https://')) {
    return makeHttpAdapter({ env: { ...env, TERMDECK_PROOF_RECALL_URL: s } });
  }
  if (s.startsWith('http:')) {
    const url = s.slice('http:'.length);
    return makeHttpAdapter({ env: { ...env, TERMDECK_PROOF_RECALL_URL: url || env.TERMDECK_PROOF_RECALL_URL } });
  }
  throw new Error(`[proof] unknown recall adapter spec: "${spec}" (use fixture | fixture:<dir> | http | http:<url>)`);
}

module.exports = {
  DEFAULT_FIXTURE_DIR,
  fixtureFileFor,
  makeFixtureAdapter,
  makeHttpAdapter,
  makeRecallAdapter,
};
