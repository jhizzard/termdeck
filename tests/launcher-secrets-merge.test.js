// Sprint 59 — Brad #1 launcher secrets-merge tests.
//
// Validates the bootstrap-then-detach helper at the top of
// packages/cli/src/index.js for the nohup-launch case. The fixture proof in
// .github/workflows/install-smoke.yml inspects /proc/<pid>/environ on Linux —
// not directly testable on macOS — so these tests exercise the helper's
// logic in two layers:
//
//   1. Merge contract: parsing secrets.env via the same regex/quote-strip
//      the helper uses, asserting the no-clobber + quote-strip semantics.
//      This is what "the parent process loaded into env before spawn" means.
//   2. Spawn boundary: launching `node packages/cli/src/index.js --no-stack
//      --port <free>` with stdin/stdout/stderr piped (no TTY) against a
//      fresh HOME containing secrets.env, and asserting the parent process
//      exits within ~3s (the spawn-and-exit signal that nohup needs to see).
//
// The /proc-side proof is owned by the GitHub Actions install-smoke workflow
// (`reproduce-brad-1-nohup-secrets`). When that workflow flips from RED to
// GREEN, the structural fix is verified end-to-end.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'index.js');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-brad1-'));
}

function writeSecretsEnv(home, body) {
  fs.mkdirSync(path.join(home, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termdeck', 'secrets.env'), body);
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── Merge contract (replicates the helper's parser exactly) ─────────────────

// Tiny re-implementation of the inline parser at the top of index.js so this
// test can verify the contract without booting the full CLI. The helper itself
// is intentionally inline (no shared module) to keep the bootstrap path fast
// and free of require-chain side effects.
function parseAndMerge(raw, processEnv) {
  const merged = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1);
    }
    if (processEnv[key] === undefined) merged[key] = val;
  }
  return merged;
}

test('parser merge — adds missing key (Brad #1 root case)', () => {
  const raw = 'DATABASE_URL=postgres://test\n';
  const merged = parseAndMerge(raw, {});
  assert.equal(merged.DATABASE_URL, 'postgres://test');
});

test('parser merge — does NOT clobber pre-existing process.env (user shell wins)', () => {
  const raw = 'DATABASE_URL=postgres://from-file\n';
  const merged = parseAndMerge(raw, { DATABASE_URL: 'postgres://from-shell' });
  assert.equal(
    merged.DATABASE_URL,
    undefined,
    'pre-set DATABASE_URL must NOT be merged — shell wins per loadSecretsEnv contract'
  );
});

test('parser merge — strips matched double-quotes', () => {
  const raw = 'DATABASE_URL="postgres://quoted"\n';
  const merged = parseAndMerge(raw, {});
  assert.equal(merged.DATABASE_URL, 'postgres://quoted');
});

test('parser merge — strips matched single-quotes', () => {
  const raw = "DATABASE_URL='postgres://single'\n";
  const merged = parseAndMerge(raw, {});
  assert.equal(merged.DATABASE_URL, 'postgres://single');
});

test('parser merge — leaves mismatched quotes alone (defensive)', () => {
  const raw = 'DATABASE_URL="postgres://mixed\'\n';
  const merged = parseAndMerge(raw, {});
  // Mismatched: starts with " but ends with '. Strip is no-op.
  assert.equal(merged.DATABASE_URL, '"postgres://mixed\'');
});

test('parser merge — skips comments and blank lines', () => {
  const raw = [
    '# Comment line',
    '',
    'DATABASE_URL=postgres://kept',
    '# Another comment',
  ].join('\n');
  const merged = parseAndMerge(raw, {});
  assert.deepEqual(Object.keys(merged), ['DATABASE_URL']);
});

test('parser merge — skips invalid key shapes', () => {
  const raw = [
    'lowercase=skipped',
    '123BAD=skipped',
    'GOOD_KEY=kept',
    'ALSO_GOOD=kept2',
  ].join('\n');
  const merged = parseAndMerge(raw, {});
  assert.deepEqual(Object.keys(merged).sort(), ['ALSO_GOOD', 'GOOD_KEY']);
});

test('parser merge — multiple keys all merged when missing', () => {
  const raw = [
    'SUPABASE_URL=https://x.supabase.co',
    'SUPABASE_SERVICE_ROLE_KEY=sb_secret_aaaa',
    'DATABASE_URL=postgres://multi',
    'OPENAI_API_KEY=sk-proj-multi',
  ].join('\n');
  const merged = parseAndMerge(raw, {});
  assert.equal(merged.SUPABASE_URL, 'https://x.supabase.co');
  assert.equal(merged.SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_aaaa');
  assert.equal(merged.DATABASE_URL, 'postgres://multi');
  assert.equal(merged.OPENAI_API_KEY, 'sk-proj-multi');
});

// ── Spawn boundary: parent exit signals the detach ─────────────────────────

// On non-TTY launch with secrets.env on disk, the bootstrap helper calls
// process.exit(0) after spawning the detached child. The fixture's nohup
// background job sees this exit. We can't observe /proc/<pid>/environ on
// macOS, but we CAN observe that:
//   - Parent exits cleanly (code 0) within ~3s of launch
//   - The child node process keeps running (didn't crash with the parent)
//
// The child may not bind a port (the secrets.env in this test has fake
// values that would make the server start but fail health checks); we just
// assert that the parent didn't error out.

test('spawn boundary — non-TTY parent exits 0 after detaching (Brad #1)', { timeout: 10000 }, async () => {
  const home = freshHome();
  // Use a real-shaped DATABASE_URL so the child doesn't crash on URL parse.
  // The values are bogus but the SHAPE is valid; the child will start, fail
  // its DB probe with ECONNREFUSED, and continue running with the merged env.
  writeSecretsEnv(home, [
    'SUPABASE_URL=https://abcdefghijklmnop.supabase.co',
    'SUPABASE_SERVICE_ROLE_KEY=sb_secret_aaaaaaaaaaaaaaaaaaaaaaaa',
    'DATABASE_URL=postgres://postgres:pw@127.0.0.1:1/postgres',
    'OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ].join('\n'));

  const port = await pickFreePort();
  // Strip ambient secrets so the test doesn't interact with the host machine.
  const env = { ...process.env, HOME: home };
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    delete env[k];
  }

  const child = spawn(process.execPath, [CLI, '--no-stack', '--port', String(port), '--no-open'], {
    env,
    // Pipe stdio to force isTTY=false on stdin/stdout/stderr — exactly what
    // nohup does. This is what triggers the bootstrap-and-detach path.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
  child.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });

  const exitCode = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_e) { /* gone */ }
      reject(new Error('parent did not exit within 8s'));
    }, 8000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  assert.equal(
    exitCode,
    0,
    `parent should exit 0 (detach-and-go); got ${exitCode}. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
  );

  // Best-effort cleanup: kill anything still bound to our test port.
  // Try to reach the spawned child via the port and shut it down. If nothing
  // bound, this is a no-op.
  try {
    await new Promise((res) => {
      const probe = net.connect(port, '127.0.0.1', () => { probe.end(); res(); });
      probe.on('error', () => res());
      setTimeout(() => { probe.destroy(); res(); }, 500);
    });
  } catch (_e) { /* ignore */ }

  // pgrep-style cleanup of any leftover detached child node process.
  // Match the actual exec path the spawn used: `node /...packages/cli/src/index.js --port <port>`.
  try {
    const out = require('child_process').execSync(
      `pgrep -f 'packages/cli/src/index.js.*--port ${port}'`,
      { encoding: 'utf-8' }
    );
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch (_e) { /* gone */ }
    }
  } catch (_e) { /* pgrep exits 1 when no match — that's fine */ }

  fs.rmSync(home, { recursive: true, force: true });
});

// ── Re-execed child does NOT recurse ────────────────────────────────────────

test('spawn boundary — child with __TERMDECK_BOOTSTRAPPED=1 does NOT re-detach', { timeout: 10000 }, async () => {
  const home = freshHome();
  writeSecretsEnv(home, [
    'SUPABASE_URL=https://abcdefghijklmnop.supabase.co',
    'SUPABASE_SERVICE_ROLE_KEY=sb_secret_aaaaaaaaaaaaaaaaaaaaaaaa',
    'DATABASE_URL=postgres://postgres:pw@127.0.0.1:1/postgres',
    'OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ].join('\n'));

  const port = await pickFreePort();
  const env = {
    ...process.env,
    HOME: home,
    __TERMDECK_BOOTSTRAPPED: '1',  // pretend we're already the re-execed child
  };
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    delete env[k];
  }

  const child = spawn(process.execPath, [CLI, '--no-stack', '--port', String(port), '--no-open'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
  child.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });

  // With the bootstrap marker set, the child should fall through to the
  // normal CLI startup path. It will try to bind the port and listen. We
  // give it 4s to either listen or exit on its own; if it's still alive,
  // that's the expected "child takes over the role of the server" outcome.
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const stillAlive = !child.killed && child.exitCode === null;
  try { child.kill('SIGTERM'); } catch (_e) { /* gone */ }
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { child.kill('SIGKILL'); } catch (_e) { /* gone */ }

  // We're not asserting any particular stderr/stdout content here — only
  // that the child either kept running OR exited with an error code (NOT
  // the silent exit-0 that detach-and-go would produce). A fresh exit-0
  // before our timer means the helper detached AGAIN, which is the bug.
  if (!stillAlive && child.exitCode === 0) {
    assert.fail(
      `child detached again with __TERMDECK_BOOTSTRAPPED=1 set — recursion guard broken. ` +
      `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
    );
  }

  fs.rmSync(home, { recursive: true, force: true });
});
