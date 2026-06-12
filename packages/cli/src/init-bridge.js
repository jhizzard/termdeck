#!/usr/bin/env node

// `termdeck init --bridge` — guided wizard for the Tier 5 Web-Chat Bridge
// permanent install (named cloudflared tunnel + stack supervisor). Automates
// the manual flow in docs/GETTING-STARTED.md § Tier 5 (PR #23); the doc and
// this wizard must stay in lockstep.
//
// What it does, in order:
//   1. Preflight: cloudflared on PATH (install hint if not), origin cert,
//      existing tunnel credentials, existing config.yml / supervisor.env.
//   2. Prompts for tunnel name (default `termdeck-bridge`) + public hostname
//      — or reuses the values already in ~/.termdeck/supervisor.env.
//   3. Persists ~/.termdeck/supervisor.env IMMEDIATELY after collection
//      (merge-aware, backs up before changing) so an abort during the
//      operator wait-loop below cannot lose typed-in answers. This runs
//      BEFORE the cloudflared wait — INSTALLER-PITFALLS Class C
//      (state-mutating writes before fallible/blocking steps; ledger #5).
//      Safe against a live quick-tunnel stack: termdeck-supervise.sh's
//      start_tunnel short-circuits on any running `cloudflared tunnel`
//      process and only adopts the named tunnel after the next restart.
//   4. Stages the VENDORED supervisor script + operator one-shot scripts
//      under ~/.termdeck/bridge-install/ and PRINTS the cloudflared
//      login/create/route steps — it NEVER runs them (browser auth is
//      operator-interactive). Single-line `bash <one-shot>` hand-offs per
//      INSTALLER-PITFALLS Class J (checklist #11).
//   5. Waits/re-checks until tunnel credentials exist, then writes
//      ~/.cloudflared/config.yml (tunnel id from the credentials JSON,
//      ingress → http://127.0.0.1:8870). Existing files are backed up
//      before any overwrite and a foreign (non-wizard) config.yml is never
//      replaced without explicit consent.
//   6. Copies the supervisor install files AS FILES to their final paths —
//      rendered launchd plist → ~/Library/LaunchAgents/ on darwin, systemd
//      unit + timer → ~/.config/systemd/user/ on linux — then PRINTS the
//      operator `launchctl load -w` / `systemctl enable` steps. It never
//      runs launchctl/systemctl itself (ORCH decision 2026-06-11 20:58).
//   7. Verify pass: if the local bridge is up, runs the four Tier 5 public
//      reachability checks against https://<hostname> and prints results.
//
// Supervisor assets are VENDORED into the npm tarball at
// packages/cli/assets/supervise/ (script byte-mirrors scripts/
// termdeck-supervise.sh; plist/service are __TERMDECK_*__-tokenized twins of
// the canonical repo artifacts so no developer-machine paths ever ship —
// pre-ship checklist #8). The wizard reads ONLY the vendored assets, so npm
// installs and repo checkouts behave identically. Because the staged script
// runs from ~/.termdeck/bridge-install/ (not the repo), its REPO_DIR
// parent-dir derivation would be wrong — the wizard therefore fills
// TERMDECK_REPO_DIR into supervisor.env (the supervisor's own env-override
// contract), pointing at this package's root. Never overwrites an
// operator-set TERMDECK_REPO_DIR.
//
// Flags:
//   --help          Print usage and exit
//   --yes           Reuse existing supervisor.env settings without prompting
//                   and auto-confirm overwrites (backups still written)
//   --reset         Ignore existing supervisor.env values and re-prompt
//   --from-env      No prompts; read TERMDECK_PUBLIC_HOSTNAME (required) and
//                   TERMDECK_TUNNEL_NAME (optional, default termdeck-bridge)
//                   from the environment. Strict by design.
//   --tunnel-id <uuid>  Disambiguate when ~/.cloudflared holds credentials
//                   for more than one tunnel (current cloudflared writes no
//                   TunnelName field into the credentials JSON, so the
//                   wizard cannot always match by name).
//   --dry-run       Print the plan; touch nothing on disk
//   --skip-verify   Skip the public reachability checks
//   --verify-only   Run ONLY the reachability checks (hostname from
//                   supervisor.env or env) — no prompts, no writes. Exits
//                   non-zero if any check fails, so it is script-friendly.
//
// Exit codes: 0 ok · 2 input/validation error · 3 tunnel credentials
// pending or ambiguous (resume with `--yes` / `--tunnel-id` after the
// operator steps) · 4 --verify-only found failures · 6 filesystem write
// failure.
//
// Sibling of init-mnestra.js — same step/ok/fail output idiom, the same
// status-object returns with `would-*` dry-run variants, the same
// timestamped `.bak.<YYYYMMDDhhmmss>` backup convention, and the same
// opts-injected paths so tests never touch the real HOME or the network.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SETUP_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'setup');
// Lazy: the setup aggregate pulls in pg + supabase helpers. Loading it at
// require-time would (a) slow `termdeck init --bridge --help`, and (b) make
// this module un-requirable from an extracted npm tarball without
// node_modules — which the packed-layout asset-resolution test does on
// purpose (ledger #21: exercise the production FS layout, not a mock).
let _setupMods = null;
function setupMods() {
  if (!_setupMods) _setupMods = require(SETUP_DIR);
  return _setupMods;
}
function promptsMod() { return setupMods().prompts; }
function dotenvMod() { return setupMods().dotenv; }

const BRIDGE_PORT = 8870;
const DEFAULT_TUNNEL_NAME = 'termdeck-bridge';
// Trust marker for config.yml files this wizard wrote — mirrors the
// TermDeck-managed-marker pattern the hook refresher uses to tell "ours,
// safe to refresh" from "user-authored, preserve" (ledger #15's safety gate).
const CONFIG_MARKER = 'Managed by `termdeck init --bridge`';
const SUPERVISE_LABEL = 'com.jhizzard.termdeck-supervise';

const HELP = [
  '',
  'TermDeck Web-Chat Bridge Setup (Tier 5)',
  '',
  'Usage: termdeck init --bridge [flags]',
  '',
  'Flags:',
  '  --help            Print this message and exit',
  '  --yes             Reuse existing supervisor.env settings without prompting',
  '                    and auto-confirm overwrites (timestamped backups are',
  '                    still written before any replacement)',
  '  --reset           Ignore existing supervisor.env values and re-prompt',
  '  --from-env        Skip every prompt; read TERMDECK_PUBLIC_HOSTNAME',
  '                    (required) and TERMDECK_TUNNEL_NAME (optional, default',
  '                    termdeck-bridge) from environment variables',
  '  --tunnel-id <id>  Pick a specific tunnel credentials file when',
  '                    ~/.cloudflared holds more than one',
  '  --dry-run         Print the plan without touching the filesystem',
  '  --skip-verify     Skip the public reachability checks',
  '  --verify-only     Only run the four Tier 5 reachability checks against',
  '                    the configured hostname; exit 4 if any fail',
  '',
  'What this does:',
  '  1. Prompts for a tunnel name + public hostname (or reuses what is',
  '     already in ~/.termdeck/supervisor.env).',
  '  2. Writes ~/.termdeck/supervisor.env IMMEDIATELY (merge-aware, backed',
  '     up) so a later abort cannot lose what you typed in.',
  '  3. PRINTS the operator-interactive cloudflared steps (login / create /',
  '     route) — browser auth means the wizard never runs them itself — and',
  '     waits until the tunnel credentials appear.',
  '  4. Writes ~/.cloudflared/config.yml (ingress → http://127.0.0.1:8870),',
  '     backing up any existing file first. A config.yml this wizard did not',
  '     write is never replaced without your explicit consent.',
  '  5. Copies the supervisor files into place from the vendored package',
  '     assets (script → ~/.termdeck/bridge-install/, launchd plist /',
  '     systemd units → their install dirs) and PRINTS the launchctl /',
  '     systemctl steps — the wizard never runs those either.',
  '  6. Verifies public reachability with the four Tier 5 checks.',
  '',
  'The manual flow lives in docs/GETTING-STARTED.md § Tier 5.',
  ''
].join('\n');

