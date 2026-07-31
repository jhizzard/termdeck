'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Bridge access policy (Sprint 71 / T2; propose carve-out Sprint 76 / T2).
// Together with redact.js these contracts enforce the Bridge invariant:
// "nothing secret egresses, nothing can mutate canonical state, nothing
// un-allowlisted is visible — plus exactly one quarantined proposal channel
// that can only append to memory_inbox."
//
//   assertReadOnly(toolDef)    — throw if a tool declares a write/delete/exec
//                                capability. Belt-and-suspenders: the Bridge
//                                ships only read tools, but a registration-time
//                                guard means a future write tool cannot be
//                                mounted by accident. T1 calls this per tool.
//                                Exact-name exemptions only: WRITE_CHANNEL_TOOLS
//                                (see below) — and only with verified-HONEST
//                                annotations (readOnlyHint:false). Each member
//                                appends to a quarantine via a validating RPC
//                                (memory_inbox for proposals, memory_sessions
//                                for session records); neither can touch
//                                memory_items, so canonical state stays
//                                immutable from this surface.
//   requiresApproval(toolName) — true for terminal-state tools (live local
//                                buffers are more sensitive than curated
//                                memory), true (explicitly) for the proposal
//                                channel (a write crossing the Bridge gets
//                                per-call human approval in the connector UI),
//                                false for memory reads, and FAIL-SAFE true
//                                for anything unrecognized.
//   visiblePanels(allSessions) — DEFAULT-DENY filter to the operator's
//                                project/panel allowlist. T3's panel tools call
//                                it so an un-allowlisted panel is never exposed.
//   loadProposeMap / mapClientToSourceAgent — server-side connector identity:
//                                resolve the OAuth client behind a write to one
//                                of the four *-web source_agent values.
//                                FAIL-CLOSED: unmappable ⇒ the call is
//                                rejected; identity is never caller-supplied
//                                and never defaulted. Sprint 84 adds
//                                TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1
//                                (default OFF) to drop the client_name
//                                heuristic and require an explicit map entry.
//
// Dependency-free (Node built-ins only), matching redact.js — this is on the
// security-critical path and must be trivially testable + supply-chain-inert.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── assertReadOnly ──────────────────────────────────────────────────────────

// Verbs that imply mutation/side-effects. Matched per name-TOKEN (the tool name
// is split on non-alphanumerics), not as a substring, so `panel_status` /
// `recent_activity` / `read_panel` do not false-trip on an embedded fragment.
const MUTATING_VERBS = new Set([
  'write', 'create', 'update', 'upsert', 'insert', 'delete', 'remove', 'destroy',
  'drop', 'truncate', 'exec', 'execute', 'eval', 'run', 'spawn', 'kill',
  'terminate', 'send', 'post', 'put', 'patch', 'mutate', 'modify', 'set',
  'edit', 'append', 'upload', 'push', 'pull', 'revoke', 'grant', 'install',
  'uninstall', 'rename', 'move', 'copy', 'chmod', 'chown', 'sudo', 'reset',
  'restart', 'stop', 'start', 'launch', 'inject', 'poke',
  // Memory/store mutation verbs — protects the no-`memory_remember` /
  // no-`memory_forget` guarantee. A tool named `memory_remember` that lies via
  // `readOnlyHint:true` must STILL be rejected (T4-CODEX); the name heuristic
  // runs unconditionally, it just needed these words.
  'remember', 'forget', 'store', 'save', 'persist', 'commit', 'link', 'unlink',
  'add', 'tag', 'untag', 'clear', 'purge', 'wipe', 'flush', 'archive',
  // Sprint 76: `propose` is a mutating verb too. Any *_propose tool that LIES
  // with readOnlyHint:true is rejected by-token here; the only way to mount a
  // proposal channel is the exact-name WRITE_CHANNEL_TOOLS registry below,
  // which additionally demands HONEST annotations. Needle, not a hole.
  'propose', 'proposal',
  // Sprint 84: same treatment for the session-capture verbs. `memory_session_record`
  // is a write, so a future tool named *_record / *_capture that forgot (or
  // lied about) its hints must be rejected by-token exactly like *_propose.
  'record', 'capture',
]);

// ── WRITE_CHANNEL_TOOLS — the quarantined write channels (S76, S84) ─────────

// Exact tool names allowed to be non-read-only. Membership alone is NOT
// enough: assertReadOnly additionally requires the honest annotation shape
// below, so neither a lying `memory_propose` (readOnlyHint:true) nor a
// destructive impostor (destructiveHint:true) can mount.
//
// Both members write to a QUARANTINE, never to canonical memory:
//   memory_propose (S76)        → memory_inbox (status='pending', invisible to
//                                 every recall path until Rumen promotes).
//   memory_session_record (S84) → memory_sessions, which no recall path reads
//                                 either — it is the Rumen tick's input queue,
//                                 and that tick's synthesis pass is the gate.
// Neither can reach memory_items. Adding a THIRD name here is a trust-boundary
// change, not a refactor: it must terminate in a table recall cannot see.
const WRITE_CHANNEL_TOOLS = new Set(['memory_propose', 'memory_session_record']);

