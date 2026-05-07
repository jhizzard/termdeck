// Sprint 59 T2 — Brad #7 fixture (systemd Type=simple Hetzner nightly).
//
// Two distinct surfaces are exercised here, mirroring the two-part Brad #7
// fix:
//   1. `packages/cli/src/stack.js#execTermDeck` — wait-semantics. Pre-fix the
//      function returned undefined synchronously after spawning the child, so
//      `main()` returned 0 immediately and `process.exit(0)` killed ExecStart
//      before the child bound the port. Post-fix it returns Promise<exitCode>
//      that resolves only when the child emits 'exit'.
//   2. `packages/cli/src/index.js` — the `--service` / `--non-interactive`
//      flag at the dispatcher level. Pre-fix, plain `termdeck` always routed
//      through stack.js (which was broken under systemd until #1). Post-fix
//      `--service` bypasses the auto-orchestrate detour, runs the server
//      in-process (so the launcher process IS the server — ExecStart blocks
//      naturally), and forces `--no-open` so xdg-open / open never gets
//      invoked under systemd.
//
// The live `systemctl is-active termdeck.service` check lives in Sprint 58's
// systemd-nightly Hetzner fixture (`scripts/hetzner-systemd-smoke.sh`); this
// file only verifies the unit-level invariants on the publish machine.
//
// Run: node --test tests/launcher-service-flag.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const CLI = path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'index.js');
const { _execTermDeck: execTermDeck } = require('../packages/cli/src/stack.js');

// ── execTermDeck wait-semantics (Brad #7 root cause fix) ──────────────

test('execTermDeck returns Promise<exitCode> that resolves on child exit', async () => {
  const fakeChild = new EventEmitter();
  fakeChild.kill = () => {};
  const fakeSignals = new EventEmitter();
  fakeSignals.pid = 99999;
  fakeSignals.kill = () => {};

  const promise = execTermDeck(
    { port: 3000, extra: [] },
    { spawn: () => fakeChild, signals: fakeSignals }
  );
  // Promise must not have resolved yet — the parent must be waiting on the
  // child. This is the exact invariant systemd Type=simple needs.
  let resolvedEarly = false;
  promise.then(() => { resolvedEarly = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(resolvedEarly, false, 'Promise must not resolve until child exits');

  setImmediate(() => fakeChild.emit('exit', 42, null));
  const code = await promise;
  assert.equal(code, 42);
});

test('execTermDeck resolves 0 when child exits with null code', async () => {
  const fakeChild = new EventEmitter();
  fakeChild.kill = () => {};
  const fakeSignals = new EventEmitter();
  fakeSignals.pid = 99999;
  fakeSignals.kill = () => {};

  const promise = execTermDeck(
    { port: 3000, extra: [] },
    { spawn: () => fakeChild, signals: fakeSignals }
  );
  setImmediate(() => fakeChild.emit('exit', null, null));
  const code = await promise;
  assert.equal(code, 0);
});

test('execTermDeck forwards SIGTERM to child and re-raises on parent', async () => {
  const fakeChild = new EventEmitter();
  let childKilledWith = null;
  fakeChild.kill = (sig) => { childKilledWith = sig; };

  const fakeSignals = new EventEmitter();
  fakeSignals.pid = 99999;
  let parentKilledWith = null;
  fakeSignals.kill = (pid, sig) => { parentKilledWith = { pid, sig }; };

  const promise = execTermDeck(
    { port: 3000, extra: [] },
    { spawn: () => fakeChild, signals: fakeSignals }
  );

  // Simulate systemd sending SIGTERM to the parent.
  fakeSignals.emit('SIGTERM');
  // Parent must have forwarded the signal to the child.
  assert.equal(childKilledWith, 'SIGTERM');

  // The child terminates because of the signal; emit the corresponding exit.
  setImmediate(() => fakeChild.emit('exit', null, 'SIGTERM'));
  await promise;

  // Parent re-raises the signal on itself so callers (systemd, parent shell)
  // see the right termination state.
  assert.deepEqual(parentKilledWith, { pid: 99999, sig: 'SIGTERM' });
});

test('execTermDeck passes --no-stack and the supplied port + extra to the child argv', () => {
  let capturedArgv = null;
  const fakeChild = new EventEmitter();
  fakeChild.kill = () => {};
  const fakeSpawn = (_cmd, argv) => { capturedArgv = argv; return fakeChild; };
  const fakeSignals = new EventEmitter();
  fakeSignals.pid = 99999;
  fakeSignals.kill = () => {};

  execTermDeck(
    { port: 3001, extra: ['--service', '--session-logs'] },
    { spawn: fakeSpawn, signals: fakeSignals }
  );

  // child argv shape: [<cliPath>, '--no-stack', '--port', '3001', '--service', '--session-logs']
  assert.ok(capturedArgv[0].endsWith(path.join('packages', 'cli', 'src', 'index.js')),
    `child cli path: ${capturedArgv[0]}`);
  assert.ok(capturedArgv.includes('--no-stack'), 'child must receive --no-stack to skip nested auto-orchestrate');
  assert.ok(capturedArgv.includes('--port'), 'child must receive --port');
  assert.ok(capturedArgv.includes('3001'), 'child must receive the port value as string');
  assert.ok(capturedArgv.includes('--service'), 'child must receive pass-through extra args');
  assert.ok(capturedArgv.includes('--session-logs'), 'child must receive every extra arg, in order');
});

// ── --service flag dispatcher integration ─────────────────────────────

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-test-'));
}

// Spawn the CLI, capture combined stdout+stderr for `windowMs`, then kill.
// Mirrors the helper in tests/cli-default-routing.test.js.
function captureCliOutput(args, env, windowMs = 1500) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try { child.kill('SIGTERM'); } catch (_e) { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 200);
    };
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { out += b.toString('utf8'); });
    child.on('exit', () => resolve(out));
    setTimeout(kill, windowMs);
  });
}

