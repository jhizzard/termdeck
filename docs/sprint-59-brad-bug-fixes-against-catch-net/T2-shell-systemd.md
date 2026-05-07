# T2 — SHELL + SYSTEMD lane (Brad #5 + Brad #7)

**Role:** Claude worker, Sprint 59.
**Scope:** Two source-code root-fixes — the PTY shell fallback chain hardening + a `--service` (or `--non-interactive`) launcher flag for systemd Type=simple deployment.

## Pre-flight reads

1. `memory_recall(project="termdeck", query="PTY spawn shell fallback /bin/zsh systemd Type=simple launcher TTY")`
2. `memory_recall(query="recent decisions and bugs")`
3. `~/.claude/CLAUDE.md` (post shape, no commits in lane)
4. `./CLAUDE.md` (no TypeScript, vanilla JS client, CommonJS server)
5. `docs/sprint-59-brad-bug-fixes-against-catch-net/PLANNING.md`
6. `docs/sprint-59-brad-bug-fixes-against-catch-net/STATUS.md`
7. `docs/sprint-58-environment-coverage/T2-systemd-doctor.md` (the systemd-nightly fixture you need to satisfy)
8. `docs/sprint-58-environment-coverage/T1-ghactions-docker.md` (Alpine + Ubuntu-without-zsh fixtures you need to satisfy)
9. `CHANGELOG.md` § [1.0.12] Notes (Brad's 9-finding report — #5 and #7)

## Goal

Two fixes such that the Sprint 58 fixtures for Brad #5 (Alpine no-zsh + Ubuntu apt-removed-zsh) and Brad #7 (Hetzner systemd Type=simple) both turn from RED to GREEN.

## Brad #5 — PTY shell hardcoded /bin/zsh fallback

**Severity:** MEDIUM (cosmetic on macOS where zsh is present; fatal on minimal Linux).

**Symptom:** `packages/server/src/index.js:958`:
```js
const spawnShell = isPlainShell ? cmdTrim : (config.shell || '/bin/zsh');
```
Three failure modes converge: (a) `config.shell` empty/unread, (b) `$SHELL` ignored, (c) `/bin/zsh` absent on the host. Result: silent `execvp(3) failed: No such file or directory` from `pty.spawn`. User's login shell is bypassed entirely.

**Fix (per Brad's recommendation):** change the fallback chain to:
```js
const spawnShell = isPlainShell
  ? cmdTrim
  : (cmdTrim || config.shell || process.env.SHELL || '/bin/sh');
```
Rationale: `/bin/sh` is universally present on POSIX; `/bin/zsh` is not. Order: explicit command override → user config → user environment → universal fallback.

Also: investigate why `config.shell` from `~/.termdeck/config.yaml` may be empty/unread. Two probable causes — (a) the YAML `shell:` key isn't documented so users don't set it; (b) `loadConfig()` in `packages/server/src/config.js` may not propagate it to the value passed to `pty.spawn`. Check `index.js:940` `command || config.shell` and the surrounding spawn-prep block.

**Where else this pattern appears:**
- `packages/server/src/index.js:940` — `command: command || config.shell` (no `/bin/zsh` here, but worth verifying it picks up the same fallback chain when config.shell is empty).
- Any `node-pty` spawn in tests — confirm tests don't hard-code `/bin/zsh` either (test on Alpine in CI).

**Test:**
- `tests/pty-shell-fallback.test.js` — four cases:
  1. `cmdTrim='/bin/bash'`, all others empty → spawn `/bin/bash`.
  2. `cmdTrim=''`, `config.shell='/bin/bash'` → spawn `/bin/bash`.
  3. `cmdTrim=''`, `config.shell=''`, `process.env.SHELL='/bin/zsh'` → spawn `/bin/zsh` (only if it exists; pure unit test asserts the *string returned*, not actual spawn).
  4. all empty → spawn `/bin/sh`.

The unit test should extract the fallback logic into a helper function (e.g. `resolveSpawnShell(cmdTrim, configShell, envShell)`) so it's testable without `pty.spawn`.

**Fixture target:** Sprint 58's `install-smoke-alpine` Dockerfile (no zsh) and `install-smoke-ubuntu` (with `apt remove zsh` step). Both currently RED (Brad #5 reproduces). Post-fix GREEN.

## Brad #7 — Launcher exits 0 immediately under systemd Type=simple

**Severity:** BLOCKING for systemd deployment.

**Symptom:** TermDeck launcher detects no controlling TTY and exits 0, presumably to defer to interactive use. Under `systemd Type=simple` + `Restart=on-failure`, this is a clean exit — systemd marks the service inactive and does NOT restart (only `on-failure` triggers, not `on-success`).

**Fix:** add a `--service` flag (alias `--non-interactive`) to the launcher CLI that bypasses the TTY check. Document the flag in the install guide (T3 owns the docs side; you own the flag).

**Where to land it:**
- `packages/stack-installer/src/launcher.js` — the launcher entry point. Find the TTY-check site (probably an `if (!process.stdout.isTTY) process.exit(0)` or similar). Add `--service` arg parsing and skip the TTY check when set.
- Could also be in `packages/cli/src/index.js` if the TTY check happens there. Read `index.js` boot sequence (~line 263-376 area where secrets paths and DATABASE_URL hint checks run) to locate.
- Add the flag to `--help` output.

**Test:**
- `tests/launcher-service-flag.test.js` — invoke the launcher with `--service` in a non-TTY context (`stdio: 'pipe'`) and assert it does NOT exit 0 immediately. Asserts process is alive after 1s, then kills it. Use `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']` so `process.stdin.isTTY === undefined`.
- Without `--service` in the same context, assert it DOES exit 0 immediately (preserve the existing interactive-use behavior).

**Fixture target:** Sprint 58's `systemd-nightly` Hetzner workflow. The systemd unit currently uses `ExecStart=/usr/bin/termdeck` (no flag) and `Type=simple`; expected behavior post-fix is `ExecStart=/usr/bin/termdeck --service`. T3 will update the canonical example unit. Pre-fix: `systemctl is-active termdeck.service` → `inactive`. Post-fix: `active`.

## Discipline (universal)

- **Post shape:** `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`.
- **Stay in lane.** T1 owns secrets/env propagation + DATABASE_URL quote-strip; T3 owns docs and the canonical systemd unit example. Cross-lane reads OK; cross-lane writes BANNED.
- **Append-only STATUS.md.**
- **Document the before/after fixture state in your `### [T2] DONE` post.**

## Coordination notes

- T3 owns the canonical systemd unit example file. After your `--service` flag lands, post `### [T2] FIX-LANDED Brad-7 — flag is "--service"; T3 please update example unit ExecStart`. T3 will respond.
- T4-CODEX audits each fix against its Sprint 58 fixture. If T4 posts `### [T4-CODEX] FIXTURE-STILL-RED F-5` or `F-7`, iterate.

## Success criteria

1. `### [T2] FIX-LANDED` posts for Brad #5 and Brad #7.
2. Both new test files exist and pass (`npm test`).
3. T4-CODEX posts `### [T4-CODEX] FIXTURE-VERIFIED F-5` and `FIXTURE-VERIFIED F-7` (or, pre-Phase-B, `LOCAL-VERIFIED` equivalents).
4. `### [T2] DONE 2026-05-07 HH:MM ET` with summary + fixture-state-before/after.
