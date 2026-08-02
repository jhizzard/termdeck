#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const repoRoot = path.resolve(__dirname, '..', '..');
const vaultExport = require(path.join(repoRoot, 'packages', 'cli', 'src', 'vault-export.js'));
const docSync = require(path.join(repoRoot, 'packages', 'server', 'src', 'doctrine-sync.js'));

const DAILY_DRIVER_VAULT = '/Volumes/Crucial X6/mnestra-vault';

function parseArgs(argv) {
  const opts = {
    keep: false,
    project: null,
    limit: null,
    minWeight: null,
    includePrivacy: null,
    dbSamples: 6,
    skipByteStability: false,
    skipGraphClobber: false,
    skipDbSamples: false,
    strictAllWikilinks: false,
    fixture: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--keep') opts.keep = true;
    else if (arg === '--project') opts.project = next();
    else if (arg === '--limit') opts.limit = next();
    else if (arg === '--min-weight') opts.minWeight = next();
    else if (arg === '--include-privacy') opts.includePrivacy = next();
    else if (arg === '--db-samples') opts.dbSamples = Number(next());
    else if (arg === '--skip-byte-stability') opts.skipByteStability = true;
    else if (arg === '--skip-graph-clobber') opts.skipGraphClobber = true;
    else if (arg === '--skip-db-samples') opts.skipDbSamples = true;
    else if (arg === '--strict-all-wikilinks') opts.strictAllWikilinks = true;
    else if (arg === '--fixture') opts.fixture = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node docs/sprint-69-vault-readability/t4-vault-acceptance-harness.js [flags]

Fresh-exports the live read-only store into disposable temp dirs and validates
Sprint 69 vault-readability acceptance structurally.

Flags:
  --project <name>             Pass through to termdeck vault export.
  --limit <n>                  Pass through to termdeck vault export.
  --min-weight <n>             Pass through to termdeck vault export.
  --include-privacy <a,b>      Pass through to termdeck vault export.
  --db-samples <n>             Number of live consolidation hubs to sample.
  --skip-db-samples            Do not run independent DB reverse-map checks.
  --skip-byte-stability        Do not diff two independent fresh exports.
  --skip-graph-clobber         Do not test graph.json write-if-missing.
  --strict-all-wikilinks       Also fail raw memory/documentation wikilinks.
  --fixture                    Use a fake pg client instead of DATABASE_URL.
  --keep                       Preserve temp export dirs for inspection.
`);
}

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termdeck-s69-${label}-`));
  assertNotDailyDriver(dir);
  return dir;
}

function assertNotDailyDriver(dir) {
  const resolved = path.resolve(dir);
  if (resolved === DAILY_DRIVER_VAULT || resolved.startsWith(`${DAILY_DRIVER_VAULT}${path.sep}`)) {
    throw new Error(`refusing to write to daily-driver vault: ${resolved}`);
  }
}

async function runExport(dir, opts) {
  assertNotDailyDriver(dir);
  const args = ['export', dir];
  if (opts.project) args.push('--project', opts.project);
  if (opts.limit) args.push('--limit', String(opts.limit));
  if (opts.minWeight !== null && opts.minWeight !== undefined) args.push('--min-weight', String(opts.minWeight));
  if (opts.includePrivacy) args.push('--include-privacy', opts.includePrivacy);
  const code = await vaultExport(args);
  if (code !== 0) throw new Error(`vault export exited ${code} for ${dir}`);
}

