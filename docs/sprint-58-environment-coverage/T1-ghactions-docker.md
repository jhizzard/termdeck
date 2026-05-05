# T1 — GHACTIONS + DOCKER lane

**Role:** Claude worker, Sprint 58.
**Scope:** Pieces 1 + 2 of the catch-net — GitHub Actions install-into-clean-Ubuntu workflow + Multi-OS Docker matrix.

## Goal

Build the `.github/workflows/install-smoke.yml` workflow and the four Dockerfiles (Ubuntu 24, Fedora 41, Alpine 3.20, Debian 12) that together verify, on every push to `main` and every PR, that a fresh install of `@jhizzard/termdeck-stack` succeeds end-to-end on each target OS, and that `termdeck doctor` reports all probes GREEN.

## Pre-flight reads

1. `~/.claude/CLAUDE.md` (global rules — post-shape, no commits in lane, etc.)
2. `./CLAUDE.md` (project rules — no TypeScript, vanilla JS client, CommonJS server)
3. `docs/sprint-58-environment-coverage/PLANNING.md` (full sprint context)
4. `docs/sprint-58-environment-coverage/STATUS.md` (post shape + lane discipline)
5. `docs/RELEASE.md` (you are NOT publishing in this sprint, but the workflow must verify the same tarball-content invariants RELEASE.md mandates)
6. Existing `install.sh` and `scripts/sync-rumen-functions.sh` (any bashism here is an Alpine-fixture failure mode you'll catch)
7. T3's `docs/INSTALL-FIXTURES.md` (when T3 has it written) — your fixtures must satisfy the contract documented there

## Tasks

### Task 1.1 — `.github/workflows/install-smoke.yml`

Workflow triggers: `push` to `main` + `pull_request` to `main` + `workflow_dispatch` (manual fire).

Job: `install-smoke-ubuntu`. Single Ubuntu 24 runner. Steps:

1. Checkout the repo at the triggering ref.
2. Setup Node 20 (matches Brad's environment + matches our minimum).
3. Install the stack from the working tree (NOT from npm — we're testing this commit, not the previously-published version): `npm install -g .` from repo root, then `cd packages/stack-installer && npm install -g .`.
4. Write a `~/.termdeck/secrets.env` from CI secrets (`TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_DATABASE_URL`, plus dummy `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` for keys that init wizards may probe).
5. **Crucial — deliberately write `DATABASE_URL` with surrounding quotes** to reproduce Brad #2: `DATABASE_URL="${TEST_DATABASE_URL}"` with the literal double-quote chars in the file. The post-Sprint-59 audit-upgrade quote-strip should handle this; if Sprint 59 hasn't shipped yet, this step is allowed to fail and we mark the workflow `continue-on-error: true` for now (T4-CODEX will flag the gap explicitly).
6. Run `termdeck init --mnestra --yes` (non-interactive). Capture exit code; fail the job if non-zero.
7. Run `termdeck init --rumen --yes`. Capture exit code; fail if non-zero.
8. Run `termdeck doctor --json`. Parse output; fail the job if any probe is RED.
9. Run `mnestra doctor --json` (when present). Parse; fail on RED.
10. Cleanup step: reset the test schema in the test Supabase project (T3 provides the script; if T3 not done yet, delete the `test_run_${{ github.run_id }}` schema or truncate `public` tables with the standard reset).

Coordinate with T3 on the test Supabase secrets — T3 owns the secret-name canonicalization. Use whatever names T3 documents.

### Task 1.2 — Multi-OS Docker matrix

Add four Dockerfiles under `docker/`:

- **`docker/Dockerfile.ubuntu`** — `FROM ubuntu:24.04`. Installs Node 20 (NodeSource apt), git, build-essential, **does NOT install zsh** (this is the Brad #5 fixture). Runs the same install + init + doctor sequence as Task 1.1. Exits 0 on full success; non-zero on any failure.
- **`docker/Dockerfile.fedora`** — `FROM fedora:41`. Installs Node 20 via dnf. Same sequence. Catches dnf-vs-apt assumptions in any install scripts.
- **`docker/Dockerfile.alpine`** — `FROM alpine:3.20`. Installs Node 20 via apk, **uses ash not bash** (Alpine's default `/bin/sh` is busybox ash). This is the bashism-catching fixture. If `install.sh` has any bashism (`[[ ]]`, `<()` process substitution, `array=()`, etc.), this Dockerfile will fail.
- **`docker/Dockerfile.debian`** — `FROM debian:12`. Conservative enterprise target. Same sequence.

Each Dockerfile follows the same skeleton; T1's job is to make sure the differences (package manager, default shell, missing optional binaries) are handled correctly OR explicitly surface as failures so Sprint 59 can fix them.

Add a second job to `install-smoke.yml` — `install-smoke-matrix` — that runs each Dockerfile via `docker build .` in a `strategy.matrix.os: [ubuntu, fedora, alpine, debian]`. Builds in parallel.

### Task 1.3 — README badge + workflow status

Add a workflow-status badge to `README.md` near the top: `![Install Smoke](https://github.com/jhizzard/termdeck/workflows/install-smoke/badge.svg)`. So Joshua and any onlooker can see at a glance whether the latest commit's catch-net is green.

## Discipline (universal)

- **Post shape:** `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`.
- **Zero feature work.** If a fixture exposes a bug (e.g. install.sh has a bashism that breaks Alpine), DO NOT fix the bug in this lane. Post `### [T1] FINDING ...` describing the failure and the file:line where the fix would go; Sprint 59 fixes it. The Sprint 58 deliverable is "fixture exists and accurately reports RED" — making it GREEN is Sprint 59's job.
- **Stay in lane.** T2 owns systemd nightly + doctor probes; T3 owns Supabase secrets + docs. Cross-lane reads OK; cross-lane writes BANNED.
- **Append-only STATUS.md.**
- **Secrets handling:** never paste real secret values into workflow files. Always reference `${{ secrets.TEST_SUPABASE_URL }}` etc. T3 documents which secret names exist and what they contain.

## Coordination notes

- T3 owns the test Supabase project setup and the canonical secret names. Coordinate with T3's STATUS.md posts before referencing specific `secrets.*` names. If T3 hasn't posted those names yet, use placeholders `secrets.TEST_SUPABASE_URL_PLACEHOLDER` and post `### [T1] BLOCKED-ON-T3 ...`.
- T2's systemd nightly workflow is a separate file (`.github/workflows/systemd-nightly.yml`); your install-smoke workflow is a different file. No file collision expected.
- T4-CODEX will audit your fixtures against Brad's 9. Welcome the scrutiny — the goal of this sprint is "the catch-net catches the right things"; if T4 finds a gap, that's the value being delivered.

## Success criteria

1. `### [T1] FIX-LANDED` posts for Tasks 1.1 (workflow + Ubuntu job) and 1.2 (4 Dockerfiles + matrix job).
2. PR-triggered run of the new workflow against this commit shows the Ubuntu job passing AND at least one Dockerfile failing if a known Brad-class bug is present in HEAD (we WANT a failure if the bug is real — that proves the fixture catches it). T4-CODEX verifies.
3. README badge added.
4. `### [T1] DONE 2026-05-05 HH:MM ET` posted with summary of what shipped + which Brad findings the fixtures cover (cross-reference against T3's INSTALL-FIXTURES.md coverage matrix).
