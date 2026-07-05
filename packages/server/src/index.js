// TermDeck Server - main entry point
// Express REST API + WebSocket hub + PTY management

const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const dns = require('dns');
const { spawn: spawnChild } = require('child_process');
const { createCachedLookup, createFailureLogger } = require('./rumen-pool-resilience');

// Conditional imports (graceful fallback if not installed yet)
let pty, Database, pg;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch { pty = null; }
try {
  Database = require('better-sqlite3');
} catch (err) {
  // Brad Heath 2026-05-11: distinguish a native-ABI mismatch (Node upgraded
  // after install) from "package not installed yet." ABI mismatch leaves
  // Database=null and cascades into a null-handle storm downstream that
  // masquerades as "Mnestra unreachable / DB timeout" in health probes.
  // Fail fast with the actionable rebuild hint instead.
  const msg = err && err.message ? String(err.message) : '';
  if (err && err.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(msg)) {
    console.error('[db] better-sqlite3 native ABI mismatch (Node was upgraded after install).');
    console.error('[db] TermDeck cannot serve memory features without a working SQLite.');
    console.error('[db] Fix:');
    process.stderr.write('       cd "$(npm root -g)/@jhizzard/termdeck" && npm rebuild better-sqlite3\n');
    console.error('[db] Then restart TermDeck. Aborting.');
    process.exit(1);
  }
  Database = null;
}
try { pg = require('pg'); } catch { pg = null; }

// Module-level singleton Postgres pool for rumen_insights (the daily-driver DB).
// Lazy-initialized on first rumen endpoint hit so startup stays fast and
// servers without DATABASE_URL never pay the connection cost.
//
// DNS-resilience (Sprint 45 side-task): the pool is constructed with a
// cached `lookup` function that retries DNS failures with jittered
// exponential backoff and serves stale entries during transient outages.
// Pool errors / recoveries flow through a recency-graded logger so a
// flapping host doesn't flood the log.
let _rumenPool = null;
let _rumenPoolFailed = false;
let _rumenPoolFailedAt = 0;
const RUMEN_POOL_RETRY_MS = 30_000;
const _rumenLookup = createCachedLookup(dns);
const _rumenLogger = createFailureLogger(console);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function getRumenPool() {
  if (_rumenPool) return _rumenPool;
  if (_rumenPoolFailed) {
    if (Date.now() - _rumenPoolFailedAt < RUMEN_POOL_RETRY_MS) return null;
    console.warn('[rumen] retrying pool creation after 30s cooldown');
    _rumenPoolFailed = false;
    _rumenPoolFailedAt = 0;
  }
  if (!pg || !process.env.DATABASE_URL) return null;
  try {
    _rumenPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      lookup: _rumenLookup,
    });
    _rumenPool.on('error', (err) => _rumenLogger.logFailure(`pg pool error: ${err.message}`));
    _rumenPool.on('connect', () => _rumenLogger.logRecovery());
    return _rumenPool;
  } catch (err) {
    _rumenLogger.logFailure(`failed to create pg pool: ${err.message}`);
    _rumenPoolFailed = true;
    _rumenPoolFailedAt = Date.now();
    return null;
  }
}

const { SessionManager } = require('./session');
const { initDatabase, logCommand, getSessionHistory, getProjectSessions } = require('./database');
const { RAGIntegration } = require('./rag');
const { createBridge } = require('./mnestra-bridge');
const flashbackDiag = require('./flashback-diag');
const advisor = require('./advisor');
const { submitToPty } = require('./pty-submit');
const {
  computeContextK,
  classifyContext,
  evaluateEnforcement,
} = require('./context-meter');
const { writeSessionLog } = require('./session-logger');
const { TranscriptWriter } = require('./transcripts');
const { createHealthHandler, runPreflight } = require('./preflight');
const { getFullHealth } = require('./health');
const { themes, statusColors } = require('./themes');
const { loadConfig, addProject, removeProject, updateConfig } = require('./config');
const { createAuthMiddleware, verifyWebSocketUpgrade, hasAuth } = require('./auth');
const { createSprintRoutes } = require('./sprint-routes');
const { createSprintInjectRoutes } = require('./sprints/inject');
// Sprint 69 T1 — boot-prompt template engine. Exposed at the public surface
// so external callers (T2's inject route, integration tests, future tools)
// can do `require('@termdeck/server').templateEngine` instead of reaching
// into the internal `./templates/template-engine` path.
const templateEngine = require('./templates/template-engine');
const { createSprintNudgeRoutes } = require('./sprints/nudge');
const { createGraphRoutes } = require('./graph-routes');
const { createProjectsRoutes } = require('./projects-routes');
const orchestrationPreview = require('./orchestration-preview');
const { createPtyReaper } = require('./pty-reaper');
const { AGENT_ADAPTERS, getAdapterForSessionType } = require('./agent-adapters');
const { deriveRagMode } = require('./rag-mode');
const { resolveSpawnShell } = require('./spawn-shell');

// Sprint 48 T4 deliverable 2: PTY env-var propagation.
// Reads ~/.termdeck/secrets.env once per server lifetime so each PTY spawn
// inherits SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY etc.
// without depending on the user's shell to have sourced the file.
//
// Why this exists: `memory-session-end.js` (the bundled Stop hook installed by
// `@jhizzard/termdeck-stack`) writes session_summary rows to Mnestra by
// reading those three vars from `process.env`. When TermDeck spawns a Claude
// Code panel directly via `pty.spawn`, the child shell inherits the server's
// `process.env` — but if the *user* didn't source secrets.env in their
// `.zshrc` before running `termdeck`, those vars are absent and every session
// close hits `env-var-missing`. Sprint 47 close-out audit confirmed 0
// session_summary rows had ever landed.
//
// Treats `${VAR}` placeholders as unset (Sprint 47.5 hotfix lesson — Claude
// Code does not shell-expand MCP env values; same trap applies anywhere the
// secrets file flows through a non-shell consumer).
let _termdeckSecretsCache = null;

// Sprint 64 T1 (ORCH SCOPE 16:29 ET item 4) — management-grade tokens that
// MUST NEVER be merged from ~/.termdeck/secrets.env into a spawned child's
// env. The wizard's --auto path now explicitly avoids persisting the
// Supabase PAT here (see packages/cli/src/init.js Phase 3 + the AUDIT-RED
// resolution comment), but a user might still paste one manually via
// `vi ~/.termdeck/secrets.env` — defense-in-depth at the reader caps that
// failure mode. Keys hold:
//   • SUPABASE_ACCESS_TOKEN: Supabase PAT — org-wide management privileges
//     (can create/delete projects, set vault secrets, deploy functions
//     against every project in the org). Highest blast-radius credential
//     in the standard TermDeck stack. The Mnestra hook does NOT need it
//     (per-project SUPABASE_SERVICE_ROLE_KEY is what the hook uses), so
//     dropping it from the PTY merge is loss-free for the running stack.
//   • GITHUB_TOKEN / GITHUB_PAT: Personal Access Tokens for GitHub —
//     repo write access at minimum, often org-wide. Brad's R730 likely
//     doesn't carry one but Joshua's daily-driver does (publish wave
//     workflow). Preventive.
//   • OPENAI_ADMIN_KEY: OpenAI Admin key — billing/org-management.
//     Distinct from OPENAI_API_KEY which is the per-project usage key
//     that Mnestra DOES need. Preventive.
//   • NPM_TOKEN: registry publish token. Preventive.
const SECRETS_EXCLUDED_FROM_PTY = new Set([
  'SUPABASE_ACCESS_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'OPENAI_ADMIN_KEY',
  'NPM_TOKEN',
]);

// Sprint 65 T2 (2.1) — explicit operator-role whitelist for the optional
// `role` field on POST /api/sessions (Brad's 2026-05-13 v2 dashboard spec,
// Approach A). `null` is the valid "unroled" value; an absent field also
// defaults to null. The dashboard pins the ORCH row for the orchestrator
// family (`orchestrator` OR `master-orchestrator`); worker/reviewer/auditor
// are accepted for forward-compat with the canonical 3+1+1 role taxonomy.
// Sprint 80 FR-2 (Brad's 2026-06-26 fleet-legibility ask) — `master-orchestrator`
// is a distinct TOP tier: it renders GOLD while plain `orchestrator` moves to
// SILVER, so an operator running many orchestrators across a fleet can spot the
// master control panel at a glance. Both tiers pin. Unknown values are rejected
// with 400 at the route. Exported for the route-fence test.
const ALLOWED_SESSION_ROLES = ['master-orchestrator', 'orchestrator', 'worker', 'reviewer', 'auditor', null];

// Sprint 80 T3 (FR-3) — normalize the configured panel cap. A positive finite
// integer is a real ceiling; null / 0 / negative / NaN / non-numeric ALL mean
// UNLIMITED — the exact pre-FR-3 behavior, so an unset/malformed value never
// caps below current usage. Exported for the unit test.
function effectivePanelCap(config) {
  const n = Number(config && config.maxPanels);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function readTermdeckSecretsForPty() {
  if (_termdeckSecretsCache !== null) return _termdeckSecretsCache;
  const secretsPath = path.join(os.homedir(), '.termdeck', 'secrets.env');
  const out = {};
  try {
    const text = fs.readFileSync(secretsPath, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
        v = v.slice(1, -1);
      }
      if (v.startsWith('${') && v.endsWith('}')) continue;
      if (v === '') continue;
      // Sprint 64 T1 (ORCH SCOPE 16:29 ET item 4): EXCLUDE management-grade
      // tokens from the PTY/child-process env merge. See
      // SECRETS_EXCLUDED_FROM_PTY constant above for the rationale per key.
      if (SECRETS_EXCLUDED_FROM_PTY.has(m[1])) continue;
      out[m[1]] = v;
    }
  } catch (_err) {
    // File absent or unreadable — empty merge, hook still hits env-var-missing
    // until the user runs the wizard. Better than a crash on spawn.
  }
  _termdeckSecretsCache = out;
  return out;
}
// Test hook — clear the cache between tests that mutate the on-disk file.
function _resetTermdeckSecretsCache() { _termdeckSecretsCache = null; }

// Sprint 50 T1 — Per-agent SessionEnd hook trigger.
//
// `_spawnSessionEndHookImpl` is the production spawn path; tests swap it
// out via `_setSpawnSessionEndHookImplForTesting` to capture the
// payload + arguments deterministically. The reason this indirection
// exists rather than mocking `child_process.spawn`: `node:test` doesn't
// run detached + stdio:['pipe','ignore','ignore'] children inside the
// test runner (verified — direct spawn with the same options fails to
// even invoke the script's first line). Mocking `child_process` would
// require module-level mocking which the runner doesn't support out of
// the box. A single-function injection keeps the surface tiny.
function _defaultSpawnSessionEndHookImpl(hookPath, payload, env) {
  const child = spawnChild('node', [hookPath], {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
    env,
  });
  child.on('error', (err) => {
    console.error('[panel-close] hook spawn error:', err && err.message ? err.message : err);
  });
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch (err) {
    console.error('[panel-close] hook stdin write failed:', err && err.message ? err.message : err);
  }
  child.unref();
  return child;
}
let _spawnSessionEndHookImpl = _defaultSpawnSessionEndHookImpl;
function _setSpawnSessionEndHookImplForTesting(fn) {
  _spawnSessionEndHookImpl = typeof fn === 'function' ? fn : _defaultSpawnSessionEndHookImpl;
}

// Sprint 64 T3 — periodic-capture spawn (Investigation 2 of
// docs/CRITICAL-READ-FIRST-2026-05-07.md). Parallel to _spawnSessionEndHookImpl
// but targets memory-pre-compact.js. Same indirection rationale: tests stub
// this to capture the payload deterministically without running detached
// children inside the test runner.
function _defaultSpawnPeriodicCaptureHookImpl(hookPath, payload, env) {
  return _defaultSpawnSessionEndHookImpl(hookPath, payload, env);
}
let _spawnPeriodicCaptureHookImpl = _defaultSpawnPeriodicCaptureHookImpl;
function _setSpawnPeriodicCaptureHookImplForTesting(fn) {
  _spawnPeriodicCaptureHookImpl = typeof fn === 'function' ? fn : _defaultSpawnPeriodicCaptureHookImpl;
}

// Sprint 72 T2 — web-chat driver resolver (Workstream B). A `web-chat` panel is
// backed by T1's CDP render-bridge (packages/web-chat-driver), NOT node-pty.
// Lazy-required + fail-soft: if the driver isn't built/installed yet (T1/T3
// build it in parallel) the require throws and we return null, so a web-chat
// spawn degrades to 'errored' status instead of crashing the server — PTY
// panels AND the parallel Sprint 71 deck stay completely unaffected. The
// require is by RELATIVE PATH (resolving the package's own package.json `main`),
// not a root dependency, per Guardrail 5 (no root package.json churn; the
// driver keeps its own isolated install). Tests inject a fake driver via
// `_setWebChatDriverImplForTesting` (same DI rationale as the hook-spawn impls
// above) so the seams are exercised with no real Chrome / CDP / network.
//
// Defensive aggregator-gap handling: the driver's src/index.js currently
// exports only `{ cdp }` (T3's `grok` namespace isn't wired into the aggregator
// yet — flagged in Sprint 72 STATUS.md). If `.grok` is absent we attach it from
// the sub-module directly so this seam works before that one-line T1 fix lands.
function _defaultWebChatDriverImpl() {
  let driver;
  try { driver = require('../../web-chat-driver'); }
  catch (_e) { return null; }
  if (driver && !driver.grok) {
    try { driver = { ...driver, grok: require('../../web-chat-driver/src/grok') }; }
    catch (_e) { /* grok namespace not present yet — cdp-only handle is degraded but non-fatal */ }
  }
  return driver;
}
let _webChatDriverImpl = _defaultWebChatDriverImpl;
function _setWebChatDriverImplForTesting(fn) {
  _webChatDriverImpl = typeof fn === 'function' ? fn : _defaultWebChatDriverImpl;
}

// Fires when a panel's PTY exits. Routes through the adapter registry's
// new `resolveTranscriptPath` field (10th adapter field, Sprint 50) and
// invokes the bundled `~/.claude/hooks/memory-session-end.js` with the
// right payload so Codex / Gemini / Grok panels write a `session_summary`
// row the same way Claude Code already does.
//
// Skip rules (in order):
//   1. Claude — its own SessionEnd hook (registered in
//      ~/.claude/settings.json) ingests Claude rows. Double-firing here
//      would either insert two rows per session or race the Claude hook.
//   2. Adapters without `resolveTranscriptPath` — older adapters or types
//      not in the registry (shell, python-server, one-shot). No-op.
//   3. `resolveTranscriptPath` returns null — adapter declares no
//      transcript exists for this session (panel never sent a turn).
//   4. ~/.claude/hooks/memory-session-end.js missing — user hasn't
//      installed the TermDeck stack hook. No-op.
//
// Fail-soft contract: any error logs to stderr and exits cleanly. Never
// blocks panel teardown — the spawn is fire-and-forget (detached + unref).
//
// `source_agent` is included in the payload (T2 consumes it via the new
// `memory_items.source_agent` column). T1 just passes the value; if T2
// hasn't migrated the column yet at the moment of first fire, Supabase
// rejects the row and the hook logs `supabase-insert-failed: HTTP 4xx`.
async function onPanelClose(session) {
  try {
    if (!session || !session.meta) return;
    const adapter = AGENT_ADAPTERS[session.meta.type]
      || Object.values(AGENT_ADAPTERS).find((a) => a.sessionType === session.meta.type);
    if (!adapter) return;
    if (adapter.sessionType === 'claude-code') return;
    if (typeof adapter.resolveTranscriptPath !== 'function') return;

    const transcriptPath = await adapter.resolveTranscriptPath(session);
    if (!transcriptPath) return;

    const hookPath = path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js');
    if (!fs.existsSync(hookPath)) return;

    const payload = {
      transcript_path: transcriptPath,
      cwd: session.meta.cwd,
      session_id: session.id,
      sessionType: adapter.sessionType,
      // Sprint 50 — T2 consumes this via the new memory_items.source_agent column.
      // Sprint 70 T3 — prefer an explicit `adapter.sourceAgent` provenance tag
      // when an adapter declares one (decouples the provenance string from the
      // registry/binary-match `name`); existing adapters omit it and fall back
      // to `name` (behavior unchanged). The antigravity (`agy`) adapter sets
      // sourceAgent:'antigravity'; the session-end hook's normalizeSourceAgent
      // also aliases the binary name `agy` → `antigravity` as a safety net.
      source_agent: adapter.sourceAgent || adapter.name,
    };

    _spawnSessionEndHookImpl(hookPath, payload, {
      ...process.env,
      ...readTermdeckSecretsForPty(),
    });
  } catch (err) {
    console.error('[panel-close] error:', err && err.message ? err.message : err);
  }
}

// Sprint 64 T3.4 — periodic-capture timer for non-Claude panels.
//
// PreCompact only fires inside Claude Code. Codex/Gemini/Grok don't have a
// PreCompact-equivalent — verified 2026-05-11, see docs/RESTART-PROMPT-
// 2026-05-11.md § Sprint 64 candidates ("Codex CLI specifically lacks a pre-
// compact hook surface — `codex --help` exposes no hooks subcommand").
// Long sessions on those agents grow their transcripts indefinitely; without
// a periodic snapshot to Mnestra, all of that context evaporates if the
// process crashes BEFORE the SessionEnd hook can fire on /exit.
//
// Strategy: every N minutes (default 10 min, override via
// `TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS`) the timer resolves the panel's
// on-disk transcript via the same `adapter.resolveTranscriptPath` path
// `onPanelClose` uses, then spawns memory-pre-compact.js with
// `mode: 'periodic_checkpoint'`. The hook handles parsing + embed + POST.
//
// Throttle (per the T3 brief): skip if the transcript hasn't grown by
// >= 1 KB since the last fire. Stop firing once `meta.status === 'exited'`
// (close-out capture covers that path).
//
// Skip rules mirror onPanelClose (Claude has its own PreCompact hook,
// missing adapter / resolveTranscriptPath / hook file → no-op).
async function onPanelPeriodicCapture(session) {
  try {
    if (!session || !session.meta) return;
    if (session.meta.status === 'exited') return;
    const adapter = AGENT_ADAPTERS[session.meta.type]
      || Object.values(AGENT_ADAPTERS).find((a) => a.sessionType === session.meta.type);
    if (!adapter) return;
    if (adapter.sessionType === 'claude-code') return;
    if (typeof adapter.resolveTranscriptPath !== 'function') return;

    const transcriptPath = await adapter.resolveTranscriptPath(session);
    if (!transcriptPath) return;

    // Throttle: compare current transcript size against last-fire bookmark.
    // 1 KB minimum delta keeps the bill bounded on quiet panels (a panel
    // sitting idle at the prompt produces ~0 new bytes per interval).
    let stat;
    try { stat = fs.statSync(transcriptPath); }
    catch (_e) { return; }
    if (!session._periodicCapture) session._periodicCapture = { lastSize: 0, lastFireMs: 0 };
    const grew = stat.size - session._periodicCapture.lastSize;
    if (grew < 1024) return;

    const hookPath = path.join(os.homedir(), '.claude', 'hooks', 'memory-pre-compact.js');
    if (!fs.existsSync(hookPath)) return;

    const payload = {
      transcript_path: transcriptPath,
      cwd: session.meta.cwd,
      session_id: session.id,
      sessionType: adapter.sessionType,
      // Sprint 70 T3 — same provenance contract as onPanelClose: an explicit
      // adapter.sourceAgent wins, else fall back to adapter.name (unchanged for
      // existing adapters). agy panels' periodic snapshots tag 'antigravity'.
      source_agent: adapter.sourceAgent || adapter.name,
      // Mode discriminator the hook reads in resolveFiringContext —
      // distinguishes "TermDeck server periodic capture" from "Claude Code
      // PreCompact harness fire."
      mode: 'periodic_checkpoint',
    };

    _spawnPeriodicCaptureHookImpl(hookPath, payload, {
      ...process.env,
      ...readTermdeckSecretsForPty(),
    });

    // Update bookmark immediately — even if the spawn fails downstream we
    // don't want to retry the same byte range on the next tick. Worst case
    // we lose one tick; the next 1 KB of growth fires again.
    session._periodicCapture.lastSize = stat.size;
    session._periodicCapture.lastFireMs = Date.now();
  } catch (err) {
    console.error('[periodic-capture] error:', err && err.message ? err.message : err);
  }
}

// Default interval (10 min). Override via env var; setting to 0 disables the
// timer entirely. Tests pass a much smaller value (e.g. 100ms) via the env
// var to exercise the timer path without waiting.
function _resolvePeriodicCaptureIntervalMs() {
  const raw = process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS;
  if (!raw) return 10 * 60 * 1000;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 10 * 60 * 1000;
  return n;
}

// ════════════════════════════════════════════════════════════════════════════
// Sprint 80 T2 — context telemetry (FR-5) + ceiling enforcement (FR-6).
//
// Reads the true Claude context size off the on-disk transcript (the same
// figure the model itself can no longer reliably self-report at high context —
// see context-meter.js header + Brad's 2026-06-26 crash) and, when configured,
// enforces a ceiling. FR-5 is telemetry-only; FR-6 default action is `notify`
// (PLANNING §3.3) — inject/kill are opt-in and kill is grace-guarded.
//
// The compute + threshold + hysteresis/kill-grace DECISIONS live in the pure,
// unit-tested context-meter.js. This block is the WIRING: the fs.watch on the
// transcript, the meta mutation (which rides the existing 2s status_broadcast),
// and the action side-effects. Side-effects are behind injectable impls so the
// enforcement path is testable with a stubbed PTY — never a live server (the
// production submitToPty path is a suspected crash trigger under the 2026-07-01
// INCIDENT, and inject is the only action that touches it; it stays opt-in).
// ════════════════════════════════════════════════════════════════════════════

const CONTEXT_WATCH_RETRY_MS = 3000;
const CONTEXT_WATCH_MAX_RETRIES = 20;   // ~60s of retries before giving up quietly

function _resolveContextWatchDebounceMs() {
  const raw = process.env.TERMDECK_CONTEXT_WATCH_DEBOUNCE_MS;
  if (raw === undefined || raw === '') return 600;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 600;
  return n;
}

function _numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// The server sets this to `() => config.context` at startup; tests set their own.
let _contextConfigProvider = () => ({});
function _setContextConfigProvider(fn) {
  _contextConfigProvider = typeof fn === 'function' ? fn : (() => ({}));
}

// Injectable action side-effects (mirrors the _spawn*HookImpl pattern).
let _contextSubmitImpl = submitToPty;                 // FR-6 inject (SUSPECT crash path — opt-in only)
let _contextKillImpl = null;                          // FR-6 kill — server wires this (needs spawn/sessions)
let _contextWebhookImpl = _defaultContextWebhook;     // FR-6 notify webhook
function _setContextSubmitImplForTesting(fn) { _contextSubmitImpl = typeof fn === 'function' ? fn : submitToPty; }
function _setContextKillImpl(fn) { _contextKillImpl = typeof fn === 'function' ? fn : null; }
function _setContextWebhookImplForTesting(fn) { _contextWebhookImpl = typeof fn === 'function' ? fn : _defaultContextWebhook; }

