// TermDeck Server - main entry point
// Express REST API + WebSocket hub + PTY management

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Conditional imports (graceful fallback if not installed yet)
let pty, Database;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch { pty = null; }
try { Database = require('better-sqlite3'); } catch { Database = null; }

const { SessionManager } = require('./session');
const { initDatabase, logCommand, getSessionHistory, getProjectSessions } = require('./database');
const { RAGIntegration } = require('./rag');
const { createBridge } = require('./engram-bridge');
const { writeSessionLog } = require('./session-logger');
const { themes, statusColors } = require('./themes');
const { loadConfig } = require('./config');

function createServer(config) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  app.use(express.json());

  // Serve client files
  const clientDir = path.join(__dirname, '..', '..', 'client', 'public');
  app.use(express.static(clientDir));

  // Initialize database
  let db = null;
  if (Database) {
    try {
      db = initDatabase(Database);
      // Mark orphaned sessions as exited (PTYs lost on server restart)
      const orphaned = db.prepare(
        `UPDATE sessions SET exited_at = ?, exit_code = -1 WHERE exited_at IS NULL`
      ).run(new Date().toISOString());
      if (orphaned.changes > 0) {
        console.log(`[db] Marked ${orphaned.changes} orphaned session(s) as exited`);
      }
      console.log('[db] SQLite initialized');
    } catch (err) {
      console.warn('[db] SQLite init failed:', err.message);
    }
  }

  // Initialize session manager
  const sessions = new SessionManager(db);

  // Initialize RAG + Engram bridge
  const rag = new RAGIntegration(config, db);
  const engramBridge = createBridge(config);
  console.log(`[engram-bridge] mode=${engramBridge.mode}`);

  // Wire RAG to session events
  sessions.on('session:created', (s) => rag.onSessionCreated(s));
  sessions.on('session:removed', (s) => rag.onSessionEnded(s));

  // ==================== REST API ====================

  // GET /api/sessions - list all active sessions
  app.get('/api/sessions', (req, res) => {
    res.json(sessions.getAll());
  });

  // POST /api/sessions - create a new terminal session
  app.post('/api/sessions', (req, res) => {
    const { command, cwd, project, label, type, theme, reason } = req.body;

    const rawCwd = cwd || config.projects?.[project]?.path || os.homedir();
    const resolvedCwd = path.resolve(rawCwd.replace(/^~/, os.homedir()));

    const session = sessions.create({
      type: type || 'shell',
      project: project || null,
      label: label || command || 'Terminal',
      command: command || config.shell,
      cwd: resolvedCwd,
      theme: theme || config.projects?.[project]?.defaultTheme || config.defaultTheme,
      reason: reason || 'launched via API'
    });

    // Spawn PTY
    if (pty) {
      const shell = command || config.shell;
      const args = command ? ['-c', command] : [];
      const spawnShell = command ? config.shell : shell;

      try {
        const term = pty.spawn(spawnShell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: resolvedCwd,
          env: {
            ...process.env,
            TERMDECK_SESSION: session.id,
            TERMDECK_PROJECT: project || '',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            // Disable macOS Terminal.app's zsh session save/restore. Without
            // this, new PTYs source ~/.zsh_sessions/<TERM_SESSION_ID>.session
            // which can contain stale or malformed lines from Terminal.app's
            // bookkeeping and fail with "command not found: Saving".
            SHELL_SESSION_HISTORY: '0'
          }
        });

        session.pty = term;
        session.pid = term.pid;
        session.meta.status = 'active';

        // PTY output → analyze + broadcast to WebSocket
        term.onData((data) => {
          session.analyzeOutput(data);

          // Send to connected WebSocket
          if (session.ws && session.ws.readyState === 1) {
            session.ws.send(JSON.stringify({ type: 'output', data }));
          }
        });

        term.onExit(({ exitCode, signal }) => {
          session.meta.status = 'exited';
          session.meta.exitCode = exitCode;
          session.meta.statusDetail = `Exited (${exitCode})${signal ? `, signal ${signal}` : ''}`;

          if (session.ws && session.ws.readyState === 1) {
            session.ws.send(JSON.stringify({
              type: 'exit',
              exitCode,
              signal
            }));
          }

          rag.onSessionEnded(session);

          // Fire-and-forget session log (T2.5)
          writeSessionLog({ session, config, db, getSessionHistory });
        });

        // Wire command logging to SQLite + RAG
        session.onCommand = (sessionId, command) => {
          if (db) {
            try { logCommand(db, sessionId, command); } catch (err) { console.error('[db] logCommand failed:', err); }
          }
          rag.onCommandExecuted(session, command);
        };

        // Wire status change tracking to RAG
        session.onStatusChange = (sess, oldStatus, newStatus) => {
          rag.onStatusChanged(sess, oldStatus, newStatus);
        };

        // Proactive Engram queries on error — fire-and-forget, respects rag.enabled
        session.onErrorDetected = (sess, ctx) => {
          if (!rag.enabled) return;
          const question = `${sess.meta.type} error ${ctx.lastCommand || ''} ${ctx.tail || ''}`.trim();
          engramBridge.queryEngram({
            question,
            project: sess.meta.project,
            searchAll: false,
            sessionContext: {
              type: sess.meta.type,
              project: sess.meta.project,
              lastCommands: sess.meta.lastCommands.slice(-5),
              status: 'errored'
            }
          }).then((result) => {
            const hit = (result.memories || [])[0];
            if (!hit) return;
            if (sess.ws && sess.ws.readyState === 1) {
              try {
                sess.ws.send(JSON.stringify({ type: 'proactive_memory', hit }));
              } catch (err) {
                console.error('[ws] proactive_memory send failed:', err);
              }
            }
          }).catch((err) => {
            console.warn('[engram-bridge] proactive query failed:', err.message);
          });
        };

        console.log(`[pty] Spawned session ${session.id} (PID ${term.pid}): ${shell} ${args.join(' ')}`);
      } catch (err) {
        session.meta.status = 'errored';
        session.meta.statusDetail = err.message;
        console.error(`[pty] Spawn failed:`, err);
      }
    } else {
      session.meta.status = 'errored';
      session.meta.statusDetail = 'node-pty not available';
    }

    res.status(201).json(session.toJSON());
  });

  // GET /api/sessions/:id - get session details
  app.get('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
  });

  // PATCH /api/sessions/:id - update session metadata
  app.patch('/api/sessions/:id', (req, res) => {
    const session = sessions.updateMeta(req.params.id, req.body);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
  });

  // DELETE /api/sessions/:id - kill terminal and remove session
  app.delete('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Kill PTY process
    if (session.pty) {
      try { session.pty.kill(); } catch (err) { console.error('[pty] kill failed for session', req.params.id + ':', err); }
    }

    sessions.remove(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/sessions/:id/input - write text into a PTY from an external sender
  // Body: { text: string, source?: 'user' | 'reply' | 'ai', fromSessionId?: string }
  // Used by T1.3 reply button and any agent-to-agent routing.
  const inputRateLimit = new Map(); // sessionId -> { windowStart, count }
  app.post('/api/sessions/:id/input', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.meta.status === 'exited' || !session.pty) {
      return res.status(404).json({ error: 'Session is exited' });
    }

    const { text, source, fromSessionId } = req.body || {};
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing text' });
    }

    // Rate limit: max 10 writes/sec per target session
    const now = Date.now();
    const bucket = inputRateLimit.get(session.id) || { windowStart: now, count: 0 };
    if (now - bucket.windowStart >= 1000) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    inputRateLimit.set(session.id, bucket);
    if (bucket.count > 10) {
      return res.status(429).json({ error: 'Rate limit exceeded (10/sec)' });
    }

    // CRLF normalize: zsh/readline want \r for Enter
    const normalized = text.replace(/\r\n?/g, '\r').replace(/\n/g, '\r');

    try {
      session.pty.write(normalized);
      session.trackInput(normalized);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    session.meta.replyCount = (session.meta.replyCount || 0) + 1;

    // Log the injection to command_history with its source. Commands typed by the
    // user get auto-logged via session.onCommand — here we log the raw write so
    // non-newline-terminated injections and agent-to-agent traffic are visible.
    const effectiveSource = source || 'user';
    if (db) {
      try {
        const snippet = fromSessionId ? `from:${fromSessionId}` : null;
        logCommand(db, session.id, text.slice(0, 500), snippet, effectiveSource);
      } catch (err) {
        console.error('[db] logCommand (input endpoint) failed:', err);
      }
    }

    res.json({ ok: true, bytes: normalized.length, replyCount: session.meta.replyCount });
  });

  // POST /api/sessions/:id/resize - resize terminal
  app.post('/api/sessions/:id/resize', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session?.pty) return res.status(404).json({ error: 'Session not found' });

    const { cols, rows } = req.body;
    try {
      session.pty.resize(cols || 120, rows || 30);
      res.json({ ok: true, cols, rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/history - command history for session
  app.get('/api/sessions/:id/history', (req, res) => {
    if (!db) return res.json([]);
    res.json(getSessionHistory(db, req.params.id));
  });

  // GET /api/themes - available terminal themes
  app.get('/api/themes', (req, res) => {
    const list = Object.entries(themes).map(([id, t]) => ({
      id,
      label: t.label,
      category: t.category,
      background: t.theme.background,
      foreground: t.theme.foreground,
      theme: t.theme
    }));
    res.json(list);
  });

  // GET /api/themes/:id - full theme data
  app.get('/api/themes/:id', (req, res) => {
    const t = themes[req.params.id];
    if (!t) return res.status(404).json({ error: 'Theme not found' });
    res.json(t);
  });

  // GET /api/config - current config (sanitized)
  app.get('/api/config', (req, res) => {
    res.json({
      projects: config.projects || {},
      defaultTheme: config.defaultTheme,
      ragEnabled: rag.enabled,
      aiQueryAvailable: !!(config.rag?.supabaseUrl && config.rag?.supabaseKey && config.rag?.openaiApiKey),
      statusColors
    });
  });

  // GET /api/status - global status (control room data)
  app.get('/api/status', (req, res) => {
    const allSessions = sessions.getAll();
    const byProject = {};
    const byStatus = {};
    const byType = {};

    for (const s of allSessions) {
      const proj = s.meta.project || 'untagged';
      byProject[proj] = (byProject[proj] || 0) + 1;
      byStatus[s.meta.status] = (byStatus[s.meta.status] || 0) + 1;
      byType[s.meta.type] = (byType[s.meta.type] || 0) + 1;
    }

    res.json({
      totalSessions: allSessions.length,
      byProject,
      byStatus,
      byType,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      ragEnabled: rag.enabled
    });
  });

  // GET /api/rag/events - recent RAG events from local buffer
  app.get('/api/rag/events', (req, res) => {
    if (!db) return res.json([]);
    const limit = parseInt(req.query.limit) || 50;
    const rows = db.prepare(
      'SELECT * FROM rag_events ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
    res.json(rows.map(r => ({ ...r, payload: JSON.parse(r.payload) })));
  });

  // GET /api/rag/status - RAG system status
  app.get('/api/rag/status', (req, res) => {
    if (!db) return res.json({ enabled: false, localEvents: 0, unsynced: 0 });
    const total = db.prepare('SELECT COUNT(*) as n FROM rag_events').get().n;
    const unsynced = db.prepare('SELECT COUNT(*) as n FROM rag_events WHERE synced = 0').get().n;
    res.json({
      enabled: rag.enabled,
      supabaseConfigured: !!(rag.supabaseUrl),
      localEvents: total,
      unsynced,
      tables: rag.tables
    });
  });

  // POST /api/ai/query - query Engram memory via the bridge (direct|webhook|mcp)
  app.post('/api/ai/query', async (req, res) => {
    let { question, sessionId, project } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    let searchAll = false;
    if (question.toLowerCase().startsWith('all:')) {
      question = question.substring(4).trim();
      searchAll = true;
    }

    const session = sessionId ? sessions.get(sessionId) : null;
    const sessionContext = session ? {
      type: session.meta.type,
      project: session.meta.project,
      lastCommands: session.meta.lastCommands.slice(-5),
      status: session.meta.status
    } : null;

    try {
      const { memories, total } = await engramBridge.queryEngram({
        question,
        project,
        searchAll,
        sessionContext
      });

      res.json({
        question,
        memories: memories.slice(0, 5).map((m) => ({
          content: m.content?.substring(0, 500),
          source_type: m.source_type,
          project: m.project,
          similarity: m.similarity,
          created_at: m.created_at
        })),
        sessionContext,
        total
      });
    } catch (err) {
      console.error('[engram-bridge] query failed:', err.message);
      // Config-shaped errors are 503, everything else 502
      const msg = err.message || 'Query failed';
      const status = /not configured|OPENAI_API_KEY/i.test(msg) ? 503 : 502;
      res.status(status).json({ error: msg });
    }
  });

  // ==================== WebSocket ====================

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('session');

    if (!sessionId) {
      ws.close(4000, 'Missing session parameter');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      ws.close(4001, 'Session not found');
      return;
    }

    // Bind WebSocket to session
    session.ws = ws;
    console.log(`[ws] Client connected to session ${sessionId}`);

    // Send initial metadata
    ws.send(JSON.stringify({
      type: 'meta',
      session: session.toJSON()
    }));

    // Client → PTY
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);

        switch (parsed.type) {
          case 'input':
            if (session.pty) {
              session.pty.write(parsed.data);
              session.trackInput(parsed.data);
            }
            break;

          case 'resize':
            if (session.pty) {
              session.pty.resize(parsed.cols || 120, parsed.rows || 30);
            }
            break;

          case 'meta':
            // Client requesting metadata refresh
            ws.send(JSON.stringify({
              type: 'meta',
              session: session.toJSON()
            }));
            break;
        }
      } catch (err) { console.error('[ws] message handler error:', err); }
    });

    ws.on('close', () => {
      console.log(`[ws] Client disconnected from session ${sessionId}`);
      if (session.ws === ws) {
        session.ws = null;
      }
    });
  });

  // Periodic metadata broadcast (control room live updates)
  setInterval(() => {
    const allMeta = sessions.getAll();
    const payload = JSON.stringify({ type: 'status_broadcast', sessions: allMeta });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try { client.send(payload); } catch (err) { console.error('[ws] broadcast send failed:', err); }
      }
    });
  }, 2000);

  // Fallback route → serve index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  return { app, server, wss, sessions, rag, db };
}

