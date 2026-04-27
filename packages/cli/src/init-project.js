#!/usr/bin/env node

// `termdeck init --project <name>` — Sprint 37 T2.
//
// Scaffolds a new project directory with the orchestration patterns TermDeck
// itself uses: CLAUDE.md (router), CONTRADICTIONS.md (audit trail),
// project_facts.md (stable facts), README.md, docs/orchestration/ (sprint +
// restart-prompt scaffolding), .claude/settings.json (sensible permission
// defaults), and .gitignore. All content comes from packages/cli/templates/
// rendered with {{placeholder}} substitution via packages/cli/src/templates.js.
//
// Public API (used by the CLI entry and by tests):
//   initProject({ name, dryRun, force, cwd }) -> Promise<{ exitCode, files }>
//
// CLI shim (used by index.js dispatch):
//   main(argv)                                -> Promise<exitCode>
//
// `argv` here is everything AFTER `init --project` in the original argv —
// i.e. for `termdeck init --project hello --dry-run`, argv is
// `['hello', '--dry-run']`.

'use strict';

const fs = require('fs');
const path = require('path');

const { listTemplates, renderTemplate, TEMPLATES_DIR } = require(path.join(__dirname, 'templates.js'));

// Project name validation: lowercase letters, digits, hyphens, optional
// scoped prefix (@org/name) is intentionally NOT supported here — the user
// would clone the result and rename if they want a scoped npm package.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return 'Project name is required.';
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return `Project name "${name}" must not contain slashes or "..".`;
  }
  if (!NAME_RE.test(name)) {
    return `Project name "${name}" must be lowercase letters, digits, and hyphens (no leading/trailing hyphen).`;
  }
  return null;
}

function readTermdeckVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json'));
    return pkg.version || '0.0.0';
  } catch (_e) {
    return '0.0.0';
  }
}

function buildVars({ name, projectPath }) {
  return {
    project_name: name,
    project_path: projectPath,
    generated_at: new Date().toISOString(),
    termdeck_version: readTermdeckVersion(),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Returns true if the directory either does not exist or exists and is empty.
function isEmptyOrMissing(dir) {
  if (!fs.existsSync(dir)) return true;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(dir).length === 0;
}

function previewSnippet(content, headLines = 5) {
  const lines = content.split('\n');
  const head = lines.slice(0, headLines).join('\n');
  const remaining = Math.max(0, lines.length - headLines);
  return remaining === 0 ? head : `${head}\n... (${remaining} more line${remaining === 1 ? '' : 's'})`;
}

async function initProject(opts) {
  const { name, dryRun = false, force = false, cwd = process.cwd() } = opts || {};

  const nameError = validateName(name);
  if (nameError) {
    process.stderr.write(`\n  ✗ ${nameError}\n\n`);
    return { exitCode: 1, files: [] };
  }

  const projectPath = path.resolve(cwd, name);

  if (!dryRun && !force && !isEmptyOrMissing(projectPath)) {
    process.stderr.write(`\n  ✗ Target ${projectPath} exists and is not empty. Use --force to overwrite, or pick a new name.\n\n`);
    return { exitCode: 1, files: [] };
  }

  const vars = buildVars({ name, projectPath });
  const templates = listTemplates();
  const written = [];

  if (dryRun) {
    process.stdout.write(`\n  [dry-run] Would create ${projectPath}/ with ${templates.length} files:\n\n`);
  } else {
    ensureDir(projectPath);
  }

  for (const entry of templates) {
    const dest = path.join(projectPath, entry.targetPath);
    const rendered = renderTemplate(entry.name, vars);

    if (dryRun) {
      process.stdout.write(`  • ${entry.targetPath}\n`);
      const indented = previewSnippet(rendered).split('\n').map((l) => `      ${l}`).join('\n');
      process.stdout.write(`${indented}\n\n`);
      written.push({ template: entry.file, name: entry.name, dest, bytes: Buffer.byteLength(rendered, 'utf8') });
      continue;
    }

    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, rendered);
    written.push({ template: entry.file, name: entry.name, dest, bytes: Buffer.byteLength(rendered, 'utf8') });
  }

  if (dryRun) {
    process.stdout.write(`  [dry-run] Nothing was written. Re-run without --dry-run to scaffold.\n\n`);
  } else {
    process.stdout.write(`
  Created ${name}/ at ${projectPath}.

  Next steps:
    cd ${name}
    git init
    # Open ${name}/ in TermDeck — it will pick up the .claude/settings.json automatically.
    # Read CLAUDE.md to see the agent read-order for this project.

`);
  }

  return { exitCode: 0, files: written };
}

// CLI shim. Parses argv and calls initProject(). The dispatch in
// packages/cli/src/index.js strips the leading `init --project` tokens.
async function main(argv) {
  const args = argv || [];

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  // First positional argument that isn't a flag is the project name.
  let name = null;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--dry-run') { dryRun = true; continue; }
    if (tok === '--force') { force = true; continue; }
    if (tok === '--name' && args[i + 1]) { name = args[i + 1]; i++; continue; }
    if (tok.startsWith('--')) {
      process.stderr.write(`\n  ✗ Unknown flag: ${tok}\n${HELP}`);
      return 1;
    }
    if (name === null) {
      name = tok;
      continue;
    }
    process.stderr.write(`\n  ✗ Unexpected extra argument: ${tok}\n${HELP}`);
    return 1;
  }

  if (!name) {
    process.stderr.write(`\n  ✗ Missing project name.\n${HELP}`);
    return 1;
  }

  const { exitCode } = await initProject({ name, dryRun, force, cwd: process.cwd() });
  return exitCode;
}

const HELP = `
TermDeck Project Scaffolder

Usage: termdeck init --project <name> [flags]

Flags:
  --dry-run          Print what would be created; write nothing
  --force            Overwrite an existing non-empty target directory
  --help, -h         Print this message and exit

What this does:
  Creates <name>/ in the current directory with a project skeleton:
    CLAUDE.md                  Agent read-order router
    CONTRADICTIONS.md          Audit trail of changed facts/decisions
    project_facts.md           Stable per-project facts
    README.md                  Human-facing intro
    docs/orchestration/        Sprint + restart-prompt scaffolding
    .claude/settings.json      Sensible Claude Code permission defaults
    .gitignore                 Standard Node + .DS_Store + .termdeck/

Templates live in packages/cli/templates/ and use {{placeholder}} substitution.
`;

module.exports = main;
module.exports.initProject = initProject;
module.exports._validateName = validateName;
module.exports._buildVars = buildVars;
module.exports.TEMPLATES_DIR = TEMPLATES_DIR;
