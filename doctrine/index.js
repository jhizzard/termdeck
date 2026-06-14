// TermDeck Doctrine registry — machine-readable rule substrate.
//
// Sprint 78 T1. This is the SUBSTRATE that every later stage consumes:
//   - T2 advisor MVP calls loadDoctrine() + shouldNotify() + recordGateEvent()
//   - Sprint 79 elevation pipeline materializes/ratifies registry entries
//   - Sprint 80 git-hooks / inject-refusal / PreToolUse-deny read enforcement{}
//
// Hard rules this file obeys (PLANNING §3, AMEND-1/2/3/5/11, A9):
//   - vanilla JS / CommonJS / zero build / ZERO non-builtin deps. (node:fs,
//     path, os, child_process only. better-sqlite3 is NEVER required here —
//     the db handle is dependency-injected; doctrine opens no DB file.)
//   - FAIL-SOFT everywhere. Nothing here throws into a hook/commit/inject/PTY
//     path. Bad inputs log one `[doctrine]` warning and degrade gracefully.
//   - NO work at require() time. Requiring this module only defines functions,
//     so `database.js` can require it cheaply for the DDL.
//   - Forbidden-string patterns are NEVER hardcoded here (the patterns ARE the
//     leak). The screen shells out to the user's gitleaks + ~/.gitleaks.toml.
//
// Two distinct throttle layers exist this sprint (PLANNING §8.2 — do not
// conflate): shouldNotify() here is the per-RULE registry-stage throttle
// (30-min cooldown + 3/lane/hr hard budget → ORCH overflow). T2 owns a
// separate per-ENTRY advisory layer (24h/5-per-session/1-per-10min).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Version + enums (the field contract — mirrored in doctrine/SCHEMA.md).
// ---------------------------------------------------------------------------

// Human/telemetry version. Bumped by ORCH when registry CONTENT changes.
// NOTE: the stack-installer refresh gate uses a FULL-FILE content hash, not
// this number (so a forgotten bump can't strand a stale copy). This constant
// is for diagnostics + loadDoctrine()'s reported version only.
const DOCTRINE_REGISTRY_VERSION = 1;

// enforcement.surface — WHERE a rule is (or could be) enforced.
const SURFACES = [
  'git-hook',          // pre-commit / pre-push (gitleaks etc.) — can block
  'preToolUse-deny',   // Sprint 80 PreToolUse deny tier — can block
  'inject-refusal',    // sprint-dispatch refusal — can block
  'server-monitor',    // TermDeck server-side observation — advisory only
  'inject-advisory',   // re-routed PTY advisory (T2) — advisory only
  'status-append',     // STATUS.md grammar/cadence — structurally advisory
];

// block is architecturally possible ONLY on these surfaces (AMEND-3). The
// advisory surfaces have no interception point that can actually deny, so a
// registry entry claiming block there is a lie and is REJECTED by the loader.
const BLOCK_ALLOWED_SURFACES = new Set([
  'git-hook',
  'preToolUse-deny',
  'inject-refusal',
]);

const CHECK_TYPES = ['regex', 'script', 'sql', 'manual'];
const MAX_SEVERITIES = ['block', 'warn', 'advise'];
const SCOPES = ['universal', 'operator-local'];
const SEVERITIES = ['critical', 'high', 'medium', 'low']; // rule importance (sorting/telemetry)
const STATUSES = ['active', 'proposed', 'deprecated'];     // Sprint 79 elevation keys off this

// ---------------------------------------------------------------------------
// doctrine_events store DDL — canonical here, wired into the shared
// better-sqlite3 handle by packages/server/src/database.js. No second DB file.
// ---------------------------------------------------------------------------

