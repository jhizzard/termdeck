// Sprint 81 T3 — PreToolUse deny gate behavior fences.
//
// The two bundled gates ship at packages/stack-installer/assets/hooks/
// gate-{publish-before-push,migration-without-rls}.js and get vendored to
// ~/.claude/hooks/ + wired under settings.hooks.PreToolUse (matcher 'Bash').
//
// These fences prove the load-bearing invariants:
//   • FAIL-OPEN by default: not-Bash / not-the-git-op / rule-not-promoted /
//     any uncertainty → ALLOW (empty stdout, exit 0). A too-aggressive gate is
//     a P0, so every "allow" branch is exercised.
//   • REGISTRY-DRIVEN: a real deny only fires when the doctrine rule is
//     status:active + surface:preToolUse-deny + max_severity:block. Advisory /
//     absent / unreadable registry → inert.
//   • PreToolUse CONTRACT: a deny is exit 0 + stdout
//     {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',
//     permissionDecisionReason:...}}. Never exit 2.
//
// Runs the gate as a real subprocess against real temp git repos (+ a fake npm
// on PATH for the publish gate) so the git/npm plumbing is exercised, not mocked.
//
// Run: node --test packages/stack-installer/tests/pretooluse-gate-behavior.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'assets', 'hooks');
const PUBLISH_GATE = path.join(HOOKS_DIR, 'gate-publish-before-push.js');
const MIGRATION_GATE = path.join(HOOKS_DIR, 'gate-migration-without-rls.js');

// ── temp-dir + git helpers ───────────────────────────────────────────────────
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmTmp(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ } }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function initRepo(dir, { branch = 'main' } = {}) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  git(dir, ['branch', '-M', branch]);
}

function stageFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(dir, ['add', '--', rel]);
}

// A registry file with one rule entry at the requested enforcement level.
function writeRegistry(dir, { id, promoted }) {
  const enforcement = promoted
    ? { surface: 'preToolUse-deny', max_severity: 'block', ref: 'CLAUDE.md' }
    : { surface: 'inject-advisory', max_severity: 'warn', ref: 'CLAUDE.md' };
  const entry = {
    id, title: id, severity: 'high', scope: 'universal', audience: 'all',
    check: { type: 'manual' }, enforcement, status: 'active', version: 1,
  };
  const p = path.join(dir, 'registry.jsonl');
  fs.writeFileSync(p, JSON.stringify(entry) + '\n');
  return p;
}

