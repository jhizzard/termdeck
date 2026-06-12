/**
 * TermDeck pre-compact memory hook (Mnestra-direct, no rag-system dependency).
 *
 * @termdeck/stack-installer-hook v2
 *
 * ^ Stamp lives at the TOP of the docblock — both readers scan only the first
 *   4096 bytes (Sprint 73 T1 hit this on the session-end hook when its
 *   changelog grew past 4 KB and the stamp fell out of the window, silently
 *   disabling every refresh path). Keep it above the fold.
 *
 * Vendored into ~/.claude/hooks/memory-pre-compact.js by @jhizzard/termdeck-stack.
 * Wired into ~/.claude/settings.json under hooks.PreCompact — fires BEFORE
 * Claude Code compacts conversation context, capturing the in-flight session
 * state into Mnestra before the harness vaporizes it.
 *
 * Why this hook exists (Sprint 64 Investigation 2 of
 * docs/CRITICAL-READ-FIRST-2026-05-07.md): every long Claude Code session that
 * crosses the auto-compaction boundary loses in-context state. The global
 * CLAUDE.md "Before Context Gets Long" rule was advisory and unreliably
 * followed under sprint pressure. PreCompact is the deterministic signal —
 * see the canonical hooks docs at https://code.claude.com/docs/en/hooks for
 * the event contract — and this hook captures a session_summary-shaped row
 * with `source_type='pre_compact_snapshot'` so post-compaction `memory_recall`
 * can resurface what was about to be lost.
 *
 * Two firing modes:
 *
 *   1. Claude Code PreCompact (primary). STDIN shape per the docs:
 *      { session_id, transcript_path, cwd, hook_event_name: "PreCompact",
 *        trigger: "auto"|"manual" }.
 *
 *   2. TermDeck server periodic-capture timer (Sprint 64 T3.4). Non-Claude
 *      panels (Codex/Gemini/Grok) have no PreCompact-equivalent. The TermDeck
 *      server spawns this hook every N minutes for each active non-Claude
 *      panel, draining the rolling transcript to Mnestra. STDIN shape adds:
 *      { sessionType, source_agent, mode: "periodic_checkpoint" }.
 *
 * Both modes share the rest of the pipeline:
 *   - Load ~/.termdeck/secrets.env on env-var gaps (Sprint 47.5 discipline).
 *   - Parse transcript via the adapter parser exported by
 *     memory-session-end.js (Sprint 38 module-export contract; no duplication).
 *   - Embed via the session-end hook's embedText (text-embedding-3-large at
 *     dimensions:1536 since v5 there — recall-parity with mnestra's query
 *     embedder; this hook has NO embed call of its own).
 *   - POST ONE row to /rest/v1/memory_items with
 *     source_type='pre_compact_snapshot', category='workflow'.
 *
 * Fail-soft contract: any error (network, parse, env-var-missing, malformed
 * transcript) logs and exits 0. NEVER blocks compaction — PreCompact CAN block
 * via exit-2/decision:block, but losing the checkpoint is bad while blocking
 * compaction would be worse (the user gets stuck). Match memory-session-end.js
 * fail-soft.
 *
 * Version stamp (Sprint 64 T3.2 — initial cut):
 *   The marker `@termdeck/stack-installer-hook v<N>` at the TOP of this
 *   docblock is read by both stack-installer's installPreCompactHook
 *   (version-aware overwrite under --yes) and `termdeck init --mnestra`
 *   (refreshBundledPreCompactHookIfNewer step) — both scan only the first
 *   4096 bytes. Bump the integer whenever a change here should overwrite an
 *   already-installed copy. Comment-only tweaks do not need a bump.
 *
 *   v2 (Sprint 73 T1, ORCH handoff — embedding recall-parity marker):
 *     - Snapshot rows now stamp metadata.embedding_model with the marker
 *       exported by the session-end hook (v5: 'text-embedding-3-large@1536')
 *       — Sprint 74 T3's re-embed backfill keys idempotency on it. The marker
 *       is stamped ONLY when the loaded helpers export it: an older installed
 *       session-end (still embedding 3-small) exports none, the row stays
 *       unmarked, and the backfill correctly re-embeds it — a false marker on
 *       a mis-embedded row would permanently hide it from repair.
 *
 * Required env vars (validated at entry, after the secrets.env fallback):
 *   - SUPABASE_URL              e.g. https://<project-ref>.supabase.co
 *   - SUPABASE_SERVICE_ROLE_KEY      service-role key (needs INSERT on memory_items)
 *   - OPENAI_API_KEY            sk-... for the embed model (see embedText in
 *                               the session-end hook — 3-large@1536 since v5)
 *
 * Optional:
 *   - TERMDECK_HOOK_DEBUG=1               verbose logging
 *   - TERMDECK_PRECOMPACT_MIN_BYTES=5000  transcript size threshold (same default as
 *                                         memory-session-end.js — sub-5KB transcripts
 *                                         don't compact anyway, but the guard keeps
 *                                         synthetic test fixtures honest)
 *   - TERMDECK_HOOK_HELPERS_PATH=...      override the memory-session-end.js path the
 *                                         hook require()s helpers from (tests use this)
 *
 * Co-existence with memory-session-end.js:
 *   - memory-session-end.js writes source_type='session_summary' (one per SessionEnd).
 *   - this hook writes source_type='pre_compact_snapshot' (one per PreCompact OR
 *     per periodic-capture tick).
 *   - Same source_session_id ties them together; future `memory_recall` filters
 *     can include or exclude pre-compact rows independently.
 */

