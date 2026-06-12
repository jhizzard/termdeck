'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// memory_propose — the Bridge's ONE quarantined write channel (Sprint 76).
//
// "CLIs write canonical; web chats write proposals." A consumer chat may submit
// a memory PROPOSAL which lands in engram's `memory_inbox` (status='pending',
// invisible to every recall path) via the webhook 'propose' op. It is promoted
// to canonical memory — or rejected — later, by Rumen's asynchronous gates.
// This tool can never touch memory_items.
//
// THE INVERTED-INVERTED THREAT MODEL. redact.js exists because tool RESULTS
// egress through the provider cloud. A proposal is the reverse: INGRESS that —
// if promoted — will later egress into every CLI session via recall. So the
// proposal is scanned with the SAME rule set (external literal denylist +
// built-in secret patterns) BEFORE it is forwarded, and the policy is REJECT,
// not scrub-and-forward: a silently-sanitized memory is a corrupted memory;
// the proposer should rephrase. Rejection reasons name only the RULE CLASS,
// never the matched text (we will not echo a secret back through the provider
// cloud).
//
// Pipeline (each stage fail-closed): server-derived connector identity →
// size caps → per-connector rate limit → ingress secret scan → forward.
// `source_agent` is NEVER caller-supplied: it derives from the per-request
// OAuth client (explicit operator map, else a conservative client_name
// heuristic), and an unmappable client is refused outright.
//
// House conventions: descriptor shape matches ./memory.js; policy fns and the
// identity source are INJECTED (this module requires only ./util and the
// dependency-free ../redact), so it loads and unit-tests with no node_modules.
// ─────────────────────────────────────────────────────────────────────────────

const { toolError, ok } = require('./util');
const { scanDeep } = require('../redact');

// Caps — mirror engram T1's webhook/RPC caps at the bridge boundary so a
// too-big proposal fails fast with a friendly error before any network hop.
// (T1's SQL validation remains the authoritative gate; these match it.)
const TEXT_MAX_CHARS = 4000; // post-trim
const PROJECT_HINT_MAX_CHARS = 128;
const METADATA_MAX_BYTES = 8192; // serialized JSON, INCLUDING the bridge provenance stamp

function posNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── per-connector token bucket ───────────────────────────────────────────────

// Keyed on the resolved OAuth client_id. Defaults: 10 proposals/hour with a
// burst of 3 (env-tunable). In-memory state is acceptable: a single bridge
// process serves all sessions, and client_ids are operator-consented (DCR
// tokens require the consent secret) so the key space is small. Under
// multi-origin HA each origin keeps its own buckets — accepted; the DB-side
// caps in the Rumen promotion pass (T3) are the durable backstop.
function createProposeRateLimiter({ ratePerHour = 10, burst = 3, now = Date.now } = {}) {
  const buckets = new Map(); // client_id -> { tokens, last }
  function check(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: burst, last: t };
      buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, t - b.last);
      b.tokens = Math.min(burst, b.tokens + (elapsed / 3_600_000) * ratePerHour);
      b.last = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const retryAfterSec = Math.max(1, Math.ceil(((1 - b.tokens) * 3_600_000) / ratePerHour / 1000));
    return { ok: false, retryAfterSec };
  }
  return { check, _buckets: buckets };
}

function retryWindow(sec) {
  return sec > 90 ? `~${Math.ceil(sec / 60)} minutes` : `~${sec}s`;
}

// ── caps ─────────────────────────────────────────────────────────────────────

