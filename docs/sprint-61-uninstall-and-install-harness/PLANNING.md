# Sprint 61 — Uninstall + Fresh-Install Harness (Convergence Keystone)

**Status:** Authored 2026-05-07 ~17:25 ET, alongside Sprint 60 execution. Per `docs/CONVERGENCE-PLAN.md`, this is THE keystone sprint — without it, the convergence test ("fresh install + uninstall on Joshua's Macbook") cannot run. Scheduled to ship after v1.0.14 (Sprint 60).

**Pattern:** 3+1+1 with Codex auditor. Three workers (T1/T2/T3), one auditor (T4-CODEX), one orchestrator. Wall-clock estimate 2-3 days.

**Target ship:** `@jhizzard/termdeck@1.1.0` + `@jhizzard/termdeck-stack@1.1.0` (minor bump for the uninstall feature). Mnestra and Rumen unchanged. Skipping the `1.0.x` patch lane is intentional: this sprint introduces a new top-level command (`uninstall`), which is a feature, not a fix.

## Why this sprint exists

Per the convergence plan, the "stable installable + uninstallable product" end-state requires a single command that removes everything TermDeck created on a user's machine, plus an automated test that proves install → run → uninstall → re-install works clean. Today, TermDeck has zero uninstall path. Brad's r730 install would need ~10 manual steps to fully tear down (rm ~/.termdeck, npm uninstall, edit ~/.claude.json, edit ~/.claude/settings.json, remove hooks, remove LaunchAgents, drop Supabase schemas).

This sprint also closes Brad's open P0 from 2026-05-02 — the stack-installer upgrade-detection gap (Class A schema drift) — because the same machinery that knows what's been installed is the machinery that knows what to upgrade.

## Brad's two convergent P0s addressed by this sprint

1. **Upgrade-detection path** (open since 2026-05-02). Brad's primary Supabase project froze at the migration set current at first-kickstart even after upgrading npm packages. `init-rumen.js::applySchedule` only applies migrations on the *fresh-install* path. `npm install -g @latest` upgrades the package files; the database stays at first-install state. Until this is fixed, every external user who runs `npm install -g @latest` against an existing install ships into broken territory.
2. **No uninstall path** (surfaced 2026-05-07 by Joshua during the convergence call). User has no easy way to fully reset state, debug a bad install, or "start fresh." Compounds Brad's drift problem because there's no "give up and reinstall clean" escape hatch.

## Lane carve (3+1+1)

| Lane | Scope | Brad finding | Files (primary) |
|---|---|---|---|
| **T1 UNINSTALL CLI** | `termdeck-stack uninstall` command + `--purge-supabase` flag + idempotency + per-OS path branching | new feature | `packages/stack-installer/src/uninstall.js` (NEW), wired in `packages/stack-installer/src/index.js` |
| **T2 UPGRADE-DETECTION** | Schema introspection diff against bundled migration set; apply missing migrations on every wizard re-run; `mnestra_migrations` tracking table | Brad #2026-05-02 P0 | `packages/server/src/setup/migrations.js` (extended), `packages/cli/src/init-mnestra.js` + `init-rumen.js` (call-site), Mnestra migration `020_migration_tracking.sql` (NEW) |
| **T3 FRESH-INSTALL HARNESS** | Activate Sprint 58 catch-net Phase B (test Supabase + 10 GH secrets); add macOS install-smoke job; add uninstall step at end of every fixture; add re-install-after-uninstall probe | Sprint 58 deferred Phase B | `.github/workflows/install-smoke.yml` (extended), `.github/workflows/macos-install-smoke.yml` (NEW), `scripts/test-supabase-reset.sh` (extended for full schema drop) |
| **T4-CODEX AUDITOR** | Independent verification: idempotency of uninstall (run twice — second run is no-op), upgrade-detection probe coverage (does the diff catch every Sprint 38+ migration?), uninstall harness coverage (does it actually leave clean state on every OS?) | (audit) | (read-only across all the above) |

## T1 — UNINSTALL CLI scope

### `termdeck-stack uninstall` command shape

```
termdeck-stack uninstall [options]

Options:
  --dry-run          Print what would be removed; no changes
  --purge-supabase   Also drop Mnestra/Rumen schemas from the linked project
                     (BANNED unless explicitly confirmed; user data)
  --keep-secrets     Preserve ~/.termdeck/secrets.env (default: prompt)
  --yes              Skip all confirmations (CI mode)
```

### What gets removed (default mode)

