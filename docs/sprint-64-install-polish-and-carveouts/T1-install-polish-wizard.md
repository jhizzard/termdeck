# T1 — Install-polish wizard (Supabase MCP auto-provision + OS-detection)

You are T1 in Sprint 64 — Install-polish convergence + Sprint 63 carve-outs + Investigation 2. **Your lane is the keystone of the sprint.** When T1 ships, the new-user install path collapses from 15+ manual steps to "paste 2 credentials, click 3 buttons," and the MacBook Air dogfood acceptance test from `docs/CONVERGENCE-PLAN.md` can run clean.

## Boot sequence

1. `memory_recall(project="termdeck", query="install wizard init-mnestra init-rumen Supabase MCP provision OS detection")`
2. `memory_recall(query="recent decisions and bugs 2026-05-11 through 2026-05-14")`
3. Read `~/.claude/CLAUDE.md` (global rules — 3+1+1 hardening + Supabase RLS hygiene + no-forbidden-literals + gitleaks discipline)
4. Read `./CLAUDE.md` (TermDeck project read-order)
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` (Investigation 1 closed; Investigation 2 is T3's lane this sprint)
6. Read `docs/RESTART-PROMPT-2026-05-11.md` § Sprint 64 candidates (context)
7. Read `docs/CONVERGENCE-PLAN.md` — your lane is the named keystone there
8. Read `docs/sprint-64-install-polish-and-carveouts/PLANNING.md`
9. Read `docs/sprint-64-install-polish-and-carveouts/STATUS.md`
10. Read this file in full

Then begin.

## Scope

Three sub-tasks. Ship as a single FIX-PROPOSED block once all three cohere.

### 1.1 — Supabase MCP auto-provision path

New flag: `termdeck init --auto` (or `--mcp-supabase` — your call, document the choice in FINDING). Delegates Supabase project creation + migration application + vault secret setup to the Supabase MCP server.

Tool calls of interest (verified loaded against `mcp__supabase__*` namespace; check current schemas at lane start):

- `mcp__supabase__list_organizations` — pick the org to create under.
- `mcp__supabase__create_project` — provisions a fresh project; returns the new project ref. **Hygiene:** if Joshua's already running multi-port (per BACKLOG D.5 "8-panel grid OR multi-port" entry), the wizard MUST NOT overwrite an existing project ref without explicit confirmation. Probe `~/.termdeck/secrets.env` for an existing `SUPABASE_URL` first; only auto-provision if empty.
- `mcp__supabase__apply_migration` — apply the bundled Mnestra + Rumen + TermDeck migration set to the new project. Iterate the migration files at `packages/server/src/setup/migrations/` + `packages/cli/src/init-mnestra.js` migration list + `packages/cli/src/init-rumen.js` migration list. Order matters; preserve the existing order.
- `mcp__supabase__get_project_url` + `mcp__supabase__get_publishable_keys` — fetch the URL + anon + service_role keys for `secrets.env` write.
- `mcp__supabase__deploy_edge_function` — deploy Rumen + graph-inference Edge Functions.
- `mcp__supabase__get_advisors` — post-provision RLS + function-search-path + lint sweep. Any RED advisor BLOCKS wizard completion with a clear remediation hint.

**Failure modes to handle:**
- MCP server not authenticated. Fall through to the manual flow (existing `init-mnestra` path) with a clear "MCP unavailable; falling back to manual" log.
- Supabase quota exhausted (free tier limits). Surface a remediation hint with the link to billing.
- Migration apply failure mid-run. Roll back what was applied if possible; otherwise leave a `~/.termdeck/.partial-install` marker file so subsequent runs can resume rather than re-provision.

### 1.2 — OS-detection branches

Detect at wizard boot: macOS / Ubuntu / Docker (fedora vs debian fixtures via `/etc/os-release` parse) / unknown. New module `packages/cli/src/os-detect.js` exporting `detectOS()` returning `{family: 'macos'|'linux'|'docker', distro?: 'ubuntu'|'fedora'|'debian'|'alpine', version: string, isAppleSilicon?: boolean, defaultShell: string}`.

Branches:
- **Default shell:** `zsh` on macOS, `bash` on Ubuntu/debian, `bash` on fedora, `sh` on minimal Alpine. Cross-reference Sprint 59 T2's `resolveSpawnShell` at `packages/server/src/index.js` — that precedent chained `config.shell` → `$SHELL` → `/bin/sh`; the wizard's default detection should agree with the runtime fallback.
- **Default node-pty rebuild guidance:** macOS → "xcode-select --install"; Ubuntu → "apt install build-essential"; fedora → "dnf install gcc-c++ make"; alpine → "apk add build-base". Surface the right hint in the wizard's "if you need to rebuild" tip.
- **Default install path:** macOS → `~/Library/Application Support/termdeck` is NOT used; stick with `~/.termdeck/`. Linux → `~/.termdeck/`. (XDG_CONFIG_HOME respect is a separate ticket; out of scope here.)
- **Autostart unit emission:** macOS → launchd plist stub at `~/Library/LaunchAgents/com.jhizzard.termdeck.plist`; Linux → systemd user unit stub at `~/.config/systemd/user/termdeck.service`. **If scope creeps, stub-only with TODO marker is acceptable** — full autostart wiring can defer to Sprint 65+.

### 1.3 — Wizard surface unification

New file `packages/cli/src/init.js` — top-level `termdeck init` orchestrator. Runs:

1. `os-detect.detectOS()` → store result for downstream branches.
2. Probe `~/.termdeck/secrets.env` for existing config. If present, ask: "Existing install detected. Reset (--reset) / Continue with detected config / Cancel."
3. If `--auto` or `--mcp-supabase`: run sub-task 1.1 (Supabase MCP provisioning).
4. Else: run existing `init-mnestra.js` flow (manual paste of credentials).
5. After Mnestra config lands: run existing `init-rumen.js` flow.
6. Run `termdeck doctor` (Sprint 35 + schema-check probes).
7. Run `mcp__supabase__get_advisors` for RLS + lint sweep. RED advisors block.
8. Surface a final "ready to start" message with the dashboard URL.

Both `init-mnestra` and `init-rumen` stay callable independently for advanced users / CI fixtures.

Progress UX: single progress bar across all phases. Phase labels: "Detecting OS" → "Provisioning Supabase" → "Applying Mnestra migrations" → "Deploying Rumen" → "Verifying" → "Done."

`--reset` and `--from-env` flags carry forward to the unified wizard:
- `--reset`: drop `~/.termdeck/secrets.env` + bundled artifacts; re-provision.
- `--from-env`: skip interactive paste; read seed credentials from existing `~/.termdeck/secrets.env`.

## Files of interest

- `packages/cli/src/init.js` (NEW — top-level orchestrator)
- `packages/cli/src/os-detect.js` (NEW — OS-detection module, exports `detectOS()`)
- `packages/cli/src/mcp-supabase-provision.js` (NEW — MCP-mediated provisioning path)
- `packages/cli/src/init-mnestra.js` (existing; do NOT rewrite — call from `init.js`)
- `packages/cli/src/init-rumen.js` (existing; do NOT rewrite — call from `init.js`)
- `packages/cli/src/doctor.js` (existing; wire post-provision verification sweep)
- `packages/cli/src/index.js` (existing; add `init` subcommand routing)
- `packages/cli/tests/init-flow.test.js` (NEW — fixture-based test of the unified flow)
- `packages/cli/tests/os-detect.test.js` (NEW — fixture-based OS-detection tests)
- `packages/cli/tests/mcp-supabase-provision.test.js` (NEW — mocked-MCP tests)

## Acceptance criteria

For this lane to close (post `### [T1] DONE`):

