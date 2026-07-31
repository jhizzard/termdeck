// Sprint 83 T3 — Obsidian vault exporter.
//
// Covers the properties that make the vault safe and useful:
//   • DETERMINISM — same input ⇒ byte-identical output. Note filenames are
//     wikilink targets, so a name that changed between runs would break every
//     inbound link in every other note and the vault would look progressively
//     corrupted with each regeneration.
//   • READ-ONLY POSTURE — the generated README says so, generated notes are
//     identifiable as generated, and there is no import path to test because
//     there deliberately is not one.
//   • THE DESTRUCTIVE-WRITE GUARD — this command deletes the previous run's
//     notes. Pointed at someone's real Obsidian vault it would destroy work,
//     so it must refuse a directory it did not create.
//
// All of it runs off-database: the render layer is pure, and the guard is
// filesystem-only.
//
// Run: node --test packages/cli/tests/vault-export.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vaultExport = require('../src/vault-export');
const { noteName, renderNote, renderVaultReadme, parseFlags, MARKER_FILE } = vaultExport;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-vault-test-'));
}

// Runs `fn` with NO reachable database credentials.
//
// Clearing `process.env.DATABASE_URL` alone is NOT enough: the exporter also
// falls back to `~/.termdeck/secrets.env`, which on a developer's machine is
// populated — so a test that only unsets the env var connects to the real
// store and asserts against live data. (It did, the first time this file ran:
// a "no credentials" test passed with exit 0 after a 2-second round-trip to
// production.) Overriding HOME points `os.homedir()` at an empty temp dir so
// the secrets fallback finds nothing, which makes the credential-absent path
// genuinely absent rather than merely unset.
async function withoutCredentials(fn) {
  const prevHome = process.env.HOME;
  const prevUrl = process.env.DATABASE_URL;
  const fakeHome = tmpdir();
  process.env.HOME = fakeHome;
  delete process.env.DATABASE_URL;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}

const MEM_A = {
  id: '11111111-2222-3333-4444-555555555555',
  content: 'Postgres permission denied on memory_items — the service role was missing a grant.',
  source_type: 'bug_fix',
  category: 'debugging',
  project: 'termdeck',
  metadata: { problem_signature: { v: 1, class: 'err-pg-permission-denied', symptom_hash: 'abc123' } },
  privacy_tags: [],
  source_agent: 'claude',
  created_at: new Date('2026-07-01T12:00:00.000Z'),
};

const MEM_B = {
  id: '66666666-7777-8888-9999-000000000000',
  content: 'Granting service_role EXECUTE fixed it.',
  source_type: 'bug_fix',
  category: null,
  project: 'termdeck',
  metadata: {},
  privacy_tags: [],
  source_agent: null,
  created_at: new Date('2026-07-02T12:00:00.000Z'),
};

const SUMMARY = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  content: 'These failures all trace to Postgres grants being applied per-migration rather than centrally.',
  source_type: 'consolidation_summary',
  category: 'consolidation',
  project: 'termdeck',
  metadata: {
    consolidation: {
      kind: 'community_summary',
      version: 1,
      community_key: MEM_A.id,
      member_ids: [MEM_A.id, MEM_B.id],
      member_count: 2,
      generated_at: '2026-07-31T04:30:00.000Z',
      generator: 'graph-consolidation/claude-haiku-4-5-20251001',
    },
  },
  privacy_tags: [],
  source_agent: null,
  created_at: new Date('2026-07-31T04:30:00.000Z'),
};

function nameMap(...memories) {
  return new Map(memories.map((m) => [m.id, noteName(m)]));
}

const EDGE = (over = {}) => ({
  relationship_type: 'fixed_by',
  direction: 'outbound',
  other_id: MEM_B.id,
  weight: 0.91,
  inferred_by: 'cron-2026-07-30',
  valid_at: new Date('2026-07-30T00:00:00.000Z'),
  invalid_at: null,
  ...over,
});

// ── determinism ────────────────────────────────────────────────────────────

