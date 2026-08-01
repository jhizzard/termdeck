'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// Sprint 68-REDUX · T3 fence — RC-FILE FENCE IDEMPOTENCY + TRANSCRIPT ROTATION
//
// Two surfaces that touch things the user owns and cannot afford to get wrong:
//
//   RC FILE. We append a fenced block to a file the user wrote. The invariants
//   are "adds once", "second run is a no-op", and — the one that actually
//   matters — "uninstall restores the file BYTE-EXACTLY". Anything less and we
//   are silently rewriting someone's dotfiles, which Brad syncs across machines.
//
//   ROTATION. The shim prunes transcripts at spawn. A prune is a delete on the
//   user's disk driven by a variable that could mis-expand, so the fence checks
//   the blast radius explicitly: only *.log, only inside standalone-transcripts,
//   only older than the cutoff.
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { makeWorld, REPO_ROOT } = require('./_shim-harness');

const installer = require(path.join(REPO_ROOT, 'packages', 'stack-installer', 'src', 'index.js'));
const uninstaller = require(path.join(REPO_ROOT, 'packages', 'stack-installer', 'src', 'uninstall.js'));

const SHIM_SOURCE_DIR = path.join(
  REPO_ROOT, 'packages', 'stack-installer', 'assets', 'shims',
);

// The installer prints a banner; silence it so a green run stays readable.
function quiet(fn) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = write; }
}

function rcWorld(rcContent = '# my shell config\nexport EDITOR=vim\n') {
  const w = makeWorld({ agent: 'codex' });
  const rcPath = path.join(w.home, '.zshrc');
  fs.writeFileSync(rcPath, rcContent);
  return { w, rcPath, original: rcContent };
}

const installOpts = (w, rcPath) => ({
  home: w.home,
  sourceDir: SHIM_SOURCE_DIR,
  assumeYes: true,
  target: { supported: true, shell: 'zsh', rcPath },
});

