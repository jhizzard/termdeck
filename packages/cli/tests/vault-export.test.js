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

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 69 — the navigation layer.
//
// Everything below pins the topology and schema that turned the projection
// from a flat orphan cloud into hub-and-spoke neighbourhoods. These are
// RENDER-level goldens: pure functions, no filesystem, no database. The
// pipeline-level fences (byte-stability, timezone invariance, orphan sweep,
// manifest completeness, dangling links, graph.json never clobbered) live in
// `vault-export-fences.test.js`, which drives the real end-to-end export.
//
// A note on fixtures: these are deliberately NOT sampled from the real store.
// Read-only psql over the 9,167 live exportable rows on 2026-08-02 found ZERO
// instances of every case that actually matters here — no dangling member ids,
// no memory in two communities, no empty community, no `created_at` ties, no
// path-hostile project name. Goldens built from real output would pin the
// happy path and prove nothing about the shapes that break. So the hard cases
// are synthetic and deliberate, and each one says why it exists.
// ═══════════════════════════════════════════════════════════════════════════

const {
  noteTitle, noteAliases, tagSlug, relPathFor, routeFor, projectSegment,
  buildNameMap, buildTopology, buildIndexView, mocNameFor,
  renderHome, renderMoc, renderMemoriesBase, renderGraphDefaults,
  DATE_PREFIXED_TYPES, SNAPSHOT_TYPES,
} = vaultExport;

// MEM_B sits in BOTH communities below — the multi-membership case.
const SUMMARY_TWO = {
  id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  content: 'Credential loading silently falls back to an empty object.',
  source_type: 'consolidation_summary',
  category: 'consolidation',
  project: 'termdeck',
  metadata: {
    consolidation: {
      kind: 'community_summary',
      version: 1,
      community_key: MEM_B.id,
      // One in-scope member, one that is not — the dangling case.
      member_ids: [MEM_B.id, 'dddddddd-dead-dead-dead-dddddddddddd'],
      member_count: 2,
      generated_at: '2026-07-31T04:30:00.000Z',
      generator: 'graph-consolidation/claude-haiku-4-5-20251001',
    },
  },
  privacy_tags: [],
  source_agent: null,
  created_at: new Date('2026-07-31T04:31:00.000Z'),
};

const MEM_SESSION = {
  id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
  content: 'Session wrap: shipped the exporter topology pass.',
  source_type: 'session_summary',
  category: null,
  project: 'termdeck',
  metadata: {},
  privacy_tags: [],
  source_agent: 'claude',
  created_at: new Date('2026-07-01T12:00:00.000Z'),
};

const TOPOLOGY_SET = [MEM_A, MEM_B, SUMMARY, SUMMARY_TWO, MEM_SESSION];

function topologyFor(memories = TOPOLOGY_SET) {
  const nameOf = buildNameMap(memories);
  return { nameOf, topology: buildTopology(memories, nameOf) };
}

// ── P0-1: community membership renders as topology ─────────────────────────