function _defaultContextWebhook(url, payload) {
  // Fire-and-forget POST. Uses global fetch (Node 18+); silently no-ops if
  // unavailable. Never throws into the caller.
  try {
    if (typeof fetch !== 'function' || !url) return;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* fire-and-forget */ });
  } catch (_e) { /* fire-and-forget */ }
}

// Effective per-panel context config = global config.context, with per-session
// meta overrides (maxContextK / contextAction) winning. maxContextK stays
// undefined (→ enforcement disabled) unless a positive number is configured.
function resolveContextConfig(session) {
  const base = _contextConfigProvider() || {};
  const meta = (session && session.meta) || {};
  const maxRaw = (meta.maxContextK !== undefined && meta.maxContextK !== null)
    ? meta.maxContextK
    : base.maxContextK;
  const maxNum = Number(maxRaw);
  return {
    warnK: _numOr(base.warnK, 350),
    overK: _numOr(base.overK, 400),
    maxContextK: (Number.isFinite(maxNum) && maxNum > 0) ? maxNum : undefined,
    contextAction: meta.contextAction || base.contextAction || 'notify',
    contextInjectText: base.contextInjectText
      || 'You are approaching the context limit. Persist critical state to memory now, then rotate to a fresh session.',
    respawnOnKill: !!base.respawnOnKill,
    killGraceMs: _numOr(base.killGraceMs, 15000),
    killMaxDeferrals: _numOr(base.killMaxDeferrals, 3),
    webhookUrl: base.webhookUrl || null,
  };
}

function _contextAdapterFor(session) {
  return AGENT_ADAPTERS[session.meta.type]
    || Object.values(AGENT_ADAPTERS).find((a) => a.sessionType === session.meta.type);
}

// Kill is destructive, so we NEVER fire it while the panel looks busy. Any live
// state (thinking / editing / active / anything not clearly at-rest) defers the
// kill; the deferral cap in evaluateEnforcement guarantees we eventually act.
function isMidToolUse(session) {
  const m = session && session.meta;
  if (!m) return false;
  return !(m.status === 'idle' || m.status === 'exited' || m.status === 'errored');
}

// FR-5 core: resolve the panel's Claude transcript, compute contextK, update
// meta (rides status_broadcast), and run the FR-6 check. Claude-only; non-Claude
// panels have no Claude JSONL and degrade to PATCH-only (no header noise).
//
// Precedence (PLANNING §3.4): the server-computed value WINS whenever the JSONL
// is readable. When compute returns null (no usage yet / truncated mid-write),
// we return early and RETAIN the prior value — so a transient truncated tail
// never clobbers a good reading, and a PATCH-supplied fallback stands until a
// real reading arrives.
async function updatePanelContext(session) {
  try {
    if (!session || !session.meta) return;
    if (session.meta.status === 'exited') return;
    const adapter = _contextAdapterFor(session);
    if (!adapter || adapter.sessionType !== 'claude-code') return;
    if (typeof adapter.resolveTranscriptPath !== 'function') return;

    const transcriptPath = await adapter.resolveTranscriptPath(session);
    if (!transcriptPath) return;

    const result = computeContextK(transcriptPath);
    if (!result) return; // no reading — retain prior value (PATCH fallback stands)

    const cfg = resolveContextConfig(session);
    session.meta.contextK = result.contextK;
    session.meta.contextLevel = classifyContext(result.contextK, cfg.warnK, cfg.overK);

    enforceContext(session, result.contextK, cfg);
  } catch (_e) { /* fail-soft: telemetry must never break a panel */ }
}

// FR-6: run the pure state machine, then apply the decided side-effect.
function enforceContext(session, contextK, cfg) {
  if (!session._contextEnforce) session._contextEnforce = { armed: true, deferrals: 0 };
  const decision = evaluateEnforcement({
    contextK,
    maxContextK: cfg.maxContextK,
    warnK: cfg.warnK,
    action: cfg.contextAction,
    midToolUse: isMidToolUse(session),
    state: session._contextEnforce,
    maxDeferrals: cfg.killMaxDeferrals,
  });

  if (decision.kind === 'fire') {
    fireContextAction(session, decision.action, contextK, cfg);
  } else if (decision.kind === 'defer') {
    _scheduleKillRecheck(session, cfg);
  } else if (decision.kind === 'reset') {
    // Context dropped below WARN — a rotation happened; clear the stale alert.
    if (session.meta) session.meta.contextAlert = null;
  }
}

// Kill was deferred because the panel is mid-tool-use. Re-check after the grace
// window with the CURRENT contextK. Guarded so overlapping JSONL writes don't
// stack multiple timers.
function _scheduleKillRecheck(session, cfg) {
  const st = session._contextEnforce;
  if (!st || st.gracePending) return;
  st.gracePending = true;
  const t = setTimeout(() => {
    st.gracePending = false;
    if (session.meta && session.meta.status !== 'exited'
        && typeof session.meta.contextK === 'number') {
      enforceContext(session, session.meta.contextK, resolveContextConfig(session));
    }
  }, _numOr(cfg.killGraceMs, 15000));
  if (t.unref) t.unref();
  session._contextKillTimer = t;
}

// Apply an enforcement action. `notify` (default) records a UI alert (rides the
// status_broadcast) + optional webhook. `inject` additionally pastes the
// force-rotate message via the production submitToPty path (opt-in; SUSPECT
// crash path). `kill` terminates + optionally respawns (opt-in; never default).
function fireContextAction(session, action, contextK, cfg) {
  const alert = {
    action,
    contextK,
    maxContextK: cfg.maxContextK,
    ts: new Date().toISOString(),
  };
  if (session.meta) session.meta.contextAlert = alert;
  console.warn(`[context] panel ${session.id} at ${contextK}K ≥ ${cfg.maxContextK}K ceiling — action=${action}`);

  if (cfg.webhookUrl) {
    try { _contextWebhookImpl(cfg.webhookUrl, { sessionId: session.id, ...alert }); }
    catch (_e) { /* fire-and-forget */ }
  }

  if (action === 'inject') {
    try {
      Promise.resolve(_contextSubmitImpl(session, cfg.contextInjectText))
        .catch((err) => console.error('[context] inject submit failed:', err && err.message ? err.message : err));
    } catch (err) {
      console.error('[context] inject submit threw:', err && err.message ? err.message : err);
    }
  } else if (action === 'kill') {
    if (typeof _contextKillImpl === 'function') {
      try { _contextKillImpl(session, { respawn: !!cfg.respawnOnKill }); }
      catch (err) { console.error('[context] kill failed:', err && err.message ? err.message : err); }
    } else {
      console.error(`[context] kill requested for ${session.id} but no kill impl wired`);
    }
  }
  // 'notify' → alert + webhook only (already done above).
}

// FR-5 watch: Claude writes its transcript at
// ~/.claude/projects/<cwd-slash→dash>/<uuid>.jsonl, but the inner UUID is
// Claude's own session id (not TermDeck's) and the file may not exist at spawn,
// so we watch the DIRECTORY (debounced) and re-resolve the newest jsonl via the
// shared claude-adapter resolver on each change — reusing that resolver rather
// than rolling a second encoded-cwd path builder (Sprint 64 mandate). The dir
// may not exist yet on a brand-new cwd; retry a bounded number of times.
function establishContextWatch(session, opts = {}) {
  try {
    if (!session || !session.meta || !session.meta.cwd) return;
    const adapter = _contextAdapterFor(session);
    if (!adapter || adapter.sessionType !== 'claude-code') return; // Claude-only
    if (typeof adapter.resolveTranscriptPath !== 'function') return;

    const dirHash = session.meta.cwd.replace(/\//g, '-');
    const projectsDir = path.join(os.homedir(), '.claude', 'projects', dirHash);
    const debounceMs = _numOr(opts.debounceMs, _resolveContextWatchDebounceMs());

    const state = { watcher: null, debounce: null, retry: null, retries: 0, closed: false };
    session._contextWatch = state;

    const recompute = () => {
      state.debounce = null;
      updatePanelContext(session).catch((err) =>
        console.error('[context] update error:', err && err.message ? err.message : err));
    };
    const schedule = () => {
      if (state.closed || state.debounce) return;
      state.debounce = setTimeout(recompute, debounceMs);
      if (state.debounce.unref) state.debounce.unref();
    };
    const tryWatch = () => {
      if (state.closed) return;
      try {
        state.watcher = fs.watch(projectsDir, () => schedule());
        // Initial compute — a resumed panel already has a growing transcript.
        schedule();
      } catch (e) {
        if (e && e.code === 'ENOENT' && state.retries < CONTEXT_WATCH_MAX_RETRIES) {
          state.retries += 1;
          state.retry = setTimeout(tryWatch, CONTEXT_WATCH_RETRY_MS);
          if (state.retry.unref) state.retry.unref();
        }
        // else: give up quietly — contextK stays unknown (no header noise).
      }
    };
    tryWatch();
  } catch (_e) { /* fail-soft */ }
}

// Clear the fs.watch + any pending grace timer. Called at both panel-teardown
// sites next to the periodic-capture timer clear.
function teardownContextWatch(session) {
  const s = session && session._contextWatch;
  if (s) {
    s.closed = true;
    if (s.watcher) { try { s.watcher.close(); } catch (_e) { /* noop */ } s.watcher = null; }
    if (s.debounce) { try { clearTimeout(s.debounce); } catch (_e) { /* noop */ } s.debounce = null; }
    if (s.retry) { try { clearTimeout(s.retry); } catch (_e) { /* noop */ } s.retry = null; }
  }
  if (session && session._contextKillTimer) {
    try { clearTimeout(session._contextKillTimer); } catch (_e) { /* noop */ }
    session._contextKillTimer = null;
  }
}

// Sprint 70 T1 — best-effort line-buffering wrap for stdout-capture adapters.
//
// The LOAD-BEARING capture mechanism is the PTY tee in spawnTerminalSession;
// this wrap is a RESIDUAL buffering-defense, valuable only for line-buffered
// C-stdio CLIs and timelier mid-session periodic checkpoints. It is inert for a
// compiled binary like `agy` (libstdbuf only affects glibc stdio) and a no-op
// on hosts without a stdbuf-family tool (stock macOS) — the tee captures
// everything regardless. We PREFER `stdbuf`/`gstdbuf` (GNU coreutils) because
// it exec()s the target IN PLACE: same controlling TTY, pid preserved, exit
// code propagated. We deliberately do NOT use `unbuffer` (expect) — it
// allocates its own pty, producing a double-pty that strips the interactive-TTY
// context agent CLIs need (Sprint 64 T2 carve-out 2.4 rationale).
let _stdbufToolCache;  // undefined = unprobed, string = tool name, null = none on PATH
function _defaultLookStdbuf() {
  if (_stdbufToolCache !== undefined) return _stdbufToolCache;
  const { spawnSync } = require('child_process');
  _stdbufToolCache = null;
  for (const name of ['stdbuf', 'gstdbuf']) {
    try {
      const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
      if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
        _stdbufToolCache = name;
        break;
      }
    } catch (_) { /* try next candidate */ }
  }
  return _stdbufToolCache;
}

// Returns the (possibly rewritten) { binary, args } to hand pty.spawn. No-op
// unless the adapter declares `capture.mode==='stdout'` AND `capture.unbuffer`.
// `lookPath` is dependency-injected so tests stay hermetic (no real stdbuf
// dependence). Resets the memo via `_resetStdbufToolCacheForTesting`.
function _resolveStdoutCaptureSpawn(binary, args, capture, lookPath = _defaultLookStdbuf) {
  if (!capture || capture.mode !== 'stdout' || !capture.unbuffer) {
    return { binary, args };
  }
  let tool = null;
  try { tool = lookPath(); } catch (_) { tool = null; }
  if (!tool) return { binary, args };  // graceful fallback — bare direct-spawn
  return { binary: tool, args: ['-oL', '-eL', binary, ...args] };
}
function _resetStdbufToolCacheForTesting() { _stdbufToolCache = undefined; }

// Sprint 37 T3 — lazy resolution of T2's CLI modules. The orchestration-preview
// helper is decoupled from T2's templates.js / init-project.js; we resolve
// them here and pass them into the helper. If a module is missing (e.g.
// install hasn't been completed yet), the route surfaces a 503 with a clear
// error rather than crashing the server.
let _t2Templates = null;
let _t2TemplatesResolved = false;
function _getT2Templates() {
  if (_t2TemplatesResolved) return _t2Templates;
  _t2TemplatesResolved = true;
  try { _t2Templates = require('../../cli/src/templates'); }
  catch (_e) { _t2Templates = null; }
  return _t2Templates;
}

let _t2InitProject = null;
let _t2InitProjectResolved = false;
function _getT2InitProject() {
  if (_t2InitProjectResolved) return _t2InitProject;
  _t2InitProjectResolved = true;
  try {
    const mod = require('../../cli/src/init-project');
    _t2InitProject = (mod && typeof mod.initProject === 'function')
      ? mod.initProject
      : (typeof mod === 'function' ? mod : null);
  } catch (_e) {
    _t2InitProject = null;
  }
  return _t2InitProject;
}

function _getT2DestFor() {
  try {
    const mod = require('../../cli/src/init-project');
    return (mod && typeof mod._destFor === 'function') ? mod._destFor : undefined;
  } catch (_e) {
    return undefined;
  }
}

function _termdeckVersion() {
  try { return require('../../../package.json').version; }
  catch (err) { console.error('[version] package.json read failed:', err); return '0.0.0'; }
}

// Sprint 60 v1.0.14 (Item 3) — safe PTY resize. Brad's 2026-05-07 r730 crash
// forensic surfaced 25× `[ws] message handler error: Error: ioctl(2) failed,
// EBADF/ENOTTY` per 13h uptime. Race: WS `resize` message arrives for a PTY
// that pty-reaper has already closed (or the child has exited), and
// `pty.resize()` ioctls a stale fd. The error is race-expected, not a bug,
// but the noisy stderr trace pollutes diagnostics and obscures real
// errors. This helper guards against the race and downgrades the known
// race-class errors (EBADF, ENOTTY) to a silent return. Set
// TERMDECK_DEBUG_PTY_RACES=1 to log to console.debug for diagnostics.
//
// Sprint 63 T1 — `isPtyRaceError(err)` extracted so the WS message-handler
// outer catch can also downgrade race-class errors that escape the helper's
// own catch (e.g. if `pty.write` ever races the close, future code paths).
// `session.pty._destroyed` short-circuit added as belt-and-suspenders for the
// `term.kill()` → before-`term.onExit`-fires window: the DELETE handler now
// stamps `_destroyed = true` immediately after kill(), so resize attempts in
// that interval short-circuit without an ioctl call.
function isPtyRaceError(err) {
  if (!err) return false;
  const msg = (err.message) || '';
  const code = err.code;
  return code === 'EBADF' ||
    code === 'ENOTTY' ||
    /\b(?:EBADF|ENOTTY)\b/.test(msg);
}

function safelyResizePty(session, cols, rows) {
  if (!session || !session.pty) return false;
  if (session.pty._destroyed) return false;
  if (session.meta && session.meta.status === 'exited') return false;
  try {
    session.pty.resize(cols || 120, rows || 30);
    return true;
  } catch (err) {
    // Sprint 60 v1.0.14 + T4-CODEX AUDIT-CONCERN narrowing: race classifier
    // requires explicit EBADF or ENOTTY (in code OR message). The earlier
    // shape — any "ioctl(N) failed" message — was too broad: it would have
    // silently dropped a non-race ioctl failure (e.g. EINTR, EFAULT) that
    // might indicate a real bug. Now: only the specific race-class signals
    // get suppressed; everything else rethrows so it surfaces in logs.
    if (isPtyRaceError(err)) {
      if (process.env.TERMDECK_DEBUG_PTY_RACES) {
        console.debug(`[ws] resize-after-pty-exit (race-expected): session=${session.id} ${err.code || err.message}`);
      }
      return false;
    }
    throw err;
  }
}

// Sprint 63 T1 (Item 1.3) — body-parser hardening. The pre-existing
// `entity.verify.failed` / `entity.parse.failed` handler logged the error
// message but not WHICH bytes triggered the parse failure. Operators on
// Brad's r730 saw 9× SyntaxError flood over 13h with no fingerprint to
// identify the offending caller. `hexEscapePrefix` renders a 32-byte
// prefix of the raw body in a single-line, log-safe form: printable ASCII
// kept verbatim, non-printables rendered as `\xNN`, backslash escaped as
// `\\`. PII-conservative because we cap at 32 bytes (truncation marker `…`
// appended if more). The error middleware injects this into the existing
// `console.warn` line so the log signature is identifiable without
// dumping the full body.
function hexEscapePrefix(buf, maxBytes = 32) {
  if (!buf || buf.length === 0) return '<no-body>';
  const len = Math.min(buf.length, maxBytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b === 0x5c) {
      out += '\\\\';
    } else if (b >= 0x20 && b < 0x7f) {
      out += String.fromCharCode(b);
    } else {
      out += '\\x' + b.toString(16).padStart(2, '0');
    }
  }
  if (buf.length > maxBytes) out += '…';
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Sprint 80 T1 (FR-4) — inject-vs-human-typing queue. When a human is actively
// typing in a panel, hold API injects and flush them FIFO on the human's next
// submit/clear (or when a later inject arrives after typing stops) so an
// agent-to-agent inject never interleaves mid-line. Default ON for
// orchestrator-tier panels only (Brad's ask); per-panel override via
// meta.holdInjectsWhileTyping. Thresholds are env-overridable, read at call
// time (no restart-order dependency). Module-scope + db-injected so the whole
// queue is unit-testable off a live server.
// ─────────────────────────────────────────────────────────────────────────

function resolveInjectHoldWindowMs() {
  const raw = Number(process.env.TERMDECK_INJECT_HOLD_WINDOW_MS);
  return (Number.isFinite(raw) && raw >= 0) ? raw : 4000;   // "actively typing" window
}
function resolveInjectQueueTtlMs() {
  const raw = Number(process.env.TERMDECK_INJECT_QUEUE_TTL_MS);
  return (Number.isFinite(raw) && raw > 0) ? raw : 30000;   // a held inject older than this is dropped, never fired into a stale context
}
function isInjectHoldEnabled(session) {
  const flag = session.meta && session.meta.holdInjectsWhileTyping;
  if (flag === true) return true;
  if (flag === false) return false;
  const role = session.meta && session.meta.role;
  return role === 'orchestrator' || role === 'master-orchestrator';
}
function shouldHoldInject(session, now) {
  if (!isInjectHoldEnabled(session)) return false;
  if (!session._inputBuffer || session._inputBuffer.length === 0) return false;
  const last = session._lastHumanKeystrokeAt || 0;
  return (now - last) < resolveInjectHoldWindowMs();
}

// Deliver one held inject to the PTY (honoring submit:true), then log it.
async function deliverQueuedInject(session, item, db) {
  const normalized = String(item.text == null ? '' : item.text)
    .replace(/\r\n?/g, '\r').replace(/\n/g, '\r');
  try {
    if (item.submit === true) {
      await submitToPty(session, normalized);
    } else {
      session.pty.write(normalized);
      session.trackInput(normalized);
    }
    session.meta.replyCount = (session.meta.replyCount || 0) + 1;
    if (db) {
      try {
        const snippet = item.fromSessionId ? `from:${item.fromSessionId}` : null;
        logCommand(db, session.id, String(item.text || '').slice(0, 500), snippet, item.source || 'user');
      } catch (err) { console.error('[db] logCommand (inject-queue) failed:', err); }
    }
  } catch (err) {
    console.error('[inject-queue] deliver failed:', err && err.message ? err.message : err);
  }
}

// Flush the held-inject queue FIFO. Drops injects older than the TTL. Serialized
// via `_injectFlushing` so a WS-triggered flush and a route-triggered drain
// can't interleave writes.
async function flushInjectQueue(session, db) {
  if (!session || !session._injectQueue || session._injectQueue.length === 0) return;
  if (session._injectFlushing) return;
  session._injectFlushing = true;
  try {
    const ttl = resolveInjectQueueTtlMs();
    while (session._injectQueue.length > 0) {
      const item = session._injectQueue.shift();
      const age = Date.now() - item.enqueuedAt;
      if (age > ttl) {
        console.warn(`[inject-queue] dropped stale inject (age ${age}ms > ttl ${ttl}ms) session=${session.id}`);
        continue;
      }
      if (!session.pty || (session.meta && session.meta.status === 'exited')) {
        session._injectQueue = [];   // panel gone — drop the rest
        break;
      }
      await deliverQueuedInject(session, item, db);
    }
  } finally {
    session._injectFlushing = false;
  }
}

