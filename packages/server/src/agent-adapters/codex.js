// Codex CLI adapter — Sprint 45 T1
//
// Second adapter in the AGENT_ADAPTERS registry (see ./index.js). Sprint 44 T3
// shipped the Claude adapter as the reference implementation; this file is the
// recipe in `docs/AGENT-RUNTIMES.md` § 6 turned into running code for Codex
// CLI (`/usr/local/bin/codex`, v0.125.0 verified 2026-05-01).
//
// This is *Codex-as-its-own-panel* — distinct from the existing
// `codex@openai-codex` Claude Code plugin which is a delegate-from-Claude
// pathway. Sprint 46 wires per-lane agent assignment; this lane just makes
// `codex` work end-to-end inside a TermDeck panel: type detection, status
// badge, transcript ingestion into Mnestra.
//
// Contract — see ./claude.js header for the full annotated shape.
//
// Pattern provenance:
// • Codex CLI ships a Ratatui (Rust) TUI. The TUI redraws on each turn so the
//   raw PTY stream is heavy in ANSI escapes; session.js stripAnsi() runs
//   *before* these regexes, so the patterns assume cleaned text.
// • The headless `codex exec` mode emits a documented sequence: a `--------`
//   header block, `user` / `codex` speaker lines on their own row, function
//   `exec_command` blocks, and a `tokens used` footer. The TUI mirrors these
//   speaker shapes inside its rendered chat surface.
// • Reasoning markers come from the JSONL `response_item.payload.type=reasoning`
//   events that the TUI renders as a "Thinking…" status line.
// • Apply-patch / exec markers come from `response_item.payload.type=function_call`
//   entries with names like `apply_patch` and `exec_command`.
//
// Patterns are conservative defaults — Sprint 45 T4 / Sprint 46 will tune
// against captured real-world TUI output. Snapshot tests in
// tests/agent-adapter-codex.test.js pin the current behavior so any tuning
// is an explicit, reviewed change.

// ──────────────────────────────────────────────────────────────────────────
// Patterns
// ──────────────────────────────────────────────────────────────────────────

// Codex prompt detection. Three shapes accepted:
//   1. `codex>` literal (mirrors gemini's `gemini>` and the codex CLI's REPL
//      prompt convention — used by `codex resume` interactive sessions).
//   2. A bare `codex` line (the speaker label the TUI prints above an
//      assistant turn AND that headless `codex exec` prints before the reply).
//   3. The `--------` divider that wraps the codex header block in headless
//      mode and bookends turns in the TUI.
const PROMPT = /^(?:codex>\s|codex\s*$|--------\s*$)/m;

// Reasoning indicator. Codex's TUI status line shows "Thinking" while the
// model reasons; "Reasoning" appears in some headless transcripts; "Working"
// is what `codex exec` prints for tool-loop progress.
const THINKING = /\b(Thinking|Reasoning|Working)\b/;

// File edit / patch markers. Codex applies diffs through the `apply_patch`
// tool which the TUI renders as `Apply patch <file>` headers. Plain
// Edit/Create/Update/Delete shapes are also kept so simple file ops register
// (mirrors the Claude adapter's editing markers for cross-adapter parity).
const EDITING = /^(Apply patch|Edit|Create|Update|Delete|Modified)\s/m;
const EDITING_DETAIL = /^(Apply patch|Edit|Create|Update|Delete|Modified)\s+(.+)$/m;

// Tool / shell-exec markers. Codex's TUI prefixes shell commands with `$`
// (chat-shell convention), arrow `→` for read tool calls, and bare keywords
// `exec` / `Running` / `Calling` for the phase between dispatch and result.
// `exec_command` is Codex's function-call name (verified in rollout JSONL
// 2026-05-01); the alternation handles both bare `exec` and the underscored
// `exec_command` shape (the underscore is a word character so `exec\b`
// alone wouldn't match `exec_command`).
const TOOL = /^(?:\$\s|→\s|exec(?:_command\b|\b)|Running\b|Calling\b)/m;

// Idle / waiting-for-input. The TUI returns to the bare `codex` speaker
// label when it's done reasoning and waiting on the user.
const IDLE = /^codex\s*$/m;

// Error patterns — line-anchored to avoid mid-line "error" mentions in tool
// output (grep results, test logs, file dumps) flagging false positives.
// Same shape as Claude with codex-specific OpenAI-API failure modes added
// (rate-limit 429, model-not-found, invalid_api_key) which surface as visible
// strings in Codex's error reporting and would otherwise slip through.
const ERROR = /^\s*(?:(?:error|Error|ERROR|exception|Exception|Traceback|fatal|Fatal|FATAL|segmentation fault|panic|EACCES|ECONNREFUSED|ENOENT|command not found|undefined reference|cannot find module|failed with exit code|No such file or directory|Permission denied|429\s+Too Many Requests|rate.?limit|invalid_api_key|model_not_found|insufficient_quota)\b|npm ERR!)/m;