function fixtureUuid(n) {
  const s = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${s}`;
}

function fixtureStore() {
  const memberA = {
    id: fixtureUuid(1),
    content: 'Overlapping member belongs to two generated communities.',
    source_type: 'decision',
    category: 'architecture',
    project: 'TermDeck',
    metadata: {},
    privacy_tags: [],
    source_agent: 'codex',
    created_at: new Date('2026-08-01T23:30:00.000Z'),
  };
  const session = {
    id: fixtureUuid(2),
    content: 'Session summary should stay under notes/<project> while gaining a UTC date prefix.',
    source_type: 'session_summary',
    category: null,
    project: 'TermDeck',
    metadata: {},
    privacy_tags: [],
    source_agent: 'claude',
    created_at: new Date('2026-08-02T00:30:00.000Z'),
  };
  const chunk = {
    id: fixtureUuid(3),
    content: 'Document chunk should route into snapshots with a UTC date prefix.',
    source_type: 'document_chunk',
    category: null,
    project: 'TermDeck',
    metadata: {},
    privacy_tags: [],
    source_agent: null,
    created_at: new Date('2026-08-02T01:30:00.000Z'),
  };
  const pvbLower = {
    id: fixtureUuid(4),
    content: 'Lowercase project row.',
    source_type: 'fact',
    category: null,
    project: 'pvb',
    metadata: {},
    privacy_tags: [],
    source_agent: null,
    created_at: new Date('2026-08-02T02:30:00.000Z'),
  };
  const pvbUpper = {
    id: fixtureUuid(5),
    content: 'Uppercase project row should merge into the same lowercased MOC.',
    source_type: 'fact',
    category: null,
    project: 'PVB',
    metadata: {},
    privacy_tags: [],
    source_agent: null,
    created_at: new Date('2026-08-02T03:30:00.000Z'),
  };
  const hubA = {
    id: fixtureUuid(10),
    content: 'The first generated community summarizes overlapping and snapshot material.',
    source_type: 'consolidation_summary',
    category: 'consolidation',
    project: 'TermDeck',
    metadata: {
      consolidation: {
        kind: 'community_summary',
        version: 1,
        member_ids: [memberA.id, chunk.id, fixtureUuid(999)],
        member_count: 3,
        generated_at: '2026-08-02T04:00:00.000Z',
        generator: 'fixture/consolidation',
      },
    },
    privacy_tags: [],
    source_agent: null,
    created_at: new Date('2026-08-02T04:00:00.000Z'),
  };
  const hubB = {
    id: fixtureUuid(11),
    content: 'The second generated community shares one member with the first.',
    source_type: 'consolidation_summary',
    category: 'consolidation',
    project: 'termdeck',
    metadata: {
      consolidation: {
        kind: 'community_summary',
        version: 1,
        member_ids: [memberA.id, session.id],
        member_count: 2,
        generated_at: '2026-08-02T05:00:00.000Z',
        generator: 'fixture/consolidation',
      },
    },
    privacy_tags: [],
    source_agent: null,
    created_at: new Date('2026-08-02T05:00:00.000Z'),
  };

  const memories = [memberA, session, chunk, pvbLower, pvbUpper, hubA, hubB]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const relationships = [
    {
      source_id: memberA.id,
      target_id: session.id,
      relationship_type: 'relates_to',
      weight: 0.9,
      inferred_by: 'fixture',
      valid_at: new Date('2026-08-02T06:00:00.000Z'),
      invalid_at: null,
    },
  ];
  return { memories, relationships };
}

async function withFakePg(fn) {
  const store = fixtureStore();
  const originalRequirePg = docSync.requirePg;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  class FakeClient {
    constructor() {}
    async connect() {}
    async end() {}
    async query(sql) {
      if (/information_schema\.columns/.test(sql)) {
        return { rows: [{ column_name: 'valid_at' }, { column_name: 'invalid_at' }] };
      }
      if (/count\(\*\)::int as n from memory_items/.test(sql)) {
        return { rows: [{ n: 0 }] };
      }
      if (/from memory_relationships/.test(sql)) {
        return { rows: store.relationships };
      }
      if (/from memory_items/.test(sql) && /select id, content/.test(sql)) {
        return { rows: store.memories };
      }
      throw new Error(`fixture pg did not recognize query: ${sql.slice(0, 120)}`);
    }
  }

  docSync.requirePg = () => ({ Client: FakeClient });
  process.env.DATABASE_URL = 'postgres://fixture';
  try {
    return await fn(store);
  } finally {
    docSync.requirePg = originalRequirePg;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of listFiles(src)) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function readUtf8(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  const raw = text.slice(4, end);
  const parsed = YAML.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function rawFrontmatter(text) {
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  if (end === -1) return '';
  return text.slice(4, end);
}

function stripExt(rel) {
  return rel.replace(/\.(md|base)$/i, '');
}

function fileTitle(rel) {
  return stripExt(path.posix.basename(rel));
}

function buildIndex(root) {
  const files = listFiles(root);
  const relSet = new Set(files);
  const relStemSet = new Set(files.map(stripExt));
  const titleToRel = new Map();
  const titleWithExtToRel = new Map();
  const notes = [];
  const idToNote = new Map();

  for (const rel of files) {
    titleToRel.set(fileTitle(rel), rel);
    titleWithExtToRel.set(path.posix.basename(rel), rel);
    if (!rel.endsWith('.md')) continue;
    const text = readUtf8(root, rel);
    const frontmatter = parseFrontmatter(text);
    const note = { rel, title: fileTitle(rel), text, frontmatter, rawFrontmatter: rawFrontmatter(text) };
    notes.push(note);
    if (frontmatter.id) idToNote.set(String(frontmatter.id), note);
  }

  return { root, files, relSet, relStemSet, titleToRel, titleWithExtToRel, notes, idToNote };
}

function extractWikilinks(text) {
  const links = [];
  const re = /!?\[\[([^\]\n]+)\]\]/g;
  let match;
  while ((match = re.exec(text))) {
    const body = match[1].trim();
    const [targetPart, alias] = body.split('|');
    const target = targetPart.split('#')[0].split('^')[0].trim();
    if (!target) continue;
    links.push({ raw: match[0], target, piped: alias !== undefined });
  }
  return links;
}

function resolveWikilink(target, index) {
  const normalized = target.replace(/\\/g, '/').replace(/^\//, '');
  const candidates = [
    normalized,
    `${normalized}.md`,
    `${normalized}.base`,
    stripExt(normalized),
  ];
  for (const candidate of candidates) {
    if (index.relSet.has(candidate)) return candidate;
    if (index.relStemSet.has(stripExt(candidate))) return `${stripExt(candidate)}.md`;
  }
  if (!normalized.includes('/')) {
    if (index.titleToRel.has(stripExt(normalized))) return index.titleToRel.get(stripExt(normalized));
    if (index.titleWithExtToRel.has(normalized)) return index.titleWithExtToRel.get(normalized);
  }
  return null;
}

function getSection(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function upFieldHasHub(up, hubTitle) {
  const needle = `[[${hubTitle}]]`;
  if (Array.isArray(up)) return up.some((v) => upFieldHasHub(v, hubTitle));
  if (up && typeof up === 'object') return JSON.stringify(up).includes(needle);
  return String(up || '').includes(needle);
}

function checkLinks(label, text, index, failures) {
  for (const link of extractWikilinks(text)) {
    if (!resolveWikilink(link.target, index)) failures.push(`${label}: dangling wikilink ${link.raw}`);
  }
}

function generatedLinkSurface(note) {
  const chunks = [];
  const basename = path.posix.basename(note.rel);
  if (basename === 'Home.md' || basename.startsWith('MOC - ')) chunks.push(note.text);
  for (const heading of ['## Members', '## Links']) {
    const section = getSection(note.text, heading);
    if (section) chunks.push(section);
  }
  for (const line of note.text.split('\n')) {
    if (line.startsWith('Part of:')) chunks.push(line);
  }
  const up = note.frontmatter.up;
  if (Array.isArray(up)) chunks.push(up.join('\n'));
  else if (up) chunks.push(String(up));
  return chunks.join('\n');
}

function validateDanglingLinks(index, failures, opts) {
  if (opts.strictAllWikilinks) {
    for (const note of index.notes) checkLinks(note.rel, note.text, index, failures);
    return;
  }

  for (const note of index.notes) {
    const surface = generatedLinkSurface(note);
    if (surface) checkLinks(note.rel, surface, index, failures);
  }
}

function validateHomeAndMocs(index, failures) {
  if (!index.relSet.has('Home.md')) failures.push('missing root Home.md');
  const mocs = index.files.filter((rel) => path.posix.basename(rel).startsWith('MOC - ') && rel.endsWith('.md'));
  if (mocs.length === 0) failures.push('missing per-project MOC files');
}

function validateMocContracts(index, failures) {
  const mocs = index.files.filter((rel) => path.posix.basename(rel).startsWith('MOC - ') && rel.endsWith('.md'));
  const seen = new Map();
  for (const rel of mocs) {
    const stem = fileTitle(rel);
    const projectSlug = stem.replace(/^MOC - /, '');
    if (/[A-Z]/.test(projectSlug)) failures.push(`${rel}: MOC project slug must be lowercased per R-2`);
    if (/\s+\(\d+\)$/.test(projectSlug)) failures.push(`${rel}: MOC case/collision suffix violates R-2 merge-on-lowercase contract`);
    const folded = projectSlug.replace(/\s+\(\d+\)$/, '').toLowerCase();
    const prior = seen.get(folded);
    if (prior) failures.push(`${rel}: duplicate lowercased MOC slug also emitted as ${prior}`);
    else seen.set(folded, rel);
  }
}

function validateFrontmatterContracts(index, failures) {
  for (const note of index.notes) {
    if (note.frontmatter.created_at && note.frontmatter.id) {
      const match = note.rawFrontmatter.match(/^date:\s+(.+)$/m);
      if (!match) failures.push(`${note.rel}: missing date frontmatter`);
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(match[1])) {
        failures.push(`${note.rel}: date must be unquoted UTC YYYY-MM-DD, got ${match[1]}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(note.frontmatter, 'up') && !Array.isArray(note.frontmatter.up)) {
      failures.push(`${note.rel}: up must be a YAML list even at length 1`);
    }
  }
}