function createServer(config) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Sprint 80 T1 (BR-1 — Brad's 2026-06-26 fleet cascade) — route-scoped
  // pre-parse normalization for POST /api/sessions/:id/input. Bash/curl inject
  // callers send JSON whose `text` contains the literal 4-char sequence `\x1b`
  // (backslash-x-1-b) — an INVALID JSON escape that express.json() rejects with
  // entity.parse.failed. Autonomous orch callers do NOT check the 400, so the
  // inject vanishes silently and the spawned panel never boots — the root of
  // the cascade that eventually crashed Brad's deck. This middleware, mounted
  // BEFORE express.json(), rewrites `\xNN` → the equivalent valid `\u00NN`
  // escape in the raw body so the intended real ESC-wrapped bracketed paste
  // lands in the PTY.
  //
  // Mechanism: it fully consumes the request stream, parses the normalized body
  // itself, and sets `req.body`; express.json() below then short-circuits via
  // `onFinished.isFinished(req)` (verified against body-parser 2.2.2
  // read.js:40 — the request stream is complete + no longer readable) and never
  // re-parses. `req.rawBody` is stamped with the ORIGINAL bytes so the
  // error-handler hex prefix shows what the caller actually sent.
  //
  // Scope + hazard (locked, PLANNING §3.1): applied ONLY on this exact route
  // (POST + the /input path) and ONLY to application/json bodies — every other
  // route keeps strict parsing. Accepted hazard: a caller who genuinely wants
  // the literal 4-char text `\x1b` written with a SINGLE backslash is already
  // sending invalid JSON (it 400'd before this fix); post-fix it becomes a real
  // ESC. Real-ESC intent dominates on /input, so this is accepted + documented
  // in docs/ARCHITECTURE.md § Input API. The even/odd backslash guard SHRINKS
  // the hazard: a PROPERLY escaped `\\x1b` (valid-JSON literal-text intent) is
  // left untouched.
  const INPUT_ROUTE_RE = /^\/api\/sessions\/[^/]+\/input$/;
  // Parity with express.json()'s default '100kb' limit (the mount below sets no
  // explicit limit), so a >100kb /input body 413s exactly as it does today.
  const INPUT_BODY_LIMIT = 100 * 1024;

  // Rewrite REAL `\xNN` / `\XNN` escapes (ODD-length backslash run — the last
  // backslash escapes the x) to `\u00NN`. An even run (`\\x…`) is a valid
  // escaped backslash + literal text and is left as-is, so legitimate literal
  // `\x` content is never corrupted.
  function normalizeXEscapes(s) {
    return s.replace(/(\\+)[xX]([0-9a-fA-F]{2})/g, (m, slashes, hex) => {
      if (slashes.length % 2 === 1) {
        return slashes.slice(0, -1) + '\\u00' + hex;
      }
      return m;
    });
  }

  app.use((req, res, next) => {
    if (req.method !== 'POST' || !INPUT_ROUTE_RE.test(req.path)) return next();
    const ctype = req.headers['content-type'] || '';
    // Non-JSON bodies fall through to normal handling (express.json skips them;
    // the route returns its own 400 "Missing text").
    if (!/application\/json/i.test(ctype)) return next();

    const chunks = [];
    let size = 0;
    let finished = false;
    const fail = (err) => { if (!finished) { finished = true; next(err); } };
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > INPUT_BODY_LIMIT) {
        const err = new Error('request entity too large');
        err.type = 'entity.too.large';
        err.statusCode = 413;
        err.status = 413;
        return fail(err);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      const raw = Buffer.concat(chunks);
      req.rawBody = raw;   // original bytes for the error-handler hex prefix
      if (raw.length === 0) {
        // Empty body: mirror body-parser (leave req.body undefined; the route
        // returns its own 400 "Missing text").
        return next();
      }
      const text = raw.toString('utf8');
      try {
        req.body = JSON.parse(normalizeXEscapes(text));
        req._body = true;  // body-parser convention; the real skip is isFinished(req)
        return next();
      } catch (parseErr) {
        // Still malformed AFTER normalization (e.g. a structural error or a raw
        // control char) — forward as the SAME entity.parse.failed shape the
        // global error handler already renders, now with the extended hint.
        const err = new Error(parseErr.message);
        err.type = 'entity.parse.failed';
        err.statusCode = 400;
        err.status = 400;
        return next(err);
      }
    });
    req.on('error', (streamErr) => fail(streamErr));
  });

  // Sprint 60 v1.0.14 (Item 2) — pre-screen incoming JSON bodies for unescaped
  // control characters in string contexts. Brad's 2026-05-07 r730 crash
  // forensic logged 9x `SyntaxError: Bad control character in string literal
  // in JSON at position 9` per 13h uptime. The post-Sprint-56 error-handler
  // already returns a structured 400, but body-parser's internal
  // `JSON.parse(body)` throws a verbose SyntaxError whose 10-line stack trace
  // dumps to stderr (Express dev-mode default error logger). The verify
  // callback below fails earlier with a tight ControlCharBodyError that our
  // handler logs as a single-line warning instead of a stack trace.
  //
  // Most likely source of these bodies: agent-to-agent inject through
  // /api/sessions/:id/input where the `text` field contains raw PTY escape
  // sequences (e.g. one panel forwarding terminal output to another). The
  // 400 response is the correct user-facing semantic; this just quiets the
  // logs so real errors aren't drowned in noise.
  app.use(express.json({
    verify: (req, res, buf) => {
      // Sprint 63 T1 (Item 1.3) — capture a stable copy of the raw body so
      // the error middleware below can render a 32-byte hex-escaped prefix.
      // `Buffer.from(buf)` copies because express may pool the underlying
      // accumulator across requests; without the copy the error handler
      // could see bytes from a later request.
      req.rawBody = Buffer.from(buf);

      // O(N) single-pass scan. Only checks bytes inside double-quoted string
      // regions so structural whitespace doesn't trigger false positives.
      let inString = false;
      let escape = false;
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (!inString) {
          if (b === 0x22) inString = true; // "
          continue;
        }
        if (escape) { escape = false; continue; }
        if (b === 0x5c) { escape = true; continue; }     // backslash
        if (b === 0x22) { inString = false; continue; } // closing quote
        // JSON forbids unescaped control chars (0x00-0x1F and 0x7F) inside
        // string literals. Reject with a structured error.
        if (b < 0x20 || b === 0x7f) {
          const err = new Error(`Body contains illegal control character 0x${b.toString(16).padStart(2, '0')} at byte ${i}`);
          err.type = 'entity.verify.failed';
          err.statusCode = 400;
          err.code = 'CONTROL_CHAR_IN_STRING';
          throw err;
        }
      }
    },
  }));

  // Sprint 56 (T2 F-T2-1) — malformed-JSON body returns JSON 400, not
  // express's default HTML error page. Pre-Sprint-56 every POST/PATCH
  // endpoint that consumed a JSON body returned `text/html` on parse
  // failure, breaking programmatic clients (the inject script, MCP, CI
  // smoke tests). The status code (400) was correct; only the body
  // shape regressed. Mounted IMMEDIATELY after express.json() so it
  // catches body-parse errors before any route handler runs.
  //
  // Sprint 60 v1.0.14 — extended to also catch `entity.verify.failed` from
  // the control-char pre-screen above, AND to log via console.warn (single
  // line) instead of letting Express's default error logger dump a 10-line
  // stack trace to stderr.
  app.use((err, req, res, next) => {
    if (err && (
      err.type === 'entity.parse.failed' ||
      err.type === 'entity.verify.failed' ||
      err instanceof SyntaxError
    )) {
      // Sprint 63 T1 (Item 1.3) — append a 32-byte hex-escaped prefix of the
      // raw body so the operator can identify which caller is sending bad
      // JSON without exposing the full payload. Falls through to `<no-body>`
      // if the verify callback never ran (parse error before verify, or no
      // body at all).
      const prefix = hexEscapePrefix(req.rawBody);
      console.warn(`[body-parser] ${err.code || err.type || 'parse-error'}: ${err.message} (${req.method} ${req.path}) prefix="${prefix}"`);
      return res.status(400).json({
        error: 'Malformed JSON body',
        detail: err.message,
        code: err.code,
        // Sprint 80 T1 (BR-1, PLANNING §3.2) — "the 400 stays loud and gets
        // louder." Silent-swallow by autonomous callers was half of Brad's
        // 2026-06-26 cascade, so name the exact fix: how to encode a control
        // byte AND that /input now auto-normalizes literal \xNN.
        hint: 'JSON allows only \\", \\\\, \\/, \\b, \\f, \\n, \\r, \\t and \\uXXXX escapes. For an ESC/control byte use \\u001b (not \\x1b). POST /api/sessions/:id/input additionally auto-normalizes literal \\xNN escapes to \\u00NN, so a 400 there means the body is malformed for another reason.',
      });
    }
    return next(err);
  });

  // First-run detection (Sprint 19 T3): true when ~/.termdeck/config.yaml
  // does not exist. Surfaced on /api/config so the client can offer the
  // setup wizard on first visit. T1's /api/setup endpoint may reuse this.
  const firstRun = !fs.existsSync(path.join(os.homedir(), '.termdeck', 'config.yaml'));

  // Optional token auth (Sprint 9 T3). Zero-op when no token is configured,
  // so local users see no behavior change. Mounted before static + routes so
  // unauthenticated requests never touch app.js / index.html.
  const authMiddleware = createAuthMiddleware(config);
  if (authMiddleware) {
    app.use(authMiddleware);
    console.log('[auth] Token authentication enabled');
  }

  // Serve client files
  const clientDir = path.join(__dirname, '..', '..', 'client', 'public');
  app.use(express.static(clientDir));

  // Serve repo-rooted /docs as static markdown so the dashboard right-rail Guide
  // panel can fetch docs/orchestrator-guide.md and render it client-side.
  // Sprint 37 T1.
  const docsDir = path.join(__dirname, '..', '..', '..', 'docs');
  if (fs.existsSync(docsDir)) {
    app.use('/docs', express.static(docsDir));
  }

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
      // Sprint 59 T4-CODEX cleanup: reap upload tempdirs whose owning session is
      // exited or unknown (crashed processes, hard kills, pre-this-version dirs).
      try {
        const uploadsRoot = path.join(os.tmpdir(), 'termdeck-uploads');
        if (fs.existsSync(uploadsRoot)) {
          const liveIds = new Set();
          try {
            for (const row of db.prepare('SELECT id FROM sessions WHERE exited_at IS NULL').all()) {
              liveIds.add(row.id);
            }
          } catch (_e) { /* live-set empty → all dirs are stale */ }
          let reaped = 0;
          for (const dir of fs.readdirSync(uploadsRoot)) {
            if (!liveIds.has(dir)) {
              try { fs.rmSync(path.join(uploadsRoot, dir), { recursive: true, force: true }); reaped++; } catch (_e) {}
            }
          }
          if (reaped > 0) console.log(`[uploads] Reaped ${reaped} stale upload tempdir(s)`);
        }
      } catch (_err) { /* non-blocking */ }
      console.log('[db] SQLite initialized');
    } catch (err) {
      console.warn('[db] SQLite init failed:', err.message);
    }
  }

  // Initialize session manager
  const sessions = new SessionManager(db);

  // Sprint 80 T2 (FR-5 + FR-6) — wire the context-telemetry module to this
  // server's config + spawn/teardown surfaces (once). The config provider feeds
  // resolveContextConfig; the kill impl terminates (and optionally respawns) a
  // panel that breaches its ceiling. `notify` (default) needs neither — it only
  // sets meta.contextAlert (rides status_broadcast) + optional webhook.
  _setContextConfigProvider(() => (config && config.context) || {});
  _setContextKillImpl((session, { respawn } = {}) => {
    const meta = (session && session.meta) || {};
    const respawnDesc = respawn
      ? {
          command: meta.command,
          cwd: meta.cwd,
          project: meta.project,
          label: meta.label,
          type: meta.type,
          theme: meta.theme,
          reason: `auto-respawn after context ceiling (prev ${String(session.id).slice(0, 8)})`,
          role: meta.role,
        }
      : null;
    // Terminate via the PTY's own kill → onExit runs the normal teardown
    // (broadcast, timer clears, context-watch teardown) so we don't duplicate it.
    try { if (session.pty) session.pty.kill(); } catch (_e) { /* already gone */ }
    if (respawnDesc && respawnDesc.command) {
      try { spawnTerminalSession(respawnDesc); }
      catch (err) { console.error('[context] respawn failed:', err && err.message ? err.message : err); }
    }
  });

  // PTY orphan reaper (Sprint 42 T2). Periodically walks the live process
  // tree, tracks descendants of each session's shell PTY, and SIGTERMs any
  // that survive the leader's death — closing the kern.tty.ptmx_max leak
  // path that bit Joshua on 2026-04-28 (forkpty: Device not configured).
  // Skipped when node-pty is unavailable (no PTYs to reap) and when the
  // explicit kill switch is set (tests / opt-out).
  const ptyReaperEnabled = pty
    && process.env.TERMDECK_PTY_REAPER !== 'off'
    && config.ptyReaper?.enabled !== false;
  const ptyReaperIntervalMs = Number.parseInt(
    process.env.TERMDECK_PTY_REAPER_INTERVAL_MS
      || config.ptyReaper?.intervalMs
      || 30000,
    10
  );
  const ptyReaper = ptyReaperEnabled
    ? createPtyReaper({ sessions, intervalMs: ptyReaperIntervalMs })
    : null;
  if (ptyReaper) {
    ptyReaper.start();
    console.log(`[pty-reaper] enabled (interval ${ptyReaperIntervalMs}ms)`);
  } else if (!pty) {
    console.log('[pty-reaper] disabled (node-pty unavailable)');
  } else {
    console.log('[pty-reaper] disabled by config');
  }

  // Initialize RAG + Mnestra bridge
  const rag = new RAGIntegration(config, db);
  const mnestraBridge = createBridge(config);
  console.log(`[mnestra-bridge] mode=${mnestraBridge.mode}`);

  // Sprint 38 / T3 — let RAGIntegration delegate vector recall to the
  // bridge so we don't duplicate the embed pipeline. Graph recall stays
  // in rag.js because it's a different RPC and doesn't share the
  // direct/webhook/mcp mode shape.
  rag.setBridge(mnestraBridge);
  if (rag.graphRecall) {
    console.log(
      `[rag] graph-aware recall ENABLED (depth=${rag.graphRecallDepth}, k=${rag.graphRecallK}, half-life=${rag.graphRecallRecencyHalflifeDays}d)`
    );
  }

  // Initialize transcript writer (Session Transcripts — Sprint 6)
  const transcriptConfig = config.transcripts || {};
  const transcriptEnabled = transcriptConfig.enabled !== undefined
    ? transcriptConfig.enabled
    : !!process.env.DATABASE_URL;
  let transcriptWriter = null;
  if (transcriptEnabled && process.env.DATABASE_URL) {
    transcriptWriter = new TranscriptWriter(process.env.DATABASE_URL, {
      batchSize: transcriptConfig.batchSize || 50,
      flushIntervalMs: transcriptConfig.flushIntervalMs || 2000,
      enabled: true
    });
    console.log('[transcript] Writer initialized (flush every %dms, batch %d)',
      transcriptConfig.flushIntervalMs || 2000, transcriptConfig.batchSize || 50);
  } else {
    console.log('[transcript] Writer disabled (no DATABASE_URL or transcripts.enabled=false)');
  }

  // Sprint 79 T3 — doctrine-sync: default-OFF worktree poller that
  // materializes rumen's drafted doctrine_registry rows into a termdeck PR.
  // maybeStart() itself checks TERMDECK_DOCTRINE_REPO + runs the boot
  // preflight (git repo + expected remote + gh auth + gitleaks present) and
  // no-ops with one log line when either is missing — required so this is
  // lazy-required here rather than at module load, matching the cost-when-
  // unused convention every other optional feature in this file follows.
  try {
    require('./doctrine-sync').maybeStart();
  } catch (err) {
    console.warn('[doctrine-sync] failed to initialize (fail-soft):', err && err.message);
  }

  // Wire RAG to session events
  sessions.on('session:created', (s) => rag.onSessionCreated(s));
  sessions.on('session:removed', (s) => rag.onSessionEnded(s));

  // ==================== REST API ====================

  // GET /api/health - preflight health checks (Sprint 6 T1, wired by T3)
  // SECURITY NOTE: Returns operational detail (memory counts, DB latency, project paths,
  // RAG breaker state). Intentional for local-first use — TermDeck binds to 127.0.0.1 by
  // default and the CLI guardrail blocks beyond-localhost binds without explicit opt-in.
  // For any non-loopback deployment (Sprint 18+ remote story), gate this route behind auth
  // or scope the response to a minimal {status, version} payload.
  app.get('/api/health', createHealthHandler(config));

  // GET /api/health/full - v0.7.0 runtime health snapshot (Sprint 32 T3)
  // Mirrors the install-time auditPreconditions/verifyOutcomes pattern from
  // v0.6.9 at runtime: re-runs the same SELECTs against pg_extension,
  // vault.decrypted_secrets, cron.job, and information_schema.columns so a
  // post-install drift (extension toggled off, schedule paused, stale loader
  // shadow) is observable without a re-install. Cached 30s; pass ?refresh=1
  // to bypass. Required checks drive the response status (200 ok / 503 fail);
  // warn checks (mnestra-webhook, rumen-pool) never flip ok.
  app.get('/api/health/full', async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    try {
      const report = await getFullHealth(config, { refresh, db });
      res.status(report.ok ? 200 : 503).json(report);
    } catch (err) {
      res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  // GET /api/setup - setup wizard tier status (Sprint 19 T1)
  // Reuses preflight checks (mnestra_reachable, rumen_recent) and pairs them
  // with filesystem + config signals to classify which of the 4 TermDeck tiers
  // the user has reached:
  //   1. TermDeck running (always active when this handler responds)
  //   2. Mnestra reachable + DATABASE_URL available (partial if only reachable)
  //   3. Rumen job seen recently (partial if DATABASE_URL set but no recent job)
  //   4. At least one project configured in config.yaml
  // Cached for 60s so the setup UI can poll without re-running shell/PTY probes.
  const SETUP_CONFIG_DIR = path.join(os.homedir(), '.termdeck');
  const SETUP_SECRETS_PATH = path.join(SETUP_CONFIG_DIR, 'secrets.env');
  const SETUP_CACHE_TTL_MS = 60_000;
  let _setupCache = null;
  let _setupCachedAt = 0;

  app.get('/api/setup', async (req, res) => {
    if (_setupCache && (Date.now() - _setupCachedAt) < SETUP_CACHE_TTL_MS) {
      return res.json(_setupCache);
    }

    try {
      const preflight = await runPreflight(config);
      const byName = {};
      for (const c of preflight.checks) byName[c.name] = c;

      const hasConfigFile = !firstRun;
      const hasSecretsFile = fs.existsSync(SETUP_SECRETS_PATH);
      const hasDatabaseUrl = !!process.env.DATABASE_URL;
      const hasMnestraRunning = !!(byName.mnestra_reachable && byName.mnestra_reachable.passed);
      const hasRumenDeployed = !!(byName.rumen_recent && byName.rumen_recent.passed);
      const projectCount = Object.keys(config.projects || {}).length;

      const tier1 = {
        status: 'active',
        detail: `TermDeck running on :${config.port || 3000}`
      };

      let tier2;
      if (hasMnestraRunning && hasDatabaseUrl) {
        tier2 = {
          status: 'active',
          detail: byName.mnestra_reachable.detail || 'Mnestra reachable'
        };
      } else if (hasMnestraRunning && !hasDatabaseUrl) {
        tier2 = {
          status: 'partial',
          detail: 'Mnestra reachable but DATABASE_URL not set'
        };
      } else {
        tier2 = {
          status: 'not_configured',
          detail: (byName.mnestra_reachable && byName.mnestra_reachable.detail) || 'Mnestra not reachable'
        };
      }

      let tier3;
      if (hasRumenDeployed) {
        tier3 = { status: 'active', detail: byName.rumen_recent.detail };
      } else if (hasDatabaseUrl && byName.rumen_recent &&
                 /no completed Rumen jobs|stale/i.test(byName.rumen_recent.detail || '')) {
        tier3 = { status: 'partial', detail: byName.rumen_recent.detail };
      } else {
        tier3 = {
          status: 'not_configured',
          detail: (byName.rumen_recent && byName.rumen_recent.detail) || 'Rumen not deployed'
        };
      }

      const tier4 = projectCount > 0
        ? { status: 'active', detail: `${projectCount} project${projectCount === 1 ? '' : 's'} configured` }
        : { status: 'not_configured', detail: 'No project paths in config.yaml' };

      const tiers = { 1: tier1, 2: tier2, 3: tier3, 4: tier4 };

      // Current tier = highest contiguous tier with status active or partial.
      let tier = 0;
      for (let i = 1; i <= 4; i++) {
        if (tiers[i].status === 'active' || tiers[i].status === 'partial') {
          tier = i;
        } else {
          break;
        }
      }

      const payload = {
        tier,
        tiers,
        config: {
          hasSecretsFile,
          hasConfigFile,
          hasDatabaseUrl,
          hasMnestraRunning,
          hasRumenDeployed,
          projectCount
        },
        firstRun
      };

      _setupCache = payload;
      _setupCachedAt = Date.now();
      res.json(payload);
    } catch (err) {
      console.error('[setup] /api/setup failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/setup/configure - Sprint 23 T2
  // Accepts pasted credentials from the browser wizard, validates each,
  // then writes ~/.termdeck/secrets.env (chmod 600) and updates
  // ~/.termdeck/config.yaml with rag.enabled: true plus ${VAR} references.
  // Security: the bind guardrail refuses non-loopback binds without auth,
  // so this endpoint only ever responds on 127.0.0.1 in the default config.
  app.post('/api/setup/configure', async (req, res) => {
    const b = req.body || {};
    const supabaseUrl = typeof b.supabaseUrl === 'string' ? b.supabaseUrl.trim() : '';
    const supabaseServiceRoleKey = typeof b.supabaseServiceRoleKey === 'string' ? b.supabaseServiceRoleKey.trim() : '';
    const openaiApiKey = typeof b.openaiApiKey === 'string' ? b.openaiApiKey.trim() : '';
    const anthropicApiKey = typeof b.anthropicApiKey === 'string' ? b.anthropicApiKey.trim() : '';
    const databaseUrl = typeof b.databaseUrl === 'string' ? b.databaseUrl.trim() : '';

    const missing = [];
    if (!supabaseUrl) missing.push('supabaseUrl');
    if (!supabaseServiceRoleKey) missing.push('supabaseServiceRoleKey');
    if (!openaiApiKey) missing.push('openaiApiKey');
    if (!databaseUrl) missing.push('databaseUrl');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: `Missing required credentials: ${missing.join(', ')}`
      });
    }

    if (!/^https?:\/\//i.test(supabaseUrl)) {
      return res.status(400).json({
        success: false,
        error: 'supabaseUrl must start with http:// or https://'
      });
    }

    const [supaRes, oaiRes, dbRes] = await Promise.all([
      validateSupabase(supabaseUrl, supabaseServiceRoleKey).catch((e) => ({ ok: false, detail: e.message })),
      validateOpenAI(openaiApiKey).catch((e) => ({ ok: false, detail: e.message })),
      validateDatabase(databaseUrl).catch((e) => ({ ok: false, detail: e.message }))
    ]);
    const validation = { supabase: supaRes, openai: oaiRes, database: dbRes };

    const allValid = validation.supabase.ok && validation.openai.ok && validation.database.ok;
    if (!allValid) {
      return res.status(400).json({
        success: false,
        validation,
        error: 'One or more credentials failed validation'
      });
    }

    try {
      if (!fs.existsSync(SETUP_CONFIG_DIR)) {
        fs.mkdirSync(SETUP_CONFIG_DIR, { recursive: true });
      }

      const secretsBody = buildSecretsEnv({
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
        OPENAI_API_KEY: openaiApiKey,
        ANTHROPIC_API_KEY: anthropicApiKey,
        DATABASE_URL: databaseUrl
      });
      const tmpPath = SETUP_SECRETS_PATH + '.tmp';
      fs.writeFileSync(tmpPath, secretsBody, { mode: 0o600 });
      fs.renameSync(tmpPath, SETUP_SECRETS_PATH);
      try { fs.chmodSync(SETUP_SECRETS_PATH, 0o600); } catch (err) {
        console.warn('[setup] chmod 600 on secrets.env failed:', err.message);
      }

      process.env.SUPABASE_URL = supabaseUrl;
      process.env.SUPABASE_SERVICE_ROLE_KEY = supabaseServiceRoleKey;
      process.env.OPENAI_API_KEY = openaiApiKey;
      if (anthropicApiKey) process.env.ANTHROPIC_API_KEY = anthropicApiKey;
      process.env.DATABASE_URL = databaseUrl;

      updateConfigYamlForRag(config);

      _setupCache = null;
      _setupCachedAt = 0;

      console.log('[setup] Credentials saved, RAG enabled via wizard');

      return res.json({
        success: true,
        tier: 2,
        detail: 'Secrets saved, RAG enabled',
        validation
      });
    } catch (err) {
      console.error('[setup] /api/setup/configure write failed:', err.message);
      return res.status(500).json({
        success: false,
        validation,
        error: `Failed to write config: ${err.message}`
      });
    }
  });

  // POST /api/setup/migrate - auto-run all 7 bootstrap migrations (Sprint 23 T3)
  // Invoked by the browser setup wizard after credentials are saved. Reloads
  // ~/.termdeck/secrets.env so DATABASE_URL picks up T2's just-written value
  // without a server restart, then streams per-migration status to the server
  // log and returns an aggregate result to the client. Idempotent — all seven
  // migration files (6 Mnestra + 1 transcript) are authored with IF NOT EXISTS
  // / CREATE OR REPLACE so re-runs are safe.
  const { migrationRunner: _migrationRunner, dotenv: _dotenv } = require('./setup');
  let _migrateInFlight = false;
  app.post('/api/setup/migrate', async (req, res) => {
    if (_migrateInFlight) {
      return res.status(409).json({ ok: false, error: 'Migration already in progress' });
    }
    _migrateInFlight = true;

    // Invalidate the /api/setup cache — tier status will shift once migrations land.
    _setupCache = null;
    _setupCachedAt = 0;

    try {
      // Re-read secrets.env so a freshly saved DATABASE_URL is visible without
      // a restart. dotenv-io will not clobber pre-set process.env entries.
      try {
        const secrets = _dotenv.readSecrets();
        for (const [k, v] of Object.entries(secrets)) {
          if (process.env[k] === undefined || process.env[k] === '') {
            process.env[k] = v;
          }
        }
      } catch (_err) { /* optional refresh — fall back to explicit lookup */ }

      const databaseUrl = _migrationRunner.resolveDatabaseUrl(req.body && req.body.databaseUrl);
      if (!databaseUrl) {
        _migrateInFlight = false;
        return res.status(400).json({
          ok: false,
          error: 'DATABASE_URL not set. Save credentials in the setup wizard first.'
        });
      }

      const total = _migrationRunner.listAllMigrations().length;
      console.log(`[setup] /api/setup/migrate starting (${total} migrations)`);

      const events = [];
      const result = await _migrationRunner.runAll({
        databaseUrl,
        onProgress: (event) => {
          events.push(event);
          if (event.type === 'step' && event.status === 'running') {
            console.log(`[setup] Migration ${event.index}/${event.total}: ${event.file}...`);
          } else if (event.type === 'step' && event.status === 'done') {
            console.log(`[setup] Migration ${event.index}/${event.total}: ${event.file} ✓ (${event.elapsedMs}ms)`);
          } else if (event.type === 'step' && event.status === 'failed') {
            console.error(`[setup] Migration ${event.index}/${event.total}: ${event.file} ✗ ${event.error}`);
          }
        }
      });

      console.log(`[setup] Migrations ${result.ok ? 'complete' : 'halted'} (${result.applied}/${result.total} applied)`);
      res.json({ ok: result.ok, ...result, events });
    } catch (err) {
      console.error('[setup] /api/setup/migrate failed:', err.message);
      res.status(500).json({ ok: false, error: err.message, code: err.code || null });
    } finally {
      _migrateInFlight = false;
    }
  });

  // ── Sprint 25 T2 — Supabase MCP wizard endpoints ──────────────────────────
  //
  // Three thin orchestrators that let the Tier-2 setup wizard skip the manual
  // 4-credential paste step. They sit on top of T1's `supabase-mcp.callTool`
  // bridge plus the existing Sprint 23 `configure` + `migrate` flow. The PAT
  // travels in the request body for the lifetime of the call only — it is
  // never persisted, never echoed, and never logged.
  let _supabaseMcp = null;
  try {
    _supabaseMcp = require('./setup/supabase-mcp');
  } catch (_err) {
    // T1's bridge module may not exist yet on a fresh checkout, or the user
    // may not have `@supabase/mcp-server-supabase` on PATH. Either case
    // surfaces as `code: 'mcp_not_installed'` at request time.
  }
  let _supabaseSelectInFlight = false;

  function _mapMcpError(err) {
    const code = err && (err.code || (err.cause && err.cause.code));
    const msg = (err && err.message) || '';
    if (code === 'mcp_not_installed' || code === 'ENOENT' || /not.*installed|cannot.*spawn|module not found/i.test(msg)) {
      return {
        status: 400,
        body: { ok: false, code: 'mcp_not_installed', detail: 'run: npm install -g @supabase/mcp-server-supabase' }
      };
    }
    if (code === 'mcp_timeout' || code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) {
      return { status: 504, body: { ok: false, code: 'mcp_timeout' } };
    }
    return { status: 401, body: { ok: false, code: 'pat_invalid', detail: msg || 'PAT verification failed' } };
  }

  function _ensureMcpAvailable(res) {
    if (_supabaseMcp && typeof _supabaseMcp.callTool === 'function') return true;
    res.status(400).json({
      ok: false,
      code: 'mcp_not_installed',
      detail: 'run: npm install -g @supabase/mcp-server-supabase'
    });
    return false;
  }

  // POST /api/setup/supabase/connect — verify a PAT works by listing projects.
  // We only return the count; the project list itself is fetched by /projects.
  app.post('/api/setup/supabase/connect', async (req, res) => {
    const pat = (req.body && typeof req.body.pat === 'string') ? req.body.pat : '';
    if (!pat) {
      return res.status(400).json({ ok: false, code: 'pat_invalid', detail: 'pat field is required' });
    }
    if (!_ensureMcpAvailable(res)) return;
    try {
      const result = await _supabaseMcp.callTool(pat, 'list_projects', {}, { timeoutMs: 6000 });
      const list = Array.isArray(result)
        ? result
        : (Array.isArray(result && result.projects) ? result.projects : []);
      console.log(`[setup] supabase/connect ok (${list.length} projects)`);
      return res.json({ ok: true, projectCount: list.length });
    } catch (err) {
      const m = _mapMcpError(err);
      console.warn(`[setup] supabase/connect failed: ${m.body.code}`);
      return res.status(m.status).json(m.body);
    }
  });

  // POST /api/setup/supabase/projects — return a stable-shape project list.
  // Mapping isolates the wizard from MCP field-name churn.
  app.post('/api/setup/supabase/projects', async (req, res) => {
    const pat = (req.body && typeof req.body.pat === 'string') ? req.body.pat : '';
    if (!pat) {
      return res.status(400).json({ ok: false, code: 'pat_invalid', detail: 'pat field is required' });
    }
    if (!_ensureMcpAvailable(res)) return;
    try {
      const result = await _supabaseMcp.callTool(pat, 'list_projects', {}, { timeoutMs: 6000 });
      const raw = Array.isArray(result)
        ? result
        : (Array.isArray(result && result.projects) ? result.projects : []);
      const projects = raw.map((p) => ({
        id: (p && (p.id || p.ref || p.project_id)) || '',
        name: (p && p.name) || '',
        region: (p && (p.region || p.region_name)) || null,
        createdAt: (p && (p.createdAt || p.created_at)) || null,
      }));
      console.log(`[setup] supabase/projects ok (${projects.length} returned)`);
      return res.json({ ok: true, projects });
    } catch (err) {
      const m = _mapMcpError(err);
      console.warn(`[setup] supabase/projects failed: ${m.body.code}`);
      return res.status(m.status).json(m.body);
    }
  });

  // POST /api/setup/supabase/select — full chain: MCP → configure → migrate.
  // Concurrency guarded by a module-scoped boolean — second call gets 409.
  app.post('/api/setup/supabase/select', async (req, res) => {
    if (_supabaseSelectInFlight) {
      return res.status(409).json({ ok: false, code: 'select_in_flight', error: 'Supabase select already in progress' });
    }
    const pat = (req.body && typeof req.body.pat === 'string') ? req.body.pat : '';
    const projectId = (req.body && typeof req.body.projectId === 'string') ? req.body.projectId.trim() : '';
    if (!pat || !projectId) {
      return res.status(400).json({ ok: false, code: 'bad_request', detail: 'pat and projectId are required' });
    }
    if (!_ensureMcpAvailable(res)) return;

    _supabaseSelectInFlight = true;
    try {
      // 1. Pull credentials via MCP. Prefer the bundled tool if T1 ships one;
      //    fall back to the four single-field tools so we are robust to either
      //    bridge shape.
      let creds;
      try {
        creds = await _supabaseMcp.callTool(pat, 'fetch_project_credentials', { projectId }, { timeoutMs: 8000 });
      } catch (errBundle) {
        const code = errBundle && errBundle.code;
        const msg = (errBundle && errBundle.message) || '';
        const isUnknownTool = code === 'unknown_tool' || /unknown.?tool|method not found|no such tool/i.test(msg);
        if (!isUnknownTool) throw errBundle;
        const [proj, anon, service, db] = await Promise.all([
          _supabaseMcp.callTool(pat, 'get_project', { projectId }, { timeoutMs: 6000 }),
          _supabaseMcp.callTool(pat, 'get_anon_key', { projectId }, { timeoutMs: 6000 }),
          _supabaseMcp.callTool(pat, 'get_service_role_key', { projectId }, { timeoutMs: 6000 }),
          _supabaseMcp.callTool(pat, 'get_database_url', { projectId }, { timeoutMs: 6000 }),
        ]);
        creds = {
          url: (proj && (proj.url || proj.api_url)) || '',
          anonKey: (anon && (anon.key || anon.anon_key)) || (typeof anon === 'string' ? anon : ''),
          serviceRoleKey: (service && (service.key || service.service_role_key)) || (typeof service === 'string' ? service : ''),
          databaseUrl: (db && (db.connectionString || db.url || db.database_url)) || (typeof db === 'string' ? db : ''),
        };
      }

      const supabaseUrl = (creds && (creds.url || creds.supabaseUrl || creds.api_url)) || '';
      const serviceRoleKey = (creds && (creds.serviceRoleKey || creds.service_role_key)) || '';
      const databaseUrl = (creds && (creds.databaseUrl || creds.database_url)) || '';
      const anonKey = (creds && (creds.anonKey || creds.anon_key)) || '';

      if (!supabaseUrl || !serviceRoleKey || !databaseUrl) {
        return res.status(502).json({
          ok: false,
          code: 'mcp_incomplete',
          detail: 'MCP did not return all required credentials (url, service role key, database url)'
        });
      }

      // 2. Hand off to existing /api/setup/configure via in-process loopback
      //    fetch. This keeps Sprint 23's validators and writers as the single
      //    source of truth — no validation logic is duplicated here.
      const port = (config && config.port) || 3000;
      const headers = { 'content-type': 'application/json' };
      if (req.headers.authorization) headers.authorization = req.headers.authorization;

      const openaiApiKey = (req.body && typeof req.body.openaiApiKey === 'string')
        ? req.body.openaiApiKey
        : (process.env.OPENAI_API_KEY || '');
      const anthropicApiKey = (req.body && typeof req.body.anthropicApiKey === 'string')
        ? req.body.anthropicApiKey
        : (process.env.ANTHROPIC_API_KEY || '');

      const configureRes = await fetch(`http://127.0.0.1:${port}/api/setup/configure`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          supabaseUrl,
          supabaseServiceRoleKey: serviceRoleKey,
          databaseUrl,
          openaiApiKey,
          anthropicApiKey,
          // anonKey is not part of the Sprint 23 contract — we hold it here
          // for parity with future runtime needs but do not pass it on.
        })
      });
      const configureBody = await configureRes.json().catch(() => ({}));
      if (!configureRes.ok || configureBody.success === false) {
        const status = configureRes.status >= 400 ? configureRes.status : 500;
        return res.status(status).json({
          ok: false,
          code: 'configure_failed',
          detail: configureBody.error || 'configure step failed',
          validation: configureBody.validation || null,
        });
      }

      // 3. Trigger /api/setup/migrate. Pass databaseUrl explicitly so we don't
      //    depend on the migrate endpoint's dotenv refresh ordering.
      const migrateRes = await fetch(`http://127.0.0.1:${port}/api/setup/migrate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ databaseUrl })
      });
      const migrateBody = await migrateRes.json().catch(() => ({}));
      if (!migrateRes.ok || migrateBody.ok === false) {
        const status = migrateRes.status >= 400 ? migrateRes.status : 500;
        return res.status(status).json({
          ok: false,
          code: 'migrate_failed',
          detail: migrateBody.error || 'migrate step failed',
          applied: migrateBody.applied || 0,
        });
      }

      console.log(`[setup] supabase/select complete (${migrateBody.applied || 0} migrations applied)`);
      // Mark the anonKey unused so lint stays clean — see comment above.
      void anonKey;
      return res.json({
        ok: true,
        configured: true,
        migrated: true,
        validation: configureBody.validation || null,
        applied: migrateBody.applied || 0,
      });
    } catch (err) {
      const m = _mapMcpError(err);
      console.warn(`[setup] supabase/select failed: ${m.body.code}`);
      return res.status(m.status).json(m.body);
    } finally {
      _supabaseSelectInFlight = false;
    }
  });

  // GET /api/sessions - list all active sessions
  app.get('/api/sessions', (req, res) => {
    // Sprint 65 T2 (2.2) — exited (dead-PTY) sessions are excluded by default
    // so an orchestrator polling this endpoint doesn't see dead panels as
    // live (Brad's "18 windows open, 10 were dead codex cli" — BACKLOG § D.5).
    // `?includeExited=true` returns the legacy full shape for `termdeck
    // doctor` + debug tooling. The 2s status_broadcast is intentionally NOT
    // filtered (it calls bare getAll()) so the dashboard's missed-exit
    // reconciliation still has exited sessions to work from.
    const includeExited = req.query.includeExited === 'true';
    res.json(sessions.getAll({ includeExited }));
  });

  // Reusable PTY spawn + wire helper. Used by POST /api/sessions and the
  // in-dashboard 4+1 sprint runner (Sprint 37 T4) so multi-panel spawns reuse
  // the same wiring (transcripts, RAG, Mnestra flashback) without copy-paste.
  // Returns the Session object regardless of PTY success — status will be
  // 'errored' if pty.spawn threw.
  // ────────────────────────────────────────────────────────────────────────
  // Sprint 72 T2 (Workstream B) — web-chat panel lifecycle.
  //
  // A `web-chat` session is driven by T1's CDP render-bridge against a real
  // grok.com tab, NOT node-pty. These closures are the server seams that
  // consume the `web-chat-grok` adapter + the driver, reusing the SAME
  // inject/read/transcript/capture machinery the PTY panels use. The PTY path
  // (`if (pty)` in spawnTerminalSession) is left byte-identical (Guardrail 3);
  // everything web-chat is gated on `session.meta.type === 'web-chat'`.
  // ────────────────────────────────────────────────────────────────────────

  // Per-server panel counter so each web-chat panel gets a distinct CDP port
  // (T1's profile.js: "T2 allocates a distinct port per panel"). The first
  // panel uses the canonical 'grok' profile + base port — the warm-login
  // location the human signs into once. Additional concurrent panels get their
  // own profile + port (their own Chrome). NOTE: that means panel ≥2 has an
  // ISOLATED Grok login, not the shared one — the shared-browser-multi-tab
  // model is a follow-up (flagged in STATUS); single-panel is the sprint scope.
  let _webChatPanelSeq = 0;

  // Resolve the dedicated profile (NAME → T1's resolveProfileDir maps it to
  // ~/.termdeck/web-chat-profiles/<name>; an absolute path is used verbatim),
  // the per-panel CDP port, and the provider start URL (from the adapter).
  // Posture: never the human's DEFAULT Chrome profile (Chrome 136+ blocks CDP
  // there anyway). Every value is config/env-overridable.
  function resolveWebChatProfile(adapter) {
    const wc = (config && config.webChat) || {};
    const n = _webChatPanelSeq++;
    const baseName = wc.profile || process.env.TERMDECK_WEBCHAT_PROFILE || 'grok';
    const userDataDir = wc.userDataDir
      || process.env.TERMDECK_WEBCHAT_USER_DATA_DIR
      || (n === 0 ? baseName : `${baseName}-${n + 1}`);
    const basePort = parseInt(
      String(wc.cdpPort || process.env.TERMDECK_WEBCHAT_CDP_PORT || '9333'), 10,
    );
    const cdpPort = (Number.isFinite(basePort) ? basePort : 9333) + n;
    const startUrl = (adapter && adapter.webChatUrl) || wc.startUrl || 'https://grok.com';
    return { userDataDir, cdpPort, startUrl };
  }

  // Set status + fire the (best-effort) status-change telemetry. No-op once the
  // panel is exited so a late driver callback can't resurrect a dead panel.
  function applyWebChatStatus(session, { status, statusDetail } = {}) {
    if (!status || session.meta.status === 'exited') return;
    const oldStatus = session.meta.status;
    session.meta.status = status;
    session.meta.statusDetail = statusDetail || '';
    session.meta.lastActivity = new Date().toISOString();
    if (oldStatus !== status && session.onStatusChange) {
      try { session.onStatusChange(session, oldStatus, status); }
      catch (err) { console.error('[web-chat] onStatusChange error:', err && err.message); }
    }
  }

  // Register the periodic-capture timer — web-chat is a non-Claude adapter WITH
  // resolveTranscriptPath, so it is eligible exactly like a Codex/Gemini/Grok/
  // agy panel. Replicated from the PTY path (index.js spawn block) rather than
  // shared so the PTY branch stays byte-identical (Guardrail 3).
  function maybeRegisterWebChatPeriodicCapture(session) {
    try {
      const adapter = getAdapterForSessionType(session.meta.type);
      const eligible = adapter
        && adapter.sessionType !== 'claude-code'
        && typeof adapter.resolveTranscriptPath === 'function';
      const intervalMs = _resolvePeriodicCaptureIntervalMs();
      if (eligible && intervalMs > 0) {
        session._periodicCapture = { lastSize: 0, lastFireMs: 0, timer: null };
        session._periodicCapture.timer = setInterval(() => {
          onPanelPeriodicCapture(session).catch((err) => {
            console.error('[periodic-capture] async error:', err && err.message ? err.message : err);
          });
        }, intervalMs);
        if (session._periodicCapture.timer.unref) session._periodicCapture.timer.unref();
      }
    } catch (_e) { /* fail-soft */ }
  }

  // A completed Grok turn (from the driver's onComplete OR a degraded driver's
  // inject-resolved text): record it, update status via the adapter, broadcast
  // {type:'output'}, archive to the transcript writer. Deliberately NOT
  // session.analyzeOutput() — its _detectErrors would false-positive 'errored'
  // on chat prose containing "Error:" (see web-chat-grok.js header). statusFor
  // gives the same status outcome without that hazard.
  function onWebChatResponse(session, responseText) {
    if (typeof responseText !== 'string' || responseText.length === 0) return;
    if (session.meta.status === 'exited') return;

    if (session._webChatTranscript && Array.isArray(session._webChatTranscript.turns)) {
      session._webChatTranscript.turns.push({ role: 'assistant', content: responseText });
    }

    const adapter = getAdapterForSessionType('web-chat');
    let applied = false;
    if (adapter && typeof adapter.statusFor === 'function') {
      const st = adapter.statusFor(responseText);
      if (st && st.status) { applyWebChatStatus(session, st); applied = true; }
    }
    if (!applied) session.meta.lastActivity = new Date().toISOString();

    if (session.ws && session.ws.readyState === 1) {
      try { session.ws.send(JSON.stringify({ type: 'output', data: responseText })); }
      catch (_e) { /* never disrupt */ }
    }
    if (transcriptWriter) {
      try { transcriptWriter.append(session.id, responseText, Buffer.byteLength(responseText, 'utf8')); }
      catch (_e) { /* never let transcript failures disrupt the data path */ }
    }
  }

  // Route injected/typed text to the driver's "type into composer + send",
  // NOT pty.write. Assembles the 4+1 two-stage submit (paste body buffered,
  // fired on the lone-`\r`) so the orchestrator inject pattern works UNCHANGED.
  // Returns a small status object the route maps to HTTP.
  function routeWebChatInput(session, text) {
    if (typeof text !== 'string') return { ok: false, code: 'invalid_text' };
    const wc = session._webChat;
    if (!wc || !wc.handle || !wc.driver || !wc.driver.grok
        || typeof wc.driver.grok.inject !== 'function') {
      return { ok: false, code: 'web_chat_not_ready' };
    }
    if (!session._webChatInput) session._webChatInput = { pending: '' };

    // Strip bracketed-paste markers; a trailing CR/LF is the submit signal.
    // No trailing newline ⇒ accumulate only (the two-stage stage-1 case).
    const stripped = text.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    const m = stripped.match(/^([\s\S]*?)[\r\n]+$/);
    let content; let doSubmit;
    if (m) { content = m[1]; doSubmit = true; } else { content = stripped; doSubmit = false; }
    if (content) session._webChatInput.pending += content;
    if (!doSubmit) return { ok: true, buffered: true };

    const full = session._webChatInput.pending;
    session._webChatInput.pending = '';
    if (!full) return { ok: true, empty: true };

    if (session._webChatTranscript && Array.isArray(session._webChatTranscript.turns)) {
      session._webChatTranscript.turns.push({ role: 'user', content: full });
    }
    // Event-driven status so the orchestrator inject-verify sees 'thinking'
    // immediately after the submit lands (parity with a PTY agent panel).
    applyWebChatStatus(session, { status: 'thinking', statusDetail: 'Grok is responding…' });

    try {
      const p = Promise.resolve(wc.driver.grok.inject(wc.handle, full));
      if (!wc.unsubscribe) {
        // onComplete wasn't wired (degraded/cdp-only driver) — pull the reply
        // from inject's resolved value instead so the turn is still captured.
        p.then((responseText) => onWebChatResponse(session, responseText))
         .catch((err) => {
           console.error('[web-chat] inject failed:', err && err.message ? err.message : err);
           applyWebChatStatus(session, { status: 'errored', statusDetail: `inject failed: ${err && err.message ? err.message : 'unknown'}` });
         });
      } else {
        // Push model: the onComplete listener handles the reply; just surface
        // inject errors (double-processing avoided by not consuming the value).
        p.catch((err) => {
          console.error('[web-chat] inject failed:', err && err.message ? err.message : err);
          applyWebChatStatus(session, { status: 'errored', statusDetail: `inject failed: ${err && err.message ? err.message : 'unknown'}` });
        });
      }
    } catch (err) {
      return { ok: false, code: 'inject_threw', error: err && err.message ? err.message : 'unknown' };
    }
    return { ok: true, submitted: true };
  }

  // The web-chat analog of term.onExit. Idempotent (guarded by
  // `_webChatClosed`): fires the memory-capture hook (seam 7), clears the
  // periodic timer, broadcasts exit/panel_exited, and tears down the driver.
  // Wired into DELETE /api/sessions/:id + the driver disconnect callback.
  function closeWebChatSession(session, opts = {}) {
    if (!session || session._webChatClosed) return;
    session._webChatClosed = true;
    const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 0;
    const signal = opts.signal || null;

    session.meta.status = 'exited';
    session.meta.exitCode = exitCode;
    session.meta.exitedAt = new Date().toISOString();
    session.meta.statusDetail = `Closed${signal ? ` (${signal})` : ''}`;

    if (session.ws && session.ws.readyState === 1) {
      try { session.ws.send(JSON.stringify({ type: 'exit', exitCode, signal })); }
      catch (_e) { /* fail-soft */ }
    }
    try {
      const exitPayload = JSON.stringify({
        type: 'panel_exited',
        sessionId: session.id,
        exitCode,
        signal: signal || null,
        exitedAt: session.meta.exitedAt,
      });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try { client.send(exitPayload); }
          catch (err) { console.error('[ws] panel_exited send failed:', err); }
        }
      });
    } catch (err) {
      console.error('[ws] panel_exited broadcast failed:', err);
    }

    // Clear the periodic timer BEFORE the close hook so a tick mid-teardown
    // can't race onPanelClose (same ordering as the PTY path).
    if (session._periodicCapture && session._periodicCapture.timer) {
      try { clearInterval(session._periodicCapture.timer); }
      catch (_e) { /* fail-soft */ }
      session._periodicCapture.timer = null;
    }
    // Sprint 80 T2 — clear the context fs.watch + any pending kill-grace timer
    // (no-op for web-chat, which is never Claude-watched, but symmetric + safe).
    teardownContextWatch(session);

    onPanelClose(session).catch((err) => {
      console.error('[panel-close] async error:', err && err.message ? err.message : err);
    });

    // Tear down driver listeners + detach the CDP handle (tolerant of whichever
    // teardown method T1's handle exposes).
    try {
      const wc = session._webChat;
      if (wc) {
        if (typeof wc.unsubscribe === 'function') { try { wc.unsubscribe(); } catch (_e) { /* fail-soft */ } }
        const h = wc.handle;
        if (h && typeof h.close === 'function') { try { h.close(); } catch (_e) { /* fail-soft */ } }
        else if (h && typeof h.detach === 'function') { try { h.detach(); } catch (_e) { /* fail-soft */ } }
        else if (wc.driver && wc.driver.cdp && typeof wc.driver.cdp.detach === 'function') {
          try { wc.driver.cdp.detach(h); } catch (_e) { /* fail-soft */ }
        }
      }
    } catch (_e) { /* fail-soft */ }
  }

  // Boot a web-chat panel: attach T1's driver fire-and-forget (route stays
  // sync), wire screencast→WS, completion→capture, disconnect→close. Fail-soft
  // at every step — a missing/partial/throwing driver degrades the panel to
  // 'errored', never crashes the server.
  // Render-watchdog: self-heal a wedged web-chat cold-start. On a brand-new
  // browser profile the first load very occasionally paints nothing (empty
  // body.innerText) even though attach + screencast are healthy; a full
  // re-navigation clears it (a reload does NOT). Polls briefly for paint, then
  // re-navigates up to `attempts` times. Returns true if the page painted (or
  // we cannot measure — never block readiness on the watchdog itself), false if
  // it stayed blank. Provider-neutral: "painted" == the body has any visible
  // text, which empirically separates the white cold-start wedge (innerText
  // length 0) from a rendered SPA (>0). (Sprint-72 hardening — 2026-06-09.)
  async function ensureWebChatRendered(session, handle, startUrl, opts = {}) {
    const settleMs = opts.settleMs || Number(process.env.TERMDECK_WEBCHAT_RENDER_SETTLE_MS) || 8000;
    const attempts = opts.attempts != null ? opts.attempts
      : (Number(process.env.TERMDECK_WEBCHAT_RENDER_ATTEMPTS) || 2);
    const stepMs = opts.stepMs || Number(process.env.TERMDECK_WEBCHAT_RENDER_STEP_MS) || 500;
    if (!handle || !handle.page || typeof handle.page.evaluate !== 'function') return true;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const painted = async () => {
      try {
        return await handle.page.evaluate(
          () => !!(document && document.body && (document.body.innerText || '').trim().length > 0),
        );
      } catch (_e) {
        return false;
      }
    };
    const settle = async () => {
      for (let waited = 0; waited < settleMs; waited += stepMs) {
        if (session._webChatClosed) return true;
        if (await painted()) return true;
        await sleep(stepMs);
      }
      return painted();
    };
    if (await settle()) return true;
    for (let tries = 1; tries <= attempts; tries++) {
      if (session._webChatClosed) return true;
      applyWebChatStatus(session, { status: 'starting', statusDetail: `Recovering blank page (try ${tries}/${attempts})…` });
      try {
        if (typeof handle.navigate === 'function') {
          await handle.navigate(startUrl, { waitUntil: 'domcontentloaded' });
        } else {
          await handle.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } catch (_e) {
        /* navigation hiccup — re-check paint anyway */
      }
      if (await settle()) return true;
    }
    return false;
  }

  function setupWebChatSession(session) {
    session.pty = null;
    session.pid = null;
    session.meta.status = 'starting';
    session.meta.statusDetail = 'Connecting to Grok…';

    const adapter = getAdapterForSessionType('web-chat');
    const driver = _webChatDriverImpl();
    if (!driver || !driver.cdp || typeof driver.cdp.attach !== 'function' || !adapter) {
      session.meta.status = 'errored';
      session.meta.statusDetail = (!driver || !driver.cdp)
        ? 'web-chat driver not available'
        : (!adapter ? 'web-chat adapter not registered' : 'web-chat driver missing cdp.attach');
      return;
    }

    // In-flight transcript buffer + two-stage inject assembler state.
    session._webChatTranscript = { turns: [] };
    session._webChatInput = { pending: '' };
    // Best-effort status telemetry parity with PTY panels.
    session.onStatusChange = (sess, oldStatus, newStatus) => {
      try { rag.onStatusChanged(sess, oldStatus, newStatus); }
      catch (_e) { /* telemetry is best-effort */ }
    };

    maybeRegisterWebChatPeriodicCapture(session);

    const { userDataDir, cdpPort, startUrl } = resolveWebChatProfile(adapter);

    (async () => {
      let handle;
      try {
        handle = await driver.cdp.attach({ userDataDir, port: cdpPort, startUrl });
      } catch (err) {
        console.error('[web-chat] attach failed:', err && err.message ? err.message : err);
        if (session.meta.status !== 'exited') {
          session.meta.status = 'errored';
          session.meta.statusDetail = `web-chat attach failed: ${err && err.message ? err.message : 'unknown'}`;
        }
        return;
      }
      if (session._webChatClosed) {
        // Panel was deleted during attach — detach immediately, don't wire.
        try { if (handle && typeof handle.close === 'function') handle.close(); } catch (_e) { /* fail-soft */ }
        return;
      }
      session._webChat = { driver, handle, unsubscribe: null };

      // Screencast → WS canvas frames (T3 paints). Prefer handle-method form
      // (T1's per-session recommendation); fall back to the standalone form.
      try {
        const onFrame = (frame) => {
          if (session.ws && session.ws.readyState === 1) {
            try { session.ws.send(JSON.stringify({ type: 'web-chat-frame', frame })); }
            catch (_e) { /* never disrupt */ }
          }
        };
        // Render quality (Sprint-72 hardening, 2026-06-09): pass crisp, Retina-friendly
        // screencast opts. The driver's bare default was a blurry 1280x800 @ jpeg-q60 — fine
        // on a 1x display, soft on a 2x Mac (the HiDPI canvas then upscales it). Env-tunable
        // down for slow links: TERMDECK_WEBCHAT_QUALITY / _MAXW / _MAXH / _FORMAT.
        const scOpts = {
          format: process.env.TERMDECK_WEBCHAT_FORMAT || 'jpeg',
          quality: Number(process.env.TERMDECK_WEBCHAT_QUALITY) || 85,
          maxWidth: Number(process.env.TERMDECK_WEBCHAT_MAXW) || 2560,
          maxHeight: Number(process.env.TERMDECK_WEBCHAT_MAXH) || 1600,
        };
        if (handle && typeof handle.screencast === 'function') handle.screencast(onFrame, scOpts);
        else if (driver.cdp && typeof driver.cdp.screencast === 'function') driver.cdp.screencast(handle, onFrame, scOpts);
      } catch (err) {
        console.error('[web-chat] screencast wiring failed:', err && err.message ? err.message : err);
      }

      // Completed Grok turn → capture (push model).
      try {
        if (driver.grok && typeof driver.grok.onComplete === 'function') {
          session._webChat.unsubscribe = driver.grok.onComplete(handle, (responseText) => {
            onWebChatResponse(session, responseText);
          });
        }
      } catch (err) {
        console.error('[web-chat] onComplete wiring failed:', err && err.message ? err.message : err);
      }

      // Driver/Chrome disconnect → panel close (web-chat analog of term.onExit).
      try {
        if (handle && typeof handle.onDisconnect === 'function') {
          handle.onDisconnect(() => closeWebChatSession(session, { exitCode: 0, signal: 'disconnect' }));
        } else if (driver.cdp && typeof driver.cdp.onDisconnect === 'function') {
          driver.cdp.onDisconnect(handle, () => closeWebChatSession(session, { exitCode: 0, signal: 'disconnect' }));
        }
      } catch (_e) { /* optional hook — absence is fine */ }

      // Self-heal a flaky blank cold-start before declaring the panel Ready.
      let rendered = true;
      try {
        rendered = await ensureWebChatRendered(session, handle, startUrl);
      } catch (err) {
        console.error('[web-chat] render-watchdog error:', err && err.message ? err.message : err);
      }
      if (session._webChatClosed) return;
      applyWebChatStatus(session, rendered
        ? { status: 'idle', statusDetail: 'Ready' }
        : { status: 'errored', statusDetail: 'page did not render (blank after retries)' });
    })();
  }

  function spawnTerminalSession({ command, cwd, project, label, type, theme, reason, role }) {
    const rawCwd = cwd || config.projects?.[project]?.path || os.homedir();
    const resolvedCwd = path.resolve(rawCwd.replace(/^~/, os.homedir()));

    const session = sessions.create({
      type: type || 'shell',
      project: project || null,
      label: label || command || 'Terminal',
      command: command || config.shell,
      cwd: resolvedCwd,
      theme: theme || config.projects?.[project]?.defaultTheme || config.defaultTheme,
      reason: reason || 'launched via API',
      // Sprint 65 T2 (2.1) — explicit operator role. Route validation has
      // already rejected unknown values; here `undefined`/`null` → null.
      role: role || null,
    });

    // Sprint 72 T2 — web-chat panels are driver-backed, not PTY-backed. Boot
    // T1's CDP render-bridge (fire-and-forget; `pty` stays null) and return the
    // session synchronously, exactly as the PTY path returns before the first
    // onData. setupWebChatSession is fully fail-soft, so this branch can never
    // crash a spawn — and it sits BEFORE `if (pty)` so a web-chat panel never
    // touches node-pty.
    if (session.meta.type === 'web-chat') {
      setupWebChatSession(session);
      return session;
    }

    if (pty) {
      // Four launch shapes (Sprint 64 T2 carve-out 2.4 extends the original three):
      //   (1) no command            → spawn the default shell interactively
      //   (2) command is a plain shell name (zsh, bash, fish, ...)
      //                             → spawn THAT shell interactively, no -c wrapper
      //                               (otherwise `zsh -c zsh` exits immediately)
      //   (3) command exactly matches a known agent-adapter binary AND that
      //       adapter declares `spawn.shellWrap === false`
      //                             → spawn the adapter's binary directly with
      //                               its declared defaultArgs + env merge, no
      //                               shell wrapper. Closes Sprint 63
      //                               EXIT-CAPTURE-VERIFICATION.md § 6 (the
      //                               `zsh -c codex` wrap that likely cost the
      //                               codex canary panel its interactive-TTY
      //                               context during the 2026-05-11 update-picker
      //                               event). The exact-binary gate preserves
      //                               user-supplied flags like `claude --resume
      //                               <uuid>` — those still fall through to (4).
      //   (4) command is a real command string
      //                             → spawn default shell with -c <command>
      const cmdTrim = (command || '').trim();
      const PLAIN_SHELLS = /^(zsh|bash|fish|sh|dash|tcsh|ksh|csh|pwsh|powershell)$/i;
      const isPlainShell = PLAIN_SHELLS.test(cmdTrim);

      // Sprint 64 T2 (carve-out 2.4) — resolve the matching agent adapter from
      // the command string. Walk the registry in declaration order; the first
      // adapter whose `matches(command)` returns true claims the spawn. We
      // honor `adapter.spawn.shellWrap === false` ONLY when the trimmed command
      // is exactly the adapter's binary name (no extra args). User-supplied
      // flags like `codex resume <id>` keep the legacy `zsh -c <command>` path
      // so we don't silently drop their args.
      let directSpawnAdapter = null;
      if (cmdTrim && !isPlainShell) {
        for (const adapter of Object.values(AGENT_ADAPTERS)) {
          if (!adapter || typeof adapter.matches !== 'function') continue;
          if (!adapter.matches(cmdTrim)) continue;
          const spawnDecl = adapter.spawn;
          if (!spawnDecl || spawnDecl.shellWrap !== false) continue;
          const binary = spawnDecl.binary;
          if (typeof binary !== 'string' || binary.length === 0) continue;
          // Exact-binary gate: only switch to direct-spawn for bare-binary
          // launches. `codex --resume xyz` falls through to the shell-wrap path.
          if (cmdTrim !== binary) continue;
          directSpawnAdapter = adapter;
          break;
        }
      }

      // Sprint 59 T2 — Brad #5: resolveSpawnShell chains config.shell →
      // $SHELL → /bin/sh so a host without zsh (Alpine, minimal Ubuntu after
      // `apt remove zsh`) still spawns a working interactive shell instead of
      // failing silently from execvp(/bin/zsh).
      let spawnShell;
      let args;
      let adapterSpawnEnv = {};
      if (directSpawnAdapter) {
        const decl = directSpawnAdapter.spawn;
        spawnShell = decl.binary;
        args = Array.isArray(decl.defaultArgs) ? decl.defaultArgs.slice() : [];
        // Adapter-declared env overlays (e.g. grok's GROK_MODEL). Empty/`undefined`
        // values are filtered so they don't shadow process.env.
        if (decl.env && typeof decl.env === 'object') {
          for (const [k, v] of Object.entries(decl.env)) {
            if (typeof v === 'string' && v.length > 0) adapterSpawnEnv[k] = v;
          }
        }
      } else {
        spawnShell = isPlainShell
          ? cmdTrim
          : resolveSpawnShell('', config.shell, process.env.SHELL);
        args = (cmdTrim && !isPlainShell) ? ['-c', cmdTrim] : [];
      }

      // Sprint 70 T1 — stdout-capture adapters (agy) may opt into a best-effort
      // line-buffering wrap of the direct-spawn. No-op for every other adapter
      // (none declare `capture`) and for the shell-wrap path. Gated on
      // directSpawnAdapter because a capture declaration only rides the
      // exact-binary direct-spawn path. Falls back to the bare binary when no
      // stdbuf-family tool is on PATH; the PTY tee below captures regardless.
      if (directSpawnAdapter && directSpawnAdapter.capture) {
        const wrapped = _resolveStdoutCaptureSpawn(spawnShell, args, directSpawnAdapter.capture);
        spawnShell = wrapped.binary;
        args = wrapped.args;
      }

      try {
        // Sprint 48 T4: merge ~/.termdeck/secrets.env into the PTY env so
        // the bundled session-end memory hook (`memory-session-end.js`) sees
        // SUPABASE_URL / SERVICE_ROLE_KEY / OPENAI_API_KEY without depending
        // on the user's shell to have sourced the file. process.env is the
        // base; any concrete value the parent already exported wins.
        const termdeckSecrets = readTermdeckSecretsForPty();
        const secretFallback = {};
        for (const [k, v] of Object.entries(termdeckSecrets)) {
          if (process.env[k] === undefined || process.env[k] === '') {
            secretFallback[k] = v;
          }
        }
        // Sprint 64 T2 (carve-out 2.3) — codex pre-spawn version probe.
        // Fire-and-forget; never blocks spawn. WARN-only when
        // CODEX_PINNED_VERSION drifts from observed (default install: no probe
        // comparison, no warning). See codex.js `probeCodexVersion` for full
        // rationale.
        if (directSpawnAdapter && directSpawnAdapter.name === 'codex'
            && typeof directSpawnAdapter.probeCodexVersion === 'function') {
          try {
            directSpawnAdapter.probeCodexVersion();
          } catch (_probeErr) { /* fail-soft */ }
        }
        const term = pty.spawn(spawnShell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: resolvedCwd,
          env: {
            ...process.env,
            ...secretFallback,
            // Sprint 64 T2 (carve-out 2.4) — adapter-declared env overlays
            // (e.g. grok's `GROK_MODEL`, codex's `OPENAI_API_KEY` pass-through)
            // land last so they win over process.env defaults on direct-spawn.
            // For shell-wrap launches `adapterSpawnEnv` is empty; this is a
            // no-op spread.
            ...adapterSpawnEnv,
            TERMDECK_SESSION: session.id,
            TERMDECK_PROJECT: project || '',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            // Kill macOS Terminal.app's zsh session save on teardown.
            // We do NOT override TERM_SESSION_ID or SHELL_SESSION_DID_INIT —
            // touching those caused interactive shells to stop accepting
            // input in at least one confirmed reproducer. If ~/.zsh_sessions/
            // files get corrupted externally and produce a one-line startup
            // warning, that is cosmetic and safe to ignore.
            SHELL_SESSION_HISTORY: '0'
          }
        });

        session.pty = term;
        session.pid = term.pid;

        // Sprint 80 T1 (INCIDENT 2026-07-01 — whole-deck crash) — attach a pty
        // 'error' listener so an ASYNC node-pty socket error can NEVER take the
        // server down. node-pty's UnixTerminal master-socket handler
        // (@homebridge/node-pty-prebuilt-multiarch/lib/unixTerminal.js:114-140)
        // swallows EAGAIN + EIO but RE-THROWS any other errno (EBADF/ENOTTY/
        // EPIPE — exactly what a write to a pty whose child just died emits)
        // as an UNCAUGHT exception when the terminal has fewer than 2 'error'
        // listeners. The baseline count is 1, so with no consumer listener a
        // single bad write kills the whole process (all lane PTYs + the HTTP
        // listener). This is what crashed Brad's deck when a POST
        // /api/sessions/:id/input {submit:true} re-engaged a panel whose agent
        // had just exited — the 400ms server-held submit settle (pty-submit.js)
        // widens the write-after-death race so the body write's async socket
        // error surfaces while the request is still in flight. Attaching one
        // listener raises the count to 2 → node-pty declines to throw instead
        // of crashing. Guarded on `typeof term.on` so the plain-object fake
        // ptys used by the unit harnesses (no EventEmitter surface) are
        // untouched; real node-pty always has `.on`.
        if (typeof term.on === 'function') {
          term.on('error', (err) => {
            const code = (err && err.code) ? `, ${err.code}` : '';
            const msg = (err && err.message) ? err.message : String(err);
            console.warn(`[pty] non-fatal socket error (session=${session.id}${code}): ${msg}`);
          });
        }

        session.meta.status = 'active';
        // Sprint 64 T2 (carve-out 2.4 closure) — when direct-spawn matched
        // a known adapter, promote `session.meta.type` from its `'shell'`
        // default to the adapter's canonical `sessionType` immediately. Two
        // downstream paths benefit:
        //   • T3's periodic-capture timer (Sprint 64) looks up
        //     `getAdapterForSessionType(session.meta.type)` at session-create
        //     time — without this promotion, a bare `command:'codex'` launch
        //     stays as `meta.type='shell'` until adapter output triggers
        //     auto-detect, and the periodic timer never registers
        //     (T4-CODEX 2026-05-14 16:25/16:31 AUDIT-CONCERN).
        //   • `getAdapterForSessionType` callers in session.js' output
        //     analyzer (`_updateStatus`) get the right pattern set on the
        //     very first PTY chunk instead of waiting for the auto-detect
        //     branch.
        // Only promotes when the caller didn't already specify a concrete
        // type (i.e., `meta.type === 'shell'`) so explicit requests are
        // never overridden.
        if (directSpawnAdapter && session.meta.type === 'shell') {
          session.meta.type = directSpawnAdapter.sessionType;
        }
        // Sprint 64 T2 (carve-out 2.1) — strict spawn timestamp consumed by
        // codex.js `resolveTranscriptPath` to gate rollout-file candidates
        // against cross-panel contamination. `session.meta.createdAt` is set
        // earlier in `sessions.create()` and predates `pty.spawn` by O(ms);
        // `spawnTimestampMs` captures the actual fork-time so we can reject
        // pre-spawn rollout files even when another panel's mtime briefly
        // races past createdAt. See `packages/server/src/agent-adapters/codex.js`
        // header for the bug shape.
        session.meta.spawnTimestampMs = Date.now();

        // Sprint 64 T3.4 — register the periodic-capture timer for non-Claude
        // panels. Claude Code uses the PreCompact hook (Investigation 2
        // primary signal) — the timer below is the orthogonal fallback for
        // Codex/Gemini/Grok which have no equivalent harness hook. Cleared
        // in term.onExit below. Disabled when the interval env var is set
        // to 0.
        try {
          const adapter = AGENT_ADAPTERS[session.meta.type]
            || Object.values(AGENT_ADAPTERS).find((a) => a.sessionType === session.meta.type);
          const isNonClaudeAdapter = adapter
            && adapter.sessionType !== 'claude-code'
            && typeof adapter.resolveTranscriptPath === 'function';
          const intervalMs = _resolvePeriodicCaptureIntervalMs();
          if (isNonClaudeAdapter && intervalMs > 0) {
            session._periodicCapture = { lastSize: 0, lastFireMs: 0, timer: null };
            session._periodicCapture.timer = setInterval(() => {
              onPanelPeriodicCapture(session).catch((err) => {
                console.error('[periodic-capture] async error:', err && err.message ? err.message : err);
              });
            }, intervalMs);
            // Don't keep the event loop alive solely for this timer — the PTY
            // / WS / HTTP listeners are the real lifetime anchors.
            if (session._periodicCapture.timer.unref) session._periodicCapture.timer.unref();
          }
        } catch (_periodicErr) { /* fail-soft */ }

        // Sprint 80 T2 (FR-5) — establish the context-size watch for CLAUDE
        // panels. The mirror image of the periodic-capture timer above: that one
        // is for non-Claude panels, this is Claude-only (the ONLY adapter whose
        // JSONL carries a per-turn `usage` block). fs.watch on the transcript
        // dir → debounced recompute of meta.contextK, which rides the 2s
        // status_broadcast to the header. Cleared in term.onExit below.
        // establishContextWatch is internally Claude-gated + fully fail-soft.
        establishContextWatch(session);

        // Sprint 70 T1 — initialize the in-flight stdout capture buffer for
        // adapters that opt in (agy). The tee in term.onData below appends to
        // it; resolveTranscriptPath materializes it into a tempfile envelope at
        // panel close + on the periodic-capture tick. Gated on the direct-spawn
        // adapter's declaration so non-capture panels carry no buffer (zero
        // overhead; their behavior is byte-for-byte unchanged).
        if (directSpawnAdapter && directSpawnAdapter.capture
            && directSpawnAdapter.capture.mode === 'stdout') {
          const declaredMax = directSpawnAdapter.capture.maxBytes;
          const maxBytes = (typeof declaredMax === 'number' && declaredMax > 0)
            ? declaredMax
            : 4 * 1024 * 1024;
          session._stdoutCapture = { chunks: [], bytes: 0, maxBytes };
        }

        // PTY output → analyze + broadcast to WebSocket + transcript archive
        term.onData((data) => {
          session.analyzeOutput(data);

          // Sprint 70 T1 — tee PTY output into the in-flight capture buffer for
          // stdout-capture adapters (agy). Tail-capped: when the buffer exceeds
          // maxBytes we drop whole chunks from the FRONT, keeping the most
          // recent conversation (TUI redraws inflate raw bytes far past the
          // de-chromed content). Best-effort — a capture failure must never
          // disrupt the load-bearing PTY data path below.
          const cap = session._stdoutCapture;
          if (cap) {
            try {
              cap.chunks.push(data);
              cap.bytes += Buffer.byteLength(data, 'utf8');
              while (cap.bytes > cap.maxBytes && cap.chunks.length > 1) {
                const dropped = cap.chunks.shift();
                cap.bytes -= Buffer.byteLength(dropped, 'utf8');
              }
            } catch (_capErr) { /* capture is best-effort */ }
          }

          // Send to connected WebSocket
          if (session.ws && session.ws.readyState === 1) {
            session.ws.send(JSON.stringify({ type: 'output', data }));
          }

          // Archive to transcript writer (non-blocking, failure-safe)
          if (transcriptWriter) {
            try {
              transcriptWriter.append(session.id, data, Buffer.byteLength(data, 'utf8'));
            } catch (err) {
              // Never let transcript failures disrupt the PTY data path
            }
          }
        });

        term.onExit(({ exitCode, signal }) => {
          session.meta.status = 'exited';
          session.meta.exitCode = exitCode;
          // Sprint 65 T2 (2.4) — stamp the exit timestamp so the panel_exited
          // WS frame (below) and the 410 body on POST .../input can both
          // report when the panel died.
          session.meta.exitedAt = new Date().toISOString();
          session.meta.statusDetail = `Exited (${exitCode})${signal ? `, signal ${signal}` : ''}`;

          if (session.ws && session.ws.readyState === 1) {
            session.ws.send(JSON.stringify({
              type: 'exit',
              exitCode,
              signal
            }));
          }

          // Sprint 65 T2 (2.4) — broadcast panel_exited to ALL dashboard WS
          // clients so the grid can auto-remove the dead tile (Brad's
          // 2026-05-12 item 2b — CLI panels must auto-close on PTY exit).
          // Distinct from the `exit` frame above, which targets ONLY this
          // panel's own socket; panel_exited goes to every connected client
          // because any of them may be rendering this tile in its grid.
          // Inlined wss.clients broadcast — same idiom as status_broadcast /
          // config_changed / projects_changed elsewhere in this file.
          try {
            const exitPayload = JSON.stringify({
              type: 'panel_exited',
              sessionId: session.id,
              exitCode,
              signal: signal || null,
              exitedAt: session.meta.exitedAt,
            });
            wss.clients.forEach((client) => {
              if (client.readyState === 1) {
                try { client.send(exitPayload); }
                catch (err) { console.error('[ws] panel_exited send failed:', err); }
              }
            });
          } catch (err) {
            console.error('[ws] panel_exited broadcast failed:', err);
          }

          rag.onSessionEnded(session);

          // Fire-and-forget session log (T2.5)
          writeSessionLog({ session, config, db, getSessionHistory });

          // Sprint 64 T3.4 — clear the periodic-capture timer first so a
          // tick mid-teardown doesn't race onPanelClose. The bookmark stays
          // on `session._periodicCapture.lastSize` for any future inspection
          // (test fixtures consult it post-exit).
          if (session._periodicCapture && session._periodicCapture.timer) {
            try { clearInterval(session._periodicCapture.timer); }
            catch (_clrErr) { /* fail-soft */ }
            session._periodicCapture.timer = null;
          }
          // Sprint 80 T2 (FR-5) — tear down the context fs.watch + any pending
          // kill-grace timer before onPanelClose, same ordering discipline as
          // the periodic-capture clear so no watch/grace tick races teardown.
          teardownContextWatch(session);

          // Sprint 50 T1 — fire the bundled SessionEnd hook for non-Claude
          // panels so Codex / Gemini / Grok /exits write to Mnestra the way
          // Claude Code already does. onPanelClose handles dispatch +
          // skip-claude + skip-when-no-transcript. Fire-and-forget; any
          // error logs and never blocks teardown.
          onPanelClose(session).catch((err) => {
            console.error('[panel-close] async error:', err && err.message ? err.message : err);
          });

          // Sprint 59 T4-CODEX UPLOAD-AUDIT-CONCERN closure: blow away the
          // per-session upload tempdir so dropped files don't outlive the panel
          // that received them. Fire-and-forget; never blocks teardown.
          try {
            const sessUploadDir = path.join(os.tmpdir(), 'termdeck-uploads', session.id);
            fs.rmSync(sessUploadDir, { recursive: true, force: true });
          } catch (_err) { /* non-blocking */ }

          // Sprint 63 T1 (Item 1.1) — null `session.pty` so the wrapper is
          // eligible for GC and downstream `if (session.pty)` guards correctly
          // identify the exited state. Root cause of Joshua's 2026-05-08/09
          // overnight `kern.tty.ptmx_max=511` exhaustion (516 fds for 4 panels):
          // without this nulling, node-pty's wrapper stayed pinned by onData /
          // onExit closures even after the child exited, holding the master
          // fd until next GC pass. Set AFTER `onPanelClose` fires (fire-and-
          // forget; reads `session.meta` + `session.id`, not `session.pty`) and
          // AFTER the upload-dir cleanup so any sync reader above this line
          // sees the original wrapper.
          session.pty = null;
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

        // Sprint 78 T2 — ADV-ACK detection (best-effort). When an agent types
        // `ADV-ACK <rule_id>` in response to an injected advisory, mark the
        // matching advisory_events row acked (heeding lifts the unheeded-
        // recurrence quarantine signal). Fail-soft; never load-bearing.
        session.onAdvAck = (ruleId) => {
          if (!db) return;
          try { advisor.markAcked(db, session.id, ruleId); } catch (err) { console.warn('[advisor] markAcked failed:', err && err.message); }
        };

        // Proactive Mnestra queries on error — fire-and-forget.
        // Independent of rag.enabled — the push loop (rag.js) and the Flashback
        // bridge (mnestra-bridge) are separate systems. rag.enabled gates only
        // the telemetry push loop. Flashback has its own error handling via
        // the catch below and should fire whenever the Mnestra bridge is
        // configured, regardless of the push-loop flag.
        session.onErrorDetected = (sess, ctx) => {
          const question = `${sess.meta.type} error ${ctx.lastCommand || ''} ${ctx.tail || ''}`.trim();
          console.log(`[flashback] error detected in session ${sess.id} (type=${sess.meta.type}, project=${sess.meta.project || 'none'}), querying Mnestra via ${mnestraBridge.mode}…`);
          // Sprint 78 T2 — agent-facing advisory. Registry-driven (T1 doctrine),
          // Mnestra-INDEPENDENT (A1, no embedding call), so it fires for EVERY
          // detected error — NOT gated behind the Mnestra-hit toast below (which
          // returns early on no-hit). Sets sess._lastAdvisorMatch synchronously
          // so the proactive_memory frame can report `agent_injected`. Delivery
          // is fire-and-forget + idle-gated inside onTrigger. Fail-soft: never
          // throws into onErrorDetected.
          try {
            advisor.onTrigger(sess, ctx, { db });
          } catch (advErr) {
            console.warn('[advisor] onTrigger threw at call site (fail-soft):', advErr && advErr.message);
          }
          mnestraBridge.queryMnestra({
            question,
            project: sess.meta.project,
            searchAll: false,
            cwd: sess.meta.cwd,
            sessionId: sess.id,
            sessionContext: {
              type: sess.meta.type,
              project: sess.meta.project,
              cwd: sess.meta.cwd,
              lastCommands: sess.meta.lastCommands.slice(-5),
              status: 'errored'
            }
          }).then((result) => {
            const memories = (result && result.memories) || [];
            const count = memories.length;
            console.log(`[flashback] query returned ${count} matches for session ${sess.id}`);
            // Sprint 57 T1 (#4): negative-feedback persistence. Skip any
            // memory the user previously dismissed (across all sessions);
            // iterate candidates in score order, first non-dismissed wins.
            // Without this, a low-confidence match the user marked
            // "Not relevant" would resurface on the next error fire —
            // exactly the resurfacing-after-dismiss bug Sprint 55 T2 + T4
            // diagnosed (T4 audit addendum: index.js:1058-1100 emits
            // memories[0] without consulting dismissed history). Selection
            // logic lives in `flashbackDiag.pickNextNonDismissed` so the
            // integration shape stays testable without a live PTY.
            const { hit, dismissedCount } =
              flashbackDiag.pickNextNonDismissed(db, memories);
            const wsReadyState = sess.ws ? sess.ws.readyState : null;
            if (!hit) {
              const allDismissed = count > 0 && dismissedCount === count;
              const outcome = allDismissed ? 'dropped_dismissed' : 'dropped_empty';
              console.log(`[flashback] ${allDismissed
                ? `all ${count} candidate(s) previously dismissed`
                : 'no matches'} — skipping proactive_memory send for session ${sess.id}`);
              flashbackDiag.log({
                sessionId: sess.id,
                event: 'proactive_memory_emit',
                ws_ready_state: wsReadyState,
                frame_size_bytes: 0,
                result_count_in_frame: allDismissed ? dismissedCount : 0,
                outcome,
              });
              return;
            }
            if (sess.ws && sess.ws.readyState === 1) {
              // Sprint 43 T2: persist the fire to flashback_events BEFORE
              // serializing the WS frame so we can include the row id. The
              // client uses flashback_event_id to POST dismiss/click-through
              // updates back to the audit dashboard.
              const flashback_event_id = flashbackDiag.recordFlashback(db, {
                sessionId: sess.id,
                project: sess.meta.project || null,
                error_text: question,
                hits_count: count,
                top_hit_id: hit.id || null,
                top_hit_score: typeof hit.similarity === 'number' ? hit.similarity : null,
              });
              // Sprint 78 T2 — report whether a registry advisory was routed to
              // the agent's PTY for this error. `willDeliver` is onTrigger's
              // synchronous post-suppression decision (matched AND cleared the
              // throttle), set above before this frame is built. A matched-but-
              // suppressed advisory reports false (nothing reached the agent).
              // Final landed/queued/dropped status lives in advisory_events.
              // Default false (e.g. a Claude/shell panel onTrigger no-ops on).
              const agent_injected = !!(sess._lastAdvisorMatch && sess._lastAdvisorMatch.willDeliver);
              const frame = JSON.stringify({ type: 'proactive_memory', hit, flashback_event_id, agent_injected });
              try {
                sess.ws.send(frame);
                console.log(`[flashback] proactive_memory sent to session ${sess.id} (source_type=${hit.source_type}, project=${hit.project}, event_id=${flashback_event_id})`);
                flashbackDiag.log({
                  sessionId: sess.id,
                  event: 'proactive_memory_emit',
                  ws_ready_state: 1,
                  frame_size_bytes: Buffer.byteLength(frame, 'utf8'),
                  result_count_in_frame: 1,
                  outcome: 'emitted',
                  flashback_event_id,
                });
              } catch (err) {
                console.error('[flashback] proactive_memory send failed:', err);
                console.error('[ws] proactive_memory send failed:', err);
                flashbackDiag.log({
                  sessionId: sess.id,
                  event: 'proactive_memory_emit',
                  ws_ready_state: 1,
                  frame_size_bytes: Buffer.byteLength(frame, 'utf8'),
                  result_count_in_frame: 1,
                  outcome: 'error',
                  error_message: err && err.message ? err.message : String(err),
                });
              }
            } else {
              console.log(`[flashback] ws not open for session ${sess.id} (readyState=${sess.ws ? sess.ws.readyState : 'null'}) — dropped hit`);
              flashbackDiag.log({
                sessionId: sess.id,
                event: 'proactive_memory_emit',
                ws_ready_state: wsReadyState,
                frame_size_bytes: 0,
                result_count_in_frame: count,
                outcome: 'dropped_no_ws',
              });
            }
          }).catch((err) => {
            console.error(`[flashback] query failed for session ${sess.id}: ${err.message}`);
            console.warn('[mnestra-bridge] proactive query failed:', err.message);
          });
        };

        console.log(`[pty] Spawned session ${session.id} (PID ${term.pid}): ${spawnShell} ${args.join(' ')}`);
      } catch (err) {
        session.meta.status = 'errored';
        session.meta.statusDetail = err.message;
        console.error(`[pty] Spawn failed:`, err);
      }
    } else {
      session.meta.status = 'errored';
      session.meta.statusDetail = 'node-pty not available';
    }

    return session;
  }

  // POST /api/sessions - create a new terminal session
  app.post('/api/sessions', (req, res) => {
    const { command, cwd, project, label, type, theme, reason, role } = req.body || {};
    // Sprint 65 T2 (2.1) — validate the optional explicit operator-role flag
    // (Approach A). An absent field (`undefined`) is fine — it defaults to
    // null in spawnTerminalSession. Any present value must be in the
    // whitelist (case-sensitive exact match; `null` is allowed). Unknown
    // values are a 400 so a typo'd role surfaces immediately rather than
    // silently rendering as an unroled panel.
    if (role !== undefined && !ALLOWED_SESSION_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, code: 'invalid_role', allowed: ALLOWED_SESSION_ROLES });
    }
    // Sprint 80 T3 (FR-3, Brad's 2026-06-26 fleet ask) — enforce the optional
    // panel cap. Brad hit silent host/PTY exhaustion at ~30-40 panels with NO
    // TermDeck limit; a configured ceiling now returns a clear 429 instead of
    // letting the host die. Counts LIVE panels only (exited PTYs hold no
    // resources) so a deck full of dead panels never blocks a fresh spawn.
    // Scoped to this user-facing route — internal respawn/sprint-runner spawns
    // intentionally bypass the cap so recovery is never blocked.
    const panelCap = effectivePanelCap(config);
    if (panelCap !== null) {
      const live = sessions.getAll({ includeExited: false }).length;
      if (live >= panelCap) {
        return res.status(429).json({
          ok: false,
          code: 'panel_cap_reached',
          limit: panelCap,
          current: live,
          hint: `TermDeck is at its configured maxPanels ceiling (${panelCap}). `
            + `Close an idle panel, or raise maxPanels in ~/.termdeck/config.yaml `
            + `(or set the TERMDECK_MAX_PANELS env var). See the README "Panel cap" `
            + `section for per-OS PTY headroom notes.`,
        });
      }
    }
    const session = spawnTerminalSession({ command, cwd, project, label, type, theme, reason, role });
    res.status(201).json(session.toJSON());
  });

  // Sprint runner endpoints (Sprint 37 T4) — in-dashboard 4+1 sprint runner.
  // Wraps spawnTerminalSession with two-stage submit + verify-and-poke.
  createSprintRoutes({
    app,
    config,
    spawnTerminalSession,
    getSession: (id) => sessions.get(id),
  });
  createSprintInjectRoutes({
    app,
    getSession: (id) => sessions.get(id),
  });
  createSprintNudgeRoutes({
    app,
    getSession: (id) => sessions.get(id),
  });

  // Graph endpoints (Sprint 38 T4) — knowledge-graph view backing graph.html.
  // Reuses the daily-driver pg pool (same DATABASE_URL serves memory_items +
  // memory_relationships alongside rumen_*). Graceful-degrades when the pool
  // is absent.
  createGraphRoutes({
    app,
    getPool: getRumenPool,
  });

  // GET /api/sessions/:id - get session details
  app.get('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
  });

  // PATCH /api/sessions/:id - update session metadata
  app.patch('/api/sessions/:id', (req, res) => {
    // Sprint 66 T1 (Task 1.2) — `role` is PATCH-mutable so an operator can tag
    // a live panel as orchestrator in place. Validate it exactly as POST
    // /api/sessions does (index.js — the `invalid_role` 400 above): an absent
    // field is fine, any present value must be in ALLOWED_SESSION_ROLES
    // (master-orchestrator/orchestrator/worker/reviewer/auditor/null) — an unknown value is a 400
    // so a typo surfaces immediately rather than silently mis-tagging the
    // panel. Validation runs BEFORE updateMeta so a bad role never reaches the
    // whitelist apply or the SQLite write.
    const body = req.body || {};
    if (body.role !== undefined && !ALLOWED_SESSION_ROLES.includes(body.role)) {
      return res.status(400).json({ ok: false, code: 'invalid_role', allowed: ALLOWED_SESSION_ROLES });
    }
    const session = sessions.updateMeta(req.params.id, body);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
  });

  // DELETE /api/sessions/:id - kill terminal and remove session
  app.delete('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Sprint 72 T2 — web-chat panels have no PTY to kill. Fire the idempotent
    // close path (memory capture + periodic-timer cleanup + exit/panel_exited
    // broadcast + driver detach) — the web-chat analog of term.onExit — before
    // removing the session from the manager.
    if (session.meta.type === 'web-chat') {
      closeWebChatSession(session, { exitCode: 0, signal: 'SIGTERM' });
    } else if (session.pty) {
      // Kill PTY process
      try { session.pty.kill(); } catch (err) { console.error('[pty] kill failed for session', req.params.id + ':', err); }
      // Sprint 63 T1 (Item 1.2) — stamp `_destroyed = true` on the pty wrapper
      // so `safelyResizePty` can short-circuit any resize attempts that arrive
      // in the kill()→onExit window. node-pty's `kill()` only signals the
      // child; onExit fires asynchronously once the child reaps. Without this
      // marker, a WS resize message in that window would ioctl a fd whose
      // child has just SIGHUP'd, surfacing as EBADF/ENOTTY. node-pty doesn't
      // set this property itself; the convention is owned by TermDeck.
      session.pty._destroyed = true;
    }

    sessions.remove(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/sessions/:id/input - write text into a PTY from an external sender
  // Body: { text: string, source?: 'user' | 'reply' | 'ai', fromSessionId?: string }
  // Used by T1.3 reply button and any agent-to-agent routing.
  const inputRateLimit = new Map(); // sessionId -> { windowStart, count }
  app.post('/api/sessions/:id/input', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // Sprint 72 T2 — web-chat panels have no PTY. Route the inject to the
    // driver (type into composer + send) BEFORE the `!session.pty` 410 guard
    // below (which would otherwise reject every web-chat inject as "exited").
    // Self-contained (own rate-limit + logging + response) so the PTY path
    // below stays byte-identical (Guardrail 3).
    if (session.meta.type === 'web-chat') {
      if (session.meta.status === 'exited' || session._webChatClosed) {
        const msg = `Panel ${req.params.id} has exited`;
        return res.status(410).json({
          ok: false, code: 'panel_exited', error: msg, message: msg,
          exitCode: session.meta.exitCode ?? null,
          exitedAt: session.meta.exitedAt || null,
        });
      }
      const { text, source, fromSessionId } = req.body || {};
      if (typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });

      // Same 10 writes/sec/session rate limit as the PTY path below.
      const now = Date.now();
      const bucket = inputRateLimit.get(session.id) || { windowStart: now, count: 0 };
      if (now - bucket.windowStart >= 1000) { bucket.windowStart = now; bucket.count = 0; }
      bucket.count += 1;
      inputRateLimit.set(session.id, bucket);
      if (bucket.count > 10) return res.status(429).json({ error: 'Rate limit exceeded (10/sec)' });

      const result = routeWebChatInput(session, text);
      if (!result.ok && result.code !== 'invalid_text') {
        // Driver not attached yet (or inject threw) — 409 Conflict so the caller
        // can retry; distinct from 410 (gone) / 400 (bad input).
        return res.status(409).json({
          ok: false, code: result.code || 'web_chat_not_ready',
          error: result.error || 'web-chat panel not ready',
        });
      }
      if (!result.ok) return res.status(400).json({ error: 'Missing text' });

      session.meta.replyCount = (session.meta.replyCount || 0) + 1;
      const effectiveSource = source || 'user';
      if (db) {
        try {
          const snippet = fromSessionId ? `from:${fromSessionId}` : null;
          logCommand(db, session.id, text.slice(0, 500), snippet, effectiveSource);
        } catch (err) {
          console.error('[db] logCommand (web-chat input) failed:', err);
        }
      }
      return res.json({
        ok: true,
        bytes: Buffer.byteLength(text, 'utf8'),
        replyCount: session.meta.replyCount,
        buffered: !!result.buffered,
        submitted: !!result.submitted,
      });
    }
    // Sprint 65 T2 (2.3) — inject to a dead panel returns 410 Gone, not the
    // pre-Sprint-65 silent 404. The orchestrator POSTing to an exited panel
    // (Brad's D.5 item 3 — "10 dead codex cli") got a 404 that reads as
    // "session never existed"; 410 = "the resource was here, has been
    // intentionally removed" — the semantically correct + debuggable signal.
    // Mirrors POST /api/sessions/:id/resize (Sprint 63). The body carries
    // `error` (backward-compat with the client api()/sendReply() path that
    // treats a missing `.error` as success — T4-CODEX 19:44) AND `code`
    // (programmatic discriminator) AND `ok:false`.
    if (session.meta.status === 'exited' || !session.pty) {
      const msg = `Panel ${req.params.id} has exited`;
      return res.status(410).json({
        ok: false,
        code: 'panel_exited',
        error: msg,
        message: msg,
        exitCode: session.meta.exitCode ?? null,
        exitedAt: session.meta.exitedAt || null,
      });
    }

    const { text, source, fromSessionId, submit } = req.body || {};
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

    // Sprint 80 T1 (FR-4) — hold this inject while a human is actively typing in
    // the panel (buffer non-empty + a keystroke within the window); it flushes
    // FIFO later on the human's submit/clear (WS path). If the human has STOPPED
    // typing but a backlog exists, drain it first so held injects still land in
    // order AHEAD of this direct write. `now` was captured for the rate limiter.
    if (shouldHoldInject(session, now)) {
      session._injectQueue.push({
        text, submit: submit === true, source, fromSessionId, enqueuedAt: now,
      });
      return res.json({
        ok: true,
        queued: true,
        queuePosition: session._injectQueue.length,
        status: session.meta.status,
        inputBufferLength: (session._inputBuffer || '').length,
      });
    }
    if (session._injectQueue && session._injectQueue.length > 0) {
      await flushInjectQueue(session, db);
    }

    // CRLF normalize: zsh/readline want \r for Enter
    const normalized = text.replace(/\r\n?/g, '\r').replace(/\n/g, '\r');

    // Sprint 76.1 (Bug B — Brad's "POST /input returns 200 but never submits"):
    // optional server-sequenced submit. The documented two-stage inject (paste
    // body, ~400ms settle, then a lone `\r` as a SECOND POST) is a CALLER-side
    // race — when the bracketed-paste close marker and the `\r` ride one PTY
    // write the foreground TUI absorbs the `\r` as paste content, so under
    // concurrent / mid-turn injects the submit is silently swallowed and the
    // text sits unsubmitted (a 200 here only ever meant "bytes written", not
    // "became a turn"). With `submit:true` the SERVER owns the ordering: write
    // the body, await the settle, then write a lone `\r` as its OWN PTY write —
    // the OS chunk-boundary race is impossible because the two writes are
    // distinct with a server-held gap between them. Mirrors the web-chat arm's
    // server-side assembly above. Absent/falsy `submit` ⇒ byte-identical to the
    // pre-76.1 pass-through (existing two-stage callers are untouched).
    let bytesWritten;
    let submitted;
    if (submit === true) {
      // Sprint 76.1 server-sequenced submit, now via the shared pty-submit
      // helper so this route and the Sprint 78 advisor delivery path never
      // drift. The helper writes the body, awaits the server-held settle, then
      // writes a LONE `\r` as its own PTY write — the mechanical guarantee that
      // removes the caller-side `\r`-swallow race. It re-validates the PTY after
      // the settle so a panel closed mid-submit returns a clean 410 (vs a
      // generic 500 for a real write error); `status` below is the best-effort
      // "did the TUI start the turn" signal. `normalized` is already
      // CRLF-normalized; the helper strips the trailing CR so the body can't
      // self-submit.
      const r = await submitToPty(session, normalized);
      if (r.reason === 'exited_mid_settle') {
        const msg = `Panel ${req.params.id} exited during submit settle`;
        return res.status(410).json({
          ok: false, code: 'panel_exited', error: msg, message: msg,
          exitCode: session.meta.exitCode ?? null,
          exitedAt: session.meta.exitedAt || null,
        });
      }
      if (!r.ok) {
        return res.status(500).json({ error: r.error || r.reason || 'submit failed' });
      }
      bytesWritten = r.bytes;
      submitted = true;
    } else {
      try {
        session.pty.write(normalized);
        session.trackInput(normalized);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      bytesWritten = normalized.length;
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

    // submit-confirm: callers (e.g. Brad's tg-poll re-inject) read
    // `status` / `inputBufferLength` to detect a stuck inject and retry
    // deterministically instead of separately polling GET /buffer. `submitted`
    // is present only when `submit:true` was requested.
    const responseBody = {
      ok: true,
      bytes: bytesWritten,
      replyCount: session.meta.replyCount,
      status: session.meta.status,
      inputBufferLength: (session._inputBuffer || '').length,
    };
    if (submit === true) responseBody.submitted = submitted;
    res.json(responseBody);
  });

  // POST /api/sessions/:id/upload?name=<filename> - File drop / clipboard image paste
  // Body: raw octet-stream of the file content (max 50MB).
  // Writes to /tmp/termdeck-uploads/<sessionId>/<sanitizedName>, returns {ok, path, name, size}.
  // Client typically follows up with POST /api/sessions/:id/input { text: "@<path> " } so
  // the agent (Claude/Codex/Gemini/Grok) sees the standard @filepath attachment syntax.
  // Added Sprint 59 (2026-05-07) to close Brad's "how do I drop a zip into Codex" gap.
  app.post('/api/sessions/:id/upload',
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.meta.status === 'exited' || !session.pty) {
        return res.status(404).json({ error: 'Session is exited' });
      }

      const rawName = (req.query.name || '').toString();
      if (!rawName) return res.status(400).json({ error: 'Missing ?name=' });
      // Sanitize: strip path traversal + control chars; cap at 200 chars.
      // Replace anything not alphanumeric / dash / underscore / dot / space with _
      const safeName = rawName
        .replace(/[\x00-\x1f\x7f/\\]/g, '_')
        .replace(/^\.+/, '_')
        .replace(/\.\.+/g, '_')
        .slice(0, 200) || 'upload.bin';

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty body' });
      }

      const uploadsRoot = path.join(os.tmpdir(), 'termdeck-uploads', session.id);
      try {
        fs.mkdirSync(uploadsRoot, { recursive: true, mode: 0o700 });
        const fullPath = path.join(uploadsRoot, safeName);
        fs.writeFileSync(fullPath, req.body, { mode: 0o600 });
        res.json({ ok: true, path: fullPath, name: safeName, size: req.body.length });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
  );

  // POST /api/sessions/:id/poke - PTY-flush recovery endpoint
  // Body: { methods?: ('sigcont' | 'bracketed-paste' | 'cr-flood' | 'all')[] }  default ['all']
  // Used to recover from the post-stop PTY delivery gap where injected input via /input
  // returns 200 OK but never reaches the running TUI process. Tries multiple flush
  // mechanisms in sequence and reports per-attempt status plus session state before/after.
  // Discovered 2026-04-26 / 2026-04-27 during ClaimGuard Sprints 4-6 (TMR 4+1 orchestration);
  // see ~/.claude/plans/skill-tmr-orchestrate/known-issues/2026-04-27-pty-delivery-gap.md
  app.post('/api/sessions/:id/poke', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.meta.status === 'exited' || !session.pty) {
      return res.status(404).json({ error: 'Session is exited' });
    }

    const { methods } = req.body || {};
    const requested = Array.isArray(methods) && methods.length > 0
      ? methods
      : ['all'];
    const runAll = requested.includes('all');
    const wants = (m) => runAll || requested.includes(m);

    const before = {
      status: session.meta.status,
      statusDetail: session.meta.statusDetail || '',
      lastActivity: session.meta.lastActivity,
      pid: session.pty.pid,
    };

    const attempts = [];

    // Attempt 1: SIGCONT — wakes the child process if it's somehow stopped (job-control state).
    // Harmless when the process is already running.
    if (wants('sigcont')) {
      try {
        process.kill(session.pty.pid, 'SIGCONT');
        attempts.push({ method: 'sigcont', ok: true });
      } catch (err) {
        attempts.push({ method: 'sigcont', ok: false, error: err.message });
      }
    }

    // Attempt 2: bracketed-paste sequence wrapping a single CR.
    // Some TUIs treat bracketed-paste differently from raw input; this is a documented
    // (and previously untested) workaround mentioned in the TermDeck API reference.
    if (wants('bracketed-paste')) {
      try {
        session.pty.write('\x1b[200~\r\x1b[201~');
        attempts.push({ method: 'bracketed-paste', ok: true });
      } catch (err) {
        attempts.push({ method: 'bracketed-paste', ok: false, error: err.message });
      }
    }

    // Wait briefly between attempts so each one has a chance to take effect
    // before the next floods the buffer.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Attempt 3: triple CR — multiple Enter keypresses in case the TUI needs more
    // than one to register. Each \r is a literal Enter (zsh/readline submit).
    if (wants('cr-flood')) {
      try {
        session.pty.write('\r\r\r');
        attempts.push({ method: 'cr-flood', ok: true });
      } catch (err) {
        attempts.push({ method: 'cr-flood', ok: false, error: err.message });
      }
    }

    // Final settle delay so `after` reflects the result of all attempts.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = {
      status: session.meta.status,
      statusDetail: session.meta.statusDetail || '',
      lastActivity: session.meta.lastActivity,
    };

    // Heuristic recovery signal: if lastActivity advanced between before and after,
    // at least one attempt got the TUI to consume input. Not definitive (the TUI
    // might have advanced for other reasons) but a useful hint to the caller.
    const advanced = before.lastActivity !== after.lastActivity;

    res.json({
      ok: true,
      pid: session.pty.pid,
      before,
      after,
      advanced,
      attempts,
    });
  });

  // GET /api/sessions/:id/buffer - lightweight introspection of recent input writes
  // Returns the session's recent _inputBuffer state (what the orchestrator has
  // written via /input that may or may not have been consumed by the TUI yet).
  // Useful for diagnosing whether bytes are queued vs consumed.
  app.get('/api/sessions/:id/buffer', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // Sprint 72 T2 — web-chat panels have no PTY by design, so only the
    // exited check gates them (the `!session.pty` arm is PTY-only). This keeps
    // the orchestrator's inject-verify poll (status:'thinking' after a submit)
    // working on a web-chat panel exactly as on a PTY agent panel (seam 4/5).
    const isWebChat = session.meta.type === 'web-chat';
    if (session.meta.status === 'exited' || (!isWebChat && !session.pty)) {
      return res.status(404).json({ error: 'Session is exited' });
    }
    const inFlight = isWebChat
      ? ((session._webChatInput && session._webChatInput.pending) || '')
      : (session._inputBuffer || '');
    res.json({
      ok: true,
      pid: session.pty ? session.pty.pid : (session.pid || null),
      inputBufferLength: inFlight.length,
      inputBufferPreview: inFlight.slice(-200),
      lastActivity: session.meta.lastActivity,
      status: session.meta.status,
      statusDetail: session.meta.statusDetail || '',
      replyCount: session.meta.replyCount || 0,
    });
  });

  // GET /api/advisor/diag - recent advisory_events rows (Sprint 78 T2).
  // Mirrors the flashback-diag route style. The agent-facing analogue of
  // /api/flashback/diag: "did an advisory fire, was it delivered or suppressed,
  // and did the agent ACK it?" Query params: ?limit=N (≤500), ?since=ISO.
  app.get('/api/advisor/diag', (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const since = req.query.since || undefined;
      res.json({ ok: true, events: advisor.getRecentAdvisoryEvents(db, { limit, since }) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/advisor/stats - aggregate counts + suppression-reason histogram +
  // active quarantine state (Sprint 78 T2). ?since=ISO optional.
  app.get('/api/advisor/stats', (req, res) => {
    try {
      const since = req.query.since || undefined;
      res.json({ ok: true, stats: advisor.getAdvisoryStats(db, { since }) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/sessions/:id/resize - resize terminal
  // Sprint 63 T1 (Item 1.2) — distinguish "session never existed" (404) from
  // "session exists but PTY has exited" (410 Gone). Pre-Sprint-63 both paths
  // collapsed to 404 (when session.pty was null after the PTY-leak fix) or
  // 409 (when safelyResizePty returned false). 410 is the semantically
  // correct response: the resource was here, the resource is now gone.
  app.post('/api/sessions/:id/resize', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.pty || (session.meta && session.meta.status === 'exited')) {
      return res.status(410).json({ error: 'PTY is gone (session exited)' });
    }

    const { cols, rows } = req.body || {};
    try {
      const resized = safelyResizePty(session, cols, rows);
      if (!resized) {
        return res.status(410).json({ error: 'PTY is gone (session exited)' });
      }
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

  // GET /api/agent-adapters - serializable projection of the multi-agent
  // registry for the launcher. Sprint 45 T4: replaces the hardcoded
  // claude/cc/gemini/python branches in app.js with a registry-driven
  // detector. Each entry exposes only the fields the client needs:
  //   • name        — adapter id ("claude", "codex", "gemini", "grok")
  //   • sessionType — meta.type the launcher should set
  //   • binary      — canonical command name; client matches `^binary\b` (i)
  //   • costBand    — 'free' | 'pay-per-token' | 'subscription' (Sprint 46
  //                   surfaces this in PLANNING.md cost annotations)
  //   • displayName — Sprint 50 T3: human-readable label for launcher buttons
  //                   and panel headers. Backwards-compat: existing clients
  //                   that ignore the field continue to work unchanged.
  // Functions / RegExps are NOT serialized — match logic lives client-side
  // and uses the binary as the prefix anchor. Adapter-specific shorthand
  // (e.g. `cc` → `claude`) is normalized in app.js before this lookup.
  app.get('/api/agent-adapters', (req, res) => {
    const list = Object.values(AGENT_ADAPTERS).map((a) => ({
      name: a.name,
      sessionType: a.sessionType,
      binary: a.spawn && a.spawn.binary,
      costBand: a.costBand,
      displayName: a.displayName || a.name,
    }));
    res.json(list);
  });

  // GET /api/agents - Sprint 50 T3: richer adapter projection used by the
  // dashboard launcher to render one button per registered agent and by the
  // mixed-agent dogfood inject script to discover available agents. Adds
  // the full spawn descriptor (binary + defaultArgs) so callers don't need
  // to re-derive it from the binary alone. Coexists with /api/agent-adapters
  // (kept stable for the launcher-resolver client contract).
  app.get('/api/agents', (req, res) => {
    const list = Object.values(AGENT_ADAPTERS).map((a) => ({
      name: a.name,
      sessionType: a.sessionType,
      displayName: a.displayName || a.name,
      spawn: {
        binary: (a.spawn && a.spawn.binary) || a.name,
        defaultArgs: (a.spawn && Array.isArray(a.spawn.defaultArgs))
          ? a.spawn.defaultArgs.slice()
          : [],
      },
      costBand: a.costBand,
    }));
    res.json(list);
  });

  // Public-shape helper so GET and PATCH return the same envelope.
  function publicConfigPayload() {
    return {
      projects: config.projects || {},
      defaultTheme: config.defaultTheme,
      // ragEnabled is the EFFECTIVE state (after credential eligibility).
      // ragConfigEnabled is the user's intent from config.yaml. The dashboard
      // toggle reads ragConfigEnabled (intent) but renders a warning when it
      // diverges from ragEnabled (e.g. enabled in config but Supabase creds
      // missing → effective state stays off).
      ragEnabled: rag.enabled,
      ragConfigEnabled: !!(config.rag && config.rag.enabled),
      ragSupabaseConfigured: !!(config.rag?.supabaseUrl && config.rag?.supabaseKey),
      aiQueryAvailable: !!(config.rag?.supabaseUrl && config.rag?.supabaseKey && config.rag?.openaiApiKey),
      // Sprint 57 T2 (F-T2-2 + F-T2-6) — derived 3-state enum: 'off' |
      // 'pending' | 'active'. Single source of truth across /api/config,
      // /api/rag/status, /api/status. Replaces per-client derivation of
      // the "RAG · on / pending / mcp-only" label.
      ragMode: deriveRagMode(rag, config),
      statusColors,
      // Sprint 80 T2 (FR-5) — WARN/OVER context-size thresholds so the client
      // can band a PATCH-only contextK (non-Claude panels have no server-set
      // contextLevel). Read-only projection of config.context; safe to expose.
      contextThresholds: {
        warnK: (config.context && config.context.warnK) || 350,
        overK: (config.context && config.context.overK) || 400,
      },
      firstRun
    };
  }

  // GET /api/config - current config (sanitized)
  app.get('/api/config', (req, res) => {
    res.json(publicConfigPayload());
  });

  // PATCH /api/config - update writable config fields. Sprint 36 T3 Deliverable A.
  // Body: { rag: { enabled: boolean } } — the only currently writable path.
  // Persists to ~/.termdeck/config.yaml, live-updates the in-memory integration,
  // and broadcasts a `config_changed` WS event so all open dashboards re-render
  // their RAG indicator without a refresh.
  app.patch('/api/config', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be a JSON object' });
    }
    try {
      updateConfig(body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (body.rag && typeof body.rag.enabled === 'boolean') {
      rag.setEnabled(body.rag.enabled);
    }

    const payload = publicConfigPayload();

    try {
      const wsPayload = JSON.stringify({ type: 'config_changed', config: payload });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try { client.send(wsPayload); } catch (err) { console.error('[ws] config_changed send failed:', err); }
        }
      });
    } catch (err) {
      console.error('[ws] config_changed broadcast failed:', err);
    }

    res.json(payload);
  });

  // POST /api/projects (add) + DELETE /api/projects/:name (remove) — Sprint 42
  // T4 extracted both into projects-routes.js so tests can drive them without
  // bootstrapping the full server. Sessions are passed via getSessions() so
  // DELETE can enforce the 409 live-PTY guard. Files on disk at the project's
  // `path` are NEVER touched by remove — only the YAML entry is rewritten.
  createProjectsRoutes({
    app,
    config,
    getSessions: () => sessions.getAll(),
    addProject,
    removeProject,
    broadcast: (payload) => {
      try {
        const wsPayload = JSON.stringify(payload);
        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            try { client.send(wsPayload); } catch (err) { console.error('[ws] projects_changed send failed:', err); }
          }
        });
      } catch (err) {
        console.error('[ws] projects_changed broadcast failed:', err);
      }
    },
  });

  // GET /api/projects/:name/orchestration-preview — Sprint 37 T3.
  // Renders T2's scaffolding templates without writing to disk so the
  // dashboard can show "if you ran `termdeck init --project <name>`, this
  // is what would be created." Read-only.
  app.get('/api/projects/:name/orchestration-preview', (req, res) => {
    const templates = _getT2Templates();
    if (!templates) {
      return res.status(503).json({
        error: 'Orchestration scaffolding unavailable: packages/cli/src/templates.js not loaded'
      });
    }
    try {
      const preview = orchestrationPreview.buildPreview({
        name: req.params.name,
        projects: config.projects || {},
        cwd: process.cwd(),
        templates,
        destFor: _getT2DestFor(),
        version: _termdeckVersion()
      });
      res.json(preview);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error('[orchestration-preview] GET failed:', err.message);
      res.status(status).json({ error: err.message });
    }
  });

  // POST /api/projects/:name/orchestration-preview/generate — Sprint 37 T3.
  // Calls T2's initProject() to actually write the scaffolding. Body:
  // { force?: boolean }. Returns the same envelope as the GET preview but
  // with `created` instead of `wouldCreate`.
  app.post('/api/projects/:name/orchestration-preview/generate', async (req, res) => {
    const templates = _getT2Templates();
    const initProject = _getT2InitProject();
    if (!templates || !initProject) {
      return res.status(503).json({
        error: 'Orchestration scaffolding unavailable: T2 CLI modules not loaded'
      });
    }
    const force = !!(req.body && req.body.force);
    try {
      const result = await orchestrationPreview.generateScaffolding({
        name: req.params.name,
        projects: config.projects || {},
        cwd: process.cwd(),
        force,
        initProject,
        templates,
        destFor: _getT2DestFor(),
        version: _termdeckVersion()
      });
      res.json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error('[orchestration-preview] generate failed:', err.message);
      res.status(status).json({ error: err.message });
    }
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
      ragEnabled: rag.enabled,
      // Sprint 57 T2 — single-source-of-truth ragMode enum (see rag-mode.js).
      ragMode: deriveRagMode(rag, config)
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
    if (!db) return res.json({ enabled: false, ragMode: deriveRagMode(rag, config), localEvents: 0, unsynced: 0 });
    const total = db.prepare('SELECT COUNT(*) as n FROM rag_events').get().n;
    const unsynced = db.prepare('SELECT COUNT(*) as n FROM rag_events WHERE synced = 0').get().n;
    res.json({
      enabled: rag.enabled,
      // Sprint 57 T2 — single-source-of-truth ragMode enum. Programmatic
      // clients (CLI, MCP, CI) consume this directly instead of re-deriving
      // from the flat `enabled` boolean which can't distinguish "MCP-only by
      // intent" from "intent on but Supabase missing."
      ragMode: deriveRagMode(rag, config),
      supabaseConfigured: !!(rag.supabaseUrl),
      localEvents: total,
      unsynced,
      tables: rag.tables
    });
  });

  // GET /api/flashback/diag - Sprint 39 T1 diagnostic ring buffer.
  // Returns the last N Flashback decision-point events so Joshua can trigger
  // a real-shell error and read the timeline of which gate dropped the toast.
  // Optional filters: ?sessionId=<uuid>, ?eventType=pattern_match, ?limit=N
  // (capped at 200, the ring size).
  app.get('/api/flashback/diag', (req, res) => {
    const { sessionId, eventType } = req.query || {};
    const rawLimit = req.query && req.query.limit;
    const limit = rawLimit != null ? parseInt(rawLimit, 10) : undefined;
    const events = flashbackDiag.snapshot({
      sessionId: typeof sessionId === 'string' && sessionId.length ? sessionId : undefined,
      eventType: typeof eventType === 'string' && eventType.length ? eventType : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, flashbackDiag.RING_SIZE) : undefined,
    });
    res.json({ count: events.length, events });
  });

  // GET /api/flashback/history - Sprint 43 T2 durable audit dashboard.
  // Returns the most-recent flashback fires from SQLite (survives restart)
  // plus the click-through funnel aggregate. The dashboard uses one fetch
  // for both so it can render the table and the funnel in lockstep.
  // Optional filters: ?since=<ISO8601>, ?limit=N (default 100, max 500).
  app.get('/api/flashback/history', (req, res) => {
    const rawSince = req.query && req.query.since;
    const since = (typeof rawSince === 'string' && rawSince.length) ? rawSince : undefined;
    const rawLimit = req.query && req.query.limit;
    const limit = rawLimit != null ? parseInt(rawLimit, 10) : undefined;
    const events = flashbackDiag.getRecentFlashbacks(db, {
      since,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    const funnel = flashbackDiag.getFunnelStats(db, { since });
    res.json({ count: events.length, events, funnel });
  });

  // POST /api/flashback/:id/dismissed - mark a flashback toast as dismissed.
  // Called by the client when the user clicks ×, presses Escape, lets the
  // 30s auto-timer fire, OR clicks "Not relevant" / "Dismiss" in the modal.
  // Idempotent: subsequent calls are no-ops (first dismiss timestamp wins).
  app.post('/api/flashback/:id/dismissed', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const updated = flashbackDiag.markDismissed(db, id);
    res.json({ ok: true, updated });
  });

  // POST /api/flashback/:id/clicked - mark a flashback toast as clicked-
  // through (user opened the modal). Click-through is also an implicit
  // dismiss, so this updates dismissed_at if it's still NULL. Idempotent.
  app.post('/api/flashback/:id/clicked', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const updated = flashbackDiag.markClickedThrough(db, id);
    res.json({ ok: true, updated });
  });

  // GET /api/pty-reaper/status — Sprint 42 T2 observability surface.
  // Returns the live registry (per-session PTY pid + tracked descendants) and
  // the reaped-history ring buffer so heavy-use installs can tell whether the
  // reaper is firing and what it's killing. Read-only.
  app.get('/api/pty-reaper/status', (req, res) => {
    if (!ptyReaper) {
      return res.json({
        enabled: false,
        reason: !pty ? 'node-pty-unavailable' : 'disabled-by-config',
      });
    }
    res.json({ enabled: true, ...ptyReaper.status() });
  });

  // ==================== Transcript endpoints (Sprint 6 T3) ====================

  // GET /api/transcripts/search - FTS across all sessions
  // (Must be registered before :sessionId to avoid route collision)
  app.get('/api/transcripts/search', async (req, res) => {
    if (!transcriptWriter) return res.json({ results: [] });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });
    const since = req.query.since || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    try {
      const results = await transcriptWriter.search(q, { since, limit });
      res.json({ results });
    } catch (err) {
      console.error('[transcript] search endpoint error:', err.message);
      res.status(500).json({ error: 'Transcript search failed' });
    }
  });

  // GET /api/transcripts/recent - time-windowed crash recovery
  // Returns { sessions: [ { session_id, chunks: [...] }, ... ] }
  app.get('/api/transcripts/recent', async (req, res) => {
    if (!transcriptWriter) return res.json({ sessions: [] });
    const minutes = Math.min(Math.max(parseInt(req.query.minutes) || 60, 1), 1440);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 2000);
    try {
      const rows = await transcriptWriter.getRecent(minutes, limit);
      // Group by session_id for client consumption
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.session_id)) grouped.set(row.session_id, []);
        grouped.get(row.session_id).push(row);
      }
      const sessions = [];
      for (const [session_id, chunks] of grouped) {
        sessions.push({ session_id, chunks });
      }
      res.json({ sessions });
    } catch (err) {
      console.error('[transcript] recent endpoint error:', err.message);
      res.status(500).json({ error: 'Transcript recent query failed' });
    }
  });

  // GET /api/transcripts/:sessionId - ordered chunks for a session
  // Returns { content: string } (joined transcript text)
  app.get('/api/transcripts/:sessionId', async (req, res) => {
    if (!transcriptWriter) return res.json({ content: '', lines: [] });
    const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit), 1), 5000) : undefined;
    const since = req.query.since || undefined;
    try {
      const chunks = await transcriptWriter.getSessionTranscript(req.params.sessionId, { limit, since });
      const lines = chunks.map(c => c.content);
      const content = lines.join('');
      res.json({ content, lines, chunks });
    } catch (err) {
      console.error('[transcript] session transcript endpoint error:', err.message);
      res.status(500).json({ error: 'Transcript retrieval failed' });
    }
  });

  // ==================== Rumen insights (Sprint 4 T2) ====================
  // Read-only access to rumen_insights + rumen_jobs in the daily-driver Postgres
  // instance. Contract frozen in docs/sprint-4-rumen-integration/API-CONTRACT.md.

  function rumenUnreachable(res) {
    return res.status(503).json({ error: 'rumen database unreachable' });
  }

  // GET /api/rumen/insights
  app.get('/api/rumen/insights', async (req, res) => {
    const pool = getRumenPool();
    if (!pool) {
      return res.json({ insights: [], total: 0, enabled: false });
    }

    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 20;
    limit = Math.max(1, Math.min(100, limit));

    const project = typeof req.query.project === 'string' && req.query.project.trim()
      ? req.query.project.trim() : null;
    const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since))
      ? new Date(req.query.since).toISOString() : null;
    const unseen = typeof req.query.unseen === 'string' &&
      /^(1|true|yes)$/i.test(req.query.unseen);

    let minConfidence = parseFloat(req.query.minConfidence);
    if (!Number.isFinite(minConfidence)) minConfidence = 0.15;
    minConfidence = Math.max(0, Math.min(1, minConfidence));

    const where = [];
    const params = [];
    if (project) { params.push(project); where.push(`$${params.length} = ANY(projects)`); }
    if (since)   { params.push(since);   where.push(`created_at >= $${params.length}`); }
    if (unseen)  { where.push(`acted_upon = FALSE`); }
    params.push(minConfidence); where.push(`confidence >= $${params.length}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      const countSql = `SELECT COUNT(*)::int AS n FROM rumen_insights ${whereSql}`;
      const listParams = params.slice();
      listParams.push(limit);
      const listSql =
        `SELECT id, insight_text, confidence, projects, source_memory_ids, created_at, acted_upon
           FROM rumen_insights
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT $${listParams.length}`;

      const [countRes, listRes] = await Promise.all([
        pool.query(countSql, params),
        pool.query(listSql, listParams)
      ]);

      const insights = listRes.rows.map((r) => ({
        id: r.id,
        insight_text: r.insight_text,
        confidence: r.confidence == null ? 0 : Number(r.confidence),
        projects: r.projects || [],
        source_memory_ids: r.source_memory_ids || [],
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        acted_upon: !!r.acted_upon
      }));

      res.json({ insights, total: countRes.rows[0]?.n || 0 });
    } catch (err) {
      console.warn('[rumen] GET /insights failed:', err.message);
      return rumenUnreachable(res);
    }
  });

  // GET /api/rumen/status
  app.get('/api/rumen/status', async (req, res) => {
    const pool = getRumenPool();
    if (!pool) return res.json({ enabled: false });

    try {
      // Sprint 45 side-task 2 — order by COALESCE(started_at, completed_at) so
      // jobs whose upstream writer (the @jhizzard/rumen createJob INSERT in the
      // Edge Function) leaves started_at NULL still surface as "latest" via
      // their populated completed_at. Pre-fix the query returned a 2026-04-16
      // job permanently because that was the last row to have started_at
      // populated — every subsequent insert lands started_at = NULL.
      const jobSql =
        `SELECT id, status, completed_at, sessions_processed, insights_generated
           FROM rumen_jobs
           ORDER BY COALESCE(started_at, completed_at) DESC NULLS LAST
           LIMIT 1`;
      const insightSql =
        `SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE acted_upon = FALSE)::int AS unseen,
            MAX(created_at) AS latest
           FROM rumen_insights`;

      const [jobRes, insightRes] = await Promise.all([
        pool.query(jobSql),
        pool.query(insightSql)
      ]);

      const job = jobRes.rows[0] || null;
      const stat = insightRes.rows[0] || { total: 0, unseen: 0, latest: null };

      res.json({
        enabled: true,
        last_job_id: job ? job.id : null,
        last_job_status: job ? job.status : null,
        last_job_completed_at: job && job.completed_at
          ? (job.completed_at instanceof Date ? job.completed_at.toISOString() : job.completed_at)
          : null,
        last_job_sessions_processed: job ? (job.sessions_processed || 0) : 0,
        last_job_insights_generated: job ? (job.insights_generated || 0) : 0,
        total_insights: stat.total || 0,
        unseen_insights: stat.unseen || 0,
        latest_insight_at: stat.latest
          ? (stat.latest instanceof Date ? stat.latest.toISOString() : stat.latest)
          : null
      });
    } catch (err) {
      console.warn('[rumen] GET /status failed:', err.message);
      return rumenUnreachable(res);
    }
  });

  // POST /api/rumen/insights/:id/seen
  app.post('/api/rumen/insights/:id/seen', async (req, res) => {
    const pool = getRumenPool();
    if (!pool) return res.status(503).json({ error: 'rumen not configured' });

    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'invalid insight id' });
    }

    try {
      const result = await pool.query(
        `UPDATE rumen_insights SET acted_upon = TRUE WHERE id = $1
         RETURNING id, acted_upon`,
        [id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'insight not found' });
      }
      const row = result.rows[0];
      res.json({ id: row.id, acted_upon: !!row.acted_upon });
    } catch (err) {
      console.warn('[rumen] POST /insights/:id/seen failed:', err.message);
      return rumenUnreachable(res);
    }
  });

  // POST /api/ai/query - query Mnestra memory via the bridge (direct|webhook|mcp)
  app.post('/api/ai/query', async (req, res) => {
    let { question, sessionId, project } = req.body || {};
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
      cwd: session.meta.cwd,
      lastCommands: session.meta.lastCommands.slice(-5),
      status: session.meta.status
    } : null;

    try {
      const { memories, total } = await mnestraBridge.queryMnestra({
        question,
        project,
        searchAll,
        cwd: session ? session.meta.cwd : undefined,
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
      console.error('[mnestra-bridge] query failed:', err.message);
      // Config-shaped errors are 503, everything else 502
      const msg = err.message || 'Query failed';
      const status = /not configured|OPENAI_API_KEY/i.test(msg) ? 503 : 502;
      res.status(status).json({ error: msg });
    }
  });

  // ==================== WebSocket ====================

  wss.on('connection', (ws, req) => {
    // Optional token auth for WS upgrades (Sprint 9 T3). Express middleware
    // does not run on the upgrade path, so the check has to live here.
    if (!verifyWebSocketUpgrade(config, req)) {
      ws.close(4003, 'Unauthorized');
      return;
    }

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
            // Sprint 72 T2 — web-chat composer text from the client input box
            // goes to the driver's inject (type+send), NOT pty.write. Same
            // two-stage assembler as the POST /input route, so a trailing-`\r`
            // submits. PTY panels are untouched (the else-branch is verbatim).
            if (session.meta.type === 'web-chat') {
              routeWebChatInput(session, parsed.data);
            } else if (session.pty && !session.pty._destroyed) {
              session.pty.write(parsed.data);
              session.trackInput(parsed.data);
              // Sprint 80 T1 (FR-4) — a REAL human keystroke: stamp the typing
              // clock and, on Enter (submit) or Ctrl-C/U/bare-Esc (clear), flush
              // any held injects FIFO into the now-free line.
              if (session.markHumanKeystroke(parsed.data)) {
                flushInjectQueue(session, db).catch((err) =>
                  console.error('[inject-queue] flush failed:', err && err.message ? err.message : err));
              }
            }
            break;

          case 'web-chat-input':
            // Sprint 72 T2 — raw CDP input-event forwarding for DIRECT human
            // interaction with the live Grok tab (mouse/keyboard on the
            // screencast canvas). T3's canvas emits
            // {type:'web-chat-input', event:<CDP Input.* payload>}; routed to
            // the driver's sendInput. Never reaches a PTY.
            if (session.meta.type === 'web-chat' && session._webChat && session._webChat.handle) {
              const wc = session._webChat;
              try {
                if (typeof wc.handle.sendInput === 'function') wc.handle.sendInput(parsed.event);
                else if (wc.driver && wc.driver.cdp && typeof wc.driver.cdp.sendInput === 'function') {
                  wc.driver.cdp.sendInput(wc.handle, parsed.event);
                }
              } catch (err) {
                console.error('[web-chat] sendInput failed:', err && err.message ? err.message : err);
              }
            }
            break;

          case 'resize':
            // Sprint 60 v1.0.14 — safelyResizePty guards against the
            // pty-reaper-closed-the-fd race that surfaced 25x in Brad's
            // 13h uptime as ioctl EBADF/ENOTTY noise.
            safelyResizePty(session, parsed.cols, parsed.rows);
            break;

          case 'meta':
            // Client requesting metadata refresh
            ws.send(JSON.stringify({
              type: 'meta',
              session: session.toJSON()
            }));
            break;
        }
      } catch (err) {
        // Sprint 63 T1 (Item 1.2) — belt-and-suspenders: if a race-class
        // ioctl error somehow escapes safelyResizePty's own catch (or comes
        // from a future write/ioctl path), downgrade to console.debug
        // instead of polluting stderr with the noisy ws-message-handler
        // error log. safelyResizePty itself already catches the resize
        // path; this catches any other race-class shape that bubbles here.
        if (isPtyRaceError(err)) {
          if (process.env.TERMDECK_DEBUG_PTY_RACES) {
            console.debug(`[ws] message handler race-class (suppressed): ${err.code || err.message}`);
          }
        } else {
          console.error('[ws] message handler error:', err);
        }
      }
    });

    ws.on('close', () => {
      console.log(`[ws] Client disconnected from session ${sessionId}`);
      // Intentional: PTYs survive WS close. The session stays in the manager,
      // the PTY keeps running, and reconnecting (?session=<id>) re-binds.
      // PTY teardown happens only via DELETE /api/sessions/:id (user-initiated)
      // or the PTY's own exit event. Hard-refresh is therefore non-destructive.
      // Sprint 36 T3 Deliverable C audit (2026-04-27): the briefing predicted
      // this handler would call pty.kill() — it does not. Joshua's original
      // hard-refresh-loses-PTYs symptom was the reclaimStalePort SIGKILL chain
      // (orchestrator hotfix #2, 15:25 ET), not a WS-close cascade.
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

  // Fallback route → serve index.html. Express 5: named wildcard '/{*splat}'
  // (path-to-regexp v8 — a bare '*' throws at registration; this matches all paths incl. root).
  app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  return { app, server, wss, sessions, rag, db, transcriptWriter, ptyReaper };
}

// ==================== Setup-configure helpers (Sprint 23 T2) ====================
// Scoped to module level so they can be unit tested without spinning the server.
// Each validator resolves to { ok: boolean, detail: string } — never throws.

function validateSupabase(url, key) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve({ ok: false, detail: `invalid URL: ${err.message}` });
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const probePath = '/rest/v1/';
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: probePath,
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      },
      timeout: 8000
    }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        // 200 = PostgREST OpenAPI doc served, 404 = URL reachable but no doc —
        // both indicate the host + key passed the edge auth check.
        if (r.statusCode === 200 || r.statusCode === 404) {
          resolve({ ok: true, detail: `Supabase reachable (HTTP ${r.statusCode})` });
        } else if (r.statusCode === 401 || r.statusCode === 403) {
          resolve({ ok: false, detail: `Authentication failed (HTTP ${r.statusCode}) — check service role key` });
        } else {
          resolve({ ok: false, detail: `Unexpected response HTTP ${r.statusCode}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, detail: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: 'timeout after 8s' }); });
    req.end();
  });
}

