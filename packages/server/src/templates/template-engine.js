'use strict';

// Sprint 69 T1 — boot-prompt template engine.
//
// Looks up templates by (cliType × role), substitutes {{variable}} tokens,
// and returns the paste-ready string. Default templates ship in
// packages/server/share/termdeck/templates/. A per-file override at
// ~/.termdeck/templates/<cli>-<role>.txt wins when present so projects can
// customise without forking the package.
//
// Public contract (consumed by T2's POST /api/sprints/inject handler):
//   loadTemplate(cliType, role, variables) -> string
//     Throws TemplateNotFoundError if neither override nor default exists.
//     Throws MissingVariableError if any {{var}} would be left unsubstituted;
//     the error's `missingVariables` array names every unfilled token (not
//     just the first) so callers can validate the whole template in one pass.
//   requiredVariables(cliType, role) -> string[]
//     Pre-scans a template for {{var}} tokens; lets the inject endpoint
//     validate the request body before rendering.
//
// Token grammar: /\{\{(\w+)\}\}/g — flat names, no whitespace, no dotted
// paths. Deliberately simpler than the Sprint 47 boot-prompt-resolver (which
// supported `{{lane.tag}}`) so the inject body shape stays flat and the
// failure mode (unsubstituted token left in the rendered output) is easy to
// reason about.
//
// Override-directory resolution order:
//   1. process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR (set in tests; also usable
//      for system-wide installs e.g. /etc/termdeck/templates/).
//   2. ~/.termdeck/templates/ — the documented per-user override location.
//   3. <repo>/packages/server/share/termdeck/templates/ — the in-package
//      defaults that ship with @jhizzard/termdeck.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SUPPORTED_CLI_TYPES = Object.freeze(['claude-code', 'codex', 'gemini', 'grok']);
const SUPPORTED_ROLES = Object.freeze(['worker', 'auditor', 'orchestrator']);

// Filename convention: `<cliType>-<role>.txt`. `cliType` is the literal
// session-manager `meta.type` value (verified at session.js:165 — the
// canonical types are 'shell' / 'claude-code' / 'gemini' / 'python-server' /
// 'one-shot'). No aliasing layer — per the [ORCH] RULING 2026-05-20 13:13 ET,
// `meta.type` flows from `GET /api/sessions` straight into `loadTemplate` so
// T2's inject endpoint stays a one-liner. If the inject caller needs to
// normalize a short-form name (e.g. 'claude') to 'claude-code', that's the
// caller's normalization layer (see T2's `normalizeCliType` in
// packages/server/src/sprints/inject.js).

// Templates live alongside the server package: packages/server/share/termdeck/templates/.
// __dirname here is packages/server/src/templates, so '..' twice lands at
// packages/server/, then into share/termdeck/templates.
const DEFAULT_TEMPLATE_DIR = path.join(
  __dirname,
  '..',
  '..',
  'share',
  'termdeck',
  'templates'
);

class TemplateNotFoundError extends Error {
  constructor(message, { cliType, role, lookedUpPaths } = {}) {
    super(message);
    this.name = 'TemplateNotFoundError';
    this.cliType = cliType;
    this.role = role;
    this.lookedUpPaths = Array.isArray(lookedUpPaths) ? lookedUpPaths : [];
  }
}

class MissingVariableError extends Error {
  constructor(message, { cliType, role, missingVariables } = {}) {
    super(message);
    this.name = 'MissingVariableError';
    this.cliType = cliType;
    this.role = role;
    this.missingVariables = Array.isArray(missingVariables) ? missingVariables : [];
  }
}

function _overrideDir() {
  if (process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR) {
    return process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR;
  }
  return path.join(os.homedir(), '.termdeck', 'templates');
}

function _resolveTemplatePath(cliType, role) {
  if (!cliType || typeof cliType !== 'string') {
    throw new TemplateNotFoundError(
      `loadTemplate requires a string cliType; got ${cliType === undefined ? 'undefined' : JSON.stringify(cliType)}`,
      { cliType, role, lookedUpPaths: [] }
    );
  }
  if (!role || typeof role !== 'string') {
    throw new TemplateNotFoundError(
      `loadTemplate requires a string role; got ${role === undefined ? 'undefined' : JSON.stringify(role)}`,
      { cliType, role, lookedUpPaths: [] }
    );
  }

  if (!SUPPORTED_CLI_TYPES.includes(cliType)) {
    throw new TemplateNotFoundError(
      `Unknown cliType="${cliType}". Supported: ${SUPPORTED_CLI_TYPES.join(', ')}.`,
      { cliType, role, lookedUpPaths: [] }
    );
  }
  if (!SUPPORTED_ROLES.includes(role)) {
    throw new TemplateNotFoundError(
      `Unknown role="${role}". Supported: ${SUPPORTED_ROLES.join(', ')}.`,
      { cliType, role, lookedUpPaths: [] }
    );
  }

  const filename = `${cliType}-${role}.txt`;
  const overrideCandidate = path.join(_overrideDir(), filename);
  const defaultCandidate = path.join(DEFAULT_TEMPLATE_DIR, filename);

  if (fs.existsSync(overrideCandidate)) {
    return { path: overrideCandidate, source: 'override' };
  }
  if (fs.existsSync(defaultCandidate)) {
    return { path: defaultCandidate, source: 'default' };
  }

  throw new TemplateNotFoundError(
    `Template not found for cliType="${cliType}" role="${role}". Looked up override=${overrideCandidate}, default=${defaultCandidate}.`,
    { cliType, role, lookedUpPaths: [overrideCandidate, defaultCandidate] }
  );
}

function _scanVariables(rawTemplate) {
  const found = new Set();
  // Fresh regex per call — global regexes carry stateful lastIndex.
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(rawTemplate)) !== null) {
    found.add(m[1]);
  }
  return found;
}

function loadTemplate(cliType, role, variables) {
  const { path: templatePath } = _resolveTemplatePath(cliType, role);
  const raw = fs.readFileSync(templatePath, 'utf8');
  const vars = (variables && typeof variables === 'object') ? variables : {};

  // First pass: substitute every {{name}} whose name is present (and not
  // null/undefined). Empty string IS a valid substitution. We use a fresh
  // regex per replace call so multiple loadTemplate() calls don't interact.
  const rendered = raw.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (
      Object.prototype.hasOwnProperty.call(vars, name) &&
      vars[name] !== undefined &&
      vars[name] !== null
    ) {
      return String(vars[name]);
    }
    return match;
  });

  // Second pass: detect any {{...}} still in the rendered string. If any
  // remain, the contract is violated — name them all so the caller fixes
  // them in one pass instead of one-at-a-time.
  const leftover = _scanVariables(rendered);
  if (leftover.size > 0) {
    const missing = Array.from(leftover).sort();
    throw new MissingVariableError(
      `Missing template variables for ${cliType}/${role}: ${missing.join(', ')}`,
      { cliType, role, missingVariables: missing }
    );
  }

  return rendered;
}

function requiredVariables(cliType, role) {
  const { path: templatePath } = _resolveTemplatePath(cliType, role);
  const raw = fs.readFileSync(templatePath, 'utf8');
  return Array.from(_scanVariables(raw)).sort();
}

module.exports = {
  loadTemplate,
  requiredVariables,
  TemplateNotFoundError,
  MissingVariableError,
  SUPPORTED_CLI_TYPES,
  SUPPORTED_ROLES,
  DEFAULT_TEMPLATE_DIR,
  // Internal helpers exported for unit tests; not part of the public contract.
  _resolveTemplatePath,
  _overrideDir,
  _scanVariables,
};
