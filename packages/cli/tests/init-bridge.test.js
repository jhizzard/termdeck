// Sprint 73 T2 — `termdeck init --bridge` wizard regression suite.
//
// Covers the Tier 5 bridge wizard (packages/cli/src/init-bridge.js): tunnel
// credentials discovery, config.yml + supervisor.env scaffolding (idempotency
// + backup-before-overwrite + foreign-file consent), operator one-shot
// staging, the four Tier 5 reachability checks (injected fetch — NO network
// in tests), CLI dispatch (the `--bridge` branch must win over the
// leading-dash fall-through into init.js — T4-CODEX 2026-06-11 20:24 ET
// tripwire), and a static pin that the wizard source never execs
// cloudflared / launchctl / systemctl.
//
// Co-located under packages/cli/tests/ so the suite rides the official
// `npm test` glob (package.json:35) — repo-root tests/ is NOT in CI
// (Sprint 67 precedent).
//
// Run directly: node --test packages/cli/tests/init-bridge.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.js');
const BRIDGE_SRC = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'init-bridge.js');
const CANONICAL_PLIST = path.join(REPO_ROOT, 'scripts', 'com.jhizzard.termdeck-supervise.plist');

const initBridge = require('../src/init-bridge');
const {
  parseFlags,
  validateTunnelName,
  validateHostname,
  findTunnelCredentials,
  buildCloudflaredConfigYml,
  writeCloudflaredConfig,
  mergeSupervisorEnv,
  buildSetupTunnelScript,
  resolveSuperviseAssets,
  renderTemplate,
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdTimer,
  buildInstallSupervisorScript,
  buildSupervisorInstallPlan,
  installManagedFile,
  runReachabilityChecks,
  checkLocalBridgeUp,
  DEFAULT_TUNNEL_NAME,
  BRIDGE_PORT,
  CONFIG_MARKER,
  SUPERVISE_ASSETS_DIR
} = initBridge;

const IS_DARWIN = process.platform === 'darwin';

const TUNNEL_ID = '11111111-2222-3333-4444-555555555555';
const TUNNEL_ID_B = '99999999-8888-7777-6666-555555555555';

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'init-bridge-'));
}

function seedCreds(dir, tunnelId, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tunnelId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    AccountTag: 'acct123',
    TunnelSecret: 'sssh-not-real',
    TunnelID: tunnelId,
    Endpoint: '',
    ...extra
  }));
  return file;
}

function bakFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.includes('.bak.')); }
  catch (_e) { return []; }
}

// ── parseFlags + validators ─────────────────────────────────────────────────

test('parseFlags captures --tunnel-id value and ignores unknown flags', () => {
  const f = parseFlags(['--yes', '--tunnel-id', TUNNEL_ID, '--wat', '--dry-run']);
  assert.equal(f.yes, true);
  assert.equal(f.tunnelId, TUNNEL_ID);
  assert.equal(f.dryRun, true);
  assert.equal(f.help, false);
});

test('validateHostname rejects placeholders, schemes, paths, dotless names; accepts real hostnames', () => {
  assert.equal(validateHostname('bridge.example.com'), null);
  assert.equal(validateHostname('BRIDGE.Example.Com'), null);
  assert.match(validateHostname('bridge.<your-domain>'), /placeholder/);
  assert.match(validateHostname('https://bridge.example.com'), /scheme/);
  assert.match(validateHostname('bridge.example.com/mcp'), /path/);
  assert.ok(validateHostname('localhost'));
  assert.ok(validateHostname(''));
});

test('validateTunnelName accepts the default and rejects spaces / leading dash', () => {
  assert.equal(validateTunnelName(DEFAULT_TUNNEL_NAME), null);
  assert.ok(validateTunnelName('bad name'));
  assert.ok(validateTunnelName('-lead'));
  assert.ok(validateTunnelName(''));
});

// ── findTunnelCredentials ───────────────────────────────────────────────────

test('findTunnelCredentials: missing dir → none', () => {
  const dir = path.join(freshTmpDir(), 'nope');
  const r = findTunnelCredentials({ cloudflaredDir: dir, tunnelName: 'x' });
  assert.equal(r.status, 'none');
  assert.deepEqual(r.candidates, []);
});

