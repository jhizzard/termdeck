// Sprint 64 T1 — OS detection module tests.
//
// Pins the matrix the unified `termdeck init` wizard branches on: family
// (macos / linux / docker / unknown), distro (ubuntu / debian / fedora / alpine
// / etc.), defaultShell (zsh / bash / sh), rebuildHint (xcode-select / apt /
// dnf / apk / arch / suse), autostart-unit kind (launchd / systemd / null),
// and the in-container detection across Docker / Podman / nspawn signals.
//
// All inputs are injected via the `deps` parameter to detectOS() — no test
// touches the host's actual /etc/os-release / /.dockerenv / process.platform.
//
// Co-located under packages/cli/tests/ per ORCH SCOPE 16:14 + 16:18 ET
// adjudications. The root `package.json` test glob covers this dir
// alongside `packages/server/tests/` and `packages/stack-installer/tests/`.
//
// Run: node --test packages/cli/tests/os-detect.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  detectOS,
  parseOsRelease,
  _LINUX_DEFAULTS,
  _ID_LIKE_FALLBACK,
  _launchdPlistStub,
  _systemdUserUnitStub,
  _detectInContainer,
} = require('../src/os-detect');

// ─────────────────────────────────────────────────────────────────────────
// Helpers: build a deps object with fixed values + a fake filesystem map.

function makeDeps({ platform, arch = 'x64', homedir = '/home/tester', files = {}, env = {}, macosVersion } = {}) {
  return {
    platform,
    arch,
    homedir,
    getEnv: (k) => env[k],
    readFile: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    macosVersion,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// parseOsRelease — unit tests for the standalone helper.

test('parseOsRelease — returns null for empty/missing input', () => {
  assert.equal(parseOsRelease(null), null);
  assert.equal(parseOsRelease(undefined), null);
  assert.equal(parseOsRelease(''), null);
  assert.equal(parseOsRelease('   \n# comment only\n'), null);
});

test('parseOsRelease — strips matched surrounding quotes', () => {
  const out = parseOsRelease('ID="ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
  assert.equal(out.ID, 'ubuntu');
  assert.equal(out.VERSION_ID, '24.04');
  assert.equal(out.PRETTY_NAME, 'Ubuntu 24.04 LTS');
});

test('parseOsRelease — handles single quotes and bare values', () => {
  const out = parseOsRelease("ID='fedora'\nVERSION_ID=39\nID_LIKE=rhel\n");
  assert.equal(out.ID, 'fedora');
  assert.equal(out.VERSION_ID, '39');
  assert.equal(out.ID_LIKE, 'rhel');
});

test('parseOsRelease — skips comments, malformed lines, lowercase keys', () => {
  const out = parseOsRelease([
    '# This file describes the distribution.',
    'ID=ubuntu',
    'malformed_line_no_equals',
    '=NO_KEY',
    'lowercase_key=ignored',
    '0LEADING_DIGIT=ignored',
    'VERSION_ID="22.04"',
  ].join('\n'));
  assert.equal(out.ID, 'ubuntu');
  assert.equal(out.VERSION_ID, '22.04');
  assert.equal(out.malformed_line_no_equals, undefined);
  assert.equal(out.lowercase_key, undefined);
  assert.equal(out['0LEADING_DIGIT'], undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// macOS branches.

test('detectOS macOS arm64 — Apple Silicon defaults', () => {
  const r = detectOS(makeDeps({ platform: 'darwin', arch: 'arm64', homedir: '/Users/tester', macosVersion: '14.3.1' }));
  assert.equal(r.family, 'macos');
  assert.equal(r.distro, null);
  assert.equal(r.version, '14.3.1');
  assert.equal(r.isAppleSilicon, true);
  assert.equal(r.inDocker, false);
  assert.equal(r.defaultShell, 'zsh');
  assert.match(r.rebuildHint, /xcode-select --install/);
  assert.equal(r.paths.termdeck, '/Users/tester/.termdeck');
  assert.equal(r.paths.secretsEnv, '/Users/tester/.termdeck/secrets.env');
  assert.equal(r.paths.autostartDir, '/Users/tester/Library/LaunchAgents');
  assert.equal(r.autostartUnit.kind, 'launchd');
  assert.equal(r.autostartUnit.path, '/Users/tester/Library/LaunchAgents/com.jhizzard.termdeck.plist');
  assert.match(r.autostartUnit.content, /<key>Label<\/key>\s*<string>com\.jhizzard\.termdeck<\/string>/);
  assert.match(r.autostartUnit.content, /\/Users\/tester\/\.termdeck\/termdeck\.log/);
  assert.match(r.autostartUnit.note, /STUB|Sprint 65/);
});

test('detectOS macOS x64 — legacy Intel defaults', () => {
  const r = detectOS(makeDeps({ platform: 'darwin', arch: 'x64', homedir: '/Users/tester' }));
  assert.equal(r.family, 'macos');
  assert.equal(r.isAppleSilicon, false);
  assert.equal(r.defaultShell, 'zsh');
  assert.equal(r.version, null);  // no macosVersion injected → null, not a shell-out
});

// ─────────────────────────────────────────────────────────────────────────
// Linux distro matrix.

test('detectOS linux Ubuntu 24.04 — apt rebuild hint', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    homedir: '/home/joshua',
    files: {
      '/etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\nID_LIKE=debian\n',
    },
  }));
  assert.equal(r.family, 'linux');
  assert.equal(r.distro, 'ubuntu');
  assert.equal(r.version, '24.04');
  assert.equal(r.inDocker, false);
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /apt install.*build-essential/);
  assert.equal(r.paths.autostartDir, '/home/joshua/.config/systemd/user');
  assert.equal(r.autostartUnit.kind, 'systemd');
  assert.equal(r.autostartUnit.path, '/home/joshua/.config/systemd/user/termdeck.service');
  assert.match(r.autostartUnit.content, /\[Unit\][\s\S]*\[Service\][\s\S]*\[Install\]/);
  assert.match(r.autostartUnit.content, /ExecStart=\/usr\/local\/bin\/termdeck --service/);
});

test('detectOS linux Debian 12', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' },
  }));
  assert.equal(r.distro, 'debian');
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /apt install/);
});

