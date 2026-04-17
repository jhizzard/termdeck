// RAG integration - multi-layer memory system
// Layers: session → project → developer (cross-project)
// Syncs to Supabase tables with configurable namespaces

const path = require('path');
const os = require('os');
const { logRagEvent, getUnsyncedRagEvents, markRagEventsSynced } = require('./database');

// Resolve a working directory to a canonical project name defined in
// ~/.termdeck/config.yaml. Sessions without an explicit `project` field
// otherwise end up tagged with raw directory segments (e.g. "chopin-nashville"
// from ~/Documents/Graciella/ChopinNashville/...), which pollutes Mnestra
// memory tagging across unrelated repos that share an ancestor folder.
//
// Strategy: walk config.projects and pick the entry whose resolved path is the
// longest prefix of cwd (supports subdirectories of a registered project).
// Fallback is the directory basename, which is still better than an arbitrary
// mid-path segment.
function resolveProjectName(cwd, config) {
  if (!cwd) return null;

  const cwdResolved = path.resolve(String(cwd).replace(/^~/, os.homedir()));
  const projects = (config && config.projects) || {};

  const entries = Object.entries(projects)
    .map(([name, def]) => {
      const rawPath = def && def.path;
      if (!rawPath || typeof rawPath !== 'string') return null;
      const resolved = path.resolve(rawPath.replace(/^~/, os.homedir()));
      return { name, resolved };
    })
    .filter(Boolean)
    .sort((a, b) => b.resolved.length - a.resolved.length);

  for (const { name, resolved } of entries) {
    if (cwdResolved === resolved) return name;
    if (cwdResolved.startsWith(resolved + path.sep)) return name;
  }

  return path.basename(cwdResolved) || null;
}

class RAGIntegration {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.supabaseUrl = config.rag?.supabaseUrl || null;
    this.supabaseKey = config.rag?.supabaseKey || null;
    this.enabled = !!(config.rag?.enabled && this.supabaseUrl && this.supabaseKey);
    this.syncInterval = config.rag?.syncIntervalMs || 10000;
    this._syncTimer = null;

    // Table configuration matching Josh's multi-layer schema
    this.tables = {
      sessionMemory: config.rag?.tables?.session || 'mnestra_session_memory',
      projectMemory: config.rag?.tables?.project || 'mnestra_project_memory',
      developerMemory: config.rag?.tables?.developer || 'mnestra_developer_memory',
      commandLog: config.rag?.tables?.commands || 'mnestra_commands'
    };

    // Circuit breaker: track consecutive 404s per table name.
    // After 3 consecutive 404s, disable pushes to that table until restart.
    this._circuitBreaker = new Map(); // table -> { count: number, open: boolean }