function parseFlags(argv) {
  const out = {
    help: false,
    yes: false,
    reset: false,
    fromEnv: false,
    dryRun: false,
    skipVerify: false,
    verifyOnly: false,
    tunnelId: null
  };
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--from-env') out.fromEnv = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-verify') out.skipVerify = true;
    else if (a === '--verify-only') out.verifyOnly = true;
    else if (a === '--tunnel-id' && args[i + 1]) { out.tunnelId = args[i + 1]; i++; }
  }
  return out;
}

function step(msg) { process.stdout.write(`→ ${msg}`); }
function ok(suffix = '') { process.stdout.write(` ✓${suffix ? ' ' + suffix : ''}\n`); }
function fail(err) { process.stdout.write(` ✗\n    ${err}\n`); }

function stamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

// Atomic write — tmp + rename, same shape as init-mnestra's _writeSettingsJson.
function writeFileAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  if (mode != null) fs.writeFileSync(tmp, content, { mode });
  else fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function validateTunnelName(v) {
  if (!v || !v.trim()) return 'tunnel name is required';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.trim())) {
    return 'tunnel name must start alphanumeric and contain only letters, digits, ".", "_", "-" (max 64 chars)';
  }
  return null;
}

// Class D guard built into the validator: placeholder shapes like
// `bridge.<your-domain>` (straight from the docs) must never reach disk.
function validateHostname(v) {
  if (!v || !v.trim()) return 'hostname is required';
  const value = v.trim();
  if (/[<>*\s]/.test(value)) return 'enter a real hostname — placeholders like bridge.<your-domain> cannot be used';
  if (/^https?:\/\//i.test(value)) return 'hostname only — drop the https:// scheme';
  if (value.includes('/')) return 'hostname only — no path component';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
    return 'not a valid DNS hostname (expected something like bridge.example.com)';
  }
  return null;
}

function detectCloudflared(opts = {}) {
  const lookup = opts.lookupImpl
    || (() => execSync('command -v cloudflared', { stdio: 'ignore' }));
  try { lookup(); return true; } catch (_e) { return false; }
}

// Scan ~/.cloudflared/*.json for tunnel credentials. Ground truth from the
// 2026-06-10 PR #23 machine: current cloudflared writes ONLY AccountTag /
// TunnelSecret / TunnelID / Endpoint — NO TunnelName — so name matching is
// best-effort (newer cloudflared versions do include TunnelName). Resolution
// order: explicit tunnelId > TunnelName match > single-file fallback >
// ambiguous (caller must disambiguate; never guess silently).
// The returned objects deliberately exclude TunnelSecret.
function findTunnelCredentials(opts = {}) {
  const dir = opts.cloudflaredDir || path.join(os.homedir(), '.cloudflared');
  const wantName = opts.tunnelName || null;
  const wantId = opts.tunnelId || null;

  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_e) {
    return { status: 'none', candidates: [] };
  }

  const candidates = [];
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.TunnelID !== 'string' || !parsed.TunnelID) continue;
      if (typeof parsed.AccountTag !== 'string' || !parsed.AccountTag) continue;
      candidates.push({
        tunnelId: parsed.TunnelID,
        tunnelName: typeof parsed.TunnelName === 'string' && parsed.TunnelName ? parsed.TunnelName : null,
        file: full,
        mtimeMs: fs.statSync(full).mtimeMs
      });
    } catch (_e) { /* malformed / unreadable → not a credentials file */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (wantId) {
    const hit = candidates.find((c) => c.tunnelId === wantId);
    return hit
      ? { status: 'match', creds: hit, candidates }
      : { status: 'id-not-found', candidates };
  }
  if (wantName) {
    const hit = candidates.find((c) => c.tunnelName === wantName);
    if (hit) return { status: 'match', creds: hit, candidates };
  }
  if (candidates.length === 1) return { status: 'single', creds: candidates[0], candidates };
  if (candidates.length === 0) return { status: 'none', candidates };
  return { status: 'ambiguous', candidates };
}

