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
// resolveTranscriptPath — Sprint 50 T1.
//
// Gemini CLI persists chats at
//   ~/.gemini/tmp/<basename(cwd)>/chats/session-<ISO-ts>-<short-id>.{json,jsonl}
// (single-JSON-object shape that matches parseGeminiJson for the .json
// flavor, verified 2026-05-02 substrate probe; .jsonl flavor introduced
// some time between 2026-05-02 and 2026-05-08, surfaced by Sprint 63 T2
// acceptance — see docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md
// Finding #2. The extension filter accepts both shapes; downstream parser
// handling of JSONL deltas is a Sprint 64 candidate). Pick the most
// recently modified file whose mtime is at-or-after
// `session.meta.createdAt`. Falls back to walking every project directory
// under `~/.gemini/tmp/*/chats/` if the basename heuristic produces no
// candidate (e.g., Gemini renormalized the project name to deduplicate
// against an existing one).
// ──────────────────────────────────────────────────────────────────────────

async function resolveTranscriptPath(session) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (!session || !session.meta || !session.meta.cwd) return null;
  const createdAtMs = session.meta.createdAt
    ? Date.parse(session.meta.createdAt)
    : 0;
  const tmpRoot = path.join(os.homedir(), '.gemini', 'tmp');
  const cwdBase = path.basename(session.meta.cwd);
  const primary = path.join(tmpRoot, cwdBase, 'chats');
  const extras = [];
  try {
    for (const proj of fs.readdirSync(tmpRoot)) {
      const candidate = path.join(tmpRoot, proj, 'chats');
      if (candidate !== primary) extras.push(candidate);
    }
  } catch (_) { /* tmp root absent */ }
  let bestPath = null;
  let bestMtime = -Infinity;
  const scan = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of entries) {
      if (!name.startsWith('session-')) continue;
      if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (createdAtMs && st.mtimeMs < createdAtMs) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = full;
      }
    }
  };
  scan(primary);
  if (!bestPath) for (const dir of extras) scan(dir);
  return bestPath;
}

// ──────────────────────────────────────────────────────────────────────────
// parseTranscript — Gemini CLI session transcript → normalized Memory[].
//
// TWO on-disk shapes, both handled (verified 2026-06-07 against real files in
// `~/.gemini/tmp/<proj>/chats/`):
//
//   (A) LEGACY single-JSON object (`.json`, Gemini CLI ≤ ~2026-05-02) —
//       pretty-printed across many lines:
//         { sessionId, projectHash, startTime, lastUpdated, kind,
//           messages: [ { id, timestamp, type:'user'|'gemini', content }, ... ] }
//
//   (B) MODERN JSONL (`.jsonl`, Gemini CLI ≥ ~2026-05-08 — what ships today) —
//       one JSON object per line, heterogeneous:
//         line 0           → session header { sessionId, projectHash, ... }   (no messages/type → skipped)
//         { "$set": {...} } → incremental mutation deltas                      (no type        → skipped)
//         { id, timestamp, type:'user'|'gemini'|'info', content } → a message  (extracted)
//
// In BOTH shapes a `type:'user'` message carries a content ARRAY of `{text}`
// parts and a `type:'gemini'` message carries a STRING. We normalize both to
// the Claude adapter's output shape — `{ role:'user'|'assistant', content }`
// truncated to 400 chars — so the memory-hook summary builder never branches
// on adapter type. `type:'gemini'` → `role:'assistant'`; any other type
// (info / system / tool) is skipped.
//
// Pre-Sprint-70 this did a single `JSON.parse(raw)` and `return []` on throw,
// so EVERY modern `.jsonl` session threw `Extra data: line 2` and captured
// NOTHING (silent data loss). Strategy now: try a whole-blob parse first — it
// succeeds only for shape (A) and any genuinely single-line input, keeping the
// Sprint-45 fixtures green — then fall back to line-by-line JSONL for shape
// (B), tolerating blank lines, a trailing newline, and a partial last line,
// and skipping any line that isn't a well-formed transcript turn.
//
// CROSS-FILE CONTRACT: the parser the LIVE capture path actually invokes is
// the hook-side mirror `parseGeminiJson` in `~/.claude/hooks/memory-session-
// end.js` (+ its bundled copy `packages/stack-installer/assets/hooks/memory-
// session-end.js`); the bundled comment there mandates "keep the two in sync."
// Those copies need the same whole-blob→JSONL fix to close the capture gap
// end-to-end — that file is Sprint-70 T3-owned (see STATUS.md T2 cross-lane
// FINDING). This adapter copy is the canonical reference they mirror.
// ──────────────────────────────────────────────────────────────────────────

