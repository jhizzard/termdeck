# T2 — SYSTEMD + DOCTOR lane

**Role:** Claude worker, Sprint 58.
**Scope:** Pieces 3 + 5 of the catch-net — Hetzner nightly systemd VM smoke + Brad #4 version-gated doctor probes.

## Goal

Build the systemd-nightly Hetzner workflow that verifies TermDeck runs cleanly under real systemd (catching Brad #7 launcher exit-0 + Brad #8 PATH inheritance) AND ship the version-gated doctor probe fix that catches Brad #4 RPC-name drift between Mnestra ≤ 0.3.x (`search_memories`) and Mnestra ≥ 0.4.0 (`memory_hybrid_search`).

## Pre-flight reads

1. `~/.claude/CLAUDE.md` (global rules)
2. `./CLAUDE.md` (project rules — no TypeScript, vanilla JS client, CommonJS server)
3. `docs/sprint-58-environment-coverage/PLANNING.md`
4. `docs/sprint-58-environment-coverage/STATUS.md`
5. Existing TermDeck doctor implementation — grep for `search_memories` to find probe location (likely `packages/cli/src/doctor*.js` or `packages/server/src/doctor*.js`)
6. Mnestra version-detection options: `npm view @jhizzard/mnestra version`, or read installed mnestra package.json via `require.resolve`
7. Hetzner Cloud API docs: https://docs.hetzner.cloud/ (REST API + the `hcloud` CLI)
8. T1's `.github/workflows/install-smoke.yml` (you reuse the same TEST_SUPABASE_* secrets)

## Tasks

### Task 2.1 — `scripts/hetzner-systemd-smoke.sh`

A standalone shell script that:

1. Reads Hetzner API token from environment (`HETZNER_API_TOKEN`) — set as a GitHub Actions secret.
2. Provisions a Hetzner Cloud CX22 VM (Ubuntu 24, smallest tier ~€4.51/mo prorated to pennies if torn down quickly). Uses an SSH key uploaded to Hetzner once via console (key fingerprint stored as `HETZNER_SSH_KEY_NAME`).
3. Polls until VM is `running` and SSH-reachable (timeout 5 min).
4. SSHes in and runs the install-smoke sequence:
   - `apt update && apt install -y nodejs npm git curl` (and DELIBERATELY no zsh — Brad #5 fixture)
   - `npm install -g @jhizzard/termdeck-stack@latest`
   - Write `~/.termdeck/secrets.env` from CI-passed values (use scp + chmod 600)
   - `termdeck init --mnestra --yes`
   - `termdeck init --rumen --yes`
   - **Install systemd unit** (Brad #7 + #8 fixture — deliberately reproduces both bugs):
     ```ini
     [Unit]
     Description=TermDeck Multiplexer
     After=network.target

     [Service]
     Type=simple
     ExecStart=/usr/local/bin/termdeck
     EnvironmentFile=/home/test-user/.termdeck/secrets.env
     # NOTE: Environment=PATH= deliberately omitted (Brad #8 fixture).
     # Sprint 59 docs add the PATH= line. Until then this unit FAILS, which
     # is exactly the proof that the fixture catches Brad #7 + #8.
     Restart=on-failure

     [Install]
     WantedBy=multi-user.target
     ```
   - `systemctl enable --now termdeck.service`
   - Wait 30s.
   - `systemctl is-active termdeck.service` — expect `active (running)`. **Failure = Brad #7 reproduced.**
   - `curl -sf http://localhost:3000/healthz` — expect 200. **Failure = also Brad #7.**
   - `journalctl -u termdeck.service --no-pager -n 200 | grep -i "command not found\|claude"` — looking for Brad #8 evidence (claude-binary-not-in-PATH).
5. Capture all evidence into a structured JSON report on the VM.
6. SCP the report back to the runner.
7. **Always-run cleanup**: `hcloud server delete <vm-name>` even on failure (avoid orphaned billable VMs).
8. Exit 0 if all GREEN; exit 1 if any RED. JSON output for the workflow to parse.

The script must be idempotent (re-runnable) and verbose (every step logged with timestamps).

### Task 2.2 — `.github/workflows/systemd-nightly.yml`

Workflow triggers: `schedule: cron: '0 4 * * *'` (4am UTC = midnight ET) + `workflow_dispatch` (manual fire). NOT triggered on every push (too slow, too expensive for that cadence).

Job: `systemd-smoke`. Single Ubuntu runner. Steps:

1. Checkout repo.
2. Install `hcloud` CLI from the Hetzner GitHub releases.
3. Run `scripts/hetzner-systemd-smoke.sh` with secrets injected via env (`HETZNER_API_TOKEN`, `TEST_SUPABASE_*`, `HETZNER_SSH_PRIVATE_KEY`).
4. Parse the JSON report; fail the workflow if exit non-zero OR any check RED.
5. Always-run cleanup step: `hcloud server delete <vm-name>` (idempotent — fine if already deleted).
6. Post a summary comment to the most recent commit SHA OR to a tracking issue (orchestrator's call documented in T3's INSTALL-FIXTURES.md).

### Task 2.3 — Brad #4 version-gated doctor RPC probes

Locate the doctor RPC probe via `grep -rn "search_memories" packages/`. Current behavior: probes for `search_memories()`, reports RED if absent. Mnestra 0.4.0+ replaced it with `memory_hybrid_search()`, so doctor reports false-negative on every modern install.

**Fix:**

1. Add a small `getInstalledMnestraVersion()` helper. Try in order:
   - `require.resolve('@jhizzard/mnestra/package.json')` if mnestra is a runtime dep
   - Shell out to `npm view @jhizzard/mnestra version` (with timeout) if not
   - Fall back to `null` (probe both names — GREEN if either exists)
2. Update the probe with `semver.gte(version, '0.4.0')`:
   - ≥ 0.4.0 → probe `memory_hybrid_search()`
   - ≤ 0.3.x → probe `search_memories()`
   - unknown → probe both, GREEN if either exists
3. Add `tests/doctor-rpc-version-gate.test.js` covering all three branches:
   - Mnestra 0.4.3 + `memory_hybrid_search` exists, `search_memories` absent → GREEN (post-fix only)
   - Mnestra 0.3.5 + `search_memories` exists, `memory_hybrid_search` absent → GREEN (no regression)
   - Version detection fails + only `memory_hybrid_search` exists → GREEN (graceful)

The fix is small (~30 LOC + ~50 LOC tests). The catch-net value is in T1/T2's CI integration: T1's install-smoke against the test Supabase project will turn from RED to GREEN once this lands, providing empirical proof the fix actually closes Brad #4.

## Discipline (universal)

- **Post shape:** `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`.
- **Task 2.3 is the ONE allowed code-shipping task in this otherwise-infrastructure sprint.** Justified because it's a doctor-environment-drift bug (the exact class the catch-net is supposed to find), shipping it lets T1's install-smoke validate the catch-net empirically, and it's small/contained. Do not scope-creep beyond this.
- **Stay in lane.** T1 owns install-smoke + Docker matrix; T3 owns test Supabase + docs. Cross-lane reads OK; cross-lane writes BANNED.
- **Append-only STATUS.md.**
- **Hetzner cost discipline.** ALWAYS run the teardown step. Workflow MUST NOT exit without a `hcloud server delete` attempt. If teardown fails, post `### [T2] BLOCKED ...` with the orphaned VM ID so orchestrator can manually clean up. Cost projection: nightly run with full teardown ≈ €0.03 per night ≈ €1/month. Always-on alternative ≈ €4.51/month — discuss with T3 in INSTALL-FIXTURES.md before deciding.

## Coordination notes

- T1 reuses the same `TEST_SUPABASE_*` secrets you reference. Coordinate naming via T3's docs (T3 owns secret-name canonicalization).
- Hetzner SSH key + API token: orchestrator pre-provisions these once outside the sprint. Coordinate via STATUS.md `### [T2] BLOCKED-ON-ORCH ...` post if not yet provisioned at start.
- The systemd unit deliberately omits `Environment=PATH=` and uses `Type=simple` — this is the FIXTURE for Sprint 59. Sprint 58's job is "fixture exists and accurately reports RED on Brad #7 + #8." Sprint 59 ships `--service` flag + docs that turn the fixture GREEN.

## Success criteria

1. `### [T2] FIX-LANDED` posts for Tasks 2.1 (smoke script), 2.2 (workflow), 2.3 (doctor version-gate + tests).
2. Manual `workflow_dispatch` trigger of `systemd-nightly` provisions, runs, and tears down a Hetzner VM cleanly. JSON report captured.
3. The systemd unit currently FAILS the smoke (Brad #7 + #8 still present in HEAD pre-Sprint-59) — that's CORRECT and proves the fixture catches the right thing. T4-CODEX verifies via the structured JSON report.
4. `tests/doctor-rpc-version-gate.test.js` passes; doctor probe version-gates against installed Mnestra version.
5. T1's install-smoke against the test Supabase project reports doctor GREEN once Task 2.3 lands (was RED pre-fix). That's the integration proof.
6. `### [T2] DONE 2026-05-05 HH:MM ET` posted with summary + Hetzner cost projection.
