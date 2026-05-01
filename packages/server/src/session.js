// Session manager - PTY lifecycle, metadata tracking, output analysis
// Each session wraps a node-pty instance with rich metadata.
//
// v0.7.0 theme model (see theme-resolver.js): meta.theme is a *getter* that
// resolves at read time from { session.theme_override → project default →
// global default → 'tokyo-night' }. The session no longer snapshots a theme
// string into meta at construction. This is the getter form (vs. the
// alternative of recomputing-and-writing on every metadata broadcast) because
// it makes the resolution path explicit at every read site and keeps the
// metadata broadcast in index.js untouched — `s.meta.theme` already returns
// the right thing whenever index.js dereferences it.

const { v4: uuidv4 } = require('uuid');
const os = require('os');
const path = require('path');
const { resolveTheme } = require('./theme-resolver');
const flashbackDiag = require('./flashback-diag');
const claudeAdapter = require('./agent-adapters/claude');
const { detectAdapter, getAdapterForSessionType } = require('./agent-adapters');

// Strip ANSI escape codes for pattern matching
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\?]?[0-9;]*[A-Za-z]/g, '')   // CSI sequences (including ?-prefixed like bracketed paste)
    .replace(/\x1b\][^\x07]*\x07/g, '')             // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')               // Character set sequences
    .replace(/\x1b[>=<]/g, '');                      // Keypad/cursor modes
}