function buildCloudflaredConfigYml({ tunnelId, credentialsFile, hostname }) {
  return [
    `# ${CONFIG_MARKER} — Tier 5 Web-Chat Bridge ingress.`,
    '# A timestamped backup is written before this wizard ever replaces the file.',
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${BRIDGE_PORT}`,
    '  - service: http_status:404',
    ''
  ].join('\n');
}

// Semantic (not byte) match so a hand-written config.yml that already routes
// <hostname> → :8870 through <tunnelId> counts as configured — the wizard
// must be a no-op on machines where the manual Tier 5 flow already ran.
function readCloudflaredConfigState(configPath, desired) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch (_e) { return { status: 'missing' }; }
  const trimmedLines = raw.split(/\r?\n/).map((l) => l.trim());
  const has = (s) => trimmedLines.includes(s);
  const matches = has(`tunnel: ${desired.tunnelId}`)
    && has(`credentials-file: ${desired.credentialsFile}`)
    && has(`- hostname: ${desired.hostname}`)
    && raw.includes(`service: http://127.0.0.1:${BRIDGE_PORT}`);
  return {
    status: matches ? 'matches' : 'differs',
    raw,
    ours: raw.includes(CONFIG_MARKER)
  };
}

// Write ~/.cloudflared/config.yml. Never clobbers silently: existing files
// are backed up first, and a foreign (non-wizard-marker) file additionally
// requires consent (interactive confirm, or --yes). confirmFn is injected by
// main(); absent confirmFn + absent assumeYes = keep the foreign file.
async function writeCloudflaredConfig({
  cloudflaredDir,
  configPath,
  tunnelId,
  hostname,
  dryRun,
  assumeYes,
  confirmFn
} = {}) {
  const dir = cloudflaredDir || path.join(os.homedir(), '.cloudflared');
  const target = configPath || path.join(dir, 'config.yml');
  const credentialsFile = path.join(dir, `${tunnelId}.json`);
  const desired = buildCloudflaredConfigYml({ tunnelId, credentialsFile, hostname });
  const state = readCloudflaredConfigState(target, { tunnelId, credentialsFile, hostname });

  if (state.status === 'matches') {
    return { status: 'already-configured', configPath: target };
  }
  if (state.status === 'missing') {
    if (dryRun) return { status: 'would-write', configPath: target };
    writeFileAtomic(target, desired);
    return { status: 'written', configPath: target };
  }

  // differs
  if (!state.ours) {
    if (dryRun) return { status: 'would-replace-foreign', configPath: target };
    let consent = !!assumeYes;
    if (!consent && typeof confirmFn === 'function') {
      consent = await confirmFn();
    }
    if (!consent) {
      return { status: 'kept-foreign', configPath: target, desired };
    }
  } else if (dryRun) {
    return { status: 'would-update', configPath: target };
  }

  let backup = `${target}.bak.${stamp()}`;
  try { fs.copyFileSync(target, backup); }
  catch (_e) { backup = null; /* best-effort, matching the sibling wizard */ }
  writeFileAtomic(target, desired);
  return { status: state.ours ? 'updated' : 'replaced', configPath: target, backup };
}

// Merge TERMDECK_TUNNEL_NAME + TERMDECK_PUBLIC_HOSTNAME into
// ~/.termdeck/supervisor.env. Reuses dotenv.writeSecrets (merge-aware:
// preserves comments, ordering, and every unrelated key — the operator may
// have custom overrides in here). No-change runs are detected BEFORE any
// write so idempotent re-runs leave mtime untouched and create no backup.
//
// fillIfMissing: keys written ONLY when absent/empty in the existing file —
// never overwriting an operator-set value (settings-invariant #4 posture).
// Used for TERMDECK_REPO_DIR: the staged supervisor script can't derive the
// repo/package root from its own location, so the wizard pins it here.
function mergeSupervisorEnv({ envPath, tunnelName, hostname, fillIfMissing = {}, dryRun } = {}) {
  const target = envPath || path.join(os.homedir(), '.termdeck', 'supervisor.env');
  const exists = fs.existsSync(target);
  const existing = exists ? dotenvMod().readSecrets(target) : {};
  const adds = {};
  for (const [k, v] of Object.entries(fillIfMissing)) {
    if (v == null || v === '') continue;
    if (existing[k] === undefined || existing[k] === '') adds[k] = v;
  }
  if (existing.TERMDECK_TUNNEL_NAME === tunnelName
      && existing.TERMDECK_PUBLIC_HOSTNAME === hostname
      && Object.keys(adds).length === 0) {
    return { status: 'already-set', envPath: target };
  }
  if (dryRun) {
    return { status: exists ? 'would-update' : 'would-create', envPath: target, added: Object.keys(adds) };
  }

  let backup = null;
  if (exists) {
    backup = `${target}.bak.${stamp()}`;
    try { fs.copyFileSync(target, backup); }
    catch (_e) { backup = null; }
  } else {
    // Seed a supervisor-appropriate banner so writeSecrets doesn't stamp the
    // fresh file with its secrets.env-specific header.
    writeFileAtomic(
      target,
      '# TermDeck supervisor overrides — sourced by termdeck-supervise.sh on every tick.\n'
      + '# Written by `termdeck init --bridge`; safe to hand-edit (re-read each tick, no reinstall needed).\n'
      + '\n',
      0o600
    );
  }
  dotenvMod().writeSecrets({
    TERMDECK_TUNNEL_NAME: tunnelName,
    TERMDECK_PUBLIC_HOSTNAME: hostname,
    ...adds
  }, target);
  return { status: exists ? 'updated' : 'created', envPath: target, backup, added: Object.keys(adds) };
}

// ── Operator one-shot scripts + supervision install plan ────────────────────
//
// Every command hand-off is a staged script invoked by ONE single-line `bash
// <path>` (INSTALLER-PITFALLS Class J / checklist #11: multi-line clipboard
// pastes shred on \r\n-converting terminals; one logical operation per
// invocation). The wizard itself NEVER execs cloudflared / launchctl /
// systemctl — staging files into the user's home is the entire extent of
// its authority here.

function buildSetupTunnelScript({ tunnelName, hostname }) {
  return `#!/usr/bin/env bash
# Staged by \`termdeck init --bridge\` — one-shot named-tunnel bootstrap.
# OPERATOR-RUN: \`cloudflared tunnel login\` opens a browser for Cloudflare
# auth; the wizard never runs these itself.
set -uo pipefail
command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared not found — macOS: brew install cloudflared | Linux: https://pkg.cloudflare.com"; exit 1; }
if [ ! -s "$HOME/.cloudflared/cert.pem" ]; then
  echo "==> cloudflared tunnel login (browser opens — authorize the zone that owns ${hostname})"
  cloudflared tunnel login || exit 1
else
  echo "==> origin cert already present ($HOME/.cloudflared/cert.pem) — skipping login"
fi
echo "==> cloudflared tunnel create ${tunnelName}"
cloudflared tunnel create '${tunnelName}' || echo "    (create failed — fine if the tunnel already exists)"
echo "==> cloudflared tunnel route dns ${tunnelName} ${hostname}"
cloudflared tunnel route dns '${tunnelName}' '${hostname}' || echo "    (route failed — fine if the DNS record already exists)"
echo "==> done. Back in the wizard, answer the re-check prompt — or re-run: termdeck init --bridge --yes"
`;
}

// Vendored supervisor assets — packed into the npm tarball via root
// package.json `files[]` entry `packages/cli/assets/**` (ORCH decision
// 2026-06-11 20:58; precedent: stack-installer's bundled hooks). The same
// relative layout exists in the monorepo and the extracted tarball, exactly
// like init-mnestra's HOOK_SOURCE resolution.
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'supervise');

function resolveSuperviseAssets(opts = {}) {
  const dir = opts.assetsDir || ASSETS_DIR;
  const names = {
    script: 'termdeck-supervise.sh',
    plist: `${SUPERVISE_LABEL}.plist`,
    service: 'termdeck-supervise.service',
    timer: 'termdeck-supervise.timer'
  };
  const paths = {};
  const missing = [];
  for (const [key, name] of Object.entries(names)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) paths[key] = p;
    else missing.push(name);
  }
  return { ok: missing.length === 0, dir, paths, missing };
}

// Token substitution for the vendored plist/service templates. Throws on any
// surviving __TERMDECK_*__ token so a half-rendered file can never reach disk
// (Class D: no placeholder may land in a config a runtime will consume).
function renderTemplate(content, tokens) {
  let out = content;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  const residual = out.match(/__TERMDECK_[A-Z_]+__/);
  if (residual) {
    throw new Error(`unresolved template token ${residual[0]} — vendored asset and wizard are out of sync`);
  }
  return out;
}

function buildLaunchdPlist({ scriptPath, home, assetsDir }) {
  const assets = resolveSuperviseAssets({ assetsDir });
  if (!assets.paths.plist) throw new Error(`vendored plist asset missing under ${assets.dir}`);
  return renderTemplate(fs.readFileSync(assets.paths.plist, 'utf8'), {
    __TERMDECK_SUPERVISE_SCRIPT__: scriptPath,
    __TERMDECK_HOME__: home
  });
}