// Start server
if (require.main === module) {
  // Minimal flag parsing for direct-invocation users (the CLI wrapper has its own).
  const argv = process.argv.slice(2);
  if (argv.includes('--session-logs')) {
    process.env.TERMDECK_SESSION_LOGS = '1';
  }

  const config = loadConfig();
  if (process.env.TERMDECK_SESSION_LOGS === '1') {
    config.sessionLogs = { ...(config.sessionLogs || {}), enabled: true };
  }

  const { server } = createServer(config);
  const port = config.port || 3000;
  const host = config.host || '127.0.0.1';

  server.listen(port, host, () => {
    console.log(`\n  TermDeck running at http://${host}:${port}\n`);
    console.log(`  Terminals:  0 active`);
    console.log(`  Database:   ${Database ? 'SQLite OK' : 'unavailable'}`);
    console.log(`  PTY:        ${pty ? 'node-pty OK' : 'unavailable (install node-pty)'}`);
    console.log(`  RAG:        ${config.rag?.supabaseUrl ? 'configured' : 'not configured'}`);
    console.log(`  Session logs: ${config.sessionLogs?.enabled ? '~/.termdeck/sessions/ (on exit)' : 'off'}`);
    console.log(`\n  WARNING: TermDeck binds to ${host} only.`);
    console.log(`  Do NOT expose this to the network without authentication.`);
    console.log(`  Terminal sessions have full shell access.\n`);
  });
}

module.exports = { createServer, loadConfig };
