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

// End-of-turn terminator (Sprint 60 v1.0.14 fix). After Codex finishes a
// reply the TUI renders a separator with the elapsed time, e.g.
// "─ Worked for 2m 50s ──────────" using box-drawing dashes (U+2500). This
// pattern is unambiguous: it only ever appears when the turn closes and the
// panel parks waiting for next input. Placed FIRST in the statusFor cascade
// because the same chunk may also contain a final "Working" spinner update
// that would otherwise stick `status: 'thinking'` indefinitely. Bit Sprint 59
// twice — orchestrator's `meta.status` reported "Codex is reasoning..." for
// 22+ minutes after Codex actually parked at end-of-turn.
const END_OF_TURN = /─\s*Worked for\s+(?:\d+m\s*)?\d+s\s*─/;

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
  // Sprint 60 v1.0.14: end-of-turn terminator wins over THINKING. Without
  // this branch, a chunk that contains both a final "Working Xs" spinner
  // line AND the closing "Worked for X" separator would stick on 'thinking'.
  if (END_OF_TURN.test(data)) {
    return { status: 'idle', statusDetail: '' };
  }
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
// resolveTranscriptPath — Sprint 50 T1.
//
// Codex stores chat-shape JSONL rollouts at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// (verified 2026-05-02 substrate probe — first line is
// `{type:'session_meta', payload:{cwd, ...}}`). `~/.codex/history.jsonl` at
// the top level is a flat command-history shape, NOT chat — Sprint 49
// close-out tried that and got `session-too-short: 0 messages
// (parser=codex)` from the bundled hook against a real lane session.
//
// Attribution strategy: we don't know Codex's internal session UUID at
// spawn time, so we walk today's + yesterday's rollout directories in
// newest-mtime order, parse each file's first line, and return the first
// match where `session_meta.payload.cwd === session.meta.cwd` AND
// `mtime >= session.meta.createdAt`. Returns null when no rollout exists
// (e.g., Codex panel was opened but never sent a turn) — onPanelClose
// no-ops cleanly.
// ──────────────────────────────────────────────────────────────────────────

function _codexCandidateDirs(homedir, now) {
  const path = require('path');
  const day = new Date(now);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const fmt = (d) => ({
    Y: String(d.getUTCFullYear()),
    M: String(d.getUTCMonth() + 1).padStart(2, '0'),
    D: String(d.getUTCDate()).padStart(2, '0'),
  });
  const out = [];
  for (const d of [day, yesterday]) {
    const { Y, M, D } = fmt(d);
    out.push(path.join(homedir, '.codex', 'sessions', Y, M, D));
  }
  return out;
}

// Sprint 64 T2 (carve-out 2.1) — `min(birthtime, mtime)` is the right gate
// for cross-panel contamination. Sprint 63 EXIT-CAPTURE-VERIFICATION.md
// Finding #1 documents the failure mode: when codex panel-B spawned and
// self-exited during the 0.129→0.130 auto-update, panel-A's rollout was
// still being written by panel-A's ongoing turns; A's `mtimeMs` exceeded
// B's `createdAtMs`, so A was returned as B's transcript.
//
// Why `min(birthtime, mtime)` rather than birthtime alone or mtime alone:
//   • Cross-panel contamination (Sprint 63 Finding #1): Panel-A active panel
//     has `birthtime=T_A_create` (in the past) and `mtime=NOW` (bumped each
//     turn). min = birthtime — correctly rejects when birthtime < spawn time.
//   • Backdated-mtime stale rollouts: mtime < birthtime. min = mtime —
//     correctly rejects when backdated mtime < spawn time.
//   • Same-session rollout (this panel's own): birthtime AND mtime both
//     post-spawn. min = birthtime ≈ mtime — correctly admits.
//   • Platforms without birthtime (some Linux tmpfs returns birthtimeMs=0):
//     fall back to `mtime` for both terms of the min → equivalent to mtime
//     gate, same behavior as pre-fix.
//
// Gate epsilon (per Sprint 64 T4-CODEX 16:21 AUDIT-CONCERN — deterministic
// pre-spawn rejection on birthtime-capable platforms):
//   • Birthtime-capable platforms (APFS, ext4 with `statx`, NTFS): STRICT,
//     no epsilon. Birthtime is deterministic FS metadata — no jitter, no
//     quantization beyond ~1ns. A file with `birthtimeMs < spawnTimestampMs`
//     was unambiguously created before this panel spawned and CANNOT be
//     this panel's rollout. Strict gate is correct.
//   • Mtime-fallback platforms (rare; some Linux tmpfs): use
//     `_CODEX_GATE_EPSILON_MS_MTIME_FALLBACK = 5000ms` to absorb FS time
//     quantization rounding plus any small clock-skew between OS time and
//     `Date.now()`. mtime can drift in production (active concurrent panel
//     bumps it), so this epsilon path is intentionally narrower than
//     birthtime — it's a structural fallback, not a tolerance knob.
const _CODEX_GATE_EPSILON_MS_BIRTHTIME = 0;
const _CODEX_GATE_EPSILON_MS_MTIME_FALLBACK = 5000;

