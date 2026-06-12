// web-chat-grok adapter — Sprint 72 T2 (Workstream B)
//
// Sixth adapter in the AGENT_ADAPTERS registry (see ./index.js). Unlike every
// other adapter it is NOT backed by a node-pty child process — a `web-chat`
// panel is driven by T1's CDP render-bridge against a real, logged-in headful
// grok.com tab (`packages/web-chat-driver`). The adapter is the seam the
// TermDeck server (index.js) consumes; the driver is the seam the adapter
// consumes. See docs/sprint-72-grok-panel/PLANNING.md § "The 8 TermDeck seams".
//
// ── Why a distinct adapter from grok.js (the CLI) ────────────────────────────
// grok.js drives the `grok-dev` CLI (PTY, ~/.grok/grok.db, GROK_MODEL env). This
// adapter drives grok.com in a browser — the FLAT-RATE (subscription) path to
// Grok's reasoning model, which the CLI rejects (`reasoningEffort` → HTTP 400;
// see grok-models.js). Same provider, different runtime + different cost
// realization, so it is a separate `sessionType:'web-chat'`. Provenance is
// tagged `sourceAgent:'grok-web'` (Sprint 73 T1 — see the "source_agent
// attribution" section), distinguishing web rows from Grok-CLI rows in Mnestra.
//
// ── The one hard constraint: NO node-pty, NO on-disk transcript ──────────────
// There is no PTY stream and no conversation file on disk. The server seam
// accumulates each turn (injected prompt + Grok's completed response) into an
// in-memory buffer `session._webChatTranscript.turns` (`[{role,content}]`).
// `resolveTranscriptPath` materializes that buffer into a Gemini-shaped JSON
// envelope tempfile — EXACTLY the agy.js (Sprint 70 T1) pattern — so the
// bundled hook's `parseAutoDetect`/`parseGeminiJson` ingest it with NO
// dedicated `TRANSCRIPT_PARSERS['web-chat']` entry. onPanelClose's close→hook
// path is reused with no second write path. (Mirrors agy's "live source →
// tempfile envelope → existing hook" decoupling from the hook layer.)
//
// ── statusFor is a contract backstop, not the primary status signal ──────────
// PTY adapters derive status by pattern-matching escape-laden output. A
// web-chat panel has no escapes; its status is EVENT-driven by the server seam
// (a prompt was injected ⇒ 'thinking'; T3's completion detector fired ⇒
// 'idle'). `statusFor(text)` is implemented for contract uniformity + as a
// text-shape backstop (and is what index.js routes a completed response
// through), but the load-bearing transitions are wired in index.js off the
// driver's inject/onComplete events. We deliberately do NOT carry a
// `patterns.error` (a Grok answer that DISCUSSES an error is not a panel
// error) — index.js does not route web-chat text through `_detectErrors`.
//
// ── source_agent attribution ─────────────────────────────────────────────────
// `sourceAgent:'grok-web'` (Sprint 73 T1 — flips the Sprint 72 ORCH zero-touch
// decision that shipped 'grok' to keep that sprint off the release-sensitive
// hook surface). Web and CLI Grok rows are now distinguishable in Mnestra:
// onPanelClose/periodic emit `adapter.sourceAgent || adapter.name`, the bundled
// hook allow-lists 'grok-web' (stamp v4, plus a `web-chat-grok` registry-name
// alias as the agy→antigravity-style safety net), and mnestra's source_agents
// enum + recall filter gain 'grok-web' via migration 024 (Sprint 74 T1 —
// ATOMIC release partner; neither side ships without the other, else rows are
// unfilterable or, on a stale installed hook, coerced to 'claude').
//
// Byte-floor (shipped with the flip, hook v4): the bundled hook skips
// transcripts < 5 KB unless the sessionType is exempted. Our materialized
// envelope is compact — synthesized turn content, no JSONL metadata bloat;
// 48/49 live Sprint-72 envelopes were <5 KB — so 'web-chat' is exempted
// alongside 'antigravity', gated on parsed content (≥1 assistant turn)
// instead of raw bytes.
//
// Contract — see ./claude.js header for the full annotated adapter shape.

