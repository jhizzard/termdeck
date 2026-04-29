// Migration SQL templating helper.
//
// Several Rumen migrations ship with placeholder markers for values that
// can only be resolved at apply-time: the user's Supabase project ref,
// service-role JWT name, etc. Migration 002 (rumen-tick schedule) and 003
// (graph-inference-tick schedule) both embed the project ref inside the
// pg_cron body that calls `net.http_post` on
// `https://<project-ref>.supabase.co/functions/v1/<name>`.
//
// Pre-Sprint 42, init-rumen.js::applySchedule did this substitution inline
// for migration 002 only — and migration 003 (added Sprint 38) shipped its
// `<project-ref>` placeholder unsubstituted. Sprint 42 T3 extracts the
// substitution into this shared helper so every migration that lists a
// known placeholder gets templated consistently.
//
// Supported placeholder syntaxes (both accepted; legacy + sigil-style):
//   <project-ref>
//   {{PROJECT_REF}}
//
// API:
//   applyTemplating(sql, vars)
//     sql:  string — raw migration body
//     vars: { projectRef?: string }
//   returns: string — substituted body
//   throws:  Error — when SQL contains a placeholder but `vars` lacks the
//            corresponding value. (Quietly leaving the placeholder in
//            would let an unsubstituted URL ship to pg_cron, which is the
//            very bug this module exists to prevent.)
//
// Idempotent: applying twice yields the same string. Safe on SQL with no
// placeholders (returns the input unchanged).

'use strict';

const PLACEHOLDER_SYNTAXES = Object.freeze({
  projectRef: [/<project-ref>/g, /\{\{PROJECT_REF\}\}/g],
});

function hasPlaceholder(sql, patterns) {
  for (const pat of patterns) {
    pat.lastIndex = 0;
    if (pat.test(sql)) return true;
  }
  return false;
}

function substitute(sql, patterns, value) {
  let out = sql;
  for (const pat of patterns) {
    out = out.replace(pat, value);
  }
  return out;
}

function applyTemplating(sql, vars) {
  if (typeof sql !== 'string') {
    throw new TypeError('applyTemplating: sql must be a string');
  }
  const v = vars || {};
  let out = sql;

  for (const [varName, patterns] of Object.entries(PLACEHOLDER_SYNTAXES)) {
    if (!hasPlaceholder(out, patterns)) continue;
    const value = v[varName];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `applyTemplating: SQL contains ${varName} placeholder but vars.${varName} is missing or empty. ` +
        `Refusing to ship an unsubstituted placeholder to the database.`
      );
    }
    out = substitute(out, patterns, value);
  }
  return out;
}

module.exports = { applyTemplating, PLACEHOLDER_SYNTAXES };