async function resolveTranscriptPath(session) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (!session || !session.meta || !session.meta.cwd) return null;
  const cwd = session.meta.cwd;
  const createdAtMs = session.meta.createdAt
    ? Date.parse(session.meta.createdAt)
    : 0;
  // Sprint 64 T2 (carve-out 2.1) — spawnTimestampMs is set in spawnTerminalSession
  // immediately after `pty.spawn` returns; strictly later than createdAt (which
  // is set in `sessions.create` BEFORE pty.spawn). Use it when present; fall
  // back to createdAt for older sessions reloaded from SQLite that pre-date the
  // field. The `- _CODEX_GATE_EPSILON_MS` accounts for filesystem time-stamp
  // quantization rounding (worst-case 1s on some platforms).
  const spawnAtMs = (typeof session.meta.spawnTimestampMs === 'number' && session.meta.spawnTimestampMs > 0)
    ? session.meta.spawnTimestampMs
    : createdAtMs;
  const candidates = [];
  for (const dir of _codexCandidateDirs(os.homedir(), Date.now())) {
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch (_) { continue; }
    for (const name of entries) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      // Per-file gate: prefer strict birthtime when the platform exposes it;
      // fall back to epsilon-tolerant mtime only when birthtime is unavailable.
      // Either signal indicates "this rollout existed before the panel
      // spawned" → reject the candidate.
      const hasBirthtime = (typeof st.birthtimeMs === 'number' && st.birthtimeMs > 0);
      const epsilonForFile = hasBirthtime
        ? _CODEX_GATE_EPSILON_MS_BIRTHTIME
        : _CODEX_GATE_EPSILON_MS_MTIME_FALLBACK;
      const gateMsForFile = spawnAtMs > 0 ? spawnAtMs - epsilonForFile : 0;
      const fileBirthMs = hasBirthtime ? st.birthtimeMs : st.mtimeMs;
      const fileMinMs = Math.min(fileBirthMs, st.mtimeMs);
      if (gateMsForFile && fileMinMs < gateMsForFile) continue;
      candidates.push({ full, mtime: st.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { full } of candidates) {
    let firstLine;
    try {
      const buf = fs.readFileSync(full, 'utf8');
      const nl = buf.indexOf('\n');
      firstLine = nl >= 0 ? buf.slice(0, nl) : buf;
    } catch (_) { continue; }
    let meta;
    try { meta = JSON.parse(firstLine); } catch (_) { continue; }
    if (!meta || meta.type !== 'session_meta') continue;
    if (!meta.payload || meta.payload.cwd !== cwd) continue;
    return full;
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

// ──────────────────────────────────────────────────────────────────────────
// probeCodexVersion — Sprint 64 T2 (carve-out 2.3).
//
// Pre-spawn version probe for the Codex CLI auto-update lifecycle hazard
// documented in Sprint 63 EXIT-CAPTURE-VERIFICATION.md Finding #1. Codex CLI
// has no `--no-update` flag (verified 2026-05-11 against codex 0.130.0), so a
// stale codex panel may fire its interactive update picker on spawn, accept
// "Update now," `npm install -g @openai/codex`, and exit 0 — BEFORE any canary
// inject lands. Joshua's Sprint 63 T2 lost a codex canary panel to exactly
// this failure mode at 13:26 ET.
//
// Approach (per Sprint 64 ORCH SCOPE 16:14 ET adjudication of T4-CODEX 16:11
// AUDIT-CONCERN #3 default-install visibility): two complementary WARN paths.
//
//   • **Persisted last-seen-version drift.** Read
//     `~/.termdeck/.last-codex-version`. Absent → write `observed` silently,
//     no WARN (first run is "baseline," not "drift"). Present and
//     `observed !== persisted` → log WARN + update persisted to new observed
//     (self-heals: next spawn is silent on the new version). Catches the
//     Sprint 63 auto-update hazard for the default operator with no env-var
//     setup required. Doesn't false-alarm on stable installs (no env, no
//     persisted file changes once written).
//
//   • **`CODEX_PINNED_VERSION` env knob.** Operator-explicit pin retained
//     as a separate signal — useful in CI / multi-user installs where the
//     persisted file is per-user but the pin is global. WARN on observed ≠
//     pinned; independent of the drift path above.
//
// Why not a hardcoded "known-good window"? Codex shipped 0.125 → 0.129 →
// 0.130 in ~10 days; a baked-in version list goes stale in a week. The
// persisted-self-heal path is the deterministic answer.
//
// Why not a wrapper shim (option B) that intercepts the update picker? The
// picker has already shifted shape across recent codex releases; a shim that
// answers "n\n" today may answer "yes\n" to a future renamed prompt. Real
// fix lives upstream — file a `--no-update` flag against the Codex CLI repo.
// Tracking that filing is cheaper than maintaining a shim.
//
// Dependency-injected `spawnSync` + `logger` + `fsApi` keep the fence test
// free of a live codex binary on PATH or filesystem dependence.
// ──────────────────────────────────────────────────────────────────────────

// Module-level constants for testability — ORCH SCOPE 16:14 ET. Fence tests
// override the path by passing `{ persistedVersionPath: '...' }`.
const _CODEX_PERSISTED_VERSION_FILENAME = '.last-codex-version';

function _defaultPersistedVersionPath() {
  const os = require('os');
  const path = require('path');
  return path.join(os.homedir(), '.termdeck', _CODEX_PERSISTED_VERSION_FILENAME);
}

function probeCodexVersion({
  pinnedVersion = process.env.CODEX_PINNED_VERSION,
  spawnSync = require('child_process').spawnSync,
  logger = console,
  fsApi = require('fs'),
  persistedVersionPath = _defaultPersistedVersionPath(),
} = {}) {
  let observed = null;
  try {
    const res = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (!res || res.status !== 0 || !res.stdout) {
      return { ok: null, observed: null, reason: 'probe-failed' };
    }
    const match = String(res.stdout).match(/(\d+\.\d+\.\d+)/);
    observed = match ? match[1] : null;
  } catch (_) {
    return { ok: null, observed: null, reason: 'probe-error' };
  }
  if (!observed) {
    return { ok: null, observed: null, reason: 'no-version-string' };
  }

  // Drift path: compare observed against persisted last-seen value.
  let persisted = null;
  let driftDetected = false;
  try {
    if (fsApi.existsSync(persistedVersionPath)) {
      const raw = fsApi.readFileSync(persistedVersionPath, 'utf8');
      const trimmed = String(raw || '').trim();
      persisted = trimmed.length > 0 ? trimmed : null;
    }
  } catch (_) {
    // Read failure is non-fatal — treat as absent. Persistence is best-effort.
    persisted = null;
  }
  if (persisted === null) {
    // First-run baseline — write silently, no WARN.
    _writePersistedVersion(fsApi, persistedVersionPath, observed);
  } else if (persisted !== observed) {
    driftDetected = true;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        `[codex] version drift detected: observed=${observed} persisted=${persisted} — `
        + 'codex CLI may have auto-updated since last spawn (Sprint 63 lifecycle hazard).'
      );
    }
    _writePersistedVersion(fsApi, persistedVersionPath, observed);
  }

  // Pin path: independent of drift. Warns on every spawn where pin ≠ observed.
  let pinnedMismatch = false;
  if (pinnedVersion && observed !== pinnedVersion) {
    pinnedMismatch = true;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        `[codex] version pin mismatch: observed=${observed} pinned=${pinnedVersion} — `
        + 'CODEX_PINNED_VERSION env var requires explicit re-pin (Sprint 63 lifecycle hazard).'
      );
    }
  }

  if (driftDetected || pinnedMismatch) {
    return { ok: false, observed, persisted, pinned: pinnedVersion || null, driftDetected, pinnedMismatch };
  }
  return { ok: true, observed, persisted, pinned: pinnedVersion || null, driftDetected: false, pinnedMismatch: false };
}

