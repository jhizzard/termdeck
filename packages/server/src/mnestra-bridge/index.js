// Mnestra bridge — routes TermDeck memory queries through one of three backends:
//   - direct:  talk to Supabase + OpenAI from the server (pre-bridge behavior)
//   - webhook: POST to Mnestra's HTTP webhook server (T3.1) at rag.mnestraWebhookUrl
//   - mcp:     spawn the @jhizzard/mnestra binary and talk JSON-RPC over stdio
//
// All three modes return the same shape:
//   { memories: Array<{ id, content, source_type, project, similarity,
//                       semantic_similarity, created_at }>, total }
//
// Sprint 82 T2 added `id` and `semantic_similarity` to that contract:
//   • `id` — the memory's uuid. memory_hybrid_search has always returned it
//     (032:169) but the mappers dropped it, so `top_hit_id` was written NULL
//     on every flashback_events row and the Sprint 57 dismissal blacklist
//     matched nothing. The feature existed on paper only.
//   • `semantic_similarity` — raw cosine, migration 033's absolute signal.
//     Normalized to null when the store predates 033, which is the
//     feature-detection signal every consumer keys off. NEVER conflate it
//     with `similarity`: that field is the ordinal RRF composite (ceiling
//     ~0.074) and is not a percentage of anything.
//
// Errors are thrown as plain Error objects; the caller maps them to HTTP responses.

const { spawn } = require('child_process');
const { resolveProjectName } = require('../rag');
const flashbackDiag = require('../flashback-diag');

// Normalizes one row from any of the three backends into the bridge's
// public memory shape. Kept in one place so `direct`, `webhook` and `mcp`
// cannot drift on which fields survive the hop.
function mapMemoryRow(m) {
  const sem = (m && typeof m.semantic_similarity === 'number'
    && Number.isFinite(m.semantic_similarity))
    ? m.semantic_similarity
    : null;
  return {
    id: (m && m.id) || null,
    content: m.content,
    source_type: m.source_type,
    project: m.project,
    // memory_hybrid_search returns `score`, not `similarity`. This stays the
    // ORDINAL composite — see the header note; it must not be rendered as a
    // percentage anywhere.
    similarity: m.similarity ?? m.score ?? null,
    semantic_similarity: sem,
    created_at: m.created_at
  };
}

