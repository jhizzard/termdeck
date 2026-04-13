// Session manager - PTY lifecycle, metadata tracking, output analysis
// Each session wraps a node-pty instance with rich metadata

const { v4: uuidv4 } = require('uuid');
const os = require('os');
const path = require('path');

// Strip ANSI escape codes for pattern matching
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\?]?[0-9;]*[A-Za-z]/g, '')   // CSI sequences (including ?-prefixed like bracketed paste)
    .replace(/\x1b\][^\x07]*\x07/g, '')             // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')               // Character set sequences
    .replace(/\x1b[>=<]/g, '');                      // Keypad/cursor modes
}

// Pattern matchers for detecting terminal type and status
const PATTERNS = {
  claudeCode: {
    prompt: /^[>❯]\s/m,
    thinking: /\b(thinking|Thinking)\b/,
    editing: /^(Edit|Create|Update|Delete)\s/m,
    tool: /^⏺\s/m,
    idle: /^>\s*$/m
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
    port: /(?:port\s+(\d+)|(?:on|at)\s+(?:https?:\/\/)?[\w.\[\]:]*:(\d+))/i
  },
  shell: {
    prompt: /[\$#%❯>]\s*$/m,
    // Match lines ending with common shell control sequences that indicate a new prompt
    // We track commands via input echo instead (see _trackInput)
    command: /^[\$#%❯>]\s+(.+)$/m
  },
  // Broad error markers across shells, compilers, scripts, and HTTP servers.
  error: /\b(error|Error|ERROR|exception|Exception|Traceback|fatal|FATAL|segmentation fault|panic|EACCES|ECONNREFUSED|ENOENT|command not found|undefined reference|cannot find module|failed with exit code|\b5\d\d\b)\b/
};

class Session {
  constructor(options) {
    this.id = options.id || uuidv4();
    this.pid = null;
    this.pty = null;
    this.ws = null;

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

      // Theme
      theme: options.theme || 'tokyo-night',

      // RAG
      ragEnabled: options.ragEnabled !== false,
      ragEvents: []                          // buffer before flush
    };

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
    if (PATTERNS.claudeCode.prompt.test(data) || /claude/i.test(this.meta.command)) {
      this.meta.type = 'claude-code';
    } else if (PATTERNS.geminiCli.prompt.test(data) || /gemini/i.test(this.meta.command)) {
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

    switch (this.meta.type) {
      case 'claude-code':
        if (p.claudeCode.thinking.test(data)) {
          this.meta.status = 'thinking';
          this.meta.statusDetail = 'Claude is reasoning...';
        } else if (p.claudeCode.editing.test(data)) {
          this.meta.status = 'editing';
          const match = data.match(/^(Edit|Create|Update|Delete)\s+(.+)$/m);
          this.meta.statusDetail = match ? `${match[1]} ${match[2]}` : 'Editing files';
        } else if (p.claudeCode.tool.test(data)) {
          this.meta.status = 'active';
          this.meta.statusDetail = 'Using tools';
        } else if (p.claudeCode.idle.test(data)) {
          this.meta.status = 'idle';
          this.meta.statusDetail = 'Waiting for input';
        }
        break;

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

  _detectErrors(clean) {
    if (!PATTERNS.error.test(clean)) return;

    const oldStatus = this.meta.status;
    this.meta.status = 'errored';
    this.meta.statusDetail = 'Error detected in output';

    // Mirror status-change callback so T1 sees 'errored' in status_broadcast without
    // waiting for the 3s debounce.
    if (oldStatus !== 'errored' && this.onStatusChange) {
      try { this.onStatusChange(this, oldStatus, 'errored'); } catch {}
    }

    // Server-side rate limit: at most one error_detected event every 30s per session
    const now = Date.now();
    if (now - this._lastErrorFireAt < 30000) return;
    this._lastErrorFireAt = now;

    if (this.onErrorDetected) {
      const lastCommand = this.meta.lastCommands.length > 0
        ? this.meta.lastCommands[this.meta.lastCommands.length - 1].command
        : '';
      const tail = this._outputBuffer.slice(-200).replace(/\x1b\[[\?]?[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      try {
        this.onErrorDetected(this, { lastCommand, tail });
      } catch (err) {
        console.error('[session] onErrorDetected handler error:', err);
      }
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

    // Persist to SQLite
    if (this.db) {
      this.db.prepare(`
        INSERT INTO sessions (id, type, project, label, command, cwd, created_at, reason, theme)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.meta.type,
        session.meta.project,
        session.meta.label,
        session.meta.command,
        session.meta.cwd,
        session.meta.createdAt,
        session.meta.reason,
        session.meta.theme
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

  updateMeta(id, updates) {
    const session = this.sessions.get(id);
    if (!session) return null;

    Object.assign(session.meta, updates);

    // Persist theme changes to SQLite
    if (updates.theme && this.db) {
      this.db.prepare('UPDATE sessions SET theme = ? WHERE id = ?')
        .run(updates.theme, id);
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
