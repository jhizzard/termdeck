# T1 — UNINSTALL CLI

You are **T1** in Sprint 61 (Uninstall + Fresh-Install Harness — Convergence Keystone).

## Why this lane exists

TermDeck has zero uninstall path today. A user who installs the stack and wants to fully tear down currently needs ~10 manual steps (`rm ~/.termdeck`, `npm uninstall -g`, edit `~/.claude.json`, edit `~/.claude/settings.json`, remove hooks, remove LaunchAgents, drop Supabase schemas). This blocks the convergence-test acceptance ("install + uninstall on Joshua's Macbook"), the "give up and reinstall clean" escape hatch, and CI fixture coverage of "did the uninstall actually leave clean state."

Your job is to ship the `termdeck-stack uninstall` command — surgical, idempotent, OS-aware, with explicit data-preservation defaults.

## Boot sequence (run before any code)

1. `memory_recall(project="termdeck", query="uninstall command + stack-installer + ~/.termdeck cleanup + ~/.claude.json splice + ~/.claude/settings.json hook entries")`
2. `memory_recall(query="stack-installer architecture + LaunchAgents + systemd units")`
3. Read `~/.claude/CLAUDE.md`
4. Read `./CLAUDE.md`
5. Read `docs/CONVERGENCE-PLAN.md` (the end-state acceptance test)
6. Read `docs/sprint-61-uninstall-and-install-harness/PLANNING.md`
7. Read `docs/sprint-61-uninstall-and-install-harness/STATUS.md`
8. Read `docs/INSTALLER-PITFALLS.md` (14 failure classes — your work must trace to which classes it avoids; especially Class A, N, O for uninstall→reinstall correctness)
9. Read `packages/stack-installer/src/index.js` (the install ceremony — your uninstall is the inverse)
10. Read `packages/stack-installer/src/launcher.js` and `mcp-config.js` (the splice surfaces)

Then begin.

## Scope (precise)

Author `packages/stack-installer/src/uninstall.js` (NEW) and wire it into `packages/stack-installer/src/index.js` so `termdeck-stack uninstall` is a top-level subcommand.

### Command shape

```
termdeck-stack uninstall [options]

Options:
  --dry-run          Print what would be removed; no changes
  --purge-supabase   Also drop Mnestra/Rumen schemas from the linked Supabase
                     project. Two-step prompt: first asks, then "type the
                     project ref to confirm". BANNED unless explicit.
  --keep-secrets     Preserve ~/.termdeck/secrets.env (default: prompt;
                     CI mode without --yes treats this as the safe default)
  --yes              Skip all confirmations (CI mode)
  -h, --help         Print usage
```

### Removal steps (default mode, in this order)

1. **Pre-flight summary.** Print exactly what will be removed (paths + sizes if cheap), then prompt for confirmation unless `--yes`.

2. **`~/.termdeck/`** — entire directory:
   - `config.yaml`, `secrets.env`, `secrets.env.bak.*`
   - `termdeck.db`, `termdeck.db-wal`, `termdeck.db-shm`
   - `transcripts/`, `uploads/` (per-session tempdirs)
   - With `--keep-secrets`: preserve `secrets.env` and `secrets.env.bak.*`; remove the rest. Echo "preserved" in summary.

3. **`~/.claude.json` mnestra MCP entry** — surgical splice:
   - Read JSON; if malformed, abort with clear error (do NOT overwrite).
   - Splice `mcpServers.mnestra` (and any other key your install ceremony writes — verify against `packages/stack-installer/src/mcp-config.js`).
   - Preserve every other MCP entry (supabase, playwright, mnestra-other-project, etc.).
   - Write back with the same indent style. Atomic write (temp file + rename).
   - If the file doesn't exist, skip silently.