function validateOpenAI(key) {
  return new Promise((resolve) => {
    // Probe with the EXACT request shape the bundled hooks use in production
    // (session-end v5: 3-large @ dimensions:1536, recall-parity with mnestra)
    // so a passing preflight means the real capture pipeline's call works —
    // not some other model the account may gate differently.
    const payload = JSON.stringify({
      model: 'text-embedding-3-large',
      dimensions: 1536,
      input: 'termdeck setup test'
    });
    const req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        if (r.statusCode === 200) {
          resolve({ ok: true, detail: 'Embedding test succeeded' });
          return;
        }
        let msg = `HTTP ${r.statusCode}`;
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.error && parsed.error.message) msg = parsed.error.message;
        } catch (_err) { /* ignore body parse */ }
        resolve({ ok: false, detail: msg });
      });
    });
    req.on('error', (err) => resolve({ ok: false, detail: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: 'timeout after 10s' }); });
    req.write(payload);
    req.end();
  });
}

async function validateDatabase(connStr) {
  let pgMod;
  try { pgMod = require('pg'); } catch (err) { pgMod = null; }
  if (!pgMod) return { ok: false, detail: 'pg module not installed' };

  const pool = new pgMod.Pool({
    connectionString: connStr,
    max: 1,
    connectionTimeoutMillis: 6000
  });
  try {
    const t0 = Date.now();
    const r = await pool.query('SELECT 1 AS ok');
    const ms = Date.now() - t0;
    if (r.rows[0] && r.rows[0].ok === 1) {
      return { ok: true, detail: `connected in ${ms}ms` };
    }
    return { ok: false, detail: 'unexpected query result' };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    await pool.end().catch(() => {});
  }
}

