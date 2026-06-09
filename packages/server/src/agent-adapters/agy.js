// Antigravity CLI (`agy`) adapter — Sprint 70 T1
//
// Fifth adapter in the AGENT_ADAPTERS registry (see ./index.js). Makes an
// Antigravity panel a first-class TermDeck agent whose transcript is written
// to Mnestra at panel close, the same lifecycle Claude/Codex/Gemini/Grok get.
//
// ── The one hard constraint: NO readable on-disk transcript ──────────────────
// Antigravity stores conversations as protobuf at
//   ~/.gemini/antigravity-cli/conversations/<uuid>.pb        (opaque binary)
// and a flat prompt-history at
//   ~/.gemini/antigravity-cli/history.jsonl                  ({display,ts,workspace})
// — the `.pb` has no readable schema and history.jsonl carries NO assistant
// turns (same flat-history shape codex.js explicitly rejects). Verified live
// 2026-06-07 (agy v1.0.0 binary / banner reports 1.0.6). So unlike every other
// adapter — which resolves a structured transcript FILE and lets the bundled
// hook parse it — agy has to capture the transcript **in-flight from the PTY
// stdout stream** and materialize it for the close handler.
//
// ── Capture architecture (what's load-bearing vs residual) ───────────────────
// LOAD-BEARING: the PTY tee. spawnTerminalSession (index.js) tees every PTY
//   chunk into `session._stdoutCapture` when an adapter opts in via
//   `capture.mode === 'stdout'` (this adapter is the first to do so; the other
//   four are unchanged). A PTY is a TTY, so the child flushes on exit and the
//   close-time buffer is lossless — the tee alone satisfies the close-proof.
// RESIDUAL: the `stdbuf` buffering-defense (capture.unbuffer). agy is a
//   compiled Mach-O binary, so `libstdbuf` (LD_PRELOAD) is inert for it; the
//   wrap is a best-effort, gracefully-degrading layer that only matters for
//   future line-buffered C-stdio capture-mode adapters and for timelier
//   mid-session periodic checkpoints. NOT `unbuffer` (it forks its own pty →
//   double-pty → breaks the interactive-TTY semantics Sprint 64 T2 protects).
//
// resolveTranscriptPath reads `session._stdoutCapture`, runs parseTranscript to
// clean + segment, writes a **Gemini-shaped JSON envelope** to os.tmpdir(), and
// returns that path — exactly grok.js's "live source → tempfile envelope →
// existing hook" pattern, so onPanelClose's close→hook path is reused with no
// second write path. The envelope shape (`{messages:[{type,content}]}`) is what
// the bundled hook's `parseAutoDetect`/`parseGeminiJson` already consume, so
// agy rows ingest WITHOUT a dedicated `TRANSCRIPT_PARSERS['antigravity']` entry
// (decoupling T1 from T3's hook edits; T3 owns only the source_agent allowlist).
//
// ── source_agent attribution ─────────────────────────────────────────────────
// `name: 'antigravity'` is the canonical source_agent — onPanelClose emits
// `source_agent: adapter.name` (and, post-Sprint-70-T3, `adapter.sourceAgent ||
// adapter.name`). The explicit `sourceAgent: 'antigravity'` field below is
// belt-and-suspenders: self-documents intent and survives any future rename of
// `name`. T3 adds `'antigravity'` to the hook's ALLOWED_SOURCE_AGENTS (+ an
// `agy → antigravity` alias) so the row isn't coerced to 'claude'.
//
// ── Transcript fidelity (honest ceiling) ─────────────────────────────────────
// Capturing a rich full-screen TUI's stdout yields a FUZZY, RAG-grade transcript
// — not a verbatim log. agy uses truecolor ANSI, cursor positioning, a brief
// alt-screen (sign-in spinner: enter `?1049h` → exit `?1049l`), box-drawing
// rules, Braille spinners, and a slash-command menu. We strip ANSI, collapse
// carriage-return overdraws, drop box/Braille chrome lines, and de-duplicate
// redraw frames. The substantive conversation survives (it's embedded for
// semantic recall); precise per-turn role boundaries are approximate. The clean
// path is an `agy --print` panel (one-shot, plain CRLF text — verified). Full
// terminal emulation to perfectly reconstruct turns would be a disproportionate
// dependency (INSTALLER-PITFALLS Class H); best-effort is the right altitude.
//
// Contract — see ./claude.js header for the full annotated adapter shape.

