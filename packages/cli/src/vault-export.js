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
// Sprint 71 B-T2 — the SAME tier-0 normalizer and renderer the server and the
// PreCompact hook use. Requiring across into packages/server is safe here (and
// already the established pattern one line up): both directories ship in the
// same `@jhizzard/termdeck` tarball. The bundled hook cannot do this — it
// installs to ~/.claude/hooks/ and would be reaching into a package the user
// may not have — which is why that one copy is vendored and parity-fenced.
const tier0lib = require(path.join(__dirname, '..', '..', 'server', 'src', 'tier0.js'));

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

// Sprint 71 B-T2 — read the tier-0 objectives straight from Postgres for the
// vault render.
//
// GUARDED BY to_regclass, NOT BY try/catch-on-query. The table does not exist
// until engram migration 038 applies, and this exporter ships first. A failed
// query inside a transaction would poison the rest of the export; asking the
// catalog first is the only way to be sure we never issue it. The catch is
// still there as a floor, but it is not the mechanism.
//
// Table name is env-overridable for the same reason as everywhere else in this
// feature: B-T1 owns the schema and had not frozen the name when this shipped.
async function fetchTier0FromPg(client, project) {
  const table = process.env.TERMDECK_TIER0_TABLE || 'memory_objectives';
  // Anything that is not a plain identifier is refused rather than escaped —
  // this value reaches a query as an identifier, and an allow-list is the only
  // honest way to handle that.
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return [];
  try {
    const reg = await client.query('select to_regclass($1) as t', [`public.${table}`]);
    if (!reg.rows[0] || !reg.rows[0].t) return [];
    const params = [];
    let where = 'true';
    if (project) { params.push(project); where += ` and project = $${params.length}`; }
    // Active-only at the query, matching `objective_list`'s contract — but only
    // when the column is actually there. Emitting `status = 'active'`
    // unconditionally would throw on a table shaped differently, and the catch
    // below turns a throw into an empty list: the vault would silently lose its
    // objectives section rather than say anything. `normalizeObjectives` is the
    // guarantee that a superseded objective is never rendered; this is the
    // optimisation, and an optimisation must not be able to blank the feature.
    const col = await client.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = 'status'`,
      [table],
    );
    if (col.rows.length > 0) where += " and status = 'active'";
    const res = await client.query(`select * from public."${table}" where ${where}`, params);
    return tier0lib.normalizeObjectives(res.rows);
  } catch (_e) {
    // A pre-038 store, a permissions gap, or a shape we do not recognise all
    // mean the same thing to a reader: no objectives section. The export is
    // not the place to surface a schema problem.
    return [];
  }
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
// Sprint 69 P2-8. The time-series classes carry a UTC date prefix, which turns
// Obsidian's lexical filename sort into a free chronological index — "what
// happened around then" is the most common human query and search does not
// answer it. Only these three: a decision or a preference has no useful
// position on a timeline, and a date prefix there would just push the readable
// part of the name off the edge of the sidebar.
const DATE_PREFIXED_TYPES = new Set(['session_summary', 'pre_compact_snapshot', 'document_chunk']);

// `idChars` widens the id suffix for the collision case only — see
// buildNameMap. The default reproduces the pre-Sprint-69 name exactly, so an
// uncontested name is byte-identical to what previous releases wrote.
function noteName(memory, idChars = 8) {
  const slug = String(memory.content || '')
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'memory';
  const hex = String(memory.id).replace(/-/g, '');
  const stem = `${slug}-${hex.slice(0, Math.max(1, idChars))}`;
  if (!DATE_PREFIXED_TYPES.has(String(memory.source_type || ''))) return stem;
  // UTC, never local time. A filename IS a wikilink target, so a date derived
  // from the exporting machine's timezone would give two machines two different
  // link namespaces for the same store — a laptop-vs-cron regen would look like
  // mass corruption.
  const day = isoDate(memory.created_at);
  return day ? `${day}-${stem}` : stem;
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

// ── topology: hubs, members, titles ────────────────────────────────────────
//
// A consolidation summary knows which memories it synthesized
// (`metadata.consolidation.member_ids`); a member has no idea it belongs to
// anything. That asymmetry is the whole reason the vault read as an orphan
// cloud: the containment edge — the one edge that is ALWAYS available, unlike
// sparse semantic edges — was present in the data and never rendered.
//
// Rendering it in BOTH directions means knowing every hub before writing any
// note, so the export is two-pass: buildTopology() walks the full memory set
// first, then renderNote() reads finished maps. Membership is keyed off the
// presence of `metadata.consolidation` rather than off `source_type`, so the
// `hub: true` flag and the "Generated summary" callout can never disagree
// about whether a note is a hub.

const EMPTY_MAP = new Map();

// How long a title may run before it is cut. Long enough to carry a claim,
// short enough that a hub's member list stays scannable.
const TITLE_MAX = 72;

// Characters that terminate or re-target a wikilink. Left inside an alias they
// do not render as text — they silently change what the link points at, or
// break it outright.
function linkText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[[\]|#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The human-readable claim a note makes. Titles are what let a hub's member
// list read as prose instead of as a column of uuid-suffixed slugs.
function noteTitle(memory) {
  const first = String(memory.content || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  // Memory content is markdown, so its first line frequently opens with
  // decoration — a heading marker, a bullet, a blockquote, bold. In a link
  // alias that decoration does not render as formatting, it renders as
  // literal punctuation in front of the claim.
  const undecorated = first
    .replace(/^(?:[>\s]*)(?:#{1,6}\s+|[-*+]\s+)?/, '')
    .replace(/^\*{1,3}(.+?)\*{1,3}$/, '$1')
    .replace(/^\*{1,3}/, '');
  const clean = linkText(undecorated);
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

// Obsidian's tag grammar is letters, digits, `_`, `-`, `/`. Underscores are
// preserved DELIBERATELY so `type/<tag>` maps 1:1 onto the `source_type`
// column — `type/bug_fix`, not `type/bug-fix` — which is what makes a graph
// color group or a Bases filter expressible as one literal instead of a
// lossy transformation both ends have to agree on.
function tagSlug(value, fallback) {
  const s = String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return s || fallback;
}

function isoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// `aliases` is what makes search and link autocomplete surface a claim rather
// than a uuid-suffixed slug. Two entries: the filename with its disambiguating
// uuid suffix stripped (so typing the slug still finds the note), and the
// human title (so typing words a person would actually remember finds it too).
function noteAliases(memory) {
  const out = [];
  // The id suffix widens from 8 to 32 chars when two memories contest a
  // basename (buildNameMap), so the strip has to cover the widened form too.
  const slug = noteName(memory).replace(/-[0-9a-f-]{8,36}$/i, '');
  // `memory` is the fallback slug for content with no alphanumerics at all —
  // as an alias it would collide across every such note, so it is skipped.
  if (slug && slug !== 'memory') out.push(slug);
  const title = noteTitle(memory);
  if (title && title !== slug) out.push(title);
  return [...new Set(out)];
}

function buildTopology(memories, nameOf) {
  const titleOf = new Map();
  for (const m of memories) titleOf.set(m.id, noteTitle(m) || nameOf.get(m.id) || String(m.id));

  const hubsOf = new Map();    // member id -> [hub id, ...]; a note may belong to several
  const membersOf = new Map(); // hub id    -> { links, declared, missing }
  const hubs = [];
  let danglingMembers = 0;

  for (const m of memories) {
    const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
    const consolidation = meta.consolidation || null;
    if (!consolidation) continue;

    const declared = Array.isArray(consolidation.member_ids) ? consolidation.member_ids : [];
    const links = [];
    const seen = new Set();
    let missing = 0;
    for (const raw of declared) {
      const id = String(raw);
      // A hub is never its own member, and a repeated id must not produce a
      // duplicated bullet — both are cheap to defend against and neither is
      // guaranteed absent by anything upstream.
      if (id === m.id || seen.has(id)) continue;
      seen.add(id);
      if (!nameOf.has(id)) {
        // Outside this export's scope (--project / --limit / privacy filters
        // all produce this by construction). Counted and reported; NEVER
        // emitted as a wikilink, because a link to a note that does not exist
        // reads in Obsidian as corruption rather than as a scope boundary.
        missing++;
        danglingMembers++;
        continue;
      }
      links.push({ id, name: nameOf.get(id), title: titleOf.get(id) });
      const bucket = hubsOf.get(id) || [];
      bucket.push(m.id);
      hubsOf.set(id, bucket);
    }
    links.sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
    membersOf.set(m.id, { links, declared: declared.length, missing });
    hubs.push(m);
  }

  // Deterministic parent order for a note in several communities.
  for (const bucket of hubsOf.values()) {
    bucket.sort((a, b) => String(nameOf.get(a)).localeCompare(String(nameOf.get(b))));
  }

  return { titleOf, hubsOf, membersOf, hubs, danglingMembers };
}

// The single place a generated note's location is decided (CONTRACT-2). The
// folder decision itself is T2's `routeFor`; this composes it with the name
// map so the write loop never joins a path by hand. Wikilinks are bare-name
// and `buildNameMap` keeps basenames unique, so where a note lives has no
// bearing on whether a link to it resolves.
function relPathFor(memory, nameOf) {
  const name = (nameOf && nameOf.get(memory.id)) || noteName(memory);
  return path.join(routeFor(memory), `${name}.md`);
}

// One note. Frontmatter carries identity + provenance + navigation (tags,
// date, aliases, edge count, hub/up membership) + the full edge list (type,
// direction, target, validity, who inferred it, weight); the body carries the
// content, the containment breadcrumb, the member list, and the wikilinks.
//
// `topology` is optional: rendering a note with no topology produces a valid
// note without the membership layer, which is what a caller that has not run
// buildTopology() should get rather than a crash.
function renderNote(memory, edges, nameOf, topology) {
  const topo = topology && typeof topology === 'object' ? topology : {};
  const hubsOf = topo.hubsOf instanceof Map ? topo.hubsOf : EMPTY_MAP;
  const membersOf = topo.membersOf instanceof Map ? topo.membersOf : EMPTY_MAP;
  const titleOf = topo.titleOf instanceof Map ? topo.titleOf : EMPTY_MAP;

  const meta = memory.metadata && typeof memory.metadata === 'object' ? memory.metadata : {};
  const consolidation = meta.consolidation || null;
  const signature = meta.problem_signature || null;

  const membership = membersOf.get(memory.id) || null;
  const parents = (hubsOf.get(memory.id) || [])
    .map((hubId) => ({ name: nameOf.get(hubId), title: titleOf.get(hubId) || nameOf.get(hubId) }))
    .filter((p) => p.name);

  const lines = [];
  lines.push('---');
  lines.push(`id: ${yamlString(memory.id)}`);
  lines.push(`project: ${yamlString(memory.project)}`);
  lines.push(`source_type: ${yamlString(memory.source_type)}`);
  if (memory.category) lines.push(`category: ${yamlString(memory.category)}`);
  lines.push(`created_at: ${yamlString(memory.created_at && memory.created_at.toISOString ? memory.created_at.toISOString() : memory.created_at)}`);
  // Emitted UNQUOTED so Obsidian types this as a real date rather than as
  // text: date-typed properties are what Bases recency filters and formulas
  // sort and bucket on, and a quoted "2026-07-01" silently is not one.
  const dateOnly = isoDate(memory.created_at);
  if (dateOnly) lines.push(`date: ${dateOnly}`);
  // Nested tags: the tag pane turns `project/*` and `type/*` into a browsable
  // tree, and they are the stable literal the graph color groups key on.
  // Project identity is ONE slug across every surface (R-2 §2): the same
  // `projectSegment` that names the folder names the tag and the MOC, so
  // `pvb` and `PVB` are one project everywhere or nowhere. Type keeps its
  // underscores so `type/*` stays 1:1 with the `source_type` column.
  lines.push(`tags: ${yamlList([
    `project/${projectSegment(memory.project)}`,
    `type/${tagSlug(memory.source_type, 'unknown')}`,
  ])}`);
  const aliases = noteAliases(memory);
  if (aliases.length > 0) lines.push(`aliases: ${yamlList(aliases)}`);
  if (memory.source_agent) lines.push(`source_agent: ${yamlString(memory.source_agent)}`);
  if (Array.isArray(memory.privacy_tags) && memory.privacy_tags.length > 0) {
    lines.push(`privacy_tags: ${yamlList(memory.privacy_tags)}`);
  }
  // Always emitted, including 0 — "how connected is this note" is only a
  // filterable/sortable property if every note carries it.
  lines.push(`edge_count: ${edges.length}`);

  // Containment, the edge that is always available. `up:` is the field
  // Breadcrumbs and the Bases hierarchy views read, and it is ALWAYS a list —
  // even at length 1 (ORCH ruling R-2). A property that is a scalar for most
  // notes and a list for a few is one every consumer has to special-case, and
  // the ones that forget silently read only the first parent.
  if (parents.length > 0) {
    lines.push('up:');
    for (const p of parents) lines.push(`  - ${yamlString(`[[${p.name}]]`)}`);
  }

  // Provenance for generated content. A consolidation summary must be
  // identifiable AS a generated artifact from the note alone — someone reading
  // the vault has no other way to tell it apart from a memory a human wrote.
  if (consolidation) {
    lines.push('generated: true');
    // `hub: true` is the one-clause selector for "this note is a neighbourhood
    // centre" — what the graph sizes on and what the Bases hub view filters to.
    lines.push('hub: true');
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

  // The breadcrumb a reader lands on. Frontmatter `up:` is machine-readable;
  // this is the version a person actually follows, aliased so it reads as a
  // claim rather than as a slug.
  if (parents.length > 0) {
    lines.push(`Part of: ${parents.map((p) => `[[${p.name}|${p.title}]]`).join(' · ')}`);
    lines.push('');
  }

  lines.push(String(memory.content || '').trim());
  lines.push('');

  // The hub half of the containment edge: what this summary synthesized.
  if (membership && (membership.links.length > 0 || membership.missing > 0)) {
    lines.push('## Members');
    lines.push('');
    for (const l of membership.links) lines.push(`- [[${l.name}|${l.title}]]`);
    if (membership.missing > 0) {
      lines.push(`- _${membership.missing} member${membership.missing === 1 ? '' : 's'} outside this export's scope._`);
    }
    lines.push('');
    // The static list above is the durable one — it survives Bases being
    // disabled and it is what the acceptance check reads. The view adds sort
    // and filter on top of it (R-2 §9).
    lines.push(basesEmbed('Members'));
    lines.push('');
  }

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

// ── the generated index layer (Home + per-project MOCs) ────────────────────
//
// Nine thousand notes is past the point where anyone browses files. The index
// layer exists so there is exactly one note to open first, and so every
// project has a named door rather than a search box.

// Where the per-project maps live. Kept as a constant, and every link to them
// is bare-name, so moving them is a one-line change that breaks nothing.
const MOC_DIR = 'moc';
const HOME_FILE = 'Home.md';

// How much of the long tail an index note is allowed to list. The tail belongs
// to search and to the Bases dashboards; a hub that lists everything is as
// useless as no hub at all.
const HOME_RECENT_LIMIT = 15;
const HOME_HUB_LIMIT = 100;
const MOC_RECENT_LIMIT = 25;

// Bases views, per CONTRACT-3 as settled in ORCH ruling R-2 §9. The view names
// are T2's, emitted by `renderMemoriesBase()` in this same file and in the same
// run — so the embed target always exists in any tree this exporter writes.
// A named view is embedded as `![[Memories.base#<View>]]`.
const BASES_FILE = 'Memories.base';

function basesEmbed(view) {
  return `![[${BASES_FILE}#${view}]]`;
}

// A MOC is identified by the project SLUG, not by the raw project string
// (R-2 §2). The live store holds both `pvb` and `PVB`; they are one project in
// the folder tree and one project in the tag pane, so they get one map. Naming
// the file from the slug also makes it filesystem-safe and collision-free by
// construction, which raw project strings are not.
function mocNameFor(slug) {
  return `MOC - ${slug}`;
}

function link(name, title) {
  return title && title !== name ? `[[${name}|${title}]]` : `[[${name}]]`;
}

// Sprint 71 B-T2 — the tier-0 block as it appears at the top of Home and every
// MOC. The point of rendering it here is symmetry: the human opening the vault
// reads the same standing objectives, in the same order, that the agents get
// injected at boot and at compaction. If those two ever differ, the operator is
// reasoning about a system that is being told something else.
//
// It goes ABOVE the store statistics deliberately. The first thing on the page
// should be what the project is FOR, not how many notes are in it.
function tier0Section(objectives) {
  const block = tier0lib.renderTier0Block(objectives || []);
  if (!block) return [];
  return [
    '> [!abstract] Tier 0 — injected into every agent session',
    '> Pinned above recall for agents at session boot and re-injected at context',
    '> compaction. This is a read-only projection; objectives change only by',
    '> explicit ratification in the store.',
    '',
    block,
    '',
    '---',
    '',
  ];
}

function renderHome(view) {
  const { stats, hubs, projects, recent, doctrine } = view;
  const lines = [];
  lines.push('---');
  lines.push('generated: true');
  lines.push(`generated_by: ${yamlString('termdeck vault export')}`);
  // Deliberately NOT stamped with a generation time (declared to T3 per
  // R-2 §7). README.md and the marker already carry the one authoritative
  // stamp; a second copy in 34 more files would buy nothing and would widen
  // the byte-stability allowlist from two entries to thirty-six.
  lines.push(`tags: ${yamlList(['index/home'])}`);
  lines.push('---');
  lines.push('');
  lines.push('# Home');
  lines.push('');
  lines.push('> [!info] Generated index — start here');
  lines.push('> This whole vault is a READ-ONLY projection of the Mnestra memory store, rewritten from scratch on every export. Edits are not written back. This note is regenerated too, so do not edit it either.');
  lines.push('');

  for (const l of tier0Section(view.tier0)) lines.push(l);

  lines.push('## The store right now');
  lines.push('');
  lines.push(`- **${stats.notes}** notes · **${stats.edges}** live edge references · **${hubs.length}** community hubs · **${projects.length}** projects`);
  if (stats.newest) lines.push(`- Newest memory ${stats.newest}${stats.oldest ? ` · oldest ${stats.oldest}` : ''}`);
  lines.push('- Export time and full counts: see `README.md`');
  if (stats.excluded_privacy > 0) lines.push(`- ${stats.excluded_privacy} memory(ies) withheld for privacy tags`);
  if (stats.dangling_members > 0) lines.push(`- ${stats.dangling_members} community member(s) fall outside this export's scope and are counted rather than linked`);
  lines.push('');

  lines.push('## Communities');
  lines.push('');
  if (hubs.length === 0) {
    lines.push('_No consolidation summaries in this export._');
  } else {
    lines.push('Each hub is a generated summary of a cluster; its members link back to it.');
    lines.push('');
    for (const h of hubs.slice(0, HOME_HUB_LIMIT)) {
      lines.push(`- ${link(h.name, h.title)} — ${h.member_count} member${h.member_count === 1 ? '' : 's'}${h.project ? ` · ${h.project}` : ''}`);
    }
    if (hubs.length > HOME_HUB_LIMIT) {
      lines.push(`- _…and ${hubs.length - HOME_HUB_LIMIT} more — see the per-project maps below._`);
    }
    lines.push('');
    lines.push(basesEmbed('Communities'));
  }
  lines.push('');

  lines.push('## Projects');
  lines.push('');
  for (const p of projects) {
    lines.push(`- ${link(p.moc_name, p.project)} — ${p.count} note${p.count === 1 ? '' : 's'}${p.hub_count > 0 ? ` · ${p.hub_count} hub${p.hub_count === 1 ? '' : 's'}` : ''}`);
  }
  lines.push('');

  // Omitted entirely at zero: the store has no doctrine rows today (doctrine
  // lives in rumen's registry, not in memory_items), and a heading over an
  // empty list reads as a missing feature rather than as an absent input.
  if (doctrine.length > 0) {
    lines.push('## Doctrine');
    lines.push('');
    for (const d of doctrine) lines.push(`- ${link(d.name, d.title)}`);
    lines.push('');
  }

  lines.push('## Newest decisions and fixes');
  lines.push('');
  if (recent.length === 0) {
    lines.push('_None in this export._');
  } else {
    for (const r of recent) {
      lines.push(`- ${link(r.name, r.title)} — ${r.date} · ${r.source_type}${r.project ? ` · ${r.project}` : ''}`);
    }
    lines.push('');
    lines.push(basesEmbed('Decisions'));
  }
  lines.push('');

  lines.push('## Everything else');
  lines.push('');
  lines.push('Too long to list. Browse by tag — `#project/…`, `#type/…` — search, or use the view below.');
  lines.push('');
  lines.push(basesEmbed('Recent'));
  lines.push('');

  return lines.join('\n');
}

function renderMoc(view) {
  const { project, slug, hubs, recent, count } = view;
  const lines = [];
  lines.push('---');
  lines.push('generated: true');
  lines.push(`generated_by: ${yamlString('termdeck vault export')}`);
  // `project` is the DOMINANT raw casing of the merged slug (R-2 §2) — the
  // spelling most of the notes actually use, so a Bases filter written against
  // this MOC matches the bulk of the project rather than a 2-row tail.
  lines.push(`project: ${yamlString(project)}`);
  lines.push(`tags: ${yamlList(['index/moc', `project/${slug}`])}`);
  lines.push('up:');
  lines.push(`  - ${yamlString('[[Home]]')}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${linkText(project) || slug}`);
  lines.push('');
  lines.push('> [!info] Generated map of content');
  lines.push('> Regenerated on every export. Do not edit — start from [[Home]].');
  lines.push('');

  // Per-project objectives. A MOC is the door to a project, so the project's
  // standing constraints belong on it — and an agent scoped to this project is
  // injected with exactly this subset.
  for (const l of tier0Section(view.tier0)) lines.push(l);

  lines.push(`**${count}** note${count === 1 ? '' : 's'} in this project.`);
  lines.push('');

  lines.push('## Communities');
  lines.push('');
  if (hubs.length === 0) {
    lines.push('_No consolidation summaries in this project yet._');
  } else {
    for (const h of hubs) {
      lines.push(`- ${link(h.name, h.title)} — ${h.member_count} member${h.member_count === 1 ? '' : 's'}`);
    }
  }
  lines.push('');

  lines.push(`## Most recent`);
  lines.push('');
  if (recent.length === 0) {
    lines.push('_None in this export._');
  } else {
    for (const r of recent) {
      lines.push(`- ${link(r.name, r.title)} — ${r.date} · ${r.source_type}`);
    }
    if (count > recent.length) {
      lines.push('');
      lines.push(`_${count - recent.length} older note(s) not listed — the full feed is below._`);
    }
  }
  lines.push('');

  lines.push('## Everything in this project');
  lines.push('');
  lines.push(`Tagged \`#project/${slug}\`.`);
  lines.push('');
  lines.push(basesEmbed('ProjectFeed'));
  lines.push('');

  return lines.join('\n');
}

// Everything the index notes need, computed once. Kept separate from the
// renderers so the shape of the index is testable without a filesystem and
// without a database.
function buildIndexView(memories, nameOf, topology) {
  const timeOf = (m) => {
    const t = m.created_at instanceof Date ? m.created_at.getTime() : Date.parse(m.created_at);
    return Number.isNaN(t) ? 0 : t;
  };
  const summarize = (m) => ({
    name: nameOf.get(m.id),
    title: topology.titleOf.get(m.id) || nameOf.get(m.id),
    date: isoDate(m.created_at) || '',
    source_type: m.source_type || '',
    project: m.project || null,
  });
  // Newest-first, with an id tiebreak so an unchanged store cannot produce two
  // different orderings.
  const newestFirst = (rows, limit) => rows
    .slice()
    .sort((a, b) => timeOf(b) - timeOf(a) || String(b.id).localeCompare(String(a.id)))
    .slice(0, limit)
    .map(summarize);

  const hubs = topology.hubs.map((m) => {
    const membership = topology.membersOf.get(m.id) || { links: [] };
    return {
      name: nameOf.get(m.id),
      title: topology.titleOf.get(m.id) || nameOf.get(m.id),
      project: m.project || null,
      // Members resolved IN THIS EXPORT, not the count the generator declared:
      // a navigation list that promises 12 links and shows 4 is worse than one
      // that says 4.
      member_count: membership.links.length,
    };
  }).sort((a, b) => b.member_count - a.member_count
    || a.title.localeCompare(b.title)
    || a.name.localeCompare(b.name));

  // Projects are grouped by SLUG, so case variants (`pvb` / `PVB`) are one
  // project here exactly as they are one folder and one tag (R-2 §2).
  const byProject = new Map();
  for (const m of memories) {
    const slug = projectSegment(m.project);
    const bucket = byProject.get(slug) || [];
    bucket.push(m);
    byProject.set(slug, bucket);
  }
  // Display casing is the raw spelling the most notes use — decided by count,
  // then lexically so a tie cannot depend on row order.
  const dominantCasing = (rows) => {
    const tally = new Map();
    for (const m of rows) {
      const raw = m.project || '';
      tally.set(raw, (tally.get(raw) || 0) + 1);
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  };
  const projects = [...byProject.entries()].map(([slug, rows]) => ({
    slug,
    project: dominantCasing(rows) || slug,
    moc_name: mocNameFor(slug),
    count: rows.length,
    hubs: hubs.filter((h) => projectSegment(h.project) === slug),
    recent: newestFirst(rows, MOC_RECENT_LIMIT),
  })).map((p) => ({ ...p, hub_count: p.hubs.length }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

  // Doctrine is not in `memory_items` today — it lives in rumen's
  // `doctrine_registry`. Detected rather than assumed absent, so the section
  // appears on its own the day doctrine starts landing in the store.
  const doctrine = memories
    .filter((m) => {
      const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
      return Boolean(meta.doctrine)
        || /doctrine/i.test(String(m.category || ''))
        || /doctrine/i.test(String(m.source_type || ''));
    })
    .map(summarize)
    .sort((a, b) => a.title.localeCompare(b.title));

  const dates = memories.map((m) => isoDate(m.created_at)).filter(Boolean).sort();

  return {
    hubs,
    projects,
    doctrine,
    recent: newestFirst(
      memories.filter((m) => m.source_type === 'decision' || m.source_type === 'bug_fix'),
      HOME_RECENT_LIMIT,
    ),
    newest: dates.length > 0 ? dates[dates.length - 1] : null,
    oldest: dates.length > 0 ? dates[0] : null,
  };
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

## Start here

Open **Home.md**. It is generated too, and it is the only note you need to
find first: store stats, every community hub, a map of content per project,
and the newest decisions and fixes. Each project map is \`${MOC_DIR}/MOC - <project>.md\`.

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

// ── projection surfaces (Sprint 69 T2) ─────────────────────────────────────
//
// Three files that make 9k notes navigable rather than merely present:
// `Memories.base` (dashboards), `.obsidian/graph.json` (graph defaults), and
// the folder routing that both of them lean on.

// Paths the exporter writes but DOES NOT own. Sprint 69 ruling R-1: the
// regeneration model is "unlink everything in the prior manifest, then write" —
// so a path that lands in the manifest is a path the NEXT run deletes. That is
// correct for generated notes and wrong for anything the user is invited to
// tune. `.obsidian/` is the user's; graph.json in particular is written
// once, write-if-missing, and must survive every subsequent export.
//
// This constant is the enforcement layer, not a convention: it is applied at
// BOTH ends — the manifest is filtered before it is serialized, and the unlink
// sweep skips these prefixes even if an older or hand-edited manifest names
// them. A future caller who wires graph.json into `written` by mistake still
// cannot get it swept.
const UNTRACKED_PREFIXES = ['.obsidian'];

function isUntracked(relPath) {
  const first = String(relPath).split(/[\\/]/)[0];
  return UNTRACKED_PREFIXES.includes(first);
}

// Writes only if nothing is there. Returns whether it wrote. Deliberately has
// no access to the manifest array — the tracked-write path and the
// user-tunable-write path are different functions so that tracking a tunable
// file requires writing a new line of code rather than forgetting one.
function writeIfMissing(absPath, contents) {
  if (fs.existsSync(absPath)) return false;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, contents, 'utf8');
  return true;
}

// ── folder routing ─────────────────────────────────────────────────────────
//
// Folders are for PURPOSE (they give the graph and Bases one-clause filters to
// quarantine noise); links are for meaning. Wikilinks resolve by name, not
// path, so re-foldering breaks no existing link — the thing re-foldering CAN
// break is a basename collision across two folders, which is why buildNameMap
// disambiguates.

const SNAPSHOT_TYPES = new Set(['pre_compact_snapshot', 'document_chunk']);

// Project names become directory names, so they are lowercased — not merely
// slugified. The live store holds both `pvb` and `PVB`, and both
// `chopin-in-bohemia` and `ChopinInBohemia`. macOS is case-insensitive by
// default and Linux is not, so case-distinct folders would make the export
// non-portable and its layout dependent on which row was written first.
// Lowercasing merges each pair deliberately; frontmatter `project` keeps the
// true casing, so nothing is lost.
// Delegates to tagSlug rather than reimplementing it, so the folder segment and
// the `project/<slug>` tag are the SAME string by construction. Two slug
// functions that agree today and drift on the first project name containing an
// underscore is exactly the kind of divergence nobody notices until a Bases
// filter and a folder path disagree about where a project lives.
function projectSegment(project) {
  return tagSlug(project, 'unfiled');
}

// Directories a run may create. Used to prune empties after a layout change:
// re-foldering leaves the previous run's now-empty directories behind, and a
// stale empty folder in the sidebar reads as "this project vanished".
const GENERATED_DIRS = ['notes', 'communities', 'doctrine', 'snapshots', MOC_DIR];

function routeFor(memory) {
  const type = String(memory.source_type || '');
  if (type === 'consolidation_summary') return 'communities';
  // Doctrine is not a memory_items citizen today — it lives in rumen's
  // doctrine_registry and the repo's doctrine/registry.jsonl, and a live-store
  // scan finds zero rows of this type. The rule is kept because it is one map
  // entry; no `doctrine/` directory appears in an export until something
  // actually routes there, since directories are created on write.
  if (type === 'doctrine') return 'doctrine';
  // Snapshots and document chunks are bulk machine output — 1,142 of the 9,118
  // exportable rows. Quarantining them by folder is what lets the graph and
  // every Bases view drop them with a single clause.
  if (SNAPSHOT_TYPES.has(type)) return 'snapshots';
  return path.join('notes', projectSegment(memory.project));
}

// Note names, with collisions resolved. Two memories claiming one basename is
// no longer a harmless duplicate once notes live in different folders: Obsidian
// resolves `[[name]]` by basename, so a collision silently sends every inbound
// link to whichever file won.
//
// Disambiguation is order-INDEPENDENT: when a name is contested, EVERY
// claimant widens its id suffix. "First writer keeps the short name" would make
// the output depend on row order from Postgres, which is exactly the property
// the golden-file test exists to prevent. (Live-store probe: zero collisions
// today across all 9,118 rows — this is a guard, not a fix.)
function buildNameMap(memories) {
  const claims = new Map();
  for (const m of memories) {
    const base = noteName(m);
    const bucket = claims.get(base) || [];
    bucket.push(m);
    claims.set(base, bucket);
  }
  const nameOf = new Map();
  for (const claimants of claims.values()) {
    if (claimants.length === 1) {
      nameOf.set(claimants[0].id, noteName(claimants[0]));
      continue;
    }
    for (const m of claimants) nameOf.set(m.id, noteName(m, 32));
  }
  return nameOf;
}

function pruneEmptyDirs(targetDir) {
  const walk = (abs) => {
    let entries;
    try { entries = fs.readdirSync(abs); } catch (_e) { return; }
    for (const entry of entries) {
      const child = path.join(abs, entry);
      let st;
      try { st = fs.lstatSync(child); } catch (_e) { continue; }
      if (st.isDirectory()) walk(child);
    }
    // Only ever removes a directory that is already empty, so a user file
    // anywhere beneath it keeps the whole branch alive.
    try {
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch (_e) { /* non-empty or gone */ }
  };
  for (const dir of GENERATED_DIRS) {
    const abs = path.join(targetDir, dir);
    if (fs.existsSync(abs)) walk(abs);
  }
}

