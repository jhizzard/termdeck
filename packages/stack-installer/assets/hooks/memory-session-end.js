/**
 * TermDeck session-end memory hook (Mnestra-direct, no rag-system dependency).
 *
 * Vendored into ~/.claude/hooks/memory-session-end.js by @jhizzard/termdeck-stack.
 * Wired into ~/.claude/settings.json under hooks.Stop. Fires on Claude Code Stop event.
 *
 * Behavior:
 *   1. Reads {transcript_path, cwd, session_id} from stdin (Claude Code Stop payload).
 *   2. Skips small transcripts (< MIN_TRANSCRIPT_BYTES, default 5KB).
 *   3. Validates env vars; logs and exits cleanly if any required key is missing.
 *   4. Detects project from cwd against PROJECT_MAP (else "global"). Extend the
 *      map by editing the array below — see assets/hooks/README.md for guidance.
 *   5. Builds a coarse session summary from the transcript (last ~30 message excerpts).
 *   6. Embeds the summary via OpenAI text-embedding-3-small.
 *   7. POSTs ONE row to Supabase /rest/v1/memory_items with source_type='session_summary'.
 *   8. Logs every step to ~/.claude/hooks/memory-hook.log.
 *
 * Required env vars (validated at entry):
 *   - SUPABASE_URL              e.g. https://luvvbrpaopnblvxdxwzb.supabase.co
 *   - SUPABASE_SERVICE_KEY      service-role key (NOT the anon key — needs INSERT on memory_items)
 *   - OPENAI_API_KEY            sk-... for text-embedding-3-small
 *
 * Optional:
 *   - TERMDECK_HOOK_DEBUG=1            verbose logging
 *   - TERMDECK_HOOK_MIN_BYTES=5000     transcript size threshold
 *
 * Fail-soft contract: any error (network, parse, env-var-missing, malformed transcript)
 * logs and exits 0. Never blocks Claude Code session close.
 *
 * Co-existence with Joshua's personal rag-system hook: this bundled hook writes
 * source_type='session_summary' (one row per session). Joshua's personal hook
 * writes source_type='fact' (multiple rows from extractFacts pipeline). Different
 * source_types coexist in memory_items without dedup collisions.
 */

'use strict';

const { existsSync, statSync, appendFileSync, readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

const LOG_FILE = join(os.homedir(), '.claude', 'hooks', 'memory-hook.log');

// PROJECT_MAP — minimal default. Users extend by adding entries to this array.
// Patterns match against the cwd reported by Claude Code at Stop time.
// First match wins; falls through to "global".
const PROJECT_MAP = [
  // Example entries — uncomment + edit, or add your own:
  // { pattern: /\/myproject\//i,        project: 'my-project' },
  // { pattern: /work-stuff/i,           project: 'work' },
];

const MIN_TRANSCRIPT_BYTES = parseInt(process.env.TERMDECK_HOOK_MIN_BYTES || '5000', 10);
const DEBUG = process.env.TERMDECK_HOOK_DEBUG === '1';

function log(msg) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); }
  catch (_) { /* fail-soft */ }
}
function debug(msg) { if (DEBUG) log(`[debug] ${msg}`); }

function detectProject(cwd) {
  for (const { pattern, project } of PROJECT_MAP) {
    if (pattern.test(cwd)) return project;
  }
  return 'global';
}

function readEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    log(`env-var-missing: ${missing.join(', ')} — set these in ~/.termdeck/secrets.env or your shell to enable Mnestra ingestion. Skipping.`);
    return null;
  }
  return {
    supabaseUrl: process.env.SUPABASE_URL.replace(/\/$/, ''),
    supabaseKey: process.env.SUPABASE_SERVICE_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
  };
}

function buildSummary(transcriptPath) {
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch (e) { log(`read-transcript-failed: ${e.message}`); return null; }

  const lines = raw.split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    const role = msg?.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg.message.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }

  if (messages.length < 5) {
    debug(`session-too-short: ${messages.length} messages, skipping`);
    return null;
  }

  const tail = messages.slice(-30);
  const summary =
    `Session with ${messages.length} messages.\n\n` +
    tail.map((m) => `[${m.role}] ${m.content}`).join('\n');
  // OpenAI text-embedding-3-small accepts up to 8192 tokens (~32K chars).
  // 7000 chars is a safe headroom that survives multibyte expansion.
  return summary.slice(0, 7000);
}

async function embedText(text, openaiKey) {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`openai-embed-failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch (e) {
    log(`openai-embed-exception: ${e.message}`);
    return null;
  }
}

async function postMemoryItem({ supabaseUrl, supabaseKey, content, embedding, project, sessionId }) {
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
        source_type: 'session_summary',
        category: 'workflow',
        project,
        source_session_id: sessionId || null,
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

async function processStdinPayload(input) {
  let data;
  try { data = JSON.parse(input); }
  catch (e) { log(`parse-stdin-failed: ${e.message}`); return; }

  const transcriptPath = data.transcript_path;
  const cwd = data.cwd || '';
  const sessionId =
    data.session_id ||
    (transcriptPath ? transcriptPath.split('/').pop().replace('.jsonl', '') : null);

  if (!transcriptPath) { log('no-transcript-path: skipping'); return; }

  let stat;
  try { stat = statSync(transcriptPath); }
  catch (e) { log(`cannot-stat-transcript: ${transcriptPath} — ${e.message}`); return; }

  if (stat.size < MIN_TRANSCRIPT_BYTES) {
    debug(`small-transcript: ${stat.size} bytes < ${MIN_TRANSCRIPT_BYTES}, skipping`);
    return;
  }

  const env = readEnv();
  if (!env) return;

  const project = detectProject(cwd);
  debug(`project="${project}", session=${sessionId}`);

  const summary = buildSummary(transcriptPath);
  if (!summary) return;

  const embedding = await embedText(summary, env.openaiKey);
  if (!embedding) return;

  const ok = await postMemoryItem({
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    content: summary,
    embedding,
    project,
    sessionId,
  });

  if (ok) log(`ingested: project="${project}" session=${sessionId} bytes=${summary.length}`);
}

// Module-export contract for testability. When run as a script (require.main === module),
// read stdin and process. When require()d (tests), expose helpers.
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    processStdinPayload(input).catch((e) => log(`hook-error: ${e.message}`));
  });
} else {
  module.exports = {
    PROJECT_MAP,
    detectProject,
    readEnv,
    buildSummary,
    embedText,
    postMemoryItem,
    processStdinPayload,
    LOG_FILE,
  };
}