'use strict';

// ──────────────────────────────────────────────────────────────────────────
// Patterns. Best-effort, calibrated against the real interactive capture
// (2026-06-07). Status detection is NOT load-bearing for the capture proof —
// follow-up: tune `thinking` against a real model-turn capture (the calibration
// session exited before the model replied, so the thinking spinner's text label
// is inferred from the Gemini family, not yet observed verbatim).
// ──────────────────────────────────────────────────────────────────────────

// Idle / prompt indicator. agy renders an input box `> ` and a persistent
// "Antigravity CLI" banner line. Anchored on the banner (agy-distinctive — avoids
// agy's prompt regex stealing cross-adapter detection from other panels' `> `
// output) OR the bare input-box prompt.
const PROMPT = /Antigravity CLI|^[>❯]\s/m;

// Thinking indicator. Antigravity is a Gemini-family CLI (banner: "Gemini 3.5
// Flash"); mirror gemini/grok's working-state vocabulary. Conservative —
// word-anchored to avoid prose false positives.
const THINKING = /\b(Thinking|Generating|Working|Reasoning)\b/;

// ──────────────────────────────────────────────────────────────────────────
// statusFor — best-effort panel status. thinking → idle, first match wins;
// null leaves meta.status untouched (the contract's "no change" semantics).
// ──────────────────────────────────────────────────────────────────────────

function statusFor(data) {
  if (typeof data !== 'string') return null;
  if (THINKING.test(data)) {
    return { status: 'thinking', statusDetail: 'Antigravity is generating...' };
  }
  if (PROMPT.test(data)) {
    return { status: 'idle', statusDetail: 'Waiting for input' };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Capture cleaning helpers (the raw-TUI path).
// ──────────────────────────────────────────────────────────────────────────

// Strip ANSI/VT control sequences. Order matters: OSC (terminated by BEL or
// ST) first, then CSI (ESC [ params intermediates final), then any remaining
// nF/Fe/Fs two-byte escapes, then a catch-all. Verified against the real agy
// capture (truecolor SGR, cursor moves, alt-screen toggles, bracketed-paste,
// cursor-shape — all removed cleanly).
function _stripAnsi(s) {
  return s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')          // OSC … BEL|ST
    .replace(/\x1b[\[\]][\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '') // CSI (+ private)
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')            // nF/Fp/Fe/Fs escapes
    .replace(/\x1b./g, '');                                 // any other ESC pair
}

// Collapse carriage-return overdraws. agy emits CRLF line endings (verified)
// AND lone-CR spinner redraws (`⣾…\r⣷…\r⣯…`). Normalize CRLF → LF first, then
// for each line keep only the text after the LAST lone CR (the final overwrite).
function _normalizeOverdraw(s) {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i >= 0 ? line.slice(i + 1) : line;
    })
    .join('\n');
}

// A line is "chrome" (drop it) when it's dominated by box-drawing (U+2500–257F)
// or Braille (U+2800–28FF, the spinner block) glyphs. ASCII rules like markdown
// `---`/`***` use hyphen/asterisk (NOT box-drawing), so real markdown content is
// never caught here. Threshold 0.5 keeps short mixed lines that carry real text.
function _isChromeLine(line) {
  const stripped = line.replace(/\s/g, '');
  if (stripped.length === 0) return true;
  let glyphs = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2500 && cp <= 0x257f) || (cp >= 0x2800 && cp <= 0x28ff)) glyphs += 1;
  }
  return glyphs / stripped.length >= 0.5;
}