// Pattern matchers for detecting terminal type and status.
//
// Sprint 44 T3: claudeCode patterns are owned by the Claude adapter at
// ./agent-adapters/claude.js. This object continues to expose them under
// the legacy `PATTERNS.claudeCode.*` shape so external callers
// (tests/rcfile-noise.test.js, tests/analyzer-error-fixtures.test.js, the
// rcfile-noise analyze.js fixture script) keep working without import
// changes. Sprint 45 T4 removes this shim — new code should consume the
// adapter directly via require('./agent-adapters/claude').
const PATTERNS = {
  claudeCode: {
    prompt: claudeAdapter.patterns.prompt,
    thinking: claudeAdapter.patterns.thinking,
    editing: claudeAdapter.patterns.editing,
    tool: claudeAdapter.patterns.tool,
    idle: claudeAdapter.patterns.idle
  },
  geminiCli: {
    prompt: /^gemini>\s/m,
    thinking: /\b(Generating|Working)\b/,
  },
  pythonServer: {
    uvicorn: /Uvicorn running on/,
    flask: /Running on http/,
    django: /Starting development server/,
    httpServer: /Serving HTTP on/,
    request: /(?:^|\s|")(GET|POST|PUT|DELETE|PATCH)\s+\S+.*?\s(\d{3})/m,
    // Sprint 40 T2: HTTP 5xx response in a web-server log line is a real
    // error condition for the application. Used as a python-server-typed
    // fallback in _detectErrors when the prose-shape analyzers miss because
    // the line carries no `Error:` keyword — just `"GET /foo HTTP/1.1" 503`.
    // 5xx only (not 4xx, which are typically client-caused). The leading
    // `(?:^|\s|")` mirrors `request` so colon-quoted log shapes still match.
    serverError: /(?:^|\s|")(?:GET|POST|PUT|DELETE|PATCH)\s+\S+.*?\sHTTP\/\d(?:\.\d)?"?\s+5\d{2}\b/m,
    // Port detection — matches any of:
    //   • "port NNNN" phrase (capture group 1)
    //   • URL with http/https scheme, optionally prefixed with "on " or "at "
    //     (capture group 2)
    //   • bare "on HOST:NNNN" or "at HOST:NNNN" even without a scheme
    //     (capture group 2)
    // Port must be 2–5 digits to avoid matching timestamps like "23:40".
    // `_detectPort` reads `match[1] || match[2]`, so both capture groups
    // are live.
    port: /(?:\bport\s+(\d{2,5})\b|(?:https?:\/\/|\bon\s+|\bat\s+)[a-zA-Z0-9.\-_\[\]]+:(\d{2,5})\b)/i
  },
  shell: {
    prompt: /[\$#%❯>]\s*$/m,
    // Match lines ending with common shell control sequences that indicate a new prompt
    // We track commands via input echo instead (see _trackInput)
    command: /^[\$#%❯>]\s+(.+)$/m
  },
  // Broad error markers across shells, compilers, scripts, and HTTP servers.
  // Includes the literal "No such file or directory" phrase because many Unix
  // tools (cat, ls, cd, rm, etc.) report filesystem misses in plain English
  // without ever emitting the ENOENT errno code. Flagged as a gap by Rumen's
  // first production kickstart insight on 2026-04-15.
  // Sprint 40 T2: added uppercase `ERROR:` (mirrors `Error:` / `error:` for
  // case-symmetry — closes the stripAnsi-ERROR test fixture from Sprint 33)
  // and Node errno-style colon-prefix shapes (`ENOENT:`, `EACCES:`,
  // `ECONNREFUSED:`) so `ENOENT: no such file or directory` shapes from
  // child-process error reporting fire without depending on the line ALSO
  // containing the `No such file or directory` prose phrase.
  error: /(?:^|\n)\s*(?:Error:\s+\S|error:\s+\S|ERROR:\s+\S|Traceback \(most recent call last\):|npm ERR!|error\[E\d+\]:|Uncaught Exception|Fatal:|ENOENT:\s+\S|EACCES:\s+\S|ECONNREFUSED:\s+\S)/m,
  // Stricter line-anchored variant for Claude Code, whose tool output (grep
  // results, test logs, file contents) routinely mentions "Error" mid-line
  // without representing an actual failure of the agent itself.
  // Sprint 40 T2: added mixed-case `Fatal` (mirrors `fatal` / `FATAL`) and
  // the `npm ERR!` shape (special-cased outside the alternation because
  // `!` is not a word character so `\b` after `npm ERR!` doesn't match).
  // Sprint 44 T3: this regex is now owned by the Claude adapter
  // (./agent-adapters/claude.js patterns.error). The shim below preserves
  // the legacy PATTERNS.errorLineStart export — same regex object, so any
  // existing reference equality (e.g. `=== PATTERNS.errorLineStart`) holds.
  errorLineStart: claudeAdapter.patterns.error,
  // Sprint 33: PATTERNS.error misses the most common Unix shell errors —
  // `cat: /foo: No such file or directory`, `bash: foo: command not found`,
  // `rm: cannot remove ...: Permission denied`. These have a colon-prefix
  // shape (`<cmd>: ...: <phrase>`) that distinguishes them from prose
  // mentioning the same words. Each branch requires either the colon-prefix
  // structure or a stand-alone anchored keyword. Validated against an
  // adversarial prose suite (see tests/analyzer-error-fixtures.test.js).
  //
  // Sprint 39 T2: separated `command not found` from the other phrases. The
  // unified branch was matching rcfile-noise lines emitted by version
  // managers during shell startup — most notably:
  //   `pyenv: pyenv-virtualenv-init: command not found in path`
  // …which has the colon-prefix-with-`command not found` shape but with a
  // descriptive suffix (` in path`) rather than ending the line. The pyenv
  // case confirms the strong rcfile-noise hypothesis for pyenv users: their
  // shell startup burns the 30s onErrorDetected rate limit before the user
  // can type their first command. The dedicated `command not found` branch
  // below requires the keyword to be either:
  //   • followed by `:` (the zsh `command not found: <cmd>` form), or
  //   • at end-of-line (the bash `<sh>: <cmd>: command not found` form).
  // Suffixes like ` in path`, ` in $PATH`, ` (compinit)` are silenced as
  // rcfile noise.
  // Trade-off: custom command_not_found_handler output that adds a comma-
  // separated "did you mean X" suggestion is silenced — those are cosmetic
  // suggestions, not the error itself, which the user already saw fire.
  // See tests/rcfile-noise.test.js and tests/analyzer-error-fixtures.test.js
  // for the locked corpus.
  shellError: /(?:^|\n)(?:[^\n]*:\s+(?:.*?:\s+)?(?:No such file or directory|Permission denied|Is a directory|Not a directory)\b|[^\n]*:\s+(?:.*?:\s+)?command not found(?::|\s*(?:[\r\n]|$))|[^\n]*?\(\d+\)\s+Could not resolve host\b|\s*ModuleNotFoundError:\s+\S|\s*Segmentation fault\b|\s*fatal:\s+\S)/m
};

class Session {
  constructor(options) {
    this.id = options.id || uuidv4();
    this.pid = null;
    this.pty = null;
    this.ws = null;

    // v0.7.0: theme_override is the user's explicit dropdown choice (NULL = no
    // override → resolveTheme falls through to project / global default at
    // read time). The legacy `options.theme` argument is intentionally NOT
    // stored as an override here — it arrives from index.js already
    // pre-defaulted (`theme || project.defaultTheme || config.defaultTheme`),
    // which means we can no longer distinguish a real user choice from the
    // server-filled default at the create-call boundary. Real overrides come
    // through PATCH /api/sessions/:id (see updateMeta below).
    this.theme_override = options.themeOverride != null ? options.themeOverride : null;

    // Project (mirrored from meta for theme-resolver convenience — resolveTheme
    // reads `session.project`, not `session.meta.project`).
    Object.defineProperty(this, 'project', {
      get: () => this.meta.project,
      enumerable: false,
      configurable: true
    });

    // Metadata
    this.meta = {
      type: options.type || 'shell',        // shell, claude-code, gemini, python-server, one-shot
      project: options.project || null,
      label: options.label || '',
      command: options.command || '',
      cwd: options.cwd || os.homedir(),
      createdAt: new Date().toISOString(),
      reason: options.reason || 'manual launch',

      // Dynamic state (updated by output analyzer)
      status: 'starting',                   // starting, active, idle, thinking, editing, errored, exited
      statusDetail: '',
      lastCommands: [],                      // rolling buffer of last 10 commands
      lastActivity: new Date().toISOString(),
      detectedPort: null,
      requestCount: 0,
      exitCode: null,
      childProcesses: [],

      // RAG
      ragEnabled: options.ragEnabled !== false,
      ragEvents: []                          // buffer before flush
    };

    // theme is render-time resolved (see header comment + theme-resolver.js).
    // Reads call resolveTheme(this, undefined) which falls back to the cached
    // ~/.termdeck/config.yaml. Writes route to theme_override so PATCH/UPDATE
    // through `session.meta.theme = 'dracula'` persists correctly. Setting
    // null clears the override and reverts to the config-derived default.
    Object.defineProperty(this.meta, 'theme', {
      get: () => resolveTheme(this),
      set: (val) => { this.theme_override = val == null ? null : val; },
      enumerable: true,
      configurable: true
    });

    // Transcript chunk counter — monotonic per session for deterministic replay
    this.transcriptChunkIndex = 0;

    // Output analysis state
    this._outputBuffer = '';
    this._outputFlushTimer = null;
    this._commandBuffer = '';
    this._inputBuffer = '';   // tracks user keyboard input for command detection
    this.onCommand = null;    // callback: (sessionId, command) => void
    this.onStatusChange = null; // callback: (session, oldStatus, newStatus) => void
    this.onErrorDetected = null; // callback: (session, { lastCommand, tail }) => void
    this._statusChangeTimer = null;
    this._pendingStatusChange = null;
    this._lastErrorFireAt = 0;
  }

  // Analyze PTY output to extract metadata
  analyzeOutput(data) {
    this._outputBuffer += data;
    this.meta.lastActivity = new Date().toISOString();

    // Strip ANSI codes for reliable pattern matching
    const clean = stripAnsi(data);

    // Detect terminal type if still generic
    if (this.meta.type === 'shell') {
      this._detectType(clean);
    }

    // Detect ports before status update (so status can reference the port)
    this._detectPort(clean);

    // Update status based on type-specific patterns
    this._updateStatus(clean);

    // Extract commands from shell-like prompts
    this._extractCommands(clean);

    // Count HTTP requests for server terminals
    this._countRequests(clean);

    // Error detection — transition to 'errored' and fire onErrorDetected (rate limited 30s)
    this._detectErrors(clean);

    // Flush buffer periodically (don't hold too much in memory)
    clearTimeout(this._outputFlushTimer);
    this._outputFlushTimer = setTimeout(() => {
      // Keep last 4KB for pattern matching
      if (this._outputBuffer.length > 4096) {
        this._outputBuffer = this._outputBuffer.slice(-4096);
      }
      // Server types: revert to 'listening' after output settles
      if (this.meta.type === 'python-server' && this.meta.status === 'active') {
        this.meta.status = 'listening';
        this.meta.statusDetail = this.meta.detectedPort
          ? `Serving on :${this.meta.detectedPort}`
          : 'Server running';
      }
    }, 2000);
  }

  _detectType(data) {
    // Sprint 44 T3: registry-aware detection. detectAdapter() iterates
    // AGENT_ADAPTERS in declaration order and returns the first hit by
    // prompt regex OR command-string match. Sprint 44 lands Claude only
    // (so this returns the Claude adapter or undefined); Sprint 45 adds
    // Codex / Gemini / Grok adapters and the gemini fall-through below
    // moves into gemini.js.
    const adapter = detectAdapter(data, this.meta.command);
    if (adapter) {
      this.meta.type = adapter.sessionType;
      return;
    }
    if (PATTERNS.geminiCli.prompt.test(data) || /gemini/i.test(this.meta.command)) {
      this.meta.type = 'gemini';
    } else if (
      PATTERNS.pythonServer.uvicorn.test(data) ||
      PATTERNS.pythonServer.flask.test(data) ||
      PATTERNS.pythonServer.django.test(data) ||
      PATTERNS.pythonServer.httpServer.test(data)
    ) {
      this.meta.type = 'python-server';
    }
  }

  _updateStatus(data) {
    const p = PATTERNS;
    const oldStatus = this.meta.status;

    // Sprint 44 T3: claude-code status detection now lives in the Claude
    // adapter's `statusFor(data)` method. Returns { status, statusDetail }
    // on a match, null on no-change — preserves the original switch's
    // "leave status untouched if no claude pattern fires" semantics.
    // Other types (gemini, python-server, default shell) stay in-file
    // until Sprint 45 migrates them.
    const adapter = getAdapterForSessionType(this.meta.type);
    if (adapter && typeof adapter.statusFor === 'function') {
      const result = adapter.statusFor(data);
      if (result && result.status) {
        this.meta.status = result.status;
        this.meta.statusDetail = result.statusDetail || '';
      }
    } else {
      switch (this.meta.type) {
      case 'gemini':
        if (p.geminiCli.thinking.test(data)) {
          this.meta.status = 'thinking';
          this.meta.statusDetail = 'Gemini is generating...';
        } else if (p.geminiCli.prompt.test(data)) {
          this.meta.status = 'idle';
          this.meta.statusDetail = 'Waiting for input';
        }
        break;

      case 'python-server':
        if (p.pythonServer.request.test(data)) {
          this.meta.status = 'active';
          const match = data.match(p.pythonServer.request);
          if (match) {
            this.meta.statusDetail = `${match[1]} → ${match[2]}`;
          }
        } else {
          this.meta.status = 'listening';
          this.meta.statusDetail = this.meta.detectedPort
            ? `Serving on :${this.meta.detectedPort}`
            : 'Server running';
        }
        break;

      default:
        if (p.shell.prompt.test(data)) {
          this.meta.status = 'idle';
          this.meta.statusDetail = 'Ready';
        } else {
          this.meta.status = 'active';
        }
      }
    }

    // Debounce status change events (3s) to avoid flooding RAG with active↔idle flaps
    if (this.meta.status !== oldStatus && this.onStatusChange) {
      clearTimeout(this._statusChangeTimer);
      this._pendingStatusChange = { oldStatus, newStatus: this.meta.status };
      this._statusChangeTimer = setTimeout(() => {
        if (this._pendingStatusChange) {
          this.onStatusChange(this, this._pendingStatusChange.oldStatus, this._pendingStatusChange.newStatus);
          this._pendingStatusChange = null;
        }
      }, 3000);
    }
  }

  _detectPort(data) {
    const match = data.match(PATTERNS.pythonServer.port);
    if (match) {
      // Two capture groups: match[1] for "port XXXX", match[2] for ":XXXX"
      this.meta.detectedPort = parseInt(match[1] || match[2], 10);
    }
  }

  // Track user input to detect commands (called from server when PTY receives input)
  trackInput(data) {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = ch.charCodeAt(0);

      if (ch === '\r' || ch === '\n') {
        // Enter — flush the buffer as a command
        const cmd = this._inputBuffer.trim();
        if (cmd.length > 0 && cmd.length < 500) {
          const clean = cmd.replace(/\x1b\[[A-Za-z0-9;]*[A-Za-z]/g, '').trim();
          if (clean.length > 0) {
            this.meta.lastCommands.push({
              command: clean,
              timestamp: new Date().toISOString()
            });
            if (this.meta.lastCommands.length > 10) {
              this.meta.lastCommands.shift();
            }
            if (this.onCommand) {
              this.onCommand(this.id, clean);
            }
          }
        }
        this._inputBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        this._inputBuffer = this._inputBuffer.slice(0, -1);
      } else if (ch === '\x1b') {
        // Skip escape sequences
        if (i + 1 < data.length && data[i + 1] === '[') {
          i += 2; // skip \x1b[
          while (i < data.length && !/[A-Za-z]/.test(data[i])) i++;
          // i now points at the final letter, loop increment will skip it
        }
      } else if (code >= 32) {
        this._inputBuffer += ch;
      }
    }
  }

  getNextChunkIndex() {
    return this.transcriptChunkIndex++;
  }

  _detectErrors(clean) {
    // After a clean PTY exit (code 0), the session has already completed
    // successfully — index.js sets status='exited' / exitCode=0 in onExit.
    // Trailing data events that contain error-like strings (Claude Code tool
    // output, log tails) shouldn't retroactively flip the panel back to
    // 'errored'. Real errors surface via non-zero exit codes.
    if (this.meta.exitCode === 0) return;

    // Claude Code's tool output frequently contains "error"/"Error" mid-line
    // (grep matches, test results, log dumps). Use a line-anchored pattern
    // for that session type so we don't flag content as failure.
    //
    // Sprint 44 T3: per-agent primary error pattern is now read off the
    // adapter (`patterns.error` + `patternNames.error`). Falls back to the
    // generic prose-shape PATTERNS.error when no adapter has claimed the
    // session type. The Claude adapter's `patterns.error` IS the same regex
    // object as PATTERNS.errorLineStart (the shim wires them together), so
    // existing `=== PATTERNS.errorLineStart` reference checks still hold.
    const adapter = getAdapterForSessionType(this.meta.type);
    const primaryPattern = adapter && adapter.patterns && adapter.patterns.error
      ? adapter.patterns.error
      : PATTERNS.error;
    const primaryName = adapter && adapter.patternNames && adapter.patternNames.error
      ? adapter.patternNames.error
      : 'error';
    // Sprint 33 fix: the structured patterns above miss `cat: /foo: No such
    // file or directory` and friends — the most common Unix shell error
    // shapes Josh hits day-to-day. Fall through to PATTERNS.shellError so
    // the analyzer flips status='errored' and Flashback can fire.
    const primaryMatch = clean.match(primaryPattern);
    const shellMatch = !primaryMatch ? clean.match(PATTERNS.shellError) : null;
    // Sprint 40 T2: HTTP 5xx fallback for python-server sessions. The prose
    // analyzers miss `"GET /foo HTTP/1.1" 503 -` because it carries no
    // `Error:` keyword — but the response IS the error signal for an
    // HTTP-server session. Gated on session type to avoid flagging 5xx
    // status codes that legitimately appear in unrelated content (e.g. a
    // shell that just printed a copy of an HTTP log).
    const serverMatch = (!primaryMatch && !shellMatch && this.meta.type === 'python-server')
      ? clean.match(PATTERNS.pythonServer.serverError)
      : null;
    if (!primaryMatch && !shellMatch && !serverMatch) return;

    // Sprint 39 T1 — pattern_match diag event. Emitted on every PATTERNS hit,
    // including ones that get rate-limited downstream. T2 reads these to
    // measure the rcfile-noise false-positive rate against real shell output.
    const matchedSrc = primaryMatch || shellMatch || serverMatch;
    const matchedLine = (matchedSrc && typeof matchedSrc[0] === 'string')
      ? matchedSrc[0].replace(/^\n+/, '').slice(0, 200)
      : '';
    const matchedPattern = primaryMatch
      ? primaryName
      : (shellMatch ? 'shellError' : 'serverError');
    flashbackDiag.log({
      sessionId: this.id,
      event: 'pattern_match',
      pattern: matchedPattern,
      matched_line: matchedLine,
      output_chunk_size: clean.length,
    });

    const oldStatus = this.meta.status;
    this.meta.status = 'errored';
    this.meta.statusDetail = 'Error detected in output';

    // Mirror status-change callback so T1 sees 'errored' in status_broadcast without
    // waiting for the 3s debounce.
    if (oldStatus !== 'errored' && this.onStatusChange) {
      try { this.onStatusChange(this, oldStatus, 'errored'); } catch (err) { console.error('[pty] onStatusChange error:', err.message); }
    }

    // Server-side rate limit: at most one error_detected event every 30s per session
    const now = Date.now();
    const remainingMs = this._lastErrorFireAt
      ? Math.max(0, 30000 - (now - this._lastErrorFireAt))
      : 0;

    // Sprint 39 T1 — error_detected diag event, before the rate-limit gate.
    // The (error_detected count − rate_limit_blocked count) is the number of
    // errors that actually got dispatched to onErrorDetected. T2/T3 use this
    // to spot rcfile noise burning the rate-limit window before real errors.
    flashbackDiag.log({
      sessionId: this.id,
      event: 'error_detected',
      error_text: matchedLine,
      rate_limit_remaining_ms: remainingMs,
      last_emit_at: this._lastErrorFireAt
        ? new Date(this._lastErrorFireAt).toISOString()
        : null,
    });

    if (now - this._lastErrorFireAt < 30000) {
      flashbackDiag.log({
        sessionId: this.id,
        event: 'rate_limit_blocked',
        rate_limit_remaining_ms: remainingMs,
      });
      console.log(`[flashback] error detected in session ${this.id} but rate-limited (${Math.round((30000 - (now - this._lastErrorFireAt)) / 1000)}s left)`);
      return;
    }
    this._lastErrorFireAt = now;

    if (this.onErrorDetected) {
      const lastCommand = this.meta.lastCommands.length > 0
        ? this.meta.lastCommands[this.meta.lastCommands.length - 1].command
        : '';
      const tail = this._outputBuffer.slice(-200).replace(/\x1b\[[\?]?[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      try {
        this.onErrorDetected(this, { lastCommand, tail });
      } catch (err) {
        console.error('[flashback] onErrorDetected handler threw:', err);
        console.error('[session] onErrorDetected handler error:', err);
      }
    } else {
      console.log(`[flashback] error detected in session ${this.id} but no onErrorDetected handler wired`);
    }
  }

  _extractCommands(data) {
    // Output-based command extraction as fallback (e.g. for commands echoed by shell)
    // Primary command tracking is via trackInput()
  }

  _countRequests(data) {
    const globalRequest = new RegExp(PATTERNS.pythonServer.request.source, 'gm');
    const matches = data.match(globalRequest);
    if (matches) {
      this.meta.requestCount += matches.length;
    }
  }

  toJSON() {
    return {
      id: this.id,
      pid: this.pid,
      meta: { ...this.meta }
    };
  }

  destroy() {
    clearTimeout(this._outputFlushTimer);
    clearTimeout(this._statusChangeTimer);
    this._outputBuffer = '';
  }
}

class SessionManager {
  constructor(db) {
    this.sessions = new Map();
    this.db = db;
    this._listeners = new Map(); // event listeners
  }

  create(options) {
    const session = new Session(options);
    this.sessions.set(session.id, session);

    // Persist to SQLite. Both columns get written:
    //   theme           — legacy; the resolved value at create time, kept for
    //                     backward-compat with any consumer that still reads it.
    //                     Not authoritative post-v0.7.0.
    //   theme_override  — v0.7.0 authoritative column. NULL on create — only
    //                     a PATCH from the dropdown sets it (see updateMeta).
    if (this.db) {
      this.db.prepare(`
        INSERT INTO sessions (id, type, project, label, command, cwd, created_at, reason, theme, theme_override)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.meta.type,
        session.meta.project,
        session.meta.label,
        session.meta.command,
        session.meta.cwd,
        session.meta.createdAt,
        session.meta.reason,
        session.meta.theme,           // resolved snapshot, legacy column
        session.theme_override        // NULL by default
      );
    }

    this._emit('session:created', session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  getAll() {
    return Array.from(this.sessions.values()).map(s => s.toJSON());
  }

  // Fields a client is allowed to modify via PATCH /api/sessions/:id.
  // Explicit whitelist so a malicious or buggy client cannot inject
  // arbitrary metadata (e.g. overwriting `pid`, `exitCode`, `lastCommands`,
  // or mutating internal pattern state). Server-mutable fields like
  // `status`, `lastActivity`, `detectedPort` are intentionally excluded —
  // those are driven by the output analyzer, not the client.
  static PATCHABLE_META_FIELDS = new Set([
    'theme',
    'label',
    'project',
    'ragEnabled',
    'flashbackEnabled'
  ]);

  updateMeta(id, updates) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (!updates || typeof updates !== 'object') return session;

    const applied = {};
    for (const [key, val] of Object.entries(updates)) {
      if (!SessionManager.PATCHABLE_META_FIELDS.has(key)) continue;
      session.meta[key] = val;          // theme assignment routes through the setter → theme_override
      applied[key] = val;
    }

    // Persist theme changes to SQLite. v0.7.0: writes go to theme_override
    // (the authoritative column); a `theme: null` PATCH clears the override
    // and reverts the session to the config-derived default at next read.
    if ('theme' in applied && this.db) {
      this.db.prepare('UPDATE sessions SET theme_override = ? WHERE id = ?')
        .run(applied.theme == null ? null : applied.theme, id);
    }

    this._emit('session:updated', session);
    return session;
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.destroy();
    this.sessions.delete(id);

    if (this.db) {
      this.db.prepare(`
        UPDATE sessions SET exited_at = ?, exit_code = ? WHERE id = ?
      `).run(new Date().toISOString(), session.meta.exitCode, id);
    }

    this._emit('session:removed', session);
    return true;
  }

  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(fn);
  }

  _emit(event, data) {
    const fns = this._listeners.get(event) || [];
    for (const fn of fns) {
      try { fn(data); } catch (e) { console.error(`[events] handler error for ${event}:`, e); }
    }
  }
}

module.exports = { Session, SessionManager, PATTERNS };
