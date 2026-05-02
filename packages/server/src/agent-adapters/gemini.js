// Gemini CLI adapter — Sprint 45 T2
//
// Lifts the previously-hardcoded gemini logic out of session.js into the
// AGENT_ADAPTERS registry alongside the Claude adapter shipped in Sprint 44
// T3. Behavior is bit-for-bit identical to the pre-Sprint-45 inline path:
// same `^gemini>` prompt regex, same `Generating|Working` thinking regex,
// same status strings ("Gemini is generating..." / "Waiting for input"),
// same loose `/gemini/i` command-string match. parseTranscript is the new
// capability — Gemini sessions previously didn't write to Mnestra because
// the memory hook assumed Claude JSONL.
//
// Contract — see ./claude.js header for the full 7-field shape.
//
// Patterns intentionally omit `error`. The fallback in session.js
// `_detectErrors` (`adapter.patterns.error || PATTERNS.error`) lets generic
// prose-shape error detection continue to apply to Gemini sessions, which
// matches the pre-Sprint-45 behavior. Sprint 46+ can layer in a Gemini-
// specific line-anchored error pattern once we've observed enough TUI
// output to know what false positives to dodge.

// ──────────────────────────────────────────────────────────────────────────
// Patterns — verbatim regexes lifted from session.js's PATTERNS.geminiCli
// (lines 47-50). Reference-equal preservation matters because session.js
// keeps a `PATTERNS.geminiCli` shim that points back at these regex
// objects, the same way `PATTERNS.claudeCode.*` shimmed Sprint 44 T3.
// ──────────────────────────────────────────────────────────────────────────

const PROMPT = /^gemini>\s/m;
const THINKING = /\b(Generating|Working)\b/;

// ──────────────────────────────────────────────────────────────────────────
// statusFor — replaces the `case 'gemini':` block of _updateStatus. Order
// matches the legacy switch's `if/else if` cascade exactly: thinking wins,
// then prompt → idle. No editing/tool/error branches in the legacy switch,
// so statusFor has none either; null returns leave the status untouched
// just like the legacy fall-through.
// ──────────────────────────────────────────────────────────────────────────

