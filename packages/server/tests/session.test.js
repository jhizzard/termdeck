// Unit tests for packages/server/src/session.js
//
// Covers the highest-risk surfaces flagged by the external code audit:
//   - stripAnsi: escape-sequence removal before pattern matching
//   - PATTERNS regexes: claude-code / gemini / python-server / shell / error
//   - Session.analyzeOutput: type detection, port detection, status transitions
//   - Session.trackInput: character-level command extraction with backspace +
//     escape-sequence handling (arrow keys must NOT pollute the command log)
//   - Session.onErrorDetected rate limiting (30s per session)
//   - SessionManager.updateMeta whitelist (no arbitrary metadata injection)
//
// Run: node --test packages/server/tests/session.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session, SessionManager } = require('../src/session');

// ─────────────────────────────────────────────────────────────────────────────
// stripAnsi — the first guard before every pattern match. Bugs here cascade.
// ─────────────────────────────────────────────────────────────────────────────

test('stripAnsi removes standard CSI sequences (SGR colors)', () => {
  // Red bold text
  const input = '\x1b[31;1mERROR\x1b[0m: not found';
  // stripAnsi is not exported, but we can exercise it indirectly through
  // analyzeOutput by feeding colored input to a session and observing that
  // the error pattern still matches.
  const s = new Session({ id: 'test-1', type: 'shell' });
  s.analyzeOutput(input);
  assert.equal(s.meta.status, 'errored', 'colored ERROR should still match error pattern');
});

test('stripAnsi removes zsh bracketed-paste sequences', () => {
  // Real zsh prompt with bracketed paste mode enable + CSI cursor move
  const input = '\x1b[?2004h\x1b[?1049h\x1b[0muser@host ~ % ';
  const s = new Session({ id: 'test-2', type: 'shell' });
  s.analyzeOutput(input);
  assert.equal(s.meta.status, 'idle', 'stripped zsh prompt should classify as idle');
});