// Raw PTY/TUI capture → [{role, content}]. Strip → normalize → de-chrome →
// de-duplicate consecutive redraw frames → segment. Role attribution is
// best-effort: default 'assistant' (the bulk of substantive TUI text is model
// output); a line that is the echo of a typed prompt (sits on/after the `> `
// input box) is marked 'user'. Each emitted record is truncated to 400 chars to
// match the other adapters' parsers and the hook's summary builder.
function _cleanAndSegment(raw) {
  const cleaned = _normalizeOverdraw(_stripAnsi(raw))
    // Drop remaining C0 controls except newline/tab (e.g. BEL, backspace, EOT).
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

  const out = [];
  let prevKept = null;
  let pendingUser = false;
  for (let line of cleaned.split('\n')) {
    line = line.replace(/\s+$/g, '');
    const trimmed = line.trim();
    if (!trimmed) { prevKept = null; continue; }
    if (_isChromeLine(line)) { prevKept = null; continue; }

    // A lone `>` (or `❯`) is the empty input box — the NEXT substantive line is
    // the user's typed/echoed prompt. Don't emit the marker itself.
    if (/^[>❯]\s*$/.test(trimmed)) { pendingUser = true; prevKept = null; continue; }

    // Collapse consecutive identical lines (alt-screen / redraw duplication).
    if (trimmed === prevKept) continue;
    prevKept = trimmed;

    // `> text` on one line: the text after the prompt glyph is user input.
    const promptInline = trimmed.match(/^[>❯]\s+(.+)$/);
    if (promptInline) {
      out.push({ role: 'user', content: promptInline[1].slice(0, 400) });
      pendingUser = false;
      continue;
    }
    const role = pendingUser ? 'user' : 'assistant';
    pendingUser = false;
    out.push({ role, content: trimmed.slice(0, 400) });
  }
  return out;
}

// Structured fast-path: my own resolveTranscriptPath writes a Gemini-shaped
// `{messages:[{type,content}]}` envelope; also accept a bare `[{role,content}]`
// array. Lets parseTranscript round-trip its own output, so a hook that calls
// THIS function on the tempfile (rather than parseAutoDetect) still works.
function _parseStructured(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return []; }
  const rows = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.messages) ? obj.messages : null);
  if (!rows) return [];
  const out = [];
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    // Accept both shapes: {role} (array form) and {type} (gemini-envelope form,
    // where type 'gemini' maps to assistant for cross-adapter parity).
    let role = m.role;
    if (!role && m.type) role = (m.type === 'user') ? 'user' : 'assistant';
    if (role !== 'user' && role !== 'assistant') continue;
    const content = m.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ');
    }
    if (text) out.push({ role, content: text.slice(0, 400) });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// parseTranscript — dual-mode. Structured envelope (this adapter's own
// tempfile, or a {role,content} array) is parsed directly; otherwise the input
// is raw PTY/TUI capture and gets the ANSI-strip + de-chrome + segment path.
// Returns [] on empty/garbage (parity-test fail-soft contract).
// ──────────────────────────────────────────────────────────────────────────

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const trimmed = raw.trimStart();
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    const structured = _parseStructured(raw);
    if (structured.length > 0) return structured;
  }
  return _cleanAndSegment(raw);
}

// ──────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — Sprint 70 T1. There is no on-disk transcript to
// resolve; instead we materialize the in-flight PTY capture buffer
// (`session._stdoutCapture`, populated by spawnTerminalSession's tee) into a
// tempfile the bundled hook can read. Mirrors grok.js's tempfile-envelope
// approach. Returns null when the panel produced no output (buffer empty /
// absent / parses to zero messages) so onPanelClose + the periodic-capture
// timer no-op cleanly.
//
// Side effect (matching grok.js): writes a tempfile. Called by BOTH onPanelClose
// (once, at exit) and onPanelPeriodicCapture (every interval) — each call
// re-materializes the current buffer, so the periodic timer's size-delta
// throttle sees the transcript grow correctly.
// ──────────────────────────────────────────────────────────────────────────

