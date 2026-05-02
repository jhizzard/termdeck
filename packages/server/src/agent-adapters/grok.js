// Grok adapter (superagent-ai grok-dev CLI) — Sprint 45 T3
//
// Implements the 7-field adapter contract documented in ./claude.js and
// docs/AGENT-RUNTIMES.md § 5. TUI mode by default — conversation persists
// inside the PTY process for the lifetime of the panel, matching the Claude
// Code pattern. Headless `grok --prompt` is reserved for orchestrator
// background tasks (Sprint 46+) and is NOT this adapter's spawn shape.
//
// Lane-time empirical findings (Sprint 45 T3, 2026-05-01) — see
// docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md and Sprint 45 STATUS.md
// for the full investigation:
//
//   • grok-dev v1.1.5, binary `/usr/local/bin/grok` (#!/usr/bin/env bun)
//   • Session storage: SQLite at ~/.grok/grok.db, NOT JSON files in
//     ~/.grok/sessions/. Tables (STRICT, requires SQLite ≥3.37):
//       sessions(id, workspace_id, title, model, mode, status, created_at, ...)
//       messages(session_id, seq, role, message_json, created_at)
//       tool_calls, tool_results, usage_events, compactions
//     `messages.message_json` is a JSON blob in AI SDK provider shape:
//       { role: 'user'|'assistant'|'tool', content: string | Array<...> }
//     where array parts are { type: 'text', text } | { type: 'tool-call', ... }
//     | { type: 'tool-result', ... }. Sprint 45 T4 wires the memory hook to
//     extract from grok.db and feed parseTranscript a JSON envelope.
//
//   • TUI shimmer text strings (the canonical "thinking" indicator):
//       "Planning next moves"  — default isProcessing without stream content
//       "Generating plan..."   — plan-mode label
//       "Answering…"           — /btw overlay
//   • Tool indicators: TUI renders `→ <label>` (InlineTool component);
//     headless mode emits `▸ <label>`. Both forms accepted.
//   • Sub-agents: 5 built-in (general / explore / vision / verify / computer)
//     plus up to 12 user-defined customs on grok-4.20-multi-agent-0309
//     (16-agent ceiling). Sub-agent fan-out is internal to grok-dev — the
//     adapter doesn't need to surface per-sub-agent status; the parent CLI
//     emits SubagentTaskLine entries that show through as inline tool calls.
//   • Empty-state placeholder: "Message Grok…" — used only as a weak idle
//     hint, not a load-bearing pattern.
//
// Cost band: 'subscription'. Joshua's SuperGrok Heavy carries the rate
// limits; non-Heavy users supply GROK_API_KEY / XAI_API_KEY via secrets.env
// (which the spawn inherits from process.env automatically — no need to
// re-list it in spawn.env).

'use strict';

const { chooseModel } = require('./grok-models');

// ──────────────────────────────────────────────────────────────────────────
// Patterns — observed from grok-dev@1.1.5 source (dist/ui/app.js) plus
// Joshua's smoke test on 2026-05-01. TUI is OpenTUI/React-rendered with
// frequent redraws; patterns must survive ANSI strip and partial chunks.
// Conservative bias: false negatives (missed status updates) are cheaper
// than false positives (badge flapping or spurious 'errored' status).
// ──────────────────────────────────────────────────────────────────────────

// Prompt indicator — Sprint 45 T3 anchored on the empty-state placeholder
// "Message Grok…" assuming it was the only stable string in TUI output.
// That assumption was wrong: the TUI rotates placeholders ("What are we
// building?", "Bring me a problem", etc.). Sprint 47 orchestrator side-task
// extends to also match the model-mode footer line ("Grok 4.20 Reasoning",
// "Grok 4.20 Heavy", "Grok 4.20 Code", "Grok 4.20 Auto", "Grok 4.20
// Planning") which renders on every frame regardless of which placeholder
// the TUI surfaced. Version number digits stay open-ended so future Grok
// versions don't regress detection.
const PROMPT = /Message Grok[….]|Grok\s+\d+(?:\.\d+)?\s+(?:Reasoning|Heavy|Code|Auto|Planning)/;

// Thinking — Grok's three known "isProcessing" shimmer states. Hits any of
// the literal labels. The trailing variants on "Generating" / "Answering"
// cover both ASCII `...` and Unicode ellipsis.
const THINKING = /Planning next moves|Generating plan[….]|Answering[….]/;