const DOCTRINE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS doctrine_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fired_at    TEXT    NOT NULL,
    rule_id     TEXT    NOT NULL,
    dedupe_key  TEXT,
    lane        TEXT,
    surface     TEXT,
    outcome     TEXT    NOT NULL,
    reason      TEXT,
    session_id  TEXT,
    detail      TEXT
  );
  CREATE INDEX IF NOT EXISTS doctrine_events_rule_fired_idx
    ON doctrine_events(rule_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS doctrine_events_lane_fired_idx
    ON doctrine_events(lane, fired_at DESC);
`;

// Throttle defaults (PLANNING §2 row 2 + §8.2 + AMEND-5).
const DEFAULT_RULE_COOLDOWN_MS = 30 * 60 * 1000; // per-rule 30-min cooldown
const DEFAULT_LANE_HOURLY_BUDGET = 3;            // hard 3 advisories / lane / hr

// ---------------------------------------------------------------------------
// Logging (TermDeck convention: bracket-tagged console.warn for greppability).
// ---------------------------------------------------------------------------

function log(...args) {
  // eslint-disable-next-line no-console
  console.warn('[doctrine]', ...args);
}

let _warnedGitleaksAbsent = false;

// ---------------------------------------------------------------------------
// Default source paths — resolved at CALL time (os.homedir()) so tests can
// re-point HOME or pass explicit overrides without module-reload (mirrors the
// stack-installer `_hookCommandFor` call-time pattern). All overridable.
// ---------------------------------------------------------------------------

function defaultRepoRegistry() {
  return path.join(__dirname, 'registry.jsonl');
}
function defaultClaudeOverlay() {
  return path.join(os.homedir(), '.claude', 'doctrine', 'registry.local.jsonl');
}
function defaultTermdeckOverlayDir() {
  return path.join(os.homedir(), '.termdeck', 'doctrine-local');
}

// ---------------------------------------------------------------------------
// Dependency-injected db handle (better-sqlite3). The server calls setDb(db)
// once at startup with its shared handle. recordGateEvent/shouldNotify use it.
// No db ⇒ fail-soft (see each function).
// ---------------------------------------------------------------------------

let _db = null;
function setDb(db) { _db = db || null; }
function _resolveDb(opts) { return (opts && opts.db) || _db; }

// ---------------------------------------------------------------------------
// Validation (AMEND-3 — the loader REJECTS structurally-impossible enforcement).
// ---------------------------------------------------------------------------

function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['entry is not an object'] };
  }
  if (!entry.id || typeof entry.id !== 'string') errors.push('missing/invalid id');
  if (!entry.title || typeof entry.title !== 'string') errors.push('missing/invalid title');
  if (!SCOPES.includes(entry.scope)) errors.push(`invalid scope: ${JSON.stringify(entry.scope)} (want ${SCOPES.join('|')})`);
  if (!SEVERITIES.includes(entry.severity)) errors.push(`invalid severity: ${JSON.stringify(entry.severity)} (want ${SEVERITIES.join('|')})`);
  if (!entry.audience || typeof entry.audience !== 'string') errors.push('missing/invalid audience');

  const check = entry.check || {};
  if (!CHECK_TYPES.includes(check.type)) errors.push(`invalid check.type: ${JSON.stringify(check.type)} (want ${CHECK_TYPES.join('|')})`);

  const enf = entry.enforcement || {};
  if (!SURFACES.includes(enf.surface)) errors.push(`invalid enforcement.surface: ${JSON.stringify(enf.surface)} (want ${SURFACES.join('|')})`);
  // max_severity is required (SCHEMA.md marks enforcement.{surface,max_severity,ref}
  // required); absent/invalid is rejected so the AMEND-3 cap is always evaluable.
  if (!MAX_SEVERITIES.includes(enf.max_severity)) {
    errors.push(`invalid/missing enforcement.max_severity: ${JSON.stringify(enf.max_severity)} (want ${MAX_SEVERITIES.join('|')})`);
  }
  // THE load-bearing rule (AMEND-3): block only on git-hook / preToolUse-deny /
  // inject-refusal. server-monitor & inject-advisory capped at warn;
  // status-append structurally advisory forever.
  if (enf.max_severity === 'block' && !BLOCK_ALLOWED_SURFACES.has(enf.surface)) {
    errors.push(
      `max_severity 'block' is architecturally impossible on surface '${enf.surface}' ` +
      `(advisory surfaces are capped at warn; block only on ${[...BLOCK_ALLOWED_SURFACES].join('/')})`
    );
  }

  const adv = entry.advisory || {};
  if (adv.one_line != null) {
    if (typeof adv.one_line !== 'string') errors.push('advisory.one_line must be a string');
    else if (adv.one_line.length > 200) errors.push(`advisory.one_line exceeds 200 chars (${adv.one_line.length})`);
  }

  if (!STATUSES.includes(entry.status)) errors.push(`invalid status: ${JSON.stringify(entry.status)} (want ${STATUSES.join('|')})`);

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Per-entry trigger compilation (A9). A malformed regex on ONE entry must not
// poison the load — callers wrap this in try/catch and skip the bad entry.
// ---------------------------------------------------------------------------

function compileTrigger(entry) {
  if (!entry || typeof entry !== 'object') return entry; // fail-soft on the exported surface
  const out = Object.assign({}, entry);
  if (entry.check && entry.check.type === 'regex' && entry.check.pattern != null) {
    // Throws on a malformed pattern — caught by the caller, entry skipped.
    out._checkRegex = new RegExp(entry.check.pattern, entry.check.flags || '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSONL reader — per-line try/catch. A malformed line is skipped (logged),
// never aborts the file. Missing/unreadable file ⇒ [] (not an error).
// ---------------------------------------------------------------------------

function readJsonlSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return []; // missing or unreadable — optional overlay, not an error
  }
  const rows = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue; // blank/comment
    try {
      rows.push({ lineNo: i + 1, obj: JSON.parse(line) });
    } catch (e) {
      rows.push({ lineNo: i + 1, error: e.message });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Forbidden-strings screen (A11 / AMEND-2). Shell out to gitleaks over the
// concatenated advisory text + path fields. An entry that trips is DROPPED +
// logged (it never reaches agent context or public STATUS.md). FAIL-SOFT: if
// gitleaks is absent or errors, log once and return entries unscreened (the
// repo registry is gitleaks-clean via the pre-commit hook; overlays are
// operator-local + lower-risk). NO forbidden patterns are hardcoded here.
// ---------------------------------------------------------------------------

function _screenableText(entry) {
  const parts = [
    entry.title,
    entry.advisory && entry.advisory.one_line,
    entry.advisory && entry.advisory.procedure_path,
    entry.enforcement && entry.enforcement.ref,
    entry.source && entry.source.incident,
    entry.source && entry.source.memory_recall_query,
  ];
  // One physical line per entry so a gitleaks finding's StartLine maps 1:1.
  return parts.filter((p) => typeof p === 'string').join(' ').replace(/[\r\n]+/g, ' ');
}

function screenEntries(entries, opts = {}) {
  if (!entries.length) return entries;
  const gitleaksBin = opts.gitleaksBin || '/usr/local/bin/gitleaks';
  const configPath = opts.gitleaksConfig || path.join(os.homedir(), '.gitleaks.toml');

  // gitleaks present?
  try {
    if (!fs.existsSync(gitleaksBin)) {
      if (!_warnedGitleaksAbsent) {
        log(`gitleaks not found at ${gitleaksBin} — skipping forbidden-string screen (fail-soft). Repo registry is gitleaks-clean via pre-commit.`);
        _warnedGitleaksAbsent = true;
      }
      return entries;
    }
  } catch (_e) {
    return entries; // fail-soft
  }

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctrine-screen-'));
    const payloadPath = path.join(tmpDir, 'screen.txt');
    const reportPath = path.join(tmpDir, 'report.json');
    // line i (1-based) ↔ entries[i-1]
    fs.writeFileSync(payloadPath, entries.map(_screenableText).join('\n') + '\n', 'utf8');

    const args = ['detect', '--no-git', '--source', tmpDir,
      '--report-format', 'json', '--report-path', reportPath, '--no-banner'];
    if (configPath && fs.existsSync(configPath)) args.push('-c', configPath);

    const res = spawnSync(gitleaksBin, args, { encoding: 'utf8', timeout: 20000 });
    // status 0 = clean, 1 = leaks found, >1 / null = tool error (fail-soft).
    if (res.error) {
      log(`gitleaks invocation errored (fail-soft, unscreened): ${res.error.message}`);
      return entries;
    }
    let findings = [];
    try {
      findings = JSON.parse(fs.readFileSync(reportPath, 'utf8') || '[]');
    } catch (_e) {
      // No/!json report. If status signalled a leak we can't isolate, be safe
      // and drop nothing only when status==0; otherwise log + keep (fail-soft).
      if (res.status && res.status !== 0) {
        log(`gitleaks reported status ${res.status} but report unparseable (fail-soft, unscreened)`);
      }
      return entries;
    }
    if (!Array.isArray(findings) || !findings.length) return entries;

    const taintedIdx = new Set();
    for (const f of findings) {
      const ln = f && (f.StartLine || f.startLine);
      if (typeof ln === 'number' && ln >= 1 && ln <= entries.length) taintedIdx.add(ln - 1);
    }
    if (!taintedIdx.size) return entries;
    const kept = [];
    entries.forEach((e, i) => {
      if (taintedIdx.has(i)) {
        log(`DROPPED entry '${e && e.id}' (origin=${e && e._origin}) — advisory text/path tripped the forbidden-string screen; not surfaced.`);
      } else {
        kept.push(e);
      }
    });
    return kept;
  } catch (e) {
    log(`forbidden-string screen failed (fail-soft, unscreened): ${e.message}`);
    return entries;
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } }
  }
}

// ---------------------------------------------------------------------------
// loadDoctrine — merge repo registry + 2 optional overlays (precedence:
// repo < ~/.claude overlay < ~/.termdeck overlay; later overrides by id),
// validate + compile + screen each entry. Both overlays absent ⇒ repo entries.
// NEVER throws (acceptance gate). Cached by source signature (mtime+size+path);
// pass opts.noCache to bypass.
// ---------------------------------------------------------------------------

let _cache = null; // { sig, entries }

function _collectSources(opts) {
  const repo = opts.repoRegistry || defaultRepoRegistry();
  const claude = opts.claudeOverlay || defaultClaudeOverlay();
  const tdDir = opts.termdeckOverlayDir || defaultTermdeckOverlayDir();
  const sources = [{ path: repo, origin: 'repo' }];
  sources.push({ path: claude, origin: 'local' });
  // ~/.termdeck/doctrine-local/ is a DIR of *.jsonl files
  try {
    if (fs.existsSync(tdDir) && fs.statSync(tdDir).isDirectory()) {
      const files = fs.readdirSync(tdDir).filter((f) => f.endsWith('.jsonl')).sort();
      for (const f of files) sources.push({ path: path.join(tdDir, f), origin: 'local' });
    }
  } catch (_e) { /* optional — ignore */ }
  return sources;
}

function _sourcesSignature(sources) {
  return sources.map((s) => {
    try {
      const st = fs.statSync(s.path);
      return `${s.path}:${st.size}:${st.mtimeMs}`;
    } catch (_e) {
      return `${s.path}:absent`;
    }
  }).join('|');
}

function _filterEntries(entries, opts) {
  let out = entries;
  if (opts.audience) {
    out = out.filter((e) => e.audience === 'all' || e.audience === opts.audience);
  }
  if (opts.event) {
    out = out.filter((e) => {
      const t = e.trigger;
      if (t == null || t === 'always') return true;
      if (Array.isArray(t)) return t.includes(opts.event) || t.includes('always');
      return t === opts.event;
    });
  }
  return out;
}

function loadDoctrine(opts = {}) {
  try {
    const sources = _collectSources(opts);
    const sig = _sourcesSignature(sources);
    if (_cache && _cache.sig === sig && !opts.noCache) {
      return _filterEntries(_cache.entries, opts);
    }
    const byId = new Map(); // later sources override earlier by id
    for (const src of sources) {
      const rows = readJsonlSafe(src.path);
      for (const row of rows) {
        if (row.error) {
          log(`skip malformed JSONL ${src.path}:${row.lineNo} — ${row.error}`);
          continue;
        }
        const obj = row.obj;
        try {
          const v = validateEntry(obj);
          if (!v.valid) {
            log(`DROP invalid entry '${obj && obj.id}' (${src.origin}) — ${v.errors.join('; ')}`);
            continue;
          }
          const compiled = compileTrigger(obj); // may throw (bad regex)
          compiled._origin = src.origin;
          byId.set(compiled.id, compiled);
        } catch (e) {
          log(`skip entry '${obj && obj.id}' (${src.origin}) — trigger compile error: ${e.message}`);
        }
      }
    }
    let entries = Array.from(byId.values());
    entries = screenEntries(entries, opts);
    _cache = { sig, entries };
    return _filterEntries(entries, opts);
  } catch (err) {
    log(`loadDoctrine failed (fail-soft, returning []): ${err && err.message}`);
    return [];
  }
}

function clearCache() { _cache = null; }

// ---------------------------------------------------------------------------
// Throttle + event log. Both NEVER throw (AMEND-11) — they ride hook/commit/
// inject/PTY paths.
// ---------------------------------------------------------------------------

function _toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const t = Date.parse(now);
  return Number.isNaN(t) ? Date.now() : t;
}
function _toIso(ms) { return new Date(ms).toISOString(); }

function recordGateEvent(evt = {}, opts = {}) {
  try {
    const db = _resolveDb(opts);
    if (!db || typeof db.prepare !== 'function') {
      return { recorded: false, reason: 'no-db' };
    }
    const firedAt = _toIso(_toMs(opts.now));
    db.prepare(
      `INSERT INTO doctrine_events
         (fired_at, rule_id, dedupe_key, lane, surface, outcome, reason, session_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      firedAt,
      evt.rule_id || null,
      evt.dedupe_key || null,
      // lane preserved faithfully (not `|| null`) so a falsy-but-present lane is
      // stored verbatim and the `WHERE lane = ?` budget query matches the
      // `if (lane != null)` guard in shouldNotify — no guard/insert split.
      evt.lane != null ? evt.lane : null,
      evt.surface || null,
      evt.outcome || 'recorded',
      evt.reason || null,
      evt.session_id || null,
      evt.detail != null ? (typeof evt.detail === 'string' ? evt.detail : JSON.stringify(evt.detail)) : null
    );
    return { recorded: true };
  } catch (err) {
    log(`recordGateEvent failed (fail-soft): ${err && err.message}`);
    return { recorded: false, reason: 'error', error: err && err.message };
  }
}

