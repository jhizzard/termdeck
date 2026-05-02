/**
 * TermDeck session-end memory hook (Mnestra-direct, no rag-system dependency).
 *
 * Vendored into ~/.claude/hooks/memory-session-end.js by @jhizzard/termdeck-stack.
 * Wired into ~/.claude/settings.json under hooks.SessionEnd — fires once per
 * Claude Code session close (`/exit`, Ctrl+D, terminal close, or process kill).
 *
 * History: this hook was originally registered under hooks.Stop, which fires
 * after every assistant turn. That meant the same transcript got embedded and
 * INSERTed dozens of times per session (and most fired with env-var-missing
 * because Claude Code launched outside TermDeck doesn't have SUPABASE_URL in
 * scope). Sprint 48 close-out moved registration to SessionEnd (one row per
 * session, fires deterministically on /exit) AND added the secrets-env
 * fallback below so a standalone-Claude-Code launch picks up the credentials
 * without needing them in the parent shell.
 *
 * Behavior:
 *   1. Reads {transcript_path, cwd, session_id, sessionType?, source_agent?}
 *      from stdin (Claude Code SessionEnd payload, or — Sprint 50 T1 — a
 *      server-driven invocation for non-Claude agents). source_agent
 *      defaults to 'claude' when absent (Claude Code's existing hook
 *      payload doesn't carry it; the TermDeck server's per-adapter
 *      onPanelClose interceptor sets it explicitly for codex/gemini/grok).
 *   2. Loads ~/.termdeck/secrets.env into process.env if any required key is
 *      absent OR is a literal `${VAR}` placeholder (Sprint 47.5 hotfix
 *      discipline — Claude Code does not expand `${VAR}` in MCP env, and we
 *      can't trust the parent shell to have sourced secrets.env).
 *   3. Skips small transcripts (< MIN_TRANSCRIPT_BYTES, default 5KB).
 *   4. Validates env vars; logs and exits cleanly if any required key is still
 *      missing after the secrets.env fallback.
 *   5. Detects project from cwd against PROJECT_MAP (else "global"). Extend the
 *      map by editing the array below — see assets/hooks/README.md for guidance.
 *   6. Dispatches to a transcript parser by sessionType (Sprint 45 T4): Claude
 *      JSONL, Codex JSONL, Gemini single-JSON, or auto-detect when sessionType
 *      is absent. Builds a coarse summary from the resulting message list
 *      (last ~30 message excerpts).
 *   7. Embeds the summary via OpenAI text-embedding-3-small.
 *   8. POSTs ONE row to Supabase /rest/v1/memory_items with source_type='session_summary'.
 *   9. Logs every step to ~/.claude/hooks/memory-hook.log.
 *
 * Required env vars (validated at entry, after the secrets.env fallback):
 *   - SUPABASE_URL              e.g. https://<project-ref>.supabase.co
 *   - SUPABASE_SERVICE_ROLE_KEY      service-role key (NOT the anon key — needs INSERT on memory_items)
 *   - OPENAI_API_KEY            sk-... for text-embedding-3-small
 *
 * Optional:
 *   - TERMDECK_HOOK_DEBUG=1            verbose logging
 *   - TERMDECK_HOOK_MIN_BYTES=5000     transcript size threshold
 *   - TERMDECK_SESSION_TYPE=...        override sessionType when payload lacks it
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

// Resolved per-call so tests can override via TERMDECK_HOOK_SECRETS_PATH
// (the const-at-load-time pattern would freeze the path before any test
// that mutates HOME or the override env var gets a chance to take effect).
function resolveSecretsPath() {
  return process.env.TERMDECK_HOOK_SECRETS_PATH
    || join(os.homedir(), '.termdeck', 'secrets.env');
}

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

// Treat values shaped like `${VAR}` as unset. Claude Code does not expand
// shell placeholders in MCP env or hook env, so a literal `${SUPABASE_URL}`
// is non-empty-but-invalid — the same trap that caused the Sprint 47.5
// hotfix on the stack-installer + mnestra MCP. Mirroring that discipline
// here keeps the hook resilient if any future tooling regresses to the
// placeholder pattern.
function isUnexpandedPlaceholder(v) {
  return typeof v === 'string' && v.startsWith('${') && v.endsWith('}');
}

// Load ~/.termdeck/secrets.env into process.env when keys are absent or
// hold an unexpanded `${VAR}` placeholder. Concrete values already in
// process.env always win — the fallback only fills gaps. Silent no-op if
// the file is missing. Mirrors mnestra's loadTermdeckSecretsFallback so
// the hook works in three launch contexts:
//   1. Inside TermDeck PTY (Sprint 48 T4 PTY env merge supplies the vars).
//   2. Standalone Claude Code launched from a shell with secrets.env sourced.
//   3. Standalone Claude Code launched from a vanilla shell (this fallback).
function loadTermdeckSecretsFallback() {
  const secretsPath = resolveSecretsPath();
  if (!existsSync(secretsPath)) return;
  let raw;
  try { raw = readFileSync(secretsPath, 'utf8'); }
  catch (err) {
    log(`secrets-env-read-failed: ${err && err.message ? err.message : String(err)}`);
    return;
  }
  let loaded = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    const cur = process.env[key];
    if (cur && !isUnexpandedPlaceholder(cur)) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
      v = v.slice(1, -1);
    }
    process.env[key] = v;
    loaded++;
  }
  if (loaded > 0) debug(`secrets-env-loaded: ${loaded} keys from ${secretsPath}`);
}

function readEnv() {
  loadTermdeckSecretsFallback();
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
  const missing = required.filter((k) => {
    const v = process.env[k];
    return !v || isUnexpandedPlaceholder(v);
  });
  if (missing.length) {
    log(`env-var-missing: ${missing.join(', ')} — set these in ~/.termdeck/secrets.env or your shell to enable Mnestra ingestion. Skipping.`);
    return null;
  }
  return {
    supabaseUrl: process.env.SUPABASE_URL.replace(/\/$/, ''),
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Sprint 45 T4 — adapter-pluggable transcript parsers.
//
// Each parser takes raw transcript file contents (string) and returns a
// `{ role: 'user'|'assistant', content: string }[]` array — the shape
// buildSummary() consumes. Adapters in packages/server/src/agent-adapters/
// own the canonical parser logic; this file inlines copies because the
// hook ships standalone to ~/.claude/hooks/ where it can't `require()`
// from the TermDeck server package. When new agents add adapters, mirror
// their parseTranscript function body here — keep the two in sync.
// (Sprint 46 candidate: a sync script that codegens this section from
// agent-adapters/*.js, analogous to scripts/sync-agent-instructions.js
// for CLAUDE.md / AGENTS.md / GEMINI.md mirroring.)
//
// When sessionType is absent or unknown, parseAutoDetect runs a per-line
// best-effort that handles Claude JSONL, Codex JSONL, AND Gemini's single
// JSON-object shape. This is the pre-T4 stop-gap T1+T2 landed inline —
// preserved as the fallback so existing hook payloads (Claude Code Stop,
// no sessionType field) continue working for any of the three agents.
// Once Sprint 46 wires sessionType into payloads, the auto path narrows
// to a legacy compatibility role.
// ──────────────────────────────────────────────────────────────────────────

function parseClaudeJsonl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const lines = raw.split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    const role = msg && msg.message && msg.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && c.type === 'text')
        .map((c) => c.text || '')
        .join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }
  return messages;
}

function parseCodexJsonl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const lines = raw.split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    if (!msg || msg.type !== 'response_item') continue;
    const payload = msg.payload;
    if (!payload || payload.type !== 'message') continue;
    const role = payload.role;
    // Codex's `developer` role carries the sandbox/permissions prelude — skip.
    if (role !== 'user' && role !== 'assistant') continue;
    const content = payload.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Codex uses `input_text` (user) and `output_text` (assistant); accept
      // plain `text` for forward-compat with future Codex CLI versions.
      text = content
        .filter((c) => c && (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text'))
        .map((c) => c.text || '')
        .join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }
  return messages;
}

function parseGeminiJson(raw) {
  // Gemini CLI persists each session as a single JSON object (NOT JSONL):
  //   { sessionId, projectHash, startTime, lastUpdated, kind,
  //     messages: [{ id, timestamp, type: 'user'|'gemini', content }] }
  // user content: [{ text }]; gemini content: string. Map type='gemini' →
  // role='assistant' to match the rest of the dispatch shape.
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return []; }
  if (!obj || !Array.isArray(obj.messages)) return [];
  const messages = [];
  for (const msg of obj.messages) {
    if (!msg || typeof msg !== 'object') continue;
    let role;
    if (msg.type === 'user') role = 'user';
    else if (msg.type === 'gemini' || msg.type === 'assistant') role = 'assistant';
    else continue;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }
  return messages;
}

// Sprint 50 T1 — Grok parser. Mirrors packages/server/src/agent-adapters/grok.js
// parseTranscript: accepts either a JSON array or JSONL of `{role, content}`
// objects, where content is a string OR an array of `{type, text, ...}` parts
// (AI SDK provider shape). Tool-call / tool-result / reasoning parts are
// skipped — only the `type:'text'` parts contribute to the summary.
//
// The JSON envelope is produced server-side by the Grok adapter's
// `resolveTranscriptPath` (which extracts from ~/.grok/grok.db SQLite via
// better-sqlite3 and writes a tempfile). The hook itself never opens grok.db
// — that would require better-sqlite3 to be reachable from ~/.claude/hooks/,
// which isn't part of the install contract. The transcript_path the server
// hands the hook is the tempfile, and the sessionType in the payload is
// 'grok' so this parser is the one selected.
function parseGrokJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let messages = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) messages = parsed;
  } catch (_) { /* fall through to JSONL */ }
  if (!messages) {
    messages = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') messages.push(obj);
      } catch (_) { continue; }
    }
  }
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ');
    }
    if (text) out.push({ role, content: text.slice(0, 400) });
  }
  return out;
}

