# T3 — FRESH-INSTALL HARNESS

You are **T3** in Sprint 61 (Uninstall + Fresh-Install Harness — Convergence Keystone).

## Why this lane exists

Sprint 58 shipped the install-smoke catch-net **scaffolding** (Phase A) but Phase B (test Supabase + 10 GH secrets) was deferred to the operator. The fixture matrix today proves the scaffolding works against zero-secret Dockerfiles; it does NOT prove a real wizard run reaches a functional Supabase project. Without Phase B activation, your install-smoke gate is theatrical.

Plus: the fixture matrix is **install-only**. T1's uninstall command needs CI coverage proving `install → doctor → uninstall → reinstall → doctor` works clean across the matrix. Without this probe, T1's uninstall could ship and we'd never learn it leaves leftover state on Linux or that re-install poisons against leftover state.

Plus: matrix is Linux-only (ubuntu-24.04 + 4 Dockerfiles). Joshua's daily-driver is macOS. Brad's r730 is Linux. The 3+ external testers span both. macOS-specific issues (LaunchAgents path, Apple Silicon vs Intel, Homebrew vs system Node) can ship and we'd never learn until a tester reports.

Your job: activate Phase B, add macOS smoke job, append uninstall-then-reinstall probe to every fixture.

## Boot sequence (run before any code)

1. `memory_recall(project="termdeck", query="install-smoke fixtures + Sprint 58 catch-net + Phase B + test Supabase + 10 GH secrets")`
2. `memory_recall(project="termdeck", query="macOS install-smoke + LaunchAgents + Apple Silicon")`
3. `memory_recall(query="GitHub Actions + macos-14 runner + secrets")`
4. Read `~/.claude/CLAUDE.md`
5. Read `./CLAUDE.md`
6. Read `docs/CONVERGENCE-PLAN.md`
7. Read `docs/sprint-61-uninstall-and-install-harness/PLANNING.md` (especially § T3 scope)
8. Read `docs/sprint-61-uninstall-and-install-harness/STATUS.md`
9. Read `docs/INSTALL-FIXTURES.md` (complete — especially § 6 Phase B runbook + § 7 reset script)
10. Read `.github/workflows/install-smoke.yml` (the existing matrix)
11. Read `scripts/test-supabase-reset.sh` (existing schema reset)
12. Read `tests/install-smoke-fixture-*.test.js` files (the existing fixture pattern)

Then begin.

## Scope (precise)

### Step 0 — Phase B activation (operator-coordinated atomic task)

**This is operator-blocked.** Phase B requires Joshua (or a delegated operator) to:

1. Provision `termdeck-test` Supabase project (free tier, separate from the daily-driver Mnestra project).
2. Apply Mnestra migrations 001-019 + Rumen migrations.
3. Add 10 canonical secrets to GitHub Actions (`Settings > Secrets and variables > Actions`):
   - `TEST_SUPABASE_URL`
   - `TEST_SUPABASE_ANON_KEY`
   - `TEST_SUPABASE_SERVICE_ROLE_KEY`
   - `TEST_DATABASE_URL`
   - Plus dummy/non-functional placeholders for: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `HETZNER_API_TOKEN`, `HETZNER_SSH_KEY`.
4. Install canary row in `memory_items` so reset-script verification has a known target.
5. Verify `scripts/test-supabase-reset.sh` clears + re-seeds the canary row correctly.

