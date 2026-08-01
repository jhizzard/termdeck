'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Shared harness for the Sprint 68-REDUX shim fences.  —  T3
//
// Not a `.test.js` file on purpose: the default `npm test` glob
// (`packages/stack-installer/tests/**/*.test.js`, package.json:42) collects only
// `*.test.js`, so this is importable without being collected as a suite.
//
// WHY A HARNESS. Every shim invariant is about the process boundary — argv,
// exit code, TTY-ness, env, and what does or does not appear on disk afterwards.
// None of that is observable by requiring a module; it has to be driven by
// actually running the thing. So each case builds a throwaway world:
//
//     <tmp>/shims/<agent>   ← the real shim template, installed under the name
//                             the agent is derived from (the shim reads its own
//                             basename, so the filename IS the parameterisation)
//     <tmp>/bin/<agent>     ← a fake "real binary" that records argv + env and
//                             exits with a status we choose
//     <tmp>/home/           ← HOME, so ~/.termdeck lands inside the sandbox
//
// ── THE ENVIRONMENT IS NOT INHERITED, DELIBERATELY ────────────────────────────
// `spawn` with a curated env, never `...process.env`. This is load-bearing, not
// hygiene theatre: these fences are frequently authored and run *inside a
// TermDeck panel*, where TERMDECK_SESSION is set — which is precisely the
// condition the D1′ dedup guard keys on. Inheriting the developer's env would
// silently route every "capture path" case down the transparent-exec branch and
// the whole file would pass while asserting nothing. (Observed live during
// authoring: TERMDECK_SESSION=a13e2d4f-… in the authoring panel.)
// ──────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHIM_TEMPLATE = path.join(
  REPO_ROOT, 'packages', 'stack-installer', 'assets', 'shims', 'shim-template.sh',
);
const DRAIN_JS = path.join(
  REPO_ROOT, 'packages', 'stack-installer', 'assets', 'shims', 'drain.js',
);
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 's68r-shims');

