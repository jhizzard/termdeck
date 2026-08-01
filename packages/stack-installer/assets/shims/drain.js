#!/usr/bin/env node
'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// TermDeck standalone-shell capture — exit drain  —  Sprint 68-REDUX T1
//
// Invoked (detached, fail-soft) by shim-template.sh after the real CLI exits.
// Turns a raw `script(1)` PTY transcript into something the EXISTING bundled
// memory-session-end hook can actually ingest, then feeds it in.
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────────
// PLANNING D2′ assumed the bundled hook could read a raw `script` transcript
// directly ("ANSI/PTY noise is the parsers' problem, already solved"). It
// cannot, and this was verified empirically before a line of shim was written
// (STATUS, [T1] FINDING 2026-08-01 15:36 ET):
//
//   raw `script` transcript → hook parseAutoDetect  →  0 messages
//   raw `script` transcript → hook 'codex' parser   →  0 messages
//   raw `script` transcript → agy.js parseTranscript→  3 messages ✅
//
// EVERY parser in the hook's TRANSCRIPT_PARSERS table is a JSON/JSONL parser;
// parseAutoDetect JSON.parses each line and skips what doesn't parse, so raw
// ANSI yields []. Panels only work because the ADAPTER cleans first: agy.js's
// resolveTranscriptPath strips ANSI, collapses CR overdraws, drops TUI chrome,
// segments into turns, and writes a Gemini-shaped `{messages:[{type,content}]}`
// envelope tempfile — the hook parses THAT. grok.js does the same from grok.db.
//
// So the shim needs the same clean → envelope step, and this is it. The hook is
// NOT modified by this sprint.
//
// ── ⚠ CLASS N — LOCKSTEP DRIFT (INSTALLER-PITFALLS) ───────────────────────────
// The clean+segment algorithm below is a VENDORED COPY of
// `packages/server/src/agent-adapters/agy.js` (_stripAnsi / _normalizeOverdraw /
// _isChromeLine / _cleanAndSegment). It is duplicated deliberately: an artifact
// installed at `~/.termdeck/shims/` must not `require()` into the termdeck
// server package — that is a Class E hidden dependency, and it would break for
// any user whose global install layout differs.
//
// THE COST: two copies that must not drift. A parity test feeds one shared
// fixture to BOTH implementations and asserts identical output, so an edit to
// agy.js that isn't mirrored here fails loudly instead of silently degrading
// standalone capture. IF YOU EDIT EITHER COPY, EDIT BOTH.
//
// ── FAIL-SOFT CONTRACT ────────────────────────────────────────────────────────
// This process runs detached, after the user's CLI has already exited with its
// real status. Nothing here can affect that status. Every failure path logs one
// line and exits 0. It must never throw, never hang forever, never write to the
// user's terminal.
// ──────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const AGENT = process.env.TERMDECK_SHIM_AGENT || '';
const TRANSCRIPT = process.env.TERMDECK_SHIM_TRANSCRIPT || '';
const CWD = process.env.TERMDECK_SHIM_CWD || process.cwd();

function log(msg) {
  try {
    process.stdout.write(`[${new Date().toISOString()}] drain(${AGENT || '?'}): ${msg}\n`);
  } catch (_) { /* fail-soft */ }
}

// Binary name → canonical mnestra source_agent. `agy`'s canonical provenance
// tag is `antigravity` (the hook's SOURCE_AGENT_ALIASES folds it too, so this
// is belt-and-suspenders rather than the only defense).
const SOURCE_AGENT_BY_BINARY = {
  codex: 'codex',
  grok: 'grok',
  agy: 'antigravity',
};

// ──────────────────────────────────────────────────────────────────────────────
// VENDORED FROM agy.js — keep byte-compatible. See Class N note above.
// ──────────────────────────────────────────────────────────────────────────────