test('detectOS linux Fedora 39 — dnf rebuild hint', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=fedora\nVERSION_ID=39\nID_LIKE="rhel centos"\n' },
  }));
  assert.equal(r.distro, 'fedora');
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /dnf install.*gcc-c\+\+/);
});

test('detectOS linux Alpine — sh shell + apk rebuild hint', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=alpine\nVERSION_ID="3.20.0"\n' },
  }));
  assert.equal(r.distro, 'alpine');
  assert.equal(r.defaultShell, 'sh');
  assert.match(r.rebuildHint, /apk add.*build-base/);
});

test('detectOS linux Arch — pacman rebuild hint', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=arch\nPRETTY_NAME="Arch Linux"\n' },
  }));
  assert.equal(r.distro, 'arch');
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /pacman.*base-devel/);
});

test('detectOS linux Pop!_OS — ID_LIKE fallback to debian apt path', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=pop\nVERSION_ID="22.04"\nID_LIKE="ubuntu debian"\n' },
  }));
  assert.equal(r.distro, 'pop');
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /apt install/);
});

test('detectOS linux unknown distro with ID_LIKE=ubuntu falls back to apt', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=garuda\nVERSION_ID=1\nID_LIKE="arch"\n' },
  }));
  // garuda → not in LINUX_DEFAULTS; ID_LIKE=arch → fallback hits Arch defaults.
  assert.equal(r.distro, 'garuda');
  assert.match(r.rebuildHint, /pacman.*base-devel/);
});

test('detectOS linux truly-unknown distro — generic fallback', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: { '/etc/os-release': 'ID=hypothetical-os\nVERSION_ID=1.0\n' },
  }));
  assert.equal(r.distro, 'hypothetical-os');
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /install your distro/);
});

test('detectOS linux with no /etc/os-release — generic fallback, distro=unknown', () => {
  const r = detectOS(makeDeps({ platform: 'linux', files: {} }));
  assert.equal(r.family, 'linux');
  assert.equal(r.distro, 'unknown');
  assert.equal(r.defaultShell, 'bash');
  assert.match(r.rebuildHint, /install your distro/);
});

// ─────────────────────────────────────────────────────────────────────────
// Container detection — Docker / Podman / nspawn signals.

test('detectOS linux + /.dockerenv → family=docker, autostartUnit kind=null', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: {
      '/etc/os-release': 'ID=ubuntu\nVERSION_ID="22.04"\n',
      '/.dockerenv': '',
    },
  }));
  assert.equal(r.family, 'docker');
  assert.equal(r.inDocker, true);
  assert.equal(r.distro, 'ubuntu');
  assert.equal(r.defaultShell, 'bash');
  assert.equal(r.paths.autostartDir, null);
  assert.equal(r.autostartUnit.kind, null);
  assert.equal(r.autostartUnit.path, null);
  assert.match(r.autostartUnit.note, /container/i);
});

test('detectOS linux + Podman /run/.containerenv → family=docker', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: {
      '/etc/os-release': 'ID=fedora\nVERSION_ID=39\n',
      '/run/.containerenv': 'engine="podman-4.5.1"\n',
    },
  }));
  assert.equal(r.family, 'docker');
  assert.equal(r.inDocker, true);
  assert.equal(r.distro, 'fedora');
});