// shouldNotify — the per-RULE registry-stage throttle T2 consumes. STABLE
// SIGNATURE: shouldNotify(rule_id, dedupe_key, opts). opts: { lane, surface,
// session_id, db, now, cooldownMs, hourlyBudget, record }. Returns
// { notify, reason, outcome, recorded, route? }. Records its decision into
// doctrine_events (so the cooldown/budget are self-enforcing) unless
// opts.record === false. NEVER throws.
function shouldNotify(rule_id, dedupe_key, opts = {}) {
  const cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : DEFAULT_RULE_COOLDOWN_MS;
  const hourlyBudget = opts.hourlyBudget != null ? opts.hourlyBudget : DEFAULT_LANE_HOURLY_BUDGET;
  const lane = opts.lane != null ? opts.lane : null;
  const surface = opts.surface != null ? opts.surface : null;
  const session_id = opts.session_id != null ? opts.session_id : null;
  const record = opts.record !== false;
  const nowMs = _toMs(opts.now);

  try {
    const db = _resolveDb(opts);
    if (!db || typeof db.prepare !== 'function') {
      // Can't throttle without the store. Allow (T2's per-entry suppression
      // layer backstops spam); do not record. Fail-soft, never blocks delivery.
      return { notify: true, reason: 'no-db-failsoft', outcome: 'notified-failsoft', recorded: false };
    }

    // 1. Hard per-lane hourly budget (counts only delivered = 'notified').
    if (lane != null) {
      const since = _toIso(nowMs - 60 * 60 * 1000);
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM doctrine_events
          WHERE lane = ? AND outcome = 'notified' AND fired_at >= ?`
      ).get(lane, since);
      if (row && row.n >= hourlyBudget) {
        const decision = { notify: false, reason: 'lane-hourly-budget-exceeded', outcome: 'overflow-orch', route: 'orch' };
        if (record) recordGateEvent({ rule_id, dedupe_key, lane, surface, session_id, outcome: decision.outcome, reason: decision.reason }, { db, now: nowMs });
        return Object.assign({}, decision, { recorded: record });
      }
    }

    // 2. Per-rule cooldown (last delivered for this rule within the window).
    const cdSince = _toIso(nowMs - cooldownMs);
    const last = db.prepare(
      `SELECT fired_at FROM doctrine_events
        WHERE rule_id = ? AND outcome = 'notified' AND fired_at >= ?
        ORDER BY fired_at DESC LIMIT 1`
    ).get(rule_id, cdSince);
    if (last) {
      const decision = { notify: false, reason: 'rule-cooldown-active', outcome: 'suppressed-cooldown' };
      if (record) recordGateEvent({ rule_id, dedupe_key, lane, surface, session_id, outcome: decision.outcome, reason: decision.reason }, { db, now: nowMs });
      return Object.assign({}, decision, { recorded: record });
    }

    // 3. Allow.
    if (record) recordGateEvent({ rule_id, dedupe_key, lane, surface, session_id, outcome: 'notified' }, { db, now: nowMs });
    return { notify: true, reason: 'ok', outcome: 'notified', recorded: record };
  } catch (err) {
    log(`shouldNotify failed (fail-soft, allowing): ${err && err.message}`);
    return { notify: true, reason: 'throttle-error-failsoft', outcome: 'error', recorded: false };
  }
}

module.exports = {
  // version + enums (field contract)
  DOCTRINE_REGISTRY_VERSION,
  SURFACES,
  BLOCK_ALLOWED_SURFACES,
  CHECK_TYPES,
  MAX_SEVERITIES,
  SCOPES,
  SEVERITIES,
  STATUSES,
  // store
  DOCTRINE_EVENTS_SQL,
  DEFAULT_RULE_COOLDOWN_MS,
  DEFAULT_LANE_HOURLY_BUDGET,
  setDb,
  // loader
  loadDoctrine,
  validateEntry,
  compileTrigger,
  screenEntries,
  clearCache,
  // throttle
  recordGateEvent,
  shouldNotify,
  // path helpers (exported for the stack-installer + tests)
  defaultRepoRegistry,
  defaultClaudeOverlay,
  defaultTermdeckOverlayDir,
};