function buildSystemdService({ scriptPath, assetsDir }) {
  const assets = resolveSuperviseAssets({ assetsDir });
  if (!assets.paths.service) throw new Error(`vendored service asset missing under ${assets.dir}`);
  return renderTemplate(fs.readFileSync(assets.paths.service, 'utf8'), {
    __TERMDECK_SUPERVISE_SCRIPT__: scriptPath
  });
}

function buildSystemdTimer({ assetsDir } = {}) {
  const assets = resolveSuperviseAssets({ assetsDir });
  if (!assets.paths.timer) throw new Error(`vendored timer asset missing under ${assets.dir}`);
  return fs.readFileSync(assets.paths.timer, 'utf8');
}

// linux-only: the wizard copies the unit files itself, so the one-shot is
// just the enable sequence (3 commands → still worth a single-line hand-off
// per Class J checklist #11). darwin needs no one-shot — its operator step
// is a single `launchctl load -w` line.
function buildInstallSupervisorScript() {
  return `#!/usr/bin/env bash
# Staged by \`termdeck init --bridge\` — enables the stack supervisor's 60s
# systemd user timer. The wizard already copied the unit files into
# ~/.config/systemd/user/; OPERATOR-RUN because the wizard never invokes
# systemctl/loginctl itself.
set -uo pipefail
systemctl --user daemon-reload
systemctl --user enable --now termdeck-supervise.timer
loginctl enable-linger "$(whoami)"
echo "==> supervisor timer enabled. Logs: journalctl --user -u termdeck-supervise.service -n 50"
`;
}

// Install plan, built ENTIRELY from the vendored package assets — identical
// behavior for npm-global installs and repo checkouts (no repo probe, no
// degraded path; ORCH decision 2026-06-11 20:58). The supervisor script is
// staged to ~/.termdeck/bridge-install/ and the launchd/systemd files point
// at THAT copy: a stable user-land path that survives npm upgrades and node
// version-manager switches, refreshed on every wizard run.
function buildSupervisorInstallPlan({ platform, home, stageDir, assetsDir } = {}) {
  const plat = platform || process.platform;
  const homeDir = home || os.homedir();
  const assets = resolveSuperviseAssets({ assetsDir });
  if (!assets.ok) {
    // A healthy install can never hit this (the packed-layout test pins the
    // tarball); reaching it means a corrupted/partial install — Class H made
    // loud instead of silent.
    return { ok: false, platform: plat, assetsDir: assets.dir, missing: assets.missing };
  }
  const stagedScript = path.join(stageDir, 'termdeck-supervise.sh');

  if (plat === 'darwin') {
    const dest = path.join(homeDir, 'Library', 'LaunchAgents', `${SUPERVISE_LABEL}.plist`);
    return {
      ok: true,
      platform: plat,
      assets,
      stagedScript,
      stageExtras: [],
      targets: [{
        kind: 'launchd plist',
        dest,
        mode: 0o644,
        content: buildLaunchdPlist({ scriptPath: stagedScript, home: homeDir, assetsDir: assets.dir })
      }],
      operatorLines: [`launchctl load -w ${dest}`],
      reloadHint: `launchctl unload -w ${dest}`,
      oneShot: null
    };
  }

  const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
  return {
    ok: true,
    platform: plat,
    assets,
    stagedScript,
    stageExtras: [
      { name: 'install-supervisor.sh', content: buildInstallSupervisorScript(), mode: 0o755 }
    ],
    targets: [
      {
        kind: 'systemd service',
        dest: path.join(unitDir, 'termdeck-supervise.service'),
        mode: 0o644,
        content: buildSystemdService({ scriptPath: stagedScript, assetsDir: assets.dir })
      },
      {
        kind: 'systemd timer',
        dest: path.join(unitDir, 'termdeck-supervise.timer'),
        mode: 0o644,
        content: buildSystemdTimer({ assetsDir: assets.dir })
      }
    ],
    operatorLines: [
      'systemctl --user daemon-reload',
      'systemctl --user enable --now termdeck-supervise.timer',
      'loginctl enable-linger "$(whoami)"'
    ],
    reloadHint: null,
    oneShot: path.join(stageDir, 'install-supervisor.sh')
  };
}

// Write a wizard-managed file (plist / systemd unit) to its FINAL path with
// the same safety contract as config.yml: byte-identical → no-op; a file we
// wrote (carries the wizard marker) → timestamped backup + update; a foreign
// file → kept unless explicitly consented (interactive confirm or --yes).
async function installManagedFile({ dest, content, mode = 0o644, dryRun, assumeYes, confirmFn } = {}) {
  let existing = null;
  try { existing = fs.readFileSync(dest, 'utf8'); } catch (_e) { existing = null; }

  if (existing === content) {
    return { status: 'already-current', dest };
  }
  if (existing === null) {
    if (dryRun) return { status: 'would-install', dest };
    writeFileAtomic(dest, content, mode);
    return { status: 'installed', dest };
  }

  const ours = existing.includes('termdeck init --bridge');
  if (!ours) {
    if (dryRun) return { status: 'would-replace-foreign', dest };
    let consent = !!assumeYes;
    if (!consent && typeof confirmFn === 'function') consent = await confirmFn();
    if (!consent) return { status: 'kept-foreign', dest };
  } else if (dryRun) {
    return { status: 'would-update', dest };
  }

  let backup = `${dest}.bak.${stamp()}`;
  try { fs.copyFileSync(dest, backup); }
  catch (_e) { backup = null; }
  writeFileAtomic(dest, content, mode);
  return { status: ours ? 'updated' : 'replaced', dest, backup };
}

function stageFiles({ stageDir, files, dryRun }) {
  if (dryRun) return { status: 'would-stage', stageDir, names: files.map((f) => f.name) };
  fs.mkdirSync(stageDir, { recursive: true });
  for (const f of files) {
    writeFileAtomic(path.join(stageDir, f.name), f.content, f.mode);
    // writeFileAtomic's rename preserves the tmp file's mode, but be explicit
    // in case the tmp inherited a stricter umask.
    try { fs.chmodSync(path.join(stageDir, f.name), f.mode); } catch (_e) { /* best-effort */ }
  }
  return { status: 'staged', stageDir, names: files.map((f) => f.name) };
}

// ── Tier 5 reachability checks (GETTING-STARTED.md § Tier 5 Step 4) ────────

async function checkLocalBridgeUp({ fetchImpl, port = BRIDGE_PORT } = {}) {
  const f = fetchImpl || fetch;
  try {
    const res = await f(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2500) });
    return !!(res && res.ok);
  } catch (_e) {
    return false;
  }
}