function statusFor(data) {
  if (THINKING.test(data)) {
    return { status: 'thinking', statusDetail: 'Gemini is generating...' };
  }
  if (PROMPT.test(data)) {
    return { status: 'idle', statusDetail: 'Waiting for input' };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// parseTranscript — Gemini CLI session JSON format (NOT JSONL).
//
// Captured shape (from `gemini -p "say hi"` 2026-05-01):
//   {
//     sessionId, projectHash, startTime, lastUpdated, kind,
//     messages: [
//       { id, timestamp, type: 'user',   content: [{ text: '...' }] },
//       { id, timestamp, type: 'gemini', content: '...', thoughts, tokens, model },
//       ...
//     ]
//   }
//
// The user role carries a content ARRAY of `{text}` parts; the gemini
// (assistant) role carries a STRING. We normalize both to the Claude
// adapter's output shape — `{ role: 'user'|'assistant', content: string }`
// truncated to 400 chars — so the memory-hook summary builder doesn't have
// to branch on adapter type.
//
// `type: 'gemini'` maps to `role: 'assistant'` for cross-adapter parity.
// ──────────────────────────────────────────────────────────────────────────

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let session;
  try { session = JSON.parse(raw); } catch (_) { return []; }
  if (!session || !Array.isArray(session.messages)) return [];

  const messages = [];
  for (const msg of session.messages) {
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

// ──────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — placeholder mirroring the Claude adapter's shape.
// Points at GEMINI.md (the auto-generated mirror of CLAUDE.md per Sprint 44
// T2's sync-agent-instructions.js script). Sprint 46 T2 will refine the
// per-agent boot prompt — Gemini doesn't have Claude's `memory_recall` MCP
// tool out-of-the-box, so the lane brief shape may need agent-specific
// scaffolding. The placeholder here keeps the contract complete.
// ──────────────────────────────────────────────────────────────────────────

function bootPromptTemplate(lane = {}, sprint = {}) {
  const tn = lane.id || 'T?';
  const sprintNum = sprint.number || '?';
  const sprintName = sprint.name || 'unnamed';
  const project = (lane.project || sprint.project || 'termdeck');
  const briefing = lane.briefingPath || `docs/sprint-${sprintNum}-${sprintName}/${tn}-<lane>.md`;
  return [
    `You are ${tn} in Sprint ${sprintNum} (${sprintName}). Boot sequence:`,
    `1. memory_recall(project="${project}", query="<topic>")`,
    `2. memory_recall(query="<broader topic>")`,
    `3. Read ~/.claude/CLAUDE.md and ./GEMINI.md`,
    `4. Read docs/sprint-${sprintNum}-${sprintName}/PLANNING.md`,
    `5. Read docs/sprint-${sprintNum}-${sprintName}/STATUS.md`,
    `6. Read ${briefing}`,
    '',
    'Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md.',
    "Don't bump versions, don't touch CHANGELOG, don't commit.",
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// mcpConfig — Sprint 48 T2. Declarative description of where Gemini reads
// its MCP-server registry and how to write a Mnestra entry into it. The
// shared helper at packages/server/src/mcp-autowire.js (Sprint 48 T1) uses
// this on panel spawn to ensure `memory_recall` is available out-of-the-box
// for outside users running mixed 4+1 with a Gemini lane.
//
// Schema reference: https://www.geminicli.com/docs/tools/mcp-server
// (verified 2026-05-02). Top-level key is `mcpServers` (camelCase). Each
// entry must specify exactly one transport — `command` (stdio), `url`
// (SSE), or `httpUrl` (HTTP streaming). Mnestra ships as a stdio binary
// (`mnestra`), so we use `command`.
//
// Note (no `type` field): the `type: 'stdio'` field used in the Claude
// Code config (~/.claude.json `mcp_servers.mnestra.type`) is a Claude-Code
// extension. Gemini infers transport from which of command/url/httpUrl is
// set, so we omit `type` here to keep the entry valid against the
// documented Gemini schema.
//
// Note (restart required): Gemini CLI discovers MCP servers at startup, so
// adding a new entry only takes effect on the next `gemini` launch. The
// helper still writes immediately on panel spawn — by the time the user
// types `gemini` in the panel, the entry is in place.
//
// Note (env-key omission): empty/missing secrets are intentionally
// dropped from the env object instead of written as empty strings. This
// matches stack-installer/src/index.js:336-339 — concrete-or-omit, never
// placeholder, because Gemini (like Claude Code) does not shell-expand
// `${VAR}` references in MCP env. Mnestra's own secrets.env fallback
// loads what's missing at process start.
// ──────────────────────────────────────────────────────────────────────────

const MNESTRA_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];

function buildMnestraBlock({ secrets } = {}) {
  const env = {};
  for (const key of MNESTRA_ENV_KEYS) {
    const value = secrets && secrets[key];
    if (value) env[key] = value;
  }
  return {
    mnestra: {
      command: 'mnestra',
      env,
    },
  };
}

const geminiAdapter = {
  name: 'gemini',
  sessionType: 'gemini',
  matches: (cmd) => typeof cmd === 'string' && /gemini/i.test(cmd),
  spawn: {
    binary: 'gemini',
    defaultArgs: [],
    // GEMINI_API_KEY is read via `process.env` at spawn time by index.js'
    // PTY env merge — declared here for documentation / discoverability,
    // not for in-adapter overriding. OAuth-personal is the typical auth
    // path (settings.json `security.auth.selectedType: 'oauth-personal'`).
    env: {},
  },
  patterns: {
    prompt: PROMPT,
    thinking: THINKING,
    // editing / tool / error intentionally omitted — see header comment.
  },
  patternNames: {
    // No adapter-owned error pattern → session.js falls back to the
    // generic `PATTERNS.error` and the `'error'` diag label, which is
    // exactly what gemini-typed sessions saw pre-Sprint-45.
  },
  statusFor,
  parseTranscript,
  bootPromptTemplate,
  costBand: 'pay-per-token',
  // Sprint 47 T3 — Gemini's CLI is paste-friendly per the single-JSON-object
  // session shape captured in Sprint 45 T2; bracketed-paste injects cleanly.
  acceptsPaste: true,
  // Sprint 48 T2 — see comment block above for schema notes + provenance.
  mcpConfig: {
    path: '~/.gemini/settings.json',
    format: 'json',
    mcpServersKey: 'mcpServers',
    mnestraBlock: buildMnestraBlock,
  },
};

module.exports = geminiAdapter;