async function resolveTranscriptPath(session) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (!session || !session.meta) return null;
  const cap = session._stdoutCapture;
  if (!cap || !Array.isArray(cap.chunks) || cap.chunks.length === 0) return null;

  const raw = cap.chunks.join('');
  if (!raw) return null;

  const messages = parseTranscript(raw);
  if (messages.length === 0) return null;

  // Gemini-shaped envelope: the bundled hook's parseAutoDetect/parseGeminiJson
  // consume `{messages:[{type,content}]}` as-is (type 'user'|'assistant'), so no
  // dedicated antigravity parser is required in the hook.
  const envelope = {
    messages: messages.map((m) => ({ type: m.role, content: m.content })),
  };

  const safeId = String(session.id || `unknown-${session.pid || ''}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpfile = path.join(os.tmpdir(), `termdeck-agy-${safeId}.json`);
  try {
    fs.writeFileSync(tmpfile, JSON.stringify(envelope), 'utf8');
  } catch (_) {
    return null;  // fail-soft — a tmpfile write failure must not block teardown
  }
  return tmpfile;
}

// ──────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — Antigravity reads `AGENTS.md` (its project-prompt
// convention, shared with Codex/Grok via scripts/sync-agent-instructions.js).
// Same memory_recall + read-instructional-file + read-sprint-docs scaffold as
// the other adapters. Contract-complete placeholder; Sprint-46-style per-agent
// refinement is a follow-up.
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

// ──────────────────────────────────────────────────────────────────────────
// mcpConfig — null (Mnestra MCP auto-wire intentionally OFF for agy).
// VERIFIED 2026-06-08 (live 4-CLI 360): Antigravity's MCP is NOT file-config-
// driven — agy's MCP servers are managed by its embedded "exa" language-server
// (RPCs `RefreshMcpServers` / `GetMcpServerStates`; type
// `gemini.GeminiMCPServerConfig`), not a readable `mcp_config.json`. Ruled out
// empirically against a LIVE agy panel: a de-secreted mnestra block written to
// BOTH `~/.gemini/config/mcp_config.json` AND the appDataDir
// `~/.gemini/antigravity-cli/mcp_config.json` left agy reporting
// `NO-MNESTRA-TOOL`; `~/.gemini/settings.json` already carries mnestra (gemini
// reads it) yet agy ignores it; `agy --help` exposes no `mcp` subcommand and
// `agy plugin list` is empty. A file-based mcpConfig here only targets a dead
// path, so it is `null` → the shared mcp-autowire helper cleanly skips (exactly
// the Claude case). Wiring Mnestra into agy is a deferred follow-up via the
// Antigravity language-server registration mechanism (likely IDE- /
// `RefreshMcpServers`-driven). This was always a non-load-bearing nicety: agy's
// PTY panel + the memory CAPTURE path (source_agent=antigravity, Sprint 70) both
// work; only the agy-side memory READ is deferred.
// ──────────────────────────────────────────────────────────────────────────

const antigravityAdapter = {
  name: 'antigravity',
  sessionType: 'antigravity',
  // Explicit canonical source_agent (belt-and-suspenders vs `name`; consumed by
  // the Sprint-70-T3 `adapter.sourceAgent || adapter.name` server change).
  sourceAgent: 'antigravity',
  displayName: 'Antigravity',
  // Match the `agy` binary. `agy` shares no substring with claude/codex/gemini/
  // grok, so this is mutually exclusive across the registry (parity test 108).
  matches: (cmd) => typeof cmd === 'string' && /(?:^|\s|\/)agy(?:\b|$)/i.test(cmd),
  spawn: {
    binary: 'agy',
    defaultArgs: [],
    // OAuth-personal auth (agy stays on OAuth while gemini moved to API-key —
    // the auth-segregation the Sprint 70 migration is built around). No env
    // overlay needed; the PTY inherits the user's environment.
    env: {},
    // Direct spawn (no `zsh -c` wrapper) — same carve-out the other four
    // adapters use. Required by adapter-spawn-shell-wrap.test.js:175.
    shellWrap: false,
  },
  // Sprint 70 T1 — opt-in in-flight stdout capture. Absent on every other
  // adapter, so this is the ONLY adapter spawnTerminalSession tees. `mode`
  // selects the capture strategy; `maxBytes` tail-caps the in-memory buffer
  // (TUI redraws inflate raw bytes far past the de-chromed content, so cap
  // generously and keep the tail — the most recent conversation); `unbuffer`
  // opts into the best-effort `stdbuf` buffering-defense (residual; see header).
  capture: {
    mode: 'stdout',
    maxBytes: 4 * 1024 * 1024,
    unbuffer: true,
  },
  patterns: {
    prompt: PROMPT,
    thinking: THINKING,
    // editing / tool / error intentionally omitted — the TUI screen-scrape is
    // too noisy for reliable line-anchored edit/tool/error detection without a
    // calibrated real-turn capture. session.js falls back to the generic
    // PATTERNS.error, matching gemini's conservative posture.
  },
  patternNames: {},
  statusFor,
  parseTranscript,
  resolveTranscriptPath,
  bootPromptTemplate,
  costBand: 'subscription',
  // Antigravity's input handling hasn't been pasted-against empirically; default
  // true (bracketed-paste fast path), flip to false if a lane-time test shows
  // the TUI input box eats the paste markers.
  acceptsPaste: true,
  // See the mcpConfig note above — Antigravity MCP is language-server-mediated,
  // not file-config; null so mcp-autowire skips (Claude-style) instead of writing
  // a dead-path file. agy memory READ is a deferred follow-up; CAPTURE works.
  mcpConfig: null,
};

module.exports = antigravityAdapter;