// Wire-compatible alias — server.js consults `policy.PROPOSE_TOOLS` to decide
// which tools keep their honest readOnlyHint:false instead of being stamped
// read-only. Same Set object, so the two can never drift.
const PROPOSE_TOOLS = WRITE_CHANNEL_TOOLS;

// The ONLY annotation shape a PROPOSE_TOOLS member may declare. Honesty is the
// point: readOnlyHint:false because the tool DOES write (to quarantine);
// destructiveHint:false because an INSERT into an inbox destroys nothing;
// idempotentHint:false because each call appends a new proposal;
// openWorldHint:true because it talks to an external system (the webhook).
const PROPOSE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

// True iff the toolDef declares EXACTLY the honest proposal shape (plus an
// optional benign `title`) and none of the top-level destructive aliases.
function isHonestProposeShape(toolDef) {
  if (toolDef.destructive === true || toolDef.mutates === true) return false;
  if (toolDef.readOnly === true) return false; // top-level alias lie
  const ann = toolDef.annotations || toolDef.annotation || {};
  for (const [k, v] of Object.entries(PROPOSE_ANNOTATIONS)) {
    if (ann[k] !== v) return false;
  }
  for (const k of Object.keys(ann)) {
    if (!(k in PROPOSE_ANNOTATIONS) && k !== 'title') return false;
  }
  return true;
}

// assertReadOnly(toolDef) — throws if the tool looks capable of mutation.
// Honors explicit MCP capability hints first, then a name-token heuristic.
// Exactly ONE exemption: a PROPOSE_TOOLS member with verified-honest proposal
// annotations (see isHonestProposeShape) — anything else, including the same
// name with any other annotation shape, still throws.
function assertReadOnly(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') {
    throw new TypeError('assertReadOnly: toolDef must be an object');
  }
  const name = String(toolDef.name || '').trim();
  if (!name) throw new Error('assertReadOnly: tool is missing a name');

  // 0) The quarantined proposal channel (Sprint 76). Exact name + exactly the
  // honest annotation shape, or nothing. A lying readOnlyHint:true here is as
  // fatal as a destructive hint: the carve-out exists precisely so the Bridge
  // never has to lie about a write tool to mount it.
  if (WRITE_CHANNEL_TOOLS.has(name)) {
    if (!isHonestProposeShape(toolDef)) {
      throw new Error(
        `Bridge policy: tool "${name}" is a registered write channel but does not declare the exact honest `
        + 'proposal annotations { readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true }; refusing to mount.',
      );
    }
    return true; // exempt from the read-only rejections below — and ONLY this name+shape
  }

  // 1) Explicit capability signals (MCP tool annotations + a few aliases).
  const ann = toolDef.annotations || toolDef.annotation || {};
  if (ann.readOnlyHint === false || toolDef.readOnly === false) {
    throw new Error(`Bridge policy: tool "${name}" is declared writable (readOnlyHint:false); the Bridge is read-only.`);
  }
  if (ann.destructiveHint === true || toolDef.destructive === true || toolDef.mutates === true) {
    throw new Error(`Bridge policy: tool "${name}" is declared destructive; the Bridge is read-only.`);
  }

  // 2) Name-token heuristic (catches a mutating tool that forgot its hints).
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    const singular = t.replace(/s$/, '');
    if (MUTATING_VERBS.has(t) || MUTATING_VERBS.has(singular)) {
      throw new Error(`Bridge policy: tool "${name}" name implies a mutating capability ("${t}"); the Bridge is read-only.`);
    }
  }
  return true;
}

// ── requiresApproval ────────────────────────────────────────────────────────

// Terminal-state tools surface live LOCAL terminal content — strictly more
// sensitive than already-curated memory — so they require a per-call human
// approval in the connecting client. Memory reads do not.
const TERMINAL_STATE_TOOLS = new Set([
  'list_panels', 'read_panel', 'panel_status', 'recent_activity',
]);
const MEMORY_TOOLS = new Set(['memory_recall', 'memory_search']);

