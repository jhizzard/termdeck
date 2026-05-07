# T3 — DOCS + EXAMPLE-UNIT lane (Brad #6 + Brad #8 + Brad #3)

**Role:** Claude worker, Sprint 59.
**Scope:** Three documentation closures — Linux x64 optional-dep install hint, systemd PATH/Environment guidance, pgbouncer URL params clarification — plus a canonical, copy-pasteable systemd unit example that wires up T2's new `--service` flag.

## Pre-flight reads

1. `memory_recall(project="termdeck", query="install guide systemd unit pgbouncer optional dep Linux x64 docs")`
2. `memory_recall(query="recent decisions and bugs")`
3. `~/.claude/CLAUDE.md` (post shape, no commits in lane)
4. `./CLAUDE.md`
5. `docs/sprint-59-brad-bug-fixes-against-catch-net/PLANNING.md`
6. `docs/sprint-59-brad-bug-fixes-against-catch-net/STATUS.md`
7. `docs/sprint-58-environment-coverage/T2-systemd-doctor.md` (the systemd-nightly fixture; your example unit must be the canonical form)
8. `docs/sprint-58-environment-coverage/T3-supabase-docs.md` (Sprint 58 docs companion — your work continues this)
9. `docs/GETTING-STARTED.md` (current install-guide root)
10. Existing install / setup docs anywhere under `docs/` — `find docs -name "INSTALL*.md" -o -name "GETTING*.md" -o -name "SETUP*.md"`
11. `CHANGELOG.md` § [1.0.12] Notes (Brad #3, #6, #8 verbatim)

## Goal

Three docs updates + one canonical systemd unit example such that:

- Brad #6's Sprint 58 fixture (claude-code optional dep on Linux x64) turns GREEN once the install-guide is the documented path.
- Brad #8's `systemd-nightly` workflow uses your canonical unit (which includes `Environment=PATH=...`) and reports GREEN.
- Brad #3 has a docs note clarifying pgbouncer-vs-portable URL params (no fixture; cosmetic).

## Brad #6 — `@anthropic-ai/claude-code` optional dep on Linux x64

**Severity:** MEDIUM (install path break; user-visible on Linux x64 only).

**Background:** `@anthropic-ai/claude-code` ships a platform-native binary as an `optionalDependencies` entry. On macOS, npm picks it up automatically. On Linux x64, depending on `npm config get omit` and runtime flags, the optional dep can be skipped — leaving an installed `claude` stub that fails `claude --version` because the platform binary stub doesn't exist.

**Fix (docs):** update the install guide with `npm install -g @jhizzard/termdeck-stack --include=optional` for Linux x64 specifically. Add an OS-detection note:
- macOS: `npm install -g @jhizzard/termdeck-stack` (default behavior is fine)
- Linux x64: `npm install -g @jhizzard/termdeck-stack --include=optional` (mandatory if the user's npm config has `omit=optional`)

**Where to land it:**
- `docs/GETTING-STARTED.md` — install section.
- README.md — install section (mirror).
- If there's an `INSTALL.md` or similar, mirror.

**Verify:** the Sprint 58 install-smoke-ubuntu workflow runs `npm install -g .` from working tree. After the fix, the workflow's `claude --version` step should pass on Linux x64. (T1 controls the workflow; coordinate with T1 if the workflow needs the `--include=optional` flag added — though since CI installs from working tree not registry, the optional-dep semantics may differ. Verify what the actual failure mode is in CI.)

## Brad #8 — systemd doesn't inherit user PATH

**Severity:** MEDIUM (systemd Type=simple environment is minimal; npm-global bin paths invisible).

**Background:** systemd services start with a minimal PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` — none of `~/.npm-global/bin`, `/opt/homebrew/bin`, `/usr/local/lib/node_modules/.bin`). `termdeck` installed under `~/.npm-global/bin/termdeck` is invisible to systemd unless `Environment=PATH=...` is set.

**Fix (docs + canonical unit):** the canonical systemd unit must include:
```ini
Environment="PATH=%h/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
```

Plus document this in the install guide's systemd section.

## Brad #3 — pgbouncer params unrecognized by psql

**Severity:** LOW (cosmetic; does not affect functionality).

**Background:** `?pgbouncer=true&connection_limit=1` are Prisma-specific URL hints that Prisma's connection-string parser strips before passing to `pg`. `psql` and other plain `pg` clients see them as unknown params and log a warning. The cross-client portable form is `?sslmode=require` alone.

**Fix (docs note in install guide):**
> **Note on Supabase pooler URLs:** if you've copied a Supabase URL with `?pgbouncer=true&connection_limit=1`, those are Prisma-specific hints. For TermDeck's `pg`-based wizard and doctor probes, the portable form `?sslmode=require` is sufficient. Both work; the Prisma-specific form just emits a harmless warning from `psql`.

No fixture for #3 (it's cosmetic, no install break).

## Canonical systemd unit example — wires up T2's `--service` flag

Author `docs/examples/termdeck.service` (or under whatever path matches the existing examples convention — check `find docs -name "*.service" -o -name "examples"` first).

Shape:
```ini
[Unit]
Description=TermDeck browser terminal multiplexer
After=network.target

[Service]
Type=simple
ExecStart=%h/.npm-global/bin/termdeck --service
Environment="PATH=%h/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Restart=on-failure
RestartSec=5
User=%u

[Install]
WantedBy=default.target
```

Key elements:
- `Type=simple` matches Brad's deployment shape.
- `ExecStart=... --service` uses T2's new flag (Brad #7 fix).
- `Environment=PATH=...` includes `~/.npm-global/bin` first (Brad #8 fix).
- `Restart=on-failure` + `RestartSec=5` for resilience.

**Coordination:** T2 owns the `--service` flag implementation. After T2 posts `### [T2] FIX-LANDED Brad-7 — flag is "--service"`, you confirm the flag name in your example matches. If T2 picks a different name (e.g. `--non-interactive`), update the unit accordingly.

**Fixture target:** Sprint 58's `systemd-nightly` Hetzner workflow installs the systemd unit. Currently the unit is whatever Sprint 58 T2 staged; post-Sprint-59 it should be a copy of `docs/examples/termdeck.service`. T3 of Sprint 58 was an orchestrator-coordinated lane so the canonical-unit substitution may need an orchestrator close-out swap; coordinate via STATUS.md.

## Discipline (universal)

- **Post shape:** `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`.
- **Stay in lane.** T1 owns launcher/env code; T2 owns shell + systemd code. You own ONLY docs + the example unit file. Cross-lane reads OK; cross-lane writes BANNED.
- **Append-only STATUS.md.**

## Coordination notes

- T2 publishes the `--service` flag name. Wait for `### [T2] FIX-LANDED Brad-7` before finalizing the example unit.
- T1 may add a docs note about `secrets.env` quote handling — coordinate to avoid duplication.
- T4-CODEX audits doc accuracy — if a documented step doesn't actually work in the matching fixture, T4 flags `### [T4-CODEX] DOCS-FIXTURE-MISMATCH`.

## Success criteria

1. `### [T3] FIX-LANDED` posts for Brad #6 (install-guide update), Brad #8 (PATH guidance + canonical unit), Brad #3 (pgbouncer note).
2. Canonical `docs/examples/termdeck.service` exists and matches T2's flag name.
3. T4-CODEX posts `### [T4-CODEX] DOCS-VERIFIED Brad-6/8/3` (or `DOCS-FIXTURE-MISMATCH` if a step is wrong).
4. `### [T3] DONE 2026-05-07 HH:MM ET` with summary + which docs files changed.