    if (this.enabled) {
      this._startSync();
    }
  }

  // Record an event locally (always works, even offline)
  record(sessionId, eventType, payload, project) {
    if (!this.db) return;

    logRagEvent(this.db, sessionId, eventType, payload, project);

    // Also attempt immediate push if enabled
    if (this.enabled) {
      this._pushEvent({
        session_id: sessionId,
        event_type: eventType,
        payload,
        project,
        timestamp: new Date().toISOString()
      }).catch((err) => {
        // Non-fatal — the periodic sync loop will retry this event on its next
        // tick because it's still marked unsynced in the outbox. Log at debug
        // level so the first failure is visible in verbose logs without
        // flooding stdout on routine transient errors.
        console.debug('[mnestra] immediate push failed (sync loop will retry):', err && err.message);
      });
    }
  }

  // Canonical project tag for a session. Prefers the explicit config.yaml name
  // (set at session creation), falls back to cwd → config.projects resolution.
  _projectFor(session) {
    if (session.meta.project) return session.meta.project;
    return resolveProjectName(session.meta.cwd, this.config);
  }

  // Event types to record
  onSessionCreated(session) {
    this.record(session.id, 'session_created', {
      type: session.meta.type,
      command: session.meta.command,
      cwd: session.meta.cwd,
      reason: session.meta.reason
    }, this._projectFor(session));
  }

  onCommandExecuted(session, command, outputSnippet) {
    this.record(session.id, 'command_executed', {
      command,
      output_snippet: outputSnippet?.slice(0, 500), // Truncate for storage
      type: session.meta.type
    }, this._projectFor(session));
  }

  onStatusChanged(session, oldStatus, newStatus) {
    this.record(session.id, 'status_changed', {
      from: oldStatus,
      to: newStatus,
      detail: session.meta.statusDetail,
      type: session.meta.type
    }, this._projectFor(session));
  }

  onSessionEnded(session) {
    this.record(session.id, 'session_ended', {
      type: session.meta.type,
      duration_ms: Date.now() - new Date(session.meta.createdAt).getTime(),
      command_count: session.meta.lastCommands.length,
      exit_code: session.meta.exitCode
    }, this._projectFor(session));
  }

  onFileEdited(session, filepath, editType) {
    this.record(session.id, 'file_edited', {
      filepath,
      edit_type: editType,
      type: session.meta.type
    }, this._projectFor(session));
  }

  // Circuit breaker check — returns true if pushes to this table are disabled
  _isCircuitOpen(table) {
    const state = this._circuitBreaker.get(table);
    return !!(state && state.open);
  }

  // Record a 404 for a table; opens the breaker after 3 consecutive hits
  _record404(table) {
    let state = this._circuitBreaker.get(table);
    if (!state) {
      state = { count: 0, open: false };
      this._circuitBreaker.set(table, state);
    }
    state.count += 1;
    if (state.count >= 3 && !state.open) {
      state.open = true;
      console.warn(`[rag] circuit breaker open for ${table} — disabling pushes (table may not exist in Supabase)`);
    }
  }

  // Reset the breaker for a table on successful push
  _resetCircuit(table) {
    if (this._circuitBreaker.has(table)) {
      this._circuitBreaker.delete(table);
    }
  }

  // Push a single event to Supabase
  async _pushEvent(event) {
    if (!this.enabled) return;

    const layer = this._determineLayer(event);
    const table = this.tables[layer];

    // Skip if circuit breaker is open for this table
    if (this._isCircuitOpen(table)) return;

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.supabaseKey,
          'Authorization': `Bearer ${this.supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          session_id: event.session_id,
          event_type: event.event_type,
          payload: typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload),
          project: event.project,
          timestamp: event.timestamp,
          developer_id: this.config.rag?.developerId || 'default'
        })
      });

      if (!response.ok) {
        if (response.status === 404) {
          this._record404(table);
        }
        throw new Error(`Supabase responded ${response.status}`);
      }

      // Success — reset any accumulated 404 count for this table
      this._resetCircuit(table);
    } catch (err) {
      // Log at warn (not error) to reduce noise — the circuit breaker handles persistence
      if (!this._isCircuitOpen(table)) {
        console.warn('[rag] push to', table, 'failed:', err.message);
      }
      throw err; // Propagate to caller so sync loop knows this event failed
    }
  }

  // Determine which memory layer an event belongs to
  _determineLayer(event) {
    // File edits and significant commands → project memory (shared across sessions)
    if (event.event_type === 'file_edited' || event.event_type === 'command_executed') {
      return 'projectMemory';
    }
    // Session lifecycle → session memory
    if (event.event_type === 'session_created' || event.event_type === 'session_ended') {
      return 'sessionMemory';
    }
    // Status changes, errors → developer memory (cross-project patterns)
    return 'developerMemory';
  }

  // Periodic sync of unsynced events
  _startSync() {
    this._syncTimer = setInterval(async () => {
      try {
        const events = getUnsyncedRagEvents(this.db);
        if (events.length === 0) return;

        const synced = [];
        for (const event of events) {
          try {
            await this._pushEvent({
              ...event,
              payload: JSON.parse(event.payload)
            });
            synced.push(event.id);
          } catch (err) {
            // Don't print full stack traces for expected 404s (missing tables)
            console.debug('[rag] sync push failed for event', event.id + ':', err.message);
            break; // Stop on first failure, retry next cycle
          }
        }

        if (synced.length > 0) {
          markRagEventsSynced(this.db, synced);
        }
      } catch (err) {
        console.error('[mnestra] Sync cycle error:', err.message);
      }
    }, this.syncInterval);
  }

  // Query cross-project context (for the prompt bar AI features)
  async queryContext(query, options = {}) {
    if (!this.enabled) return [];

    const table = options.project
      ? this.tables.projectMemory
      : this.tables.developerMemory;

    try {
      // Uses Supabase's full-text search or pgvector if configured
      const params = new URLSearchParams({
        select: '*',
        order: 'timestamp.desc',
        limit: options.limit || 20
      });

      if (options.project) {
        params.append('project', `eq.${options.project}`);
      }

      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/${table}?${params}`,
        {
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.supabaseKey}`
          }
        }
      );

      if (!response.ok) return [];
      return await response.json();
    } catch (err) {
      console.error('[rag] queryContext failed:', err);
      return [];
    }
  }

  stop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
    }
  }
}

module.exports = { RAGIntegration, resolveProjectName };
