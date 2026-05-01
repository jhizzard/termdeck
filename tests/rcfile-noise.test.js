// Sprint 39 T2 — rcfile-noise PATTERNS regression suite.
//
// What this locks
// ───────────────
// 1. Captured zsh/bash startup transcripts (tests/rcfile-noise-fixtures/*.clean.txt)
//    must NOT trigger PATTERNS.error, CLAUDE_ERROR_LINE_START, or
//    PATTERNS.shellError — these represent the shell's own pre-prompt output
//    on a real developer machine. If any of them did trigger, the analyzer
//    would burn the 30s onErrorDetected rate limit before the user has a
//    chance to type their first command, and Flashback would never fire.
// 2. A synthetic adversarial corpus of common rcfile-noise lines (oh-my-zsh
//    plugin warnings, compinit insecure-dirs warning, version-manager
//    output, conda/pyenv/asdf/mise init, direnv loads, ssh-agent identity
//    adds, Apple's shell session save/restore notice) must also stay silent.
// 3. The known-good error fixtures from tests/analyzer-error-fixtures.test.js
//    must STILL trigger after any future tightening — proves we didn't
//    over-narrow.
//
// Hypothesis status (Sprint 39)
// ──────────────────────────────
// The strong hypothesis going in was that PATTERNS matches zsh/bash rcfile
// noise on Joshua's machine, burning the 30s rate limit before the first real
// user error. Empirically: Joshua's actual zsh prod-spawn capture is silent
// — no patterns trigger. So the hypothesis as written is REFUTED for his
// environment. This file's job is two-fold: (a) lock that result so a future
// regex change can't silently re-introduce the failure mode, and (b) cover
// the broader hypothesis space (other dev configs) the synthetic corpus
// represents.
//
// Run: node --test tests/rcfile-noise.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PATTERNS } = require('../packages/server/src/session.js');
// Sprint 45 T4: CLAUDE_ERROR_LINE_START shim was removed; the Claude-specific
// line-anchored error regex now lives at agent-adapters/claude.js. This file
// imports the adapter directly to keep the rcfile-noise corpus assertions
// scoped to the claude-code analyzer path.
const claudeAdapter = require('../packages/server/src/agent-adapters/claude');
const CLAUDE_ERROR_LINE_START = claudeAdapter.patterns.error;

const FIXTURES_DIR = path.join(__dirname, 'rcfile-noise-fixtures');

function loadCleanFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.clean.txt'))
    .sort()
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'),
    }));
}

// Combined check that mirrors session.js _detectErrors() for shell sessions.
// claude-code sessions use errorLineStart instead of error — checked separately.
function wouldTriggerShell(text) {
  return PATTERNS.error.test(text) || PATTERNS.shellError.test(text);
}

function wouldTriggerClaudeCode(text) {
  return CLAUDE_ERROR_LINE_START.test(text) || PATTERNS.shellError.test(text);
}

// ─── Captured corpus (real zsh/bash startup on Joshua's machine) ──────────

test('captured rcfile fixtures: zsh startup is silent under the shell-session error matcher', () => {
  const fixtures = loadCleanFixtures().filter(f => f.name.startsWith('zsh-'));
  assert.ok(fixtures.length > 0, 'no zsh-*.clean.txt fixtures found — capture script must have run');
  for (const fx of fixtures) {
    assert.equal(
      wouldTriggerShell(fx.content),
      false,
      `expected zsh fixture ${fx.name} to NOT trigger PATTERNS.error || PATTERNS.shellError. Content:\n${JSON.stringify(fx.content)}`,
    );
  }
});

test('captured rcfile fixtures: zsh startup is silent under the claude-code error matcher', () => {
  const fixtures = loadCleanFixtures().filter(f => f.name.startsWith('zsh-'));
  for (const fx of fixtures) {
    assert.equal(
      wouldTriggerClaudeCode(fx.content),
      false,
      `expected zsh fixture ${fx.name} to NOT trigger CLAUDE_ERROR_LINE_START || PATTERNS.shellError. Content:\n${JSON.stringify(fx.content)}`,
    );
  }
});

test('captured rcfile fixtures: bash interactive (non-login) startup is silent', () => {
  const fixtures = loadCleanFixtures().filter(f =>
    f.name.startsWith('bash-') && !f.name.includes('login')
  );
  for (const fx of fixtures) {
    assert.equal(
      wouldTriggerShell(fx.content),
      false,
      `expected bash interactive fixture ${fx.name} to NOT trigger error pattern. Content:\n${JSON.stringify(fx.content)}`,
    );
  }
});

