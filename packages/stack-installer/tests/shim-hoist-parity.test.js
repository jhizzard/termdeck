'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Sprint 68-REDUX · T3 fence — HOISTED-TWIN PARITY (INSTALLER-PITFALLS Class N)
//
// T2 hoisted the shim staging + rc-fence primitives out of
// `packages/stack-installer/src/index.js` into `packages/cli/src/init-mnestra.js`,
// for the same reason `_mergeSessionEndHookEntry` was hoisted in Sprint 51.8
// (ledger #16): the published `@jhizzard/termdeck` tarball ships
// `packages/stack-installer/assets/**` but NOT `.../src/**`, so the wizard
// cannot `require()` across the package boundary at runtime.
//
// That leaves two copies of the same logic in two packages that version
// independently — Class N by construction. This file is the pin T2 asked for:
// drive BOTH copies with identical inputs and assert identical outputs, so an
// edit to one that isn't mirrored fails loudly.
//
// ── WHAT THIS FILE DOES NOT CLAIM ─────────────────────────────────────────────
// Behavioural parity on the primitives, not on the WRAPPERS. `installShellShims`
// (installer) and `refreshShellShims` (wizard) are deliberately NOT equivalent:
// the wizard refreshes and never first-installs, because a user with no
// ~/.termdeck/shims either never ran the stack installer or DECLINED the prompt,
// and `init --mnestra` must not quietly overturn a decline by adding wrappers to
// their PATH. That asymmetry is intentional and is asserted here as an
// asymmetry, so a future "unify these" refactor has to confront it.
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { makeWorld, REPO_ROOT } = require('./_shim-harness');

const installer = require(path.join(REPO_ROOT, 'packages', 'stack-installer', 'src', 'index.js'));
const wizard = require(path.join(REPO_ROOT, 'packages', 'cli', 'src', 'init-mnestra.js'));

const SHIM_SOURCE_DIR = path.join(REPO_ROOT, 'packages', 'stack-installer', 'assets', 'shims');

// The primitives that exist under the same name in both modules.
const TWINS = [
  '_shimPathBlock', '_scanRcFences', '_rcBlockState', '_upsertRcBlock',
  '_detectRcTarget', '_shimManifest', '_stageShimFiles', '_ensureRcPathBlock',
  '_writeRcFile',
];

test('every declared twin is exported from BOTH modules', () => {
  for (const name of TWINS) {
    assert.equal(typeof installer[name], 'function', `stack-installer must export ${name}`);
    assert.equal(typeof wizard[name], 'function', `init-mnestra must export ${name}`);
  }
});

test('the shared constants are byte-identical across the package boundary', () => {
  // A drifted fence marker is the worst possible drift here: the installer would
  // write one fence and the wizard would fail to find it, then append a SECOND
  // block — and a duplicate fence makes uninstall refuse to touch the file.
  for (const k of ['SHIM_FENCE_START', 'SHIM_FENCE_END', 'SHIM_PATH_EXPORT']) {
    assert.equal(wizard[k], installer[k], `${k} has drifted between the two copies`);
  }
  assert.deepEqual(wizard.SHIM_NAMES, installer.SHIM_NAMES, 'the installed shim set has drifted');
});

test('_shimPathBlock produces byte-identical text in both copies', () => {
  assert.equal(wizard._shimPathBlock(), installer._shimPathBlock());
  // ...and it is the block the fences actually delimit.
  assert.ok(wizard._shimPathBlock().startsWith(installer.SHIM_FENCE_START));
  assert.ok(wizard._shimPathBlock().endsWith(installer.SHIM_FENCE_END));
});

test('_shimManifest agrees on what gets installed', () => {
  const a = installer._shimManifest(installer.SHIM_NAMES);
  const b = wizard._shimManifest(wizard.SHIM_NAMES);
  assert.deepEqual(b, a, 'the two copies disagree about which files land in ~/.termdeck/shims');
  // Guard the vacuous pass: an empty manifest is also "deep-equal".
  assert.ok(a.length >= installer.SHIM_NAMES.length, 'manifest must cover every shim name');
  assert.ok(
    a.some((e) => /drain\.js$/.test(e.dest || e.src || '')),
    'drain.js is required, not optional — without it capture degrades to nothing',
  );
});

// ── rc-text primitives, driven over a shared corpus ──────────────────────────

const RC_CORPUS = [
  ['empty', ''],
  ['no block', '# just a config\nexport EDITOR=vim\n'],
  ['our block only', `${installer._shimPathBlock()}\n`],
  ['block with content around it', `# before\n\n${installer._shimPathBlock()}\n\n# after\nalias ll='ls -la'\n`],
  ['drifted block (old export line)', `# before\n${installer.SHIM_FENCE_START}\nexport PATH="$HOME/.termdeck/OLD:$PATH"\n${installer.SHIM_FENCE_END}\n`],
  ['duplicate blocks', `${installer._shimPathBlock()}\n${installer._shimPathBlock()}\n`],
  ['orphan end fence', `# x\n${installer.SHIM_FENCE_END}\n`],
  ['orphan start fence', `# x\n${installer.SHIM_FENCE_START}\n`],
  ['no trailing newline', '# no newline at eof'],
  ['CRLF line endings', '# windows-ish\r\nexport EDITOR=vim\r\n'],
];