If Phase B is not yet active when you start, post `### [T3] BLOCKED 2026-05-07 HH:MM ET — Phase B operator action pending` and proceed with steps 1-3 (which can land without Phase B; they just don't actually pass CI until Phase B is up).

The runbook is in `docs/INSTALL-FIXTURES.md` § 6.1-6.7. Don't reinvent.

### Step 1 — macOS install-smoke job

New file: `.github/workflows/macos-install-smoke.yml`.

Shape:
```yaml
name: macos-install-smoke

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  macos-fresh-install:
    runs-on: macos-14
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install termdeck-stack from source
        run: npm install -g .  # or whatever the existing pattern is
      - name: Run installer (non-interactive)
        env:
          TEST_SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}
          TEST_SUPABASE_ANON_KEY: ${{ secrets.TEST_SUPABASE_ANON_KEY }}
          TEST_SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}
          TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
        run: termdeck-stack --yes
      - name: Reset Supabase project state
        env:
          TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
        run: ./scripts/test-supabase-reset.sh
      - name: Run doctor
        run: termdeck doctor
      - name: Uninstall (T1's command)
        run: termdeck-stack uninstall --yes
      - name: Verify clean state
        run: |
          test ! -d "$HOME/.termdeck" || (echo "~/.termdeck still exists" && exit 1)
          # ... add other clean-state checks (no .claude.json mnestra entry, etc.)
      - name: Re-install probe
        env:
          TEST_SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}
          TEST_SUPABASE_ANON_KEY: ${{ secrets.TEST_SUPABASE_ANON_KEY }}
          TEST_SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.TEST_SUPABASE_SERVICE_ROLE_KEY }}
          TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
        run: termdeck-stack --yes
      - name: Doctor after re-install
        run: termdeck doctor
      - name: Final uninstall (cleanup)
        run: termdeck-stack uninstall --yes
```

Mirror the structure (especially the env-var injection style) of `install-smoke.yml`. If that file uses a reusable composite action, use it here too.

### Step 2 — Append uninstall-then-reinstall step to every fixture in `install-smoke.yml`

For each fixture job in `.github/workflows/install-smoke.yml`:

After the existing `termdeck doctor` (or equivalent post-install probe) step:

```yaml
      - name: Uninstall (Sprint 61 T1)
        run: termdeck-stack uninstall --yes
      - name: Verify clean state
        run: |
          test ! -d "$HOME/.termdeck" || (echo "~/.termdeck still exists" && exit 1)
          # Verify no mnestra entry in ~/.claude.json (if it exists)
          if [ -f "$HOME/.claude.json" ]; then
            ! grep -q '"mnestra"' "$HOME/.claude.json" || (echo "mnestra MCP entry leaked" && exit 1)
          fi
          # Verify hook moved to .bak (or absent)
          test ! -f "$HOME/.claude/hooks/memory-session-end.js" || (echo "bundled hook leaked" && exit 1)
      - name: Re-install
        env: ${{ <reuse the same env block as the fresh-install step> }}
        run: termdeck-stack --yes
      - name: Doctor after re-install
        run: termdeck doctor
```

### Step 3 — `scripts/test-supabase-reset.sh` extension for full schema drop

Extend the reset script to handle:
- Dropping `mnestra_migrations` table (T2's new tracking) so re-install starts clean.
- Dropping all `rumen_*` schema artifacts.
- Re-running the canary-row insert post-reset.

Verify against the canary row that reset is clean.

### Step 4 — `tests/uninstall-then-reinstall.test.js` (NEW, local-dev)

Local-dev test that runs the full sequence in a tempdir without needing GH Actions infrastructure. Mock `os.homedir()` to a tempdir; run install (or simulate) → uninstall → re-install → assert state matches first install. Acceptable to use simulated install state if a full e2e is too heavyweight; document the simplification in the test file's header comment.

This is a belt-and-suspenders test — the GH Actions probe is the load-bearing one, but local-dev coverage prevents PR feedback loops from waiting on CI.

## Lane discipline

- Post `### [T3] STATUS-VERB 2026-05-07 HH:MM ET — gist` for every status change.
- Post `### [T3] BLOCKED ...` if Phase B operator action isn't active when you reach Step 0.
- Watch for T1 + T2 DONE — your CI matrix uses T1's uninstall command and T2's tracking-table-aware migrations runner. Idle-poll regex: `^(### )?\[T[12]\] DONE\b`.
- Post `### [T3] FIX-PROPOSED ...` BEFORE applying substantive diff.
- Don't bump versions, don't touch CHANGELOG, don't commit.

## Acceptance for T3 DONE

1. `.github/workflows/macos-install-smoke.yml` authored, syntax valid (`actionlint` if available).
2. `.github/workflows/install-smoke.yml` extended with uninstall + clean-state-verify + re-install + post-reinstall doctor steps for every existing fixture.
3. `scripts/test-supabase-reset.sh` extended to drop `mnestra_migrations` + rumen artifacts + re-seed canary.
4. `tests/uninstall-then-reinstall.test.js` authored + green locally.
5. **Phase B operator confirmation:** Joshua (or designated operator) has confirmed Phase B is active in `docs/sprint-61-uninstall-and-install-harness/STATUS.md` via an `### [ORCH]` post. Until then T3 is BLOCKED on operator.
6. Once Phase B active: trigger `workflow_dispatch` on both `install-smoke` and `macos-install-smoke` against this branch and confirm both green.
7. T4-CODEX has posted `### [T4-CODEX] AUDIT-CLEAR T3 ...`.
8. Final `### [T3] DONE 2026-05-XX HH:MM ET — install-smoke matrix green incl. macOS + uninstall-reinstall probe` post.

## INSTALLER-PITFALLS classes you must trace to

- **Class C** (Cross-OS path divergence) — macOS smoke catches this directly.
- **Class N** (Lockstep migration) — uninstall-reinstall probe catches leftover state poisoning re-install.
- **Class O** (Stale-local-global-install drift) — fresh CI runners eliminate this confound; uninstall-then-reinstall on the same runner catches it within a single job.

## What to ask the orchestrator

- If `install-smoke.yml` uses an action format that won't easily compose with macOS-runner-specific quirks (e.g., setup-node + brew install + xcode-select), post `### [T3] FINDING ...` and propose a refactor.
- If T1 ships uninstall before you reach Step 2, you can wire it in immediately. If T1 lands AFTER your initial pass, plan a small follow-up commit.
- If Phase B operator action stalls, post `### [T3] BLOCKED ...` and don't gate the lane on it indefinitely — Steps 1-3 are landable without active Phase B; only the green CI proof requires it.

## Out of T3 scope (do NOT touch)

- Uninstall CLI implementation (T1's lane).
- Migration tracking implementation (T2's lane).
- Wizard rewrite (Sprint 63).
- New fixture coverage of features not yet shipped (this sprint is install/uninstall correctness, not feature regression matrix).