function validateBases(index, failures) {
  const bases = index.files.filter((rel) => path.posix.basename(rel) === 'Memories.base');
  if (bases.length !== 1) {
    failures.push(`expected exactly one Memories.base, found ${bases.length}`);
    return;
  }
  let parsed;
  try {
    parsed = YAML.parse(readUtf8(index.root, bases[0]));
  } catch (err) {
    failures.push(`Memories.base is not valid YAML: ${err.message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failures.push('Memories.base must parse to a YAML mapping');
    return;
  }
  if (!Array.isArray(parsed.views) || parsed.views.length === 0) {
    failures.push('Memories.base must define a non-empty views list');
    return;
  }
  parsed.views.forEach((view, i) => {
    if (!view || typeof view !== 'object' || Array.isArray(view)) failures.push(`Memories.base views[${i}] must be a mapping`);
    else {
      if (typeof view.type !== 'string' || view.type.length === 0) failures.push(`Memories.base views[${i}] missing string type`);
      if (typeof view.name !== 'string' || view.name.length === 0) failures.push(`Memories.base views[${i}] missing string name`);
    }
  });
}

function validateGraphJson(index, failures) {
  const graphRel = '.obsidian/graph.json';
  if (!index.relSet.has(graphRel)) {
    failures.push('missing .obsidian/graph.json');
    return;
  }
  try {
    JSON.parse(readUtf8(index.root, graphRel));
  } catch (err) {
    failures.push(`.obsidian/graph.json is not valid JSON: ${err.message}`);
  }
}

function validateConsolidations(index, failures) {
  const hubs = index.notes.filter((note) => note.frontmatter.source_type === 'consolidation_summary');
  if (hubs.length === 0) failures.push('no consolidation_summary notes found in export');

  for (const hub of hubs) {
    if (hub.frontmatter.hub !== true) failures.push(`${hub.rel}: missing hub: true`);
    const section = getSection(hub.text, '## Members');
    if (!section) {
      failures.push(`${hub.rel}: missing ## Members section`);
      continue;
    }
    const memberLinks = extractMemberWikilinks(section);
    if (memberLinks.length === 0) failures.push(`${hub.rel}: ## Members has no wikilinks`);
    if (!memberLinks.some((link) => link.piped)) failures.push(`${hub.rel}: ## Members lacks piped wikilinks`);

    for (const link of memberLinks) {
      const rel = resolveWikilink(link.target, index);
      if (!rel) {
        failures.push(`${hub.rel}: member link ${link.raw} does not resolve`);
        continue;
      }
      const member = index.notes.find((note) => note.rel === rel);
      if (!member) {
        failures.push(`${hub.rel}: member link ${link.raw} resolves to non-note ${rel}`);
        continue;
      }
      if (!upFieldHasHub(member.frontmatter.up, hub.title)) {
        failures.push(`${member.rel}: up field does not point back to hub ${hub.title}`);
      }
    }
  }
}

