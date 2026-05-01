// Claude Code adapter — Sprint 44 T3
//
// First adapter in the AGENT_ADAPTERS registry (see ./index.js). Lifts the
// claude-code logic that previously lived as hardcoded branches in
// packages/server/src/session.js. Behavior is bit-for-bit identical to the
// pre-Sprint-44 inline path: same regexes, same status strings, same
// transcript-parser cut-offs. Sprint 45 adds Codex / Gemini / Grok adapters
// alongside this one; Sprint 46 wires per-lane agent assignment in 4+1.
//
// Contract (memorialization doc § 4 + lane brief T3):
//   {
//     name:           string,                     // adapter id used in registry
//     sessionType:    string,                     // session.meta.type produced
//     matches:        (cmd) => boolean,           // command-string detection
//     spawn:          { binary, defaultArgs, env },
//     patterns:       { prompt, thinking, editing, tool, idle, error },
//     patternNames:   { error: string },          // diag-event label preservation
//     statusFor:      (data) => { status, statusDetail } | null,
//     parseTranscript:(raw) => Memory[],          // for memory-session-end hook
//     bootPromptTemplate: (lane, sprint) => string,
//     costBand:       'free' | 'pay-per-token' | 'subscription',
//   }
//
// `statusFor` returns null when no pattern matches — preserves the original
// "no change" semantics for the claude-code switch case. Caller leaves
// `meta.status` and `meta.statusDetail` untouched on null.

// ──────────────────────────────────────────────────────────────────────────
// Patterns — verbatim regexes lifted from session.js so the adapter and the
// shim remain reference-equal. Don't redeclare these elsewhere; import from
// the adapter so future tweaks land in one place.
// ──────────────────────────────────────────────────────────────────────────

const PROMPT = /^[>❯]\s/m;
const THINKING = /\b(thinking|Thinking)\b/;
const EDITING = /^(Edit|Create|Update|Delete)\s/m;
const EDITING_DETAIL = /^(Edit|Create|Update|Delete)\s+(.+)$/m;
const TOOL = /^⏺\s/m;
const IDLE = /^>\s*$/m;

// errorLineStart from session.js — line-anchored variant for claude-code
// sessions whose tool output (grep results, test logs, file dumps) routinely
// mentions "Error" mid-line without representing an actual failure.
// Sprint 40 T2 added mixed-case `Fatal` + the special-cased `npm ERR!` shape.
const ERROR = /^\s*(?:(?:error|Error|ERROR|exception|Exception|Traceback|fatal|Fatal|FATAL|segmentation fault|panic|EACCES|ECONNREFUSED|ENOENT|command not found|undefined reference|cannot find module|failed with exit code|No such file or directory|Permission denied)\b|npm ERR!)/m;

// ──────────────────────────────────────────────────────────────────────────
// statusFor — replaces the `case 'claude-code':` block of _updateStatus.
// Order matters: thinking → editing → tool → idle. First match wins, exactly
// as the original switch did with cascading `else if`s.
// ──────────────────────────────────────────────────────────────────────────

function statusFor(data) {
  if (THINKING.test(data)) {
    return { status: 'thinking', statusDetail: 'Claude is reasoning...' };
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
// parseTranscript — Claude Code JSONL format, lifted from
// packages/stack-installer/assets/hooks/memory-session-end.js:88-102.
// Emits records of shape { role: 'user'|'assistant', content: string }
// truncated to 400 chars per message. The hook itself remains the consumer
// in Sprint 44; Sprint 45 T4 wires it to read from this adapter so other
// agents can plug in their own format parsers.
// ──────────────────────────────────────────────────────────────────────────

function parseTranscript(raw) {
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
        .map((c) => c.text)
        .join(' ');
    }
    if (text) messages.push({ role, content: text.slice(0, 400) });
  }
  return messages;
}

// ──────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — minimal scaffold matching the global-CLAUDE.md 4+1
// boot block. Sprint 46 T2 will refine per-agent prompts; this is the
// placeholder so the adapter contract is complete in Sprint 44.
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
    `3. Read ~/.claude/CLAUDE.md and ./CLAUDE.md`,
    `4. Read docs/sprint-${sprintNum}-${sprintName}/PLANNING.md`,
    `5. Read docs/sprint-${sprintNum}-${sprintName}/STATUS.md`,
    `6. Read ${briefing}`,
    '',
    'Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md.',
    "Don't bump versions, don't touch CHANGELOG, don't commit.",
  ].join('\n');
}

const claudeAdapter = {
  name: 'claude',
  sessionType: 'claude-code',
  matches: (cmd) => typeof cmd === 'string' && /claude/i.test(cmd),
  spawn: {
    binary: 'claude',
    defaultArgs: [],
    env: {},
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
    error: 'errorLineStart',
  },
  statusFor,
  parseTranscript,
  bootPromptTemplate,
  costBand: 'pay-per-token',
};

module.exports = claudeAdapter;