function createBridge(config) {
  const mode = config.rag?.mnestraMode || 'direct';
  const state = {
    mcpChild: null,
    mcpQueue: [],
    mcpNextId: 1,
    mcpBuffer: '',
    // Sprint 82 T2 — tri-state capability cache for migration 033's
    // p_decay_profile arg in DIRECT mode. null = unknown (probe on next
    // call), true = the store accepted it, false = pre-033 store, stop
    // sending it. See the PostgREST overload-resolution note in queryDirect
    // for why this must be a probe rather than an unconditional send.
    decayProfileSupported: null,
  };

  async function queryDirect({ question, project, searchAll, decayProfile }) {
    const supabaseUrl = config.rag?.supabaseUrl;
    const supabaseKey = config.rag?.supabaseKey;
    const openaiKey = config.rag?.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('RAG not configured — add supabaseUrl and supabaseKey to ~/.termdeck/config.yaml');
    }
    if (!openaiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-embedding-3-large',
        input: question,
        dimensions: 1536
      })
    });
    if (!embeddingRes.ok) {
      const err = await embeddingRes.text();
      console.error('[mnestra-bridge:direct] embedding failed:', err);
      throw new Error('Embedding generation failed');
    }
    const embeddingData = await embeddingRes.json();
    const embedding = embeddingData.data[0].embedding;

    // NOTE: memory_hybrid_search (migrations/004) accepts exactly 8 named params:
    //   query_text, query_embedding, match_count, full_text_weight,
    //   semantic_weight, rrf_k, filter_project, filter_source_type.
    // PostgREST matches RPC functions by the set of JSON keys in the body — any
    // extra key (e.g. recency_weight, decay_days) makes it fail to resolve the
    // overload and return 404 "Could not find the function". That was silently
    // killing every Flashback query for 15 sprints.
    //
    // Sprint 82 T2: migration 033 adds an optional `p_decay_profile`, and that
    // 404 trap is exactly why it cannot just be added to the body — against a
    // pre-033 store an unconditional extra key re-creates the 15-sprint
    // outage verbatim. So the key is sent optimistically and, on the specific
    // "could not find the function" 404, retried once without it while the
    // verdict is cached on the bridge instance. Post-033 stores pay nothing;
    // pre-033 stores pay one extra round-trip, once, ever.
    const baseBody = {
      query_text: question,
      query_embedding: `[${embedding.join(',')}]`,
      match_count: 10,
      full_text_weight: 1.0,
      semantic_weight: 1.0,
      rrf_k: 60,
      filter_project: searchAll ? null : (project || null),
      filter_source_type: null
    };
    const wantsProfile = !!decayProfile && state.decayProfileSupported !== false;
    const rpcBody = wantsProfile
      ? { ...baseBody, p_decay_profile: decayProfile }
      : baseBody;

    console.log(`[flashback] direct RPC → memory_hybrid_search project=${rpcBody.filter_project ?? 'ALL'} profile=${wantsProfile ? decayProfile : 'standard'} q="${question.slice(0, 60)}"`);

    const callRpc = (body) => fetch(`${supabaseUrl}/rest/v1/rpc/memory_hybrid_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify(body)
    });

    let searchRes = await callRpc(rpcBody);
    if (!searchRes.ok) {
      const errText = await searchRes.text();
      // Overload-resolution failure ⇒ this store predates 033. Latch the
      // capability off and retry with the 8-arg body so the flashback still
      // fires (degraded to the 'standard' decay profile, never dropped).
      const isOverloadMiss = searchRes.status === 404
        && /could not find the function/i.test(errText || '');
      if (wantsProfile && isOverloadMiss) {
        state.decayProfileSupported = false;
        console.warn('[mnestra-bridge:direct] p_decay_profile rejected (pre-033 store) — retrying without it; solved-problem decay unavailable until migration 033 lands');
        searchRes = await callRpc(baseBody);
      }
      if (!searchRes.ok) {
        const err = searchRes.bodyUsed ? errText : await searchRes.text();
        console.error(`[flashback] direct RPC failed ${searchRes.status}:`, err);
        console.error('[mnestra-bridge:direct] supabase search failed:', err);
        throw new Error(`Memory search failed (${searchRes.status})`);
      }
    } else if (wantsProfile) {
      state.decayProfileSupported = true;
    }

    const rows = await searchRes.json();
    console.log(`[flashback] direct RPC returned ${rows.length} rows`);
    return {
      memories: rows.map(mapMemoryRow),
      total: rows.length
    };
  }

  async function queryWebhook({ question, project, searchAll, decayProfile }) {
    const url = config.rag?.mnestraWebhookUrl || 'http://localhost:37778/mnestra';
    // mnestra ≥ 0.7.0 fail-closes the webhook: present the shared secret when
    // it's configured (sourced into this process's env from secrets.env).
    // Absent ⇒ no header ⇒ unchanged against a pre-0.7.0 ungated webhook.
    const secret = process.env.MNESTRA_WEBHOOK_SECRET || '';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'x-mnestra-secret': secret } : {})
      },
      body: JSON.stringify({
        op: 'recall',
        question,
        project: searchAll ? null : (project || null),
        min_results: 5,
        // Sprint 82 T2: forward-compat only. Mnestra's webhook `recall` op
        // builds its recall input from a fixed arg list and silently drops
        // keys it doesn't know, so this is INERT today — it becomes live
        // when engram plumbs decay_profile through recall(). Safe to send
        // now (unknown keys don't error, unlike PostgREST's overload
        // resolution in direct mode); do not read it as "webhook mode has
        // solved-problem decay."
        ...(decayProfile ? { decay_profile: decayProfile } : {})
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[mnestra-bridge:webhook] request failed:', err);
      throw new Error(`Mnestra webhook returned ${res.status}`);
    }
    const data = await res.json();
    // Sprint 82 T2: mnestra's webhook responds `{ok, hits, tokens_used, text}`
    // (engram/src/webhook-server.ts, `case 'recall'`) — there is no
    // `memories` key, so the old `data.memories || []` made EVERY webhook-mode
    // flashback resolve to zero hits and log a truthful-looking "0 matches".
    // Both keys are accepted so the bridge works against any mnestra build.
    const rows = data.memories || data.hits || [];
    return {
      memories: rows.map(mapMemoryRow),
      total: rows.length
    };
  }

  function ensureMcpChild() {
    if (state.mcpChild && !state.mcpChild.killed) return state.mcpChild;

    const bin = config.rag?.mnestraBinary || 'mnestra';
    const child = spawn(bin, ['serve', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    state.mcpChild = child;
    state.mcpBuffer = '';

    child.stdout.on('data', (chunk) => {
      state.mcpBuffer += chunk.toString('utf-8');
      let idx;
      while ((idx = state.mcpBuffer.indexOf('\n')) >= 0) {
        const line = state.mcpBuffer.slice(0, idx).trim();
        state.mcpBuffer = state.mcpBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const pending = state.mcpQueue.find((p) => p.id === msg.id);
          if (pending) {
            state.mcpQueue = state.mcpQueue.filter((p) => p !== pending);
            if (msg.error) pending.reject(new Error(msg.error.message || 'Mnestra MCP error'));
            else pending.resolve(msg.result);
          }
        } catch (err) {
          console.error('[mnestra-bridge:mcp] parse error:', err.message, line);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      console.error('[mnestra-bridge:mcp]', chunk.toString('utf-8').trim());
    });

    child.on('exit', (code, signal) => {
      console.warn(`[mnestra-bridge:mcp] child exited (code=${code}, signal=${signal}); will respawn on next call`);
      state.mcpChild = null;
      for (const pending of state.mcpQueue) {
        pending.reject(new Error('Mnestra MCP child exited'));
      }
      state.mcpQueue = [];
    });

    return child;
  }

  function mcpCall(method, params) {
    const child = ensureMcpChild();
    const id = state.mcpNextId++;
    const req = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      state.mcpQueue.push({ id, resolve, reject });
      try {
        child.stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        state.mcpQueue = state.mcpQueue.filter((p) => p.id !== id);
        reject(err);
      }
      // Safety timeout
      setTimeout(() => {
        const pending = state.mcpQueue.find((p) => p.id === id);
        if (pending) {
          state.mcpQueue = state.mcpQueue.filter((p) => p !== pending);
          pending.reject(new Error('Mnestra MCP call timed out'));
        }
      }, 15000);
    });
  }

  async function queryMcp({ question, project, searchAll }) {
    try {
      const result = await mcpCall('tools/call', {
        name: 'memory_recall',
        arguments: {
          query: question,
          project: searchAll ? null : (project || null),
          match_count: 10
        }
      });
      // Sprint 82 T2: mapper unified with direct/webhook so `id` and
      // `semantic_similarity` survive here too. No arg changes — the MCP
      // tool schema may reject unknown properties, and this mode is the
      // least-proven of the three (BACKLOG V5-5); not regressing it beats
      // extending it.
      const rows = (result && (result.memories || result.hits || result.content || [])) || [];
      return {
        memories: rows.map(mapMemoryRow),
        total: rows.length
      };
    } catch (err) {
      // Kill child so it respawns next call
      if (state.mcpChild) {
        try { state.mcpChild.kill(); } catch (err) { /* process may already be dead */ }
        state.mcpChild = null;
      }
      throw err;
    }
  }

  async function queryMnestra({ question, project, searchAll, sessionContext, cwd, sessionId, decayProfile }) {
    // Flashback callers pass the session's project (from config.yaml). If that
    // slot is empty — e.g. a session created without an explicit project — fall
    // back to resolving the session's cwd against config.projects so queries
    // don't leak into unrelated repos via basename collisions.
    let effectiveProject = project;
    let projectSource = project ? 'explicit' : 'none';
    if (!effectiveProject) {
      const ctxCwd = cwd || (sessionContext && sessionContext.cwd);
      if (ctxCwd) {
        effectiveProject = resolveProjectName(ctxCwd, config);
        projectSource = effectiveProject ? 'cwd' : 'none';
      }
    }

    // Sprint 34 observability: every Flashback query announces its project tag
    // and how it was resolved. If the writer chain is ever mis-emitting a tag
    // (as happened pre-v0.7.2 with the `chopin-nashville` regression from the
    // out-of-repo session-end hook), the mismatch surfaces here at query time.
    console.log(`[mnestra-bridge] query project=${effectiveProject ?? 'ALL'} source=${searchAll ? 'searchAll' : projectSource} mode=${mode}`);

    const projectTagInFilter = searchAll ? null : (effectiveProject || null);
    const t0 = Date.now();
    let result;
    let callError;
    try {
      switch (mode) {
        case 'webhook':
          result = await queryWebhook({ question, project: effectiveProject, searchAll, decayProfile });
          break;
        case 'mcp':
          result = await queryMcp({ question, project: effectiveProject, searchAll });
          break;
        case 'direct':
        default:
          result = await queryDirect({ question, project: effectiveProject, searchAll, decayProfile });
          break;
      }
    } catch (err) {
      callError = err;
    }
    const durationMs = Date.now() - t0;

    // Sprint 39 T1 — bridge_query / bridge_result diag events. Emitted at
    // queryMnestra's outer boundary so all three backends (direct, webhook,
    // mcp) flow through one observability point. T3 reads project_tag_in_filter
    // (the tag the bridge SENT to the RPC) and top_3_project_tags (the tags
    // it GOT BACK) to confirm or refute the project-mismatch hypothesis.
    flashbackDiag.log({
      sessionId,
      event: 'bridge_query',
      project_tag_in_filter: projectTagInFilter,
      query_text: typeof question === 'string' ? question.slice(0, 200) : '',
      mode,
      rpc_args: {
        project: projectTagInFilter,
        searchAll: !!searchAll,
        project_source: searchAll ? 'searchAll' : projectSource,
        // Sprint 82 T2 — what the caller ASKED for vs what the store could
        // actually honor. `decay_profile_supported` stays null until a
        // direct-mode probe has resolved it.
        decay_profile: decayProfile || null,
        decay_profile_supported: state.decayProfileSupported,
      },
      duration_ms: durationMs,
    });

    const memories = (result && Array.isArray(result.memories)) ? result.memories : [];
    const tagCounts = {};
    for (const m of memories) {
      const tag = m && m.project != null ? String(m.project) : '(null)';
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    const top3 = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, count]) => ({ tag, count }));

    flashbackDiag.log({
      sessionId,
      event: 'bridge_result',
      result_count: memories.length,
      error_message: callError ? (callError.message || String(callError)) : null,
      top_3_project_tags: top3,
    });

    if (callError) throw callError;
    return result;
  }

  return { mode, queryMnestra };
}

module.exports = { createBridge };