'use strict';

const { existsSync, readFileSync, appendFileSync, statSync } = require('fs');
const path = require('path');
const os = require('os');

const LOG_FILE = path.join(os.homedir(), '.claude', 'hooks', 'memory-hook.log');

function log(msg) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [pre-compact] ${msg}\n`); }
  catch (_) { /* fail-soft */ }
}
const DEBUG = process.env.TERMDECK_HOOK_DEBUG === '1';
function debug(msg) { if (DEBUG) log(`[debug] ${msg}`); }

// Load the SessionEnd hook's helpers via the Sprint 38 module-export contract
// (`require.main === module` ⇒ CLI; else exports object). Resolved in priority:
//   1. TERMDECK_HOOK_HELPERS_PATH env var (tests).
//   2. The installed SessionEnd hook at ~/.claude/hooks/memory-session-end.js —
//      production path; vendored by installSessionEndHook from the same
//      stack-installer assets dir this file lives in.
//   3. The bundled SessionEnd source sibling — used when this hook is exercised
//      directly from the source tree (fence tests, dev repro).
function loadHelpers() {
  const override = process.env.TERMDECK_HOOK_HELPERS_PATH;
  const candidates = [
    override,
    path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js'),
    path.join(__dirname, 'memory-session-end.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try { return require(p); }
    catch (err) {
      log(`helper-load-failed: ${p} — ${err && err.message ? err.message : String(err)}`);
    }
  }
  log('helpers-not-found: pre-compact hook needs memory-session-end.js bundled at ~/.claude/hooks/. Install via `npx @jhizzard/termdeck-stack`.');
  return null;
}

const MIN_TRANSCRIPT_BYTES_PRE_COMPACT =
  parseInt(process.env.TERMDECK_PRECOMPACT_MIN_BYTES || '5000', 10);

// Inline POST to /rest/v1/memory_items so we can set source_type='pre_compact_snapshot'
// without touching memory-session-end.js's postMemoryItem (which hardcodes
// source_type='session_summary'). Inlining keeps the Sprint 62 close-out path
// untouched — zero regression risk for SessionEnd flow.
async function postPreCompactSnapshot({
  supabaseUrl, supabaseKey,
  content, embedding,
  project, sessionId,
  sourceAgent,
  embeddingModelMarker,
}) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/memory_items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        content,
        embedding: `[${embedding.join(',')}]`,
        source_type: 'pre_compact_snapshot',
        category: 'workflow',
        project,
        source_session_id: sessionId || null,
        source_agent: sourceAgent,
        // v2 — backfill-idempotency marker, present ONLY when the loaded
        // helpers export one (i.e. the embed actually ran on that model).
        // See the v2 header note for the stale-helpers rationale.
        ...(embeddingModelMarker
          ? { metadata: { embedding_model: embeddingModelMarker } }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`supabase-insert-failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`supabase-insert-exception: ${e.message}`);
    return false;
  }
}

// Distinguishes the two firing modes from the STDIN payload shape:
//   - { hook_event_name: "PreCompact", trigger }      → Claude Code harness
//   - { mode: "periodic_checkpoint", sessionType }    → TermDeck server timer
// Returns { mode, trigger, sessionType, sourceAgent } resolved per mode.
function resolveFiringContext(data, helpers) {
  const isClaudePreCompact = data && data.hook_event_name === 'PreCompact';
  if (isClaudePreCompact) {
    return {
      mode: 'pre_compact',
      trigger: data.trigger === 'manual' ? 'manual' : 'auto',
      // Claude Code's PreCompact payload doesn't carry sessionType; default
      // to the canonical adapter name so buildSummary's parser dispatch picks
      // parseClaudeJsonl. Codex/Gemini/Grok never reach this branch — they
      // route through the server-side periodic-capture branch below.
      sessionType: 'claude-code',
      sourceAgent: helpers.normalizeSourceAgent(data.source_agent || 'claude'),
    };
  }
  return {
    mode: 'periodic_checkpoint',
    trigger: 'periodic',
    sessionType: data.sessionType || data.session_type || 'claude-code',
    sourceAgent: helpers.normalizeSourceAgent(data.source_agent || 'claude'),
  };
}