'use strict';

// ──────────────────────────────────────────────────────────────────────────
// Patterns. A web-chat panel produces no PTY output, so there is intentionally
// NO `prompt` pattern (would let detectAdapter steal a real PTY panel's output)
// and NO `error` pattern (chat prose mentioning "Error:" is not a panel error;
// index.js never runs `_detectErrors` on web-chat text). `thinking` is the one
// useful text shape: if a completed response somehow still carries Grok's
// shimmer label, treat it as still-working. Reused conceptually from grok.js.
// ──────────────────────────────────────────────────────────────────────────

const THINKING = /Planning next moves|Generating plan[….]|Answering[….]|\bThinking\b/;

// ──────────────────────────────────────────────────────────────────────────
// statusFor — text → { status, statusDetail } | null. By the time index.js
// routes a string here it is a COMPLETED Grok response (the onComplete event
// already fired), so the dominant outcome is 'idle' (Grok is done, awaiting the
// next prompt). The thinking branch is a defensive backstop for the unlikely
// case a streaming/partial chunk is routed through. null on empty/non-string
// preserves the contract's "leave status untouched" semantics.
// ──────────────────────────────────────────────────────────────────────────

function statusFor(data) {
  if (typeof data !== 'string' || data.length === 0) return null;
  if (THINKING.test(data)) {
    return { status: 'thinking', statusDetail: 'Grok is responding…' };
  }
  return { status: 'idle', statusDetail: 'Ready' };
}

// ──────────────────────────────────────────────────────────────────────────
// parseTranscript — web-chat capture is ALWAYS structured (the server seam
// builds `[{role,content}]` turns; there is no raw-ANSI path like agy's TUI
// scrape). Dual-mode for round-trip safety: accept this adapter's own
// Gemini-shaped envelope `{messages:[{type,content}]}` AND a bare
// `[{role,content}]` array. Returns [] on empty/garbage (fail-soft parity).
// Content truncated to 400 chars to match the other adapters' parsers and the
// hook's summary builder.
// ──────────────────────────────────────────────────────────────────────────

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let obj;
  try { obj = JSON.parse(raw); }
  catch (_) { return []; }
  const rows = Array.isArray(obj)
    ? obj
    : (obj && Array.isArray(obj.messages) ? obj.messages : null);
  if (!rows) return [];
  const out = [];
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    // Accept both shapes: {role} (array form) and {type} (envelope form). Only
    // 'user'/'assistant' pass in EITHER field; any other value is dropped — same
    // as the bundled hook's parseGeminiJson treats the envelope (we only ever
    // materialize 'user'/'assistant', so this is strictness, not behavior loss).
    let role = null;
    if (m.role === 'user' || m.role === 'assistant') role = m.role;
    else if (m.type === 'user' || m.type === 'assistant') role = m.type;
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
// resolveTranscriptPath — Sprint 72 T2. No on-disk transcript exists; the
// server seam accumulates turns into `session._webChatTranscript.turns`. We
// materialize that into a Gemini-shaped `{messages:[{type,content}]}` tempfile
// the bundled hook's parseAutoDetect ingests. Returns null when the panel
// produced no turn so onPanelClose + the periodic-capture timer no-op cleanly.
//
// Called by BOTH onPanelClose (once, at close) and onPanelPeriodicCapture
// (every interval) — each call re-materializes the current buffer so the
// periodic timer's size-delta throttle sees the transcript grow. Mirrors agy's
// resolveTranscriptPath exactly (same envelope shape, same tmpfile discipline).
// ──────────────────────────────────────────────────────────────────────────

// Per-turn content cap. The hook truncates to 400 for the summary, but storing
// a bit more keeps the envelope useful for any future richer consumer while
// bounding tempfile size on a long auditor session.
const MAX_TURN_CHARS = 4000;

