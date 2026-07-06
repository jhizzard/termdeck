/**
 * TermDeck PreToolUse deny gate — migration-without-RLS.
 *
 * @termdeck/stack-installer-hook v1
 *
 * ^ Version stamp at the TOP of the docblock — both refresh readers
 *   (stack-installer `_readHookSignatureVersion` and `termdeck init --mnestra`
 *   `refreshBundledHookIfNewer`) scan only the first 4096 bytes. Keep it above
 *   the fold. Bump the integer when a change here should overwrite an already-
 *   installed copy. The literal `@jhizzard/termdeck-stack` below is the
 *   TermDeck-managed marker the refresh gate uses to distinguish our copy from
 *   a genuinely custom user hook.
 *
 * Vendored into ~/.claude/hooks/gate-migration-without-rls.js by
 * @jhizzard/termdeck-stack. Wired into ~/.claude/settings.json under
 * hooks.PreToolUse with matcher "Bash" — fires BEFORE Claude Code runs a Bash
 * tool call, and can DENY the call.
 *
 * Why this gate exists (Sprint 81, ULTRAPLAN §6 advise→gate): the Supabase RLS
 * five-gate hygiene rule (CLAUDE.md#supabase-rls) says every new public-schema
 * table must `ENABLE ROW LEVEL SECURITY` in the SAME migration that creates it
 * — Postgres ships new tables RLS-OFF, so anon/authenticated can read/write via
 * PostgREST until a policy denies them. That rule bit a real session — a
 * migration creating a public table without RLS landed on main. This gate
 * catches exactly that: a `git commit` whose staged migration adds a
 * `create table [public.]X` with no matching `enable row level security` for X
 * in the same file.
 *
 * ── FAIL-SOFT / FAIL-OPEN CONTRACT (load-bearing) ──────────────────────────
 *   A too-aggressive gate that blocks a legitimate commit is a P0 (worse than a
 *   missed catch). Therefore EVERY uncertainty resolves to ALLOW:
 *     - not a Bash tool call / not a `git commit`            → allow
 *     - the doctrine rule is not promoted to preToolUse-deny → allow (inert)
 *     - no staged migration *.sql files                      → allow
 *     - a staged blob can't be read / parsed                 → allow
 *     - the added table qualifies to a non-public schema     → allow
 *     - RLS is enabled for the table in the same file        → allow
 *     - ANY thrown error, anywhere                           → allow
 *   ALLOW = exit 0 with NO stdout. DENY = exit 0 with the PreToolUse JSON. We
 *   NEVER exit 2 (exit 2 blocks + feeds stderr — the opposite of fail-soft).
 *
 * ── PRECISION (why it scans ADDED lines) ───────────────────────────────────
 *   It flags a table only when the `create table` appears in a NEWLY-ADDED
 *   (`git diff --cached`) line, then checks RLS presence across the full staged
 *   file. So an unrelated edit to a migration that already created a table
 *   (with RLS in a sibling file) is not re-flagged — only a create you are
 *   introducing now.
 *
 * ── KNOWN LIMITATION (documented, safe by construction) ────────────────────
 *   A `create table` inside a dollar-quoted function/DO body may be seen at the
 *   text level. This is rare in these migration sets (tables are created at top
 *   level) and, because the gate is inert until promoted and reversible per-
 *   rule, a false trigger can be turned off with `doctrine reject rls-five-gates`
 *   the same minute it misfires. temp/temporary/unlogged creates are ignored.
 *
 * ── REGISTRY-DRIVEN (inert until promoted) ─────────────────────────────────
 *   Enforces ONLY when the doctrine registry declares `rls-five-gates` as
 *   status:active + enforcement.surface:preToolUse-deny + max_severity:block.
 *   Until ORCH runs `doctrine promote rls-five-gates`, the shipped registry has
 *   it at inject-advisory/warn and this gate is a safe no-op. Registry path:
 *     1. $TERMDECK_DOCTRINE_REGISTRY
 *     2. ~/.claude/doctrine/registry.shipped.jsonl
 *     3. <repo>/doctrine/registry.jsonl
 *     4. none readable → allow (inert)
 *
 * PreToolUse deny shape (verified against code.claude.com/docs/en/hooks):
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *       "permissionDecision": "deny", "permissionDecisionReason": "<why>" } }
 *
 * INSTALLER-PITFALLS classes this avoids: Class E (zero developer-private-path
 * dependency); Class N (self-contained — no cross-hook require).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RULE_ID = 'rls-five-gates';
const LOG_FILE = path.join(os.homedir(), '.claude', 'hooks', 'doctrine-gate.log');
const GIT_TIMEOUT_MS = 5000;
const MAX_FILES_SCANNED = 40; // bound worst-case fan-out on a huge staged set

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [gate:${RULE_ID}] ${msg}\n`);
  } catch (_) { /* fail-soft */ }
}

