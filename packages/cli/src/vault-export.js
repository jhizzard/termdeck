// `termdeck vault export <dir>` — Sprint 83 T3.
//
// Generates an Obsidian vault from the memory graph: one markdown note per
// memory, wikilinks rendered from typed LIVE edges, edge type + temporal
// validity + provenance in frontmatter.
//
// ── READ-ONLY PROJECTION. THIS IS THE WHOLE DESIGN. ────────────────────────
//
// The vault is a VIEW of the memory store, never a second copy of it. There is
// no import path, no sync, no write-back, and none is planned — that is a
// design commitment, not a missing feature. The generated vault's own README
// says so, so the person browsing it six months from now knows their edits are
// disposable before they make any.
//
// Why so emphatic: the moment a projection becomes writable it becomes a
// second source of truth, and then every question about a memory has two
// possible answers that silently disagree. Regenerating is cheap; reconciling
// two divergent stores is not.
//
// ── DESTRUCTIVE-BY-NATURE, GUARDED ACCORDINGLY ─────────────────────────────
//
// "Regenerate on demand" means deleting the notes from the previous run. A
// user who points this at their real Obsidian vault would lose work, so the
// exporter REFUSES to write into a directory it did not itself create unless
// that directory carries its marker file (`.termdeck-vault.json`). `--force`
// exists, but it is never the default and the refusal names the directory.
//
// Module contract: module.exports = async function vaultExport(argv): Promise<exitCode>
//   0 = success, 1 = usage/validation error or refused action, 2 = infra
//   failure (no DATABASE_URL, pg unavailable, connection refused).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const docSync = require(path.join(__dirname, '..', '..', 'server', 'src', 'doctrine-sync.js'));

const MARKER_FILE = '.termdeck-vault.json';
const MARKER_VERSION = 1;

const HELP = `
termdeck vault export <dir> [flags]

  Generates a READ-ONLY Obsidian vault from the Mnestra memory graph.
  One note per memory; wikilinks from typed, live relationship edges.

  --project <name>        Only memories in this project (default: all)
  --limit <n>             Cap the number of memories exported (default: no cap)
  --min-weight <0..1>     Only render edges at or above this weight (default: 0)
  --include-privacy <t,t> Include memories carrying these privacy tags
                          (default: privacy-tagged memories are EXCLUDED)
  --force                 Write into a non-empty directory this exporter did
                          not create. Deletes previously generated notes.
  --dry-run               Report what would be written; write nothing.

Requires DATABASE_URL (env or ~/.termdeck/secrets.env).

The vault is a projection, not a source of truth: there is no import path.
Re-run this command to refresh it. Nightly, if you want it fresh (NOT
installed by this command — add it yourself if you want it):
  15 4 * * *  termdeck vault export ~/mnestra-vault >/dev/null 2>&1
`;

// Typed edge vocabulary rendered as link sections, in the order they appear in
// a note. Anything outside this list still renders, under "related" — the
// vocabulary is inventory-driven and grows, and a note that silently omitted
// an unfamiliar edge type would misrepresent the graph.
const EDGE_SECTION_ORDER = [
  'fixed_by', 'caused_by', 'same_pattern_as', 'supersedes', 'contradicts',
  'elaborates', 'blocks', 'inspired_by', 'cross_project_link', 'relates_to',
];