async function runReachabilityChecks({ hostname, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const base = `https://${hostname}`;
  const results = [];

  async function probe(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err && err.message || String(err) });
    }
  }

  await probe(`GET ${base}/healthz`, async () => {
    const res = await f(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (expected 200)`);
    const body = await res.json();
    if (body.ok !== true) throw new Error('body.ok !== true');
    const wantResource = `${base}/mcp`;
    if (body.resource !== wantResource) {
      throw new Error(`resource is ${body.resource} (expected ${wantResource}) — the bridge is pinned to a stale URL; the supervisor re-pins it on its next tick`);
    }
    return `ok, resource=${body.resource}`;
  });

  await probe(`GET ${base}/.well-known/oauth-protected-resource/mcp`, async () => {
    const res = await f(`${base}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (expected 200)`);
    const body = await res.json();
    if (!body.resource) throw new Error('missing resource');
    if (!Array.isArray(body.authorization_servers) || body.authorization_servers.length === 0) {
      throw new Error('missing authorization_servers');
    }
    return 'resource + authorization_servers present';
  });

  await probe(`GET ${base}/.well-known/oauth-authorization-server`, async () => {
    const res = await f(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (expected 200)`);
    const body = await res.json();
    const methods = body.code_challenge_methods_supported || [];
    if (!methods.includes('S256')) throw new Error('S256 missing from code_challenge_methods_supported');
    return 'S256 PKCE advertised';
  });

  // The unauthenticated POST MUST be rejected — a 200 here means the OAuth
  // gate is broken and the bridge is exposed; this check exists to fail loud.
  await probe(`POST ${base}/mcp (unauthenticated)`, async () => {
    const res = await f(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      signal: AbortSignal.timeout(8000)
    });
    if (res.status !== 401) {
      throw new Error(`HTTP ${res.status} (expected 401 — unauthenticated requests MUST be rejected)`);
    }
    return '401 as required';
  });

  return results;
}

function printCheckResults(results) {
  for (const r of results) {
    if (r.ok) process.stdout.write(`    ✓ ${r.name} — ${r.detail}\n`);
    else process.stdout.write(`    ✗ ${r.name} — ${r.detail}\n`);
  }
}

// ── Wizard flow ──────────────────────────────────────────────────────────────

function printBanner() {
  process.stdout.write(`
TermDeck Web-Chat Bridge Setup (Tier 5)
───────────────────────────────────────

This wizard makes the Bridge's public URL permanent (named cloudflared
tunnel) and self-healing (stack supervisor on a 60s timer) by:
  1. Asking for a tunnel name + the public hostname for the Bridge
  2. Writing ~/.termdeck/supervisor.env immediately (merge-aware, backed
     up — an abort later cannot lose what you typed in)
  3. PRINTING the cloudflared login/create/route steps for you to run
     (browser auth — the wizard never runs them) and waiting for the
     tunnel credentials to appear
  4. Writing ~/.cloudflared/config.yml (backing up any existing file)
  5. Copying the supervisor files into place from the vendored package
     assets, then PRINTING the launchctl / systemctl enable steps
     (never run by the wizard)
  6. Verifying public reachability with the four Tier 5 checks

Read-only by construction, approval-gated, egress-redacted — the security
model lives in packages/mcp-bridge/README.md. Manual flow + provider
wiring: docs/GETTING-STARTED.md § Tier 5.

Press Ctrl+C at any time to cancel.

`);
}

async function askWithDefaultValidated(question, defaultValue, validator) {
  for (let i = 0; i < 3; i++) {
    const answer = await promptsMod().ask(question, defaultValue ? { defaultValue } : {});
    if (!answer) { process.stdout.write('  (required)\n'); continue; }
    const err = validator(answer);
    if (err) { process.stdout.write(`  ${err}\n`); continue; }
    return answer.trim();
  }
  throw new Error('Too many invalid attempts — cancelling. (Non-interactive? Use --from-env with TERMDECK_PUBLIC_HOSTNAME + TERMDECK_TUNNEL_NAME.)');
}

function inputsFromEnv() {
  const hostname = (process.env.TERMDECK_PUBLIC_HOSTNAME || '').trim().toLowerCase();
  const tunnelName = (process.env.TERMDECK_TUNNEL_NAME || '').trim() || DEFAULT_TUNNEL_NAME;
  if (!hostname) {
    throw new Error(
      '--from-env is missing required environment variable(s): TERMDECK_PUBLIC_HOSTNAME.\n'
      + 'Set it (and optionally TERMDECK_TUNNEL_NAME) and re-run, e.g.:\n'
      + '  TERMDECK_PUBLIC_HOSTNAME=bridge.example.com TERMDECK_TUNNEL_NAME=termdeck-bridge termdeck init --bridge --from-env'
    );
  }
  const hErr = validateHostname(hostname);
  if (hErr) throw new Error(`TERMDECK_PUBLIC_HOSTNAME: ${hErr}`);
  const tErr = validateTunnelName(tunnelName);
  if (tErr) throw new Error(`TERMDECK_TUNNEL_NAME: ${tErr}`);
  return { tunnelName, hostname };
}

async function collectInputs({ yes, reset, existing }) {
  // Resume / idempotent-re-run path: a complete pair already in
  // supervisor.env is offered back (update-or-keep), mirroring
  // init-mnestra's saved-secrets reuse idiom.
  const existingValid = existing
    && existing.tunnelName && !validateTunnelName(existing.tunnelName)
    && existing.hostname && !validateHostname(existing.hostname);
  if (!reset && existingValid) {
    process.stdout.write(
      `Found existing bridge settings in ~/.termdeck/supervisor.env `
      + `(tunnel '${existing.tunnelName}', hostname ${existing.hostname}).\n`
    );
    const reuse = yes ? true : await promptsMod().confirm('  Keep these settings?', { defaultYes: true });
    if (reuse) {
      process.stdout.write('  Keeping existing settings.\n\n');
      return { tunnelName: existing.tunnelName, hostname: existing.hostname.toLowerCase() };
    }
    process.stdout.write('  Re-prompting.\n\n');
  }

  const tunnelName = await askWithDefaultValidated(
    '? Tunnel name',
    (existing && existing.tunnelName) || DEFAULT_TUNNEL_NAME,
    validateTunnelName
  );
  const hostname = (await askWithDefaultValidated(
    '? Public hostname for the Bridge (e.g. bridge.example.com — DNS must be on Cloudflare)',
    (existing && existing.hostname) || null,
    validateHostname
  )).toLowerCase();
  process.stdout.write('\n');
  return { tunnelName, hostname };
}

function printOperatorTunnelSteps({ tunnelName, hostname, stageDir, staged, certPresent }) {
  process.stdout.write('\nNext: create the named tunnel — operator steps, run in another terminal.\n');
  process.stdout.write('(Browser auth is involved; the wizard never runs these itself.)\n\n');
  if (staged) {
    process.stdout.write(`  One-shot:        bash ${path.join(stageDir, 'setup-tunnel.sh')}\n\n`);
    process.stdout.write('  …or step-by-step, one line at a time:\n');
  } else {
    process.stdout.write('  Step-by-step, one line at a time:\n');
  }
  process.stdout.write(`    cloudflared tunnel login${certPresent ? '   # cert.pem already present — skip' : ''}\n`);
  process.stdout.write(`    cloudflared tunnel create '${tunnelName}'\n`);
  process.stdout.write(`    cloudflared tunnel route dns '${tunnelName}' '${hostname}'\n\n`);
}