for (const [label, text] of RC_CORPUS) {
  test(`_scanRcFences parity — ${label}`, () => {
    const a = installer._scanRcFences(text);
    const b = wizard._scanRcFences(text);
    assert.deepEqual(
      { starts: b.starts, ends: b.ends, lines: b.lines },
      { starts: a.starts, ends: a.ends, lines: a.lines },
      `fence scan drifted on: ${label}`,
    );
  });

  test(`_rcBlockState parity — ${label}`, () => {
    assert.deepEqual(wizard._rcBlockState(text), installer._rcBlockState(text), `block state drifted on: ${label}`);
  });

  test(`_upsertRcBlock parity — ${label}`, () => {
    assert.deepEqual(wizard._upsertRcBlock(text), installer._upsertRcBlock(text), `upsert drifted on: ${label}`);
  });
}

test('_upsertRcBlock is idempotent and converges in BOTH copies', () => {
  for (const [label, text] of RC_CORPUS) {
    for (const mod of [installer, wizard]) {
      const once = mod._upsertRcBlock(text);
      if (once.status === 'malformed') continue; // refusal is terminal by design
      const twice = mod._upsertRcBlock(once.text);
      assert.equal(twice.text, once.text, `not idempotent on "${label}"`);
    }
  }
});

test('_detectRcTarget parity across shells and platforms, including the unsupported one', () => {
  // NB: the shell is read from `opts.env.SHELL`, NOT `opts.shell`. Passing the
  // wrong key silently falls through to the HOST's $SHELL, which on this fleet
  // is zsh — so a fish case written that way reports `supported: true` and reads
  // as a product defect when it is a test defect. (Caught exactly that way here.)
  const cases = [];
  for (const shell of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/sh', '']) {
    for (const platform of ['darwin', 'linux']) {
      cases.push({ home: '/tmp/fake-home', platform, env: { SHELL: shell } });
    }
  }
  cases.push({ home: '/tmp/fake-home', platform: 'darwin', env: {} }); // $SHELL unset

  for (const opts of cases) {
    assert.deepEqual(
      wizard._detectRcTarget(opts), installer._detectRcTarget(opts),
      `rc-target detection drifted for SHELL=${opts.env.SHELL ?? '<unset>'} platform=${opts.platform}`,
    );
  }

  // fish must be an unsupported loud-skip in both — a POSIX `export PATH=` line
  // in config.fish breaks the user's shell on next login.
  for (const mod of [installer, wizard]) {
    const fish = mod._detectRcTarget({ home: '/tmp/fake-home', env: { SHELL: '/usr/bin/fish' } });
    assert.equal(fish.supported, false, 'fish must never be written to');
    assert.equal(fish.rcPath, null, 'no rc path may be offered for fish');
    assert.ok(fish.manual, 'an unsupported shell must still be told what to do by hand');
  }
});

test('_stageShimFiles lands the same files, modes, and statuses from both copies', (t) => {
  const runStage = (mod) => {
    const w = makeWorld({ agent: 'codex' });
    t.after(() => w.cleanup());
    const destDir = path.join(w.home, '.termdeck', 'shims');
    const res = mod._stageShimFiles({
      sourceDir: SHIM_SOURCE_DIR,
      destDir,
      names: mod.SHIM_NAMES,
      dryRun: false,
      home: w.home,
    });
    const landed = fs.readdirSync(destDir).sort().map((f) => ({
      name: f,
      mode: (fs.statSync(path.join(destDir, f)).mode & 0o777).toString(8),
      sha: require('crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(destDir, f))).digest('hex'),
    }));
    return {
      landed,
      statuses: res.map((r) => ({ name: r.name, status: r.status })).sort((x, y) => x.name.localeCompare(y.name)),
    };
  };

  const a = runStage(installer);
  const b = runStage(wizard);

  assert.ok(a.landed.length > 0, 'precondition: the installer copy actually staged something');
  assert.deepEqual(b.landed, a.landed, 'staged files/modes/contents drifted between the copies');
  assert.deepEqual(b.statuses, a.statuses, 'staging statuses drifted between the copies');
  // Every shim must be executable, or the PATH entry is decorative.
  for (const f of a.landed.filter((x) => installer.SHIM_NAMES.includes(x.name))) {
    assert.equal(f.mode, '755', `${f.name} must be executable`);
  }
});

test('the wrappers are deliberately NOT twins: the wizard refreshes, it never first-installs', (t) => {
  // Asserted as an asymmetry so a future "unify these" refactor has to confront
  // it rather than discover it. A user with no ~/.termdeck/shims either never ran
  // the stack installer or declined its prompt; `init --mnestra` must not
  // overturn a decline by silently adding wrappers to their PATH.
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());
  const rcPath = path.join(w.home, '.zshrc');
  fs.writeFileSync(rcPath, '# rc\n');

  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  let res;
  try {
    res = wizard.refreshShellShims({
      home: w.home,
      sourceDir: SHIM_SOURCE_DIR,
      target: { supported: true, shell: 'zsh', rcPath },
    });
  } finally { process.stdout.write = write; }

  assert.ok(
    !fs.existsSync(path.join(w.home, '.termdeck', 'shims', 'codex')),
    'refresh must NOT create shims on a machine that has none',
  );
  assert.ok(
    !fs.readFileSync(rcPath, 'utf8').includes('termdeck shims'),
    'refresh must NOT add a PATH fence when there were no shims to refresh',
  );
  assert.ok(res, 'refresh still returns a result rather than throwing');
});