function compareSets(actual, expected, label, failures) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((v, i) => v !== e[i])) {
    failures.push(`${label}: expected [${e.join(', ')}], got [${a.join(', ')}]`);
  }
}

function validateDbSamples(index, samples, failures) {
  for (const sample of samples) {
    const hub = index.idToNote.get(sample.hub_id);
    if (!hub) {
      failures.push(`DB sample hub ${sample.hub_id}: hub note missing from export`);
      continue;
    }
    const section = getSection(hub.text, '## Members');
    if (!section) {
      failures.push(`DB sample hub ${sample.hub_id}: missing ## Members`);
      continue;
    }
    const renderedIds = new Set();
    for (const link of extractMemberWikilinks(section)) {
      const rel = resolveWikilink(link.target, index);
      const note = rel ? index.notes.find((n) => n.rel === rel) : null;
      if (note && note.frontmatter.id) renderedIds.add(String(note.frontmatter.id));
    }
    const expectedIds = new Set(sample.member_ids.filter((id) => index.idToNote.has(id)));
    compareSets(renderedIds, expectedIds, `DB sample hub ${sample.hub_id} rendered members`, failures);

    for (const id of expectedIds) {
      const member = index.idToNote.get(id);
      if (!upFieldHasHub(member.frontmatter.up, hub.title)) {
        failures.push(`DB sample member ${id}: up field missing hub ${sample.hub_id}`);
      }
    }
  }
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const secretsPath = path.join(os.homedir(), '.termdeck', 'secrets.env');
  if (!fs.existsSync(secretsPath)) throw new Error('DATABASE_URL not set and ~/.termdeck/secrets.env missing');
  const dotenv = require(path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'dotenv-io.js'));
  const secrets = dotenv.readSecrets(secretsPath);
  if (!secrets.DATABASE_URL) throw new Error('DATABASE_URL not found in ~/.termdeck/secrets.env');
  return secrets.DATABASE_URL;
}