// ── Memories.base ──────────────────────────────────────────────────────────
//
// At 9k notes nobody browses files; they browse views. Bases is a CORE plugin,
// so this costs the reader zero installs.
//
// Verified against the official syntax at obsidian.md/help/bases/syntax (source
// of record: obsidianmd/obsidian-help, en/Bases/Bases syntax.md, whose last
// schema-bearing commit is "Bases docs for 1.10.3"). ONLY documented keys are
// emitted. Notably absent: a row-level `sort:`. Sorting exists in the Bases UI
// but its serialized key is documented nowhere, and there was no app-written
// .base on hand to sample as ground truth — so ordering is delivered the
// documented way, via groupBy over numeric-prefixed bucket formulas. Guessing a
// key into a generated file is how a vault quietly stops parsing.
//
// Pure and argument-free on purpose: same store state ⇒ byte-identical file.
function renderMemoriesBase() {
  return `# Generated by \`termdeck vault export\`. REGENERATED ON EVERY RUN — edits are
# lost. To keep a tuned view, copy this file under a different name; the
# exporter only ever writes Memories.base.
#
# Property names here track the exporter's frontmatter. If a view is empty, the
# usual cause is a property that stopped being emitted, not a broken filter.
filters:
  and:
    # Every exported memory carries \`id\`; this keeps README/Home/MOC notes out
    # of the result set without hardcoding their filenames.
    - file.hasProperty("id")
    # Snapshots and document chunks are bulk machine output. They are
    # quarantined by folder precisely so one clause removes them everywhere.
    - not:
        - file.inFolder("snapshots")

formulas:
  # Numeric prefixes are load-bearing: groups sort by this string, so "10 -"
  # through "50 -" is what puts today above last month.
  recency: 'if(note.date, if(note.date >= today(), "10 - Today", if(note.date >= today() - "7d", "20 - This week", if(note.date >= today() - "30d", "30 - This month", "40 - Older"))), "50 - Undated")'
  month: 'if(note.date, note.date.format("YYYY-MM"), "unknown")'

properties:
  source_type:
    displayName: Type
  project:
    displayName: Project
  date:
    displayName: Date
  category:
    displayName: Category
  edge_count:
    displayName: Links
  community_member_count:
    displayName: Members
  source_agent:
    displayName: Agent
  file.name:
    displayName: Note
  formula.recency:
    displayName: When
  formula.month:
    displayName: Month

views:
  # Embed: ![[Memories.base#Recent]]
  - type: table
    name: Recent
    limit: 200
    filters:
      and:
        - 'note.date >= today() - "30d"'
    groupBy:
      property: formula.recency
      direction: ASC
    order:
      - file.name
      - note.project
      - note.source_type
      - note.date
      - note.edge_count

  # Embed: ![[Memories.base#Decisions]]
  - type: table
    name: Decisions
    limit: 500
    filters:
      and:
        - 'note.source_type == "decision"'
    groupBy:
      property: note.project
      direction: ASC
    order:
      - file.name
      - note.date
      - note.category
      - note.edge_count

  # Embed: ![[Memories.base#Bugs]]
  - type: table
    name: Bugs
    limit: 500
    filters:
      and:
        - 'note.source_type == "bug_fix"'
    groupBy:
      property: note.project
      direction: ASC
    order:
      - file.name
      - note.date
      - note.category
      - note.edge_count

  # Embed: ![[Memories.base#Sessions]]
  - type: table
    name: Sessions
    limit: 500
    filters:
      and:
        - 'note.source_type == "session_summary"'
    groupBy:
      property: formula.month
      direction: DESC
    order:
      - file.name
      - note.date
      - note.project
      - note.source_agent

  # Embed: ![[Memories.base#Communities]]
  # Consolidation summaries — the hub notes. Their members are one click away
  # through the hub's own Members section.
  - type: table
    name: Communities
    filters:
      and:
        - 'note.hub == true'
    groupBy:
      property: note.project
      direction: ASC
    order:
      - file.name
      - note.community_member_count
      - note.date
      - note.project

  # Embed in MOC - <project>.md: ![[Memories.base#ProjectFeed]]
  # Self-filtering: \`this\` resolves to the EMBEDDING note, so one view serves
  # every project MOC — provided the MOC carries \`project:\` in its own
  # frontmatter. Documented \`this\` examples cover file properties; note
  # properties are the same object, so this is the one construct here not
  # certified by example. It degrades to an empty table, never to an error.
  - type: table
    name: ProjectFeed
    limit: 300
    filters:
      and:
        - 'note.project == this.project'
    groupBy:
      property: note.source_type
      direction: ASC
    order:
      - file.name
      - note.date
      - note.source_type
      - note.edge_count

  # Embed in any hub note: ![[Memories.base#Members]]
  # Everything whose links point at the embedding note. The \`up:\` wikilink
  # lives in frontmatter and file.links includes frontmatter links, so a
  # community hub gets its membership without the hub listing anything.
  - type: table
    name: Members
    filters:
      and:
        - file.hasLink(this.file)
    groupBy:
      property: note.source_type
      direction: ASC
    order:
      - file.name
      - note.date
      - note.source_type
`;
}