function parseAutoDetect(raw) {
  // Fallback when sessionType is absent. Tries Gemini's single-JSON shape
  // first (cheap to detect — starts with `{` and has a top-level `messages`
  // array), then falls through to per-line Claude/Codex JSONL detection.
  // This preserves T1+T2's pre-T4 multi-shape stop-gap so any Claude Code
  // Stop payload (which doesn't carry sessionType) keeps ingesting whichever
  // CLI's transcript path landed there.
  if (typeof raw !== 'string' || raw.length === 0) return [];

  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const geminiTry = parseGeminiJson(raw);
    if (geminiTry.length > 0) return geminiTry;
  }

  const lines = raw.split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }

    let role;
    let content;
    let textBlockType = 'text';

    if (msg && msg.message && (msg.message.role === 'user' || msg.message.role === 'assistant')) {
      role = msg.message.role;
      content = msg.message.content;
    } else if (msg && msg.type === 'response_item' && msg.payload && msg.payload.type === 'message') {
      role = msg.payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      content = msg.payload.content;
      textBlockType = null; // Codex content blocks use input_text/output_text
    } else {
      continue;
    }

    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && (
          textBlockType === null
            ? (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
            : c.type === textBlockType
        ))
        .map((c) => c.text || '')
        .join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }
  return messages;
}