function printResumeHint() {
  process.stderr.write(
    '\nYour answers are saved in ~/.termdeck/supervisor.env.\n'
    + 'After completing the cloudflared steps, resume with:\n'
    + '  termdeck init --bridge --yes\n'
  );
}

function printNextSteps({ hostname }) {
  process.stdout.write(`
The Web-Chat Bridge is scaffolded.

Connector URL (paste into each provider): https://${hostname}/mcp
Operator consent secret: ~/.termdeck/bridge-operator-secret.txt
  (created by the supervisor's first tick if missing; it never rotates)

Provider wiring (full table: docs/GETTING-STARTED.md § Tier 5 Step 5):
  Claude.ai   Settings → Connectors → Add custom connector
  ChatGPT     Settings → Apps & Connectors → "New App" dialog
  Grok        grok.com → Connectors → New → Custom

Re-check public reachability anytime: termdeck init --bridge --verify-only
`);
}

async function runVerifyPass({ hostname, fetchImpl, verifyOnly }) {
  step(`Checking the local bridge (http://127.0.0.1:${BRIDGE_PORT}/healthz)...`);
  const localUp = await checkLocalBridgeUp({ fetchImpl });
  if (!localUp) {
    ok('not up yet');
    process.stdout.write(
      '    The stack isn\'t running locally — expected before the supervisor\'s first tick.\n'
      + '    Once the supervisor is installed (step above), verify with:\n'
      + '      termdeck init --bridge --verify-only\n'
    );
    return { ran: false, allOk: false };
  }
  ok('up');

  step(`Running the four Tier 5 reachability checks against https://${hostname} ...`);
  process.stdout.write('\n');
  const results = await runReachabilityChecks({ hostname, fetchImpl });
  printCheckResults(results);
  const allOk = results.every((r) => r.ok);
  if (allOk) {
    process.stdout.write('    All four checks passed — any provider can discover, register, and complete OAuth.\n');
  } else if (!verifyOnly) {
    process.stdout.write(
      '    Some checks failed. Fresh DNS routes + tunnel starts can take a minute to propagate;\n'
      + '    re-check with: termdeck init --bridge --verify-only\n'
    );
  }
  return { ran: true, allOk };
}