async function resolveTranscriptPath(session) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (!session || !session.meta) return null;
  const buf = session._webChatTranscript;
  if (!buf || !Array.isArray(buf.turns) || buf.turns.length === 0) return null;

  const messages = [];
  for (const t of buf.turns) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
    const content = typeof t.content === 'string' ? t.content : '';
    if (!content) continue;
    messages.push({ type: t.role, content: content.slice(0, MAX_TURN_CHARS) });
  }
  if (messages.length === 0) return null;

  const envelope = { messages };
  const safeId = String(session.id || `unknown-${session.pid || ''}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpfile = path.join(os.tmpdir(), `termdeck-webchat-${safeId}.json`);
  try {
    fs.writeFileSync(tmpfile, JSON.stringify(envelope), 'utf8');
  } catch (_) {
    return null; // fail-soft — a tmpfile write failure must not block teardown
  }
  return tmpfile;
}

// ──────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — a web-chat Grok panel used as a 4+1 lane gets its boot
// prompt INJECTED into the composer (via the server's two-stage inject seam),
// not typed into a CLI. Same memory_recall + read-instructional-file + read-
// sprint-docs scaffold as the Grok CLI adapter; points at AGENTS.md (Grok's
// project-prompt convention). Contract-complete placeholder.
// ──────────────────────────────────────────────────────────────────────────

function bootPromptTemplate(lane = {}, sprint = {}) {
  const tn = lane.id || 'T?';
  const sprintNum = sprint.number || '?';
  const sprintName = sprint.name || 'unnamed';
  const project = (lane.project || sprint.project || 'termdeck');
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

const webChatGrokAdapter = {
  name: 'web-chat-grok',
  sessionType: 'web-chat',
  // Sprint 73 T1 — distinct web provenance (was 'grok', the Sprint 72 ORCH
  // zero-touch decision). Pairs ATOMICALLY with hook v4 (ALLOWED_SOURCE_AGENTS
  // + byte-floor exemption) and mnestra migration 024 (Sprint 74 T1). See the
  // "source_agent attribution" header for the full rationale.
  sourceAgent: 'grok-web',
  // Sprint 50 T3 — human-readable label for launcher buttons + panel headers.
  displayName: 'Grok (Web)',
  // Provider URL the CDP driver navigates the dedicated-profile tab to on
  // attach (T1's `cdp.attach({startUrl})` defaults to about:blank). Provider-
  // owned so a future web-chat-<provider> adapter sets its own. The server seam
  // reads this and passes it through as `startUrl`.
  webChatUrl: 'https://grok.com',
  // CRITICAL: never claim a command-spawned session. web-chat panels are created
  // ONLY via an explicit `type:'web-chat'` on POST /api/sessions — never by
  // output sniffing or command-string match. Returning false here (and carrying
  // no `patterns.prompt` below) guarantees this adapter can never hijack a real
  // PTY panel's detection in detectAdapter()/the direct-spawn loop.
  matches: () => false,
  // No `spawn` block — there is no binary. The direct-spawn loop in index.js is
  // gated on `matches()` (always false here) so it is never reached.
  patterns: {
    // Intentionally NO `prompt` (see matches) and NO `error` (chat prose is not
    // a panel error). Only the thinking shimmer, used by statusFor.
    thinking: THINKING,
  },
  patternNames: {},
  statusFor,
  parseTranscript,
  // 10th adapter field — materializes the in-flight turn buffer into a tempfile
  // envelope (see header). Its PRESENCE is what makes onPanelClose +
  // onPanelPeriodicCapture fire for web-chat panels.
  resolveTranscriptPath,
  bootPromptTemplate,
  // The whole point of the web path: flat-rate subscription, not per-token.
  costBand: 'subscription',
  // N/A for a browser composer — the server seam assembles the 4+1 two-stage
  // paste/submit into a single `grok.inject(handle, fullText)` call, so there is
  // no PTY bracketed-paste handler to be capable-or-not. Declared for contract
  // completeness.
  acceptsPaste: true,
  // No MCP config to auto-wire — grok.com is a browser session, not a CLI with
  // an MCP-server registry file. null = user-managed/none (same as Claude).
  mcpConfig: null,
};

module.exports = webChatGrokAdapter;