async function processPreCompactPayload(input, helpers) {
  let data;
  try { data = JSON.parse(input); }
  catch (e) { log(`parse-stdin-failed: ${e.message}`); return { status: 'parse-failed' }; }

  const transcriptPath = data.transcript_path;
  const cwd = data.cwd || '';
  const sessionId = data.session_id || null;
  if (!transcriptPath) { log('no-transcript-path: skipping'); return { status: 'no-transcript-path' }; }
  if (!sessionId) { log('no-session-id: skipping'); return { status: 'no-session-id' }; }

  const { mode, trigger, sessionType, sourceAgent } = resolveFiringContext(data, helpers);

  let stat;
  try { stat = statSync(transcriptPath); }
  catch (e) {
    log(`cannot-stat-transcript: ${transcriptPath} — ${e.message}`);
    return { status: 'cannot-stat-transcript' };
  }

  if (stat.size < MIN_TRANSCRIPT_BYTES_PRE_COMPACT) {
    debug(`small-transcript: ${stat.size} bytes — skipping ${mode} checkpoint`);
    return { status: 'small-transcript' };
  }

  const env = helpers.readEnv();
  if (!env) return { status: 'env-missing' };

  const project = helpers.detectProject(cwd);
  const built = helpers.buildSummary(transcriptPath, sessionType);
  if (!built) {
    debug(`buildSummary-skipped: <5 messages (parser=${sessionType}) — ${mode} hook bailing gracefully`);
    return { status: 'too-few-messages' };
  }
  const { summary: baseSummary, messagesCount, durationMinutes, factsExtracted } = built;

  // Prepend a checkpoint header so memory_recall results read clearly. Plain
  // text (not JSON) so the line survives the embed roundtrip intact and is
  // operator-readable in recall output. Fields chosen for at-a-glance
  // recovery semantics: mode tells you what fired, trigger distinguishes
  // auto-vs-manual-vs-periodic, agent says whose context this slice is from.
  const header =
    `[CHECKPOINT mode=${mode} trigger=${trigger} ` +
    `agent=${sourceAgent} ` +
    `messages=${messagesCount} ` +
    `duration=${durationMinutes === null ? 'unknown' : `${durationMinutes}m`} ` +
    `facts_remembered=${factsExtracted}]`;
  const content = `${header}\n\n${baseSummary}`.slice(0, 7000);

  const embedding = await helpers.embedText(content, env.openaiKey);
  if (!embedding) return { status: 'embed-failed' };

  const ok = await postPreCompactSnapshot({
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    content, embedding, project, sessionId, sourceAgent,
    // Marker travels with the embedder: undefined on a pre-v5 session-end
    // hook (3-small embeds → row stays unmarked → backfill repairs it).
    embeddingModelMarker: helpers.EMBEDDING_MODEL_MARKER || null,
  });

  if (ok) {
    log(`ingested-${mode}: project="${project}" session=${sessionId} trigger=${trigger} agent=${sourceAgent} bytes=${content.length} messages=${messagesCount} factsExtracted=${factsExtracted}`);
    return { status: 'ingested', project, sessionId, sourceAgent, mode, trigger, messagesCount };
  }
  return { status: 'insert-failed' };
}

// Module-export contract — when run as a script, read stdin and process; when
// require()'d (tests + the TermDeck server's periodic-capture spawn helper),
// expose the inner functions.
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const helpers = loadHelpers();
    if (!helpers) { process.exit(0); return; }
    processPreCompactPayload(input, helpers)
      .catch((e) => log(`hook-error: ${e && e.message ? e.message : String(e)}`))
      // Fail-soft: ALWAYS exit 0. Blocking compaction (exit 2 per Claude Code's
      // hook contract) costs more than skipping a checkpoint.
      .finally(() => process.exit(0));
  });
} else {
  module.exports = {
    loadHelpers,
    postPreCompactSnapshot,
    processPreCompactPayload,
    resolveFiringContext,
    LOG_FILE,
    MIN_TRANSCRIPT_BYTES_PRE_COMPACT,
  };
}
