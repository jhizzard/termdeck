/**
 * TermDeck PreToolUse deny gate — publish-before-push.
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
 * Vendored into ~/.claude/hooks/gate-publish-before-push.js by
 * @jhizzard/termdeck-stack. Wired into ~/.claude/settings.json under
 * hooks.PreToolUse with matcher "Bash" — fires BEFORE Claude Code runs a Bash
 * tool call, and can DENY the call.
 *
 * Why this gate exists (Sprint 81, ULTRAPLAN §6 advise→gate): the release rule
 * (docs/RELEASE.md) is "npm publish (Passkey, never --otp) BEFORE git push."
 * That rule bit a real session — a version-bumped push landed on main with the
 * matching npm publish skipped, stranding a bump on the default branch. This
 * gate catches exactly that: a `git push` while the current branch is the
 * default branch (main/master) AND some local `@jhizzard/*` package.json
 * version is strictly ahead of what npm has published. Park the bump on a
 * hotfix branch, or publish first.
 *
 * ── FAIL-SOFT / FAIL-OPEN CONTRACT (load-bearing) ──────────────────────────
 *   A too-aggressive gate that blocks a legitimate push is a P0 (worse than a
 *   missed catch). Therefore EVERY uncertainty resolves to ALLOW:
 *     - not a Bash tool call / not a `git push`               → allow
 *     - the doctrine rule is not promoted to preToolUse-deny  → allow (inert)
 *     - current branch is not the default branch              → allow
 *     - `npm view` fails / times out / package unpublished    → allow
 *     - ANY thrown error, anywhere                            → allow
 *   ALLOW = exit 0 with NO stdout (normal permission flow). DENY = exit 0 with
 *   the PreToolUse JSON below. We NEVER exit 2 (exit 2 blocks + feeds stderr —
 *   the opposite of fail-soft).
 *
 * ── REGISTRY-DRIVEN (inert until promoted) ─────────────────────────────────
 *   The gate enforces ONLY when the doctrine registry declares the rule
 *   `publish-before-push` as status:active + enforcement.surface:preToolUse-deny
 *   + max_severity:block. Until ORCH runs `doctrine promote publish-before-push`
 *   (advise→gate), the shipped registry has it at inject-advisory/warn and this
 *   gate is a safe no-op. Deprecating/rejecting the rule disables the gate
 *   without uninstalling the hook — a reversible per-rule kill switch.
 *   Registry path resolution (first hit wins):
 *     1. $TERMDECK_DOCTRINE_REGISTRY            (tests / power users)
 *     2. ~/.claude/doctrine/registry.shipped.jsonl  (installer-vendored copy)
 *     3. <repo>/doctrine/registry.jsonl         (source-tree / dev runs)
 *     4. none readable                          → allow (inert)
 *
 * PreToolUse deny shape (verified against code.claude.com/docs/en/hooks):
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *       "permissionDecision": "deny", "permissionDecisionReason": "<why>" } }
 *
 * INSTALLER-PITFALLS classes this avoids: Class E (zero developer-private-path
 * dependency — reads only os.homedir()-relative paths + spawns git/npm on
 * PATH); Class N (self-contained — no cross-hook require, so drift in a sibling
 * hook can't break this gate).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RULE_ID = 'publish-before-push';
const LOG_FILE = path.join(os.homedir(), '.claude', 'hooks', 'doctrine-gate.log');
const GIT_TIMEOUT_MS = 5000;
const NPM_VIEW_TIMEOUT_MS = 6000;
const MAX_PACKAGES_CHECKED = 16; // bound worst-case npm-view fan-out

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [gate:${RULE_ID}] ${msg}\n`);
  } catch (_) { /* fail-soft */ }
}

// ── PreToolUse decision emitters ───────────────────────────────────────────
// ALLOW: print nothing, exit 0 → normal permission flow.
function allow() { process.exit(0); }
// DENY: print the PreToolUse JSON to stdout, exit 0 → tool call blocked, reason
// shown to Claude. (Exit 2 is intentionally NOT used — it blocks via stderr and
// is not fail-soft.)
function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch (_) { /* if we can't even print, fall through to allow */ }
  process.exit(0);
}

// ── Registry read (tiny, dependency-free JSONL parse) ───────────────────────
// Returns true iff the rule is an active, promoted (preToolUse-deny/block) gate.
// Any read/parse trouble → false (inert → allow).
function ruleIsActiveGate(ruleId) {
  const candidates = [
    process.env.TERMDECK_DOCTRINE_REGISTRY,
    path.join(os.homedir(), '.claude', 'doctrine', 'registry.shipped.jsonl'),
    // source-tree fallback: assets/hooks/ → assets → stack-installer → packages → repo root
    path.join(__dirname, '..', '..', '..', '..', 'doctrine', 'registry.jsonl'),
  ].filter(Boolean);

  for (const file of candidates) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (_) { continue; } // not this one — try next candidate
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('//')) continue;
      let obj;
      try { obj = JSON.parse(t); } catch (_) { continue; } // skip malformed line
      if (!obj || obj.id !== ruleId) continue;
      const enf = obj.enforcement || {};
      return obj.status === 'active'
        && enf.surface === 'preToolUse-deny'
        && enf.max_severity === 'block';
    }
    // Found the registry file but not the rule id → rule absent → inert.
    return false;
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
// True when the Bash command runs a REAL `git push`. `push` must be the git
// SUBCOMMAND — NOT just any token after `git` — otherwise `git commit -m "push"`
// would false-match and (on main, with an ahead version) could DENY a commit,
// a P0 false block. Leading git global options (-C <dir>, -c <kv>, --flag, -x)
// between `git` and the subcommand are allowed. Split on shell separators so
// `foo && git push` matches but a stray "push" in another segment doesn't.
// Excludes --dry-run / --help (non-writing probes: `git push --dry-run` previews
// what WOULD push and `git push --help` prints docs — neither publishes, so a
// user must be able to inspect without tripping the release-order block).
// Mirrors gate-migration-without-rls.js::isGitCommit.
function isGitPush(command) {
  if (typeof command !== 'string') return false;
  return command.split(/[;&|]|\n/).some((seg) => {
    if (!/\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--\S+\s+|-\w\s+)*push\b/.test(seg)) return false;
    if (/--dry-run\b/.test(seg)) return false;
    if (/--help\b/.test(seg)) return false;
    return true;
  });
}