4. **`~/.claude/settings.json`** — surgical splice:
   - Splice `hooks.SessionEnd[*]` and `hooks.Stop[*]` entries whose `command` field references `~/.claude/hooks/memory-session-end.js` (the bundled hook). Preserve other entries in the same arrays.
   - If `hooks.SessionEnd` becomes empty after splice, remove the key (don't leave `"SessionEnd": []`).
   - Preserve other event wirings (PreCompact, UserPromptSubmit, etc.).
   - Atomic write. Same fail-mode as step 3.

5. **`~/.claude/hooks/memory-session-end.js`** — move to `memory-session-end.js.bak.<ISO-timestamp>` for retention. Don't hard-delete (user may have customized; backup is cheap).

6. **LaunchAgents** (macOS) — `~/Library/LaunchAgents/com.jhizzard.termdeck.*.plist`:
   - For each match: `launchctl unload <path>` first (capture stderr; non-fatal if not loaded).
   - Then `rm <path>`.
   - If none present, skip silently.

7. **systemd units** (Linux) — `~/.config/systemd/user/termdeck.service` if present:
   - `systemctl --user disable --now termdeck.service` (non-fatal if not active).
   - `rm <path>`.
   - System-scope `/etc/systemd/system/termdeck.service` requires sudo; print a separate prompt suggesting the command rather than attempting it directly.

8. **`--purge-supabase`** (only if flag passed): two-step prompt (first asks, then "type the project ref to confirm"). On confirm, drop Mnestra schemas — `memory_items`, `memory_relationships`, `memory_sessions`, `mnestra_migrations`, `rumen_*` tables/functions/types. Use the linked Supabase project from `~/.termdeck/secrets.env::SUPABASE_DB_URL` BEFORE step 2 removes it.

9. **Final notice.** Print:
   ```
   Uninstalled. Run `npm uninstall -g @jhizzard/termdeck @jhizzard/termdeck-stack` to remove the npm packages.
   (Cannot self-uninstall safely while running.)
   ```

### Idempotency contract

- Running `uninstall` twice produces clean output the second time: `"already uninstalled (no TermDeck-attributable state found)"` rather than a pile of "no such file" errors.
- Running on a machine that never had TermDeck installed exits 0 with `"nothing to uninstall."`
- Partial install state (config but no hooks, hooks but no LaunchAgent, etc.) handled by per-step independence — one missing step doesn't block others. Each step is a try/catch that logs to summary, never aborts the run.

### OS branching

- macOS (`process.platform === 'darwin'`): include LaunchAgents step, skip systemd.
- Linux (`process.platform === 'linux'`): skip LaunchAgents, include systemd.
- Other (windows, freebsd, etc.): skip both, print `"OS-specific cleanup not implemented for <platform>"`.

### Tests — `tests/uninstall-cli.test.js` (NEW)

Use a tempdir as fake `$HOME`; mock `os.homedir()` to point at it. Required cases:

1. **Synthetic full install state.** Pre-populate tempdir with `~/.termdeck/`, `~/.claude.json` (with mnestra + 2 other MCP entries), `~/.claude/settings.json` (with bundled-hook entries + 2 unrelated entries), `~/.claude/hooks/memory-session-end.js`, `~/Library/LaunchAgents/com.jhizzard.termdeck.test.plist`. Run uninstall. Assert all expected paths gone or moved-to-bak; other MCP entries preserved; other settings.json wirings preserved.

2. **Idempotent second run.** Run uninstall twice. Assert second run is no-op with the "already uninstalled" message and exit 0.

3. **Never-installed.** Empty tempdir, run uninstall, exit 0 with "nothing to uninstall."

4. **`--dry-run`** writes nothing; output mentions every path that *would* be removed.

5. **`--keep-secrets`** preserves `~/.termdeck/secrets.env` and `secrets.env.bak.*`.

6. **`~/.claude.json` MCP splice** preserves other entries — pre-populate with 3 MCP entries (supabase, playwright, mnestra), assert post-state has 2 (supabase, playwright) and the file's other top-level keys (e.g., `permissions`, `env`) are bit-exact preserved.

7. **`~/.claude/settings.json` splice** preserves other event wirings — pre-populate with `hooks.SessionEnd` containing the bundled-hook entry + 1 unrelated entry, plus `hooks.UserPromptSubmit` with 1 entry. Assert post-state has the unrelated SessionEnd entry preserved AND the UserPromptSubmit entry untouched.

8. **`~/.claude/hooks/memory-session-end.js`** moved to `.bak.<ISO-timestamp>` not hard-deleted; the timestamp matches an ISO-8601 regex.

9. **LaunchAgent unload-then-remove** — mock `launchctl unload` (or use a fake binary on PATH) and assert the unload was called BEFORE the rm.

10. **Malformed `~/.claude.json`** — write `{` (broken JSON), run uninstall, assert exit non-zero with clear error and the file is bit-exact preserved.

## Lane discipline (post-shape MANDATORY)

- Post `### [T1] STATUS-VERB 2026-05-07 HH:MM ET — gist` to `docs/sprint-61-uninstall-and-install-harness/STATUS.md` for every status change.
- Post `### [T1] FIX-PROPOSED ...` BEFORE applying a substantive diff (so T4-CODEX can audit-the-WIP).
- Post `### [T1] FIX-LANDED ...` after applying.
- Post `### [T1] DONE ...` only when tests green AND lane scope complete.
- Don't bump versions, don't touch CHANGELOG, don't commit.
- Don't edit files outside your lane (T2's migrations.js, T3's workflows). If you find a fix needed there, post `### [T1] FINDING ...` with file:line and let the orchestrator route.

## Acceptance for T1 DONE

1. `packages/stack-installer/src/uninstall.js` authored + wired into `index.js`.
2. `termdeck-stack uninstall --help` prints the usage block above.
3. `tests/uninstall-cli.test.js` — all 10 cases green.
4. `npm test` (or the focused subset for the stack-installer package) passes.
5. T4-CODEX has posted `### [T4-CODEX] AUDIT-CLEAR T1 ...` (or you've addressed any AUDIT-CONCERN).
6. Final `### [T1] DONE 2026-05-XX HH:MM ET — uninstall CLI shipped, 10 tests green` post.

## INSTALLER-PITFALLS classes you must trace to

- **Class B** (User-facing surface drift) — splices preserve other MCP entries.
- **Class N** (Lockstep-migration drift) — uninstall removes everything install added; T3's reinstall probe verifies no leftover state poisons.
- **Class O** (Stale-local-global-install drift on the publisher's own machine) — uninstall must work even when the global npm install is at a different version than the source tree being run.

## What to ask the orchestrator

- If you find a step that depends on T2 or T3 work landing first, post `### [T1] BLOCKED ...`.
- If `packages/stack-installer/src/index.js`'s install ceremony writes a path you don't recognize, ask: "is this part of the install? include in uninstall scope?"

## Out of T1 scope (do NOT touch)

- Migration tracking table (T2's lane).
- GitHub Actions workflows (T3's lane).
- CHANGELOG, version bumps, commits, npm publish (orchestrator).
- Wizard rewrite for re-install detection (Sprint 63).