function _writePersistedVersion(fsApi, p, version) {
  try {
    const path = require('path');
    const dir = path.dirname(p);
    try { fsApi.mkdirSync(dir, { recursive: true }); }
    catch (_) { /* fail-soft — usually already exists */ }
    fsApi.writeFileSync(p, `${version}\n`, 'utf8');
  } catch (_) {
    // Persistence failure is non-fatal — WARN behavior is unaffected the
    // next spawn (we'll re-detect drift against whatever is/isn't on disk).
  }
}

const codexAdapter = {
  name: 'codex',
  sessionType: 'codex',
  // Sprint 50 T3 — see claude.js for rationale.
  displayName: 'Codex CLI',
  matches: (cmd) => typeof cmd === 'string' && /\bcodex\b/i.test(cmd),
  spawn: {
    binary: 'codex',
    defaultArgs: [],
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    // Sprint 64 T2 (carve-out 2.4) — direct spawn (no `zsh -c` wrapper) when
    // the launching command is exactly the binary name. Sprint 63
    // EXIT-CAPTURE-VERIFICATION.md § 6 flagged this as a probable contributor
    // to codex's fast-death window during the 2026-05-11 13:26 ET update-picker
    // event — codex spawned through `zsh -c codex` may have lost the
    // interactive-TTY context the update-picker dialog needed. See claude.js
    // for the full rationale + fallback semantics.
    shellWrap: false,
  },
  patterns: {
    prompt: PROMPT,
    thinking: THINKING,
    endOfTurn: END_OF_TURN,
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
  // Sprint 50 T1 — 10th adapter field. See header above for substrate
  // findings + attribution strategy.
  resolveTranscriptPath,
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

// Sprint 64 T2 (carve-out 2.3) — expose probeCodexVersion on the adapter object
// so call sites can `require('./codex').probeCodexVersion(...)` without
// threading through the registry. Adapter-shape parity tests (Sprint 45 T4's
// tests/agent-adapter-parity.test.js) iterate a fixed allowlist of fields and
// tolerate extra properties — adding this function is safe.
codexAdapter.probeCodexVersion = probeCodexVersion;

module.exports = codexAdapter;
