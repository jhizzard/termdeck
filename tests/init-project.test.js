// Tests for `termdeck init --project` — Sprint 37 T2.
//
// Covers:
//   - Happy path: scaffolds the expected file tree and renders {{placeholders}}.
//   - Dry-run: writes nothing, lists what would be written.
//   - Refuses on existing non-empty target without --force.
//   - --force: overwrites in non-empty target.
//   - Name validation: rejects slashes, "..", uppercase, leading hyphen.
//
// Each case runs in its own tmpdir so failed cases don't leak state.
// stdout/stderr are captured for the duration of each call so the test
// runner output stays clean and so we can assert on the dry-run listing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const initProjectMod = require(path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'init-project.js'));
const { initProject, _validateName } = initProjectMod;

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'init-project-test-'));
}

async function captureRun(fn) {
  const captured = { stdout: [], stderr: [] };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    captured.stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  process.stderr.write = (chunk) => {
    captured.stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { result, stdout: captured.stdout.join(''), stderr: captured.stderr.join('') };
}

const EXPECTED_FILES = [
  'CLAUDE.md',
  'CONTRADICTIONS.md',
  'project_facts.md',
  'README.md',
  '.gitignore',
  path.join('docs', 'orchestration', 'README.md'),
  path.join('docs', 'orchestration', 'RESTART-PROMPT.md.tmpl'),
  path.join('.claude', 'settings.json'),
];

test('happy path — creates the expected file tree', async () => {
  const tmp = freshTmpDir();
  const { result } = await captureRun(() => initProject({ name: 'hello', cwd: tmp }));

  assert.equal(result.exitCode, 0);
  const projectDir = path.join(tmp, 'hello');
  for (const f of EXPECTED_FILES) {
    assert.ok(fs.existsSync(path.join(projectDir, f)), `expected ${f} to exist`);
  }
});

test('renders {{project_name}} placeholder in CLAUDE.md', async () => {
  const tmp = freshTmpDir();
  await captureRun(() => initProject({ name: 'hello-world', cwd: tmp }));

  const claudeMd = fs.readFileSync(path.join(tmp, 'hello-world', 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /^# hello-world — agent read-order/m);
  assert.doesNotMatch(claudeMd, /\{\{project_name\}\}/);
});

test('renders {{project_path}} as absolute path in project_facts.md', async () => {
  const tmp = freshTmpDir();
  await captureRun(() => initProject({ name: 'mything', cwd: tmp }));

  const facts = fs.readFileSync(path.join(tmp, 'mything', 'project_facts.md'), 'utf8');
  const expectedPath = path.join(tmp, 'mything');
  assert.ok(facts.includes(expectedPath), `expected facts to include ${expectedPath}`);
  assert.doesNotMatch(facts, /\{\{project_path\}\}/);
});

test('renders .claude/settings.json as valid JSON', async () => {
  const tmp = freshTmpDir();
  await captureRun(() => initProject({ name: 'jsonproj', cwd: tmp }));

  const raw = fs.readFileSync(path.join(tmp, 'jsonproj', '.claude', 'settings.json'), 'utf8');
  const parsed = JSON.parse(raw); // throws on malformed
  assert.ok(parsed.permissions, 'expected permissions key');
  assert.ok(Array.isArray(parsed.permissions.allow), 'expected permissions.allow array');
  assert.ok(Array.isArray(parsed.permissions.deny), 'expected permissions.deny array');
});

test('dry-run writes nothing and lists each template', async () => {
  const tmp = freshTmpDir();
  const { result, stdout } = await captureRun(() => initProject({ name: 'preview', dryRun: true, cwd: tmp }));

  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'preview')), false, 'dry-run must not create the target dir');
  assert.match(stdout, /\[dry-run\]/);
  // Every expected destination shows up in the dry-run listing.
  for (const f of EXPECTED_FILES) {
    assert.ok(stdout.includes(f), `expected dry-run output to mention ${f}`);
  }
});

test('refuses on existing non-empty target without --force', async () => {
  const tmp = freshTmpDir();
  const target = path.join(tmp, 'occupied');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'pre-existing.txt'), 'do not overwrite me');

  const { result, stderr } = await captureRun(() => initProject({ name: 'occupied', cwd: tmp }));

  assert.equal(result.exitCode, 1);
  assert.match(stderr, /exists and is not empty/);
  assert.equal(fs.existsSync(path.join(target, 'pre-existing.txt')), true, 'pre-existing file must be untouched');
  assert.equal(fs.existsSync(path.join(target, 'CLAUDE.md')), false, 'CLAUDE.md must not be written when refused');
});

test('--force overwrites in a non-empty target', async () => {
  const tmp = freshTmpDir();
  const target = path.join(tmp, 'forceme');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'sentinel.txt'), 'survives');

  const { result } = await captureRun(() => initProject({ name: 'forceme', force: true, cwd: tmp }));

  assert.equal(result.exitCode, 0);
  assert.ok(fs.existsSync(path.join(target, 'CLAUDE.md')), 'CLAUDE.md should be written under --force');
  // We don't promise to clear the dir — only to write our files. Sentinel
  // staying alive is fine; we're verifying the refusal gate doesn't fire.
  assert.equal(fs.existsSync(path.join(target, 'sentinel.txt')), true);
});

test('refuses when target exists as a non-empty dir even with files in subdirs', async () => {
  const tmp = freshTmpDir();
  const target = path.join(tmp, 'nested');
  fs.mkdirSync(path.join(target, 'inside'), { recursive: true });

  const { result } = await captureRun(() => initProject({ name: 'nested', cwd: tmp }));
  assert.equal(result.exitCode, 1);
});

test('accepts existing-but-empty target dir without --force', async () => {
  const tmp = freshTmpDir();
  const target = path.join(tmp, 'empty');
  fs.mkdirSync(target);

  const { result } = await captureRun(() => initProject({ name: 'empty', cwd: tmp }));
  assert.equal(result.exitCode, 0);
  assert.ok(fs.existsSync(path.join(target, 'CLAUDE.md')));
});

test('validateName rejects slashes, dotdot, uppercase, leading hyphen', () => {
  assert.equal(_validateName('valid-name'), null);
  assert.equal(_validateName('name123'), null);
  assert.equal(_validateName('a'), null);

  assert.match(_validateName('has/slash'), /slashes/);
  assert.match(_validateName('..'), /slashes|".."/);
  assert.match(_validateName('UPPER'), /lowercase/);
  assert.match(_validateName('-leading'), /lowercase/);
  assert.match(_validateName('trailing-'), /lowercase/);
  assert.match(_validateName(''), /required/);
});

test('initProject returns nonzero on bad name', async () => {
  const tmp = freshTmpDir();
  const { result } = await captureRun(() => initProject({ name: 'BadName', cwd: tmp }));
  assert.equal(result.exitCode, 1);
});