// Tool — TUI inline-tool prefix `→ ` (in box layout) OR headless `▸ `
// (yellow ANSI in dist/headless/output.js:23). Anchored on the leading
// glyph + space to avoid mid-line `→` in prose markdown firing as a tool.
// Also catches the activity strings emitted by long-running tools.
const TOOL = /(?:^|\n)\s*[→▸]\s|Running command[….]|Starting process[….]/;

// Editing — Grok's TUI prefixes file-mutation tool calls with `Edit` /
// `Write` / `Read` / `Run` labels rendered through InlineTool. Match these
// after the tool glyph; the toolLabel function uses these verbatim.
const EDITING = /(?:^|\n)\s*[→▸]\s+(Edit|Write|Read|Run|Create|Update|Delete)\b/;
const EDITING_DETAIL = /(?:^|\n)\s*[→▸]\s+((?:Edit|Write|Read|Run|Create|Update|Delete)\b[^\n]*)/;

// Idle — empty-state shows the placeholder and the cwd footer line. Use the
// placeholder only — cwd shape varies by terminal width and home expansion.
const IDLE = /Message Grok[….]\s*$/m;

// Error — line-anchored variant matching Claude's strategy. Grok's tool
// output (grep, test logs, lsp diagnostics) routinely carries "Error" /
// "error" mid-line in a way that should NOT flip the panel to errored. Only
// fire on line-leading failure phrases — same conservative shape as Claude
// uses, plus the Grok-specific BtwOverlay error fallback "Something went
// wrong." literal (rendered in t.diffRemovedFg).
const ERROR = /(?:^|\n)\s*(?:(?:error|Error|ERROR|exception|Exception|Traceback|fatal|Fatal|FATAL|panic|EACCES|ECONNREFUSED|ENOENT|command not found|cannot find module|failed with exit code|Permission denied|Something went wrong)\b)/m;

// ──────────────────────────────────────────────────────────────────────────
// statusFor — replaces the absent grok branch in session.js _updateStatus.
// Order matches Claude's: thinking → editing → tool → idle. First match
// wins. Returns null on no-match so the caller leaves status untouched
// (preserves the "no fallthrough" semantics _updateStatus relies on).
// ──────────────────────────────────────────────────────────────────────────

