'use strict';

// Sprint 57 T2 (F-T2-2 + F-T2-6) — single source of truth for the RAG mode
// enum surfaced across /api/config, /api/rag/status, and /api/status.
//
// Sprint 55's T2 sweep found the three endpoints exposed inconsistent
// shapes: /api/config carried four booleans (ragEnabled, ragConfigEnabled,
// ragSupabaseConfigured, aiQueryAvailable) and the dashboard derived a
// 3-state label (`RAG · on` / `pending` / `mcp-only`) from them, while
// /api/rag/status and /api/status only exposed a flat `enabled` boolean —
// programmatic clients (CLI, MCP wrapper, CI smoke tests, future Telegram
// bot) couldn't distinguish "MCP-only by user intent" from "intent on but
// Supabase missing." Every client re-derived its own mode rule, which is
// the cross-endpoint inconsistency Sprint 57 closes.
//
// Direction (a) per orchestrator GREEN-LIGHT 2026-05-05 14:16 ET: keep the
// existing booleans on /api/config (backward compat), add a single derived
// `ragMode` enum on all three endpoints. The enum is computed once via
// `deriveRagMode(rag, config)` and consumed directly by the dashboard's
// `updateRagIndicator()`.
//
// Returns:
//   "off"     — user opted into MCP-only mode (intent=false). Memory tools
//               still work via MCP; the in-CLI `termdeck flashback`
//               command + hybrid search are disabled. UI label "RAG · mcp-only".
//   "pending" — user enabled RAG in config.yaml but the runtime isn't
//               actually serving (Supabase missing/unreachable at boot,
//               or otherwise not effective). UI label "RAG · pending".
//   "active"  — RAG fully operational (effective=true). UI label "RAG · on".
//
// Forward-compat: future fourth states (e.g. "degraded" for partial
// Supabase failure modes) MUST extend this union, not replace it. New
// endpoints should consume `ragMode` rather than re-derive from booleans
// — that's the whole point of the helper.
function deriveRagMode(rag, config) {
  const effective = !!(rag && rag.enabled);
  const intent = !!(config && config.rag && config.rag.enabled);
  if (effective) return 'active';
  if (intent) return 'pending';
  return 'off';
}

module.exports = { deriveRagMode };