// ── PreToolUse decision emitters (identical contract to gate-publish-before-push) ──
function allow() { process.exit(0); }
function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch (_) { /* fall through to allow */ }
  process.exit(0);
}

// ── Registry read (tiny, dependency-free JSONL parse) ───────────────────────
function ruleIsActiveGate(ruleId) {
  const candidates = [
    process.env.TERMDECK_DOCTRINE_REGISTRY,
    path.join(os.homedir(), '.claude', 'doctrine', 'registry.shipped.jsonl'),
    path.join(__dirname, '..', '..', '..', '..', 'doctrine', 'registry.jsonl'),
  ].filter(Boolean);

  for (const file of candidates) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (_) { continue; }
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('//')) continue;
      let obj;
      try { obj = JSON.parse(t); } catch (_) { continue; }
      if (!obj || obj.id !== ruleId) continue;
      const enf = obj.enforcement || {};
      return obj.status === 'active'
        && enf.surface === 'preToolUse-deny'
        && enf.max_severity === 'block';
    }
    return false; // registry present, rule absent → inert
  }
  return false; // no registry readable → inert
}

// ── stdin ───────────────────────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input));
  });
}

// ── command classifier ──────────────────────────────────────────────────────
// True when the Bash command is a history-writing `git commit`. `commit` must
// be the git SUBCOMMAND — NOT just any token after `git` — otherwise
// `git log --grep commit` would false-match and (with a staged bad migration)
// could DENY a read-only `git log`, a P0 false block. Leading git global options
// (-C <dir>, -c <kv>, --flag, -x) are allowed. Excludes --dry-run / --help
// (they don't create a commit → nothing to gate).
function isGitCommit(command) {
  if (typeof command !== 'string') return false;
  return command.split(/[;&|]|\n/).some((seg) => {
    if (!/\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--\S+\s+|-\w\s+)*commit\b/.test(seg)) return false;
    if (/--dry-run\b/.test(seg)) return false;
    if (/--help\b/.test(seg)) return false;
    return true;
  });
}

// ── git helpers (fail-open) ─────────────────────────────────────────────────
function gitRun(cwd, args) {
  try {
    const r = spawnSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) return null;
    return r.stdout || '';
  } catch (_) { return null; }
}

// migration *.sql files in the staged (added/modified) set.
function stagedMigrationFiles(cwd) {
  const out = gitRun(cwd, ['diff', '--cached', '--name-only', '--diff-filter=AM']);
  if (out == null) return [];
  return out.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => /\.sql$/i.test(f) && /(^|\/)[a-z0-9._-]*migrations\//i.test(f))
    .slice(0, MAX_FILES_SCANNED);
}

// The lines this commit ADDS to `file` (content of `+` hunk lines, marker stripped).
function addedLines(cwd, file) {
  const out = gitRun(cwd, ['diff', '--cached', '-U0', '--', file]);
  if (out == null) return '';
  return out.split(/\r?\n/)
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
}