async function fetchDbSamples(limit, opts) {
  const pg = docSync.requirePg();
  if (!pg) throw new Error('pg module is not installed');
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    const params = [];
    let where = `source_type = 'consolidation_summary'
      and is_active
      and not archived
      and superseded_by is null
      and cardinality(privacy_tags) = 0
      and jsonb_typeof(metadata->'consolidation'->'member_ids') = 'array'
      and jsonb_array_length(metadata->'consolidation'->'member_ids') > 0`;
    if (opts.project) {
      params.push(opts.project);
      where += ` and project = $${params.length}`;
    }
    params.push(Math.max(1, Number(limit) || 1));
    const res = await client.query(
      `select id::text as hub_id,
              project,
              metadata->'consolidation'->'member_ids' as member_ids
         from public.memory_items
        where ${where}
        order by created_at desc
        limit $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      hub_id: row.hub_id,
      project: row.project,
      member_ids: Array.isArray(row.member_ids) ? row.member_ids.map(String) : [],
    }));
  } finally {
    await client.end();
  }
}

function fixtureSamples(store) {
  return store.memories
    .filter((memory) => memory.source_type === 'consolidation_summary')
    .map((memory) => ({
      hub_id: memory.id,
      project: memory.project,
      member_ids: memory.metadata.consolidation.member_ids.map(String),
    }));
}

async function validateGraphClobber(dir, opts, failures) {
  const graphPath = path.join(dir, '.obsidian', 'graph.json');
  if (!fs.existsSync(graphPath)) return;
  const sentinel = JSON.stringify({ t4_sentinel: true, keep: 'do-not-overwrite' }, null, 2) + '\n';
  fs.writeFileSync(graphPath, sentinel, 'utf8');
  await runExport(dir, opts);
  const after = fs.readFileSync(graphPath, 'utf8');
  if (after !== sentinel) failures.push('.obsidian/graph.json was overwritten on second export');
}

function normalizedForByteCompare(rel, bytes) {
  if (rel === '.termdeck-vault.json') {
    const parsed = JSON.parse(bytes.toString('utf8'));
    parsed.generated_at = '<generated_at>';
    return Buffer.from(JSON.stringify(parsed, null, 2) + '\n');
  }
  if (rel === 'README.md') {
    return Buffer.from(bytes.toString('utf8').replace(/^Generated .* · ([0-9]+ notes · [0-9]+ edges.*)$/m, 'Generated <generated_at> · $1'));
  }
  return bytes;
}

function extractMemberWikilinks(section) {
  return section
    .split('\n')
    .filter((line) => /^\s*-\s+\[\[/.test(line))
    .flatMap((line) => extractWikilinks(line));
}

function compareTrees(a, b) {
  const aFiles = listFiles(a);
  const bFiles = listFiles(b);
  const deltas = [];
  const all = new Set([...aFiles, ...bFiles]);
  for (const rel of [...all].sort()) {
    const inA = aFiles.includes(rel);
    const inB = bFiles.includes(rel);
    if (!inA || !inB) {
      deltas.push(`${rel}: ${inA ? 'missing in second export' : 'missing in first export'}`);
      continue;
    }
    let aBytes;
    let bBytes;
    try {
      aBytes = normalizedForByteCompare(rel, fs.readFileSync(path.join(a, rel)));
      bBytes = normalizedForByteCompare(rel, fs.readFileSync(path.join(b, rel)));
    } catch (err) {
      deltas.push(`${rel}: allowlist normalization failed: ${err.message}`);
      continue;
    }
    if (!aBytes.equals(bBytes)) deltas.push(`${rel}: bytes differ`);
  }
  return deltas;
}

async function validateByteStability(opts, failures, tempDirs) {
  const dir = makeTempDir('byte');
  tempDirs.push(dir);
  await runExport(dir, opts);
  const before = makeTempDir('byte-before');
  tempDirs.push(before);
  copyTree(dir, before);
  await new Promise((resolve) => setTimeout(resolve, 8));
  await runExport(dir, opts);
  for (const delta of compareTrees(before, dir)) failures.push(`byte-stability: ${delta}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const run = async (store) => {
  const tempDirs = [];
  const failures = [];

  const mainDir = makeTempDir('main');
  tempDirs.push(mainDir);

  try {
    await runExport(mainDir, opts);
    const index = buildIndex(mainDir);

    validateDanglingLinks(index, failures, opts);
    validateFrontmatterContracts(index, failures);
    validateHomeAndMocs(index, failures);
    validateMocContracts(index, failures);
    validateBases(index, failures);
    validateGraphJson(index, failures);
    validateConsolidations(index, failures);

    if (!opts.skipDbSamples) {
      const samples = opts.fixture ? fixtureSamples(store) : await fetchDbSamples(opts.dbSamples, opts);
      if (samples.length === 0) failures.push('DB reverse-map sample returned zero consolidation hubs');
      validateDbSamples(index, samples, failures);
    }

    if (!opts.skipGraphClobber) await validateGraphClobber(mainDir, opts, failures);
    if (!opts.skipByteStability) await validateByteStability(opts, failures, tempDirs);

    if (failures.length > 0) {
      console.error(`T4 vault acceptance: FAIL (${failures.length})`);
      for (const failure of failures) console.error(`- ${failure}`);
      console.error(`main export dir: ${mainDir}`);
      process.exitCode = 1;
      return;
    }

    console.log('T4 vault acceptance: PASS');
    console.log(`main export dir: ${mainDir}`);
  } finally {
    if (!opts.keep) {
      for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  };

  if (opts.fixture) await withFakePg(run);
  else await run(null);
}

main().catch((err) => {
  console.error(`T4 vault acceptance: ERROR ${err.message}`);
  process.exitCode = 2;
});
