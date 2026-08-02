// Sprint 69 T3 — full-pipeline fences for the Obsidian vault exporter.
//
// The sibling file (`vault-export.test.js`) tests the RENDER layer: pure
// functions, no filesystem, no database. This file tests the WHOLE PIPELINE —
// query → render → manifest sweep → write — by driving the real exporter
// against a fake Postgres client into a temp directory.
//
// ── WHY THESE ARE FENCES AND NOT MERELY TESTS ──────────────────────────────
//
// A fence fails when someone LATER adds a property the design forbids, not
// only when today's code is wrong. Each one below is written so that new
// output surfaces are caught by default rather than needing a matching new
// assertion:
//
//   • F1 BYTE-STABILITY asserts an ALLOWLIST OF DIFFERENCES IS EXHAUSTIVE.
//     Two exports of an identical store must be byte-identical except for two
//     enumerated timestamp sites. A new note, dashboard, or index file that
//     bakes in a clock reading fails this without anyone editing the test.
//   • F2 TIMEZONE-INVARIANCE runs the same export under UTC and UTC+14 across
//     a fixture timestamp that straddles the calendar day. Note filenames are
//     wikilink targets and dates are moving into filenames, so a date derived
//     from local-time accessors would make the vault's link namespace depend
//     on the exporting machine. Fails the moment anyone writes a local-time
//     date anywhere in the tree.
//   • F3 STALE-FILE SWEEP is the R-1 consequence: regeneration is
//     manifest-swept in place (unlink prior manifest files, then write) — NOT
//     atomic temp-tree-and-rename. So a naming or layout change must leave
//     zero orphans from the previous run.
//   • F4 DANGLING-WIKILINK SCAN walks every generated wikilink in the tree and
//     requires a real file behind it. A broken [[link]] reads as data
//     corruption in Obsidian, which is worse than an honest omission.
//   • F5 GRAPH.JSON NEVER-CLOBBER protects user tuning: write-if-missing, and
//     excluded from the manifest so the NEXT run does not unlink it.
//
// ── THE TEST SEAM ──────────────────────────────────────────────────────────
//
// `vault-export.js` reaches Postgres through `docSync.requirePg()` — a live
// property lookup on the required module object, resolved at call time. So a
// test can swap that property for a fake and drive the genuine end-to-end
// path with no production change, no credentials, and no database. If anyone
// refactors that call into a direct `require('pg')`, every fence in this file
// goes dark; that is why the seam is documented here rather than left as a
// clever trick for the next reader to reverse-engineer.
//
// Run: node --test packages/cli/tests/vault-export-fences.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docSync = require('../../server/src/doctrine-sync.js');
const vaultExport = require('../src/vault-export');
const { MARKER_FILE } = vaultExport;

// ── fixture store ──────────────────────────────────────────────────────────
//
// Deliberately NOT a sample of the real store. Read-only psql over the live
// 9,167 exportable rows on 2026-08-02 found ZERO of every edge case that
// matters here: zero dangling member_ids, zero multi-community members, zero
// empty communities, zero `created_at` ties, zero path-hostile project names.
// A golden built from real output would pin the happy path and prove nothing.
// Every hard case below is therefore synthetic and deliberate.

// 12:00Z is the load-bearing detail for F2: under UTC this is 2026-07-01, and
// under UTC+14 it is 2026-07-02. Any date derived from local-time accessors
// changes the calendar day here; `toISOString()` does not.
const AT = (iso) => new Date(iso);

const MEM_A = {
  id: '11111111-2222-3333-4444-555555555555',
  content: 'Postgres permission denied on memory_items — the service role was missing a grant.',
  source_type: 'bug_fix',
  category: 'debugging',
  project: 'termdeck',
  metadata: {},
  privacy_tags: [],
  source_agent: 'claude',
  created_at: AT('2026-07-01T12:00:00.000Z'),
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
  created_at: AT('2026-07-01T12:00:00.000Z'),
};