- `npm test` root green (regression-clean; expect ~40+ new tests across the three new modules).
- Manual fixture run: on a fresh Ubuntu 24.04 Docker fixture, `termdeck init --auto` completes end-to-end + dashboard renders. (Use the Sprint 61 fresh-install harness if it's still wired.)
- Manual fixture run: same on a fresh macOS fixture (or simulated via mocked `os-detect`).
- All RLS hygiene gates pass on the provisioned project (`mcp__supabase__get_advisors` returns no RED rows).
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles those at sprint close.

## Post discipline

`### [T1] STATUS-VERB 2026-05-14 HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING (as needed) → FIX-PROPOSED → FIX-LANDED → DONE. Use `### ` prefix on every post (rule 1 from PLANNING § Hardening rules). No bare `[T1]` posts.

If you hit a scope question (especially around 1.1's failure-mode handling), post `### [T1] FINDING ... — scope question: <X>` and idle-poll for `### [ORCH] SCOPE ...` adjudication.

## Hygiene reminders specific to this lane

- **NEVER** hardcode the reference Mnestra project ID or internal project name in any file you ship. The wizard auto-provisions a NEW project per fresh install; the reference project name only appears (if at all) on Joshua's daily-driver and is scrubbed via gitleaks.
- **Vault secrets** (`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`) MUST go through `~/.termdeck/secrets.env`, never logged to stdout / stderr / log files.
- **No `WITH CHECK (true)` policies** in any migration this lane authors. Per global RLS hygiene rule.
- **Every new function** declared in this lane's migrations gets `REVOKE EXECUTE … FROM PUBLIC` + targeted `GRANT EXECUTE … TO service_role` + `SET search_path = public, pg_catalog`. Per the same rule.