// requiresApproval(toolName) → boolean. Fail-safe: an unrecognized tool name
// returns true, so a newly-added tool defaults to approval-gated until it is
// explicitly classified here.
function requiresApproval(toolName) {
  const n = String(toolName || '').trim();
  if (MEMORY_TOOLS.has(n)) return false;
  if (TERMINAL_STATE_TOOLS.has(n)) return true;
  // The write channels are EXPLICITLY approval-gated (not via the fallthrough):
  // a write crossing the Bridge gets per-call human approval in the connector
  // UI. Ships conservative; relaxing this is an ORCH decision with field data.
  if (WRITE_CHANNEL_TOOLS.has(n)) return true;
  return true; // default-deny
}

// ── connector identity → source_agent (Sprint 76, fail-closed) ──────────────

// The four web-surface source_agent values (engram migration 025 /
// src/types.ts SOURCE_AGENTS — keep in sync; cross-repo import isn't possible
// from this dependency-free module). CLI values (claude/codex/gemini/grok/
// orchestrator) are deliberately NOT representable here: a web connector can
// never mint a CLI identity from this surface, and T1's RPC whitelist rejects
// them again server-side (defense-in-depth).
const WEB_SOURCE_AGENTS = Object.freeze(['claude-web', 'chatgpt-web', 'grok-web', 'gemini-web']);
const WEB_SOURCE_AGENT_SET = new Set(WEB_SOURCE_AGENTS);

// Normalize + validate a candidate map VALUE. Trim/lowercase is operator
// kindness; the exact-match against the four values is the gate — an invalid
// value (typo, CLI value, 'chatgpt-web2') is IGNORED, leaving the client
// unmapped ⇒ the proposal is rejected. An operator mistake can only ever
// fail closed, never mint a wrong identity.
function normalizeWebSourceAgent(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return WEB_SOURCE_AGENT_SET.has(s) ? s : null;
}

// Load the operator's explicit client_id → source_agent map. Sources (file
// first, env wins on conflict — env is the "override" channel):
//   - JSON at TERMDECK_BRIDGE_PROPOSE_FILE, else ~/.termdeck/bridge-propose.json
//       { "clients": { "<client_id>": "claude-web", ... } }
//   - TERMDECK_BRIDGE_PROPOSE_MAP  (comma-separated "client_id=source-agent" pairs)
// Same load pattern as loadAllowlist: absent file/env is fine; re-loaded per
// call so the operator can map a new client without restarting the Bridge.
function loadProposeMap(env = process.env) {
  const map = new Map();
  const filePath = env.TERMDECK_BRIDGE_PROPOSE_FILE
    || path.join(os.homedir(), '.termdeck', 'bridge-propose.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [id, v] of Object.entries(parsed.clients || {})) {
      const agent = normalizeWebSourceAgent(v);
      if (typeof id === 'string' && id.trim() && agent) map.set(id.trim(), agent);
    }
  } catch {
    /* absent/unreadable file is fine — env-only (or empty ⇒ heuristic-only) is valid */
  }
  for (const pair of String(env.TERMDECK_BRIDGE_PROPOSE_MAP || '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim();
    const agent = normalizeWebSourceAgent(pair.slice(i + 1));
    if (id && agent) map.set(id, agent);
  }
  return map;
}

// Conservative client_name heuristic: each entry is one provider FAMILY. A
// name must match EXACTLY ONE family to resolve; zero or several matches ⇒
// null (ambiguity fails closed — "Claude via Google" maps to nothing).
const SOURCE_AGENT_HEURISTICS = [
  { agent: 'claude-web', re: /claude/i },
  { agent: 'chatgpt-web', re: /chatgpt|openai/i },
  { agent: 'grok-web', re: /grok|xai/i },
  { agent: 'gemini-web', re: /gemini|google/i },
];

// Sprint 84 T2 — STRICT MAP mode (DEFAULT OFF).
//
// The heuristic above resolves identity from `client_name`, which the
// connector supplies at DCR time. That is weaker than it looks: on this host
// the operator map named only the Claude clients, yet the ChatGPT and Grok
// registrations still resolved — via their names — and could already propose.
// Provenance was therefore selectable by whoever picked the registration
// name. It is NOT an escalation path (the heuristic can only ever mint one of
// the four *-web values, never a CLI identity, and the RPC whitelist re-checks
// server-side), but "fail-closed identity" should not rest on a display name.
//
// TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1 turns the fallback off: only client_ids
// the operator has explicitly listed resolve, and every other connector is
// refused. Default OFF so enabling it is a deliberate operator step and no
// existing connector silently stops working on upgrade. See
// docs/WEB-WRITE-ACTIVATION-RUNBOOK.md § Part B4.
function isStrictMapMode(env = process.env) {
  return String((env && env.TERMDECK_BRIDGE_PROPOSE_STRICT_MAP) || '') === '1';
}

