'use strict';

// Sprint 37 T2 — Shared template loader.
//
// `init-project.js` (T2) and the dashboard orchestration-preview endpoint (T3)
// both render the same set of project-scaffolding templates. This module is
// the single source of truth for where they live, what they're named, what
// dest path they map to inside a generated project tree, and how
// `{{placeholder}}` substitution works.
//
// Naming convention for templates in packages/cli/templates/:
//   - Files are flat in this dir (no subdirs).
//   - Subdirectory placement in the GENERATED project tree is encoded by a
//     hyphenated prefix (e.g. `docs-orchestration-README.md.tmpl` lands at
//     `docs/orchestration/README.md`). The MANIFEST below is the only
//     authoritative source for those mappings — the `name` field is the
//     human-readable identifier used in tests and UI, the `file` field is
//     the on-disk template filename, and `targetPath` is the dest path
//     RELATIVE to the project root.

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// The 8 templates that compose the project-scaffolding tree. Order is the
// order the init-project generator writes them and the order the dashboard
// preview surfaces them. T3 — iterate this directly via listTemplates().
const MANIFEST = [
  { name: 'CLAUDE.md',                     file: 'CLAUDE.md.tmpl',                     targetPath: 'CLAUDE.md' },
  { name: 'CONTRADICTIONS.md',             file: 'CONTRADICTIONS.md.tmpl',             targetPath: 'CONTRADICTIONS.md' },
  { name: 'project_facts.md',              file: 'project_facts.md.tmpl',              targetPath: 'project_facts.md' },
  { name: 'README.md',                     file: 'README.md.tmpl',                     targetPath: 'README.md' },
  { name: 'docs/orchestration/README.md',  file: 'docs-orchestration-README.md.tmpl',  targetPath: path.join('docs', 'orchestration', 'README.md') },
  { name: 'docs/orchestration/RESTART-PROMPT.md.tmpl', file: 'RESTART-PROMPT.md.tmpl', targetPath: path.join('docs', 'orchestration', 'RESTART-PROMPT.md.tmpl') },
  { name: '.claude/settings.json',         file: '.claude-settings.json.tmpl',         targetPath: path.join('.claude', 'settings.json') },
  { name: '.gitignore',                    file: '.gitignore.tmpl',                    targetPath: '.gitignore' },
];

// name → manifest entry, for callers that want lookup by name (T3's preview UI).
const BY_NAME = Object.fromEntries(MANIFEST.map((e) => [e.name, e]));

// Replace {{key}} occurrences with vars[key]. Unknown keys are left untouched
// so a typo is visible in the output rather than silently rendering empty.
function renderString(source, vars) {
  return source.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    return match;
  });
}

// Resolve a caller-supplied identifier to a manifest entry. Accepts the
// human-readable `name` ('CLAUDE.md') OR the on-disk template filename
// ('CLAUDE.md.tmpl') so both conventions work from caller code.
function resolveEntry(identifier) {
  const direct = BY_NAME[identifier];
  if (direct) return direct;
  const byFile = MANIFEST.find((e) => e.file === identifier);
  if (byFile) return byFile;
  throw new Error(`Unknown template: ${identifier}`);
}

function readTemplate(identifier) {
  const entry = resolveEntry(identifier);
  return fs.readFileSync(path.join(TEMPLATES_DIR, entry.file), 'utf8');
}

function renderTemplate(identifier, vars) {
  return renderString(readTemplate(identifier), vars || {});
}

// Returns the manifest entries (cloned so callers can't mutate state).
function listTemplates() {
  return MANIFEST.map((e) => ({ ...e }));
}

module.exports = {
  TEMPLATES_DIR,
  MANIFEST,
  readTemplate,
  renderTemplate,
  listTemplates,
  _renderString: renderString,
};