test('rc fence: fresh install appends exactly one fenced block and preserves prior content', async (t) => {
  const { w, rcPath, original } = rcWorld();
  t.after(() => w.cleanup());

  await quiet(() => installer.installShellShims(installOpts(w, rcPath)));

  const after = fs.readFileSync(rcPath, 'utf8');
  assert.ok(after.startsWith(original), "the user's existing rc content must be untouched and first");
  assert.equal(
    (after.match(/# >>> termdeck shims >>>/g) || []).length, 1,
    'exactly one start fence',
  );
  assert.equal((after.match(/# <<< termdeck shims <<</g) || []).length, 1, 'exactly one end fence');
  assert.match(after, /export PATH="\$HOME\/\.termdeck\/shims:\$PATH"/);
  assert.ok(
    !after.includes(w.home) || after.indexOf(w.home) < after.indexOf('# >>> termdeck shims >>>'),
    'the block must be $HOME-relative — an absolute path breaks synced dotfiles',
  );
});

test('rc fence: the block is appended at the END so our prepend actually wins PATH order', async (t) => {
  const { w, rcPath } = rcWorld('# my config\nexport PATH="/opt/some-other-tool/bin:$PATH"\n');
  t.after(() => w.cleanup());

  await quiet(() => installer.installShellShims(installOpts(w, rcPath)));

  const after = fs.readFileSync(rcPath, 'utf8');
  assert.ok(
    after.indexOf('/opt/some-other-tool/bin') < after.indexOf('# >>> termdeck shims >>>'),
    'a PATH export already in the rc must be executed BEFORE ours, or their prepend '
    + 'shadows our shims and capture silently stops',
  );
});

test('rc fence: a second run is a no-op — byte-identical, no duplicate block', async (t) => {
  const { w, rcPath } = rcWorld();
  t.after(() => w.cleanup());

  await quiet(() => installer.installShellShims(installOpts(w, rcPath)));
  const afterFirst = fs.readFileSync(rcPath, 'utf8');

  await quiet(() => installer.installShellShims(installOpts(w, rcPath)));
  const afterSecond = fs.readFileSync(rcPath, 'utf8');

  assert.equal(afterSecond, afterFirst, 'idempotent re-run must not change a single byte');
  assert.equal((afterSecond.match(/# >>> termdeck shims >>>/g) || []).length, 1);
});

test('rc fence: uninstall splices the block out and restores the file byte-exactly', async (t) => {
  const { w, rcPath, original } = rcWorld();
  t.after(() => w.cleanup());

  await quiet(() => installer.installShellShims(installOpts(w, rcPath)));
  assert.notEqual(fs.readFileSync(rcPath, 'utf8'), original, 'precondition: the block was added');

  const res = uninstaller._removeRcShimBlock(fs.readFileSync(rcPath, 'utf8'));
  assert.equal(res.status, 'removed');
  fs.writeFileSync(rcPath, res.text);

  assert.equal(
    fs.readFileSync(rcPath, 'utf8'), original,
    'uninstall must restore the rc file BYTE-EXACTLY — this is someone\'s dotfile',
  );
});

test('rc fence: install → uninstall → install → uninstall converges (no drift accumulation)', async (t) => {
  const { w, rcPath, original } = rcWorld();
  t.after(() => w.cleanup());

  for (let i = 0; i < 2; i += 1) {
    await quiet(() => installer.installShellShims(installOpts(w, rcPath)));
    fs.writeFileSync(rcPath, uninstaller._removeRcShimBlock(fs.readFileSync(rcPath, 'utf8')).text);
    assert.equal(
      fs.readFileSync(rcPath, 'utf8'), original,
      `cycle ${i + 1} left residue — a stray newline per cycle is how dotfiles rot`,
    );
  }
});

test('rc fence: user content BELOW the block survives the splice', async (t) => {
  const { w, rcPath } = rcWorld();
  t.after(() => w.cleanup());

  await quiet(() => installer.installShellShims(installOpts(w, rcPath)));
  const withTrailer = `${fs.readFileSync(rcPath, 'utf8')}\n# something the user added later\nalias ll='ls -la'\n`;
  fs.writeFileSync(rcPath, withTrailer);

  fs.writeFileSync(rcPath, uninstaller._removeRcShimBlock(fs.readFileSync(rcPath, 'utf8')).text);

  const after = fs.readFileSync(rcPath, 'utf8');
  assert.ok(after.includes("alias ll='ls -la'"), 'content added after our block must survive');
  assert.ok(!after.includes('termdeck shims'), 'our block must be gone');
});

test('rc fence: duplicate or orphaned markers are REFUSED, file left untouched', () => {
  // Guessing which of two blocks is ours mangles a file the user has to log in
  // through. Refusing loudly is the only safe answer.
  const dupe = [
    '# top', '# >>> termdeck shims >>>', 'export PATH="a:$PATH"', '# <<< termdeck shims <<<',
    '# >>> termdeck shims >>>', 'export PATH="b:$PATH"', '# <<< termdeck shims <<<', '',
  ].join('\n');
  const dupeRes = uninstaller._removeRcShimBlock(dupe);
  assert.equal(dupeRes.status, 'malformed');
  assert.equal(dupeRes.text, dupe, 'a malformed rc must come back unchanged');

  const orphan = ['# top', '# <<< termdeck shims <<<', ''].join('\n');
  const orphanRes = uninstaller._removeRcShimBlock(orphan);
  assert.equal(orphanRes.status, 'malformed');
  assert.equal(orphanRes.text, orphan);

  const none = uninstaller._removeRcShimBlock('# nothing of ours here\n');
  assert.equal(none.status, 'absent');
});

// ── Rotation ─────────────────────────────────────────────────────────────────

function ageFile(p, days) {
  // `touch -t` with an explicit stamp; portable across BSD/GNU touch.
  const d = new Date(Date.now() - days * 86400000);
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}`;
  const r = spawnSync('touch', ['-t', stamp, p]);
  assert.equal(r.status, 0, `failed to age ${p}`);
}

test('rotation: transcripts older than 14 days are pruned, newer ones are kept', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const dir = w.transcriptDir();
  fs.mkdirSync(dir, { recursive: true });
  const old1 = path.join(dir, 'codex-1-1.log');
  const old2 = path.join(dir, 'grok-2-2.log');
  const recent = path.join(dir, 'codex-3-3.log');
  for (const p of [old1, old2, recent]) fs.writeFileSync(p, 'x');
  ageFile(old1, 20);
  ageFile(old2, 15);
  ageFile(recent, 13);

  w.runPty([]); // any invocation prunes at spawn

  assert.ok(!fs.existsSync(old1), '20-day-old transcript must be pruned');
  assert.ok(!fs.existsSync(old2), '15-day-old transcript must be pruned');
  assert.ok(fs.existsSync(recent), '13-day-old transcript must be kept — the cutoff is 14d, not "old-ish"');
});

test('rotation: blast radius is bounded to *.log inside standalone-transcripts', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const dir = w.transcriptDir();
  fs.mkdirSync(dir, { recursive: true });

  // Ancient, but must NOT be touched: wrong extension, or outside the dir.
  const notALog = path.join(dir, 'notes.txt');
  const sibling = path.join(w.home, '.termdeck', 'ancient-secrets.env');
  const nested = path.join(dir, 'sub', 'deep.log');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(notALog, 'keep me');
  fs.writeFileSync(sibling, 'keep me too');
  fs.writeFileSync(nested, 'and me');
  for (const p of [notALog, sibling, nested]) ageFile(p, 400);

  w.runPty([]);

  assert.ok(fs.existsSync(notALog), 'a non-.log file in the transcripts dir must survive');
  assert.ok(fs.existsSync(sibling), 'nothing OUTSIDE standalone-transcripts may ever be pruned');
  assert.ok(fs.existsSync(nested), 'prune is -maxdepth 1; a nested file must survive');
});

test('rotation: an empty or absent transcripts dir is not an error', (t) => {
  const w = makeWorld({ agent: 'codex' });
  t.after(() => w.cleanup());

  const r = w.runPty([]);

  assert.equal(r.status, 0, 'first-ever run has no transcripts dir and must still succeed');
  assert.equal(w.transcripts().length, 1);
});
