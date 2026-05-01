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
  bootPromptTemplate,
  costBand: 'subscription',
  // Sprint 47 T3 — Grok's Bun+OpenTUI input box hasn't been empirically
  // pasted-against yet (Sprint 45 T3 prep notes flagged this for verification).
  // Default to true so the helper uses the bracketed-paste fast path; if a
  // lane-time test shows the OpenTUI input handler eats the paste markers,
  // flip this to false and the inject helper falls back to chunked stdin.
  acceptsPaste: true,
};

module.exports = grokAdapter;