// Normalize one parsed Gemini message object into the cross-adapter
// `{ role, content }` shape and push it onto `out`. Non-message objects
// (the session header, `$set` deltas, info/system/tool roles, empty content)
// contribute nothing.
function pushGeminiMessage(msg, out) {
  if (!msg || typeof msg !== 'object') return;
  let role;
  if (msg.type === 'user') role = 'user';
  else if (msg.type === 'gemini' || msg.type === 'assistant') role = 'assistant';
  else return; // header line, $set delta, info/system/tool — not a transcript turn

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
  if (text) out.push({ role, content: text.slice(0, 400) });
}

// Collect messages from one parsed JSON node, whether it's a session wrapper
// (shape A — carries a `messages` array) or a single bare message (shape B —
// one JSONL line). A node that is neither contributes nothing.
function collectGeminiNode(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.messages)) {
    for (const msg of node.messages) pushGeminiMessage(msg, out);
  } else {
    pushGeminiMessage(node, out);
  }
}

function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out = [];

  // Shape (A): a single (possibly pretty-printed, multi-line) JSON object.
  // Succeeds only when the WHOLE blob is valid JSON — the legacy `.json`
  // format or a 1-line `.jsonl`. A multi-line `.jsonl` throws here
  // ("Extra data: line 2") and falls through to the JSONL path below.
  try {
    collectGeminiNode(JSON.parse(raw), out);
    if (out.length) return out;
  } catch (_) { /* not a single JSON blob → try JSONL */ }

  // Shape (B): JSONL — one object per line. Tolerate blank lines, a trailing
  // newline, and a partial/truncated final line (skip unparseable lines rather
  // than aborting the whole transcript). Only reached when the whole-blob parse
  // threw OR yielded zero messages (e.g. a header-only single object), so `out`
  // is still empty here and there is no double-collection.
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let node;
    try { node = JSON.parse(trimmed); } catch (_) { continue; }
    collectGeminiNode(node, out);
  }
  return out;
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

// ──────────────────────────────────────────────────────────────────────────
// Auth — API-key mode + doctor probe (Sprint 70 T2)
//
// WHY THIS EXISTS: Google ends the Gemini CLI's OAuth / subscription serving
// path on JUNE 18 2026. After that date the `gemini` binary authenticates
// ONLY via a billing-enabled API key, which requires BOTH:
//   • `GEMINI_API_KEY` in the environment — TermDeck loads it from
//     ~/.termdeck/secrets.env at server boot and merges it into the panel PTY
//     env (see spawn.env note above); and
//   • ~/.gemini/settings.json → `security.auth.selectedType: "gemini-api-key"`
//     (the *mode* switch — a present key is ignored while the mode is still
//     `oauth-personal`).
// Antigravity (`agy`) deliberately stays on OAuth, so the two coexist:
// agy = OAuth, gemini = API-key. A future operator must NOT have to reverse-
// engineer why Gemini panels went dark after 2026-06-18 — `checkAuth()` makes
// every failure mode loud and actionable.
//
// `checkAuth(opts)` returns a structured verdict; it never throws and never
// blocks by default:
//   { ok, state, keyPresent, keySource, selectedType, detail, hint, live }
//   state ∈
//     'valid'            key present + selectedType === 'gemini-api-key'
//                        (+ live AUTHOK appended when opts.live confirmed it)
//     'missing-key'      GEMINI_API_KEY absent from env AND secrets.env → the
//                        binary cannot authenticate at all post-2026-06-18
//     'wrong-mode'       key present but selectedType !== 'gemini-api-key'
//                        (e.g. still 'oauth-personal' — works NOW, BREAKS 06-18)
//     'settings-missing' ~/.gemini/settings.json absent/unparseable → mode unknown
//     'unverified'       static config is correct but the live probe couldn't
//                        confirm (offline / binary absent / timeout) — soft-OK
//
// The static checks (env + settings.json) are pure and always run. The LIVE
// probe — actually invoking `gemini` non-interactively to confirm the key is
// accepted, the "AUTHOK" model the prior session validated — is gated behind
// `opts.live` and routed through the monkey-patchable `_liveAuthProbe` seam so
// unit tests stay offline and a future `termdeck doctor` wiring never hangs on
// it. The seams (`_geminiApiKeyState` / `_readGeminiSettings` /
// `_liveAuthProbe`) are attached to the adapter object below for the same
// stub-ability the stack doctor uses (cli/src/doctor.js `_fetchLatest`).
// ──────────────────────────────────────────────────────────────────────────

