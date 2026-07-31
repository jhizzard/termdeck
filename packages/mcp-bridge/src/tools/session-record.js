'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// memory_session_record — end-of-conversation capture for web surfaces
// (Sprint 84 T2). The WEB equivalent of the panel-close path.
//
// A CLI panel that closes gets a `memory_sessions` row from the bundled
// SessionEnd hook, and the Rumen tick sweeps unprocessed rows into synthesized
// insights. A web chat has no panel and no hook, so its conversations never
// entered that loop at all. This tool lets a connected web surface file one
// end-of-conversation summary into the same queue.
//
// WHY THIS IS NOT A CANONICAL WRITE. `memory_propose` (Sprint 76) exists
// because web content must not reach `memory_items`, which recall reads
// directly. `memory_sessions` is read by NO recall path — it is the Rumen
// tick's input queue, and that tick's extract → relate → synthesize pass is
// itself a gate. Nothing filed here becomes recallable without passing through
// it. So this is a second quarantined channel, not a hole in the first one.
//
// Pipeline, each stage fail-closed and IDENTICAL to propose.js's:
//   server-derived connector identity → size caps → per-connector rate limit
//   → ingress secret scan → forward.
// `source_agent` is NEVER caller-supplied: it derives from the per-request
// OAuth client, and an unmappable client is refused outright.
//
// TWO THINGS THIS TOOL DELIBERATELY DOES NOT DO:
//   1. It never sends a session_id. Mnestra MINTS it as
//      `web:<source_agent>:<conversation_key>`, which is what stops a web
//      caller addressing — and overwriting — a CLI-written session row. A
//      caller-supplied session_id would hand that guard away.
//   2. It never inflates `messages_count` to clear the Rumen sweep floor.
//      A short conversation is reported back as "recorded but below the sweep
//      floor" rather than being quietly rewritten into a longer one; lying to
//      the learning loop about its own inputs is worse than a skipped row.
//
// House conventions: descriptor shape matches ./memory.js and ./propose.js;
// policy fns and the identity source are INJECTED (this module requires only
// ./util and the dependency-free ../redact), so it loads and unit-tests with
// no node_modules.
// ─────────────────────────────────────────────────────────────────────────────

const { toolError, ok } = require('./util');
const { scanDeep } = require('../redact');

// Caps — mirror mnestra's memory_session_record RPC caps at the bridge
// boundary so an oversize record fails fast with a friendly error before any
// network hop. (The SQL RPC remains the authoritative gate; these match it.)
const SUMMARY_MAX_CHARS = 8000;
const CONVERSATION_KEY_MAX_CHARS = 200;
const PROJECT_MAX_CHARS = 128;
const TOPICS_MAX = 20;
const TOPIC_MAX_CHARS = 80;
const METADATA_MAX_BYTES = 8192; // serialized JSON, INCLUDING the bridge provenance stamp

// Mirrors the RPC's charset gate. The conversation key is the only
// caller-controlled component of the minted session_id.
const CONVERSATION_KEY_RE = /^[A-Za-z0-9._:@-]+$/;

// Rumen's picker floor: `COALESCE(messages_count,0) >= minEventCount`, whose
// default is 3 (rumen/src/index.ts DEFAULT_MIN_EVENT_COUNT). Nothing here
// enforces it — it is reported, so a caller understands why a two-turn chat
// will not produce insights. If the operator tunes Rumen's floor, this number
// only affects the wording of the success message, never what is stored.
const RUMEN_SWEEP_MIN_MESSAGES = 3;

function posNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── per-connector token bucket ───────────────────────────────────────────────