// Strip ANSI/VT control sequences. Order matters: OSC (terminated by BEL or
// ST) first, then CSI (ESC [ params intermediates final), then any remaining
// nF/Fe/Fs two-byte escapes, then a catch-all.
function _stripAnsi(s) {
  return s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')                 // OSC … BEL|ST
    .replace(/\x1b[\[\]][\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '') // CSI (+ private)
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')                   // nF/Fp/Fe/Fs escapes
    .replace(/\x1b./g, '');                                        // any other ESC pair
}

// Collapse carriage-return overdraws. CR-runs-before-LF → LF first, then per
// line keep only the text after the LAST lone CR (the final overwrite).
// `script` transcripts are CR-terminated and full of spinner redraws, so this
// is load-bearing here.
//
// The `\r+` (not `\r`) is load-bearing — Sprint 68-REDUX remediation item 3,
// found by T3's vendor-parity fence and confirmed by T4 with the `\r\r\r\n`
// neighbour case. A single-`\r` pattern left one CR stranded at end-of-line on
// `text\r\r\n`; the overdraw pass below then read that trailing CR as "the
// final overwrite starts here", took the empty string after it, and the line
// was dropped as blank. Real content vanished — `hello\r\r\nworld\r\r\n`
// parsed to ZERO messages, silently. This matters more here than anywhere: a
// `script(1)` transcript is the ONLY record of a standalone session.
//
// The distinction the pattern encodes: CR immediately followed by LF is just
// line-ending noise (nothing was overwritten — CR does not erase), so collapse
// it. CR followed by TEXT is a genuine redraw, and only there should the
// earlier text be discarded. `\r+\n` matches exactly the first case and leaves
// the second to the overdraw pass.
function _normalizeOverdraw(s) {
  return s
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i >= 0 ? line.slice(i + 1) : line;
    })
    .join('\n');
}

// A line is "chrome" (drop it) when dominated by box-drawing (U+2500–257F) or
// Braille (U+2800–28FF, spinner) glyphs. Markdown `---`/`***` use ASCII, so
// real content is never caught here.
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
// de-duplicate consecutive redraw frames → segment.
function _cleanAndSegment(raw) {
  const cleaned = _normalizeOverdraw(_stripAnsi(raw))
    // Drop remaining C0 controls except newline/tab (BEL, backspace, EOT — the
    // last of which `script` injects on every capture).
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

  const out = [];
  let prevKept = null;
  let pendingUser = false;
  for (let line of cleaned.split('\n')) {
    line = line.replace(/\s+$/g, '');
    const trimmed = line.trim();
    if (!trimmed) { prevKept = null; continue; }
    if (_isChromeLine(line)) { prevKept = null; continue; }

    if (/^[>❯]\s*$/.test(trimmed)) { pendingUser = true; prevKept = null; continue; }
    if (trimmed === prevKept) continue;
    prevKept = trimmed;

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

// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// REDACTION — mandatory on this path, unlike every other capture path.
//
// PLANNING D0.3 claims the bundled hook applies "redact.js (S84 NUL fix)". It
// does not: the hook contains NO redaction of any kind, and `redact.js` lives
// only in `packages/mcp-bridge/`, a different package on a different code path.
// Verified by grep (STATUS, [T1] FINDING 2026-08-01 19:56 ET).
//
// That gap is survivable for PANELS, which ingest structured JSONL transcripts —
// model turns only. It is NOT survivable here. `script(1)` captures the raw
// TERMINAL, so anything that appears on screen during the session — a pasted API
// key, an `export SUPABASE_SERVICE_ROLE_KEY=…`, an auth screen — would be
// embedded and written to a cloud database. This is not hypothetical: the first
// live grok canary captured a real OAuth device code and wrote it to the store.
//
// So the drain redacts before anything leaves the machine. The redactor is the
// repo's canonical one, COPIED IN BY THE INSTALLER (T2) rather than duplicated
// in the repo — `packages/mcp-bridge/src/redact.js` requires only Node builtins,
// so it vendors cleanly and there is exactly one source of truth. If it is
// missing (older install, partial refresh) we fall back to a small built-in
// pattern set rather than silently shipping raw terminal text.
// ──────────────────────────────────────────────────────────────────────────────

const FALLBACK_SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '‹redacted:jwt›'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '‹redacted:openai-key›'],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, '‹redacted:github-token›'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '‹redacted:slack-token›'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '‹redacted:aws-key›'],
  // KEY=value / KEY: value where the key name smells like a credential.
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"',;]{6,160})\3/gi,
    (_m, k, sep) => `${k}${sep}‹redacted:secret›`],
];