// A session note: one of the classes P2-8 moves to a date-prefixed filename,
// and the class most likely to acquire a local-time date by accident.
const MEM_SESSION = {
  id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
  content: 'Session wrap: shipped the exporter topology pass and re-ran the goldens.',
  source_type: 'session_summary',
  category: null,
  project: 'termdeck',
  metadata: {},
  privacy_tags: [],
  source_agent: 'claude',
  created_at: AT('2026-07-01T12:00:00.000Z'),
};

// A memory in a DIFFERENT project — proves per-project routing/indexing does
// not cross-contaminate, and that a second project appears in generated
// indexes.
const MEM_OTHER_PROJECT = {
  id: '88888888-9999-aaaa-bbbb-cccccccccccc',
  content: 'Scheduling solver picks a feasible assignment before optimizing fairness.',
  source_type: 'architecture',
  category: null,
  project: 'maestro',
  metadata: {},
  privacy_tags: [],
  source_agent: null,
  created_at: AT('2026-07-03T09:30:00.000Z'),
};

// Community hub whose members are all in scope — the happy path.
const SUMMARY = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  content: 'These failures all trace to Postgres grants applied per-migration rather than centrally.',
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
  created_at: AT('2026-07-31T04:30:00.000Z'),
};

// Community hub with a member that is NOT in the export set (archived,
// privacy-tagged, or filtered by --project/--limit). Zero instances live
// today; structurally reachable the moment a member is archived after its
// summary was written. The member must NOT render as a [[wikilink]].
const DANGLING_MEMBER_ID = 'dddddddd-dead-dead-dead-dddddddddddd';
const SUMMARY_DANGLING = {
  id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  content: 'Cross-project pattern: credential loading silently falls back to an empty object.',
  source_type: 'consolidation_summary',
  category: 'consolidation',
  project: 'termdeck',
  metadata: {
    consolidation: {
      kind: 'community_summary',
      version: 1,
      community_key: MEM_B.id,
      member_ids: [MEM_B.id, DANGLING_MEMBER_ID],
      member_count: 2,
      generated_at: '2026-07-31T04:30:00.000Z',
      generator: 'graph-consolidation/claude-haiku-4-5-20251001',
    },
  },
  privacy_tags: [],
  source_agent: null,
  created_at: AT('2026-07-31T04:31:00.000Z'),
};

// MEM_B belongs to BOTH summaries above. Zero instances live today, which is
// exactly why it is fixtured: if `up:` is modelled as a scalar because live
// data happens to be 1:1, the first overlapping community silently drops a
// membership and nothing catches it.
const FIXTURE_MEMORIES = [
  MEM_A, MEM_B, MEM_SESSION, MEM_OTHER_PROJECT, SUMMARY, SUMMARY_DANGLING,
];

const FIXTURE_EDGES = [
  {
    source_id: MEM_A.id,
    target_id: MEM_B.id,
    relationship_type: 'fixed_by',
    weight: 0.91,
    inferred_by: 'cron-2026-07-30',
    valid_at: AT('2026-07-30T00:00:00.000Z'),
    invalid_at: null,
  },
];

// ── the fake pg client ─────────────────────────────────────────────────────
//
// Dispatches on distinctive fragments of each query the exporter issues. An
// unrecognized query THROWS with the offending SQL rather than returning an
// empty result: a fake that silently answers `{rows: []}` to a query it does
// not understand turns "the exporter started asking for something new" into
// "the feature quietly produced nothing", which is precisely the failure mode
// these fences exist to prevent.
function makeFakePg({ memories, edges, hasTemporal = true, excludedPrivacy = 0 }) {
  const queries = [];
  const Client = class {
    constructor(config) { this.config = config; }
    async connect() {}
    async query(sql) {
      queries.push(sql);
      if (/information_schema\.columns/i.test(sql)) {
        return {
          rows: hasTemporal
            ? [{ column_name: 'valid_at' }, { column_name: 'invalid_at' }]
            : [{ column_name: 'weight' }],
        };
      }
      if (/from memory_relationships/i.test(sql)) return { rows: edges };
      if (/count\(\*\)::int as n\s+from memory_items/i.test(sql)) {
        return { rows: [{ n: excludedPrivacy }] };
      }
      if (/from memory_items/i.test(sql)) return { rows: memories };
      throw new Error(`fake pg: unrecognized query — update the fence harness:\n${sql}`);
    }
    async end() {}
  };
  return { module: { Client }, queries };
}