// A fake `npm` on PATH so the publish gate's `npm view <name> version` is
// deterministic (no network). `version` is echoed; `unpublished:true` exits 1.
function fakeNpmDir(dir, { version = '1.0.0', unpublished = false } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = unpublished
    ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\nif [ "$1" = "view" ] && [ "$3" = "version" ]; then echo "${version}"; exit 0; fi\nexit 1\n`;
  const p = path.join(bin, 'npm');
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
  return bin;
}

// Spawn a gate with a PreToolUse stdin payload; return the decision.
function runGate(gateFile, payload, { cwd, env } = {}) {
  const r = spawnSync('node', [gateFile], {
    input: JSON.stringify(payload),
    cwd: cwd || process.cwd(),
    env: Object.assign({}, process.env, env || {}),
    encoding: 'utf8',
    timeout: 20000,
  });
  const stdout = (r.stdout || '').trim();
  let decision = 'allow';
  let reason = null;
  if (stdout) {
    try {
      const j = JSON.parse(stdout);
      const hso = j.hookSpecificOutput || {};
      decision = hso.permissionDecision || 'unparseable';
      reason = hso.permissionDecisionReason || null;
      // Contract shape assertions when a decision was emitted.
      assert.equal(hso.hookEventName, 'PreToolUse', 'deny carries hookEventName=PreToolUse');
    } catch (_) { decision = 'unparseable'; }
  }
  return { status: r.status, stdout, decision, reason };
}

function bashPayload(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PreToolUse', session_id: 's1' };
}

// ── shared: never exit 2; deny is exit 0 ─────────────────────────────────────
function assertNeverExit2(res) {
  assert.notEqual(res.status, 2, 'gate must NEVER exit 2 (that blocks via stderr — not fail-soft)');
  assert.equal(res.status, 0, 'gate always exits 0');
}

// ════════════════════════════════════════════════════════════════════════════
// gate-migration-without-rls
// ════════════════════════════════════════════════════════════════════════════

test('migration gate: pure helpers', () => {
  const g = require(MIGRATION_GATE);
  assert.equal(g.isGitCommit('git commit -m x'), true);
  assert.equal(g.isGitCommit('foo && git commit'), true);
  assert.equal(g.isGitCommit('git -C /repo commit -m x'), true, 'global option before subcommand');
  assert.equal(g.isGitCommit('git commit --dry-run'), false, 'dry-run creates no commit');
  assert.equal(g.isGitCommit('git commit --help'), false);
  assert.equal(g.isGitCommit('git log'), false);
  assert.equal(g.isGitCommit('git log --grep commit'), false, 'commit must be the subcommand, not a grep arg');
  assert.equal(g.isGitCommit('git push'), false);

  // public table without RLS → violation; with RLS → clean
  const noRls = 'create table public.foo (id int);';
  const withRls = 'create table public.foo (id int);\nalter table public.foo enable row level security;';
  assert.deepEqual(g.violationsForFile(noRls, noRls), ['foo']);
  assert.deepEqual(g.violationsForFile(withRls, withRls), []);

  // non-public schema is ignored; temp/temporary ignored (never matched)
  assert.deepEqual(g.publicTablesCreated('create table cron.foo (x int);'), []);
  assert.deepEqual(g.publicTablesCreated('create temp table t (x int);'), []);
  assert.deepEqual(g.publicTablesCreated('create table if not exists public."Bar" (x int);'), ['bar']);
  assert.deepEqual(g.publicTablesCreated('create table baz (x int);'), ['baz'], 'unqualified defaults to public');

  // commented-out DDL is stripped (no false trigger)
  assert.deepEqual(g.violationsForFile('-- create table public.ghost (x int);', '-- create table public.ghost (x int);'), []);
  // RLS enable qualified/unqualified both satisfy
  assert.equal(g.fileEnablesRls('alter table public.foo enable row level security', 'foo'), true);
  assert.equal(g.fileEnablesRls('alter table foo enable row level security', 'foo'), true);
});

test('migration gate: DENY when promoted + staged migration lacks RLS', () => {
  const repo = mkTmp('td-mig-deny-');
  const reg = mkTmp('td-reg-');
  const home = mkTmp('td-home-');
  try {
    initRepo(repo);
    stageFile(repo, 'migrations/030_x.sql', 'create table public.widgets (id int);\n');
    const regPath = writeRegistry(reg, { id: 'rls-five-gates', promoted: true });
    const res = runGate(MIGRATION_GATE, bashPayload('git commit -m "add widgets"', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home },
    });
    assertNeverExit2(res);
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /migration-without-RLS/);
    assert.match(res.reason, /public\.widgets/);
    assert.match(res.reason, /rls-five-gates/);
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('migration gate: ALLOW when staged migration HAS RLS in the same file', () => {
  const repo = mkTmp('td-mig-ok-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo);
    stageFile(repo, 'migrations/031_x.sql',
      'create table public.widgets (id int);\nalter table public.widgets enable row level security;\n');
    const regPath = writeRegistry(reg, { id: 'rls-five-gates', promoted: true });
    const res = runGate(MIGRATION_GATE, bashPayload('git commit -m ok', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home },
    });
    assertNeverExit2(res);
    assert.equal(res.decision, 'allow');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('migration gate: INERT when rule is only advisory (not promoted)', () => {
  const repo = mkTmp('td-mig-inert-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo);
    stageFile(repo, 'migrations/032_x.sql', 'create table public.widgets (id int);\n'); // lacks RLS
    const regPath = writeRegistry(reg, { id: 'rls-five-gates', promoted: false }); // advisory
    const res = runGate(MIGRATION_GATE, bashPayload('git commit -m x', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home },
    });
    assertNeverExit2(res);
    assert.equal(res.decision, 'allow', 'advisory rule → gate is a no-op');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('migration gate: ALLOW when no staged migration files', () => {
  const repo = mkTmp('td-mig-none-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo);
    stageFile(repo, 'src/app.js', 'console.log(1);\n'); // not a migration
    const regPath = writeRegistry(reg, { id: 'rls-five-gates', promoted: true });
    const res = runGate(MIGRATION_GATE, bashPayload('git commit -m x', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home },
    });
    assert.equal(res.decision, 'allow');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('migration gate: ALLOW when not a git commit / not Bash', () => {
  const repo = mkTmp('td-mig-cmd-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo);
    stageFile(repo, 'migrations/033_x.sql', 'create table public.widgets (id int);\n');
    const regPath = writeRegistry(reg, { id: 'rls-five-gates', promoted: true });
    const env = { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home };
    assert.equal(runGate(MIGRATION_GATE, bashPayload('git status', repo), { cwd: repo, env }).decision, 'allow');
    assert.equal(runGate(MIGRATION_GATE, { tool_name: 'Edit', tool_input: {}, cwd: repo }, { cwd: repo, env }).decision, 'allow');
    assert.equal(runGate(MIGRATION_GATE, 'not-json', { cwd: repo, env }).decision, 'allow');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('migration gate: ALLOW (fail-open) when registry is unreadable', () => {
  const repo = mkTmp('td-mig-noreg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo);
    stageFile(repo, 'migrations/034_x.sql', 'create table public.widgets (id int);\n');
    const res = runGate(MIGRATION_GATE, bashPayload('git commit -m x', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: path.join(home, 'nope.jsonl'), HOME: home },
    });
    assert.equal(res.decision, 'allow', 'no readable registry → inert');
  } finally { rmTmp(repo); rmTmp(home); }
});

// ════════════════════════════════════════════════════════════════════════════
// gate-publish-before-push
// ════════════════════════════════════════════════════════════════════════════

test('publish gate: pure helpers', () => {
  const g = require(PUBLISH_GATE);
  assert.equal(g.isGitPush('git push'), true);
  assert.equal(g.isGitPush('git push origin main'), true);
  assert.equal(g.isGitPush('foo && git push --force'), true);
  assert.equal(g.isGitPush('git -C /repo push'), true, 'global option before subcommand');
  assert.equal(g.isGitPush('git push --dry-run'), false, 'dry-run pushes nothing → allow inspection');
  assert.equal(g.isGitPush('git push origin main --dry-run'), false, 'dry-run anywhere in the segment');
  assert.equal(g.isGitPush('git push --help'), false, 'help prints docs, pushes nothing');
  assert.equal(g.isGitPush('git status'), false);
  assert.equal(g.isGitPush('git commit -m push'), false, 'commit mentioning push is not a push');
  assert.equal(g.isGitPush('git log --grep push'), false, 'push must be the subcommand');

  assert.deepEqual(g.releaseTriple('1.14.0'), [1, 14, 0]);
  assert.deepEqual(g.releaseTriple('v2.3.4-rc.1'), [2, 3, 4]);
  assert.equal(g.releaseTriple('garbage'), null);
  assert.equal(g.localAhead('1.14.0', '1.13.0'), true);
  assert.equal(g.localAhead('1.13.0', '1.13.0'), false, 'equal → already published');
  assert.equal(g.localAhead('1.12.0', '1.13.0'), false, 'behind → not ahead');
  assert.equal(g.localAhead('1.14.0', 'garbage'), false, 'uncomparable → not ahead');
});

test('publish gate: DENY on main when local @jhizzard version is ahead of npm', () => {
  const repo = mkTmp('td-pub-deny-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-'); const np = mkTmp('td-npm-');
  try {
    initRepo(repo, { branch: 'main' });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@jhizzard/fixturepkg', version: '9.9.9' }));
    const regPath = writeRegistry(reg, { id: 'publish-before-push', promoted: true });
    const fakeBin = fakeNpmDir(np, { version: '1.0.0' }); // npm has 1.0.0; local 9.9.9 → ahead
    const res = runGate(PUBLISH_GATE, bashPayload('git push origin main', repo), {
      cwd: repo,
      env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    assertNeverExit2(res);
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /publish-before-push/);
    assert.match(res.reason, /@jhizzard\/fixturepkg/);
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); rmTmp(np); }
});

test('publish gate: ALLOW on a non-main branch (parked bump is sanctioned) — no npm call needed', () => {
  const repo = mkTmp('td-pub-branch-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo, { branch: 'hotfix/park' });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@jhizzard/fixturepkg', version: '9.9.9' }));
    const regPath = writeRegistry(reg, { id: 'publish-before-push', promoted: true });
    // No fake npm on PATH — proves the non-main fast-path never shells out.
    const res = runGate(PUBLISH_GATE, bashPayload('git push origin hotfix/park', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home },
    });
    assert.equal(res.decision, 'allow');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('publish gate: ALLOW (fail-open) when npm view fails (package unpublished / offline)', () => {
  const repo = mkTmp('td-pub-unpub-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-'); const np = mkTmp('td-npm-');
  try {
    initRepo(repo, { branch: 'main' });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@jhizzard/neverpublished', version: '1.0.0' }));
    const regPath = writeRegistry(reg, { id: 'publish-before-push', promoted: true });
    const fakeBin = fakeNpmDir(np, { unpublished: true }); // npm view exits 1
    const res = runGate(PUBLISH_GATE, bashPayload('git push origin main', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    assert.equal(res.decision, 'allow', 'unpublished/offline → skip that package → allow');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); rmTmp(np); }
});

test('publish gate: INERT on main when rule is only advisory', () => {
  const repo = mkTmp('td-pub-inert-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-'); const np = mkTmp('td-npm-');
  try {
    initRepo(repo, { branch: 'main' });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@jhizzard/fixturepkg', version: '9.9.9' }));
    const regPath = writeRegistry(reg, { id: 'publish-before-push', promoted: false }); // advisory
    const fakeBin = fakeNpmDir(np, { version: '1.0.0' });
    const res = runGate(PUBLISH_GATE, bashPayload('git push origin main', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    assert.equal(res.decision, 'allow', 'advisory rule → gate is a no-op even with an ahead version');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); rmTmp(np); }
});

test('publish gate: ALLOW when not a git push', () => {
  const repo = mkTmp('td-pub-nopush-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-');
  try {
    initRepo(repo, { branch: 'main' });
    const regPath = writeRegistry(reg, { id: 'publish-before-push', promoted: true });
    const res = runGate(PUBLISH_GATE, bashPayload('git status', repo), {
      cwd: repo, env: { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home },
    });
    assert.equal(res.decision, 'allow');
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); }
});

test('publish gate: ALLOW `git push --dry-run` / `--help` even under DENY conditions (non-writing probes)', () => {
  const repo = mkTmp('td-pub-dryrun-'); const reg = mkTmp('td-reg-'); const home = mkTmp('td-home-'); const np = mkTmp('td-npm-');
  try {
    // Exact conditions that DENY a real push: main branch + ahead version +
    // promoted rule + npm-has-an-older-version. --dry-run/--help must STILL allow.
    initRepo(repo, { branch: 'main' });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@jhizzard/fixturepkg', version: '9.9.9' }));
    const regPath = writeRegistry(reg, { id: 'publish-before-push', promoted: true });
    const fakeBin = fakeNpmDir(np, { version: '1.0.0' });
    const env = { TERMDECK_DOCTRINE_REGISTRY: regPath, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` };
    for (const cmd of ['git push --dry-run', 'git push origin main --dry-run', 'git push --help']) {
      const res = runGate(PUBLISH_GATE, bashPayload(cmd, repo), { cwd: repo, env });
      assertNeverExit2(res);
      assert.equal(res.decision, 'allow', `${cmd} is a non-writing probe → allow`);
    }
  } finally { rmTmp(repo); rmTmp(reg); rmTmp(home); rmTmp(np); }
});