// mapClientToSourceAgent({ clientId, clientName, map, env }) → one of
// WEB_SOURCE_AGENTS or null (= unmappable ⇒ caller MUST reject the write).
// Order: operator-explicit map (by client_id) wins; else — unless strict-map
// mode is on — the client_name heuristic. NEVER defaults: identity is derived
// or the call is refused.
function mapClientToSourceAgent({ clientId, clientName, map, env } = {}) {
  const environ = env || process.env;
  const m = map || loadProposeMap(environ);
  const id = String(clientId == null ? '' : clientId).trim();
  if (id && m.has(id)) return m.get(id);
  if (isStrictMapMode(environ)) return null; // explicit map or nothing
  const name = String(clientName == null ? '' : clientName).trim();
  if (!name) return null;
  const matches = SOURCE_AGENT_HEURISTICS.filter((h) => h.re.test(name));
  return matches.length === 1 ? matches[0].agent : null;
}

// ── visiblePanels (project/panel allowlist) ─────────────────────────────────

// Load the operator allowlist (default-deny). Sources, merged + de-duped:
//   - TERMDECK_BRIDGE_ALLOWLIST_PROJECTS / _PANELS  (comma-separated)
//   - JSON at TERMDECK_BRIDGE_ALLOWLIST_FILE, else ~/.termdeck/bridge-allowlist.json
//       { "projects": ["termdeck", ...], "panels": ["<session-id>", ...] }
// A literal "*" in either list opts into "all panels visible". With NO
// allowlist configured at all, NOTHING is visible — the operator must opt a
// project or panel in. This is intentional: the Bridge errs toward invisible.
function loadAllowlist(env = process.env) {
  const projects = new Set();
  const panels = new Set();

  const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of csv(env.TERMDECK_BRIDGE_ALLOWLIST_PROJECTS)) projects.add(p);
  for (const p of csv(env.TERMDECK_BRIDGE_ALLOWLIST_PANELS)) panels.add(p);

  const filePath = env.TERMDECK_BRIDGE_ALLOWLIST_FILE
    || path.join(os.homedir(), '.termdeck', 'bridge-allowlist.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const p of parsed.projects || []) if (typeof p === 'string' && p.trim()) projects.add(p.trim());
    for (const p of parsed.panels || []) if (typeof p === 'string' && p.trim()) panels.add(p.trim());
  } catch {
    /* absent file is fine — env-only (or fully-empty default-deny) is valid */
  }
  return { projects, panels };
}

// Pull a stable panel id out of a session object, tolerating field-shape drift
// from T3's TermDeck client (id / sessionId / meta.id).
function sessionId(s) {
  if (!s || typeof s !== 'object') return null;
  return s.id || s.sessionId || (s.meta && s.meta.id) || null;
}

// Derive the project for a session: an explicit project field if present, else
// the basename of its working directory. Tolerant of several field names so T3
// is not blocked on a frozen client shape.
function sessionProject(s) {
  if (!s || typeof s !== 'object') return null;
  const direct = s.project || (s.meta && s.meta.project);
  if (direct) return String(direct);
  const cwd = s.cwd || s.cwdPath || (s.meta && (s.meta.cwd || s.meta.projectDir || s.meta.cwd));
  if (cwd) return path.basename(String(cwd));
  return null;
}

// visiblePanels(allSessions, opts?) → filtered array (default-deny). A session
// is visible iff its id is panel-allowlisted OR its project is project-
// allowlisted. opts.allowlist overrides the loaded one (used by tests); opts.env
// selects an env for loading.
function visiblePanels(allSessions, opts = {}) {
  if (!Array.isArray(allSessions)) return [];
  const { projects, panels } = opts.allowlist || loadAllowlist(opts.env);
  if (projects.has('*') || panels.has('*')) return allSessions.slice();
  if (projects.size === 0 && panels.size === 0) return []; // default-deny
  return allSessions.filter((s) => {
    const id = sessionId(s);
    if (id && panels.has(id)) return true;
    const proj = sessionProject(s);
    if (proj && projects.has(proj)) return true;
    return false;
  });
}

module.exports = {
  assertReadOnly,
  requiresApproval,
  visiblePanels,
  loadAllowlist,
  // the quarantined write channels (Sprint 76 propose, Sprint 84 session record)
  WRITE_CHANNEL_TOOLS,
  PROPOSE_TOOLS, // alias of WRITE_CHANNEL_TOOLS — server.js reads this name
  PROPOSE_ANNOTATIONS,
  WEB_SOURCE_AGENTS,
  loadProposeMap,
  mapClientToSourceAgent,
  isStrictMapMode,
  // exported for tests / introspection
  MUTATING_VERBS,
  TERMINAL_STATE_TOOLS,
  MEMORY_TOOLS,
  sessionId,
  sessionProject,
  isHonestProposeShape,
  normalizeWebSourceAgent,
};