test('a community hub renders its members as piped wikilinks and is flagged hub: true', () => {
  const { nameOf, topology } = topologyFor();
  const note = renderNote(SUMMARY, [], nameOf, topology);

  assert.match(note, /\nhub: true\n/, 'a hub must be machine-identifiable, not only visually');
  assert.match(note, /\n## Members\n/);
  // Piped, so the hub list reads as prose rather than as a column of slugs.
  assert.match(note, new RegExp(`- \\[\\[${nameOf.get(MEM_A.id)}\\|[^\\]]+\\]\\]`));
  assert.match(note, new RegExp(`- \\[\\[${nameOf.get(MEM_B.id)}\\|[^\\]]+\\]\\]`));
});

test('a member note points back at its hub via up: and a Part of: line', () => {
  const { nameOf, topology } = topologyFor();
  const note = renderNote(MEM_A, [], nameOf, topology);

  assert.match(note, new RegExp(`up:\\n {2}- "\\[\\[${nameOf.get(SUMMARY.id)}\\]\\]"`));
  assert.match(note, new RegExp(`Part of: \\[\\[${nameOf.get(SUMMARY.id)}\\|`),
    'the backlink must also be visible in the body — frontmatter alone is invisible while reading');
});

test('up: is a YAML LIST even when a note belongs to exactly one community', () => {
  // Binding contract (ORCH R-2 §4). Live data is 1:1 today, so a scalar would
  // work right up until the consolidation job emits overlapping communities —
  // at which point a scalar silently drops every membership after the first,
  // and no existing test would notice. The list shape makes 1→N a no-op.
  const { nameOf, topology } = topologyFor();
  const note = renderNote(MEM_A, [], nameOf, topology);
  assert.match(note, /\nup:\n {2}- "\[\[/, 'up: must be a list, never a scalar `up: "[[hub]]"`');
});

test('a note in two communities lists both hubs, in a deterministic order', () => {
  const { nameOf, topology } = topologyFor();
  const first = renderNote(MEM_B, [], nameOf, topology);
  // MEM_B is a member of SUMMARY and SUMMARY_TWO.
  assert.match(first, new RegExp(`- "\\[\\[${nameOf.get(SUMMARY.id)}\\]\\]"`));
  assert.match(first, new RegExp(`- "\\[\\[${nameOf.get(SUMMARY_TWO.id)}\\]\\]"`));

  // Reversing the input order must not reorder the output: hub order comes
  // from the data, not from however Postgres happened to return rows.
  const reversed = topologyFor([...TOPOLOGY_SET].reverse());
  assert.equal(renderNote(MEM_B, [], reversed.nameOf, reversed.topology), first);
});

test('a member outside the export scope is counted and rendered as text, never as a wikilink', () => {
  const { nameOf, topology } = topologyFor();
  const note = renderNote(SUMMARY_TWO, [], nameOf, topology);

  assert.ok(!note.includes('dddddddd'),
    'a wikilink to a note that does not exist reads in Obsidian as data corruption rather than as a '
    + 'deliberate scope boundary');
  assert.match(note, /_1 member outside this export's scope\._/,
    'the omission must be visible — a silently shorter list misrepresents the community size');
  assert.equal(topology.danglingMembers, 1, 'and it must be counted, so the export can report it');
});

test('a hub is never its own member, and a repeated member id yields one bullet', () => {
  const selfReferential = {
    ...SUMMARY,
    id: 'cccccccc-1111-2222-3333-444444444444',
    metadata: {
      consolidation: {
        ...SUMMARY.metadata.consolidation,
        member_ids: [MEM_A.id, MEM_A.id, 'cccccccc-1111-2222-3333-444444444444'],
        member_count: 3,
      },
    },
  };
  const memories = [MEM_A, selfReferential];
  const nameOf = buildNameMap(memories);
  const note = renderNote(selfReferential, [], nameOf, buildTopology(memories, nameOf));

  const bullets = note.split('\n').filter((l) => l.startsWith('- [['));
  assert.equal(bullets.length, 1, 'duplicate ids must collapse and a hub must not link to itself');
});

test('a consolidation summary with no members still renders without a stray empty section', () => {
  const empty = {
    ...SUMMARY,
    id: 'eeeeeeee-1111-2222-3333-444444444444',
    metadata: { consolidation: { ...SUMMARY.metadata.consolidation, member_ids: [], member_count: 0 } },
  };
  const nameOf = buildNameMap([empty]);
  const note = renderNote(empty, [], nameOf, buildTopology([empty], nameOf));
  assert.ok(!/## Members\n\n\n/.test(note), 'an empty community must not leave a dangling heading');
  assert.doesNotThrow(() => renderNote(empty, [], nameOf, buildTopology([empty], nameOf)));
});

// ── P0-2: frontmatter as schema ────────────────────────────────────────────

test('frontmatter carries the schema Bases and the graph view read', () => {
  const { nameOf, topology } = topologyFor();
  const note = renderNote(MEM_A, [], nameOf, topology);

  assert.match(note, /\ntags: \["project\/termdeck", "type\/bug_fix"\]\n/);
  assert.match(note, /\nedge_count: \d+\n/);
  assert.match(note, /\naliases: \[/);
});

test('date: is UNQUOTED, because a quoted date types as a string and blanks every date filter', () => {
  const { nameOf, topology } = topologyFor();
  const note = renderNote(MEM_A, [], nameOf, topology);
  assert.match(note, /\ndate: 2026-07-01\n/);
  assert.ok(!/\ndate: "2026-07-01"\n/.test(note),
    'Obsidian types a quoted YAML date as text; every `note.date >=` formula in Memories.base then '
    + 'silently matches nothing, and the dashboards look empty rather than broken');
});

test('dates are UTC-derived, so a filename cannot depend on the exporting machine', () => {
  // 12:00Z is the trap: under UTC+14 this instant is the NEXT calendar day.
  const prevTz = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const utc = renderNote(MEM_A, [], nameMap(MEM_A));
    process.env.TZ = 'Pacific/Kiritimati';
    const plus14 = renderNote(MEM_A, [], nameMap(MEM_A));
    assert.equal(utc, plus14,
      'a local-time date gives two machines two different link namespaces for the same store — use '
      + 'created_at.toISOString().slice(0, 10)');
    assert.match(utc, /\ndate: 2026-07-01\n/);
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test('tag slugs preserve underscores so type/* maps 1:1 onto the source_type column', () => {
  assert.equal(tagSlug('bug_fix'), 'bug_fix');
  assert.equal(tagSlug('Chopin In Bohemia'), 'chopin-in-bohemia');
  assert.equal(tagSlug('', 'unknown'), 'unknown');
});

test('aliases expose a human title, so search does not show only uuid slugs', () => {
  const aliases = noteAliases(MEM_A);
  assert.ok(Array.isArray(aliases) && aliases.length > 0);
  assert.ok(aliases.some((a) => /permission denied/i.test(a)));
  assert.ok(noteTitle(MEM_A).length > 0);
});

// ── P1-4 / P2-8: routing and date-prefixed filenames ───────────────────────

test('routing sends bulk machine output to snapshots/ and real content to notes/<project>/', () => {
  // The whole point of the folder split: `-path:snapshots` prunes the noisiest
  // class from the graph in ONE clause. Meaning lives in links, not folders.
  assert.equal(routeFor({ ...MEM_A, source_type: 'pre_compact_snapshot' }), 'snapshots');
  assert.equal(routeFor({ ...MEM_A, source_type: 'document_chunk' }), 'snapshots');
  assert.equal(routeFor(SUMMARY), 'communities');
  assert.match(relPathFor(MEM_A, nameMap(MEM_A)), /^notes\/termdeck\//);
  // A session summary is real per-project content, not quarantine noise, so it
  // stays with its project and earns its chronology from the date prefix.
  assert.match(relPathFor(MEM_SESSION, nameMap(MEM_SESSION)), /^notes\/termdeck\//);
});

test('only the time-series classes get a date-prefixed filename', () => {
  assert.deepEqual([...DATE_PREFIXED_TYPES].sort(),
    ['document_chunk', 'pre_compact_snapshot', 'session_summary']);
  assert.match(noteName(MEM_SESSION), /^2026-07-01-/,
    'Obsidian sorts filenames lexically, so a date prefix is a free chronological index');
  assert.ok(!/^\d{4}-\d{2}-\d{2}-/.test(noteName(MEM_A)),
    'a bug fix has no useful position on a timeline; prefixing it would be noise');
});

test('the date prefix is applied BEFORE collision widening, not after', () => {
  // Order matters: the collision pass has to see the FINAL name. If it ran on
  // the un-prefixed stem, two notes disambiguated apart could be re-merged by
  // the prefix (or vice versa), and the resulting name collision would only
  // surface as two memories overwriting each other's file.
  const twinA = { ...MEM_SESSION, id: '11110000-0000-0000-0000-000000000001' };
  const twinB = { ...MEM_SESSION, id: '11110000-0000-0000-0000-000000000002' };
  const nameOf = buildNameMap([twinA, twinB]);

  const a = nameOf.get(twinA.id);
  const b = nameOf.get(twinB.id);
  assert.notEqual(a, b, 'identical content on the same day must still produce distinct files');
  assert.match(a, /^2026-07-01-/, 'widening must preserve the date prefix');
  assert.match(b, /^2026-07-01-/);

  // Order-independence: ALL claimants widen, so the outcome cannot depend on
  // the order Postgres returned the rows in.
  const reversed = buildNameMap([twinB, twinA]);
  assert.equal(reversed.get(twinA.id), a);
  assert.equal(reversed.get(twinB.id), b);
});

test('project segments are lowercased so case variants cannot split or collide', () => {
  // `PVB` (2 rows) vs `pvb` (1613) collide on a case-insensitive filesystem
  // and would otherwise split one project across two folders and two MOCs.
  assert.equal(projectSegment('PVB'), projectSegment('pvb'));
  assert.equal(mocNameFor(tagSlug('ChopinInBohemia')), mocNameFor(tagSlug('chopininbohemia')));
});

// ── P0-3: generated entry points ───────────────────────────────────────────

function indexFixture() {
  const memories = TOPOLOGY_SET;
  const nameOf = buildNameMap(memories);
  const topology = buildTopology(memories, nameOf);
  const index = buildIndexView(memories, nameOf, topology);
  const stats = {
    notes: memories.length,
    edges: 0,
    excluded_privacy: 0,
    dangling_members: topology.danglingMembers,
    newest: index.newest,
    oldest: index.oldest,
  };
  return { memories, nameOf, topology, index, stats };
}

test('Home links only to notes that exist, and carries the Bases embeds', () => {
  const { index, stats, nameOf } = indexFixture();
  const home = renderHome({
    stats, hubs: index.hubs, projects: index.projects, recent: index.recent, doctrine: index.doctrine,
  });

  const names = new Set([...nameOf.values()]);
  for (const m of home.matchAll(/\[\[([^\]|#]+)/g)) {
    const target = m[1].trim();
    if (target.startsWith('MOC - ') || target === 'Home' || target.startsWith('Memories.base')) continue;
    assert.ok(names.has(target), `Home links to a note that does not exist: ${target}`);
  }
  assert.match(home, /!\[\[Memories\.base#Communities\]\]/);
  assert.ok(!/generated_at/.test(home),
    'Home must not carry its own generation stamp — the marker and README already hold the one '
    + 'authoritative copy, and a stamp here would dirty the file on every nightly export');
});

test('a MOC points up at Home and scopes its feed to its own project', () => {
  const { index } = indexFixture();
  const moc = renderMoc(index.projects[0]);

  assert.match(moc, /\nup:\n {2}- "\[\[Home\]\]"/);
  assert.match(moc, /\ntags: \["index\/moc", "project\/termdeck"\]\n/);
  assert.match(moc, /!\[\[Memories\.base#ProjectFeed\]\]/);
  assert.ok(!/generated_at/.test(moc), 'a per-project stamp would dirty every MOC on every export');
});

// ── P1-5 / P1-6: the reading surface ───────────────────────────────────────

test('every Bases view embedded by Home, the MOCs, or a hub is actually declared in Memories.base', () => {
  // The integration nobody owns end-to-end: T1 writes the embeds, T2 declares
  // the views. A disagreement does not throw — the embed just renders empty,
  // which looks like "I have no recent memories" rather than like a bug.
  const base = renderMemoriesBase();
  const declared = new Set([...base.matchAll(/^\s*name:\s*(.+)$/gm)].map((m) => m[1].trim()));

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'vault-export.js'), 'utf8');
  const embedded = [...source.matchAll(/Memories\.base#([A-Za-z]+)/g)].map((m) => m[1]);
  assert.ok(embedded.length > 0, 'expected the exporter to embed at least one Bases view');

  for (const view of new Set(embedded)) {
    assert.ok(declared.has(view),
      `the exporter embeds ![[Memories.base#${view}]] but Memories.base declares no view by that name — `
      + `the embed renders empty instead of failing loudly. Declared: ${[...declared].join(', ')}`);
  }
});

test('the generated graph defaults serialize to valid JSON and open on a readable graph', () => {
  const graph = renderGraphDefaults();
  assert.equal(typeof graph, 'object', 'the exporter builds the settings object; the writer serializes it');

  // Must survive the round-trip Obsidian will do to it.
  const parsed = JSON.parse(JSON.stringify(graph));
  assert.deepEqual(parsed, graph);

  // The three subtractive choices that make a 9,000-note graph legible at all:
  // prune the noisiest class in one clause, hide the notes with no edges, and
  // don't draw links to things that do not exist.
  assert.equal(parsed.search, '-path:snapshots',
    'the one-clause prune is the entire reason snapshots got their own folder');
  assert.equal(parsed.showOrphans, false);
  assert.equal(parsed.hideUnresolved, true);

  // Colour by TYPE tag, never by filename or folder — folders are for
  // pruning, tags are for meaning.
  assert.ok(Array.isArray(parsed.colorGroups) && parsed.colorGroups.length > 0);
  for (const group of parsed.colorGroups) {
    assert.match(group.query, /^tag:#type\//,
      `graph colour groups must key on the type tag, got: ${group.query}`);
  }
});