// The full staged blob of `file` (index version).
function stagedBlob(cwd, file) {
  return gitRun(cwd, ['show', `:${file}`]);
}

// ── SQL scan (pure — unit-tested) ───────────────────────────────────────────
// Strip -- line comments and /* */ block comments so commented-out DDL doesn't
// trip or mask the scan.
function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

// Public tables created by `create table [if not exists] [<schema>.]name` in
// the given (already comment-stripped) text. Returns lowercased bare names.
// Skips temp/temporary/unlogged (never matched — regex requires `create table`
// with nothing between). Skips schema-qualified-to-non-public.
function publicTablesCreated(text) {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-z_][a-z0-9_$]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?/gi;
  const names = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const schema = m[1] ? m[1].toLowerCase() : null;
    const table = m[2] ? m[2].toLowerCase() : null;
    if (!table) continue;
    if (schema && schema !== 'public') continue; // non-public schema → not our concern
    names.push(table);
  }
  return names;
}

// Does the (comment-stripped) file enable RLS for `table`?
function fileEnablesRls(text, table) {
  const t = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    'alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\s*\\.\\s*)?"?' + t +
    '"?\\s+enable\\s+row\\s+level\\s+security',
    'i'
  );
  return re.test(text);
}

// Given a file's added text + full staged text, return the list of newly-added
// public tables that LACK RLS in the same file. Pure → unit-testable.
function violationsForFile(addedText, fullText) {
  const strippedAdded = stripSqlComments(addedText);
  const strippedFull = stripSqlComments(fullText);
  const added = publicTablesCreated(strippedAdded);
  const uniq = Array.from(new Set(added));
  return uniq.filter((table) => !fileEnablesRls(strippedFull, table));
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch (_) { return allow(); }
  if (!data || data.tool_name !== 'Bash') return allow();

  const command = data.tool_input && data.tool_input.command;
  if (!isGitCommit(command)) return allow();

  if (!ruleIsActiveGate(RULE_ID)) return allow();

  const cwd = (typeof data.cwd === 'string' && data.cwd) ? data.cwd : process.cwd();

  const files = stagedMigrationFiles(cwd);
  if (!files.length) return allow();

  const offenders = [];
  for (const file of files) {
    const added = addedLines(cwd, file);
    if (!added) continue;
    const full = stagedBlob(cwd, file);
    if (full == null) continue; // can't read staged blob → fail-open for this file
    const bad = violationsForFile(added, full);
    if (bad.length) offenders.push({ file, tables: bad });
  }
  if (!offenders.length) return allow();

  const detail = offenders
    .map((o) => `${o.file} → ${o.tables.map((t) => `public.${t}`).join(', ')}`)
    .join('; ');
  const firstTable = offenders[0].tables[0];
  const reason =
    `migration-without-RLS: staged migration adds public table(s) with no ENABLE ROW LEVEL SECURITY in the same file — ${detail}. ` +
    `New public tables ship RLS-OFF (anon/authenticated can read/write via PostgREST until a policy denies them). ` +
    `Add \`ALTER TABLE public.${firstTable} ENABLE ROW LEVEL SECURITY;\` (per table) in this migration — the five-gate hygiene rule. See CLAUDE.md#supabase-rls. ` +
    `[doctrine rule: ${RULE_ID}; disable via \`doctrine reject ${RULE_ID}\`]`;
  log(`DENY commit: ${detail}`);
  return deny(reason);
}

if (require.main === module) {
  main().catch((e) => {
    try { log(`unexpected error → allow: ${e && e.message ? e.message : String(e)}`); } catch (_) { /* noop */ }
    process.exit(0);
  });
} else {
  module.exports = {
    RULE_ID,
    isGitCommit,
    ruleIsActiveGate,
    stripSqlComments,
    publicTablesCreated,
    fileEnablesRls,
    violationsForFile,
    stagedMigrationFiles,
  };
}