test('findTunnelCredentials: single credentials file (no TunnelName, the current-cloudflared shape) → single, secret not exposed', () => {
  const dir = freshTmpDir();
  try {
    seedCreds(dir, TUNNEL_ID);
    // Non-credentials JSON noise + malformed JSON must both be skipped.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ foo: 1 }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    const r = findTunnelCredentials({ cloudflaredDir: dir, tunnelName: 'termdeck-bridge' });
    assert.equal(r.status, 'single');
    assert.equal(r.creds.tunnelId, TUNNEL_ID);
    assert.equal(r.creds.tunnelName, null);
    assert.equal('TunnelSecret' in r.creds, false);
    assert.equal(JSON.stringify(r).includes('sssh-not-real'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findTunnelCredentials: TunnelName match wins over other candidates', () => {
  const dir = freshTmpDir();
  try {
    seedCreds(dir, TUNNEL_ID);
    seedCreds(dir, TUNNEL_ID_B, { TunnelName: 'termdeck-bridge' });
    const r = findTunnelCredentials({ cloudflaredDir: dir, tunnelName: 'termdeck-bridge' });
    assert.equal(r.status, 'match');
    assert.equal(r.creds.tunnelId, TUNNEL_ID_B);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findTunnelCredentials: multiple unnamed credentials → ambiguous, newest first', () => {
  const dir = freshTmpDir();
  try {
    const a = seedCreds(dir, TUNNEL_ID);
    const b = seedCreds(dir, TUNNEL_ID_B);
    const old = new Date(Date.now() - 86400000);
    fs.utimesSync(a, old, old);
    const r = findTunnelCredentials({ cloudflaredDir: dir, tunnelName: 'termdeck-bridge' });
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.candidates.length, 2);
    assert.equal(r.candidates[0].tunnelId, TUNNEL_ID_B);
    assert.ok(b);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findTunnelCredentials: explicit tunnelId picks among many; unknown id → id-not-found', () => {
  const dir = freshTmpDir();
  try {
    seedCreds(dir, TUNNEL_ID);
    seedCreds(dir, TUNNEL_ID_B);
    const hit = findTunnelCredentials({ cloudflaredDir: dir, tunnelId: TUNNEL_ID });
    assert.equal(hit.status, 'match');
    assert.equal(hit.creds.tunnelId, TUNNEL_ID);
    const miss = findTunnelCredentials({ cloudflaredDir: dir, tunnelId: '00000000-0000-0000-0000-000000000000' });
    assert.equal(miss.status, 'id-not-found');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── writeCloudflaredConfig ──────────────────────────────────────────────────

test('writeCloudflaredConfig: fresh write contains tunnel id, abs credentials path, ingress to :8870, 404 fallback, marker', async () => {
  const dir = freshTmpDir();
  try {
    const r = await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com' });
    assert.equal(r.status, 'written');
    const raw = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
    assert.match(raw, new RegExp(`tunnel: ${TUNNEL_ID}`));
    assert.ok(raw.includes(`credentials-file: ${path.join(dir, TUNNEL_ID + '.json')}`));
    assert.ok(raw.includes('- hostname: bridge.example.com'));
    assert.ok(raw.includes(`service: http://127.0.0.1:${BRIDGE_PORT}`));
    assert.ok(raw.includes('service: http_status:404'));
    assert.ok(raw.includes(CONFIG_MARKER));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeCloudflaredConfig: semantically-matching hand-written config (no marker — the PR #23 manual-flow shape) → already-configured, untouched', async () => {
  const dir = freshTmpDir();
  try {
    const credsFile = path.join(dir, `${TUNNEL_ID}.json`);
    // Byte-shape lifted from the real machine's manual Tier 5 config.yml.
    const manual = [
      `tunnel: ${TUNNEL_ID}`,
      `credentials-file: ${credsFile}`,
      'ingress:',
      '  - hostname: bridge.example.com',
      `    service: http://127.0.0.1:${BRIDGE_PORT}`,
      '  - service: http_status:404',
      ''
    ].join('\n');
    const cfgPath = path.join(dir, 'config.yml');
    fs.writeFileSync(cfgPath, manual);
    const before = fs.readFileSync(cfgPath, 'utf8');

    const r = await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com' });
    assert.equal(r.status, 'already-configured');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);
    assert.deepEqual(bakFiles(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeCloudflaredConfig: our marker + drift → updated with backup preserving old content', async () => {
  const dir = freshTmpDir();
  try {
    await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'old.example.com' });
    const r = await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'new.example.com' });
    assert.equal(r.status, 'updated');
    assert.match(r.backup, /\.bak\.\d{14}$/);
    assert.ok(fs.readFileSync(r.backup, 'utf8').includes('old.example.com'));
    assert.ok(fs.readFileSync(path.join(dir, 'config.yml'), 'utf8').includes('new.example.com'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeCloudflaredConfig: foreign file, non-interactive, no --yes → kept-foreign, byte-identical', async () => {
  const dir = freshTmpDir();
  try {
    const cfgPath = path.join(dir, 'config.yml');
    fs.writeFileSync(cfgPath, 'tunnel: someone-elses\ningress:\n  - hostname: other.site\n    service: http://127.0.0.1:9999\n');
    const before = fs.readFileSync(cfgPath, 'utf8');
    const r = await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com' });
    assert.equal(r.status, 'kept-foreign');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);
    assert.deepEqual(bakFiles(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeCloudflaredConfig: foreign file + assumeYes → replaced WITH backup; declining confirmFn keeps it', async () => {
  const dir = freshTmpDir();
  try {
    const cfgPath = path.join(dir, 'config.yml');
    fs.writeFileSync(cfgPath, 'tunnel: someone-elses\n');

    const declined = await writeCloudflaredConfig({
      cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com',
      confirmFn: async () => false
    });
    assert.equal(declined.status, 'kept-foreign');

    const r = await writeCloudflaredConfig({
      cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com', assumeYes: true
    });
    assert.equal(r.status, 'replaced');
    assert.match(r.backup, /\.bak\.\d{14}$/);
    assert.ok(fs.readFileSync(r.backup, 'utf8').includes('someone-elses'));
    assert.ok(fs.readFileSync(cfgPath, 'utf8').includes(TUNNEL_ID));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeCloudflaredConfig: dry-run writes nothing (fresh → would-write, foreign → would-replace-foreign)', async () => {
  const dir = freshTmpDir();
  try {
    const fresh = await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com', dryRun: true });
    assert.equal(fresh.status, 'would-write');
    assert.equal(fs.existsSync(path.join(dir, 'config.yml')), false);

    fs.writeFileSync(path.join(dir, 'config.yml'), 'tunnel: someone-elses\n');
    const foreign = await writeCloudflaredConfig({ cloudflaredDir: dir, tunnelId: TUNNEL_ID, hostname: 'bridge.example.com', dryRun: true });
    assert.equal(foreign.status, 'would-replace-foreign');
    assert.equal(fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'), 'tunnel: someone-elses\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── mergeSupervisorEnv ──────────────────────────────────────────────────────

test('mergeSupervisorEnv: fresh create → supervisor banner (not the secrets.env banner) + both keys + 0600', () => {
  const dir = freshTmpDir();
  try {
    const envPath = path.join(dir, 'supervisor.env');
    const r = mergeSupervisorEnv({ envPath, tunnelName: 'termdeck-bridge', hostname: 'bridge.example.com' });
    assert.equal(r.status, 'created');
    const raw = fs.readFileSync(envPath, 'utf8');
    assert.ok(raw.includes('TermDeck supervisor overrides'));
    assert.equal(raw.includes('Never commit this file'), false);
    assert.ok(raw.includes('TERMDECK_TUNNEL_NAME=termdeck-bridge'));
    assert.ok(raw.includes('TERMDECK_PUBLIC_HOSTNAME=bridge.example.com'));
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mergeSupervisorEnv: idempotent second run → already-set, no write, no backup', () => {
  const dir = freshTmpDir();
  try {
    const envPath = path.join(dir, 'supervisor.env');
    mergeSupervisorEnv({ envPath, tunnelName: 'termdeck-bridge', hostname: 'bridge.example.com' });
    const beforeMtime = fs.statSync(envPath).mtime.getTime();
    const r = mergeSupervisorEnv({ envPath, tunnelName: 'termdeck-bridge', hostname: 'bridge.example.com' });
    assert.equal(r.status, 'already-set');
    assert.equal(fs.statSync(envPath).mtime.getTime(), beforeMtime);
    assert.deepEqual(bakFiles(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mergeSupervisorEnv: update preserves operator comments + unrelated keys; backup holds old values', () => {
  const dir = freshTmpDir();
  try {
    const envPath = path.join(dir, 'supervisor.env');
    fs.writeFileSync(envPath, [
      '# operator notes — do not lose me',
      'TERMDECK_REPO_DIR=/opt/termdeck',
      'TERMDECK_TUNNEL_NAME=old-name',
      'TERMDECK_PUBLIC_HOSTNAME=old.example.com',
      ''
    ].join('\n'));
    const r = mergeSupervisorEnv({ envPath, tunnelName: 'new-name', hostname: 'new.example.com' });
    assert.equal(r.status, 'updated');
    assert.match(r.backup, /\.bak\.\d{14}$/);
    const raw = fs.readFileSync(envPath, 'utf8');
    assert.ok(raw.includes('# operator notes — do not lose me'));
    assert.ok(raw.includes('TERMDECK_REPO_DIR=/opt/termdeck'));
    assert.ok(raw.includes('TERMDECK_TUNNEL_NAME=new-name'));
    assert.ok(raw.includes('TERMDECK_PUBLIC_HOSTNAME=new.example.com'));
    assert.equal(raw.includes('old.example.com'), false);
    assert.ok(fs.readFileSync(r.backup, 'utf8').includes('old.example.com'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mergeSupervisorEnv: dry-run touches nothing', () => {
  const dir = freshTmpDir();
  try {
    const envPath = path.join(dir, 'supervisor.env');
    const r = mergeSupervisorEnv({ envPath, tunnelName: 'a', hostname: 'b.example.com', dryRun: true });
    assert.equal(r.status, 'would-create');
    assert.equal(fs.existsSync(envPath), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mergeSupervisorEnv: fillIfMissing sets TERMDECK_REPO_DIR when absent and NEVER overwrites an operator-set value', () => {
  const dir = freshTmpDir();
  try {
    const envPath = path.join(dir, 'supervisor.env');
    const r1 = mergeSupervisorEnv({
      envPath, tunnelName: 'td', hostname: 'b.example.com',
      fillIfMissing: { TERMDECK_REPO_DIR: '/pkg/root' }
    });
    assert.equal(r1.status, 'created');
    assert.deepEqual(r1.added, ['TERMDECK_REPO_DIR']);
    assert.ok(fs.readFileSync(envPath, 'utf8').includes('TERMDECK_REPO_DIR=/pkg/root'));

    // Idempotent: same fill on a file that already has it → already-set.
    const r2 = mergeSupervisorEnv({
      envPath, tunnelName: 'td', hostname: 'b.example.com',
      fillIfMissing: { TERMDECK_REPO_DIR: '/pkg/root' }
    });
    assert.equal(r2.status, 'already-set');

    // Operator-set value wins: a custom REPO_DIR is preserved verbatim.
    fs.writeFileSync(envPath, [
      'TERMDECK_TUNNEL_NAME=td',
      'TERMDECK_PUBLIC_HOSTNAME=b.example.com',
      'TERMDECK_REPO_DIR=/operator/custom',
      ''
    ].join('\n'));
    const r3 = mergeSupervisorEnv({
      envPath, tunnelName: 'td', hostname: 'b.example.com',
      fillIfMissing: { TERMDECK_REPO_DIR: '/pkg/root' }
    });
    assert.equal(r3.status, 'already-set');
    assert.ok(fs.readFileSync(envPath, 'utf8').includes('TERMDECK_REPO_DIR=/operator/custom'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Operator artifacts ──────────────────────────────────────────────────────

test('setup-tunnel one-shot carries the three cloudflared steps (quoted), the cert.pem login guard, and a PATH guard', () => {
  const s = buildSetupTunnelScript({ tunnelName: 'termdeck-bridge', hostname: 'bridge.example.com' });
  assert.ok(s.startsWith('#!/usr/bin/env bash'));
  assert.ok(s.includes('command -v cloudflared'));
  assert.ok(s.includes('cert.pem'));
  assert.ok(s.includes('cloudflared tunnel login'));
  assert.ok(s.includes("cloudflared tunnel create 'termdeck-bridge'"));
  assert.ok(s.includes("cloudflared tunnel route dns 'termdeck-bridge' 'bridge.example.com'"));
});

test('vendored assets stay byte-locked to their canonical repo artifacts (Class N lockstep pin)', () => {
  assert.equal(
    fs.readFileSync(path.join(SUPERVISE_ASSETS_DIR, 'termdeck-supervise.sh'), 'utf8'),
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'termdeck-supervise.sh'), 'utf8'),
    'vendored supervise script must byte-match scripts/termdeck-supervise.sh'
  );
  assert.equal(
    fs.readFileSync(path.join(SUPERVISE_ASSETS_DIR, 'termdeck-supervise.timer'), 'utf8'),
    fs.readFileSync(path.join(REPO_ROOT, 'docs', 'examples', 'termdeck-supervise.timer'), 'utf8'),
    'vendored timer must byte-match docs/examples/termdeck-supervise.timer'
  );
});

test('resolveSuperviseAssets finds all four vendored assets; empty dir reports what is missing', () => {
  const r = resolveSuperviseAssets();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(Object.keys(r.paths).sort(), ['plist', 'script', 'service', 'timer']);

  const empty = freshTmpDir();
  try {
    const miss = resolveSuperviseAssets({ assetsDir: empty });
    assert.equal(miss.ok, false);
    assert.equal(miss.missing.length, 4);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('renderTemplate throws on an unresolved __TERMDECK_*__ token (no half-rendered file can reach disk)', () => {
  assert.equal(renderTemplate('a __X__ b', { __X__: 'c' }), 'a c b');
  assert.throws(
    () => renderTemplate('script=__TERMDECK_SUPERVISE_SCRIPT__ home=__TERMDECK_HOME__', { __TERMDECK_SUPERVISE_SCRIPT__: '/s' }),
    /__TERMDECK_HOME__/
  );
});

test('rendered launchd plist is a structural twin of the canonical scripts/ plist, token-free, with machine-resolved paths', () => {
  const generated = buildLaunchdPlist({ scriptPath: '/stage/termdeck-supervise.sh', home: '/home/u' });
  const canonical = fs.readFileSync(CANONICAL_PLIST, 'utf8');
  for (const structural of [
    '<string>com.jhizzard.termdeck-supervise</string>',
    '<string>/bin/bash</string>',
    '<integer>60</integer>',
    '<key>RunAtLoad</key>',
    '<key>ProcessType</key>'
  ]) {
    assert.ok(canonical.includes(structural), `canonical missing ${structural}`);
    assert.ok(generated.includes(structural), `generated missing ${structural}`);
  }
  assert.ok(generated.includes('<string>/stage/termdeck-supervise.sh</string>'));
  assert.ok(generated.includes('/home/u/.termdeck/logs/supervise.out.log'));
  assert.equal(/__TERMDECK_[A-Z_]+__/.test(generated), false);
  assert.equal(generated.includes('joshuaizzard'), false);
  assert.ok(generated.includes('termdeck init --bridge'), 'wizard marker must survive rendering');
});

test('systemd units: ExecStart resolves the staged script; timer keeps the canonical 60s cadence; PATH fix preserved', () => {
  const svc = buildSystemdService({ scriptPath: '/stage/termdeck-supervise.sh' });
  assert.ok(svc.includes('ExecStart=/bin/bash /stage/termdeck-supervise.sh'));
  assert.ok(svc.includes('Environment="PATH=%h/.npm-global/bin'));
  assert.equal(/__TERMDECK_[A-Z_]+__/.test(svc), false);
  const timer = buildSystemdTimer();
  assert.ok(timer.includes('OnUnitActiveSec=60'));
  assert.ok(timer.includes('WantedBy=timers.target'));
});

test('install-supervisor one-shot (linux): enables the timer + linger; no cp (the wizard copies files itself); no launchctl', () => {
  const s = buildInstallSupervisorScript();
  assert.ok(s.includes('systemctl --user daemon-reload'));
  assert.ok(s.includes('systemctl --user enable --now termdeck-supervise.timer'));
  assert.ok(s.includes('loginctl enable-linger'));
  assert.equal(s.includes('cp '), false);
  assert.equal(s.includes('launchctl'), false);
});

test('buildSupervisorInstallPlan: built ENTIRELY from vendored assets — final-path targets per platform, no repo fallback; missing assets → ok:false', () => {
  const stageDir = '/stage';
  const mac = buildSupervisorInstallPlan({ platform: 'darwin', home: '/home/u', stageDir });
  assert.equal(mac.ok, true);
  assert.equal(mac.stagedScript, '/stage/termdeck-supervise.sh');
  assert.equal(mac.targets.length, 1);
  assert.equal(mac.targets[0].dest, '/home/u/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist');
  assert.ok(mac.targets[0].content.includes('<string>/stage/termdeck-supervise.sh</string>'));
  assert.deepEqual(mac.stageExtras, []);
  assert.deepEqual(mac.operatorLines, ['launchctl load -w /home/u/Library/LaunchAgents/com.jhizzard.termdeck-supervise.plist']);

  const linux = buildSupervisorInstallPlan({ platform: 'linux', home: '/home/u', stageDir });
  assert.equal(linux.ok, true);
  assert.deepEqual(
    linux.targets.map((t) => t.dest).sort(),
    ['/home/u/.config/systemd/user/termdeck-supervise.service', '/home/u/.config/systemd/user/termdeck-supervise.timer']
  );
  assert.deepEqual(linux.stageExtras.map((f) => f.name), ['install-supervisor.sh']);
  assert.equal(linux.oneShot, '/stage/install-supervisor.sh');
  assert.ok(linux.operatorLines.some((l) => l.includes('systemctl --user enable --now')));

  const empty = freshTmpDir();
  try {
    const missing = buildSupervisorInstallPlan({ platform: 'darwin', home: '/home/u', stageDir, assetsDir: empty });
    assert.equal(missing.ok, false);
    assert.equal(missing.missing.length, 4);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

// ── installManagedFile (plist / systemd unit final-path writes) ─────────────

test('installManagedFile: fresh install, identical no-op, ours-marker update with backup', async () => {
  const dir = freshTmpDir();
  try {
    const dest = path.join(dir, 'LaunchAgents', 'x.plist');
    const v1 = '<!-- termdeck init --bridge -->\n<plist>v1</plist>\n';
    const v2 = '<!-- termdeck init --bridge -->\n<plist>v2</plist>\n';

    const fresh = await installManagedFile({ dest, content: v1 });
    assert.equal(fresh.status, 'installed');
    assert.equal(fs.readFileSync(dest, 'utf8'), v1);

    const same = await installManagedFile({ dest, content: v1 });
    assert.equal(same.status, 'already-current');
    assert.deepEqual(bakFiles(path.dirname(dest)), []);

    const upd = await installManagedFile({ dest, content: v2 });
    assert.equal(upd.status, 'updated');
    assert.match(upd.backup, /\.bak\.\d{14}$/);
    assert.ok(fs.readFileSync(upd.backup, 'utf8').includes('v1'));
    assert.equal(fs.readFileSync(dest, 'utf8'), v2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installManagedFile: foreign file kept without consent, replaced with backup under assumeYes; dry-run statuses touch nothing', async () => {
  const dir = freshTmpDir();
  try {
    const dest = path.join(dir, 'x.plist');
    fs.writeFileSync(dest, '<plist>hand-rolled, no marker</plist>\n');

    const kept = await installManagedFile({ dest, content: 'new', confirmFn: async () => false });
    assert.equal(kept.status, 'kept-foreign');
    assert.ok(fs.readFileSync(dest, 'utf8').includes('hand-rolled'));

    const dry = await installManagedFile({ dest, content: 'new', dryRun: true });
    assert.equal(dry.status, 'would-replace-foreign');
    assert.ok(fs.readFileSync(dest, 'utf8').includes('hand-rolled'));

    const replaced = await installManagedFile({ dest, content: 'new', assumeYes: true });
    assert.equal(replaced.status, 'replaced');
    assert.match(replaced.backup, /\.bak\.\d{14}$/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'new');

    const dryFresh = await installManagedFile({ dest: path.join(dir, 'nope', 'y.plist'), content: 'z', dryRun: true });
    assert.equal(dryFresh.status, 'would-install');
    assert.equal(fs.existsSync(path.join(dir, 'nope')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Packed-layout pin (ledger #21: exercise the production FS, not a mock) ──

test('packed npm tarball: all four supervise assets ship and resolve through the wizard module from the extracted layout', () => {
  const tmp = freshTmpDir('bridge-pack-');
  try {
    const out = execFileSync('npm', ['pack', '--pack-destination', tmp, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const info = JSON.parse(out);
    const tgz = path.join(tmp, info[0].filename);
    execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
    const pkgRoot = path.join(tmp, 'package');

    for (const n of ['termdeck-supervise.sh', 'com.jhizzard.termdeck-supervise.plist', 'termdeck-supervise.service', 'termdeck-supervise.timer']) {
      assert.ok(
        fs.existsSync(path.join(pkgRoot, 'packages', 'cli', 'assets', 'supervise', n)),
        `missing from tarball: packages/cli/assets/supervise/${n}`
      );
    }

    // Require the wizard FROM THE EXTRACTED TREE — no node_modules exists
    // there, which is exactly the point: asset resolution and plan rendering
    // must work on builtins alone (the setup aggregate is lazy-required).
    const packedBridge = require(path.join(pkgRoot, 'packages', 'cli', 'src', 'init-bridge.js'));
    const assets = packedBridge.resolveSuperviseAssets();
    assert.equal(assets.ok, true, JSON.stringify(assets));
    assert.equal(
      fs.readFileSync(assets.paths.script, 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'termdeck-supervise.sh'), 'utf8'),
      'packed script must byte-match the canonical repo script'
    );
    const plan = packedBridge.buildSupervisorInstallPlan({ platform: 'darwin', home: '/home/u', stageDir: '/stage' });
    assert.equal(plan.ok, true);
    assert.equal(/__TERMDECK_[A-Z_]+__/.test(plan.targets[0].content), false);
    assert.ok(plan.targets[0].content.includes('/stage/termdeck-supervise.sh'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── Reachability checks (injected fetch — no network) ───────────────────────

function fakeFetchFromMap(map) {
  return async (url, opts = {}) => {
    const key = `${(opts.method || 'GET').toUpperCase()} ${url}`;
    const hit = map[key];
    if (!hit) throw new Error(`unexpected fetch: ${key}`);
    if (hit.throws) throw new Error(hit.throws);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body
    };
  };
}

const H = 'https://bridge.example.com';
function greenMap() {
  return {
    [`GET ${H}/healthz`]: { status: 200, body: { ok: true, resource: `${H}/mcp` } },
    [`GET ${H}/.well-known/oauth-protected-resource/mcp`]: {
      status: 200, body: { resource: `${H}/mcp`, authorization_servers: [H] }
    },
    [`GET ${H}/.well-known/oauth-authorization-server`]: {
      status: 200, body: { code_challenge_methods_supported: ['S256'] }
    },
    [`POST ${H}/mcp`]: { status: 401, body: {} }
  };
}

test('runReachabilityChecks: all four Tier 5 checks pass on a healthy bridge', async () => {
  const results = await runReachabilityChecks({ hostname: 'bridge.example.com', fetchImpl: fakeFetchFromMap(greenMap()) });
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results, null, 2));
});

test('runReachabilityChecks: unauthenticated POST /mcp answering 200 FAILS the check (broken OAuth gate must be loud)', async () => {
  const map = greenMap();
  map[`POST ${H}/mcp`] = { status: 200, body: { jsonrpc: '2.0' } };
  const results = await runReachabilityChecks({ hostname: 'bridge.example.com', fetchImpl: fakeFetchFromMap(map) });
  const unauth = results[3];
  assert.equal(unauth.ok, false);
  assert.match(unauth.detail, /expected 401/);
});

test('runReachabilityChecks: stale resource pin and network throws degrade to per-check failures, not exceptions', async () => {
  const map = greenMap();
  map[`GET ${H}/healthz`] = { status: 200, body: { ok: true, resource: 'https://random.trycloudflare.com/mcp' } };
  map[`GET ${H}/.well-known/oauth-authorization-server`] = { throws: 'getaddrinfo ENOTFOUND' };
  const results = await runReachabilityChecks({ hostname: 'bridge.example.com', fetchImpl: fakeFetchFromMap(map) });
  assert.equal(results[0].ok, false);
  assert.match(results[0].detail, /stale/);
  assert.equal(results[2].ok, false);
  assert.match(results[2].detail, /ENOTFOUND/);
  assert.equal(results[1].ok, true);
  assert.equal(results[3].ok, true);
});

test('checkLocalBridgeUp: ok response → true; connection refused → false', async () => {
  assert.equal(await checkLocalBridgeUp({ fetchImpl: async () => ({ ok: true, status: 200 }) }), true);
  assert.equal(await checkLocalBridgeUp({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});

// ── Static pin: the wizard never execs privileged/interactive commands ─────

test('wizard source never execs cloudflared/launchctl/systemctl — its only subprocess is the PATH probe', () => {
  const src = fs.readFileSync(BRIDGE_SRC, 'utf8');
  const execSyncCalls = src.match(/execSync\(/g) || [];
  assert.equal(execSyncCalls.length, 1, 'exactly one execSync call allowed (the command -v probe)');
  assert.ok(src.includes("execSync('command -v cloudflared', { stdio: 'ignore' })"));
  assert.equal(/\bspawnSync?\(/.test(src), false, 'no spawn/spawnSync in the wizard');
  assert.equal(/\bexecFileSync?\(/.test(src), false, 'no execFile/execFileSync in the wizard');
  assert.ok(src.includes("const { execSync } = require('child_process');"));
});

// ── CLI dispatch (spawned binary) ───────────────────────────────────────────

function runCli(args, { env = {}, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

// Strip env that could leak the developer machine's real bridge settings
// into the spawned wizard.
function cleanEnv(extra = {}) {
  // Blanks first, explicit test values second — the override order matters.
  return { TERMDECK_TUNNEL_NAME: '', TERMDECK_PUBLIC_HOSTNAME: '', ...extra };
}

test('CLI dispatch: `init --bridge --help` reaches the bridge wizard (NOT the init.js orchestrator) and exits 0', async () => {
  const r = await runCli(['init', '--bridge', '--help']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Usage: termdeck init --bridge [flags]'), r.stdout);
  assert.equal(r.stdout.includes('Usage: termdeck init [--auto]'), false, 'must not fall through to init.js');
});

test('CLI dispatch: `init --bridge --mnestra` is rejected as mode-mixing', async () => {
  const r = await runCli(['init', '--bridge', '--mnestra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pass only one of/);
});

test('CLI e2e: --from-env scaffolds config.yml + supervisor.env + staged one-shots under a tmp HOME; second run is a no-op; hostname change updates with backups', async () => {
  const home = freshTmpDir('bridge-home-');
  try {
    seedCreds(path.join(home, '.cloudflared'), TUNNEL_ID);
    const env = cleanEnv({
      HOME: home,
      TERMDECK_PUBLIC_HOSTNAME: 'bridge.example.com',
      TERMDECK_TUNNEL_NAME: 'tdtest'
    });

    const first = await runCli(['init', '--bridge', '--from-env', '--skip-verify'], { env });
    assert.equal(first.code, 0, first.stdout + first.stderr);

    const cfg = fs.readFileSync(path.join(home, '.cloudflared', 'config.yml'), 'utf8');
    assert.ok(cfg.includes(`tunnel: ${TUNNEL_ID}`));
    assert.ok(cfg.includes('- hostname: bridge.example.com'));
    const sup = fs.readFileSync(path.join(home, '.termdeck', 'supervisor.env'), 'utf8');
    assert.ok(sup.includes('TERMDECK_TUNNEL_NAME=tdtest'));
    assert.ok(sup.includes('TERMDECK_PUBLIC_HOSTNAME=bridge.example.com'));
    assert.ok(sup.includes(`TERMDECK_REPO_DIR=${REPO_ROOT}`), 'staged supervisor needs the repo-dir pin');
    const stage = path.join(home, '.termdeck', 'bridge-install');
    const stagedNames = fs.readdirSync(stage);
    assert.ok(stagedNames.includes('setup-tunnel.sh'));
    assert.ok(stagedNames.includes('termdeck-supervise.sh'), 'vendored supervisor script must be staged');
    assert.equal(
      fs.readFileSync(path.join(stage, 'termdeck-supervise.sh'), 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'termdeck-supervise.sh'), 'utf8')
    );
    // Supervisor files copied AS FILES to their final install paths.
    const supervisorTargets = IS_DARWIN
      ? [path.join(home, 'Library', 'LaunchAgents', 'com.jhizzard.termdeck-supervise.plist')]
      : [
        path.join(home, '.config', 'systemd', 'user', 'termdeck-supervise.service'),
        path.join(home, '.config', 'systemd', 'user', 'termdeck-supervise.timer')
      ];
    for (const t of supervisorTargets) {
      assert.ok(fs.existsSync(t), `supervisor file not installed: ${t}`);
      const raw = fs.readFileSync(t, 'utf8');
      assert.equal(/__TERMDECK_[A-Z_]+__/.test(raw), false, `unresolved token in ${t}`);
    }
    const pointerFile = fs.readFileSync(supervisorTargets[0], 'utf8');
    assert.ok(pointerFile.includes(path.join(stage, 'termdeck-supervise.sh')), 'installed file must point at the staged script');
    if (!IS_DARWIN) assert.ok(stagedNames.includes('install-supervisor.sh'));
    assert.ok(first.stdout.includes('https://bridge.example.com/mcp'));
    assert.ok(/never runs (launchctl|systemctl)/.test(first.stdout));

    // Idempotent second run: no changes, no fresh backups anywhere.
    const second = await runCli(['init', '--bridge', '--from-env', '--skip-verify'], { env });
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.ok(second.stdout.includes('already set (no change)'));
    assert.ok(second.stdout.includes('already configured (no change)'));
    assert.ok(second.stdout.includes('already installed (current)'));
    assert.deepEqual(bakFiles(path.join(home, '.cloudflared')), []);
    assert.deepEqual(bakFiles(path.join(home, '.termdeck')), []);
    assert.deepEqual(bakFiles(path.dirname(supervisorTargets[0])), []);

    // Update path: hostname change → config.yml + supervisor.env updated and
    // backed up; the supervisor files carry no hostname → stay current.
    const third = await runCli(['init', '--bridge', '--from-env', '--skip-verify'], {
      env: { ...env, TERMDECK_PUBLIC_HOSTNAME: 'other.example.com' }
    });
    assert.equal(third.code, 0, third.stdout + third.stderr);
    assert.ok(fs.readFileSync(path.join(home, '.cloudflared', 'config.yml'), 'utf8').includes('other.example.com'));
    assert.ok(fs.readFileSync(path.join(home, '.termdeck', 'supervisor.env'), 'utf8').includes('other.example.com'));
    assert.equal(bakFiles(path.join(home, '.cloudflared')).length, 1);
    assert.equal(bakFiles(path.join(home, '.termdeck')).length, 1);
    assert.deepEqual(bakFiles(path.dirname(supervisorTargets[0])), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI e2e: missing tunnel credentials under --from-env prints the operator steps and exits 3 with a resume hint (no hang)', async () => {
  const home = freshTmpDir('bridge-home-');
  try {
    const env = cleanEnv({ HOME: home, TERMDECK_PUBLIC_HOSTNAME: 'bridge.example.com' });
    const r = await runCli(['init', '--bridge', '--from-env', '--skip-verify'], { env });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('cloudflared tunnel login'));
    assert.ok(r.stdout.includes("cloudflared tunnel create 'termdeck-bridge'"));
    assert.match(r.stderr, /termdeck init --bridge --yes/);
    // Persist-first: the typed/env answers must already be on disk (Class C).
    const sup = fs.readFileSync(path.join(home, '.termdeck', 'supervisor.env'), 'utf8');
    assert.ok(sup.includes('TERMDECK_PUBLIC_HOSTNAME=bridge.example.com'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI e2e: --dry-run plans without touching the filesystem', async () => {
  const home = freshTmpDir('bridge-home-');
  try {
    const env = cleanEnv({ HOME: home, TERMDECK_PUBLIC_HOSTNAME: 'bridge.example.com' });
    const r = await runCli(['init', '--bridge', '--from-env', '--dry-run'], { env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('Dry run complete. No changes were made.'));
    assert.equal(fs.existsSync(path.join(home, '.termdeck')), false);
    assert.equal(fs.existsSync(path.join(home, '.cloudflared', 'config.yml')), false);
    assert.equal(fs.existsSync(path.join(home, 'Library')), false);
    assert.equal(fs.existsSync(path.join(home, '.config')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI e2e: --from-env without TERMDECK_PUBLIC_HOSTNAME exits 2 with an actionable message', async () => {
  const home = freshTmpDir('bridge-home-');
  try {
    const r = await runCli(['init', '--bridge', '--from-env'], { env: cleanEnv({ HOME: home }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /TERMDECK_PUBLIC_HOSTNAME/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI e2e: ambiguous credentials under --from-env lists candidates and exits 3 pointing at --tunnel-id; --tunnel-id resolves it', async () => {
  const home = freshTmpDir('bridge-home-');
  try {
    seedCreds(path.join(home, '.cloudflared'), TUNNEL_ID);
    seedCreds(path.join(home, '.cloudflared'), TUNNEL_ID_B);
    const env = cleanEnv({ HOME: home, TERMDECK_PUBLIC_HOSTNAME: 'bridge.example.com' });

    const ambiguous = await runCli(['init', '--bridge', '--from-env', '--skip-verify'], { env });
    assert.equal(ambiguous.code, 3, ambiguous.stdout + ambiguous.stderr);
    assert.ok(ambiguous.stdout.includes(TUNNEL_ID));
    assert.ok(ambiguous.stdout.includes(TUNNEL_ID_B));
    assert.match(ambiguous.stderr, /--tunnel-id/);

    const resolved = await runCli(['init', '--bridge', '--from-env', '--skip-verify', '--tunnel-id', TUNNEL_ID], { env });
    assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);
    assert.ok(fs.readFileSync(path.join(home, '.cloudflared', 'config.yml'), 'utf8').includes(`tunnel: ${TUNNEL_ID}`));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI e2e: --verify-only with no configured hostname exits 2 without prompting', async () => {
  const home = freshTmpDir('bridge-home-');
  try {
    const r = await runCli(['init', '--bridge', '--verify-only'], { env: cleanEnv({ HOME: home }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /verify-only needs a configured hostname/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