// ── git helpers (fail-open) ─────────────────────────────────────────────────
function gitOut(cwd, args) {
  try {
    const r = spawnSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch (_) { return null; }
}

function currentBranch(cwd) { return gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); }
function repoTopLevel(cwd) { return gitOut(cwd, ['rev-parse', '--show-toplevel']); }

// ── semver: is local strictly ahead of published? ──────────────────────────
// Conservative: compares the numeric major.minor.patch release triple only.
// Equal (or unparseable, or local behind) → NOT ahead → allow.
function releaseTriple(v) {
  if (typeof v !== 'string') return null;
  const core = v.trim().replace(/^[vV]/, '').split(/[-+]/)[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return parts.slice(0, 3);
}
function localAhead(local, published) {
  const a = releaseTriple(local);
  const b = releaseTriple(published);
  if (!a || !b) return false; // can't compare → not ahead
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false; // equal → already published
}

// ── discover local @jhizzard/* publishable packages ─────────────────────────
function readPkg(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && typeof obj.name === 'string' && typeof obj.version === 'string') return obj;
  } catch (_) { /* skip */ }
  return null;
}

function candidatePackages(repoRoot) {
  const found = [];
  const seen = new Set();
  const add = (file) => {
    if (found.length >= MAX_PACKAGES_CHECKED) return;
    const pkg = readPkg(file);
    if (!pkg) return;
    if (!pkg.name.startsWith('@jhizzard/')) return;
    if (pkg.private === true) return;
    if (seen.has(pkg.name)) return;
    seen.add(pkg.name);
    found.push({ name: pkg.name, version: pkg.version });
  };

  add(path.join(repoRoot, 'package.json'));
  const pkgsDir = path.join(repoRoot, 'packages');
  try {
    for (const entry of fs.readdirSync(pkgsDir)) {
      if (found.length >= MAX_PACKAGES_CHECKED) break;
      add(path.join(pkgsDir, entry, 'package.json'));
    }
  } catch (_) { /* no packages/ dir — root-only repo */ }
  return found;
}

function publishedVersion(name) {
  try {
    const r = spawnSync('npm', ['view', name, 'version'], {
      timeout: NPM_VIEW_TIMEOUT_MS, encoding: 'utf8',
    });
    if (r.error || r.status !== 0) return null; // unpublished / offline / error → skip
    const out = (r.stdout || '').trim();
    return releaseTriple(out) ? out : null;
  } catch (_) { return null; }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch (_) { return allow(); }
  if (!data || data.tool_name !== 'Bash') return allow();

  const command = data.tool_input && data.tool_input.command;
  if (!isGitPush(command)) return allow();

  // Registry gate — inert until promoted advise→gate.
  if (!ruleIsActiveGate(RULE_ID)) return allow();

  const cwd = (typeof data.cwd === 'string' && data.cwd) ? data.cwd : process.cwd();

  // Only enforce on the default branch. Parking a bump on a hotfix/feature
  // branch is explicitly sanctioned (docs/RELEASE.md), so a non-main push is
  // always allowed.
  const branch = currentBranch(cwd);
  if (branch !== 'main' && branch !== 'master') return allow();

  const repoRoot = repoTopLevel(cwd) || cwd;
  const pkgs = candidatePackages(repoRoot);
  if (!pkgs.length) return allow();

  const ahead = [];
  for (const p of pkgs) {
    const pub = publishedVersion(p.name);
    if (pub == null) continue;            // unpublished/offline → skip (fail-open)
    if (localAhead(p.version, pub)) ahead.push({ ...p, published: pub });
  }
  if (!ahead.length) return allow();

  const list = ahead.map((p) => `${p.name} local ${p.version} > npm ${p.published}`).join('; ');
  const reason =
    `publish-before-push: pushing to ${branch} with an unpublished version bump — ${list}. ` +
    `Run \`npm publish\` (Passkey web auth, never --otp) for the bumped package(s) BEFORE this push, ` +
    `or park the bump on a hotfix branch (never push a bump to main unpublished). See docs/RELEASE.md. ` +
    `[doctrine rule: ${RULE_ID}; disable via \`doctrine reject ${RULE_ID}\` or override with a non-main branch]`;
  log(`DENY push on ${branch}: ${list}`);
  return deny(reason);
}

if (require.main === module) {
  main().catch((e) => {
    // Absolute backstop: any unforeseen error → allow (fail-open).
    try { log(`unexpected error → allow: ${e && e.message ? e.message : String(e)}`); } catch (_) { /* noop */ }
    process.exit(0);
  });
} else {
  // Export the pure helpers for unit tests (the CLI path above is the runtime).
  module.exports = {
    RULE_ID,
    isGitPush,
    ruleIsActiveGate,
    releaseTriple,
    localAhead,
    candidatePackages,
    currentBranch,
    repoTopLevel,
  };
}