test('note names are deterministic and derived only from content + id', () => {
  assert.equal(noteName(MEM_A), noteName({ ...MEM_A }));
  assert.ok(noteName(MEM_A).endsWith('-11111111'), 'the uuid prefix disambiguates similar content');
  // Same content, different id ⇒ different note. Otherwise two similar
  // memories would overwrite each other's file.
  assert.notEqual(noteName(MEM_A), noteName({ ...MEM_A, id: '99999999-0000-0000-0000-000000000000' }));
});

test('note names survive content that is entirely punctuation', () => {
  const n = noteName({ id: '12345678-0000-0000-0000-000000000000', content: '!!! ??? ***' });
  assert.equal(n, 'memory-12345678', 'must not produce an empty or dot-leading filename');
  assert.ok(!n.includes('/') && !n.includes('..'), 'note names must never contain path separators');
});

test('golden file: rendering is byte-stable across runs', () => {
  const nameOf = nameMap(MEM_A, MEM_B);
  const first = renderNote(MEM_A, [EDGE()], nameOf);
  const second = renderNote(MEM_A, [EDGE()], nameOf);
  assert.equal(first, second);

  // Pin the shape. If any of this changes, it is a deliberate format change
  // and the assertion should be updated with it — not silently drifted into.
  assert.match(first, /^---\n/);
  assert.match(first, /\nid: "11111111-2222-3333-4444-555555555555"\n/);
  assert.match(first, /\nsource_type: "bug_fix"\n/);
  assert.match(first, /\ncategory: "debugging"\n/);
  assert.match(first, /\nproblem_class: "err-pg-permission-denied"\n/);
  assert.match(first, /\nedges:\n {2}- type: "fixed_by"\n {4}direction: "outbound"\n/);
  assert.match(first, /\n {4}invalid_at: null\n/);
  assert.match(first, /\n## Links\n/);
  assert.match(first, new RegExp(`- → \\[\\[${noteName(MEM_B)}\\]\\]`));
});

test('edge ordering inside a note is deterministic regardless of query order', () => {
  const nameOf = nameMap(MEM_A, MEM_B);
  const edges = [
    EDGE({ relationship_type: 'supersedes', other_id: MEM_B.id }),
    EDGE({ relationship_type: 'caused_by', other_id: MEM_B.id }),
  ];
  const a = renderNote(MEM_A, edges, nameOf);
  const b = renderNote(MEM_A, [...edges].reverse(), nameOf);
  // Sections are emitted in a fixed vocabulary order, so a different row order
  // from Postgres cannot produce a different file.
  assert.equal(a.indexOf('### caused_by') < a.indexOf('### supersedes'), true);
  assert.equal(a.indexOf('### caused_by') < a.indexOf('### supersedes'),
    b.indexOf('### caused_by') < b.indexOf('### supersedes'));
});

// ── correctness of the rendered graph ──────────────────────────────────────

test('an edge pointing outside the export scope renders as text, not a broken wikilink', () => {
  // Only MEM_A is in scope; the edge target is not.
  const note = renderNote(MEM_A, [EDGE()], nameMap(MEM_A));
  assert.ok(!note.includes('[['), 'a wikilink to a non-existent note reads as data corruption in Obsidian');
  assert.match(note, /outside export scope/);
});

test('edge direction is rendered, because asymmetric predicates read differently per end', () => {
  const nameOf = nameMap(MEM_A, MEM_B);
  const out = renderNote(MEM_A, [EDGE({ direction: 'outbound' })], nameOf);
  const inb = renderNote(MEM_A, [EDGE({ direction: 'inbound' })], nameOf);
  assert.match(out, /- → \[\[/);
  assert.match(inb, /- ← \[\[/);
  assert.notEqual(out, inb);
});

test('temporal validity is carried into frontmatter', () => {
  const note = renderNote(MEM_A, [EDGE({ invalid_at: new Date('2026-07-31T00:00:00.000Z') })], nameMap(MEM_A, MEM_B));
  assert.match(note, /invalid_at: "2026-07-31T00:00:00\.000Z"/);
  assert.match(note, /inferred_by: "cron-2026-07-30"/);
});

test('YAML-hostile content cannot break the frontmatter', () => {
  const nasty = {
    ...MEM_A,
    content: 'error: "quoted" \\ backslash\nsecond line: with colon # and hash',
  };
  const note = renderNote(nasty, [], nameMap(nasty));
  const frontmatter = note.split('---')[1];
  // The content only appears in frontmatter via the note name; the raw text
  // lives in the body. What matters is that nothing unescaped leaked upward.
  assert.ok(!frontmatter.includes('\n"quoted"'), 'unescaped content must not appear as a YAML key');
  assert.equal(note.split('\n---')[0].startsWith('---'), true);
});

// ── generated-content provenance ───────────────────────────────────────────

test('a consolidation summary is unmistakably marked as generated', () => {
  const note = renderNote(SUMMARY, [], nameMap(SUMMARY));
  assert.match(note, /\ngenerated: true\n/);
  assert.match(note, /generated_by: "graph-consolidation\//);
  assert.match(note, /community_member_count: 2/);
  assert.match(note, /> \[!abstract\] Generated summary/);
  // Someone browsing the vault has no other way to tell a synthesized note
  // from one a human recorded. Both the machine-readable flag and the
  // human-visible callout are required.
});

test('an ordinary memory is NOT marked as generated', () => {
  const note = renderNote(MEM_A, [], nameMap(MEM_A));
  assert.ok(!note.includes('generated: true'));
  assert.ok(!note.includes('[!abstract]'));
});

// ── read-only posture ──────────────────────────────────────────────────────

test('the generated README states the read-only rule and the regeneration command', () => {
  const readme = renderVaultReadme({ dir: '/tmp/vault', notes: 3, edges: 5, excluded_privacy: 2, generated_at: 'now' });
  assert.match(readme, /READ-ONLY PROJECTION/);
  assert.match(readme, /are \*\*not\*\* written back/);
  assert.match(readme, /There is no import path/);
  assert.match(readme, /termdeck vault export \/tmp\/vault/);
  assert.match(readme, /2 memory\(ies\) withheld for privacy tags/,
    'a withheld count must be visible, or the note count is unexplainable');
});

test('the exporter exposes no import or write-back entry point', () => {
  // The read-only guarantee is architectural: there is nothing to call. If a
  // future change adds one, this fails and forces the conversation.
  const surface = Object.keys(vaultExport).concat(Object.keys(vaultExport.prototype || {}));
  for (const name of surface) {
    assert.ok(!/import|sync|write.?back|ingest|apply/i.test(name), `unexpected write-direction export: ${name}`);
  }
});

// ── the destructive-write guard ────────────────────────────────────────────

test('refuses to write into a non-empty directory it did not create', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'my-real-note.md'), '# do not delete me');

  const code = await vaultExport(['export', dir]);
  assert.equal(code, 1, 'must refuse rather than overwrite a directory that looks like a real vault');
  assert.ok(fs.existsSync(path.join(dir, 'my-real-note.md')), 'the pre-existing file must be untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the guard is keyed on the marker file, not on emptiness alone', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'stale-note.md'), '# from a previous run');
  fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify({ marker: 'termdeck-vault', files: [] }));

  // With the marker present the guard passes; the run then fails later for
  // missing credentials (exit 2 = infra), which is a DIFFERENT code from the
  // refusal (1). That distinction is the assertion.
  const code = await withoutCredentials(() => vaultExport(['export', dir]));

  assert.equal(code, 2, 'a marked directory must clear the guard and fail only on credentials');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--dry-run never triggers the guard and never writes', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'someones-note.md'), 'x');
  const before = fs.readdirSync(dir);

  const code = await withoutCredentials(() => vaultExport(['export', dir, '--dry-run']));

  assert.equal(code, 2, 'no credentials is an infra failure, not a guard refusal');
  assert.deepEqual(fs.readdirSync(dir), before, 'dry run must not touch the filesystem');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usage: bare `vault` prints help and exits non-zero', async () => {
  assert.equal(await vaultExport([]), 1);
});

// ── flag parsing ───────────────────────────────────────────────────────────

test('flags parse in both --k=v and --k v forms', () => {
  const { flags, positional } = parseFlags(['export', '/tmp/v', '--project=termdeck', '--limit', '50', '--force']);
  assert.deepEqual(positional, ['export', '/tmp/v']);
  assert.equal(flags.project, 'termdeck');
  assert.equal(flags.limit, '50');
  assert.equal(flags.force, true);
});