// ── .obsidian/graph.json ───────────────────────────────────────────────────
//
// A fresh export should open as named neighborhoods, not a hairball. Graph
// pruning is subtractive: hide orphans, drop whole classes by path, colour by
// type, and let the layout physics do the clustering.
//
// Shape and key names are taken from a real Obsidian-written graph.json rather
// than invented, so an unknown key cannot silently void the file.
//
// WRITE-IF-MISSING, and never manifest-tracked (see UNTRACKED_PREFIXES). Graph
// tuning is hand work; an export that reset it every night would be worse than
// one that never wrote it at all.
function renderGraphDefaults() {
  // Colours are rgb packed as a single integer, matching Obsidian's own
  // serialization: 0x9D7CFF violet, 0xFF8F8F salmon, 0xFFC86B amber,
  // 0x7EE0A3 mint, 0x4FD1E0 cyan, 0xC98FFF orchid, 0x8A8F98 slate.
  const group = (query, rgb) => ({ query, color: { a: 1, rgb } });
  return {
    'collapse-filter': false,
    // The one-clause payoff of routing snapshots into their own folder: 1,142
    // bulk nodes leave the graph without enumerating source types.
    search: '-path:snapshots',
    showTags: false,
    showAttachments: false,
    hideUnresolved: true,
    // "A note without links is a bug" — hiding orphans makes the remaining
    // ones the story rather than the background.
    showOrphans: false,
    'collapse-color-groups': false,
    colorGroups: [
      // Hubs first so they read as the anchors of their neighbourhoods.
      group('tag:#type/consolidation_summary', 5231072),
      group('tag:#type/decision', 10321151),
      group('tag:#type/bug_fix', 16748431),
      group('tag:#type/architecture', 16762987),
      group('tag:#type/session_summary', 8315043),
      group('tag:#type/preference', 13209599),
      group('tag:#type/fact', 9080728),
    ],
    'collapse-display': false,
    showArrow: true,
    textFadeMultiplier: -1.3,
    nodeSizeMultiplier: 1.15,
    lineSizeMultiplier: 1,
    'collapse-forces': false,
    centerStrength: 0.4,
    repelStrength: 12,
    linkStrength: 1,
    linkDistance: 120,
    scale: 0.6,
    close: false,
  };
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
    // `id` is a tiebreak, not decoration: rows sharing a created_at would
    // otherwise come back in whatever order Postgres felt like, and the
    // generated index notes (newest-first lists, hub iteration) would differ
    // between two exports of an unchanged store.
    let sql = `select id, content, source_type, category, project, metadata, privacy_tags,
                      source_agent, created_at
                 from memory_items
                where ${where}
                order by created_at, id`;
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
    // Names, with cross-folder basename collisions resolved. Obsidian resolves
    // `[[name]]` by basename, so once notes live in several folders a duplicate
    // name silently sends every inbound link to whichever file won.
    const nameOf = buildNameMap(memories);

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

    // Pass 1 of 2. Every note's membership must be known before any note is
    // written, because the containment edge is rendered from both ends.
    const topology = buildTopology(memories, nameOf);
    const index = buildIndexView(memories, nameOf, topology);

    const stats = {
      dir: targetDir,
      notes: memories.length,
      edges: edgeRes.rows.length,
      excluded_privacy: excludedPrivacy,
      dangling_members: topology.danglingMembers,
      newest: index.newest,
      oldest: index.oldest,
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
          // R-1 exclusion, enforcement layer 2 of 2. Even if a past release —
          // or a hand-edited marker — names `.obsidian/graph.json` in the
          // manifest, the sweep will not delete it. Write-if-missing is only a
          // real guarantee if the unlink pass honours it too.
          if (isUntracked(rel)) continue;
          const abs = path.join(targetDir, rel);
          // Never follow a path outside the vault, whatever the marker says.
          if (abs.startsWith(targetDir + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
        }
      } catch (err) {
        console.warn(`[vault] could not read prior manifest (${err.message}) — leaving existing files in place`);
      }
    }

    // Every generated file goes through this one helper. Regeneration is a
    // manifest sweep (unlink what the last run recorded, then write), so a
    // file written outside `written[]` becomes an orphan the next run cannot
    // clean up — and a file whose path changes between releases becomes a
    // stale duplicate. Both failure modes are avoided by never writing except
    // through here.
    const written = [];
    const emit = (rel, contents) => {
      const abs = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents, 'utf8');
      written.push(rel);
    };

    for (const memory of memories) {
      emit(
        relPathFor(memory, nameOf),
        renderNote(memory, edgesByMemory.get(memory.id) || [], nameOf, topology),
      );
    }

    // The index layer. Regenerated wholesale every run — these are maps of
    // what the store currently contains, and a stale map is worse than none.
    // Sprint 71 B-T2 — tier-0 for the index layer. One query for the export's
    // scope (Home) plus one per project (the MOCs). Objectives number in the
    // handful per project by design, so this is cheap; if a store ever makes it
    // expensive, that is itself the signal that tier 0 has stopped being tier 0.
    const homeTier0 = await fetchTier0FromPg(client, project || null);
    const mocTier0 = new Map();
    for (const p of index.projects) {
      mocTier0.set(p.slug, await fetchTier0FromPg(client, p.project));
    }

    emit(HOME_FILE, renderHome({
      stats,
      tier0: homeTier0,
      hubs: index.hubs,
      projects: index.projects,
      recent: index.recent,
      doctrine: index.doctrine,
    }));
    for (const p of index.projects) {
      emit(path.join(MOC_DIR, `${p.moc_name}.md`), renderMoc({
        project: p.project,
        slug: p.slug,
        tier0: mocTier0.get(p.slug) || [],
        hubs: p.hubs,
        recent: p.recent,
        count: p.count,
      }));
    }

    // The reading surface. Nine thousand notes is well past the point where
    // anyone browses files, and Bases is a CORE plugin, so this costs the
    // reader zero installs. Manifest-tracked like any other generated file.
    emit(BASES_FILE, renderMemoriesBase());

    fs.writeFileSync(path.join(targetDir, 'README.md'), renderVaultReadme(stats), 'utf8');
    written.push('README.md');

    // Graph defaults — WRITE-IF-MISSING, and deliberately NOT routed through
    // `emit()`. Graph tuning is hand work; an export that reset it nightly
    // would be worse than one that never wrote it at all. R-1 enforcement
    // layer 1 of 2: the tracked-write path (`emit`) and the user-tunable path
    // (`writeIfMissing`) are different functions, and only the former can
    // reach `written[]`.
    const wroteGraph = writeIfMissing(
      path.join(targetDir, '.obsidian', 'graph.json'),
      JSON.stringify(renderGraphDefaults(), null, 2) + '\n',
    );

    // Re-foldering leaves the previous layout's directories behind, empty, and
    // a stale empty folder in the sidebar reads as "this project vanished".
    // Only ever removes directories that are ALREADY empty, so a file the user
    // put anywhere beneath one keeps the whole branch alive.
    pruneEmptyDirs(targetDir);

    fs.writeFileSync(markerPath, JSON.stringify({
      marker: 'termdeck-vault',
      version: MARKER_VERSION,
      read_only: true,
      generated_at: stats.generated_at,
      generator: 'termdeck vault export',
      counts: {
        notes: stats.notes,
        edges: stats.edges,
        withheld_privacy: excludedPrivacy,
        hubs: index.hubs.length,
        mocs: index.projects.length,
        dangling_members: topology.danglingMembers,
      },
      // R-1 enforcement layer 2 of 2. A path in this array is a path the NEXT
      // run deletes, so anything the user is invited to tune must never reach
      // it — not by convention, but because it is filtered out here regardless
      // of how it got into `written[]`.
      files: written.filter((rel) => !isUntracked(rel)),
    }, null, 2) + '\n', 'utf8');

    console.log(`[vault] wrote ${stats.notes} note(s) + Home + ${index.projects.length} project map(s) + README to ${targetDir}`);
    console.log(`[vault] ${stats.edges} live edge reference(s) rendered as wikilinks`);
    console.log(`[vault] ${index.hubs.length} community hub(s) linked to their members`);
    console.log('[vault] Memories.base written — open it for dashboards (Bases is a core plugin; no install needed)');
    console.log(wroteGraph
      ? '[vault] .obsidian/graph.json written — orphans hidden, snapshots filtered out, colour by type'
      : '[vault] .obsidian/graph.json already present — left byte-untouched; your graph tuning is never overwritten');
    if (topology.danglingMembers > 0) {
      // Counted, never linked. A wikilink to a note this export did not write
      // shows up in Obsidian as a broken link and reads as corruption.
      console.log(`[vault] ${topology.danglingMembers} community member(s) fall outside this export's scope — counted, not linked`);
    }
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
module.exports.noteTitle = noteTitle;
module.exports.noteAliases = noteAliases;
module.exports.tagSlug = tagSlug;
module.exports.relPathFor = relPathFor;
module.exports.buildTopology = buildTopology;
module.exports.buildIndexView = buildIndexView;
module.exports.mocNameFor = mocNameFor;
module.exports.renderNote = renderNote;
module.exports.renderHome = renderHome;
module.exports.renderMoc = renderMoc;
module.exports.renderVaultReadme = renderVaultReadme;
// Sprint 71 B-T2 — tier-0 vault render surface.
module.exports.tier0Section = tier0Section;
module.exports.fetchTier0FromPg = fetchTier0FromPg;
module.exports.parseFlags = parseFlags;
module.exports.MARKER_FILE = MARKER_FILE;
module.exports.MOC_DIR = MOC_DIR;
module.exports.HOME_FILE = HOME_FILE;
module.exports.EDGE_SECTION_ORDER = EDGE_SECTION_ORDER;
// Sprint 69 T2 — projection surfaces.
module.exports.routeFor = routeFor;
module.exports.projectSegment = projectSegment;
module.exports.buildNameMap = buildNameMap;
module.exports.renderMemoriesBase = renderMemoriesBase;
module.exports.renderGraphDefaults = renderGraphDefaults;
module.exports.writeIfMissing = writeIfMissing;
module.exports.isUntracked = isUntracked;
module.exports.pruneEmptyDirs = pruneEmptyDirs;
module.exports.UNTRACKED_PREFIXES = UNTRACKED_PREFIXES;
module.exports.DATE_PREFIXED_TYPES = DATE_PREFIXED_TYPES;
module.exports.SNAPSHOT_TYPES = SNAPSHOT_TYPES;
module.exports.GENERATED_DIRS = GENERATED_DIRS;