// Validate + normalize the proposal fields. Returns { ok:true, value } with
// { text, projectHint } trimmed, or { ok:false, reason } with a friendly,
// secret-free reason. `metadata` here is the FINAL object that will cross the
// wire (caller metadata + bridge stamp), so the byte cap measures reality.
function checkProposalCaps({ text, projectHint, metadata } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'text is required and must be a non-empty string' };
  }
  const t = text.trim();
  if (t.length > TEXT_MAX_CHARS) {
    return { ok: false, reason: `text exceeds the ${TEXT_MAX_CHARS}-character cap (got ${t.length} after trim); shorten the proposal` };
  }
  let ph;
  if (projectHint != null) {
    if (typeof projectHint !== 'string') {
      return { ok: false, reason: 'project must be a string when provided' };
    }
    ph = projectHint.trim();
    if (ph.length > PROJECT_HINT_MAX_CHARS) {
      return { ok: false, reason: `project exceeds the ${PROJECT_HINT_MAX_CHARS}-character cap (got ${ph.length})` };
    }
    if (!ph) ph = undefined;
  }
  if (metadata != null) {
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { ok: false, reason: 'metadata must be a plain JSON object when provided' };
    }
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
    } catch {
      return { ok: false, reason: 'metadata is not JSON-serializable' };
    }
    if (bytes > METADATA_MAX_BYTES) {
      return { ok: false, reason: `metadata exceeds the ${METADATA_MAX_BYTES}-byte cap (got ${bytes} bytes serialized, including the bridge provenance stamp)` };
    }
  }
  return { ok: true, value: { text: t, projectHint: ph } };
}

// ── the tool ─────────────────────────────────────────────────────────────────