test('detectOS linux + /proc/1/cgroup contains docker → family=docker', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: {
      '/etc/os-release': 'ID=debian\nVERSION_ID="12"\n',
      '/proc/1/cgroup': '12:memory:/docker/abc123\n0::/system.slice/docker.service\n',
    },
  }));
  assert.equal(r.family, 'docker');
  assert.equal(r.inDocker, true);
});

test('detectOS linux + container env var (systemd-nspawn / Podman) → family=docker', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    env: { container: 'podman' },
    files: { '/etc/os-release': 'ID=fedora\n' },
  }));
  assert.equal(r.family, 'docker');
  assert.equal(r.inDocker, true);
});

test('detectOS linux + kubepods cgroup → family=docker', () => {
  const r = detectOS(makeDeps({
    platform: 'linux',
    files: {
      '/etc/os-release': 'ID=alpine\nVERSION_ID="3.20.0"\n',
      '/proc/1/cgroup': '0::/kubepods/burstable/pod-abc/container-def\n',
    },
  }));
  assert.equal(r.family, 'docker');
  assert.equal(r.distro, 'alpine');
  assert.equal(r.defaultShell, 'sh');
});

test('_detectInContainer — returns false when no signals present', () => {
  const r = _detectInContainer({
    existsSync: () => false,
    readFile: () => null,
    getEnv: () => undefined,
  });
  assert.equal(r, false);
});

// ─────────────────────────────────────────────────────────────────────────
// Unknown platforms.

test('detectOS win32 / other platforms → family=unknown, defaultShell=sh', () => {
  const r = detectOS(makeDeps({ platform: 'win32' }));
  assert.equal(r.family, 'unknown');
  assert.equal(r.defaultShell, 'sh');
  assert.equal(r.autostartUnit.kind, null);
  assert.match(r.rebuildHint, /install your platform/);
});

// ─────────────────────────────────────────────────────────────────────────
// Stub content fences (lock the autostart skeletons in place).

test('_launchdPlistStub — contains required plist keys', () => {
  const xml = _launchdPlistStub('/Users/tester');
  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist/);
  assert.match(xml, /<key>Label<\/key>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /\/Users\/tester\/\.termdeck\/termdeck\.log/);
});

test('_systemdUserUnitStub — contains [Unit] / [Service] / [Install] sections', () => {
  const unit = _systemdUserUnitStub();
  assert.match(unit, /\[Unit\][\s\S]*Description=TermDeck/);
  assert.match(unit, /\[Service\][\s\S]*Type=simple[\s\S]*ExecStart=\/usr\/local\/bin\/termdeck --service/);
  assert.match(unit, /\[Install\][\s\S]*WantedBy=default\.target/);
  assert.match(unit, /Restart=on-failure/);
});

// ─────────────────────────────────────────────────────────────────────────
// Shape invariants — the wizard depends on these keys always being present.

test('detectOS — shape contract across all platforms', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const r = detectOS(makeDeps({
      platform,
      arch: 'arm64',
      files: platform === 'linux' ? { '/etc/os-release': 'ID=ubuntu\n' } : {},
    }));
    assert.ok(['macos', 'linux', 'docker', 'unknown'].includes(r.family), `family check ${platform}`);
    assert.ok(typeof r.defaultShell === 'string' && ['zsh', 'bash', 'sh'].includes(r.defaultShell), `shell check ${platform}`);
    assert.ok(typeof r.rebuildHint === 'string' && r.rebuildHint.length > 0, `hint check ${platform}`);
    assert.ok(typeof r.inDocker === 'boolean', `inDocker check ${platform}`);
    assert.ok(r.paths && typeof r.paths.termdeck === 'string', `paths check ${platform}`);
    assert.ok(r.autostartUnit && Object.prototype.hasOwnProperty.call(r.autostartUnit, 'kind'), `unit shape ${platform}`);
  }
});

test('LINUX_DEFAULTS — every distro entry has both defaultShell and rebuildHint', () => {
  for (const [name, defaults] of Object.entries(_LINUX_DEFAULTS)) {
    assert.ok(['zsh', 'bash', 'sh'].includes(defaults.defaultShell), `${name} defaultShell`);
    assert.ok(defaults.rebuildHint && defaults.rebuildHint.length > 0, `${name} rebuildHint`);
  }
});

test('ID_LIKE_FALLBACK — every fallback row has match + defaults', () => {
  for (const f of _ID_LIKE_FALLBACK) {
    assert.ok(f.match instanceof RegExp, 'match is regex');
    assert.ok(f.defaults && f.defaults.defaultShell, 'fallback defaults');
  }
});