async function main(argv) {
  const flags = parseFlags(argv || []);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const HOME = os.homedir();
  const cloudflaredDir = path.join(HOME, '.cloudflared');
  const configPath = path.join(cloudflaredDir, 'config.yml');
  const envPath = path.join(HOME, '.termdeck', 'supervisor.env');
  const stageDir = path.join(HOME, '.termdeck', 'bridge-install');
  const nonInteractive = flags.fromEnv || flags.yes;

  // ── --verify-only: no prompts, no writes, exit 4 on any failure ──────────
  if (flags.verifyOnly) {
    const saved = fs.existsSync(envPath) ? dotenvMod().readSecrets(envPath) : {};
    const hostname = (saved.TERMDECK_PUBLIC_HOSTNAME || process.env.TERMDECK_PUBLIC_HOSTNAME || '').trim().toLowerCase();
    if (!hostname || validateHostname(hostname)) {
      process.stderr.write(
        '[init --bridge] --verify-only needs a configured hostname — none found in '
        + '~/.termdeck/supervisor.env (TERMDECK_PUBLIC_HOSTNAME) or the environment.\n'
        + 'Run the wizard first: termdeck init --bridge\n'
      );
      return 2;
    }
    process.stdout.write(`Verifying Bridge reachability for https://${hostname}\n\n`);
    const verdict = await runVerifyPass({ hostname, verifyOnly: true });
    return verdict.ran && verdict.allOk ? 0 : 4;
  }

  printBanner();

  // ── Preflight ─────────────────────────────────────────────────────────────
  step('Checking for cloudflared on PATH...');
  const haveCloudflared = detectCloudflared();
  if (haveCloudflared) ok();
  else {
    ok('not found');
    process.stdout.write(
      '    Install it first — macOS: brew install cloudflared | Linux: https://pkg.cloudflare.com\n'
      + '    (The wizard continues; the staged one-shot re-checks before running anything.)\n'
    );
  }

  const certPath = path.join(cloudflaredDir, 'cert.pem');
  step('Checking ~/.cloudflared/cert.pem (origin cert from `cloudflared tunnel login`)...');
  let certPresent = false;
  try { certPresent = fs.statSync(certPath).size > 0; } catch (_e) { certPresent = false; }
  ok(certPresent ? 'present' : 'not yet — the login step below creates it');

  step('Checking ~/.termdeck/supervisor.env...');
  const savedEnv = fs.existsSync(envPath) ? dotenvMod().readSecrets(envPath) : {};
  const existing = {
    tunnelName: savedEnv.TERMDECK_TUNNEL_NAME || null,
    hostname: savedEnv.TERMDECK_PUBLIC_HOSTNAME || null
  };
  if (existing.tunnelName || existing.hostname) {
    ok(`found (tunnel ${existing.tunnelName || '—'}, hostname ${existing.hostname || '—'})`);
  } else {
    ok('not yet created (will create)');
  }

  step('Checking ~/.cloudflared/config.yml...');
  ok(fs.existsSync(configPath) ? 'present' : 'not yet created (will create)');
  process.stdout.write('\n');

  // ── Collect inputs ────────────────────────────────────────────────────────
  let inputs;
  try {
    inputs = flags.fromEnv
      ? inputsFromEnv()
      : await collectInputs({ yes: flags.yes, reset: flags.reset, existing });
  } catch (err) {
    process.stderr.write(`\n[init --bridge] ${err.message}\n`);
    return 2;
  }
  if (flags.fromEnv) {
    process.stdout.write(`Using environment values (--from-env): tunnel '${inputs.tunnelName}', hostname ${inputs.hostname}.\n\n`);
  }

  // ── Persist-first (Class C): supervisor.env lands BEFORE the operator
  //    wait-loop so an abort there cannot lose the typed-in answers. ─────────
  // TERMDECK_REPO_DIR fill: the supervisor script is staged under
  // ~/.termdeck/bridge-install/, so its parent-dir REPO_DIR derivation would
  // resolve wrong — pin the package/repo root via the supervisor's own env
  // override. fill-if-missing only; an operator-set value always wins.
  const pkgRoot = path.resolve(__dirname, '..', '..', '..');
  step('Writing ~/.termdeck/supervisor.env (TERMDECK_TUNNEL_NAME + TERMDECK_PUBLIC_HOSTNAME)...');
  let envResult;
  try {
    envResult = mergeSupervisorEnv({
      envPath,
      tunnelName: inputs.tunnelName,
      hostname: inputs.hostname,
      fillIfMissing: { TERMDECK_REPO_DIR: pkgRoot },
      dryRun: flags.dryRun
    });
  } catch (err) {
    fail(err.message);
    process.stderr.write('\nFailed to write ~/.termdeck/supervisor.env. Check the directory is writable.\n');
    return 6;
  }
  const addedSuffix = envResult.added && envResult.added.length
    ? ` (set ${envResult.added.join(', ')})` : '';
  if (envResult.status === 'already-set') ok('already set (no change)');
  else if (envResult.status === 'created') ok(`created${addedSuffix}`);
  else if (envResult.status === 'updated') ok((envResult.backup ? `updated (backup: ${path.basename(envResult.backup)})` : 'updated') + addedSuffix);
  else ok(`(${envResult.status}${addedSuffix})`); // would-create / would-update (dry-run)

  // ── Stage the vendored supervisor script + operator one-shots ─────────────
  const plan = buildSupervisorInstallPlan({ platform: process.platform, home: HOME, stageDir });
  const stageList = [
    { name: 'setup-tunnel.sh', content: buildSetupTunnelScript(inputs), mode: 0o755 },
    ...(plan.ok
      ? [
        { name: 'termdeck-supervise.sh', content: fs.readFileSync(plan.assets.paths.script, 'utf8'), mode: 0o755 },
        ...plan.stageExtras
      ]
      : [])
  ];
  step(`Staging the supervisor script + operator one-shots in ${stageDir}...`);
  try {
    const staged = stageFiles({ stageDir, files: stageList, dryRun: flags.dryRun });
    if (staged.status === 'staged') ok(`(${staged.names.join(', ')})`);
    else ok(`(dry-run — would stage ${staged.names.join(', ')})`);
  } catch (err) {
    fail(err.message);
    process.stderr.write('\nFailed to stage scripts under ~/.termdeck/. Check the directory is writable.\n');
    return 6;
  }

  // ── Tunnel credentials: detect, or hand off to the operator and wait ─────
  step(`Looking for tunnel credentials in ~/.cloudflared/ (tunnel '${inputs.tunnelName}')...`);
  let found = findTunnelCredentials({
    cloudflaredDir,
    tunnelName: inputs.tunnelName,
    tunnelId: flags.tunnelId
  });

  if (found.status === 'id-not-found') {
    ok('no match');
    process.stderr.write(
      `\n[init --bridge] --tunnel-id ${flags.tunnelId} does not match any credentials file in ~/.cloudflared/.\n`
      + (found.candidates.length
        ? `Found: ${found.candidates.map((c) => c.tunnelId).join(', ')}\n`
        : 'No tunnel credentials found at all — run the cloudflared steps first.\n')
    );
    printResumeHint();
    return 3;
  }

  if (found.status === 'none') {
    ok('none yet');
    printOperatorTunnelSteps({ ...inputs, stageDir, staged: !flags.dryRun, certPresent });
    if (flags.dryRun) {
      process.stdout.write('(dry-run) config.yml step pending tunnel credentials — shown as a plan below.\n');
    } else if (nonInteractive) {
      // One immediate re-check covers the "operator already ran the steps in
      // parallel" race, then hand control back rather than hanging a script.
      found = findTunnelCredentials({ cloudflaredDir, tunnelName: inputs.tunnelName, tunnelId: flags.tunnelId });
      if (found.status === 'none' || found.status === 'ambiguous') {
        process.stdout.write('Tunnel credentials not present yet — run the steps above, then resume.\n');
        printResumeHint();
        return 3;
      }
    } else {
      while (found.status === 'none') {
        const again = await promptsMod().confirm(
          '  Completed those steps in another terminal — re-check for tunnel credentials?',
          { defaultYes: true }
        );
        if (!again) { printResumeHint(); return 3; }
        found = findTunnelCredentials({ cloudflaredDir, tunnelName: inputs.tunnelName, tunnelId: flags.tunnelId });
        if (found.status === 'none') {
          process.stdout.write(`  Still no credentials JSON in ~/.cloudflared/ — looking for <tunnel-id>.json created by \`cloudflared tunnel create '${inputs.tunnelName}'\`.\n`);
        }
      }
    }
  } else if (found.status === 'match') {
    ok(`found (${found.creds.tunnelId})`);
  } else if (found.status === 'single') {
    ok(`found one credentials file (${found.creds.tunnelId})`);
  } else if (found.status === 'ambiguous') {
    ok(`${found.candidates.length} candidates`);
  }

  // Disambiguate when multiple credentials exist and none is name-matched.
  // Never guess silently (Class D posture): interactive picks, non-interactive
  // exits with the list and the --tunnel-id escape hatch.
  if (found.status === 'ambiguous') {
    process.stdout.write('\nMultiple tunnel credentials found and none is name-matched (older cloudflared writes no TunnelName):\n');
    for (const c of found.candidates) {
      process.stdout.write(`  ${c.tunnelId}  (${c.tunnelName || 'unnamed'}, modified ${new Date(c.mtimeMs).toISOString().slice(0, 10)})\n`);
    }
    if (nonInteractive || flags.dryRun) {
      process.stderr.write('\n[init --bridge] cannot pick a tunnel non-interactively — re-run with --tunnel-id <uuid> from the list above.\n');
      return 3;
    }
    const ids = new Set(found.candidates.map((c) => c.tunnelId));
    const pickedId = await promptsMod().askRequired('? Tunnel ID to use for this bridge', {
      validate: (v) => (ids.has(v.trim()) ? null : 'not in the list above')
    });
    found = { status: 'match', creds: found.candidates.find((c) => c.tunnelId === pickedId.trim()), candidates: found.candidates };
  }

  // 'single' with no name metadata: confirm it belongs to this tunnel name
  // before binding config.yml to it (auto-accepted under --yes/--from-env,
  // loudly logged either way).
  if (found.status === 'single' && !found.creds.tunnelName && !flags.tunnelId && !flags.dryRun) {
    if (!nonInteractive) {
      const useIt = await promptsMod().confirm(
        `  Use credentials ${path.basename(found.creds.file)} for tunnel '${inputs.tunnelName}'?`,
        { defaultYes: true }
      );
      if (!useIt) {
        process.stderr.write('\n[init --bridge] re-run with --tunnel-id <uuid> to pick explicitly.\n');
        return 3;
      }
    } else {
      process.stdout.write(`  Using the only credentials file present: ${path.basename(found.creds.file)}\n`);
    }
  }

  // ── config.yml ────────────────────────────────────────────────────────────
  if (found.creds) {
    step('Writing ~/.cloudflared/config.yml (ingress → http://127.0.0.1:' + BRIDGE_PORT + ')...');
    let cfg;
    try {
      cfg = await writeCloudflaredConfig({
        cloudflaredDir,
        configPath,
        tunnelId: found.creds.tunnelId,
        hostname: inputs.hostname,
        dryRun: flags.dryRun,
        assumeYes: flags.yes || flags.fromEnv,
        confirmFn: nonInteractive ? null : () => promptsMod().confirm(
          '\n  Existing ~/.cloudflared/config.yml was NOT written by this wizard. Back it up and replace?',
          { defaultYes: false }
        )
      });
    } catch (err) {
      fail(err.message);
      process.stderr.write('\nFailed to write ~/.cloudflared/config.yml. Check the directory is writable.\n');
      return 6;
    }
    if (cfg.status === 'already-configured') ok('already configured (no change)');
    else if (cfg.status === 'written') ok('written');
    else if (cfg.status === 'updated' || cfg.status === 'replaced') ok(cfg.backup ? `${cfg.status} (backup: ${path.basename(cfg.backup)})` : cfg.status);
    else if (cfg.status === 'kept-foreign') {
      ok('kept existing file (your choice)');
      process.stdout.write(
        '    The named tunnel will not route to the Bridge until config.yml includes this ingress\n'
        + '    (merge it manually, or re-run with --yes to replace — a timestamped backup is always written):\n\n'
        + `      tunnel: ${found.creds.tunnelId}\n`
        + `      credentials-file: ${path.join(cloudflaredDir, found.creds.tunnelId + '.json')}\n`
        + '      ingress:\n'
        + `        - hostname: ${inputs.hostname}\n`
        + `          service: http://127.0.0.1:${BRIDGE_PORT}\n`
        + '        - service: http_status:404\n\n'
      );
    } else ok(`(${cfg.status})`); // would-write / would-update / would-replace-foreign (dry-run)
  }

  // ── Supervisor install: copy the vendored files AS FILES to their final
  //    paths, then print the operator load/enable steps — never exec'd
  //    (ORCH decision 2026-06-11 20:58) ───────────────────────────────────────
  if (!plan.ok) {
    step('Installing supervisor files...');
    fail(`vendored supervisor assets missing under ${plan.assetsDir}: ${plan.missing.join(', ')}`);
    process.stdout.write(
      '    This install looks corrupted — the assets ship inside the npm package.\n'
      + '    Reinstall with: npm install -g @jhizzard/termdeck@latest\n'
    );
  } else {
    let wroteAny = false;
    let keptForeign = false;
    let reloadNeeded = false;
    for (const target of plan.targets) {
      step(`Installing ${target.kind} → ${target.dest}...`);
      let r;
      try {
        r = await installManagedFile({
          dest: target.dest,
          content: target.content,
          mode: target.mode,
          dryRun: flags.dryRun,
          assumeYes: flags.yes,
          confirmFn: nonInteractive ? null : () => promptsMod().confirm(
            `\n  Existing ${target.kind} at ${target.dest} was NOT written by this wizard. Back it up and replace?`,
            { defaultYes: false }
          )
        });
      } catch (err) {
        // Fail-soft: a supervisor-file failure should not strand the verify
        // pass or the next-steps print; the operator can re-run.
        fail(err.message);
        continue;
      }
      if (r.status === 'already-current') ok('already installed (current)');
      else if (r.status === 'installed') { ok('installed'); wroteAny = true; }
      else if (r.status === 'updated' || r.status === 'replaced') {
        ok(r.backup ? `${r.status} (backup: ${path.basename(r.backup)})` : r.status);
        wroteAny = true;
        reloadNeeded = true;
      } else if (r.status === 'kept-foreign') {
        ok('kept existing file (your choice)');
        keptForeign = true;
      } else {
        ok(`(${r.status})`); // would-install / would-update / would-replace-foreign (dry-run)
      }
    }
    if (keptForeign) {
      process.stdout.write(
        '    Kept a non-wizard-managed supervisor file — it keeps running whatever it points at.\n'
        + '    Re-run with --yes to adopt the managed version (a timestamped backup is always written).\n'
      );
    }
    if (!flags.dryRun && !wroteAny && !keptForeign) {
      process.stdout.write(
        '    Supervisor files already current. The supervisor re-reads supervisor.env every tick —\n'
        + '    new tunnel settings need no reinstall.\n'
        + `    (Not ticking yet? Run: ${plan.oneShot ? `bash ${plan.oneShot}` : plan.operatorLines[0]})\n`
      );
    } else {
      process.stdout.write('\nEnable the supervisor — operator step, the wizard never runs '
        + (plan.platform === 'darwin' ? 'launchctl' : 'systemctl') + ':\n\n');
      if (plan.oneShot && !flags.dryRun) {
        process.stdout.write(`  One-shot:        bash ${plan.oneShot}\n\n`);
        process.stdout.write('  …or step-by-step, one line at a time:\n');
      }
      for (const line of plan.operatorLines) process.stdout.write(`    ${line}\n`);
      if (reloadNeeded && plan.reloadHint) {
        process.stdout.write(`    (already loaded? unload first so the change is picked up: ${plan.reloadHint})\n`);
      }
      process.stdout.write('\n');
    }
  }

  // ── Verify pass ───────────────────────────────────────────────────────────
  if (flags.dryRun) {
    process.stdout.write('\nDry run complete. No changes were made.\n');
    return 0;
  }
  if (flags.skipVerify) {
    process.stdout.write('\nSkipping reachability checks (--skip-verify).\n');
  } else {
    process.stdout.write('\n');
    await runVerifyPass({ hostname: inputs.hostname, verifyOnly: false });
  }

  printNextSteps({ hostname: inputs.hostname });
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      process.stderr.write(`\n[init --bridge] unexpected error: ${err && err.stack || err}\n`);
      process.exit(1);
    });
}