const TRANSCRIPT_PARSERS = {
  'claude-code': parseClaudeJsonl,
  'codex': parseCodexJsonl,
  'gemini': parseGeminiJson,
  // Sprint 50 T1 — grok parser. Server-side `resolveTranscriptPath` extracts
  // ~/.grok/grok.db rows via better-sqlite3 and writes a JSON envelope to a
  // tempfile; the hook reads that tempfile with parseGrokJson here.
  'grok': parseGrokJson,
};
const DEFAULT_SESSION_TYPE = 'auto';

function selectTranscriptParser(sessionType) {
  if (sessionType && TRANSCRIPT_PARSERS[sessionType]) {
    return { parser: TRANSCRIPT_PARSERS[sessionType], sessionType };
  }
  return { parser: parseAutoDetect, sessionType: 'auto' };
}

function buildSummary(transcriptPath, sessionType) {
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch (e) { log(`read-transcript-failed: ${e.message}`); return null; }

  const { parser, sessionType: resolvedType } = selectTranscriptParser(sessionType);
  if (sessionType && resolvedType !== sessionType) {
    debug(`unknown-session-type="${sessionType}", falling back to ${resolvedType}`);
  }

  const messages = parser(raw);

  if (messages.length < 5) {
    debug(`session-too-short: ${messages.length} messages (parser=${resolvedType}), skipping`);
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

// Sprint 50 T2: every row written by this hook carries an LLM-provenance
// tag (memory_items.source_agent). Defaults to 'claude' for backwards
// compat with Claude Code's existing SessionEnd payload, which doesn't
// supply the field; TermDeck server's per-adapter onPanelClose
// interceptor (Sprint 50 T1) sets it explicitly to 'codex'/'gemini'/'grok'
// for non-Claude panels. The set is open-ended on the server side; this
// constant gates only the spelling-mistake/empty-string case.
const ALLOWED_SOURCE_AGENTS = new Set([
  'claude', 'codex', 'gemini', 'grok', 'orchestrator',
]);

function normalizeSourceAgent(raw) {
  if (typeof raw !== 'string') return 'claude';
  const v = raw.trim().toLowerCase();
  if (!v) return 'claude';
  return ALLOWED_SOURCE_AGENTS.has(v) ? v : 'claude';
}

async function postMemoryItem({ supabaseUrl, supabaseKey, content, embedding, project, sessionId, sourceAgent }) {
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
        source_agent: normalizeSourceAgent(sourceAgent),
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

  // Sprint 45 T4: sessionType drives buildSummary's parser dispatch.
  // Read order: payload (server-driven invocations) → env var (TermDeck
  // server can set TERMDECK_SESSION_TYPE in the spawned PTY's env) →
  // 'auto' default (parseAutoDetect handles Claude + Codex + Gemini).
  const sessionType =
    data.sessionType ||
    data.session_type ||
    process.env.TERMDECK_SESSION_TYPE ||
    DEFAULT_SESSION_TYPE;

  // Sprint 50 T2: provenance tag the row with the LLM that produced it.
  // Default 'claude' — Claude Code's native SessionEnd payload doesn't
  // carry source_agent, so any unset path is implicitly Claude. The
  // TermDeck server's per-adapter onPanelClose interceptor (Sprint 50 T1)
  // sets it explicitly for non-Claude panels.
  const sourceAgent =
    data.source_agent ||
    data.sourceAgent ||
    process.env.TERMDECK_SOURCE_AGENT ||
    'claude';

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
  debug(`project="${project}", session=${sessionId}, sessionType=${sessionType}`);

  const summary = buildSummary(transcriptPath, sessionType);
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
    sourceAgent,
  });

  if (ok) log(`ingested: project="${project}" session=${sessionId} bytes=${summary.length} sessionType=${sessionType} sourceAgent=${normalizeSourceAgent(sourceAgent)}`);
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
    // Sprint 45 T4 — adapter-pluggable transcript-parser surface.
    TRANSCRIPT_PARSERS,
    DEFAULT_SESSION_TYPE,
    parseClaudeJsonl,
    parseCodexJsonl,
    parseGeminiJson,
    parseGrokJson,
    parseAutoDetect,
    selectTranscriptParser,
    // Sprint 50 T2 — source_agent provenance plumbing.
    normalizeSourceAgent,
    ALLOWED_SOURCE_AGENTS,
  };
}