// ──────────────────────────────────────────────────────────────────────────
// statusFor — Codex panel status. Order mirrors Claude's cascade:
// thinking → editing → tool → idle. First match wins.
// ──────────────────────────────────────────────────────────────────────────

function statusFor(data) {
  if (THINKING.test(data)) {
    return { status: 'thinking', statusDetail: 'Codex is reasoning...' };
  }
  if (EDITING.test(data)) {
    const match = data.match(EDITING_DETAIL);
    return {
      status: 'editing',
      statusDetail: match ? `${match[1]} ${match[2]}` : 'Editing files',
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
// parseTranscript — Codex JSONL format.
//
// Each line is `{ timestamp, type, payload }`. We want only:
//   type === 'response_item' && payload.type === 'message'
// with payload.role in {user, assistant}. The 'developer' role carries the
// permissions/sandbox prelude — skip. `event_msg` lines duplicate the
// canonical message channel and additionally carry exec_command_end shell
// output blocks — skip too.
//
// content is an array of { type: 'input_text' | 'output_text', text: string }
// (sometimes plain `text`). Joined with spaces and truncated to 400 chars
// per message (same cut-off Claude uses).
// ──────────────────────────────────────────────────────────────────────────

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const lines = raw.split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || entry.type !== 'response_item') continue;
    const p = entry.payload;
    if (!p || p.type !== 'message') continue;
    const role = p.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = p.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text'))
        .map((c) => c.text || '')
        .join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }
  return messages;
}

// ──────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — Codex variant of the Claude scaffold. Points at
// AGENTS.md (Codex's instructional file) instead of CLAUDE.md. Sprint 46 T2
// will refine per-agent prompts; this is the placeholder so the contract is
// uniform across all four adapters.
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
    `3. Read ~/.claude/CLAUDE.md and ./AGENTS.md`,
    `4. Read docs/sprint-${sprintNum}-${sprintName}/PLANNING.md`,
    `5. Read docs/sprint-${sprintNum}-${sprintName}/STATUS.md`,
    `6. Read ${briefing}`,
    '',
    'Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md.',
    "Don't bump versions, don't touch CHANGELOG, don't commit.",
  ].join('\n');
}

const codexAdapter = {
  name: 'codex',
  sessionType: 'codex',
  matches: (cmd) => typeof cmd === 'string' && /\bcodex\b/i.test(cmd),
  spawn: {
    binary: 'codex',
    defaultArgs: [],
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
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
    error: 'codexErrorLineStart',
  },
  statusFor,
  parseTranscript,
  bootPromptTemplate,
  costBand: 'pay-per-token',
  // Sprint 47 T3 — Codex's Ratatui TUI accepts bracketed-paste per the
  // Sprint 45 T1 audit; safe to use the two-stage submit pattern unchanged.
  acceptsPaste: true,
  // Sprint 48 T1 — per-agent MCP auto-wire descriptor consumed by
  // packages/server/src/mcp-autowire.js. Codex reads MCP servers from
  // ~/.codex/config.toml in the canonical `[mcp_servers.NAME]` shape with a
  // sibling `[mcp_servers.NAME.env]` table (snake_case, NOT camelCase — that
  // distinguishes Codex's TOML schema from the JSON-based agents).
  mcpConfig: {
    path: '~/.codex/config.toml',
    format: 'toml',
    mnestraBlock: ({ secrets }) => {
      const lines = ['[mcp_servers.mnestra]', 'command = "mnestra"'];
      const wanted = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
      const env = {};
      for (const k of wanted) {
        if (secrets && typeof secrets[k] === 'string' && secrets[k].length > 0) {
          env[k] = secrets[k];
        }
      }
      if (Object.keys(env).length > 0) {
        lines.push('');
        lines.push('[mcp_servers.mnestra.env]');
        for (const [k, v] of Object.entries(env)) {
          // TOML basic-string escaping — backslash + double-quote.
          const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          lines.push(`${k} = "${escaped}"`);
        }
      }
      return lines.join('\n') + '\n';
    },
    detectExisting: (text) => /^\s*\[mcp_servers\.mnestra\]\s*$/m.test(text),
  },
};

module.exports = codexAdapter;