// ── helpers ────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[arg.slice(2)] = argv[++i];
      else flags[arg.slice(2)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function resolveSecrets() {
  let dotenv;
  try { dotenv = require(path.join(__dirname, '..', '..', 'server', 'src', 'setup', 'dotenv-io')); }
  catch (_e) { dotenv = null; }
  const secretsPath = path.join(os.homedir(), '.termdeck', 'secrets.env');
  const fromFile = (dotenv && fs.existsSync(secretsPath)) ? dotenv.readSecrets(secretsPath) : {};
  return { DATABASE_URL: process.env.DATABASE_URL || fromFile.DATABASE_URL };
}

async function connectPg(databaseUrl) {
  const pg = docSync.requirePg();
  if (!pg) throw new Error('the "pg" module is not installed');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

// Deterministic note name: a readable slug from the content plus a uuid
// prefix. Deterministic matters because wikilinks are BY NAME — if a note's
// filename changed between runs, every inbound link in every other note would
// break, and the vault would look progressively more corrupted with each
// regeneration. Derived only from (content, id), never from ordering, time, or
// anything about the run.
function noteName(memory) {
  const slug = String(memory.content || '')
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'memory';
  return `${slug}-${String(memory.id).slice(0, 8)}`;
}

function yamlString(value) {
  if (value === null || value === undefined) return '""';
  const s = String(value);
  // Always quote and escape — memory content is arbitrary text and a stray
  // colon, hash or leading dash silently produces invalid or (worse)
  // valid-but-wrong YAML that Obsidian renders as a broken property.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

function yamlList(values) {
  if (!Array.isArray(values) || values.length === 0) return '[]';
  return `[${values.map((v) => yamlString(v)).join(', ')}]`;
}

// One note. Frontmatter carries identity + provenance + the full edge list
// (type, direction, target, validity, who inferred it, weight); the body
// carries the content and the wikilinks.
function renderNote(memory, edges, nameOf) {
  const meta = memory.metadata && typeof memory.metadata === 'object' ? memory.metadata : {};
  const consolidation = meta.consolidation || null;
  const signature = meta.problem_signature || null;

  const lines = [];
  lines.push('---');
  lines.push(`id: ${yamlString(memory.id)}`);
  lines.push(`project: ${yamlString(memory.project)}`);
  lines.push(`source_type: ${yamlString(memory.source_type)}`);
  if (memory.category) lines.push(`category: ${yamlString(memory.category)}`);
  lines.push(`created_at: ${yamlString(memory.created_at && memory.created_at.toISOString ? memory.created_at.toISOString() : memory.created_at)}`);
  if (memory.source_agent) lines.push(`source_agent: ${yamlString(memory.source_agent)}`);
  if (Array.isArray(memory.privacy_tags) && memory.privacy_tags.length > 0) {
    lines.push(`privacy_tags: ${yamlList(memory.privacy_tags)}`);
  }

  // Provenance for generated content. A consolidation summary must be
  // identifiable AS a generated artifact from the note alone — someone reading
  // the vault has no other way to tell it apart from a memory a human wrote.
  if (consolidation) {
    lines.push('generated: true');
    lines.push(`generated_kind: ${yamlString(consolidation.kind)}`);
    lines.push(`generated_by: ${yamlString(consolidation.generator)}`);
    lines.push(`generated_at: ${yamlString(consolidation.generated_at)}`);
    lines.push(`community_member_count: ${Number(consolidation.member_count) || 0}`);
  }
  if (signature && signature.class) {
    lines.push(`problem_class: ${yamlString(signature.class)}`);
    if (signature.symptom_hash) lines.push(`symptom_hash: ${yamlString(signature.symptom_hash)}`);
  }

  if (edges.length > 0) {
    lines.push('edges:');
    for (const e of edges) {
      lines.push(`  - type: ${yamlString(e.relationship_type)}`);
      lines.push(`    direction: ${yamlString(e.direction)}`);
      lines.push(`    target: ${yamlString(nameOf.get(e.other_id) || e.other_id)}`);
      lines.push(`    weight: ${e.weight === null || e.weight === undefined ? 'null' : Number(e.weight)}`);
      lines.push(`    valid_at: ${e.valid_at ? yamlString(e.valid_at.toISOString ? e.valid_at.toISOString() : e.valid_at) : 'null'}`);
      lines.push(`    invalid_at: ${e.invalid_at ? yamlString(e.invalid_at.toISOString ? e.invalid_at.toISOString() : e.invalid_at) : 'null'}`);
      lines.push(`    inferred_by: ${e.inferred_by ? yamlString(e.inferred_by) : 'null'}`);
    }
  }
  lines.push('---');
  lines.push('');

  if (consolidation) {
    lines.push('> [!abstract] Generated summary');
    lines.push(`> This note was written by \`${consolidation.generator}\` on ${consolidation.generated_at}, synthesizing ${consolidation.member_count} connected memories. It is a derived artifact, not something anyone recorded directly.`);
    lines.push('');
  }

  lines.push(String(memory.content || '').trim());
  lines.push('');

  if (edges.length > 0) {
    lines.push('## Links');
    lines.push('');
    const grouped = new Map();
    for (const e of edges) {
      const bucket = grouped.get(e.relationship_type) || [];
      bucket.push(e);
      grouped.set(e.relationship_type, bucket);
    }
    const types = [...grouped.keys()].sort((a, b) => {
      const ia = EDGE_SECTION_ORDER.indexOf(a);
      const ib = EDGE_SECTION_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const type of types) {
      lines.push(`### ${type}`);
      for (const e of grouped.get(type)) {
        const target = nameOf.get(e.other_id);
        // A target outside the export set (filtered by project/limit/privacy)
        // is rendered as plain text, NOT a wikilink — a wikilink to a note
        // that does not exist shows up in Obsidian as a broken link and reads
        // as data corruption rather than as a deliberate scope boundary.
        const arrow = e.direction === 'outbound' ? '→' : '←';
        lines.push(target ? `- ${arrow} [[${target}]]` : `- ${arrow} _(outside export scope: ${e.other_id})_`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderVaultReadme(stats) {
  return `# Mnestra memory vault (generated)

**This vault is a READ-ONLY PROJECTION. Do not edit these notes.**

Every file here was generated by \`termdeck vault export\` from the Mnestra
memory store. There is no import path and there is not going to be one: edits
made here are **not** written back, and the next export overwrites them without
warning. If you want to change what a memory says, change it in Mnestra.

Why it works this way: the moment a projection becomes writable it becomes a
second source of truth, and then every question about a memory has two answers
that can silently disagree. Regenerating this vault is cheap. Reconciling two
divergent stores is not.

## What is here

- One note per memory. Filenames are deterministic — derived from the memory's
  content and id only — so wikilinks stay stable across regenerations.
- Frontmatter carries identity, provenance, and every relationship edge with
  its type, direction, weight, temporal validity (\`valid_at\` / \`invalid_at\`),
  and what inferred it.
- \`## Links\` renders those edges as wikilinks. An edge pointing outside the
  exported scope renders as plain text rather than a broken \`[[link]]\`.
- Notes with \`generated: true\` were written by the consolidation job, not by a
  person. They are summaries of a cluster of other notes.

## Regenerating

\`\`\`
termdeck vault export ${stats.dir}
\`\`\`

Nightly, if you want it fresh (this command does NOT install a cron entry —
add it yourself if you want one):

\`\`\`
15 4 * * *  termdeck vault export ${stats.dir} >/dev/null 2>&1
\`\`\`

---

Generated ${stats.generated_at} · ${stats.notes} notes · ${stats.edges} edges${stats.excluded_privacy > 0 ? ` · ${stats.excluded_privacy} memory(ies) withheld for privacy tags` : ''}
`;
}

// ── the command ────────────────────────────────────────────────────────────

async function vaultExport(argv) {
  const { flags, positional } = parseFlags(argv || []);

  if (flags.help || flags.h || positional.length === 0 || positional[0] !== 'export') {
    console.log(HELP);
    return positional.length === 0 ? 1 : 0;
  }

  const targetDir = positional[1] ? path.resolve(String(positional[1])) : null;
  if (!targetDir) {
    console.error('[vault] usage: termdeck vault export <dir>');
    return 1;
  }

  const dryRun = !!flags['dry-run'];
  const force = !!flags.force;
  const project = flags.project ? String(flags.project) : null;
  const limit = flags.limit ? Math.max(1, parseInt(String(flags.limit), 10) || 0) : null;
  const minWeight = flags['min-weight'] !== undefined ? Number(flags['min-weight']) : 0;
  const includePrivacy = flags['include-privacy']
    ? String(flags['include-privacy']).split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // Destructive-write guard. A directory that exists, is non-empty, and does
  // NOT carry our marker is presumed to be someone's real vault.
  if (fs.existsSync(targetDir) && !dryRun) {
    const entries = fs.readdirSync(targetDir).filter((e) => e !== '.DS_Store');
    const hasMarker = entries.includes(MARKER_FILE);
    if (entries.length > 0 && !hasMarker && !force) {
      console.error(`[vault] refusing to write into ${targetDir}: it is not empty and was not created by this exporter.`);
      console.error('[vault] This command DELETES notes from previous runs. If this really is a throwaway export target, re-run with --force.');
      return 1;
    }
  }

  const secrets = resolveSecrets();
  if (!secrets.DATABASE_URL) {
    console.error('[vault] DATABASE_URL not set (checked process.env and ~/.termdeck/secrets.env).');
    return 2;
  }

  let client;
  try {
    client = await connectPg(secrets.DATABASE_URL);
  } catch (err) {
    console.error(`[vault] could not connect to DATABASE_URL: ${err.message}`);
    return 2;
  }

  try {
    // Memories. Privacy-tagged rows are EXCLUDED by default — a vault is a
    // durable, greppable, cloud-syncable artifact on disk, which is a very
    // different exposure profile from an in-terminal recall, so the default
    // here is the conservative one regardless of what recall does.
    const params = [];
    let where = 'is_active and not archived and superseded_by is null';
    if (project) { params.push(project); where += ` and project = $${params.length}`; }
    if (includePrivacy.length > 0) {
      params.push(includePrivacy);
      where += ` and (cardinality(privacy_tags) = 0 or privacy_tags && $${params.length}::text[])`;
    } else {
      where += ' and cardinality(privacy_tags) = 0';
    }
    let sql = `select id, content, source_type, category, project, metadata, privacy_tags,
                      source_agent, created_at
                 from memory_items
                where ${where}
                order by created_at`;
    if (limit) { params.push(limit); sql += ` limit $${params.length}`; }

    const memRes = await client.query(sql, params);
    const memories = memRes.rows;

    // How many were withheld — reported rather than silently dropped, so the
    // vault's note count is explainable.
    let excludedPrivacy = 0;
    if (includePrivacy.length === 0) {
      const countParams = [];
      let countWhere = 'is_active and not archived and superseded_by is null and cardinality(privacy_tags) > 0';
      if (project) { countParams.push(project); countWhere += ` and project = $${countParams.length}`; }
      const c = await client.query(`select count(*)::int as n from memory_items where ${countWhere}`, countParams);
      excludedPrivacy = c.rows[0] ? c.rows[0].n : 0;
    }

    const ids = memories.map((m) => m.id);
    const nameOf = new Map();
    for (const m of memories) nameOf.set(m.id, noteName(m));

    // Edges. Temporal columns are feature-detected: a pre-034 store has no
    // valid_at/invalid_at, and the export must still work there rather than
    // erroring on an unknown column.
    const colRes = await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'memory_relationships'`
    );
    const cols = new Set(colRes.rows.map((r) => r.column_name));
    const hasTemporal = cols.has('invalid_at') && cols.has('valid_at');
    const temporalSelect = hasTemporal ? 'valid_at, invalid_at' : 'null::timestamptz as valid_at, null::timestamptz as invalid_at';
    // LIVE edges only. An invalidated edge is a historical claim, and
    // rendering it as a live wikilink would state something the graph has
    // explicitly retracted.
    const temporalFilter = hasTemporal ? 'and invalid_at is null and (valid_at is null or valid_at <= now())' : '';

    const edgeRes = ids.length > 0
      ? await client.query(
        `select source_id, target_id, relationship_type, weight, inferred_by, ${temporalSelect}
           from memory_relationships
          where (source_id = any($1::uuid[]) or target_id = any($1::uuid[]))
            and coalesce(weight, 0.5) >= $2
            ${temporalFilter}`,
        [ids, minWeight],
      )
      : { rows: [] };

    // Index edges per memory, recording direction from that memory's point of
    // view so the note can render `→` / `←` correctly for asymmetric types.
    const edgesByMemory = new Map();
    const push = (id, edge) => {
      const bucket = edgesByMemory.get(id) || [];
      bucket.push(edge);
      edgesByMemory.set(id, bucket);
    };
    for (const e of edgeRes.rows) {
      const base = {
        relationship_type: e.relationship_type,
        weight: e.weight,
        inferred_by: e.inferred_by,
        valid_at: e.valid_at,
        invalid_at: e.invalid_at,
      };
      if (nameOf.has(e.source_id)) push(e.source_id, { ...base, direction: 'outbound', other_id: e.target_id });
      if (nameOf.has(e.target_id)) push(e.target_id, { ...base, direction: 'inbound', other_id: e.source_id });
    }
    // Deterministic edge order inside a note: same input ⇒ byte-identical
    // output, which is what makes a golden-file test meaningful and makes
    // re-exports diffable.
    for (const bucket of edgesByMemory.values()) {
      bucket.sort((a, b) => (
        a.relationship_type.localeCompare(b.relationship_type)
        || a.direction.localeCompare(b.direction)
        || String(a.other_id).localeCompare(String(b.other_id))
      ));
    }

    const stats = {
      dir: targetDir,
      notes: memories.length,
      edges: edgeRes.rows.length,
      excluded_privacy: excludedPrivacy,
      generated_at: new Date().toISOString(),
    };

    if (dryRun) {
      console.log(`[vault] dry run — would write ${stats.notes} note(s) and ${stats.edges} edge reference(s) to ${targetDir}`);
      if (excludedPrivacy > 0) console.log(`[vault] ${excludedPrivacy} privacy-tagged memory(ies) would be withheld (pass --include-privacy to include)`);
      return 0;
    }

    // Regenerate: remove the previous run's notes, keeping anything the user
    // put here that we did not generate. Only files listed in the marker are
    // removed — a blind `rm *.md` would delete a note the user added.
    const notesDir = path.join(targetDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const markerPath = path.join(targetDir, MARKER_FILE);
    if (fs.existsSync(markerPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        for (const rel of (prior.files || [])) {
          const abs = path.join(targetDir, rel);
          // Never follow a path outside the vault, whatever the marker says.
          if (abs.startsWith(targetDir + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
        }
      } catch (err) {
        console.warn(`[vault] could not read prior manifest (${err.message}) — leaving existing files in place`);
      }
    }

    const written = [];
    for (const memory of memories) {
      const name = nameOf.get(memory.id);
      const rel = path.join('notes', `${name}.md`);
      fs.writeFileSync(path.join(targetDir, rel), renderNote(memory, edgesByMemory.get(memory.id) || [], nameOf), 'utf8');
      written.push(rel);
    }

    fs.writeFileSync(path.join(targetDir, 'README.md'), renderVaultReadme(stats), 'utf8');
    written.push('README.md');

    fs.writeFileSync(markerPath, JSON.stringify({
      marker: 'termdeck-vault',
      version: MARKER_VERSION,
      read_only: true,
      generated_at: stats.generated_at,
      generator: 'termdeck vault export',
      counts: { notes: stats.notes, edges: stats.edges, withheld_privacy: excludedPrivacy },
      files: written,
    }, null, 2) + '\n', 'utf8');

    console.log(`[vault] wrote ${stats.notes} note(s) + README to ${targetDir}`);
    console.log(`[vault] ${stats.edges} live edge reference(s) rendered as wikilinks`);
    if (excludedPrivacy > 0) {
      console.log(`[vault] ${excludedPrivacy} privacy-tagged memory(ies) withheld — pass --include-privacy=<tags> to include`);
    }
    console.log('[vault] this vault is a READ-ONLY projection; edits are not written back');
    return 0;
  } catch (err) {
    console.error(`[vault] export failed: ${err.message}`);
    return 2;
  } finally {
    try { await client.end(); } catch (_e) { /* already closed */ }
  }
}

module.exports = vaultExport;
module.exports.noteName = noteName;
module.exports.renderNote = renderNote;
module.exports.renderVaultReadme = renderVaultReadme;
module.exports.parseFlags = parseFlags;
module.exports.MARKER_FILE = MARKER_FILE;
module.exports.EDGE_SECTION_ORDER = EDGE_SECTION_ORDER;