// buildProposeTools({ clients, identity, policy, env?, now? }) → [descriptor].
//   identity : { getClient(clientId) -> Promise<clientRecord|undefined> } — the
//              OAuth clients store (server bootstrap wires it from auth).
//   policy   : must provide mapClientToSourceAgent + loadProposeMap (the
//              caller — tools/index.js — gates mounting on this, fail-closed).
function buildProposeTools({ clients, identity, policy, env, now } = {}) {
  if (!clients || !clients.mnestra || typeof clients.mnestra.propose !== 'function') {
    throw new Error('buildProposeTools requires clients.mnestra.propose');
  }
  if (!identity || typeof identity.getClient !== 'function') {
    throw new Error('buildProposeTools requires an identity source ({ getClient })');
  }
  if (!policy || typeof policy.mapClientToSourceAgent !== 'function' || typeof policy.loadProposeMap !== 'function') {
    throw new Error('buildProposeTools requires policy.{mapClientToSourceAgent,loadProposeMap}');
  }
  const environ = () => env || process.env;
  const limiter = createProposeRateLimiter({
    ratePerHour: posNum(environ().TERMDECK_BRIDGE_PROPOSE_RATE_PER_HOUR, 10),
    burst: Math.max(1, Math.floor(posNum(environ().TERMDECK_BRIDGE_PROPOSE_BURST, 3))),
    now,
  });

  return [
    {
      name: 'memory_propose',
      title: 'Propose memory',
      description:
        "Submit a memory PROPOSAL to the developer's Mnestra memory inbox (a quarantine). "
        + 'This does NOT write to canonical memory: proposals are reviewed asynchronously by an '
        + 'automated promotion pass (dedup, redaction, quality gates), MAY BE REJECTED, and do '
        + 'not appear in memory_recall/memory_search unless and until promoted — minutes later '
        + 'at the earliest. Never claim a proposal has been "saved to memory"; say it has been '
        + 'proposed for review. Proposals containing secrets or denylisted literals are refused.',
      inputSchema: (z) => ({
        text: z.string().describe(
          `The proposed memory (≤ ${TEXT_MAX_CHARS} chars). Durable, kitchen-level facts/decisions/preferences — not chat ephemera.`,
        ),
        project: z.string().optional().describe(
          `Optional project slug hint (≤ ${PROJECT_HINT_MAX_CHARS} chars; advisory — the review pass may re-map it).`,
        ),
        metadata: z.record(z.string(), z.any()).optional().describe(
          `Optional JSON object of context (e.g. conversation topic). ≤ ${METADATA_MAX_BYTES} bytes serialized.`,
        ),
      }),
      // HONEST annotations — verified exact by policy.assertReadOnly's
      // PROPOSE_TOOLS carve-out: this tool really does write (to quarantine),
      // destroys nothing, appends a fresh proposal per call, and talks to an
      // external system. server.js's registerTools preserves these (it skips
      // the readOnlyHint:true stamp for PROPOSE_TOOLS members only).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Propose memory' },
      approval: true, // authoritative via policy.requiresApproval('memory_propose') → true
      handler: async (args, extra) => {
        try {
          // 1) Connector identity — server-derived, fail-closed. Any
          // caller-supplied args.source_agent is deliberately ignored: a web
          // chat must not be able to claim another surface or a CLI identity.
          const authInfo = (extra && extra.authInfo) || null;
          const clientId = authInfo && authInfo.clientId ? String(authInfo.clientId) : '';
          if (!clientId) {
            return toolError('memory_propose', new Error(
              'could not derive connector identity (no authenticated client on this request); proposal refused',
            ));
          }
          let clientRecord = null;
          try {
            clientRecord = await identity.getClient(clientId);
          } catch {
            clientRecord = null; // unresolvable record → heuristic has no name → fail closed below
          }
          const clientName = clientRecord && clientRecord.client_name ? String(clientRecord.client_name) : '';
          const sourceAgent = policy.mapClientToSourceAgent({
            clientId,
            clientName,
            map: policy.loadProposeMap(environ()),
          });
          if (!sourceAgent) {
            return toolError('memory_propose', new Error(
              `connector identity is not mapped to a web source agent (client_id "${clientId}"`
              + `${clientName ? `, client_name "${clientName}"` : ''}). The operator must add it to `
              + '~/.termdeck/bridge-propose.json {"clients":{"<client_id>":"claude-web|chatgpt-web|grok-web|gemini-web"}} '
              + 'or TERMDECK_BRIDGE_PROPOSE_MAP. Proposal refused (identity is never defaulted).',
            ));
          }

          // 2) Caps — on the FINAL payload, including the bridge provenance
          // stamp (T1's metadata column expects connector attribution only the
          // bridge can supply; a caller-supplied `bridge` key is overwritten,
          // so the stamp cannot be spoofed).
          const callerMeta = args && args.metadata != null ? args.metadata : undefined;
          let metadata;
          if (callerMeta !== undefined && (typeof callerMeta !== 'object' || Array.isArray(callerMeta))) {
            return toolError('memory_propose', new Error('metadata must be a plain JSON object when provided'));
          }
          metadata = {
            ...(callerMeta || {}),
            bridge: { client_id: clientId, client_name: clientName || null, source_agent: sourceAgent },
          };
          const caps = checkProposalCaps({
            text: args && args.text,
            projectHint: args && args.project,
            metadata,
          });
          if (!caps.ok) return toolError('memory_propose', new Error(caps.reason));

          // 3) Per-connector rate limit (after caps so oversize spam is free
          // to refuse; before the scan so the regex pass is throttled — and a
          // secret-laden proposal still consumes the proposer's budget).
          const rl = limiter.check(clientId);
          if (!rl.ok) {
            return toolError('memory_propose', new Error(
              `rate limit exceeded for this connector (default 10 proposals/hour, burst 3); retry in ${retryWindow(rl.retryAfterSec)}`,
            ));
          }

          // 4) Ingress secret scan over the exact forward payload. REJECT, do
          // not scrub. The reason names rule CLASSES only — never the matched
          // text, which must not echo back through the provider cloud.
          const payload = { text: caps.value.text, project_hint: caps.value.projectHint, metadata };
          const scanRes = scanDeep(payload, { env: environ() });
          if (!scanRes.clean) {
            const classes = scanRes.hits.map((h) => h.name).join(', ');
            return toolError('memory_propose', new Error(
              `proposal contains material matching secret/denylist rule class(es): ${classes}. `
              + 'Refused (never stored, never scrubbed-and-forwarded) — remove the sensitive material and rephrase.',
            ));
          }

          // 5) Forward to the quarantined inbox.
          const { id, status } = await clients.mnestra.propose({
            sourceAgent,
            text: caps.value.text,
            projectHint: caps.value.projectHint,
            metadata,
          });
          return ok(
            `Proposal accepted into the memory inbox as ${sourceAgent} — QUARANTINED PENDING REVIEW (id: ${id}, status: ${status}). `
            + 'It is NOT part of canonical memory: an asynchronous review pass will promote or reject it, '
            + 'and it will not appear in memory_recall/memory_search unless promoted. '
            + 'Tell the user it has been proposed for review — not "saved to memory".',
            { id, status, source_agent: sourceAgent },
          );
        } catch (err) {
          return toolError('memory_propose', err);
        }
      },
    },
  ];
}

module.exports = {
  buildProposeTools,
  createProposeRateLimiter,
  checkProposalCaps,
  TEXT_MAX_CHARS,
  PROJECT_HINT_MAX_CHARS,
  METADATA_MAX_BYTES,
};
