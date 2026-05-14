// Sprint 64 T1 — OS detection module for the unified `termdeck init` wizard.
//
// Returns a normalized facts object the wizard branches on for: default shell,
// node-pty rebuild guidance, install path, autostart unit emission, and the
// in-Docker fixture detection that Path B / Sprint 67+ multi-port work depends on.
//
// All inputs are injectable via the `deps` parameter so tests can pin every
// branch without touching the actual host. Production callers pass nothing
// and get real `process.platform` / `os.arch()` / `fs.readFileSync` behavior.
//
// Cross-references:
//  - Sprint 59 T2's `resolveSpawnShell` at packages/server/src/index.js — that
//    runtime helper chains `config.shell` → `$SHELL` → `/bin/sh`. THIS module's
//    `defaultShell` field is what the wizard reports / writes; both should agree.
//  - BACKLOG §D.5 multi-port verification 2026-05-14 15:28 ET — second-instance
//    boot under WAL-mode SQLite confirmed safe. Path B (per-instance DB, signal
//    handling, autostart) is Sprint 67+. This module emits autostart STUBS only
//    with a TODO marker — full wiring deferred per T1 brief §1.2.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Minimal /etc/os-release parser. Strips matched surrounding quotes. Returns
// an object of all parsed keys (ID, VERSION_ID, PRETTY_NAME, ID_LIKE, etc.)
// or null if nothing usable parsed.
function parseOsRelease(content) {
  if (!content || typeof content !== 'string') return null;
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Distro → defaults map. Used by detectOS() for the Linux branch.
// Keep in sync with INSTALLER-PITFALLS.md taxonomy if new distros show up
// in Brad's tester pool (currently Ubuntu 24.04 r730; macOS for Joshua).
const LINUX_DEFAULTS = {
  ubuntu:   { defaultShell: 'bash', rebuildHint: 'sudo apt install -y build-essential python3' },
  debian:   { defaultShell: 'bash', rebuildHint: 'sudo apt install -y build-essential python3' },
  pop:      { defaultShell: 'bash', rebuildHint: 'sudo apt install -y build-essential python3' },
  linuxmint:{ defaultShell: 'bash', rebuildHint: 'sudo apt install -y build-essential python3' },
  fedora:   { defaultShell: 'bash', rebuildHint: 'sudo dnf install -y gcc-c++ make python3' },
  rhel:     { defaultShell: 'bash', rebuildHint: 'sudo dnf install -y gcc-c++ make python3' },
  centos:   { defaultShell: 'bash', rebuildHint: 'sudo dnf install -y gcc-c++ make python3' },
  rocky:    { defaultShell: 'bash', rebuildHint: 'sudo dnf install -y gcc-c++ make python3' },
  alma:     { defaultShell: 'bash', rebuildHint: 'sudo dnf install -y gcc-c++ make python3' },
  alpine:   { defaultShell: 'sh',   rebuildHint: 'apk add --no-cache build-base python3' },
  arch:     { defaultShell: 'bash', rebuildHint: 'sudo pacman -S --needed base-devel python' },
  manjaro:  { defaultShell: 'bash', rebuildHint: 'sudo pacman -S --needed base-devel python' },
  opensuse: { defaultShell: 'bash', rebuildHint: 'sudo zypper install -t pattern devel_C_C++' },
};

const ID_LIKE_FALLBACK = [
  { match: /\b(debian|ubuntu)\b/, defaults: LINUX_DEFAULTS.debian },
  { match: /\b(rhel|fedora|centos)\b/, defaults: LINUX_DEFAULTS.fedora },
  { match: /\b(alpine|musl)\b/, defaults: LINUX_DEFAULTS.alpine },
  { match: /\b(arch)\b/, defaults: LINUX_DEFAULTS.arch },
  { match: /\b(suse)\b/, defaults: LINUX_DEFAULTS.opensuse },
];

// Heuristic in-container detection. Multiple signals because no single one
// is reliable across container runtimes (Docker, Podman, BuildKit, K8s).
function detectInContainer({ existsSync, readFile, getEnv }) {
  if (getEnv('container')) return true;             // systemd-nspawn / Podman set this
  if (existsSync('/.dockerenv')) return true;
  if (existsSync('/run/.containerenv')) return true; // Podman fixture
  const cgroup = readFile('/proc/1/cgroup');
  if (cgroup && /\b(docker|kubepods|containerd|libpod)\b/.test(cgroup)) return true;
  const mountinfo = readFile('/proc/self/mountinfo');
  if (mountinfo && /\b(overlay|docker|kubelet)\b/.test(mountinfo)) return true;
  return false;
}

// launchd plist stub for macOS. Path B / Sprint 65+ replaces the stub with
// full wiring including KeepAlive policy variants, log rotation, EnvironmentVariables,
// and per-port instance labels. v1.3.0 ships stub only.
function launchdPlistStub(homedir) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <!-- TermDeck launchd autostart STUB — Sprint 64 T1. Full wiring in Sprint 65+. -->',
    '  <!-- TODO(sprint-65): per-port label, log rotation, EnvironmentVariables block. -->',
    '  <key>Label</key>',
    '  <string>com.jhizzard.termdeck</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/usr/local/bin/termdeck</string>',
    '    <string>--service</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${homedir}/.termdeck/termdeck.log</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${homedir}/.termdeck/termdeck.err.log</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// systemd user unit stub for Linux (outside Docker). Path B / Sprint 65+
// replaces the stub with full wiring (per-port unit instance, Environment=,
// proper Restart policy tuning, journald integration). v1.3.0 ships stub only.
function systemdUserUnitStub() {
  return [
    '# TermDeck systemd user unit STUB — Sprint 64 T1. Full wiring in Sprint 65+.',
    '# TODO(sprint-65): templated unit @<port>, Environment=TERMDECK_PORT=, journald gates.',
    '#',
    '# Install:  systemctl --user enable --now termdeck.service',
    '# Status:   systemctl --user status termdeck.service',
    '# Logs:     journalctl --user -u termdeck.service -f',
    '',
    '[Unit]',
    'Description=TermDeck — browser terminal multiplexer',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/local/bin/termdeck --service',
    'Restart=on-failure',
    'RestartSec=5s',
    'StandardOutput=append:%h/.termdeck/termdeck.log',
    'StandardError=append:%h/.termdeck/termdeck.err.log',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// Detect the host OS and build the wizard-facing facts object.
//
// Deps (all optional; tests inject):
//   platform   — process.platform replacement ('darwin'|'linux'|'win32'|...)
//   arch       — os.arch() replacement
//   homedir    — os.homedir() replacement
//   getEnv     — (key) => string|undefined  (defaults to process.env[key])
//   readFile   — (path) => string|null
//   existsSync — (path) => boolean
//   macosVersion — pre-resolved 'YY.YY.YY' string (e.g. '14.3.1'); when omitted
//                  the function does NOT shell out (no spawnSync to `sw_vers`)
//                  — keeps boot deterministic for the wizard. Callers wanting
//                  the version can pass it via deps.
//
// Returns: {
//   family:        'macos' | 'linux' | 'docker' | 'unknown'
//   distro:        string | null                    (e.g. 'ubuntu', 'fedora', 'alpine')
//   version:       string | null                    (VERSION_ID for linux, macosVersion for macos)
//   isAppleSilicon:boolean                          (true only on darwin+arm64)
//   inDocker:      boolean                          (always present)
//   defaultShell:  'zsh' | 'bash' | 'sh'
//   rebuildHint:   string                           (node-pty rebuild remediation)
//   paths: {
//     home, termdeck, secretsEnv, configYaml, autostartDir
//   }
//   autostartUnit: { kind, path, content, note? }   (kind: 'launchd'|'systemd'|null)
// }
function detectOS(deps) {
  deps = deps || {};
  const platform = deps.platform || process.platform;
  const arch = deps.arch || os.arch();
  const homedir = deps.homedir || os.homedir();
  const getEnv = deps.getEnv || ((k) => process.env[k]);
  const readFile = deps.readFile || ((p) => {
    try { return fs.readFileSync(p, 'utf8'); }
    catch (_e) { return null; }
  });
  const existsSync = deps.existsSync || ((p) => fs.existsSync(p));

  const termdeckDir = path.join(homedir, '.termdeck');
  const basePaths = {
    home: homedir,
    termdeck: termdeckDir,
    secretsEnv: path.join(termdeckDir, 'secrets.env'),
    configYaml: path.join(termdeckDir, 'config.yaml'),
  };

  if (platform === 'darwin') {
    const isAppleSilicon = arch === 'arm64';
    const macosVersion = deps.macosVersion || null;
    return {
      family: 'macos',
      distro: null,
      version: macosVersion,
      isAppleSilicon,
      inDocker: false,
      defaultShell: 'zsh',
      rebuildHint: 'xcode-select --install   # installs the macOS Command Line Tools (clang, make)',
      paths: {
        ...basePaths,
        autostartDir: path.join(homedir, 'Library', 'LaunchAgents'),
      },
      autostartUnit: {
        kind: 'launchd',
        path: path.join(homedir, 'Library', 'LaunchAgents', 'com.jhizzard.termdeck.plist'),
        content: launchdPlistStub(homedir),
        note: 'STUB only — full wiring deferred to Sprint 65+',
      },
    };
  }

  if (platform === 'linux') {
    const inDocker = detectInContainer({ existsSync, readFile, getEnv });
    const osRelease = parseOsRelease(readFile('/etc/os-release')) || {};
    const rawId = (osRelease.ID || '').toLowerCase();
    const idLike = (osRelease.ID_LIKE || '').toLowerCase();
    const version = osRelease.VERSION_ID || null;

    let distro = rawId || null;
    let defaults = LINUX_DEFAULTS[rawId];
    if (!defaults && idLike) {
      for (const f of ID_LIKE_FALLBACK) {
        if (f.match.test(idLike)) {
          defaults = f.defaults;
          if (!distro) distro = idLike.split(/\s+/)[0];
          break;
        }
      }
    }
    if (!defaults) {
      defaults = { defaultShell: 'bash', rebuildHint: 'install your distro\'s C++ build toolchain (gcc, make, python3)' };
      if (!distro) distro = 'unknown';
    }

    const autostartDir = path.join(homedir, '.config', 'systemd', 'user');
    return {
      family: inDocker ? 'docker' : 'linux',
      distro,
      version,
      isAppleSilicon: false,
      inDocker,
      defaultShell: defaults.defaultShell,
      rebuildHint: defaults.rebuildHint,
      paths: {
        ...basePaths,
        autostartDir: inDocker ? null : autostartDir,
      },
      autostartUnit: inDocker
        ? {
            kind: null,
            path: null,
            content: null,
            note: 'in-container fixture — TermDeck runs as the container entrypoint; no per-user systemd unit',
          }
        : {
            kind: 'systemd',
            path: path.join(autostartDir, 'termdeck.service'),
            content: systemdUserUnitStub(),
            note: 'STUB only — full wiring deferred to Sprint 65+',
          },
    };
  }

  return {
    family: 'unknown',
    distro: null,
    version: null,
    isAppleSilicon: false,
    inDocker: false,
    defaultShell: 'sh',
    rebuildHint: 'install your platform\'s C++ toolchain manually (gcc, make, python3) before re-running termdeck init',
    paths: { ...basePaths, autostartDir: null },
    autostartUnit: { kind: null, path: null, content: null, note: 'unknown platform — autostart unit not auto-emitted' },
  };
}

module.exports = {
  detectOS,
  parseOsRelease,
  // Exported for tests:
  _LINUX_DEFAULTS: LINUX_DEFAULTS,
  _ID_LIKE_FALLBACK: ID_LIKE_FALLBACK,
  _launchdPlistStub: launchdPlistStub,
  _systemdUserUnitStub: systemdUserUnitStub,
  _detectInContainer: detectInContainer,
};