function loadRedactor() {
  try {
    const mod = require(path.join(__dirname, 'redact.js'));
    if (mod && typeof mod.redact === 'function') return mod.redact;
  } catch (_) { /* fall through to built-in */ }
  return (text) => {
    let out = String(text);
    for (const [re, rep] of FALLBACK_SECRET_PATTERNS) out = out.replace(re, rep);
    return out;
  };
}

// Resolve the bundled session-end hook. `~/.claude/hooks/` is the RUNTIME copy
// (what the installer vendors and what Claude Code itself fires); the sibling
// path covers an install that vendored hooks under ~/.termdeck/.
function resolveHook() {
  const candidates = [
    process.env.TERMDECK_SESSION_END_HOOK,
    path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js'),
    path.join(__dirname, '..', 'hooks', 'memory-session-end.js'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* next */ }
  }
  return null;
}

function main() {
  if (!AGENT || !TRANSCRIPT) { log('missing TERMDECK_SHIM_AGENT/TRANSCRIPT — skipping'); return; }

  let raw = '';
  try { raw = fs.readFileSync(TRANSCRIPT, 'utf8'); }
  catch (e) { log(`cannot-read-transcript: ${TRANSCRIPT} — ${e.message}`); return; }
  if (!raw) { log('empty-transcript — skipping'); return; }

  // Redact BEFORE anything else touches the content — before the envelope, the
  // embedding, or the DB. Applied per-message rather than to the whole blob so
  // a pathological regex can't blow up the entire capture.
  const redactFn = loadRedactor();
  const messages = _cleanAndSegment(raw).map((m) => {
    let content = m.content;
    try { content = redactFn(content); }
    catch (_) { content = '‹redacted:redaction-failed›'; }  // fail CLOSED, never raw
    return { role: m.role, content };
  });

  // CONTENT GATE. This replaces the hook's 5 KB byte floor, which we disable
  // below. The floor is calibrated for verbose on-disk JSONL (10s of KB); a
  // cleaned envelope for a real but short session measures in the hundreds of
  // bytes and the floor would drop it as a false zero-row. Same reasoning the
  // hook already applies to 'antigravity'/'web-chat' via
  // BYTE_FLOOR_EXEMPT_SESSION_TYPES — gate on parsed CONTENT, not raw size.
  // Mirrors agy.js resolveTranscriptPath's `messages.length === 0 → null`.
  if (messages.length === 0) { log('no-parsed-messages — skipping (nothing substantive captured)'); return; }
  const assistantTurns = messages.filter((m) => m.role === 'assistant').length;
  if (assistantTurns < 1) { log(`no-assistant-turn: ${messages.length} parsed — skipping`); return; }

  // Gemini-shaped envelope — the shape the hook's parseGeminiJson consumes and
  // the same one agy.js writes. VERIFIED round-trip: this envelope through the
  // hook's 'auto' parser yields the messages back with correct roles.
  //
  // `raw_transcript_path` (ORCH RULING 16:25 ET R-A) records the ABSOLUTE path of
  // the verbatim `script(1)` capture. `memory_sessions.transcript_path` stores
  // this envelope, not the raw log — the hook has one field for both "parse
  // this" and "store this", so the raw path has nowhere else to live. Carrying
  // it INSIDE the envelope makes the pairing explicit and machine-readable
  // rather than a filename convention someone has to know to reverse: a reader
  // that has the stored path can open it and learn exactly which capture
  // produced it, even if the suffix convention later changes.
  //
  // Resolved to absolute here rather than trusting the caller — the shim always
  // passes an absolute path today, but a relative one would be meaningless to
  // any later reader, whose cwd is not the session's.
  //
  // Extra top-level keys are inert: verified that `parseGeminiJson`,
  // `parseAutoDetect` and `agy.js::_parseStructured` all return byte-identical
  // message arrays with and without this field (they read only `.messages`).
  const envelope = {
    raw_transcript_path: path.resolve(TRANSCRIPT),
    messages: messages.map((m) => ({ type: m.role, content: m.content })),
  };

  const sessionId = crypto.randomUUID();

  // ── DURABLE ENVELOPE (Sprint 68-REDUX remediation item 4) ───────────────────
  // The envelope used to be written to os.tmpdir() and unlinked as soon as the
  // hook exited. That path is what the hook stores as
  // `memory_sessions.transcript_path`, so EVERY standalone row pointed at a file
  // that this process had already deleted — a dangling pointer by construction,
  // on 100% of rows, for anyone later trying to trace a memory back to its
  // session.
  //
  // Now it is written beside the raw transcript, inside the 14-day rotation
  // window, and never deleted by us. `<raw>.envelope.json` keeps the pairing
  // trivially derivable in both directions: strip the suffix for the raw PTY
  // capture, add it for the parsed form.
  //
  // ⚠ SCOPE NOTE FOR ORCH — this stores the durable ENVELOPE path, not the raw
  // `.log` path as the ruling words it. The hook uses ONE field for two jobs: it
  // both READS `transcript_path` to parse and STORES that same string. Pointing
  // it at the raw `.log` would store the nicer path but hand the parser raw ANSI,
  // which yields zero messages and no row at all — trading a dangling pointer for
  // no data. Storing the raw path *as well* needs a second hook field
  // (`stored_transcript_path`), which is a bundled-hook signature change with a
  // mirror obligation, outside my queue. This closes the defect (the stored path
  // resolves, for 14 days) and the raw capture is one suffix away. Say the word
  // if you want the hook field and I'll take it.
  const envelopePath = `${TRANSCRIPT}.envelope.json`;
  try {
    fs.writeFileSync(envelopePath, JSON.stringify(envelope), 'utf8');
    // Redacted, but still session content — match the raw transcript's posture.
    try { fs.chmodSync(envelopePath, 0o600); } catch (_) { /* best-effort */ }
  } catch (e) {
    log(`cannot-write-envelope: ${e.message}`);
    return;
  }

  // The RAW transcript is the one file in this flow that is NOT redacted — it is
  // the verbatim terminal, secrets and all. It sits in a 0700 directory, but
  // tighten the file itself too: defence in depth costs nothing here.
  try { fs.chmodSync(TRANSCRIPT, 0o600); } catch (_) { /* best-effort */ }

  const hook = resolveHook();
  if (!hook) {
    log('no-session-end-hook-found — skipping (run `termdeck init --mnestra` to vendor it)');
    return;
  }

  const sourceAgent = SOURCE_AGENT_BY_BINARY[AGENT] || AGENT;

  // ⚠ sessionType MUST be 'auto', NOT the CLI's name. Declaring 'codex'/'grok'
  // selects their JSONL parsers, which return 0 messages against this envelope
  // (verified). 'auto' → parseAutoDetect → parseGeminiJson → correct.
  const payload = {
    session_id: sessionId,
    transcript_path: envelopePath,
    cwd: CWD,
    hook_event_name: 'SessionEnd',
    source_agent: sourceAgent,
    sessionType: 'auto',
  };

  let child;
  try {
    child = spawn(process.execPath, [hook], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        // Payload fields already win over env in the hook's resolution order;
        // these mirror them for any path that reads env first.
        TERMDECK_SOURCE_AGENT: sourceAgent,
        TERMDECK_SESSION_TYPE: 'auto',
        // Disable the raw-size floor — superseded by the content gate above.
        // Scoped to this child only; never touches the user's shell.
        TERMDECK_HOOK_MIN_BYTES: '0',
      },
    });
  } catch (e) {
    log(`cannot-spawn-hook: ${e.message}`);
    return;
  }

  // Watchdog: a wedged hook must not leave an immortal detached process behind.
  const watchdog = setTimeout(() => {
    log('hook-timeout after 120s — killing');
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }, 120000);

  child.on('error', (e) => {
    clearTimeout(watchdog);
    log(`hook-spawn-error: ${e.message}`);
  });
  child.on('close', (code) => {
    clearTimeout(watchdog);
    log(`hook exited ${code} — agent=${sourceAgent} messages=${messages.length} raw=${TRANSCRIPT} envelope=${envelopePath}`);
  });

  try { child.stdin.end(JSON.stringify(payload)); }
  catch (e) { log(`cannot-write-stdin: ${e.message}`); }
}

if (require.main === module) {
  // Belt-and-suspenders: the fail-soft contract is absolute. Even an unforeseen
  // throw must not surface as a crash in a detached background process.
  try { main(); } catch (e) { log(`unexpected: ${e && e.message}`); }
} else {
  module.exports = {
    _stripAnsi, _normalizeOverdraw, _isChromeLine, _cleanAndSegment,
    resolveHook, SOURCE_AGENT_BY_BINARY,
  };
}