1. **`~/.termdeck/`** — entire directory (config.yaml, secrets.env, secrets.env.bak.*, termdeck.db, db-wal, db-shm, transcripts/). Optionally preserved with `--keep-secrets`.
2. **`~/.claude.json` mnestra MCP entry** — surgical: read JSON, splice out `mcpServers.mnestra`, write back. Preserve every other MCP entry.
3. **`~/.claude/settings.json`** — splice SessionEnd hook entries pointing at the bundled hook file. Preserve other event wirings.
4. **`~/.claude/hooks/memory-session-end.js`** — move to `memory-session-end.js.bak.<ISO-timestamp>` for retention. Don't hard-delete (user may have customized).
5. **LaunchAgents** — `~/Library/LaunchAgents/com.jhizzard.termdeck.*.plist` if any (for future automation features). `launchctl unload` first, then remove.
6. **systemd units** (Linux) — `~/.config/systemd/user/termdeck.service` + `systemctl --user disable --now termdeck.service` if active. System-scope unit `/etc/systemd/system/termdeck.service` requires sudo and a separate prompt.
7. **npm packages** — print the `npm uninstall -g @jhizzard/termdeck @jhizzard/termdeck-stack` command for the user to run after the script exits (script can't safely uninstall itself).

### What does NOT get removed (default mode)

- The user's Supabase project (data preservation; they paid for it)
- The Mnestra/Rumen schemas inside the Supabase project (same)
- Other MCP entries in `~/.claude.json` (e.g. supabase, playwright, mnestra-other-project)
- Other hooks in `~/.claude/hooks/`
- The user's transcripts written outside `~/.termdeck/transcripts/`

`--purge-supabase` is the explicit user-confirmed nuke. Two-step prompt (first asks, then "type the project ref to confirm").

### Idempotency contract

- Running `uninstall` twice in a row produces clean output the second time: "already uninstalled" rather than errors about missing files.
- Running on a machine that never had TermDeck installed exits 0 with "nothing to uninstall."
- Partial install state (config but no hooks, etc.) is handled by per-step independence; one missing step doesn't block others.

### Tests

`tests/uninstall-cli.test.js`:
- Synthetic install state in a tempdir; run uninstall; assert all expected paths gone, others preserved.
- Run uninstall twice; second run idempotent.
- `--dry-run` writes nothing.
- `--keep-secrets` preserves `~/.termdeck/secrets.env`.
- `~/.claude.json` MCP splice preserves other entries.
- `~/.claude/settings.json` SessionEnd splice preserves other event wirings.

## T2 — UPGRADE-DETECTION scope

### Migration tracking table

New Mnestra migration `020_migration_tracking.sql`:

```sql
CREATE TABLE IF NOT EXISTS mnestra_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL,
  schema_version text
);

ALTER TABLE mnestra_migrations ENABLE ROW LEVEL SECURITY;
-- service_role-only; anon/authenticated have no access
```

Same shape for `rumen_migrations` if Rumen ships one.

### Diff-and-apply pass

`packages/server/src/setup/migrations.js` extension:

1. On every `init --mnestra` / `init --rumen` invocation, query `mnestra_migrations` for the set of applied filenames.
2. List bundled migrations under `packages/server/src/setup/mnestra-migrations/`.
3. Compute diff: `bundled - applied = pending`.
4. Apply pending migrations in filename order.
5. Write each applied filename + sha256 checksum to `mnestra_migrations` after the migration's transaction commits.

### Backfill for existing installs

For users upgrading from pre-`020` Mnestra, the first invocation:
1. Probes for the existence of post-Sprint-38 columns / tables / functions (`memory_relationships.weight`, `memory_items.source_agent`, `pg_proc memory_recall_graph`, `cron.job WHERE jobname='graph-inference-tick'`).
2. Inserts retroactive `mnestra_migrations` rows for each migration whose schema-fingerprint matches the current state.
3. Then runs the regular diff-and-apply.

This is Brad's option (2) — durable tracking — preferred over option (1) — probe-only — because it's auditable and survives migration reordering.

### Tests

`tests/migration-tracker.test.js`:
- Empty mnestra_migrations + bundled-set of N → applies all N.
- Partial applied + bundled-set of N → applies (N - applied).
- Backfill detects post-Sprint-38 schema state and seeds rows accordingly.
- Re-running with no diff exits clean.
- Migration with bad checksum vs DB → flags warning, does not auto-overwrite.

## T3 — FRESH-INSTALL HARNESS scope

### Phase B activation (operator-coordinated atomic task)

Per Sprint 58's deferred Phase B runbook (`docs/INSTALL-FIXTURES.md` § 6.1-6.7):
1. Provision `termdeck-test` Supabase project (free tier).
2. Apply 18 Mnestra + 3 Rumen migrations.
3. Add 10 canonical secrets to GitHub Actions: `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_DATABASE_URL`, plus dummy `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `HETZNER_API_TOKEN`, `HETZNER_SSH_KEY`.
4. Install canary row in `memory_items` so reset-script verification has a known target.
5. Verify reset script clears + re-seeds correctly.

This is ~15 min operator action. Block on it if needed.

### macOS install-smoke job

New `.github/workflows/macos-install-smoke.yml`:
- Runs on `macos-14` (or current GH-supported macOS runner).
- Same install-then-doctor sequence as ubuntu-24.04.
- Catches macOS-specific issues (Apple Silicon vs Intel, Homebrew vs system Node, /Applications vs ~/Applications LaunchAgents path).

### Uninstall step appended to every fixture

After the existing `termdeck doctor` probe in each fixture:
1. Run `termdeck-stack uninstall --yes`.
2. Probe: `~/.termdeck/` should not exist.
3. Probe: `~/.claude.json` should not contain `mnestra`.
4. Probe: `~/.claude/hooks/memory-session-end.js` should not exist (or only the `.bak` variant).
5. **Re-install-after-uninstall probe.** Run `termdeck-stack` again from clean. Verify identical end-state to the first install (config exists, hook exists, MCP wired, doctor green).

This proves the uninstall is COMPLETE — that subsequent installs aren't poisoned by leftover state.

### Tests

Existing `tests/install-smoke-fixture-*.test.js` suite extended; plus a new local-dev `tests/uninstall-then-reinstall.test.js` that runs the full sequence in a tempdir without needing the GitHub Actions infrastructure.

## T4-CODEX AUDITOR scope

Standard 3+1+1 audit pattern, per Sprint 51.6+ refinements:
1. **Phase 1: Read-the-WIP.** Audit each lane's diffs as they appear, before FIX-LANDED.
2. **Phase 2: Per-finding verification.**
   - T1: idempotency of uninstall (run twice, assert second run is clean no-op).
   - T1: surgical splice of ~/.claude.json — verify other MCP entries preserved.
   - T1: surgical splice of ~/.claude/settings.json — verify other event wirings preserved.
   - T2: migration-tracker covers EVERY Sprint 38+ migration in the bundled set.
   - T2: backfill probe set covers every column/table/function added since Mnestra 0.3.0.
   - T3: every fixture's uninstall step actually leaves clean state — no regression-rot leftovers.
3. **Phase 3: Adversarial coverage probe.** What uninstall edge case is NOT in the test matrix? E.g. user with two Mnestra MCP entries (one TermDeck, one external project — Brad's 4-Supabase pattern); user with a customized hook file (must NOT be hard-deleted); user with active sessions when uninstall fires.
4. **Phase 4: Cross-fix interaction.** Does T1's `~/.claude.json` splice race against T2's wizard's `~/.claude.json` writes? Does T3's reset script handle T2's new `mnestra_migrations` table?
5. **Final verdict.** GREEN / YELLOW / RED for sprint close.

CHECKPOINT discipline mandatory (every 15 min minimum) per global rules.

## Acceptance criteria

1. `termdeck-stack uninstall` works on macOS + Linux (Ubuntu, Alpine, Debian, Fedora) leaving zero TermDeck-attributable trace.
2. Re-running the wizard against an upgraded npm package applies any missing migrations automatically.
3. Sprint 58 catch-net is now CI-active (Phase B wired); install-smoke matrix runs uninstall-then-reinstall probe and reports green.
4. `tests/uninstall-cli.test.js` + `tests/migration-tracker.test.js` + `tests/uninstall-then-reinstall.test.js` all green.
5. T4-CODEX final verdict: GREEN.
6. CHANGELOG.md `## [1.1.0]` block authored with feature list + uninstall command docs.
7. **Joshua runs the convergence test on his Macbook (`docs/CONVERGENCE-PLAN.md` § The end-state) — passes.**

## Out of Sprint 61 scope

- Security-by-default migration (Sprint 62 — RLS-on baseline + REVOKE EXECUTE pattern + auth rate-limiting)
- Install-polish wizard (Sprint 63 — Supabase MCP auto-provision + OS-detection + schema-generation auto-detect)
- Cost-monitoring panel
- Active health dashboard
- Anything in BACKLOG.md sections C, D, E, F that isn't directly install/uninstall

## Cross-references

- Convergence plan: `docs/CONVERGENCE-PLAN.md`
- BACKLOG (Brad's upgrade-detection P0): `docs/BACKLOG.md` — entry dated 2026-05-02
- INSTALLER-PITFALLS taxonomy: `docs/INSTALLER-PITFALLS.md` (Class A — schema drift; Class N — lockstep-migration)
- Sprint 60 PLANNING (v1.0.14 hotfix): `docs/sprint-60-v1014-hotfix-bundle/PLANNING.md`
- Sprint 58 catch-net Phase B runbook: `docs/INSTALL-FIXTURES.md` § 6
- Project rules: `CLAUDE.md`
- Global rules: `~/.claude/CLAUDE.md`
