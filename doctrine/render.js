'use strict';

// TermDeck Doctrine — pure rendering + deterministic naming.
//
// Sprint 81 T4: extracted VERBATIM from packages/server/src/doctrine-sync.js
// (Sprint 79) so BOTH the server materializer (doctrine-sync.js) AND the CLI
// (packages/cli/src/doctrine-cli.js) share ONE copy of the row -> names /
// markdown / registry-entry logic, instead of the CLI reaching through
// doctrine-sync's git/pg/timer surface for it. doctrine-sync.js now requires +
// re-exports every symbol here, so existing `docSync.<fn>` callers keep
// resolving unchanged (a pure move — zero behavior change).
//
// ZERO non-builtin deps (no fs/path/os/child_process, no ../index) — this is
// pure string / deterministic-id computation, hence its own module. Companion
// to doctrine/index.js (the loader/validator) and doctrine/checks.js (the
// doctrine-doc structural checks). Ships in the npm tarball via package.json
// `files` (listed explicitly — the `files` array has NO doctrine/** glob).
//
// NOTE on `new Date()` in renderDoctrineMarkdown: the rendered doc's
// `created_at` is intentionally clock-stamped and is PRE-EXISTING behavior.
// The NAMES (branch / doc path / entry id) are the clock-free, recomputable
// part — see the shortId comment. `Date` is a global builtin, so this file
// stays zero-require.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function slugify(s) {
  const out = String(s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'untitled';
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str;
}

// Short, DETERMINISTIC id derived from the rumen doctrine_registry row's own
// UUID — never a cycle-time value (Date.now() et al). This is load-bearing:
// there is no `pr_url` column on rumen's doctrine_registry (verified against
// rumen/migrations/004_doctrine_registry.sql), so `termdeck doctrine ratify`
// must be able to RECOMPUTE the exact same branch name / doc path / registry
// entry id later from nothing but the row's (id, title) to find its PR via
// `gh pr list --head <branch>` — a value seeded from "when the cycle ran"
// could never be reconstructed after the fact.
function shortId(rowId) {
  return String(rowId || '').replace(/-/g, '').slice(0, 8) || 'unknown0';
}

function branchNameFor(row) {
  return `doctrine/${shortId(row.id)}-${slugify(row.title)}`;
}
function docRelPathFor(row) {
  return `docs/doctrine/D-${shortId(row.id)}-${slugify(row.title)}.md`;
}
function registryEntryIdFor(row) {
  return `doctrine-scan-${shortId(row.id)}`;
}

// ---------------------------------------------------------------------------
// Rendering — the materialized docs/doctrine/D-<id>-<slug>.md body. Front-matter
// + Principle / Why-evidence-ledger / How-to-apply / Machine-checkable-hook /
// Provenance (the shape doctrine/checks.js validates).
// ---------------------------------------------------------------------------

function renderDoctrineMarkdown(row) {
  const title = row.title || 'Untitled doctrine';
  const principle = truncate(row.doctrine_text || title, 200);
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const evidenceLines = evidence.length
    ? evidence.map((e) => `- ${(e && e.date) || '?'} — ${(e && e.gist) || ''}`).join('\n')
    : '- (no evidence entries recorded)';
  const projectsList = Array.isArray(row.projects) ? row.projects : [];
  const triggerHints = Array.isArray(row.trigger_hints) ? row.trigger_hints : [];

  const front = [
    '---',
    `id: D-${shortId(row.id)}`,
    `title: ${JSON.stringify(title)}`,
    'status: proposed',
    'source: rumen-doctrine-scan',
    `occurrence_count: ${Number(row.occurrence_count) || 0}`,
    `projects: [${projectsList.map((p) => JSON.stringify(p)).join(', ')}]`,
    `rumen_doctrine_registry_id: ${row.id}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${title}`,
    '',
    '## Principle',
    '',
    principle,
    '',
    '## Why (evidence ledger)',
    '',
    evidenceLines,
    '',
    `Occurrence count: ${Number(row.occurrence_count) || 0}. Projects: ${projectsList.join(', ') || '(none recorded)'}.`,
    '',
    '## How to apply',
    '',
    row.doctrine_text || '(see Principle above)',
    '',
    '## Machine-checkable hook',
    '',
    triggerHints.length
      ? `${triggerHints.map((h) => `- ${h}`).join('\n')}\n\n(shadow-mode only — not yet injected into recall/advisory paths; logged as doctrine_hits pre-ratification, per AMEND-7.)`
      : '(no trigger hints synthesized this pass — advisory-only until a future doctrine-scan adds them.)',
    '',
    '## Provenance',
    '',
    `rumen doctrine_registry id: \`${row.id}\``,
    `synthesized_at: ${row.synthesized_at || '(unknown)'}`,
    `origin: ${row.origin || 'doctrine-scan'}`,
    '',
    '---',
    '_Auto-materialized by `packages/server/src/doctrine-sync.js` (Sprint 79). Reviewer: is this ONE principle, not several fused together? Do the evidence dates/gists actually support it?_',
  ].join('\n');

  return front + body + '\n';
}

// Registry entry to append to doctrine/registry.jsonl. MUST pass
// doctrine.validateEntry() before being written — callers check.
function buildRegistryEntry(row, docRelPath) {
  const title = row.title || 'Untitled doctrine';
  const projectsList = Array.isArray(row.projects) ? row.projects : [];
  return {
    id: registryEntryIdFor(row),
    title,
    severity: 'medium',
    scope: 'universal',
    audience: 'all',
    trigger: 'always',
    check: { type: 'manual' },
    enforcement: { surface: 'inject-advisory', max_severity: 'warn', ref: docRelPath },
    source: {
      incident: `Elevated from ${Number(row.occurrence_count) || 0} reinforcement(s) across ${projectsList.length} project(s) by Sprint 79 doctrine-scan.`,
      memory_recall_query: `memory_recall(query="${slugify(title).replace(/-/g, ' ')}")`,
    },
    advisory: {
      one_line: truncate(row.doctrine_text || title, 200),
      procedure_path: docRelPath,
      cooldown_hours: 24,
    },
    status: 'proposed',
    version: 1,
  };
}

module.exports = {
  slugify,
  truncate,
  shortId,
  branchNameFor,
  docRelPathFor,
  registryEntryIdFor,
  renderDoctrineMarkdown,
  buildRegistryEntry,
};
