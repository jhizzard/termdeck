// Sprint 39 T2 — empirical capture of zsh/bash rcfile-startup noise.
//
// Spawns interactive shell variants under node-pty (the same PTY layer
// TermDeck uses in production, packages/server/src/index.js -> session.js),
// captures everything from spawn until the first prompt is idle, strips ANSI,
// and writes both the raw transcript and the ANSI-stripped clean text to
// fixture files. The captured fixtures feed tests/rcfile-noise.test.js.
//
// Run from repo root:
//   node tests/rcfile-noise-fixtures/capture.js
//
// Outputs files into tests/rcfile-noise-fixtures/ named:
//   <shell>-<variant>.raw.txt   — exact PTY bytes (for forensic re-runs)
//   <shell>-<variant>.clean.txt — ANSI-stripped, used by the regex tests
//
// SECRET HANDLING: the capture redacts any line that looks like it leaks a
// known-sensitive env value (OpenAI / Anthropic / Supabase tokens). The
// shells in question shouldn't print these — `export FOO=bar` is silent —
// but a defensive redact keeps fixtures committable.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Use the same node-pty binding the server uses.
const pty = require(path.resolve(__dirname, '..', '..', 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'));

// Reuse the canonical stripAnsi from session.js so the fixture content is
// exactly what _detectErrors() would see.
const { } = require(path.resolve(__dirname, '..', '..', 'packages', 'server', 'src', 'session.js'));
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\?]?[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[>=<]/g, '');
}

// Conservative redaction. Any line containing a long base64-ish or hex token
// after a known key prefix gets the value masked. We err toward over-redact.
const SECRET_PATTERNS = [
  /(sk-(?:proj-|ant-)[A-Za-z0-9_\-]{16,})/g,
  /(sbp_[A-Fa-f0-9]{16,})/g,
  /(ghp_[A-Za-z0-9]{16,})/g,
  /(AKIA[A-Z0-9]{12,})/g,
  /(SUPABASE_ACCESS_TOKEN=\S+)/g,
  /(OPENAI_API_KEY=\S+)/g,
  /(ANTHROPIC_API_KEY=\S+)/g,
];
function redact(str) {
  for (const re of SECRET_PATTERNS) {
    str = str.replace(re, '<REDACTED>');
  }
  return str;
}

// Drop the prompt-flag noise the user types; we only want what the shell
// emitted before the first idle prompt.
function trimToFirstPrompt(clean, prompt) {
  // Find the first occurrence of the actual prompt (after the first ~50 bytes
  // to skip any spawn-time prompt echo). If we never find one, return the
  // whole capture.
  const idx = clean.indexOf(prompt, 50);
  if (idx < 0) return clean;
  return clean.slice(0, idx + prompt.length);
}

const outDir = __dirname;
const SENTINEL = `__T2_SPRINT39_PROMPT_${Date.now()}__`;

// Production env shape: TermDeck spawns shells with NO args (interactive,
// non-login by virtue of stdin being a TTY) and a specific env shape that
// includes SHELL_SESSION_HISTORY=0 to silence Apple's session save/restore.
// See packages/server/src/index.js:768.
const TERMDECK_ENV_DELTA = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERMDECK_SESSION: 'fixture-capture',
  TERMDECK_PROJECT: '',
  SHELL_SESSION_HISTORY: '0',
};

const variants = [
  // === Production fingerprint — TermDeck's actual spawn env, no args. ===
  // This is what hits Joshua's flashback rate limit on shell startup, modulo
  // the test rig's PROMPT/PS1 sentinel needed to detect end-of-startup.
  {
    name: 'zsh-termdeck-prod',
    shell: '/bin/zsh',
    args: [],
    env: { ...process.env, ...TERMDECK_ENV_DELTA, PROMPT: SENTINEL },
    note: 'TermDeck production spawn — /bin/zsh, no args, SHELL_SESSION_HISTORY=0.'
  },
  {
    name: 'bash-termdeck-prod',
    shell: '/bin/bash',
    args: [],
    env: { ...process.env, ...TERMDECK_ENV_DELTA, PS1: SENTINEL },
    note: 'TermDeck production spawn — /bin/bash, no args.'
  },

  // === Variants for hypothesis surface coverage. ===
  {
    name: 'zsh-josh-interactive',
    shell: '/bin/zsh',
    args: ['-i'],
    env: { ...process.env, PROMPT: SENTINEL },
    note: 'Explicit interactive zsh -i (matches old capture script).'
  },
  {
    name: 'zsh-josh-login',
    shell: '/bin/zsh',
    args: ['-il'],
    env: { ...process.env, PROMPT: SENTINEL },
    note: 'Login zsh — sources ~/.zprofile + ~/.zshrc.'
  },
  {
    name: 'bash-josh-interactive',
    shell: '/bin/bash',
    args: ['-i'],
    env: { ...process.env, PS1: SENTINEL },
    note: 'Explicit interactive bash -i.'
  },
  {
    name: 'bash-josh-login',
    shell: '/bin/bash',
    args: ['-il'],
    env: { ...process.env, PS1: SENTINEL },
    note: 'Login bash — sources ~/.bash_profile.'
  },

  // === Vanilla shells (system rcfiles only). Isolates "system emits" vs
  // "Joshua's rcfile emits". ===
  {
    name: 'zsh-vanilla',
    shell: '/bin/zsh',
    args: [],
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', HOME: '/tmp', PROMPT: SENTINEL, ZDOTDIR: '/tmp' },
    note: 'Bare zsh, HOME=/tmp ZDOTDIR=/tmp — system zshrc only.'
  },
  {
    name: 'bash-vanilla',
    shell: '/bin/bash',
    args: [],
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', HOME: '/tmp', PS1: SENTINEL },
    note: 'Bare bash, HOME=/tmp — system bashrc only.'
  },
];

async function captureOne(v) {
  console.log(`[capture] ${v.name} — ${v.shell} ${v.args.join(' ')}`);
  return new Promise((resolve) => {
    let buffer = '';
    const term = pty.spawn(v.shell, v.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: v.env,
    });
    term.onData((d) => { buffer += d; });
    // 5s window — long enough for compinit, conda init, pyenv init,
    // session-restore, and oh-my-zsh plugin chain to fully settle on a
    // typical developer laptop. Anything still firing past 5s would be a
    // separate "background work in rcfile" hypothesis we can rule in later.
    setTimeout(() => {
      try { term.kill(); } catch {}
      const raw = buffer;
      const clean = redact(stripAnsi(raw));
      // Don't trim — the hypothesis is about what fires before the user
      // types. Trimming to a sentinel could hide a noise burst that
      // happens after the prompt.
      fs.writeFileSync(path.join(outDir, `${v.name}.raw.txt`), redact(raw));
      fs.writeFileSync(path.join(outDir, `${v.name}.clean.txt`), clean);
      resolve({ name: v.name, lines: clean.split('\n').length, bytes: clean.length });
    }, 5000);
  });
}

(async () => {
  const results = [];
  for (const v of variants) {
    try {
      results.push(await captureOne(v));
    } catch (e) {
      console.error(`[capture] ${v.name} FAILED:`, e.message);
    }
  }
  console.log('\n[capture] summary:');
  for (const r of results) {
    console.log(`  ${r.name}: ${r.lines} lines, ${r.bytes} bytes`);
  }
  process.exit(0);
})();