// GEMINI_API_KEY presence — env first, then the canonical ~/.termdeck/
// secrets.env store (the server merges that file into the PTY env at boot, but
// a standalone probe may run before that merge). PRESENCE ONLY — the key value
// is never read into a variable, returned, or logged.
function _geminiApiKeyState({ env, secretsPath } = {}) {
  const e = env || process.env;
  if (e && typeof e.GEMINI_API_KEY === 'string' && e.GEMINI_API_KEY.trim()) {
    return { present: true, source: 'env' };
  }
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const p = secretsPath || path.join(os.homedir(), '.termdeck', 'secrets.env');
  try {
    const txt = fs.readFileSync(p, 'utf8');
    // Match a non-empty assignment without ever capturing the value.
    if (/^\s*(?:export\s+)?GEMINI_API_KEY=\s*\S/m.test(txt)) {
      return { present: true, source: 'secrets.env' };
    }
  } catch (_) { /* no secrets.env / unreadable */ }
  return { present: false, source: null };
}

// Read ~/.gemini/settings.json and return { selectedType } (or null when the
// file is absent or unparseable — the caller maps null to 'settings-missing').
function _readGeminiSettings({ settingsPath } = {}) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const p = settingsPath || path.join(os.homedir(), '.gemini', 'settings.json');
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
  try {
    const j = JSON.parse(txt);
    const sel = j && j.security && j.security.auth && j.security.auth.selectedType;
    return { selectedType: typeof sel === 'string' ? sel : null };
  } catch (_) { return null; }
}

// Live auth probe — invoke `gemini` non-interactively and resolve
//   { ran:true, ok:boolean, note:string }
// Success = exit 0 with non-empty stdout (the binary only emits a response once
// the key is accepted); the AUTHOK token, when echoed, is surfaced in `note`.
// Any spawn error / timeout / non-zero exit resolves ok:false — the caller
// keeps the static verdict and downgrades 'valid' → 'unverified' (never RED) to
// avoid false negatives on offline / rate-limited runs. Replaceable for tests.
function _liveAuthProbe({ timeoutMs = 8000 } = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gemini', ['-p', 'Reply with exactly: AUTHOK'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ran: true, ok: false, note: `spawn failed: ${e && e.message || e}` });
    }
    let out = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', () => { /* auth errors land here; intentionally not logged */ });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ran: true, ok: false, note: `error: ${e && e.message || e}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (timedOut) return resolve({ ran: true, ok: false, note: `timed out after ${timeoutMs}ms` });
      const responded = code === 0 && out.trim().length > 0;
      const sawToken = /AUTHOK/i.test(out);
      resolve({
        ran: true,
        ok: responded,
        note: responded
          ? (sawToken ? 'AUTHOK' : 'gemini responded (exit 0)')
          : `gemini exited ${code} without a response`,
      });
    });
  });
}