module.exports = main;
// Exported for packages/cli/tests/init-bridge.test.js — same pattern as
// init-mnestra.js's test exports.
module.exports.parseFlags = parseFlags;
module.exports.validateTunnelName = validateTunnelName;
module.exports.validateHostname = validateHostname;
module.exports.detectCloudflared = detectCloudflared;
module.exports.findTunnelCredentials = findTunnelCredentials;
module.exports.buildCloudflaredConfigYml = buildCloudflaredConfigYml;
module.exports.readCloudflaredConfigState = readCloudflaredConfigState;
module.exports.writeCloudflaredConfig = writeCloudflaredConfig;
module.exports.mergeSupervisorEnv = mergeSupervisorEnv;
module.exports.buildSetupTunnelScript = buildSetupTunnelScript;
module.exports.resolveSuperviseAssets = resolveSuperviseAssets;
module.exports.renderTemplate = renderTemplate;
module.exports.buildLaunchdPlist = buildLaunchdPlist;
module.exports.buildSystemdService = buildSystemdService;
module.exports.buildSystemdTimer = buildSystemdTimer;
module.exports.buildInstallSupervisorScript = buildInstallSupervisorScript;
module.exports.buildSupervisorInstallPlan = buildSupervisorInstallPlan;
module.exports.installManagedFile = installManagedFile;
module.exports.stageFiles = stageFiles;
module.exports.SUPERVISE_ASSETS_DIR = ASSETS_DIR;
module.exports.runReachabilityChecks = runReachabilityChecks;
module.exports.checkLocalBridgeUp = checkLocalBridgeUp;
module.exports.DEFAULT_TUNNEL_NAME = DEFAULT_TUNNEL_NAME;
module.exports.BRIDGE_PORT = BRIDGE_PORT;
module.exports.CONFIG_MARKER = CONFIG_MARKER;