test('--help mentions --service flag', async () => {
  const home = freshHome();
  const out = await captureCliOutput(['--help'], { HOME: home, USERPROFILE: home }, 800);
  assert.match(out, /--service/, 'help text must document --service');
  assert.match(out, /--non-interactive/, 'help text must document the alias');
  assert.match(out, /Type=simple/, 'help text must explain when to use it');
});

test('plain `termdeck --service` bypasses stack.js (runs server in-process)', async () => {
  // Same logic as cli-default-routing.test.js: stack.js prints "TermDeck
  // Stack Launcher"; in-process boot prints the boxed banner. --service
  // must take the in-process path so the launcher process IS the server
  // (ExecStart blocks for the server's lifetime under Type=simple).
  const home = freshHome();
  const out = await captureCliOutput(
    ['--service', '--no-open', '--port', '0'],
    { HOME: home, USERPROFILE: home, TERMDECK_PORT: '0' },
    1500
  );
  assert.ok(!/TermDeck Stack Launcher/.test(out),
    `--service must bypass stack.js, got:\n${out}`);
});

test('plain `termdeck --non-interactive` alias also bypasses stack.js', async () => {
  const home = freshHome();
  const out = await captureCliOutput(
    ['--non-interactive', '--no-open', '--port', '0'],
    { HOME: home, USERPROFILE: home, TERMDECK_PORT: '0' },
    1500
  );
  assert.ok(!/TermDeck Stack Launcher/.test(out),
    `--non-interactive must bypass stack.js, got:\n${out}`);
});

test('`termdeck` (no --service) still routes through stack.js — flag is opt-in', async () => {
  // Pre-fix-regression guard: the new flag must not change default behavior.
  // Without --service, plain `termdeck` continues to route through stack.js
  // per Sprint 36 policy (cli-default-routing.test.js pins this).
  const home = freshHome();
  const out = await captureCliOutput([], { HOME: home, USERPROFILE: home, TERMDECK_PORT: '0' });
  assert.match(out, /TermDeck Stack Launcher/,
    'plain termdeck without --service must still go through stack.js');
});