// See the WHY / contract block above. Async because the optional live probe
// awaits a spawn; the static-only path (default) resolves immediately. Seams
// are dereferenced via `geminiAdapter.*` so tests can monkey-patch them.
async function checkAuth(opts = {}) {
  const options = opts || {};
  const keyState = geminiAdapter._geminiApiKeyState(options);
  const settings = geminiAdapter._readGeminiSettings(options);
  const selectedType = settings ? settings.selectedType : null;

  let state;
  let ok;
  let detail;
  let hint;
  if (!keyState.present) {
    state = 'missing-key';
    ok = false;
    detail = 'GEMINI_API_KEY is not set (checked process env + ~/.termdeck/secrets.env).';
    hint = 'Add GEMINI_API_KEY=<billing-enabled key> to ~/.termdeck/secrets.env (mode 600). '
      + 'After 2026-06-18 the Gemini CLI authenticates ONLY via an API key.';
  } else if (settings === null) {
    state = 'settings-missing';
    ok = false;
    detail = 'GEMINI_API_KEY is present, but ~/.gemini/settings.json is missing or '
      + 'unparseable — cannot confirm the auth mode.';
    hint = 'Create ~/.gemini/settings.json with '
      + '{"security":{"auth":{"selectedType":"gemini-api-key"}}}.';
  } else if (selectedType !== 'gemini-api-key') {
    state = 'wrong-mode';
    ok = false;
    detail = `GEMINI_API_KEY is present, but settings.json security.auth.selectedType is `
      + `${selectedType ? `"${selectedType}"` : 'unset'} — not "gemini-api-key", so the key `
      + `is ignored. This still works until 2026-06-18, then breaks.`;
    hint = 'Set ~/.gemini/settings.json security.auth.selectedType to "gemini-api-key" '
      + '(Antigravity `agy` keeps OAuth separately).';
  } else {
    state = 'valid';
    ok = true;
    detail = `GEMINI_API_KEY present (${keyState.source}) and settings.json `
      + `selectedType="gemini-api-key".`;
    hint = '';
  }

  // Optional live confirmation — only when static config is already valid AND
  // the caller asked for it. A live miss is a soft downgrade, never a RED.
  let live = { ran: false, ok: false, note: 'not run (static check only)' };
  if (state === 'valid' && options.live) {
    live = await geminiAdapter._liveAuthProbe(options);
    if (live.ok) {
      detail += ` Live probe confirmed (${live.note}).`;
    } else {
      state = 'unverified';
      ok = true; // config is correct; the probe just couldn't confirm
      detail += ` Live probe could not confirm (${live.note}); static config looks correct.`;
      hint = 'If Gemini panels fail, check the key is billing-enabled and not rate-limited, '
        + 'and that `gemini` is on PATH.';
    }
  }

  return {
    ok,
    state,
    keyPresent: keyState.present,
    keySource: keyState.source,
    selectedType,
    detail,
    hint,
    live,
  };
}

const geminiAdapter = {
  name: 'gemini',
  sessionType: 'gemini',
  // Sprint 50 T3 — see claude.js for rationale.
  displayName: 'Gemini CLI',
  matches: (cmd) => typeof cmd === 'string' && /gemini/i.test(cmd),
  spawn: {
    binary: 'gemini',
    defaultArgs: [],
    // AUTH (Sprint 70 T2): the Gemini CLI now requires API-KEY auth — Google
    // ends the OAuth / subscription serving path on 2026-06-18. `GEMINI_API_KEY`
    // is read via `process.env` at spawn time by index.js' PTY env merge
    // (loaded from ~/.termdeck/secrets.env at server boot) — declared here for
    // documentation / discoverability, not for in-adapter overriding — AND
    // ~/.gemini/settings.json must set `security.auth.selectedType:
    // 'gemini-api-key'` (the mode switch; a present key is ignored while the
    // mode is still 'oauth-personal'). Antigravity (`agy`) stays on OAuth — the
    // two are deliberately segregated. `checkAuth()` below makes a misconfig
    // loud. (Pre-2026-06-18 the typical path was 'oauth-personal'; it stops
    // working after the cutoff.)
    env: {},
    // Sprint 64 T2 (carve-out 2.4) — direct spawn (no `zsh -c` wrapper) when
    // the launching command is exactly the binary name. See claude.js for the
    // full rationale + fallback semantics.
    shellWrap: false,
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
  // Sprint 50 T1 — 10th adapter field. Walks ~/.gemini/tmp/<proj>/chats.
  resolveTranscriptPath,
  bootPromptTemplate,
  // Sprint 70 T2 — API-key auth doctor probe. See the Auth section above for
  // states + the live-probe seam. async (raw, opts) -> verdict object.
  checkAuth,
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

// Sprint 70 T2 — monkey-patchable test seams for `checkAuth` (same pattern as
// cli/src/doctor.js `_fetchLatest`). Attached to the adapter object so unit
// tests can stub the live spawn / filesystem reads and stay hermetic.
geminiAdapter._geminiApiKeyState = _geminiApiKeyState;
geminiAdapter._readGeminiSettings = _readGeminiSettings;
geminiAdapter._liveAuthProbe = _liveAuthProbe;

module.exports = geminiAdapter;