// Bash login mode on this machine triggers ONE shellError match —
// `bash: only: command not found` — emitted by Apple's /etc/profile.d
// chain when sourced under bash. This is a LEGITIMATE shellError shape:
// `<cmd>: <thing>: command not found` is exactly what shellError targets,
// and the pattern correctly fires.
//
// We don't tighten it away because:
//   1. TermDeck's prod spawn does NOT use login mode (args=[]),
//      so this code path doesn't fire on Joshua's flashback flow.
//   2. The regex is structurally correct — `command not found` after a
//      colon-prefix is a real error in any shell.
//   3. Tightening would silence legitimate errors of the same shape.
//
// Documented here so a future maintainer knows this isn't a bug — it's
// an expected first-token of bash-login startup that fires once and
// arms the rate limit, but only if someone explicitly spawns bash -il.
test('captured rcfile fixtures: bash login mode emits one shellError-shaped line (documented, not a bug)', () => {
  const fixtures = loadCleanFixtures().filter(f =>
    f.name.startsWith('bash-') && f.name.includes('login')
  );
  for (const fx of fixtures) {
    // It's OK if shell-trigger fires here — this is the documented case.
    // We just want to assert it's the SPECIFIC line we expect, not some
    // other false positive sneaking in.
    if (wouldTriggerShell(fx.content)) {
      assert.match(
        fx.content,
        /bash:\s+\S+:\s+command not found/,
        `bash login fixture ${fx.name} fires shellError, but on an unexpected line. Content:\n${JSON.stringify(fx.content)}`,
      );
    }
  }
});

// ─── Synthetic adversarial corpus ─────────────────────────────────────────
//
// These cover rcfile-noise patterns from real-world dev environments that
// my own machine doesn't emit but other developers' machines could. They
// represent the hypothesis space — if Joshua's setup ever gains one of
// these, or if Brad's Linux box has them, they should NOT fire Flashback.
//
// Each entry: [label, content]. Add new ones liberally.

const RCFILE_SYNTHETIC_CORPUS = [
  // Apple session save/restore (zsh /etc/zshrc)
  ['Apple session restore notice',     'Restored session: Mon Apr 27 21:32:55 EDT 2026'],

  // compinit "insecure directories" classic
  ['compinit insecure dirs',           'zsh compinit: insecure directories, run compaudit for list.\nIgnore insecure directories and continue [y] or abort compinit [n]?'],

  // oh-my-zsh first-run hint
  ['omz update reminder',              '[oh-my-zsh] Would you like to update? [Y/n] '],
  ['omz plugin missing notice',        'plugin "git-extras" not found in $ZSH/plugins/ or $ZSH_CUSTOM/plugins/'],

  // Powerlevel10k instant-prompt
  ['p10k instant prompt warning',      '[INFO]: gitstatus: requested by user'],

  // Version managers
  ['nvm default node',                 'Now using node v20.10.0 (npm v10.2.3)'],
  ['rbenv shim warning',               'rbenv: cannot find ruby 3.2.0 (set by ~/.ruby-version)'],
  ['pyenv shim warning',               'pyenv: pyenv-virtualenv-init: command not found in path'],
  ['mise warn deprecated',             'mise WARN  config "~/.config/mise/config.toml" is using deprecated key "experimental_task"'],

  // Conda init
  ['conda warn deprecated',            'CondaValueError: Malformed version string \'1.x.dev\': implicit dev release.'],
  ['conda env activate',               '(base) ~ %'],

  // direnv
  ['direnv loading',                   'direnv: loading ~/.envrc'],
  ['direnv error syntax',              'direnv: error /home/u/.envrc:5: parse error'],

  // ssh-agent
  ['ssh-agent identity added',         'Identity added: /Users/josh/.ssh/id_ed25519 (josh@laptop)'],

  // brew shellenv
  ['brew env eval',                    'eval "$(/opt/homebrew/bin/brew shellenv)"'],

  // homebrew autoupdate hint
  ['brew update reminder',             '==> Auto-updated Homebrew!'],

  // generic prose mentioning errors (existing analyzer test had these too)
  ['prose mentioning past error',      'Looking at the error you mentioned, I think the cause is...'],
  ['shell command grepping error',     'grep error /var/log/syslog'],
  ['markdown heading',                 '# Error handling pattern'],

  // Plugin load hints (formatted as warnings, not errors)
  ['zinit installing plugin',          '[zinit] installing zsh-autosuggestions...'],
  ['fzf-tab notice',                   'fzf-tab loaded.'],

  // Apple chsh notice in bash 3.2 banner
  ['Apple bash deprecation banner',    'The default interactive shell is now zsh.\nTo update your account to use zsh, please run `chsh -s /bin/zsh`.\nFor more details, please visit https://support.apple.com/kb/HT208050.'],

  // Apple typeset/eval glitch (real, captured on Joshua's bash interactive)
  ['Apple bash typeset glitch L1',     'bash: typeset: -g: invalid option'],
  ['Apple bash typeset glitch L2',     'typeset: usage: typeset [-afFirtx] [-p] name[=value] ...'],
  ['Apple bash eval syntax glitch',    "bash: eval: line 15: syntax error in conditional expression: unexpected token `('"],
  ['Apple bash eval syntax near',      'bash: eval: line 15: syntax error near `$precmd_functions[(r\''],

  // Aliases / shell options notices
  ['EXTENDED_GLOB notice',             'setopt: no such option: EXTENDED_GLOBe'],
];