function buildSecretsEnv(vars) {
  const secretsPath = path.join(os.homedir(), '.termdeck', 'secrets.env');
  const existing = {};
  if (fs.existsSync(secretsPath)) {
    try {
      const raw = fs.readFileSync(secretsPath, 'utf-8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const k = trimmed.slice(0, eq).trim();
        if (!k) continue;
        let v = trimmed.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        existing[k] = v;
      }
    } catch (err) {
      console.warn('[setup] Could not parse existing secrets.env:', err.message);
    }
  }
  const merged = { ...existing };
  for (const [k, v] of Object.entries(vars)) {
    if (v != null && v !== '') merged[k] = v;
  }
  const lines = [
    '# TermDeck secrets — written by setup wizard',
    '# Do not commit this file.',
    ''
  ];
  for (const [k, v] of Object.entries(merged)) {
    const needsQuote = /[\s#"']/.test(v);
    lines.push(needsQuote ? `${k}="${String(v).replace(/"/g, '\\"')}"` : `${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

function updateConfigYamlForRag(runningConfig) {
  const yaml = require('yaml');
  const configPath = path.join(os.homedir(), '.termdeck', 'config.yaml');
  let parsed = {};
  if (fs.existsSync(configPath)) {
    try {
      parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8')) || {};
    } catch (err) {
      console.warn('[setup] config.yaml parse failed, starting from empty:', err.message);
      parsed = {};
    }
  }
  parsed.rag = parsed.rag || {};
  parsed.rag.enabled = true;
  if (!parsed.rag.supabaseUrl) parsed.rag.supabaseUrl = '${SUPABASE_URL}';
  if (!parsed.rag.supabaseKey) parsed.rag.supabaseKey = '${SUPABASE_SERVICE_ROLE_KEY}';
  if (!parsed.rag.openaiApiKey) parsed.rag.openaiApiKey = '${OPENAI_API_KEY}';
  if (!parsed.rag.anthropicApiKey) parsed.rag.anthropicApiKey = '${ANTHROPIC_API_KEY}';

  if (fs.existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(configPath, `${configPath}.${ts}.bak`); } catch (err) {
      console.warn('[setup] config.yaml backup failed:', err.message);
    }
  }
  fs.writeFileSync(configPath, yaml.stringify(parsed), 'utf-8');

  if (runningConfig) {
    runningConfig.rag = runningConfig.rag || {};
    runningConfig.rag.enabled = true;
    runningConfig.rag.supabaseUrl = process.env.SUPABASE_URL;
    runningConfig.rag.supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    runningConfig.rag.openaiApiKey = process.env.OPENAI_API_KEY;
    if (process.env.ANTHROPIC_API_KEY) runningConfig.rag.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  }
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

  const port = config.port || 3000;
  const host = config.host || '127.0.0.1';

  // Bind guardrail (Sprint 10 T1): refuse to start on a non-localhost
  // interface unless an auth token is configured. Binding 0.0.0.0 without
  // auth is equivalent to publishing a root shell on the LAN — fail closed.
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    if (!hasAuth(config)) {
      console.error('[security] Refusing to bind to ' + host + ' without auth.token set.');
      console.error('[security] Set auth.token in ~/.termdeck/config.yaml or TERMDECK_AUTH_TOKEN env var.');
      console.error('[security] To bind locally only, remove the host setting or set host: 127.0.0.1');
      process.exit(1);
    }
  }

  const { server, transcriptWriter, ptyReaper } = createServer(config);

  // Graceful shutdown — flush transcript buffer before exit
  let shutdownInProgress = false;
  async function handleShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(`\n[server] ${signal} received, shutting down...`);
    if (ptyReaper) {
      try { ptyReaper.stop(); } catch (err) {
        console.error('[pty-reaper] stop failed:', err.message);
      }
    }
    if (transcriptWriter) {
      console.log('[transcript] Flushing buffer before exit...');
      try { await transcriptWriter.close(); } catch (err) {
        console.error('[transcript] Shutdown flush failed:', err.message);
      }
    }
    server.close(() => process.exit(0));
    // Force exit after 5s if server.close hangs
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Fail-soft crash guards (Sprint-72 hardening, 2026-06-09). One bad async
  // rejection or uncaught error anywhere — a panel handler, a request, a hook —
  // must NOT crash the whole server and take every live terminal panel (and the
  // user's work) down with it. We LOG prominently (per-event ISO timestamp, like
  // the boot banner, so crash boundaries stay greppable) and keep running. This
  // trades the small risk of continuing in a degraded state for the much larger
  // cost of losing every panel; a process supervisor is the backstop if the
  // process ever truly wedges. Shutdown is exempt — let handleShutdown finish.
  process.on('unhandledRejection', (reason) => {
    if (shutdownInProgress) return;
    const msg = (reason && reason.stack) || (reason && reason.message) || String(reason);
    console.error(`[server] unhandledRejection (kept alive · ${new Date().toISOString()}):\n${msg}`);
  });
  process.on('uncaughtException', (err) => {
    if (shutdownInProgress) return;
    console.error(`[server] uncaughtException (kept alive · ${new Date().toISOString()}):\n${(err && err.stack) || err}`);
  });

  server.listen(port, host, () => {
    // Sprint 60 v1.0.14 (Item 5) — per-boot banner with ISO timestamp + PID.
    // Brad's 2026-05-07 forensic: a single 260KB termdeck.log spanned Apr 25
    // through May 7 with only ONE boot banner at the top. Crash → restart
    // dropped its own banner somewhere we couldn't find, making post-mortem
    // diagnosis harder. Per-boot timestamps make crash boundaries trivially
    // greppable and let `journalctl`/`tail` users scan a single log to find
    // the most recent restart instantly.
    const bootIso = new Date().toISOString();
    console.log(`\n  ════ TermDeck server boot · ${bootIso} · pid ${process.pid} ════`);
    console.log(`  TermDeck running at http://${host}:${port}\n`);
    console.log(`  Terminals:  0 active`);
    console.log(`  Database:   ${Database ? 'SQLite OK' : 'unavailable'}`);
    console.log(`  PTY:        ${pty ? 'node-pty OK' : 'unavailable (install node-pty)'}`);
    console.log(`  RAG:        ${config.rag?.enabled === true ? 'on (writing to mnestra_*_memory tables)' : 'off (MCP-only mode)'}`);
    console.log(`  Session logs: ${config.sessionLogs?.enabled ? '~/.termdeck/sessions/ (on exit)' : 'off'}`);
    console.log(`  Transcripts:  ${transcriptWriter ? 'streaming to Supabase' : 'off (no DATABASE_URL)'}`);
    console.log(`\n  WARNING: TermDeck binds to ${host} only.`);
    console.log(`  Do NOT expose this to the network without authentication.`);
    console.log(`  Terminal sessions have full shell access.\n`);
  });
}

module.exports = {
  createServer,
  loadConfig,
  // Sprint 60 v1.0.14 (Item 3) — exported so tests can import the production
  // helper instead of re-implementing it. T4-CODEX AUDIT-CONCERN flagged that
  // the prior re-implementation pattern in the test could drift silently.
  safelyResizePty,
  // Sprint 63 T1 (Item 1.2 + 1.3) — race-class classifier + raw-body hex
  // prefix renderer exported so fence tests can import the production
  // helpers instead of re-implementing them.
  isPtyRaceError,
  hexEscapePrefix,
  // Sprint 80 T1 (FR-4) — inject-vs-typing queue internals, exported so the
  // hold decision + FIFO/TTL flush are unit-testable off a live server.
  isInjectHoldEnabled,
  shouldHoldInject,
  flushInjectQueue,
  deliverQueuedInject,
  // Sprint 48 T4 — exported for unit testing the secrets.env → PTY env merge.
  readTermdeckSecretsForPty,
  _resetTermdeckSecretsCache,
  // Sprint 64 T1 (ORCH SCOPE 16:29 item 4) — management-token exclusion list.
  // Exported for `packages/cli/tests/spawn-env-exclusion.test.js` fence.
  SECRETS_EXCLUDED_FROM_PTY,
  // Sprint 65 T2 (2.1) — operator-role whitelist, exported for the route fence.
  ALLOWED_SESSION_ROLES,
  // Sprint 80 T3 (FR-3) — panel-cap normalizer, exported for the unit test.
  effectivePanelCap,
  // Sprint 69 T1 — boot-prompt template engine. Exported so T2's inject
  // endpoint and integration tests can import without traversing the
  // internal `./templates/template-engine` path.
  templateEngine,
  // Sprint 50 T1 — exported for unit testing the per-agent SessionEnd
  // hook trigger (skip-claude, no-transcript, no-hook-installed,
  // payload shape, fire-and-forget).
  onPanelClose,
  _setSpawnSessionEndHookImplForTesting,
  // Sprint 64 T3.4 — periodic-capture surface (Investigation 2 closure).
  onPanelPeriodicCapture,
  _setSpawnPeriodicCaptureHookImplForTesting,
  _resolvePeriodicCaptureIntervalMs,
  // Sprint 70 T1 — stdout-capture spawn-wrap resolver (best-effort stdbuf).
  _resolveStdoutCaptureSpawn,
  _resetStdbufToolCacheForTesting,
  // Sprint 72 T2 — web-chat driver DI seam. Tests inject a fake driver so the
  // web-chat seams (spawn/inject/output/status/close/capture) are exercised
  // with no real Chrome / CDP / network.
  _setWebChatDriverImplForTesting,
  // Sprint 80 T2 — context telemetry (FR-5) + ceiling enforcement (FR-6).
  // Wiring surface exported so tests exercise it with a stubbed PTY / fake
  // adapter and NO live server (the production submitToPty path is under the
  // 2026-07-01 crash INCIDENT). The pure compute/decision logic lives in
  // ./context-meter and is tested directly there.
  updatePanelContext,
  enforceContext,
  fireContextAction,
  isMidToolUse,
  resolveContextConfig,
  establishContextWatch,
  teardownContextWatch,
  _setContextConfigProvider,
  _setContextSubmitImplForTesting,
  _setContextKillImpl,
  _setContextWebhookImplForTesting,
};
