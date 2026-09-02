'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Shim winsize / SIGWINCH forwarder
//
// macOS/BSD `script` openpty()s a slave at 80×24 and does not copy the parent
// TTY's TIOCGWINSZ or forward SIGWINCH. A fullscreen TUI (Grok Build, Codex,
// Antigravity) then paints an 80×24 overlay inside a much larger Terminal.app
// window — empty field, overlapping chrome. Invariant 1 (transparent TTY
// semantics) requires the inner CLI to see the same winsize as the user's
// terminal.
//
// The helper is fail-soft and silent; this fence asserts the capture path
// actually copies a non-default size onto script's slave.
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { makeWorld } = require('./_shim-harness');

const ROWS = 40;
const COLS = 120;
const WANT = `${ROWS} ${COLS}`;

function pythonPtyOk() {
  const r = spawnSync('python3', ['-c', 'import pty, fcntl, termios, struct, select; print(1)'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return r.status === 0;
}

test('capture-path slave PTY inherits the parent winsize (not script\'s 80x24 default)', (t) => {
  if (!pythonPtyOk()) {
    t.skip('python3 pty module required');
    return;
  }

  const w = makeWorld({ agent: 'grok', realStdout: '' });
  t.after(() => w.cleanup());

  // The fake CLI must wait: the helper discovers the slave after `script` forks.
  fs.writeFileSync(path.join(w.binDir, w.agent), [
    '#!/bin/bash',
    'for i in $(seq 1 50); do',
    '  sz=$(stty size 2>/dev/null || true)',
    '  printf \'SIZE:%s\\n\' "$sz"',
    `  [ "$sz" = "${WANT}" ] && exit 0`,
    '  sleep 0.15',
    'done',
    'exit 7',
    '',
  ].join('\n'), { mode: 0o755 });

  const envFile = path.join(w.root, 'env.json');
  const env = w.baseEnv();
  env.TERM = 'xterm-256color';
  // Curated env — inheriting TERMDECK_SESSION from a TermDeck panel would take
  // the transparent-exec branch and pass vacuously (outer PTY already sized).
  delete env.TERMDECK_SESSION;
  delete env.TERMDECK_PANEL_SESSION;
  const py3 = spawnSync('command', ['-v', 'python3'], { encoding: 'utf8', shell: true });
  const py3dir = path.dirname((py3.stdout || '').trim());
  if (py3dir && py3dir !== '.') env.PATH = `${env.PATH}:${py3dir}:/usr/local/bin:/opt/homebrew/bin`;
  fs.writeFileSync(envFile, JSON.stringify(env));

  const py = [
    'import errno, fcntl, json, os, select, signal, struct, sys, termios, time',
    'rows, cols = int(sys.argv[1]), int(sys.argv[2])',
    'shim, envfile = sys.argv[3], sys.argv[4]',
    'env = json.load(open(envfile))',
    'pid, master = __import__("pty").fork()',
    'if pid == 0:',
    '    os.execve(shim, [shim], env)',
    'fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))',
    'try:',
    '    os.kill(pid, signal.SIGWINCH)',
    'except OSError:',
    '    pass',
    'deadline = time.time() + 20',
    'out = b""',
    'status = None',
    'while time.time() < deadline:',
    '    r, _, _ = select.select([master], [], [], 0.2)',
    '    if r:',
    '        try:',
    '            chunk = os.read(master, 8192)',
    '        except OSError as e:',
    '            if e.errno == errno.EIO:',
    '                try:',
    '                    _wp, status = os.waitpid(pid, 0)',
    '                except OSError:',
    '                    status = 0',
    '                break',
    '            raise',
    '        if not chunk:',
    '            try:',
    '                _wp, status = os.waitpid(pid, 0)',
    '            except OSError:',
    '                status = 0',
    '            break',
    '        out += chunk',
    '    wpid, st = os.waitpid(pid, os.WNOHANG)',
    '    if wpid == pid:',
    '        status = st',
    '        for _ in range(5):',
    '            try:',
    '                chunk = os.read(master, 8192)',
    '            except OSError:',
    '                chunk = b""',
    '            if not chunk:',
    '                break',
    '            out += chunk',
    '        break',
    'else:',
    '    try: os.kill(pid, signal.SIGTERM)',
    '    except OSError: pass',
    '    sys.stderr.write("timeout waiting for shim\\n")',
    '    sys.exit(99)',
    'sys.stdout.buffer.write(out)',
    'if status is None:',
    '    sys.exit(98)',
    'sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)',
  ].join('\n');

  const r = spawnSync('python3', ['-c', py, String(ROWS), String(COLS), w.shimPath, envFile], {
    encoding: 'utf8',
    timeout: 25000,
    cwd: w.root,
  });

  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(
    r.status, 0,
    `shim/CLI should exit 0 once the slave is ${WANT}; got ${r.status}\n${combined}`,
  );
  assert.match(
    combined.replace(/\r/g, ''),
    new RegExp(`SIZE:${WANT}`),
    `inner CLI must see ${WANT}, not script's 80x24 default. output=${JSON.stringify(combined)}`,
  );
  assert.ok(
    w.transcripts().length >= 1,
    'must take the capture/script path — an empty transcript list means transparent exec and a vacuous pass',
  );
});
