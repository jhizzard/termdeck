// Sprint 44 T2 — pure unit tests for the agent-instruction sync script.
//
// Covers: banner injection, agent-specific lead-in correctness, byte-for-byte
// content fidelity to CLAUDE.md, idempotency on re-run, and missing-CLAUDE.md
// error handling. Each test runs against a temp repo root so the real
// AGENTS.md / GEMINI.md at the project root are never touched.
//
// Run: node --test tests/sync-agent-instructions.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildMirror,
  syncAll,
  BANNER,
  MIRRORS,
} = require('../scripts/sync-agent-instructions');

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sync-test-'));
  return dir;
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SAMPLE_CLAUDE = `# Sample CLAUDE.md

This is the canonical instruction file.

- rule one
- rule two

End.
`;

test('buildMirror: prepends banner + blockquote lead-in then full canonical body', () => {
  const out = buildMirror(SAMPLE_CLAUDE, 'For test agent users.');
  assert.ok(out.startsWith(BANNER), 'output starts with banner');
  assert.ok(out.includes('\n> For test agent users.\n'), 'lead-in is a blockquote');
  assert.ok(out.endsWith(SAMPLE_CLAUDE), 'canonical body is appended verbatim');
});

test('buildMirror: rejects non-string canonical', () => {
  assert.throws(() => buildMirror(null, 'lead'), TypeError);
  assert.throws(() => buildMirror(42, 'lead'), TypeError);
});

test('buildMirror: rejects empty or non-string lead', () => {
  assert.throws(() => buildMirror('body', ''), TypeError);
  assert.throws(() => buildMirror('body', undefined), TypeError);
});

test('syncAll: writes both mirrors with banner + correct lead', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), SAMPLE_CLAUDE);

    const { written, unchanged } = syncAll({ repoRoot: root });
    assert.equal(written.length, 2, 'wrote AGENTS.md + GEMINI.md');
    assert.equal(unchanged.length, 0);

    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
    const gemini = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf-8');

    assert.ok(agents.startsWith(BANNER));
    assert.ok(gemini.startsWith(BANNER));

    assert.ok(agents.includes(`> ${MIRRORS.AGENTS.lead}\n`), 'AGENTS lead-in present');
    assert.ok(gemini.includes(`> ${MIRRORS.GEMINI.lead}\n`), 'GEMINI lead-in present');

    // The two leads must differ; otherwise the agent-specific note is wasted.
    assert.notEqual(MIRRORS.AGENTS.lead, MIRRORS.GEMINI.lead);

    // Sanity: AGENTS lead is for Codex + Grok; GEMINI lead names Gemini.
    assert.ok(/codex/i.test(MIRRORS.AGENTS.lead) && /grok/i.test(MIRRORS.AGENTS.lead));
    assert.ok(/gemini/i.test(MIRRORS.GEMINI.lead));
  } finally {
    rmDir(root);
  }
});

test('syncAll: byte-for-byte preserves canonical body after the banner block', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), SAMPLE_CLAUDE);
    syncAll({ repoRoot: root });

    for (const name of Object.keys(MIRRORS)) {
      const out = fs.readFileSync(path.join(root, `${name}.md`), 'utf-8');
      // Strip the banner + blockquote prefix and confirm the remainder is
      // identical to CLAUDE.md.
      const expected = SAMPLE_CLAUDE;
      assert.ok(out.endsWith(expected), `${name}.md ends with the canonical body verbatim`);
      // Stricter: the prefix is exactly banner + 2 newlines + "> lead\n\n".
      const lead = MIRRORS[name].lead;
      const prefix = `${BANNER}\n\n> ${lead}\n\n`;
      assert.equal(
        out.slice(0, prefix.length),
        prefix,
        `${name}.md prefix is banner + lead-in only`
      );
      assert.equal(out.length, prefix.length + expected.length, `${name}.md has no other inserts`);
    }
  } finally {
    rmDir(root);
  }
});

test('syncAll: idempotent — second run reports unchanged and writes nothing', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), SAMPLE_CLAUDE);

    const first = syncAll({ repoRoot: root });
    assert.equal(first.written.length, 2);
    assert.equal(first.unchanged.length, 0);

    const before = Object.keys(MIRRORS).map((n) => ({
      n,
      mtime: fs.statSync(path.join(root, `${n}.md`)).mtimeMs,
    }));

    const second = syncAll({ repoRoot: root });
    assert.equal(second.written.length, 0, 'no writes on second run');
    assert.equal(second.unchanged.length, 2, 'both mirrors unchanged');

    // mtime must be untouched — confirms no fs.writeFileSync call on re-run.
    for (const { n, mtime } of before) {
      const after = fs.statSync(path.join(root, `${n}.md`)).mtimeMs;
      assert.equal(after, mtime, `${n}.md mtime preserved`);
    }
  } finally {
    rmDir(root);
  }
});

test('syncAll: re-syncs after canonical CLAUDE.md changes', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), SAMPLE_CLAUDE);
    syncAll({ repoRoot: root });

    const updated = SAMPLE_CLAUDE + '\nNEW LINE ADDED.\n';
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), updated);

    const result = syncAll({ repoRoot: root });
    assert.equal(result.written.length, 2, 'both mirrors rewritten after canonical change');

    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
    assert.ok(agents.endsWith(updated));
  } finally {
    rmDir(root);
  }
});

test('syncAll: throws clean error when CLAUDE.md is missing', () => {
  const root = makeTempRoot();
  try {
    assert.throws(
      () => syncAll({ repoRoot: root }),
      /canonical CLAUDE\.md not found/
    );
    assert.equal(
      fs.existsSync(path.join(root, 'AGENTS.md')),
      false,
      'no AGENTS.md created on missing canonical'
    );
    assert.equal(
      fs.existsSync(path.join(root, 'GEMINI.md')),
      false,
      'no GEMINI.md created on missing canonical'
    );
  } finally {
    rmDir(root);
  }
});

test('syncAll: returns canonicalPath for caller telemetry', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), SAMPLE_CLAUDE);
    const result = syncAll({ repoRoot: root });
    assert.equal(result.canonicalPath, path.join(root, 'CLAUDE.md'));
  } finally {
    rmDir(root);
  }
});

test('package.json: exposes sync:agents npm script', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
  );
  assert.equal(
    pkg.scripts['sync:agents'],
    'node scripts/sync-agent-instructions.js',
    'sync:agents script wired into root package.json'
  );
});
