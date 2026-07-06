'use strict';

// TermDeck Doctrine — structural checks for materialized doctrine docs.
//
// Sprint 81 T4 (STARTER subset). The full 13-check battery is deferred to the
// Sprint 80 "doc-enforcement" sprint (ULTRAPLAN §6 line 200:
//   status-lint · checkpoint-cadence · done-periphery · anchor-check ·
//   publish-order · in-glob · tarball · rls-audit ×5 · htmlbody).
// This sprint ships the two most foundational structural checks — the ones
// every doctrine doc must pass before any of the above make sense:
//   1. frontmatter-present   — the doc opens with a well-formed front-matter
//                              block carrying the required doctrine-doc keys.
//   2. one-principle-shape   — exactly ONE `## Principle` section, non-empty
//                              (it's ONE principle, not several fused — the
//                              reviewer question renderDoctrineMarkdown poses).
// The remainder are named in DEFERRED_CHECKS below so a coverage report can't
// lie by omission (the `check.type='manual'` honesty principle from
// doctrine/SCHEMA.md, applied to the checks suite itself).
//
// Contract: the doctrine-doc front-matter shape is documented in
// doctrine/SCHEMA.md § "Doctrine document front-matter (rendered docs)". These
// checks validate a doc against THAT contract; doctrine/render.js emits it.
//
// Hard rules (mirrors doctrine/index.js): vanilla JS / CommonJS / ZERO
// non-builtin deps (this file requires nothing — it operates on a markdown
// STRING, never the filesystem; a caller reads the file and passes the text).
// FAIL-SOFT: no check throws — an internal error degrades to a failed result
// with the error attached, never crashes the caller (a checks run rides CI /
// authoring paths). NO work at require() time (requiring only defines fns).

// The doctrine-doc front-matter keys renderDoctrineMarkdown emits. The first
// three are REQUIRED (identity + lifecycle); the rest are provenance and
// optional for the presence check. Kept in lockstep with render.js by the
// SCHEMA.md contract + the doctrine-render/checks tests.
const REQUIRED_FRONTMATTER_KEYS = ['id', 'title', 'status'];
const KNOWN_FRONTMATTER_KEYS = [
  'id', 'title', 'status', 'source', 'occurrence_count',
  'projects', 'rumen_doctrine_registry_id', 'created_at',
];

// The rest of the 13-check battery (ULTRAPLAN §6 L200) — declared, not yet
// implemented, so `runChecks` can report honest coverage. Target: Sprint 80.
const DEFERRED_CHECKS = [
  'status-lint', 'checkpoint-cadence', 'done-periphery', 'anchor-check',
  'publish-order', 'in-glob', 'tarball',
  'rls-gate-enabled', 'rls-gate-no-public-write', 'rls-gate-revoke-execute',
  'rls-gate-search-path', 'rls-gate-no-anon-write',
  'htmlbody',
];

// ---------------------------------------------------------------------------
// Front-matter parser — the flat `key: value` shape renderDoctrineMarkdown
// emits (NOT a general YAML parser; zero-dep, line-based). Returns
// { ok, data?, body?, raw?, reason? }. Never throws.
// ---------------------------------------------------------------------------

function parseFrontmatter(markdown) {
  try {
    const text = String(markdown == null ? '' : markdown);
    // Must open with a `---` fence on the very first line (normalize CRLF).
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines[0].trim() !== '---') {
      return { ok: false, reason: 'no opening front-matter fence (first line is not `---`)' };
    }
    // Find the closing fence.
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { closeIdx = i; break; }
    }
    if (closeIdx === -1) {
      return { ok: false, reason: 'front-matter block is not closed (no second `---`)' };
    }
    const data = {};
    for (let i = 1; i < closeIdx; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const sep = line.indexOf(':');
      if (sep === -1) continue; // tolerate stray lines
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim();
      if (key) data[key] = value;
    }
    const body = lines.slice(closeIdx + 1).join('\n');
    return { ok: true, data, body, raw: lines.slice(1, closeIdx).join('\n') };
  } catch (err) {
    return { ok: false, reason: `front-matter parse errored: ${err && err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Checks. Each returns { id, pass, severity, message }. Never throws.
// ---------------------------------------------------------------------------

function checkFrontmatterPresent(markdown) {
  const id = 'frontmatter-present';
  const severity = 'high';
  try {
    const fm = parseFrontmatter(markdown);
    if (!fm.ok) {
      return { id, pass: false, severity, message: `no valid front-matter: ${fm.reason}` };
    }
    const missing = REQUIRED_FRONTMATTER_KEYS.filter((k) => !fm.data[k] || fm.data[k] === '');
    if (missing.length) {
      return { id, pass: false, severity, message: `front-matter missing required key(s): ${missing.join(', ')}` };
    }
    return { id, pass: true, severity, message: `front-matter present with ${REQUIRED_FRONTMATTER_KEYS.join('/')}` };
  } catch (err) {
    return { id, pass: false, severity, message: `check errored (treated as fail): ${err && err.message}` };
  }
}

function checkOnePrincipleShape(markdown) {
  const id = 'one-principle-shape';
  const severity = 'medium';
  try {
    const text = String(markdown == null ? '' : markdown).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    // Exact level-2 heading `## Principle` (not `## Principles`, not inline).
    const principleIdxs = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Principle\s*$/.test(lines[i])) principleIdxs.push(i);
    }
    if (principleIdxs.length === 0) {
      return { id, pass: false, severity, message: 'no `## Principle` section (a doctrine doc must state exactly one principle)' };
    }
    if (principleIdxs.length > 1) {
      return { id, pass: false, severity, message: `${principleIdxs.length} "## Principle" sections — a doctrine doc must be ONE principle, not several fused` };
    }
    // Non-empty: at least one non-blank line before the next `## ` heading.
    const start = principleIdxs[0] + 1;
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { end = i; break; }
    }
    const hasBody = lines.slice(start, end).some((l) => l.trim() !== '');
    if (!hasBody) {
      return { id, pass: false, severity, message: '`## Principle` section is empty' };
    }
    return { id, pass: true, severity, message: 'exactly one non-empty `## Principle` section' };
  } catch (err) {
    return { id, pass: false, severity, message: `check errored (treated as fail): ${err && err.message}` };
  }
}

// The starter suite, in run order.
const STARTER_CHECKS = [checkFrontmatterPresent, checkOnePrincipleShape];

// Run the starter suite over one doctrine-doc markdown string. Returns
// { ok, results, deferred } — ok is true iff every starter check passed.
// `deferred` surfaces the not-yet-implemented battery so coverage is honest.
function runChecks(markdown, opts = {}) {
  const checks = (opts && Array.isArray(opts.checks)) ? opts.checks : STARTER_CHECKS;
  const results = checks.map((fn) => {
    try {
      return fn(markdown);
    } catch (err) {
      // Belt-and-suspenders: individual checks already catch, but a bad
      // custom `opts.checks` entry must never crash the run.
      return { id: (fn && fn.name) || 'unknown-check', pass: false, severity: 'high', message: `check threw: ${err && err.message}` };
    }
  });
  return {
    ok: results.every((r) => r.pass),
    results,
    deferred: DEFERRED_CHECKS.slice(),
  };
}

module.exports = {
  parseFrontmatter,
  checkFrontmatterPresent,
  checkOnePrincipleShape,
  runChecks,
  STARTER_CHECKS,
  DEFERRED_CHECKS,
  REQUIRED_FRONTMATTER_KEYS,
  KNOWN_FRONTMATTER_KEYS,
};
