// Fixture tests for PATTERNS.error in packages/server/src/session.js.
//
// Sprint 26 T4 narrowed PATTERNS.error from a substring match against "error"
// to a line-anchored alternation that requires real error-line shapes
// (Error:, error:, Traceback, npm ERR!, error[Ennn]:, Uncaught Exception,
// Fatal:). These fixtures lock in both directions: prose mentioning the word
// "error" must NOT trigger, and canonical error-line shapes MUST trigger.
//
// Run: node --test tests/analyzer-error-fixtures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { PATTERNS } = require('../packages/server/src/session.js');

const SHOULD_NOT_TRIGGER = [
  ['Claude prose mentioning a past error', 'Looking at the error you mentioned, I think the cause is...'],
  ['markdown heading with capital Error',  '# Error handling pattern'],
  ['shell command grepping for "error"',   'grep error /var/log/syslog'],
  ['Haiku synthesis referencing prior error', 'The error message in the previous session was unrelated.'],
];

const SHOULD_TRIGGER = [
  ['Node ENOENT Error: line',              'Error: ENOENT: no such file or directory'],
  ['npm ERR! tag',                          'npm ERR! code ERESOLVE'],
  ['Python Traceback header',               'Traceback (most recent call last):\n  File "x.py"'],
  ['Rust borrow-checker error code',        'error[E0382]: borrow of moved value'],
  ['git Fatal: line',                       'Fatal: not a git repository'],
];

test('PATTERNS.error does not trigger on non-error prose mentioning "error"', () => {
  for (const [name, fixture] of SHOULD_NOT_TRIGGER) {
    assert.equal(
      PATTERNS.error.test(fixture),
      false,
      `expected no match for ${name}: ${JSON.stringify(fixture)}`,
    );
  }
});

test('PATTERNS.error triggers on real error-line shapes', () => {
  for (const [name, fixture] of SHOULD_TRIGGER) {
    assert.equal(
      PATTERNS.error.test(fixture),
      true,
      `expected match for ${name}: ${JSON.stringify(fixture)}`,
    );
  }
});

// Sprint 33: PATTERNS.shellError catches the common Unix shell error shapes
// that PATTERNS.error misses (the `<cmd>: <path>: <phrase>` form). These
// fixtures lock the pattern against both the real shell-error shapes AND
// adversarial prose mentioning the same keywords without the colon-prefix
// structure.
const SHELL_ERROR_SHOULD_TRIGGER = [
  ['cat ENOENT (e2e canonical)', 'cat: /nonexistent/file/path: No such file or directory'],
  ['ls cannot access',           'ls: cannot access /nope: No such file or directory'],
  ['bash command not found',     'bash: foo: command not found'],
  ['zsh command not found',      'zsh: command not found: foo'],
  ['rm permission denied',       'rm: cannot remove /etc/passwd: Permission denied'],
  ['curl could not resolve',     'curl: (6) Could not resolve host: foo.invalid'],
  ['python ModuleNotFoundError', 'ModuleNotFoundError: No module named foo'],
  ['segfault',                   'Segmentation fault: 11'],
  ['git fatal (lowercase)',      'fatal: not a git repository'],
  ['error mid-stream w/ prompt', 'user@host:~$ cat /nope\ncat: /nope: No such file or directory\nuser@host:~$ '],
];

const SHELL_ERROR_SHOULD_NOT_TRIGGER = [
  ['prose mentioning ENOENT',     'I checked, but no such file or directory exists at that path.'],
  ['prose mentioning permission', 'The error happens because permission denied beforehand.'],
  ['prose mentioning segfault',   'When the binary segfaults, segmentation fault is reported.'],
  ['prose ModuleNotFoundError',   'A common Python issue: ModuleNotFoundError happens when imports fail.'],
  ['prose command not found',     'This command not found case is rare.'],
  ['cat help text',               '       cat: concatenate files and print on standard output'],
  ['ls listing',                  'README.md  package.json  src/'],
];

test('PATTERNS.shellError triggers on common Unix shell error shapes', () => {
  for (const [name, fixture] of SHELL_ERROR_SHOULD_TRIGGER) {
    assert.equal(
      PATTERNS.shellError.test(fixture),
      true,
      `expected shellError match for ${name}: ${JSON.stringify(fixture)}`,
    );
  }
});

test('PATTERNS.shellError does not trigger on prose mentioning error keywords', () => {
  for (const [name, fixture] of SHELL_ERROR_SHOULD_NOT_TRIGGER) {
    assert.equal(
      PATTERNS.shellError.test(fixture),
      false,
      `expected no shellError match for ${name}: ${JSON.stringify(fixture)}`,
    );
  }
});