// Same shape as propose.js's limiter but a SEPARATE bucket set: sharing
// propose's would let a burst of session records starve the proposal channel
// (and vice versa).
//
// On the numbers: a session record is one-per-conversation, which invites a
// very tight default — but the bucket is keyed on the OAuth **client_id**, and
// one client_id serves EVERY conversation on that surface. A tight burst
// therefore does not throttle a chatty conversation, it throttles a busy hour.
// At the burst-2 / 6-per-hour first draft of this file, the end-to-end harness
// hit the ceiling on its THIRD legitimate call and the amend path could not
// even be exercised — which is exactly what a real operator's third chat of
// the hour would have run into. 12/hour with a burst of 4 leaves normal
// multi-conversation use alone while still capping a runaway connector, and
// the durable backstops are downstream anyway: the RPC refuses to touch
// another agent's row or an already-swept one, so the worst an accepted burst
// buys is a few extra rows in the learning queue.
function createSessionRecordRateLimiter({ ratePerHour = 12, burst = 4, now = Date.now } = {}) {
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

function isIsoish(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  return Number.isFinite(Date.parse(v));
}

// ── caps ─────────────────────────────────────────────────────────────────────

// Validate + normalize the record fields. Returns { ok:true, value } with the
// trimmed/normalized payload, or { ok:false, reason } with a friendly,
// secret-free reason. `metadata` here is the FINAL object that will cross the
// wire (caller metadata + bridge stamp), so the byte cap measures reality.
function checkSessionRecordCaps({
  conversationKey, summary, project, messagesCount, startedAt, endedAt, topics, metadata,
} = {}) {
  if (typeof conversationKey !== 'string' || !conversationKey.trim()) {
    return { ok: false, reason: 'conversation_key is required and must be a non-empty string' };
  }
  const key = conversationKey.trim();
  if (key.length > CONVERSATION_KEY_MAX_CHARS) {
    return { ok: false, reason: `conversation_key exceeds the ${CONVERSATION_KEY_MAX_CHARS}-character cap (got ${key.length})` };
  }
  if (!CONVERSATION_KEY_RE.test(key)) {
    return { ok: false, reason: 'conversation_key may contain only letters, digits, and . _ - : @' };
  }

  if (typeof summary !== 'string' || !summary.trim()) {
    return { ok: false, reason: 'summary is required and must be a non-empty string' };
  }
  const s = summary.trim();
  if (s.length > SUMMARY_MAX_CHARS) {
    return { ok: false, reason: `summary exceeds the ${SUMMARY_MAX_CHARS}-character cap (got ${s.length} after trim); shorten it` };
  }

  let proj;
  if (project != null) {
    if (typeof project !== 'string') {
      return { ok: false, reason: 'project must be a string when provided' };
    }
    proj = project.trim();
    if (proj.length > PROJECT_MAX_CHARS) {
      return { ok: false, reason: `project exceeds the ${PROJECT_MAX_CHARS}-character cap (got ${proj.length})` };
    }
    if (!proj) proj = undefined;
  }

  let msgs;
  if (messagesCount != null) {
    if (typeof messagesCount !== 'number' || !Number.isFinite(messagesCount)) {
      return { ok: false, reason: 'messages_count must be a finite number when provided' };
    }
    msgs = Math.trunc(messagesCount);
    if (msgs < 0) {
      return { ok: false, reason: `messages_count must be >= 0 (got ${msgs})` };
    }
  }

  for (const [label, v] of [['started_at', startedAt], ['ended_at', endedAt]]) {
    if (v != null && !isIsoish(v)) {
      return { ok: false, reason: `${label} must be an ISO-8601 timestamp string when provided` };
    }
  }
  if (startedAt != null && endedAt != null && Date.parse(startedAt) > Date.parse(endedAt)) {
    return { ok: false, reason: 'started_at is after ended_at' };
  }

  let tops;
  if (topics != null) {
    if (!Array.isArray(topics)) {
      return { ok: false, reason: 'topics must be an array of strings when provided' };
    }
    if (topics.length > TOPICS_MAX) {
      return { ok: false, reason: `topics exceeds the ${TOPICS_MAX}-entry cap (got ${topics.length})` };
    }
    tops = [];
    for (const t of topics) {
      if (typeof t !== 'string') return { ok: false, reason: 'topics must contain only strings' };
      const tt = t.trim();
      if (!tt) continue;
      if (tt.length > TOPIC_MAX_CHARS) {
        return { ok: false, reason: `a topic exceeds the ${TOPIC_MAX_CHARS}-character cap (got ${tt.length})` };
      }
      tops.push(tt);
    }
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

  return {
    ok: true,
    value: {
      conversationKey: key,
      summary: s,
      project: proj,
      messagesCount: msgs,
      startedAt: startedAt != null ? new Date(Date.parse(startedAt)).toISOString() : undefined,
      endedAt: endedAt != null ? new Date(Date.parse(endedAt)).toISOString() : undefined,
      topics: tops,
    },
  };
}

// ── the tool ─────────────────────────────────────────────────────────────────

// buildSessionRecordTools({ clients, identity, policy, env?, now? }) → [descriptor].
// Same injection contract as buildProposeTools — see ./propose.js.
function buildSessionRecordTools({ clients, identity, policy, env, now } = {}) {
  if (!clients || !clients.mnestra || typeof clients.mnestra.sessionRecord !== 'function') {
    throw new Error('buildSessionRecordTools requires clients.mnestra.sessionRecord');
  }
  if (!identity || typeof identity.getClient !== 'function') {
    throw new Error('buildSessionRecordTools requires an identity source ({ getClient })');
  }
  if (!policy || typeof policy.mapClientToSourceAgent !== 'function' || typeof policy.loadProposeMap !== 'function') {
    throw new Error('buildSessionRecordTools requires policy.{mapClientToSourceAgent,loadProposeMap}');
  }
  const environ = () => env || process.env;
  const limiter = createSessionRecordRateLimiter({
    ratePerHour: posNum(environ().TERMDECK_BRIDGE_SESSION_RECORD_RATE_PER_HOUR, 12),
    burst: Math.max(1, Math.floor(posNum(environ().TERMDECK_BRIDGE_SESSION_RECORD_BURST, 4))),
    now,
  });

  return [
    {
      name: 'memory_session_record',
      title: 'Record session summary',
      description:
        "File an end-of-conversation summary of THIS conversation into the developer's session log. "
        + 'This does NOT write to canonical memory and is NOT immediately searchable: the summary enters '
        + 'an asynchronous learning pass that may distill insights from it later, or may not. Never claim '
        + 'the conversation has been "saved to memory"; say the session summary has been recorded for later '
        + 'review. Call this at most ONCE per conversation, at its end, with a factual recap of what was '
        + 'decided or learned — not a transcript. Summaries containing secrets or denylisted literals are refused.',
      inputSchema: (z) => ({
        conversation_key: z.string().describe(
          `A stable identifier for this conversation (≤ ${CONVERSATION_KEY_MAX_CHARS} chars; letters, digits, and . _ - : @). `
          + 'Reuse the same value to amend this conversation’s record; the server namespaces it per surface.',
        ),
        summary: z.string().describe(
          `What this conversation established (≤ ${SUMMARY_MAX_CHARS} chars). Decisions, findings, and durable context — not a transcript.`,
        ),
        project: z.string().optional().describe(
          `Optional project slug (≤ ${PROJECT_MAX_CHARS} chars; advisory — the learning pass may re-map it).`,
        ),
        messages_count: z.number().optional().describe(
          `How many messages this conversation contained. Report it honestly: conversations under ${RUMEN_SWEEP_MIN_MESSAGES} messages are recorded but not analysed.`,
        ),
        started_at: z.string().optional().describe('Optional ISO-8601 timestamp for when the conversation began.'),
        ended_at: z.string().optional().describe('Optional ISO-8601 timestamp for when it ended. Defaults to now.'),
        topics: z.array(z.string()).optional().describe(
          `Optional short topic tags (≤ ${TOPICS_MAX} entries, ≤ ${TOPIC_MAX_CHARS} chars each).`,
        ),
        metadata: z.record(z.string(), z.any()).optional().describe(
          `Optional JSON object of extra context. ≤ ${METADATA_MAX_BYTES} bytes serialized.`,
        ),
      }),
      // HONEST annotations — verified exact by policy.assertReadOnly's
      // WRITE_CHANNEL_TOOLS carve-out. idempotentHint is false because a repeat
      // call AMENDS the record (and is refused outright once the learning pass
      // has consumed it), which is not the same thing as a no-op.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Record session summary' },
      approval: true, // authoritative via policy.requiresApproval('memory_session_record') → true
      handler: async (args, extra) => {
        try {
          // 1) Connector identity — server-derived, fail-closed. Any
          // caller-supplied args.source_agent is deliberately ignored.
          const authInfo = (extra && extra.authInfo) || null;
          const clientId = authInfo && authInfo.clientId ? String(authInfo.clientId) : '';
          if (!clientId) {
            return toolError('memory_session_record', new Error(
              'could not derive connector identity (no authenticated client on this request); session record refused',
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
            env: environ(),
          });
          if (!sourceAgent) {
            return toolError('memory_session_record', new Error(
              `connector identity is not mapped to a web source agent (client_id "${clientId}"`
              + `${clientName ? `, client_name "${clientName}"` : ''}). The operator must add it to `
              + '~/.termdeck/bridge-propose.json {"clients":{"<client_id>":"claude-web|chatgpt-web|grok-web|gemini-web"}} '
              + 'or TERMDECK_BRIDGE_PROPOSE_MAP. Session record refused (identity is never defaulted).',
            ));
          }

          // 2) Caps — on the FINAL payload, including the bridge provenance
          // stamp (a caller-supplied `bridge` key is overwritten, so the stamp
          // cannot be spoofed).
          const callerMeta = args && args.metadata != null ? args.metadata : undefined;
          if (callerMeta !== undefined && (typeof callerMeta !== 'object' || Array.isArray(callerMeta))) {
            return toolError('memory_session_record', new Error('metadata must be a plain JSON object when provided'));
          }
          const metadata = {
            ...(callerMeta || {}),
            bridge: { client_id: clientId, client_name: clientName || null, source_agent: sourceAgent },
          };
          const caps = checkSessionRecordCaps({
            conversationKey: args && args.conversation_key,
            summary: args && args.summary,
            project: args && args.project,
            messagesCount: args && args.messages_count,
            startedAt: args && args.started_at,
            endedAt: args && args.ended_at,
            topics: args && args.topics,
            metadata,
          });
          if (!caps.ok) return toolError('memory_session_record', new Error(caps.reason));

          // 3) Per-connector rate limit (after caps so oversize spam is free to
          // refuse; before the scan so the regex pass is throttled).
          const rl = limiter.check(clientId);
          if (!rl.ok) {
            return toolError('memory_session_record', new Error(
              `rate limit exceeded for this connector (default 12 session records/hour, burst 4); retry in ${retryWindow(rl.retryAfterSec)}`,
            ));
          }

          // 4) Ingress secret scan over the exact forward payload. REJECT, do
          // not scrub — a silently-sanitized summary is a corrupted summary.
          // The reason names rule CLASSES only, never the matched text, which
          // must not echo back through the provider cloud.
          const payload = {
            conversation_key: caps.value.conversationKey,
            summary: caps.value.summary,
            project: caps.value.project,
            topics: caps.value.topics,
            metadata,
          };
          const scanRes = scanDeep(payload, { env: environ() });
          if (!scanRes.clean) {
            const classes = scanRes.hits.map((h) => h.name).join(', ');
            return toolError('memory_session_record', new Error(
              `session summary contains material matching secret/denylist rule class(es): ${classes}. `
              + 'Refused (never stored, never scrubbed-and-forwarded) — remove the sensitive material and rephrase.',
            ));
          }

          // 5) Forward. NOTE: no session_id argument exists — the store mints
          // it from the resolved source agent plus the conversation key.
          const { id, sessionId } = await clients.mnestra.sessionRecord({
            sourceAgent,
            conversationKey: caps.value.conversationKey,
            summary: caps.value.summary,
            project: caps.value.project,
            messagesCount: caps.value.messagesCount,
            startedAt: caps.value.startedAt,
            endedAt: caps.value.endedAt,
            topics: caps.value.topics,
            metadata,
          });

          // Report the sweep floor honestly rather than inflating the count to
          // clear it. `undefined` messages_count is stored as 0 by the RPC, so
          // an unreported count is below the floor too.
          const counted = Number.isFinite(caps.value.messagesCount) ? caps.value.messagesCount : 0;
          const belowFloor = counted < RUMEN_SWEEP_MIN_MESSAGES;
          const floorNote = belowFloor
            ? ` NOTE: with ${counted} message(s) recorded, this session is below the learning pass's `
              + `${RUMEN_SWEEP_MIN_MESSAGES}-message threshold, so it will be stored but not analysed. `
              + 'Do not re-send it with an inflated count.'
            : '';

          return ok(
            `Session summary recorded as ${sourceAgent} (id: ${id}, key: ${sessionId || 'unknown'}).`
            + ' It is NOT part of canonical memory and is NOT searchable: an asynchronous learning pass'
            + ' may distill insights from it later. Tell the user the session summary has been recorded'
            + ' for later review — not "saved to memory".'
            + floorNote,
            {
              id,
              session_id: sessionId,
              source_agent: sourceAgent,
              messages_count: counted,
              below_sweep_floor: belowFloor,
            },
          );
        } catch (err) {
          return toolError('memory_session_record', err);
        }
      },
    },
  ];
}

module.exports = {
  buildSessionRecordTools,
  createSessionRecordRateLimiter,
  checkSessionRecordCaps,
  SUMMARY_MAX_CHARS,
  CONVERSATION_KEY_MAX_CHARS,
  PROJECT_MAX_CHARS,
  TOPICS_MAX,
  TOPIC_MAX_CHARS,
  METADATA_MAX_BYTES,
  RUMEN_SWEEP_MIN_MESSAGES,
};