// util-linux `script` takes a command STRING (`-c`) and needs `-e` to propagate
// the child's exit status; BSD/macOS `script` takes argv directly and propagates
// status natively. The shim itself branches on this; the harness has to as well,
// or every PTY case would be a no-op on the other platform.
function scriptFlavour() {
  const r = spawnSync('script', ['--version'], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return /util-linux/i.test(out) ? 'util-linux' : 'bsd';
}

/**
 * Build a sandbox world. Returns handles plus helpers bound to it.
 *
 * @param {object}  opts
 * @param {string}  opts.agent        binary name to install the shim as
 * @param {boolean} opts.realBinary   install a fake real binary after the shim
 * @param {number}  opts.realExit     exit status the fake binary returns
 * @param {string}  opts.realStdout   what the fake binary prints
 * @param {number}  opts.extraReals   additional fake binaries in later PATH dirs
 */
function makeWorld(opts = {}) {
  const {
    agent = 'codex',
    realBinary = true,
    realExit = 0,
    realStdout = 'hello from the real binary',
    extraReals = 0,
  } = opts;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's68r-shim-'));
  const shimDir = path.join(root, 'shims');
  const binDir = path.join(root, 'bin');
  const home = path.join(root, 'home');
  for (const d of [shimDir, binDir, home]) fs.mkdirSync(d, { recursive: true });

  // Install the REAL template under the agent's name — never a paraphrase of it.
  fs.copyFileSync(SHIM_TEMPLATE, path.join(shimDir, agent));
  fs.chmodSync(path.join(shimDir, agent), 0o755);
  fs.copyFileSync(DRAIN_JS, path.join(shimDir, 'drain.js'));
  // redact.js is part of the shipped manifest, not an optional extra. Omitting
  // it here silently downgrades every redaction case to drain.js's inline
  // fallback RULES — which are narrower than the canonical redactor, so a test
  // would report a leak the shipped product does not have. Stage what ships.
  const redactSrc = path.join(path.dirname(DRAIN_JS), 'redact.js');
  if (fs.existsSync(redactSrc)) fs.copyFileSync(redactSrc, path.join(shimDir, 'redact.js'));

  const marker = path.join(root, 'marker.txt');
  // ⚠ The fake binary must NEVER read stdin. Under the capture branch its stdin
  // is the pty SLAVE, and a read on that blocks forever — script(1) has no more
  // input to give it and will not close the master while a child holds it. An
  // early version of this harness drained stdin here "to snapshot it" and every
  // PTY case hung until the 30s timeout while still reporting the right
  // artifacts on disk, which reads as a harness bug rather than a shim one.
  // Anything that needs to observe piped stdin uses `writeFakeHook` instead,
  // whose stdin is an ordinary pipe that actually reaches EOF.
  const writeFake = (dir, tag) => {
    const p = path.join(dir, agent);
    fs.writeFileSync(p, [
      '#!/bin/bash',
      `printf 'RAN\\t%s\\t%s\\n' "${tag}" "$*" >> "$S68R_MARKER"`,
      'printf \'ENVSNAP\\t%s\\n\' "TERMDECK_SHIM_ACTIVE=${TERMDECK_SHIM_ACTIVE:-<unset>}" >> "$S68R_MARKER"',
      `echo ${JSON.stringify(realStdout)}`,
      `exit ${realExit}`,
    ].join('\n'), { mode: 0o755 });
    return p;
  };

  const laterDirs = [];
  if (realBinary) writeFake(binDir, 'primary');
  for (let i = 0; i < extraReals; i += 1) {
    const d = path.join(root, `bin-extra-${i}`);
    fs.mkdirSync(d, { recursive: true });
    writeFake(d, `extra-${i}`);
    laterDirs.push(d);
  }

  // node's own directory has to be reachable or the shim's
  // `command -v node >/dev/null` guard short-circuits and the drain is never
  // spawned — every drain assertion would then pass vacuously against a branch
  // that never ran.
  const nodeDir = path.dirname(process.execPath);
  const pathEntries = [shimDir, binDir, ...laterDirs, nodeDir, '/usr/bin', '/bin'];

  const baseEnv = () => ({
    HOME: home,
    PATH: pathEntries.join(':'),
    TERMDECK_HOME: path.join(home, '.termdeck'),
    S68R_MARKER: marker,
    // A bare-minimum locale keeps `script`/`find` predictable across machines.
    LC_ALL: 'C',
  });

  return {
    root, shimDir, binDir, home, marker, agent, pathEntries,
    shimPath: path.join(shimDir, agent),
    baseEnv,

    /** Add another PATH entry at the FRONT (to model a later installer prepending). */
    prependPath(dir) { pathEntries.unshift(dir); },

    /**
     * Install a stand-in for the bundled memory-session-end hook that records
     * the stdin payload and the env it was handed, then returns the env var
     * that points drain.js at it.
     *
     * Its stdin is an ordinary pipe from the drain (not a pty slave), so
     * reading to EOF here is safe — unlike in the fake CLI binary above.
     */
    installFakeHook() {
      const hookPath = path.join(root, 'fake-session-end-hook.js');
      const capture = path.join(root, 'hook-capture.json');
      fs.writeFileSync(hookPath, [
        "'use strict';",
        'const fs = require("fs");',
        'let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (d) => { buf += d; });',
        'process.stdin.on("end", () => {',
        // The drain unlinks the envelope as soon as the hook closes, so a test
        // that reads transcript_path afterwards is racing a delete it will lose.
        // Snapshot the content here, while the hook is still the live consumer.
        '  let envelope = null;',
        '  try { envelope = fs.readFileSync(JSON.parse(buf).transcript_path, "utf8"); }',
        '  catch (_) { envelope = null; }',
        '  fs.writeFileSync(' + JSON.stringify(capture) + ', JSON.stringify({',
        '    stdin: buf,',
        '    envelope,',
        '    env: {',
        '      TERMDECK_SOURCE_AGENT: process.env.TERMDECK_SOURCE_AGENT || null,',
        '      TERMDECK_SESSION_TYPE: process.env.TERMDECK_SESSION_TYPE || null,',
        '      TERMDECK_HOOK_MIN_BYTES: process.env.TERMDECK_HOOK_MIN_BYTES || null,',
        '    },',
        '  }));',
        '});',
      ].join('\n'));
      this._hookCapture = capture;
      return hookPath;
    },

    /** The payload the fake hook received, or null if it was never invoked. */
    hookPayload() {
      try { return JSON.parse(fs.readFileSync(this._hookCapture, 'utf8')); }
      catch (_) { return null; }
    },

    /** Contents of the drain's own log, for asserting fail-soft skip reasons. */
    drainLog() {
      try { return fs.readFileSync(path.join(home, '.termdeck', 'logs', 'shim-drain.log'), 'utf8'); }
      catch (_) { return ''; }
    },

    /** Everything the fake binary recorded, as lines. */
    markerLines() {
      try { return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean); }
      catch (_) { return []; }
    },
    ranTags() {
      return this.markerLines()
        .filter((l) => l.startsWith('RAN\t'))
        .map((l) => l.split('\t')[1]);
    },

    transcriptDir() { return path.join(home, '.termdeck', 'standalone-transcripts'); },
    transcripts() {
      try { return fs.readdirSync(this.transcriptDir()).filter((f) => f.endsWith('.log')); }
      catch (_) { return []; }
    },

    /** Run the shim directly (no PTY). stdin/stdout are pipes → not a TTY. */
    run(args = [], env = {}) {
      return spawnSync(this.shimPath, args, {
        env: { ...baseEnv(), ...env },
        encoding: 'utf8',
        timeout: 30000,
      });
    },

    /**
     * Run the shim UNDER A PTY via script(1) — the only way to reach the capture
     * branch, which requires `-t 0` and `-t 1`. Returns the same shape as run()
     * plus `ptyLog` (what the outer script captured).
     */
    runPty(args = [], env = {}) {
      const outer = path.join(root, `outer-${Math.random().toString(36).slice(2)}.log`);
      const merged = { ...baseEnv(), ...env };
      const flavour = scriptFlavour();
      // `input: ''` is mandatory, not tidiness. script(1) pumps its own stdin
      // into the pty master; with the default piped-but-never-closed stdin it
      // waits for an EOF that never arrives and the case hangs forever (observed:
      // a 120s tool timeout before this was added). Handing it an immediately
      // closed stdin gives script its EOT while the CHILD still sees the pty
      // slave on fd 0 — so `-t 0` remains true and the capture branch is still
      // genuinely exercised.
      let r;
      if (flavour === 'util-linux') {
        const quoted = [this.shimPath, ...args]
          .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
        r = spawnSync('script', ['-q', '-e', '-c', quoted, outer], {
          env: merged, encoding: 'utf8', timeout: 30000, input: '',
        });
      } else {
        r = spawnSync('script', ['-q', outer, this.shimPath, ...args], {
          env: merged, encoding: 'utf8', timeout: 30000, input: '',
        });
      }
      let ptyLog = '';
      try { ptyLog = fs.readFileSync(outer, 'utf8'); } catch (_) { /* none */ }
      return { ...r, ptyLog };
    },

    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ } },
  };
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/**
 * Wait for a condition that a DETACHED process satisfies. The drain is spawned
 * with nohup + `&` so the shim can return the user's prompt instantly; a fence
 * that asserts immediately after the shim exits is racing it. Poll instead of
 * sleeping a magic number — fast when it works, and a real failure still fails.
 */
function waitFor(predicate, { timeoutMs = 15000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = predicate(); } catch (_) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) return false;
    execFileSync('sleep', [String(stepMs / 1000)]);
  }
}

module.exports = {
  makeWorld, fixture, waitFor, scriptFlavour,
  REPO_ROOT, SHIM_TEMPLATE, DRAIN_JS, FIXTURE_DIR,
};