// Runs `fn` with the exporter pointed at a fake store. Restores the seam and
// the environment even when the body throws, so one failing fence cannot
// cascade into the rest of the file.
async function withFakeStore(store, fn) {
  const prevRequirePg = docSync.requirePg;
  const prevUrl = process.env.DATABASE_URL;
  const fake = makeFakePg(store);
  docSync.requirePg = () => fake.module;
  process.env.DATABASE_URL = 'postgres://fence/fence';
  try {
    return await fn(fake);
  } finally {
    docSync.requirePg = prevRequirePg;
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-vault-fence-'));
}

// Every file in the tree, as forward-slash relative paths, sorted. Includes
// dotfiles and dot-directories — `.obsidian/` and the marker are part of the
// output contract, not incidental noise.
function walkTree(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkTree(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function snapshotTree(dir) {
  const snap = new Map();
  for (const rel of walkTree(dir)) snap.set(rel, fs.readFileSync(path.join(dir, rel), 'utf8'));
  return snap;
}

// Per-line differences between two snapshots, as {file, line, before, after}.
function diffSnapshots(a, b) {
  const diffs = [];
  const files = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const file of files) {
    const left = a.get(file);
    const right = b.get(file);
    if (left === right) continue;
    if (left === undefined || right === undefined) {
      diffs.push({ file, line: null, before: left, after: right, missing: true });
      continue;
    }
    const la = left.split('\n');
    const lb = right.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) diffs.push({ file, line: i + 1, before: la[i], after: lb[i] });
    }
  }
  return diffs;
}

// The ONLY differences permitted between two exports of an identical store.
// Both are the same value — the run's wall-clock stamp — surfaced in two
// places on purpose: the marker's machine-readable field and the README's
// human-readable footer. Kept rather than deleted because "how stale is this
// vault?" is a real question a reader asks, and deleting a user-facing signal
// to make a test green trades away the wrong thing.
//
// If a new nondeterministic site appears, the right move is to decide whether
// it is deliberate provenance (add it here, with a reason) or an accident
// (remove it from the exporter) — NOT to loosen the matcher.
const STABILITY_ALLOWLIST = [
  { file: MARKER_FILE, pattern: /^\s*"generated_at":/, why: 'marker provenance: when this tree was produced' },
  { file: 'README.md', pattern: /^Generated \S+ · /, why: 'README footer: human-readable staleness signal' },
];

function isAllowlisted(diff) {
  return STABILITY_ALLOWLIST.some((rule) => (
    diff.file === rule.file
    && !diff.missing
    && rule.pattern.test(diff.before || '')
    && rule.pattern.test(diff.after || '')
  ));
}

function linkTarget(raw) {
  // `[[note|Human title]]` and `[[note#Section]]` both resolve to `note`.
  return raw.split('|')[0].split('#')[0].trim();
}

