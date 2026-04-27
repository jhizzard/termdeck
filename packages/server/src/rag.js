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
    this.openaiApiKey = config.rag?.openaiApiKey || process.env.OPENAI_API_KEY || null;
    this.enabled = !!(config.rag?.enabled && this.supabaseUrl && this.supabaseKey);
    this.syncInterval = config.rag?.syncIntervalMs || 10000;
    this._syncTimer = null;

    // Sprint 38 / T3 — graph-aware recall toggle. When true, the recall()
    // method routes through the new memory_recall_graph RPC (vector seed +
    // graph expansion + combined re-rank). When false (default), it
    // delegates to the existing mnestra-bridge vector path. The half-life
    // mirrors the SQL function default (30 days) but is exposed here so
    // callers can override it without re-deploying the migration.
    this.graphRecall = config.rag?.graphRecall === true;
    this.graphRecallDepth = Math.max(1, Math.min(5, config.rag?.graphRecallDepth ?? 2));
    this.graphRecallK = Math.max(1, Math.min(50, config.rag?.graphRecallK ?? 10));
    this.graphRecallRecencyHalflifeDays = config.rag?.graphRecallRecencyHalflifeDays ?? 30;

    // Bridge reference for the vector-only recall path. Wired in by index.js
    // after the bridge is created so we avoid duplicating the embed → RPC
    // plumbing here. Optional: if absent, recall() with graphRecall=false
    // throws a helpful error instead of silently returning empty.
    this._bridge = null;

    // Table configuration matching Josh's multi-layer schema
    this.tables = {
      sessionMemory: config.rag?.tables?.session || 'mnestra_session_memory',
      projectMemory: config.rag?.tables?.project || 'mnestra_project_memory',
      developerMemory: config.rag?.tables?.developer || 'mnestra_developer_memory',
      commandLog: config.rag?.tables?.commands || 'mnestra_commands'
    };

    // Circuit breaker: track consecutive 404s per table name.
    // After 3 consecutive 404s, open the breaker. The breaker auto-transitions
    // to half-open after 5 minutes, allowing one retry attempt. A successful
    // retry fully resets the breaker; a failed retry re-opens it for another
    // 5-minute backoff window.
    this._circuitBreaker = new Map(); // table -> { count, open, openedAt, halfOpen }
    this._halfOpenDelayMs = 5 * 60 * 1000;

    // Status-change debounce: rapid `active ↔ thinking` cycling from busy
    // Claude Code workers (4+1 sprint lanes) produces dozens of status_changed
    // events per second. Untreated, this floods stdout and the outbox; on
    // 2026-04-27 it contributed to two server-kill incidents during Sprint 36.
    // Drop intra-second status edges; let error transitions always pass.
    this._statusWriteAt = new Map(); // sessionId -> last write timestamp (ms)
    this._statusDebounceMs = 1000;

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
  // Returns { tag, source } so callers can audit which resolution path fired —
  // explicit (session.meta.project), cwd (cwd matched a config.projects entry),
  // fallback (cwd basename), or null (no cwd, no config). Sprint 34: the
  // chopin-nashville mis-tag came from an out-of-repo writer, but source
  // attribution here makes any future TermDeck-side regression visible in logs.
  _resolveProjectAttribution(session) {
    if (session.meta.project) return { tag: session.meta.project, source: 'explicit' };
    const tag = resolveProjectName(session.meta.cwd, this.config);
    if (!tag) return { tag: null, source: 'none' };
    const cwdResolved = session.meta.cwd && path.resolve(String(session.meta.cwd).replace(/^~/, os.homedir()));
    const matchedConfig = !!cwdResolved && Object.values((this.config && this.config.projects) || {}).some((def) => {
      if (!def || typeof def.path !== 'string') return false;
      const p = path.resolve(def.path.replace(/^~/, os.homedir()));
      return cwdResolved === p || cwdResolved.startsWith(p + path.sep);
    });
    return { tag, source: matchedConfig ? 'cwd' : 'fallback' };
  }

  _projectFor(session) {
    return this._resolveProjectAttribution(session).tag;
  }

  // Single attribution + observability point for session events. Logs once per
  // record() so future drift in the project-resolution chain (e.g. a writer
  // that bypasses _projectFor and stamps a raw path segment) is visible in
  // stdout. Cheap: ~one log line per RAG event, off the hot path.
  _recordForSession(session, eventType, payload) {
    const { tag, source } = this._resolveProjectAttribution(session);
    console.log(`[rag] write project=${tag ?? 'null'} source=${source} session=${session.id} event=${eventType}`);
    this.record(session.id, eventType, payload, tag);
  }

  // Event types to record
  onSessionCreated(session) {
    this._recordForSession(session, 'session_created', {
      type: session.meta.type,
      command: session.meta.command,
      cwd: session.meta.cwd,
      reason: session.meta.reason
    });
  }

  onCommandExecuted(session, command, outputSnippet) {
    this._recordForSession(session, 'command_executed', {
      command,
      output_snippet: outputSnippet?.slice(0, 500), // Truncate for storage
      type: session.meta.type
    });
  }

  onStatusChanged(session, oldStatus, newStatus) {
    // Always pass through error transitions — those carry signal worth ingesting
    // every time. Debounce only the active ↔ thinking churn that floods the log
    // when a worker cycles tool calls rapidly.
    const isError = newStatus === 'errored' || oldStatus === 'errored';
    if (!isError) {
      const now = Date.now();
      const last = this._statusWriteAt.get(session.id) || 0;
      if (now - last < this._statusDebounceMs) return;
      this._statusWriteAt.set(session.id, now);
    }
    this._recordForSession(session, 'status_changed', {
      from: oldStatus,
      to: newStatus,
      detail: session.meta.statusDetail,
      type: session.meta.type
    });
  }

  onSessionEnded(session) {
    this._recordForSession(session, 'session_ended', {
      type: session.meta.type,
      duration_ms: Date.now() - new Date(session.meta.createdAt).getTime(),
      command_count: session.meta.lastCommands.length,
      exit_code: session.meta.exitCode
    });
  }

  onFileEdited(session, filepath, editType) {
    this._recordForSession(session, 'file_edited', {
      filepath,
      edit_type: editType,
      type: session.meta.type
    });
  }

  // Circuit breaker check — returns true if pushes to this table are disabled.
  // Has a side effect: when the 5-minute half-open window has elapsed, flips
  // the breaker to half-open and permits one retry attempt through.
  _isCircuitOpen(table) {
    const state = this._circuitBreaker.get(table);
    if (!state || !state.open) return false;
    if (state.halfOpen) return true; // retry already in flight — block concurrent pushes

    const elapsed = Date.now() - (state.openedAt || 0);
    if (elapsed >= this._halfOpenDelayMs) {
      state.halfOpen = true;
      console.log(`[rag] circuit breaker half-open for ${table}, retrying`);
      return false; // allow one attempt through
    }
    return true;
  }

  // Record a 404 for a table; opens the breaker after 3 consecutive hits
  _record404(table) {
    let state = this._circuitBreaker.get(table);
    if (!state) {
      state = { count: 0, open: false, openedAt: null, halfOpen: false };
      this._circuitBreaker.set(table, state);
    }
    state.count += 1;
    if (state.count >= 3 && !state.open) {
      state.open = true;
      state.openedAt = Date.now();
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
      const state = this._circuitBreaker.get(table);
      if (state && state.halfOpen) {
        // Half-open retry failed — re-open for another 5-minute backoff window
        state.halfOpen = false;
        state.openedAt = Date.now();
        console.warn(`[rag] circuit breaker re-opened for ${table} after half-open retry failed`);
      } else if (!state || !state.open) {
        // Log at warn (not error) to reduce noise — the circuit breaker handles persistence
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
      this._syncTimer = null;
    }
    this._statusWriteAt.clear();
  }

  // Sprint 38 / T3 — wire the mnestra-bridge so vector-only recall delegates
  // to the existing direct/webhook/mcp path instead of duplicating the embed
  // pipeline here.
  setBridge(bridge) {
    this._bridge = bridge || null;
  }

  // Sprint 38 / T3 — graph-aware recall entry point. Returns the same shape
  // as bridge.queryMnestra: { memories: [...], total }. Routes through the
  // memory_recall_graph RPC when graphRecall is enabled, otherwise falls
  // back to the bridge's vector path.
  //
  // options: { project?, searchAll?, sessionContext?, cwd?, depth?, k? }
  async recall(query, options = {}) {
    if (this.graphRecall) {
      return this._recallViaGraph(query, options);
    }
    return this._recallViaVectorOnly(query, options);
  }

  async _recallViaVectorOnly(query, options) {
    if (!this._bridge) {
      throw new Error('RAGIntegration.recall: no bridge wired (call setBridge first)');
    }
    return this._bridge.queryMnestra({
      question: query,
      project: options.project,
      searchAll: !!options.searchAll,
      sessionContext: options.sessionContext,
      cwd: options.cwd
    });
  }

  // Direct REST call to memory_recall_graph (migration 010). Mirrors the
  // bridge.queryDirect pattern: OpenAI embedding → Supabase RPC. Stays in
  // rag.js so callers don't need to know which mnestra mode the bridge is
  // using; graph recall is always direct-against-Postgres because the RPC
  // doesn't ship as a Mnestra MCP tool yet (Sprint 38 / T1 wires the
  // related MCP tools — graph recall lives here for now).
  async _recallViaGraph(query, options) {
    if (!this.supabaseUrl || !this.supabaseKey) {
      throw new Error('graphRecall: supabaseUrl/supabaseKey not configured');
    }
    if (!this.openaiApiKey) {
      throw new Error('graphRecall: OPENAI_API_KEY not configured');
    }

    const project = options.searchAll ? null : (options.project || null);
    const depth = options.depth ?? this.graphRecallDepth;
    const k = options.k ?? this.graphRecallK;

    const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-embedding-3-large',
        input: query,
        dimensions: 1536
      })
    });
    if (!embeddingRes.ok) {
      const err = await embeddingRes.text();
      console.error('[rag:graph] embedding failed:', err);
      throw new Error('graphRecall: embedding generation failed');
    }
    const embeddingData = await embeddingRes.json();
    const embedding = embeddingData.data[0].embedding;

    console.log(`[rag] using graph recall path project=${project ?? 'ALL'} depth=${depth} k=${k}`);

    const rpcBody = {
      query_embedding: `[${embedding.join(',')}]`,
      project_filter: project,
      max_depth: depth,
      k
    };
    const rpcRes = await fetch(`${this.supabaseUrl}/rest/v1/rpc/memory_recall_graph`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': this.supabaseKey,
        'Authorization': `Bearer ${this.supabaseKey}`
      },
      body: JSON.stringify(rpcBody)
    });
    if (!rpcRes.ok) {
      const err = await rpcRes.text();
      console.error(`[rag:graph] RPC failed ${rpcRes.status}:`, err);
      throw new Error(`graphRecall: memory_recall_graph RPC failed (${rpcRes.status})`);
    }
    const rows = await rpcRes.json();
    return {
      memories: rows.map((m) => ({
        content: m.content,
        // graph recall doesn't return source_type; preserve the bridge's
        // shape by returning null so consumers don't crash on chip render.
        source_type: m.source_type ?? null,
        project: m.project,
        // The bridge consumers read `similarity`; pass final_score so they
        // see the combined (vector × edge × recency) signal as the badge.
        // Also expose the underlying scores for callers that want to split
        // them out (graph viz, debugging).
        similarity: m.final_score,
        depth: m.depth,
        vector_score: m.vector_score,
        edge_weight: m.edge_weight,
        recency_score: m.recency_score,
        path: m.path,
        // memory_recall_graph doesn't return created_at — depth-N neighbors
        // come from the graph walk, not a direct timestamp pull. Caller can
        // re-fetch via memory_get if they need it.
        created_at: m.created_at ?? null
      })),
      total: rows.length
    };
  }

  // Live-toggle for the dashboard RAG settings panel (Sprint 36 T3 Deliverable A).
  // Re-evaluates eligibility — flipping `enabled: true` without configured
  // Supabase creds is a no-op so the live integration never claims to be on
  // when it can't actually push. Returns the resolved effective flag.
  setEnabled(value) {
    const desired = !!value;
    if (this.config && this.config.rag) {
      this.config.rag.enabled = desired;
    }
    const effective = !!(desired && this.supabaseUrl && this.supabaseKey);
    if (effective === this.enabled) return effective;
    this.enabled = effective;
    if (effective) {
      if (!this._syncTimer) this._startSync();
    } else {
      if (this._syncTimer) {
        clearInterval(this._syncTimer);
        this._syncTimer = null;
      }
    }
    return effective;
  }
}

module.exports = { RAGIntegration, resolveProjectName };