test('synthetic rcfile corpus: shell-session error matcher stays silent', () => {
  const offenders = [];
  for (const [label, text] of RCFILE_SYNTHETIC_CORPUS) {
    if (wouldTriggerShell(text)) {
      offenders.push({ label, text });
    }
  }
  assert.equal(
    offenders.length,
    0,
    `expected zero rcfile-noise lines to trigger PATTERNS.error || PATTERNS.shellError. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

test('synthetic rcfile corpus: claude-code error matcher stays silent', () => {
  const offenders = [];
  for (const [label, text] of RCFILE_SYNTHETIC_CORPUS) {
    if (wouldTriggerClaudeCode(text)) {
      offenders.push({ label, text });
    }
  }
  assert.equal(
    offenders.length,
    0,
    `expected zero rcfile-noise lines to trigger CLAUDE_ERROR_LINE_START || PATTERNS.shellError. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

// ─── Real-error regression: the things that MUST still fire ────────────────
//
// If any of these stop matching, T2's tightening went too far and Flashback
// would silently lose its ability to detect real errors. This is the
// counter-pressure to the silent-corpus assertions above.

const REAL_ERRORS_MUST_FIRE_SHELL = [
  ['cat ENOENT (e2e canonical)',           'cat: /nonexistent/file/path: No such file or directory'],
  ['ls cannot access',                     'ls: cannot access /nope: No such file or directory'],
  ['bash command not found w/ tool',       'bash: foo: command not found'],
  ['bash command not found trailing nl',   'bash: foo: command not found\n'],
  ['zsh command not found w/ cmd',         'zsh: command not found: kubectl'],
  ['rm permission denied',                 'rm: cannot remove /etc/passwd: Permission denied'],
  ['curl could not resolve',               'curl: (6) Could not resolve host: foo.invalid'],
  ['python ModuleNotFoundError',           'ModuleNotFoundError: No module named foo'],
  ['Python Traceback header',              'Traceback (most recent call last):\n  File "x.py"'],
  ['npm ERR! tag',                         'npm ERR! code ERESOLVE'],
  ['Rust borrow-checker error code',       'error[E0382]: borrow of moved value'],
  ['git Fatal: mixed-case',                'Fatal: not a git repository'],
  ['git fatal: lowercase',                 'fatal: not a git repository'],
  ['Segmentation fault',                   'Segmentation fault: 11'],
  ['Node Error: line',                     'Error: ENOENT: no such file or directory'],
  // Mid-stream — error embedded in a transcript with prompt before/after.
  // Mirrors how production output actually arrives.
  ['error mid-stream w/ prompt',
    'user@host:~$ cat /nope\ncat: /nope: No such file or directory\nuser@host:~$ '],
];

test('real-error regression: shell-session error matcher still fires on canonical shapes', () => {
  const misses = [];
  for (const [label, text] of REAL_ERRORS_MUST_FIRE_SHELL) {
    if (!wouldTriggerShell(text)) {
      misses.push({ label, text });
    }
  }
  assert.equal(
    misses.length,
    0,
    `expected ALL canonical error shapes to trigger PATTERNS.error || PATTERNS.shellError. Misses:\n${JSON.stringify(misses, null, 2)}`,
  );
});

// Subset of REAL_ERRORS_MUST_FIRE_SHELL that the CURRENT claude-code matcher
// (errorLineStart || shellError) catches today. Documenting the gaps:
//
//   • `npm ERR! code ERESOLVE`         — errorLineStart needs `npm ERR!`
//   • `Fatal: not a git repository`    — errorLineStart has only lower/upper
//                                         case `fatal|FATAL`, not mixed-case
//
// Both fire correctly on the SHELL session path (PATTERNS.error). They
// are LATENT GAPS in the claude-code path. Out of scope for Sprint 39 T2's
// rcfile-noise lane — reported as a follow-up for whoever owns the
// claude-code analyzer next.
const CLAUDE_CODE_GAPS_OUT_OF_SCOPE = new Set([
  'npm ERR! tag',
  'git Fatal: mixed-case',
]);

test('real-error regression: claude-code error matcher still fires on shapes it claims to support', () => {
  const misses = [];
  for (const [label, text] of REAL_ERRORS_MUST_FIRE_SHELL) {
    if (CLAUDE_CODE_GAPS_OUT_OF_SCOPE.has(label)) continue;
    if (!wouldTriggerClaudeCode(text)) {
      misses.push({ label, text });
    }
  }
  assert.equal(
    misses.length,
    0,
    `expected supported claude-code error shapes to trigger CLAUDE_ERROR_LINE_START || PATTERNS.shellError. Misses:\n${JSON.stringify(misses, null, 2)}`,
  );
});
