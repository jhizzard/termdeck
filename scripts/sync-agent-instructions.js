#!/usr/bin/env node
// Sprint 44 T2 — sync agent instruction mirrors from CLAUDE.md.
//
// CLAUDE.md is the canonical project-level instruction file. Codex CLI and
// Grok CLI both read AGENTS.md; Gemini CLI reads GEMINI.md. To keep all three
// agents aligned without hand-syncing three files, this script reads
// CLAUDE.md and emits the two mirrors with an auto-generated banner and an
// agent-specific lead-in note.
//
// Run:  npm run sync:agents
//   or: node scripts/sync-agent-instructions.js
//
// Module API (consumed by tests/sync-agent-instructions.test.js):
//   const { buildMirror, syncAll, BANNER, MIRRORS } = require('./sync-agent-instructions');
//
// Idempotent: re-running on already-synced files leaves them byte-identical.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BANNER =
  '<!-- AUTO-GENERATED from CLAUDE.md by sync-agent-instructions.js. Do not edit directly. -->';

const MIRRORS = {
  AGENTS: {
    lead: 'For Codex CLI and Grok CLI users — content mirrors CLAUDE.md.',
  },
  GEMINI: {
    lead: 'For Gemini CLI users — content mirrors CLAUDE.md.',
  },
};

const REPO_ROOT = path.resolve(__dirname, '..');

function buildMirror(canonical, lead) {
  if (typeof canonical !== 'string') {
    throw new TypeError('buildMirror: canonical must be a string');
  }
  if (typeof lead !== 'string' || lead.length === 0) {
    throw new TypeError('buildMirror: lead must be a non-empty string');
  }
  return `${BANNER}\n\n> ${lead}\n\n${canonical}`;
}

function syncAll({ repoRoot = REPO_ROOT, mirrors = MIRRORS, log = () => {} } = {}) {
  const canonicalPath = path.join(repoRoot, 'CLAUDE.md');
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(
      `sync-agent-instructions: canonical CLAUDE.md not found at ${canonicalPath}`
    );
  }
  const canonical = fs.readFileSync(canonicalPath, 'utf-8');

  const written = [];
  const unchanged = [];
  for (const [name, { lead }] of Object.entries(mirrors)) {
    const target = path.join(repoRoot, `${name}.md`);
    const next = buildMirror(canonical, lead);
    const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
    if (prev === next) {
      unchanged.push(target);
      log(`= unchanged ${path.relative(repoRoot, target)} (${next.length} bytes)`);
    } else {
      fs.writeFileSync(target, next);
      written.push(target);
      log(`✓ wrote ${path.relative(repoRoot, target)} (${next.length} bytes)`);
    }
  }
  return { written, unchanged, canonicalPath };
}

if (require.main === module) {
  try {
    const { written, unchanged } = syncAll({ log: (m) => console.log(m) });
    if (written.length === 0) {
      console.log(`sync-agent-instructions: ${unchanged.length} mirror(s) already up to date.`);
    } else {
      console.log(`sync-agent-instructions: wrote ${written.length}, unchanged ${unchanged.length}.`);
    }
  } catch (err) {
    console.error(`sync-agent-instructions: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { buildMirror, syncAll, BANNER, MIRRORS };