function statusFor(data) {
  if (typeof data !== 'string') return null;
  if (THINKING.test(data)) {
    return { status: 'thinking', statusDetail: 'Grok is reasoning...' };
  }
  if (EDITING.test(data)) {
    const match = data.match(EDITING_DETAIL);
    return {
      status: 'editing',
      statusDetail: match ? match[1].slice(0, 80) : 'Editing files',
    };
  }
  if (TOOL.test(data)) {
    return { status: 'active', statusDetail: 'Using tools' };
  }
  if (IDLE.test(data)) {
    return { status: 'idle', statusDetail: 'Waiting for input' };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — Sprint 50 T1.
//
// Grok stores messages in `~/.grok/grok.db` (SQLite, STRICT schema requiring
// SQLite ≥3.37 — macOS system sqlite3 3.36 cannot read it; better-sqlite3
// bundles a recent build). The bundled hook (vendored to ~/.claude/hooks/)
// can't `require('better-sqlite3')` because that path is outside TermDeck's
// node_modules tree. So `resolveTranscriptPath` does the SQLite extraction
// in-process here (the server has better-sqlite3 as a top-level dep), writes
// the messages as a JSON envelope to `os.tmpdir()/termdeck-grok-<id>.json`,
// and returns the tempfile path. The hook then reads that path with
// `parseGrokJson` (a flat JSON-array parser — no SQLite needed downstream).
//
// Workspace mapping: grok.db's `workspaces.canonical_path` is the agent's
// cwd-at-startup. We match against `session.meta.cwd` to find the
// workspace_id, then pick the most recent session in that workspace whose
// `created_at >= session.meta.createdAt` (allowing a small clock-skew
// epsilon). Returns null gracefully if better-sqlite3 isn't loadable, the
// DB doesn't open, the workspace isn't found, or no session matches.
// ──────────────────────────────────────────────────────────────────────────

const _GROK_RESOLVE_EPSILON_MS = 5_000;

async function resolveTranscriptPath(session) {
  if (!session || !session.meta || !session.meta.cwd) return null;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (_) { return null; }  // dep missing → no-op
  const dbPath = path.join(os.homedir(), '.grok', 'grok.db');
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (_) { return null; }
  try {
    const ws = db.prepare(
      'SELECT id FROM workspaces WHERE canonical_path = ? LIMIT 1'
    ).get(session.meta.cwd);
    if (!ws) return null;
    const createdAtMs = session.meta.createdAt
      ? Date.parse(session.meta.createdAt) - _GROK_RESOLVE_EPSILON_MS
      : 0;
    const grokSession = db.prepare(
      'SELECT id, created_at FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(ws.id);
    if (!grokSession) return null;
    if (createdAtMs && Date.parse(grokSession.created_at) < createdAtMs) {
      return null;  // most recent grok session predates this panel — no match
    }
    const rows = db.prepare(
      'SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(grokSession.id);
    if (!rows || rows.length === 0) return null;
    const envelope = [];
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.message_json); } catch (_) { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const role = parsed.role;
      if (role !== 'user' && role !== 'assistant') continue;
      envelope.push({ role, content: parsed.content });
    }
    if (envelope.length === 0) return null;
    const safeId = String(session.id || `unknown-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpfile = path.join(os.tmpdir(), `termdeck-grok-${safeId}.json`);
    fs.writeFileSync(tmpfile, JSON.stringify(envelope), 'utf8');
    return tmpfile;
  } catch (_) {
    return null;
  } finally {
    try { db.close(); } catch (_) { /* fail-soft */ }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// parseTranscript — Grok stores messages in SQLite (~/.grok/grok.db), not
// in a JSONL file. The adapter contract is `(raw: string) => Memory[]`, so
// the caller (the memory-session-end hook, refactored in Sprint 45 T4) is
// responsible for extracting `messages.message_json` rows from grok.db and
// passing them in as a JSON string envelope. Two accepted shapes:
//
//   1. JSON array of message objects (preferred):
//        '[{"role":"user","content":"hi"},{"role":"assistant","content":[...]}]'
//   2. JSONL — one message JSON per line (back-compat with hooks that
//      replay grok.db rows verbatim):
//        '{"role":"user","content":"hi"}\n{"role":"assistant","content":[...]}'
//
// Both fall through to the same per-message loop. message.content matches
// the AI SDK provider shape: string OR array of { type: 'text', text } |
// { type: 'tool-call', ... } | { type: 'tool-result', ... }. We extract the
// text parts only — tool calls and results are surfaced via the `tool_calls`
// and `tool_results` tables in grok.db, which the hook layer treats
// separately if it wants tool-trace memories.
// ──────────────────────────────────────────────────────────────────────────

function _extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join(' ');
  }
  return '';
}

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  // Try JSON-array first — the preferred envelope.
  let messages = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) messages = parsed;
  } catch (_) { /* fall through to JSONL */ }

  // JSONL fallback — line-by-line parse, skip malformed lines (matches
  // Claude adapter's tolerance).
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
    const text = _extractText(msg.content);
    if (text) out.push({ role, content: text.slice(0, 400) });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — Grok reads `AGENTS.md` (per docs/AGENT-RUNTIMES.md
// § 4: convergent file with Codex via the sync-agent-instructions.js
// generator). The boot block points the lane at AGENTS.md instead of
// CLAUDE.md and uses the same `memory_recall + read instructional file +
// read sprint docs` shape as Claude. Sprint 46 T2 will refine per-agent
// boot prompts further; this is the contract-complete placeholder.
// ──────────────────────────────────────────────────────────────────────────

function bootPromptTemplate(lane = {}, sprint = {}) {
  const tn = lane.id || 'T?';
  const sprintNum = sprint.number || '?';
  const sprintName = sprint.name || 'unnamed';
  const project = lane.project || sprint.project || 'termdeck';
  const briefing = lane.briefingPath || `docs/sprint-${sprintNum}-${sprintName}/${tn}-<lane>.md`;
  const topic = lane.topic || lane.briefingPath || sprintName;
  return [
    `You are ${tn} in Sprint ${sprintNum} (${sprintName}). Boot sequence:`,
    `1. memory_recall(project="${project}", query="${topic}")`,
    `2. memory_recall(query="recent decisions and bugs")`,
    `3. Read ~/.claude/CLAUDE.md and ./AGENTS.md`,
    `4. Read docs/sprint-${sprintNum}-${sprintName}/PLANNING.md`,
    `5. Read docs/sprint-${sprintNum}-${sprintName}/STATUS.md`,
    `6. Read ${briefing}`,
    '',
    'Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md.',
    "Don't bump versions, don't touch CHANGELOG, don't commit.",
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// mcpConfig — Sprint 48 T3. Grok's MCP-server registry lives at
// `~/.grok/user-settings.json` under the `mcp.servers` key, which is an
// **ARRAY** of `McpServerConfig` items, NOT a record `mcpServers.NAME` like
// Codex/Gemini use. Authoritative schema lifted from
// `/usr/local/lib/node_modules/grok-dev/dist/utils/settings.{d.ts,js}`
// (Bun-bundled source, package `grok-dev` v1.1.5):
//
//   interface McpServerConfig {
//     id: string; label: string; enabled: boolean;
//     transport: "http" | "sse" | "stdio";
//     command?, args?, env?, cwd?, url?, headers?
//   }
//   interface McpSettings { servers?: McpServerConfig[] }
//   interface UserSettings { ..., mcp?: McpSettings }
//   function loadMcpServers(): UserSettings.mcp?.servers ?? []
//   function saveMcpServers(servers): saveUserSettings({ mcp: { servers } })
//
// Hot-load behavior: agent.js calls `loadMcpServers()` at the start of every
// agent turn (3 sites: stream / batch / child-agent), so MCP changes are
// picked up on the next user message — no Grok restart required.
//
// Schema-divergence implication: the `mcpServersKey + mnestraBlock` record-
// merge shape used by gemini.js (Sprint 48 T2) and the TOML-append shape used
// by codex.js cannot represent Grok's array-with-explicit-id-fields layout.
// Grok therefore declares a `merge(rawText, { secrets }) -> { changed, output }`
// escape-hatch on its `mcpConfig`. The shared `mcp-autowire.js` helper
// (Sprint 48 T1) checks for `mcpConfig.merge` first; if present, the adapter
// owns parse + mutate + serialize, the helper still owns tilde-expansion +
// parent-dir creation + atomic write + idempotency reporting. See Sprint 48
// STATUS.md § T3 FIX-PROPOSED for the coordination decision.
//
// Env-key omission discipline matches stack-installer/src/index.js:336-339
// and the Gemini adapter: empty/missing/`${VAR}`-placeholder values are
// dropped from the env object instead of written as empty strings, because
// Grok (like Claude Code and Gemini) does not shell-expand `${VAR}` in MCP
// env. Mnestra's own secrets.env stdio fallback (mnestra@0.3.4) loads what
// is missing at process start.
// ──────────────────────────────────────────────────────────────────────────

const MNESTRA_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];

function _pickConcreteEnv(secrets) {
  const env = {};
  if (!secrets || typeof secrets !== 'object') return env;
  for (const key of MNESTRA_ENV_KEYS) {
    const value = secrets[key];
    if (typeof value !== 'string') continue;
    if (value.length === 0) continue;
    // Reject literal `${VAR}` placeholders — Grok won't shell-expand them.
    if (/^\$\{[^}]*\}$/.test(value)) continue;
    env[key] = value;
  }
  return env;
}

function _buildMnestraServer({ secrets } = {}) {
  return {
    id: 'mnestra',
    label: 'Mnestra',
    enabled: true,
    transport: 'stdio',
    command: 'mnestra',
    args: [],
    env: _pickConcreteEnv(secrets),
  };
}

// Deep-equal check scoped to the fields we manage. Unknown extra fields on
// the existing entry (e.g. user-added `cwd` overrides) are tolerated — we
// only refresh the entry when one of OUR managed fields drifts. Prevents
// the helper from clobbering hand-edited Grok customizations on every spawn.
function _mnestraEntryEqual(existing, desired) {
  if (!existing || typeof existing !== 'object') return false;
  for (const key of ['id', 'label', 'enabled', 'transport', 'command']) {
    if (existing[key] !== desired[key]) return false;
  }
  const a = Array.isArray(existing.args) ? existing.args : [];
  const b = desired.args;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  const ea = existing.env && typeof existing.env === 'object' ? existing.env : {};
  const eb = desired.env;
  const eaKeys = Object.keys(ea).sort();
  const ebKeys = Object.keys(eb).sort();
  if (eaKeys.length !== ebKeys.length) return false;
  for (let i = 0; i < eaKeys.length; i += 1) {
    if (eaKeys[i] !== ebKeys[i]) return false;
    if (ea[eaKeys[i]] !== eb[ebKeys[i]]) return false;
  }
  return true;
}

function _mergeMnestraIntoGrokSettings(rawText, { secrets } = {}) {
  let current = {};
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed;
      }
    } catch (_) {
      // Malformed JSON → start fresh. Helper's atomic-write contract means
      // we don't risk corrupting the user's file partway through; on read
      // failure the conservative path is to write a clean replacement that
      // preserves the keys we know how to round-trip (none — we only own
      // the mcp branch). User's other settings in a corrupt file are
      // unrecoverable from text anyway.
      current = {};
    }
  }
  const next = { ...current };
  next.mcp = next.mcp && typeof next.mcp === 'object' && !Array.isArray(next.mcp)
    ? { ...next.mcp }
    : {};
  const servers = Array.isArray(next.mcp.servers) ? [...next.mcp.servers] : [];
  const desired = _buildMnestraServer({ secrets });
  const existingIdx = servers.findIndex((s) => s && s.id === 'mnestra');
  if (existingIdx >= 0 && _mnestraEntryEqual(servers[existingIdx], desired)) {
    return { changed: false, output: rawText };
  }
  if (existingIdx >= 0) {
    servers[existingIdx] = desired;
  } else {
    servers.push(desired);
  }
  next.mcp.servers = servers;
  return { changed: true, output: `${JSON.stringify(next, null, 2)}\n` };
}

// ──────────────────────────────────────────────────────────────────────────
// Adapter export. spawn.env.GROK_MODEL defaults to the cheap-fast tier;
// per-lane override is the launcher's job at session-spawn time (Sprint 46
// reads `agent: grok` + optional `model-hint: code|reasoning-deep|...` from
// the lane brief frontmatter and overlays). GROK_API_KEY isn't repeated in
// spawn.env because the PTY inherits it from the TermDeck server's process
// env; the secrets.env load at server boot is the canonical path.
// ──────────────────────────────────────────────────────────────────────────

const grokAdapter = {
  name: 'grok',
  sessionType: 'grok',
  // Sprint 50 T3 — see claude.js for rationale.
  displayName: 'Grok CLI',
  matches: (cmd) => typeof cmd === 'string' && /(?:^|\s|\/)grok(?:\b|$)/i.test(cmd),
  spawn: {
    binary: 'grok',
    defaultArgs: [],
    env: {
      GROK_MODEL: chooseModel(),
    },
  },
  patterns: {
    prompt: PROMPT,
    thinking: THINKING,
    editing: EDITING,
    tool: TOOL,
    idle: IDLE,
    error: ERROR,
  },
  patternNames: {
    error: 'grok-error',
    tool: 'grok-tool',
  },
  statusFor,
  parseTranscript,
  // Sprint 50 T1 — 10th adapter field. SQLite extraction → tempfile JSON
  // envelope (see header above for rationale + workspace mapping).
  resolveTranscriptPath,
  bootPromptTemplate,
  costBand: 'subscription',
  // Sprint 47 T3 — Grok's Bun+OpenTUI input box hasn't been empirically
  // pasted-against yet (Sprint 45 T3 prep notes flagged this for verification).
  // Default to true so the helper uses the bracketed-paste fast path; if a
  // lane-time test shows the OpenTUI input handler eats the paste markers,
  // flip this to false and the inject helper falls back to chunked stdin.
  acceptsPaste: true,
  // Sprint 48 T3 — see comment block above for schema notes + provenance.
  // Grok deviates from Codex (TOML) and Gemini (JSON record) — its `mcp.servers`
  // is an array with explicit `id`/`label`/`enabled`/`transport` fields, so the
  // adapter declares a `merge` escape-hatch instead of `mcpServersKey + mnestraBlock`.
  mcpConfig: {
    path: '~/.grok/user-settings.json',
    format: 'json',
    merge: _mergeMnestraIntoGrokSettings,
  },
};

module.exports = grokAdapter;