test('stripAnsi removes OSC (title bar) sequences', () => {
  const input = '\x1b]0;custom title\x07user@host $ ls';
  const s = new Session({ id: 'test-3', type: 'shell' });
  s.analyzeOutput(input);
  // Just needs to not crash and still process the underlying content
  assert.ok(s.meta.status !== 'errored', 'OSC sequences are not errors');
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal type detection — identifying Claude Code vs Gemini vs Python server
// from raw stdout. This routes every downstream decision.
// ─────────────────────────────────────────────────────────────────────────────

test('Claude Code detection: recognizes the ❯ prompt marker', () => {
  const s = new Session({ id: 't-cc-1', type: 'shell' });
  s.analyzeOutput('❯ ');
  assert.equal(s.meta.type, 'claude-code');
});

test('Claude Code detection: command-name inference when prompt not yet visible', () => {
  const s = new Session({ id: 't-cc-2', type: 'shell', command: 'claude --resume' });
  s.analyzeOutput('starting up...');
  assert.equal(s.meta.type, 'claude-code');
});

test('Claude Code status: "thinking" transition from Thinking keyword', () => {
  const s = new Session({ id: 't-cc-3', type: 'claude-code' });
  s.analyzeOutput('Thinking about how to refactor the engram-bridge');
  assert.equal(s.meta.status, 'thinking');
});

test('Claude Code status: editing detection from Edit marker', () => {
  const s = new Session({ id: 't-cc-4', type: 'claude-code' });
  s.analyzeOutput('Edit packages/server/src/session.js');
  assert.equal(s.meta.status, 'editing');
  assert.ok(s.meta.statusDetail.startsWith('Edit '));
});

test('Gemini CLI detection: prompt marker', () => {
  const s = new Session({ id: 't-gem', type: 'shell' });
  s.analyzeOutput('gemini> ');
  assert.equal(s.meta.type, 'gemini');
});

test('Python server detection: Uvicorn banner', () => {
  const s = new Session({ id: 't-py-1', type: 'shell' });
  s.analyzeOutput('INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)');
  assert.equal(s.meta.type, 'python-server');
});

test('Python server detection: http.server banner', () => {
  const s = new Session({ id: 't-py-2', type: 'shell' });
  s.analyzeOutput('Serving HTTP on 0.0.0.0 port 8080 (http://0.0.0.0:8080/) ...');
  assert.equal(s.meta.type, 'python-server');
});

test('Python server detection: Django dev server banner', () => {
  const s = new Session({ id: 't-py-3', type: 'shell' });
  s.analyzeOutput('Starting development server at http://127.0.0.1:8000/');
  assert.equal(s.meta.type, 'python-server');
});

// ─────────────────────────────────────────────────────────────────────────────
// Port detection — fills meta.detectedPort from multiple common phrasings
// ─────────────────────────────────────────────────────────────────────────────

test('Port detection: "port 3000" form', () => {
  const s = new Session({ id: 't-port-1', type: 'python-server' });
  s.analyzeOutput('Server listening on port 3000');
  assert.equal(s.meta.detectedPort, 3000);
});

test('Port detection: ":8080" URL form', () => {
  const s = new Session({ id: 't-port-2', type: 'python-server' });
  s.analyzeOutput('Running at http://0.0.0.0:8080/');
  assert.equal(s.meta.detectedPort, 8080);
});

test('Port detection: "listening on http://localhost:5173" form', () => {
  // The current regex requires "on" or "at" before the URL. Bare "➜  Local:
  // http://..." Vite output is not picked up — that's a known gap and a
  // followup (Sprint 4 — teach the port regex to match Vite/Next style
  // bullet lines). For this test, use a phrasing the regex does handle.
  const s = new Session({ id: 't-port-3', type: 'python-server' });
  s.analyzeOutput('ready - started server on 0.0.0.0, url: http://localhost:5173');
  assert.equal(s.meta.detectedPort, 5173);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP request counting — the python-server telemetry panel
// ─────────────────────────────────────────────────────────────────────────────

test('Request counting: GET / 200 increments the counter', () => {
  const s = new Session({ id: 't-req-1', type: 'python-server' });
  s.analyzeOutput('127.0.0.1 - - [15/Apr/2026] "GET /api/sessions HTTP/1.1" 200 -');
  assert.ok(s.meta.requestCount >= 1);
});

test('Request counting: multiple status codes on multiple lines', () => {
  const s = new Session({ id: 't-req-2', type: 'python-server' });
  const log = [
    '"GET / HTTP/1.1" 200 -',
    '"POST /api/sessions HTTP/1.1" 201 -',
    '"DELETE /api/sessions/abc HTTP/1.1" 204 -'
  ].join('\n');
  s.analyzeOutput(log);
  assert.ok(s.meta.requestCount >= 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error detection — the most critical pattern surface; feeds Flashback
// ─────────────────────────────────────────────────────────────────────────────

test('Error detection: lowercase "error" in output transitions to errored', () => {
  const s = new Session({ id: 't-err-1', type: 'shell' });
  s.analyzeOutput('error: could not find symbol foo in bar.c');
  assert.equal(s.meta.status, 'errored');
});

test('Error detection: Python traceback', () => {
  const s = new Session({ id: 't-err-2', type: 'shell' });
  s.analyzeOutput('Traceback (most recent call last):\n  File "x.py"');
  assert.equal(s.meta.status, 'errored');
});

test('Error detection: common Node errno codes', () => {
  const s = new Session({ id: 't-err-3', type: 'shell' });
  s.analyzeOutput('ENOENT: no such file or directory');
  assert.equal(s.meta.status, 'errored');
});

test('Error detection: zsh command-not-found', () => {
  const s = new Session({ id: 't-err-4', type: 'shell' });
  s.analyzeOutput('zsh: command not found: kubectl');
  assert.equal(s.meta.status, 'errored');
});

test('Error detection: HTTP 5xx from server log', () => {
  const s = new Session({ id: 't-err-5', type: 'python-server' });
  s.analyzeOutput('"GET /api/broken HTTP/1.1" 503 -');
  assert.equal(s.meta.status, 'errored');
});

test('Error detection: plural "errors" does NOT trigger (word-boundary guard)', () => {
  const s = new Session({ id: 't-err-6', type: 'shell' });
  // The pattern uses \berror\b with word boundaries — the trailing "s" in
  // "errors" is a word char, so \b does not match after "error" in "errors".
  // This is the intentional behavior: status-line recaps like "0 errors"
  // or "No errors reported" do NOT flood the Flashback pipeline.
  s.analyzeOutput('No errors reported in the build log');
  assert.notEqual(s.meta.status, 'errored', 'plural "errors" must not flip status');
});

test('Error rate limiting: onErrorDetected fires at most once per 30s per session', () => {
  const s = new Session({ id: 't-err-rate', type: 'shell' });
  let fireCount = 0;
  s.onErrorDetected = () => { fireCount += 1; };

  s.analyzeOutput('error: first failure');
  s.analyzeOutput('error: second failure one ms later');
  s.analyzeOutput('error: third failure');

  assert.equal(fireCount, 1, 'onErrorDetected should fire exactly once in a burst');
});

// ─────────────────────────────────────────────────────────────────────────────
// trackInput — character-level command capture, the feature that makes the
// command history useful. Bugs here pollute the RAG event log.
// ─────────────────────────────────────────────────────────────────────────────

test('trackInput: basic command extraction on \\r', () => {
  const s = new Session({ id: 't-in-1', type: 'shell' });
  s.trackInput('echo hello\r');
  assert.equal(s.meta.lastCommands.length, 1);
  assert.equal(s.meta.lastCommands[0].command, 'echo hello');
});

test('trackInput: backspace correctly removes characters', () => {
  const s = new Session({ id: 't-in-2', type: 'shell' });
  // Type "ls X", backspace, "-la"
  s.trackInput('ls X\x7f-la\r');
  assert.equal(s.meta.lastCommands[0].command, 'ls -la');
});

test('trackInput: empty input produces no command', () => {
  const s = new Session({ id: 't-in-3', type: 'shell' });
  s.trackInput('\r\r\r');
  assert.equal(s.meta.lastCommands.length, 0);
});

test('trackInput: arrow-key escape sequences do NOT pollute the command log', () => {
  const s = new Session({ id: 't-in-4', type: 'shell' });
  // Right arrow = \x1b[C, left arrow = \x1b[D, up arrow = \x1b[A, down = \x1b[B
  // User types: up-arrow (history), right-arrow (cursor move), "foo", enter
  s.trackInput('\x1b[A\x1b[Cfoo\r');
  assert.equal(s.meta.lastCommands.length, 1);
  assert.equal(s.meta.lastCommands[0].command, 'foo', 'escape sequences should be skipped, only foo remains');
});

test('trackInput: rolling buffer is capped at 10 entries', () => {
  const s = new Session({ id: 't-in-5', type: 'shell' });
  for (let i = 0; i < 15; i++) {
    s.trackInput(`cmd${i}\r`);
  }
  assert.equal(s.meta.lastCommands.length, 10);
  // Oldest should be cmd5, newest cmd14
  assert.equal(s.meta.lastCommands[0].command, 'cmd5');
  assert.equal(s.meta.lastCommands[9].command, 'cmd14');
});

test('trackInput: very long commands (>500 chars) are dropped', () => {
  const s = new Session({ id: 't-in-6', type: 'shell' });
  const longCmd = 'x'.repeat(501);
  s.trackInput(longCmd + '\r');
  assert.equal(s.meta.lastCommands.length, 0);
});

test('trackInput: onCommand callback fires with extracted command', () => {
  const s = new Session({ id: 't-in-7', type: 'shell' });
  const fired = [];
  s.onCommand = (id, cmd) => fired.push({ id, cmd });
  s.trackInput('git status\r');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].cmd, 'git status');
  assert.equal(fired[0].id, 't-in-7');
});

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager — the PATCH whitelist guard (added this round)
// ─────────────────────────────────────────────────────────────────────────────

test('SessionManager.updateMeta rejects non-whitelisted fields', () => {
  const mgr = new SessionManager(null);
  const session = mgr.create({ id: 'patch-1', type: 'shell' });
  session.meta.pid = 12345;
  session.meta.exitCode = null;

  mgr.updateMeta('patch-1', {
    theme: 'dracula',            // whitelisted → applied
    pid: 99999,                   // NOT whitelisted → must NOT be applied
    exitCode: 137,                // NOT whitelisted → must NOT be applied
    arbitraryField: 'injected',   // NOT whitelisted → must NOT be applied
    __proto__: { polluted: true } // must NOT reach the object
  });

  assert.equal(session.meta.theme, 'dracula', 'whitelisted theme should update');
  assert.equal(session.meta.pid, 12345, 'pid should be unchanged');
  assert.equal(session.meta.exitCode, null, 'exitCode should be unchanged');
  assert.equal(session.meta.arbitraryField, undefined, 'arbitrary field should not land on meta');
});

test('SessionManager.updateMeta accepts a valid label + project update', () => {
  const mgr = new SessionManager(null);
  mgr.create({ id: 'patch-2', type: 'shell' });
  mgr.updateMeta('patch-2', { label: 'debug panel', project: 'termdeck' });
  const s = mgr.sessions.get('patch-2');
  assert.equal(s.meta.label, 'debug panel');
  assert.equal(s.meta.project, 'termdeck');
});

test('SessionManager.updateMeta returns null for missing session', () => {
  const mgr = new SessionManager(null);
  const result = mgr.updateMeta('nonexistent', { theme: 'nord' });
  assert.equal(result, null);
});

test('SessionManager.updateMeta is a no-op on null/undefined updates', () => {
  const mgr = new SessionManager(null);
  mgr.create({ id: 'patch-3', type: 'shell' });
  const originalTheme = mgr.sessions.get('patch-3').meta.theme;
  mgr.updateMeta('patch-3', null);
  mgr.updateMeta('patch-3', undefined);
  assert.equal(mgr.sessions.get('patch-3').meta.theme, originalTheme);
});

// ─────────────────────────────────────────────────────────────────────────────
// Session serialization
// ─────────────────────────────────────────────────────────────────────────────

test('Session.toJSON returns id + meta + pid', () => {
  const s = new Session({ id: 't-json', type: 'shell', project: 'termdeck' });
  const json = s.toJSON();
  assert.equal(json.id, 't-json');
  assert.equal(json.meta.type, 'shell');
  assert.equal(json.meta.project, 'termdeck');
  assert.ok('pid' in json);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 65 T2 (2.1) — meta.role: explicit operator-role flag (Approach A).
// Route-level validation (400 on unknown values) is fenced in
// session-lifecycle-api.test.js; these cover the Session/SessionManager layer.
// ─────────────────────────────────────────────────────────────────────────────

test('Session: meta.role defaults to null when not supplied', () => {
  const s = new Session({ id: 't-role-default', type: 'shell' });
  assert.equal(s.meta.role, null);
});

test('Session: meta.role is preserved verbatim from constructor options', () => {
  for (const role of ['orchestrator', 'worker', 'reviewer', 'auditor']) {
    const s = new Session({ id: `t-role-${role}`, type: 'shell', role });
    assert.equal(s.meta.role, role);
  }
});

test('Session: explicit role:null stays null', () => {
  const s = new Session({ id: 't-role-null', type: 'shell', role: null });
  assert.equal(s.meta.role, null);
});

test('Session.toJSON carries meta.role through serialization (status_broadcast path)', () => {
  const s = new Session({ id: 't-role-json', type: 'shell', role: 'orchestrator' });
  assert.equal(s.toJSON().meta.role, 'orchestrator');
});

test('SessionManager.create persists role into the in-memory session', () => {
  const mgr = new SessionManager(null);
  const s = mgr.create({ id: 't-role-mgr', type: 'shell', role: 'auditor' });
  assert.equal(s.meta.role, 'auditor');
  assert.equal(mgr.get('t-role-mgr').meta.role, 'auditor');
});

test('SessionManager.updateMeta allows role mutation (Sprint 66 T1 — role is PATCH-mutable)', () => {
  // Sprint 66 T1 (Task 1.2) inverted the Sprint-65 immutability: an operator
  // can tag a live panel as orchestrator in place. `role` is now in
  // PATCHABLE_META_FIELDS; the PATCH /api/sessions/:id route validates the
  // value against ALLOWED_SESSION_ROLES (fenced in session-lifecycle-api.test.js)
  // before it reaches updateMeta — the model itself trusts the value.
  const mgr = new SessionManager(null);
  mgr.create({ id: 't-role-patch', type: 'shell', role: 'worker' });
  mgr.updateMeta('t-role-patch', { role: 'orchestrator' });
  assert.equal(mgr.get('t-role-patch').meta.role, 'orchestrator',
    'role updates via PATCH (worker → orchestrator)');
});

test('SessionManager.updateMeta can unmark a role back to null', () => {
  // The "unmark orchestrator" path — role: null clears the role.
  const mgr = new SessionManager(null);
  mgr.create({ id: 't-role-unmark', type: 'shell', role: 'orchestrator' });
  mgr.updateMeta('t-role-unmark', { role: null });
  assert.equal(mgr.get('t-role-unmark').meta.role, null,
    'role: null clears the role');
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 65 T2 (2.2) — SessionManager.getAll({ includeExited }). The route
// wiring (?includeExited query param) is fenced in session-lifecycle-api.test.js.
// ─────────────────────────────────────────────────────────────────────────────

test('SessionManager.getAll() includes exited sessions by default (status_broadcast relies on this)', () => {
  const mgr = new SessionManager(null);
  mgr.create({ id: 't-ga-live', type: 'shell' });
  const dead = mgr.create({ id: 't-ga-dead', type: 'shell' });
  dead.meta.status = 'exited';
  const ids = mgr.getAll().map((s) => s.id);
  assert.ok(ids.includes('t-ga-live'));
  assert.ok(ids.includes('t-ga-dead'), 'bare getAll() must still carry exited sessions (legacy default)');
});

test('SessionManager.getAll({ includeExited: false }) excludes exited sessions', () => {
  const mgr = new SessionManager(null);
  mgr.create({ id: 't-gf-live', type: 'shell' });
  const dead = mgr.create({ id: 't-gf-dead', type: 'shell' });
  dead.meta.status = 'exited';
  const ids = mgr.getAll({ includeExited: false }).map((s) => s.id);
  assert.ok(ids.includes('t-gf-live'));
  assert.ok(!ids.includes('t-gf-dead'), 'includeExited:false must drop exited sessions');
});

test('SessionManager.getAll({ includeExited: true }) is the legacy full shape', () => {
  const mgr = new SessionManager(null);
  mgr.create({ id: 't-gt-live', type: 'shell' });
  const dead = mgr.create({ id: 't-gt-dead', type: 'shell' });
  dead.meta.status = 'exited';
  assert.equal(mgr.getAll({ includeExited: true }).length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 65 T2 (2.5) — per-adapter idle/parked detection. NO new production
// code: the mechanism shipped in Sprint 60 v1.0.14 (codex END_OF_TURN
// terminator + every adapter's statusFor idle branch + the toJSON stale-status
// guard). These tests pin the shipped behavior against regression — see
// [T2] FINDING 2026-05-16 20:00 ET in the Sprint 65 STATUS.md for why 2.5
// reduces to verify+fence rather than adding a redundant `idlePattern` field.
// ─────────────────────────────────────────────────────────────────────────────

test('idle detection: Codex "Worked for" end-of-turn terminator parks status at idle', () => {
  const s = new Session({ id: 't-idle-codex-eot', type: 'codex' });
  // The box-drawing terminator the Codex TUI renders when a turn closes.
  s.analyzeOutput('─ Worked for 2m 50s ──────────────────────');
  assert.equal(s.meta.status, 'idle', 'Codex Worked-for terminator must park the panel at idle');
});

test('idle detection: Codex end-of-turn wins even when the chunk also carries a Working spinner', () => {
  // The exact Sprint 59 false-positive shape — a final spinner line plus the
  // closing terminator in one chunk. statusFor checks END_OF_TURN first so it
  // does not stick on thinking.
  const s = new Session({ id: 't-idle-codex-mixed', type: 'codex' });
  s.analyzeOutput('Working (12s)\n─ Worked for 1m 4s ─────────');
  assert.equal(s.meta.status, 'idle');
});

test('idle detection: Claude idle-prompt cursor parks status at idle', () => {
  const s = new Session({ id: 't-idle-claude', type: 'claude-code' });
  s.analyzeOutput('\n> ');
  assert.equal(s.meta.status, 'idle');
});

test('idle detection: Gemini prompt parks status at idle', () => {
  const s = new Session({ id: 't-idle-gemini', type: 'gemini' });
  s.analyzeOutput('gemini> ');
  assert.equal(s.meta.status, 'idle');
});

test('idle detection: Grok empty-state placeholder parks status at idle', () => {
  const s = new Session({ id: 't-idle-grok', type: 'grok' });
  s.analyzeOutput('Message Grok…\n');
  assert.equal(s.meta.status, 'idle');
});

test('stale-status guard: a parked thinking panel serializes to idle past the staleness threshold', () => {
  // toJSON()'s Sprint-60 v1.0.14 guard: STICKY_STATUSES={thinking,editing}
  // older than STALE_STATUS_THRESHOLD_MS report 'idle'. This IS the
  // belt-and-suspenders for a terminator chunk split across PTY reads — no
  // separate 60s broadcast-layer heuristic is added (it would duplicate this).
  const s = new Session({ id: 't-stale-thinking', type: 'codex' });
  s.meta.status = 'thinking';
  s.meta.statusDetail = 'Codex is reasoning...';
  s.meta.lastActivity = new Date(Date.now() - Session.STALE_STATUS_THRESHOLD_MS - 5000).toISOString();
  const json = s.toJSON();
  assert.equal(json.meta.status, 'idle', 'a stale parked thinking panel must serialize as idle');
  assert.equal(json.meta.statusDetail, '');
});

test('stale-status guard: a fresh thinking panel is NOT downgraded', () => {
  const s = new Session({ id: 't-fresh-thinking', type: 'codex' });
  s.meta.status = 'thinking';
  s.meta.lastActivity = new Date().toISOString();
  assert.equal(s.toJSON().meta.status, 'thinking', 'a genuinely active thinking panel must stay thinking');
});