// Wikilinks the EXPORTER generated — deliberately NOT every wikilink in the
// tree (ORCH ruling R-3, 2026-08-02 11:16 ET).
//
// Raw memory content contains wikilink-shaped strings that a human typed into
// a memory long before any vault existed (41 of them in the live store). The
// exporter is a read-only projection: it must not rewrite or escape a note
// body, so those strings render verbatim and resolve to nothing. They are
// USER DATA and a known cosmetic — failing this fence on them would be
// blaming the exporter for faithfully reproducing its input. Recorded as a
// BACKLOG candidate (optional content-escape flag), not a sprint defect.
//
// So the scan is section-scoped, with two independent gates so that a body
// that happens to contain a line like `## Links` cannot smuggle user content
// into the generated set: the line must be inside a generated SECTION *and*
// match a generated LINE shape.
const FULLY_GENERATED_FILE = /^(Home\.md|.*\/Home\.md|MOC - .*\.md|.*\/MOC - .*\.md)$/;
const GENERATED_SECTION = /^## (Members|Links)\s*$/;
const GENERATED_LINE = /^(\s*-\s*[→←]?\s*!?\[\[|Part of:\s*!?\[\[|\s*up:\s*|\s*-\s*!?\[\[)/;

function collectGeneratedWikilinks(dir) {
  const links = [];
  for (const rel of walkTree(dir)) {
    if (!rel.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    const lines = text.split('\n');

    // A fully generated file has no user content in it at all.
    if (FULLY_GENERATED_FILE.test(rel)) {
      for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = linkTarget(m[1]);
        if (target) links.push({ file: rel, target, where: 'generated-file' });
      }
      continue;
    }

    let inFrontmatter = lines[0] === '---';
    let inGeneratedSection = false;
    for (let i = inFrontmatter ? 1 : 0; i < lines.length; i++) {
      const line = lines[i];
      if (inFrontmatter) {
        if (line === '---') { inFrontmatter = false; continue; }
      } else if (/^#{1,6}\s/.test(line)) {
        // Any heading closes the previous section; only the known generated
        // ones open a new scanned region. `### <edge type>` subsections sit
        // inside `## Links`, so a level-3 heading does not close it.
        if (GENERATED_SECTION.test(line)) inGeneratedSection = true;
        else if (/^#{1,2}\s/.test(line)) inGeneratedSection = false;
        continue;
      }

      const isGenerated = inFrontmatter || inGeneratedSection || /^Part of:/.test(line);
      if (!isGenerated) continue;
      if (!inFrontmatter && !GENERATED_LINE.test(line)) continue;

      for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = linkTarget(m[1]);
        if (target) links.push({ file: rel, target, where: inFrontmatter ? 'frontmatter' : 'body' });
      }
    }
  }
  return links;
}

// Obsidian resolves a wikilink by NAME across the whole vault, so folder
// routing does not change resolution. Every spelling that Obsidian would
// accept counts as resolvable: full relative path, path without extension,
// basename, and basename without extension. Non-markdown files are included
// because generated dashboards embed them (`![[Memories.base#Recent]]`).
function resolvableTargets(dir) {
  const names = new Set();
  for (const rel of walkTree(dir)) {
    const base = path.posix.basename(rel);
    const ext = path.posix.extname(rel);
    names.add(rel);
    names.add(base);
    if (ext) {
      names.add(rel.slice(0, -ext.length));
      names.add(base.slice(0, -ext.length));
    }
  }
  return names;
}

async function exportInto(dir, store, argv = []) {
  return withFakeStore(store, () => vaultExport(['export', dir, ...argv]));
}

// Two exports separated far enough that the run stamp genuinely changes.
// Without this the fence could pass by accident when both runs land in the
// same millisecond, proving nothing.
async function exportTwice(dir, store) {
  const first = await exportInto(dir, store);
  assert.equal(first, 0, 'first export must succeed');
  const snap1 = snapshotTree(dir);
  await new Promise((r) => setTimeout(r, 8));
  const second = await exportInto(dir, store);
  assert.equal(second, 0, 'second export must succeed');
  const snap2 = snapshotTree(dir);
  return { snap1, snap2 };
}

// ── F1 — byte-stability, with an exhaustive difference allowlist ───────────

test('F1: two exports of an identical store differ ONLY at allowlisted timestamp sites', async () => {
  const dir = tmpdir();
  try {
    const { snap1, snap2 } = await exportTwice(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES });

    assert.deepEqual([...snap1.keys()].sort(), [...snap2.keys()].sort(),
      'the set of generated files must not change between runs of the same store');

    const diffs = diffSnapshots(snap1, snap2);

    // The fence must actually be exercising nondeterminism. If both runs
    // landed on the same stamp there is nothing to prove and a silent pass
    // would be misleading.
    assert.ok(diffs.length > 0,
      'expected the run stamp to differ between the two exports — otherwise this fence proves nothing');

    const unexplained = diffs.filter((d) => !isAllowlisted(d));
    assert.deepEqual(unexplained, [],
      'NEW nondeterminism in the export. Every difference between two exports of the same store must be '
      + 'deliberate provenance listed in STABILITY_ALLOWLIST. If you added a generated file that bakes in a '
      + 'clock reading, either derive it from the data instead, or add it to the allowlist with a reason.');

    // And the allowlist must not rot into a blanket exemption: each rule has
    // to still describe a difference that genuinely occurs.
    for (const rule of STABILITY_ALLOWLIST) {
      assert.ok(diffs.some((d) => d.file === rule.file && rule.pattern.test(d.before || '')),
        `stale allowlist entry for ${rule.file} (${rule.why}) — it no longer matches any real difference, so remove it`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1b: note bodies alone are fully deterministic — no stamp leaks into a note', async () => {
  const dir = tmpdir();
  try {
    const { snap1, snap2 } = await exportTwice(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES });
    for (const [file, before] of snap1) {
      if (!file.endsWith('.md') || file === 'README.md') continue;
      assert.equal(snap2.get(file), before,
        `${file} changed between two exports of the same store — a note must be a pure function of its memory`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── F2 — timezone invariance ───────────────────────────────────────────────

test('F2: the export is byte-identical under UTC and UTC+14 (dates must be UTC-ISO)', async () => {
  // Both runs go into the SAME directory, on purpose. The generated README
  // embeds the target path in its regeneration instructions, so exporting to
  // two different temp dirs would produce a legitimate content difference and
  // drown the signal this fence is looking for.
  const dir = tmpdir();
  const prevTz = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);
    const utc = snapshotTree(dir);

    // UTC+14. The fixtures are stamped 12:00Z precisely so that every one of
    // them lands on the NEXT calendar day here — the cheapest possible trap
    // for a date built from local-time accessors.
    process.env.TZ = 'Pacific/Kiritimati';
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);
    const plus14 = snapshotTree(dir);

    assert.deepEqual([...utc.keys()].sort(), [...plus14.keys()].sort(),
      'FILENAMES must not depend on the exporting machine\'s timezone: filenames are wikilink targets, so a '
      + 'timezone-dependent name means a laptop export and a cron export produce two different link namespaces '
      + 'for the same store. Derive dates with created_at.toISOString().slice(0, 10).');

    const unexplained = diffSnapshots(utc, plus14).filter((d) => !isAllowlisted(d));
    assert.deepEqual(unexplained, [],
      'CONTENT differs between a UTC export and a UTC+14 export of the same store — a date somewhere is being '
      + 'derived from local time. Use created_at.toISOString().slice(0, 10).');
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── F3 — stale-file sweep (R-1: manifest-swept in place, not atomic) ───────

test('F3: a naming/layout change leaves ZERO orphans from the previous run', async () => {
  const dir = tmpdir();
  try {
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);
    assert.ok(walkTree(dir).some((f) => f.endsWith('.md')), 'first export must produce notes');

    // Same memories, different content ⇒ different slugs ⇒ every note is
    // renamed. This is the shape of the P1-4 folder move and the P2-8
    // date-prefix rename: the layout churns, and regeneration is
    // manifest-swept IN PLACE (R-1), so nothing else reclaims the old files.
    const renamed = FIXTURE_MEMORIES.map((m) => ({ ...m, content: `revised — ${m.content}` }));
    assert.equal(await exportInto(dir, { memories: renamed, edges: FIXTURE_EDGES }), 0);

    // The orphan test is stated name-agnostically rather than as "everything
    // from run 1 is gone", because some generated files (Home.md, the MOCs,
    // README.md) keep a stable name across runs BY DESIGN and are supposed to
    // survive. What must never survive is a file the current run does not
    // claim: after the sweep, every file in the tree is either in the CURRENT
    // manifest or is user-owned.
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    const claimed = new Set((marker.files || []).map((f) => f.split(path.sep).join('/')));
    const orphans = walkTree(dir).filter((f) => (
      f !== MARKER_FILE && !f.startsWith('.obsidian/') && !claimed.has(f)
    ));
    assert.deepEqual(orphans, [],
      'these files survived a layout churn without being claimed by the current run. Regeneration unlinks the '
      + 'PRIOR MANIFEST and writes in place (R-1) — it is not an atomic temp-tree swap — so every generated '
      + 'file must be recorded in the manifest. Anything else becomes a permanent orphan that Obsidian still '
      + 'indexes and that stale wikilinks still resolve to.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3c: a project that disappears from the store has its generated index swept', async () => {
  const dir = tmpdir();
  try {
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);
    assert.ok(walkTree(dir).some((f) => /maestro/i.test(f)),
      'fixture precondition: the first export should produce a per-project surface for `maestro`');

    // Every `maestro` memory is archived/filtered away. Its per-project index
    // is now a page about nothing, linking to notes that no longer exist —
    // the exact stale-generated-file case the manifest sweep has to cover,
    // and one that a rename-only test would never reach.
    const withoutMaestro = FIXTURE_MEMORIES.filter((m) => m.project !== 'maestro');
    assert.equal(await exportInto(dir, { memories: withoutMaestro, edges: FIXTURE_EDGES }), 0);

    const stale = walkTree(dir).filter((f) => /maestro/i.test(f));
    assert.deepEqual(stale, [],
      'a per-project index survived the disappearance of its project. Generated index files must be '
      + 'manifest-tracked so the next run sweeps the ones it no longer regenerates.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3b: every generated file is recorded in the manifest', async () => {
  const dir = tmpdir();
  try {
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    const tracked = new Set((marker.files || []).map((f) => f.split(path.sep).join('/')));

    // The marker describes itself implicitly; `.obsidian/` is user-owned
    // configuration and is deliberately NOT swept (see F5).
    const generated = walkTree(dir).filter((f) => f !== MARKER_FILE && !f.startsWith('.obsidian/'));
    const untracked = generated.filter((f) => !tracked.has(f));
    assert.deepEqual(untracked, [],
      'these generated files are absent from the manifest, so the next run will not sweep them: '
      + 'after a rename or a layout change they become permanent orphans.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── F4 — dangling wikilinks ────────────────────────────────────────────────

test('F4: every EXPORTER-GENERATED wikilink resolves to a file that exists', async () => {
  const dir = tmpdir();
  try {
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);

    const targets = resolvableTargets(dir);
    const broken = collectGeneratedWikilinks(dir).filter((l) => !targets.has(l.target));
    assert.deepEqual(broken, [],
      'a [[wikilink]] with no file behind it renders in Obsidian as a broken link, which reads as data '
      + 'corruption rather than as a deliberate scope boundary. An out-of-scope reference must render as '
      + 'plain text instead. (Scope per ORCH R-3: exporter-generated surfaces only — wikilink-shaped strings '
      + 'inside raw memory content are user data and are deliberately not checked here.)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F4b: a member outside the export set never becomes a wikilink', async () => {
  const dir = tmpdir();
  try {
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);

    // SUMMARY_DANGLING lists a member id that is not in the export set. It may
    // be omitted or rendered as plain text — but it must never appear as a
    // link, and its raw uuid must never masquerade as a note name.
    const needle = DANGLING_MEMBER_ID.slice(0, 8);
    const linked = collectGeneratedWikilinks(dir).filter((l) => l.target.includes(needle));
    assert.deepEqual(linked, [],
      'the out-of-scope member id was rendered as a wikilink; it must be plain text or omitted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F4c: the generated-surface scanner does not sweep up wikilinks from memory content', () => {
  // Guards the R-3 boundary itself. A scanner that quietly widened to whole
  // files would start failing on user data and would be "fixed" by loosening
  // the assertion — so the boundary gets its own test rather than living only
  // in a comment.
  const dir = tmpdir();
  try {
    const withLinkInBody = {
      ...MEM_A,
      id: '99999999-1111-2222-3333-444444444444',
      content: 'Per [[some-note-that-never-existed]] the grant must be central. See also [[another-ghost]].',
    };
    return withFakeStore({ memories: [withLinkInBody], edges: [] }, async () => {
      assert.equal(await vaultExport(['export', dir]), 0);
      const found = collectGeneratedWikilinks(dir).map((l) => l.target);
      assert.ok(!found.includes('some-note-that-never-existed'),
        'a wikilink typed by a human into a memory body was counted as exporter-generated');
      assert.ok(!found.includes('another-ghost'));
    }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
});

// ── F5 — .obsidian/graph.json is never clobbered (R-1 consequence) ─────────

test('F5: an existing .obsidian/graph.json survives a re-export byte-untouched and un-unlinked', async () => {
  const dir = tmpdir();
  try {
    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);

    // Stand in for a user who has tuned their graph view by hand. The
    // exporter's contract is write-if-missing: it may create this file, but
    // once it exists it belongs to the user.
    const obsidianDir = path.join(dir, '.obsidian');
    fs.mkdirSync(obsidianDir, { recursive: true });
    const graphPath = path.join(obsidianDir, 'graph.json');
    const userTuning = JSON.stringify({ collapse: false, search: 'hand-tuned by the user', scale: 0.42 }, null, 2);
    fs.writeFileSync(graphPath, userTuning, 'utf8');

    assert.equal(await exportInto(dir, { memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }), 0);

    assert.ok(fs.existsSync(graphPath),
      '.obsidian/graph.json was UNLINKED by a re-export. It must be excluded from the manifest sweep, or the '
      + 'run after the exporter first writes it destroys the user\'s tuning.');
    assert.equal(fs.readFileSync(graphPath, 'utf8'), userTuning,
      '.obsidian/graph.json was overwritten. The contract is write-if-missing: never clobber user tuning.');

    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
    const tracked = (marker.files || []).map((f) => f.split(path.sep).join('/'));
    assert.ok(!tracked.includes('.obsidian/graph.json'),
      'graph.json is recorded in the manifest, so the next run will unlink it — exclude it from the manifest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5b: a fresh export DOES write .obsidian/graph.json when it is absent', () => {
  // The other half of write-if-missing. Without this, F5 would pass trivially
  // on an exporter that never wrote graph.json at all — a green test proving
  // only that a file nobody creates is never overwritten.
  const dir = tmpdir();
  return withFakeStore({ memories: FIXTURE_MEMORIES, edges: FIXTURE_EDGES }, async () => {
    assert.equal(await vaultExport(['export', dir]), 0);
    const graphPath = path.join(dir, '.obsidian', 'graph.json');
    assert.ok(fs.existsSync(graphPath),
      'a fresh export must write graph defaults, or the vault opens on an unreadable hairball');
    const parsed = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    assert.equal(parsed.search, '-path:snapshots');
    assert.equal(parsed.showOrphans, false);
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});

// ── harness self-check ─────────────────────────────────────────────────────
//
// The fences above are only as trustworthy as the seam they depend on. If a
// refactor replaces `docSync.requirePg()` with a direct `require('pg')`, every
// fence in this file would still PASS while testing nothing at all — the
// worst possible failure mode for a test suite. This asserts the seam is live.

test('harness: the fake-pg seam is actually intercepting, not silently falling through', async () => {
  const dir = tmpdir();
  try {
    const fake = await withFakeStore({ memories: [MEM_A], edges: [] }, async (f) => {
      assert.equal(await vaultExport(['export', dir]), 0);
      return f;
    });
    assert.ok(fake.queries.length >= 3,
      'the exporter did not issue its queries through the fake client — the docSync.requirePg seam is no longer '
      + 'live, and every fence in this file is now vacuous. Restore the seam or rewrite the harness.');
    assert.ok(fake.queries.some((q) => /from memory_items/i.test(q)), 'expected the memories query');
    assert.ok(fake.queries.some((q) => /from memory_relationships/i.test(q)), 'expected the edges query');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
