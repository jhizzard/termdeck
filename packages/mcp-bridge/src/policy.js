'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Bridge access policy (Sprint 71 / T2). Three contracts the rest of the
// package consumes. Together with redact.js they enforce the lane invariant:
// "nothing secret egresses, nothing can mutate, nothing un-allowlisted is
// visible."
//
//   assertReadOnly(toolDef)    — throw if a tool declares a write/delete/exec
//                                capability. Belt-and-suspenders: the Bridge
//                                ships only read tools, but a registration-time
//                                guard means a future write tool cannot be
//                                mounted by accident. T1 calls this per tool.
//   requiresApproval(toolName) — true for terminal-state tools (live local
//                                buffers are more sensitive than curated
//                                memory), false for memory reads, and
//                                FAIL-SAFE true for anything unrecognized. T1
//                                stamps the tool's MCP annotation from this.
//   visiblePanels(allSessions) — DEFAULT-DENY filter to the operator's
//                                project/panel allowlist. T3's panel tools call
//                                it so an un-allowlisted panel is never exposed.
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
]);

// assertReadOnly(toolDef) — throws if the tool looks capable of mutation.
// Honors explicit MCP capability hints first, then a name-token heuristic.
function assertReadOnly(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') {
    throw new TypeError('assertReadOnly: toolDef must be an object');
  }
  const name = String(toolDef.name || '').trim();
  if (!name) throw new Error('assertReadOnly: tool is missing a name');

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
  return true; // default-deny
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
  // exported for tests / introspection
  MUTATING_VERBS,
  TERMINAL_STATE_TOOLS,
  MEMORY_TOOLS,
  sessionId,
  sessionProject,
};
