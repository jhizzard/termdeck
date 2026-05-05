# Sprint 58 — Environment Coverage Catch-Net

**Status:** Plan authored 2026-05-05 ~15:30 ET, immediately after Sprint 57 close (`@jhizzard/termdeck@1.0.12` + `@jhizzard/termdeck-stack@0.6.12` published, commit `574c2eb` on origin/main) and Brad's 9-finding field report against `@jhizzard/termdeck@1.0.9` + Mnestra 0.4.0 + rumen 0.4.4 on Ubuntu 24 / Dell PowerEdge R730 / Node 20.

**Pattern:** 3+1+1 (T1/T2/T3 Claude workers + T4 Codex auditor + orchestrator). Pure infrastructure sprint — **zero feature work**, zero user-facing behavior changes. The sprint exists to build the test-environment coverage that catches Brad-class bugs *before* Brad finds them.

**Wall-clock estimate:** 4-6 hours. Most of the work is GitHub Actions YAML + Dockerfiles + a Hetzner VM provisioning script — well-trodden territory, low-risk per-line. The risk is in the *integration* (does the catch-net actually catch what we claim it catches), which is what T4-CODEX adversarial audit verifies.

**Target ship:** No npm publish. The deliverable is `.github/workflows/` + `docker/` + `scripts/` + `docs/INSTALL-FIXTURES.md` checked in to TermDeck. Future releases get gated on the new CI passing; that's the user-visible effect.

## Why this sprint exists

Sprint 57 ship was clean — three lanes DONE in ~50 min, T4-CODEX caught 5 in-flight regressions before they shipped. That's the 3+1+1 pattern working as designed for *shared LLM blind spots within a sprint*.

It is structurally incapable of catching environment-shape bugs. Brad's 9 findings on `@jhizzard/termdeck@1.0.9`:

- **#5** hardcoded `/bin/zsh` fallback at `packages/server/src/index.js:938` — fatal on minimal Linux without zsh installed; invisible on macOS where zsh is universal.
- **#7** launcher exits 0 immediately under `systemd Type=simple` — TTY check fails in non-interactive parent, no one on this team runs systemd day-to-day.
- **#6** `@anthropic-ai/claude-code` install needs `--include=optional` on Linux x64 — npm config quirk that doesn't fire on macOS.
- **#4** `termdeck doctor` probes for `search_memories()` but Mnestra 0.4.0+ replaced it with `memory_hybrid_search()` — version-drift bug, affects all current users with Mnestra ≥ 0.4.0.
- **#2** `DATABASE_URL` with surrounding quotes breaks Node URL parser — Brad's secrets.env had quoted value, our pg loader strips, Node URL constructor doesn't.
- **#1** `nohup` not inheriting secrets.env into `process.env` for direct-process.env probes (despite the Sprint 51.5 SUPABASE_DB_URL fallback for the Edge Function path) — distinct second-order bug the prior fix didn't cover.
- **#8** systemd doesn't inherit user PATH / `~/.bashrc` — `~/.npm-global/bin` missing from PATH, our spawned `claude` panels can't find the binary.
- **#3** `pgbouncer=true` query param unrecognized by `psql` — cosmetic but confusing during debug.
- **#9** Brad's own paste-pipeline issue (markdown auto-link wrapping) — N/A, reporter tooling.

8 of the 9 are real engineering or docs gaps. Five are P0 (#1, #2, #4, #5, #7). All eight share one shape: **they only manifest in environments we don't run locally**.

No code review catches them. No 3+1+1 audit catches them. Only running the code in the right environment catches them. We've built TermDeck on a single dev environment (Joshua's macOS); Brad is our entire long tail of one. Until we have automated coverage of the environments we don't live in, every Brad install will keep finding the same shape of bug.

Sprint 58 is the catch-net.

## Six pieces

### 1. GitHub Actions install-into-clean-Ubuntu CI step

On every push to `main` and every PR: spin Ubuntu 24 runner, `npm install -g @jhizzard/termdeck-stack@latest` (or `link:` to the working tree for PR builds), run init wizards in `--yes` mode against the dedicated **test Supabase project** (see piece #4), run `termdeck doctor`, fail the build on any RED probe.

**Catches at minimum:** Brad #5 (zsh fallback fatal — Ubuntu 24 has zsh by default but `apt remove zsh` in the workflow exposes it), #6 (claude-code optional dep — runner npm config will reproduce), #2 (quoted DATABASE_URL in `~/.termdeck/secrets.env` — workflow can deliberately write quoted values), and any future Linux-environment regression we don't anticipate.

**Cost:** Free for public repos. Build time ~5-8 min per run.

### 2. Multi-OS Docker matrix

Dockerfiles for Ubuntu 24, Fedora 41, Alpine 3.20, Debian 12. Each Dockerfile installs the stack and runs the `--yes` init pass, exits 0 on success, 1 on any failure. Run as a GitHub Actions matrix job (4 jobs in parallel).

Alpine especially valuable — `/bin/bash` not present by default; exposes any unintentional bashism in scripts. Fedora exposes any apt-vs-dnf assumptions. Debian 12 is the conservative "what runs in stable enterprise" target.

**Catches at minimum:** all OS-specific assumptions in shell scripts (`scripts/sync-rumen-functions.sh`, `install.sh`, etc.), the same Brad-class bugs as #1 but in non-Ubuntu Linux variants, plus distro-specific package-manager quirks.

**Cost:** Free for public repos. Build time ~10-15 min for the matrix (parallelized).

### 3. Real-VM nightly smoke for systemd

GitHub Actions Linux runners are containers — they don't run systemd properly. For Brad #7 (launcher exits 0 under `Type=simple`) and #8 (PATH inheritance under `EnvironmentFile=`), need an actual VM with real systemd.

**Provision:** one Hetzner Cloud CX22 (~€4.51/month) running Ubuntu 24, idle most of the time. A nightly GitHub Actions job uses the Hetzner API to:
1. SSH into the existing VM (or `hcloud server power on` if we tear down between runs to save cost)
2. `git pull` latest TermDeck → `npm install -g .`
3. Write a sample `~/.termdeck/secrets.env` from CI secrets
4. Install the prepared `termdeck.service` systemd unit; `systemctl --user enable --now termdeck.service`
5. Wait 30s, check `systemctl --user status termdeck.service` is `active (running)` AND `curl localhost:3000/healthz` returns 200
6. Tear down or stop, post pass/fail

**Alternative if Hetzner setup feels heavy:** DigitalOcean droplet at $4/month, similar API. Or **Multipass on Joshua's Mac** for local dev iteration — `multipass launch 24.04 --name termdeck-test`, ssh in, run the same script. Multipass is free + instant and serves as the dev-loop tool while CI uses Hetzner for the canonical nightly.

**Catches at minimum:** Brad #7 (launcher exits 0), #8 (PATH inheritance), any future systemd-specific regression.

**Cost:** ~€5-10/month operational if we keep one VM always-on; pennies per spin-up-and-tear-down if we use the API to provision-on-demand. Build time ~3-5 min per nightly run.

### 4. Shared test Supabase project

**One dedicated test project** (NOT the daily-driver). Free Supabase tier (500MB, 2 project limit on free) is sufficient — test data volumes are small.

Each test run creates an ephemeral schema (`test_run_<github_run_id>`) or fully resets the `public` schema between runs. Service-role key + anon key + project URL stored in GitHub Actions secrets (`TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`).

**Why one shared project, not per-VM:** spinning a Supabase project per test run is slow (~2 min provisioning) and burns the free-tier project limit. One shared project + ephemeral schemas isolates test runs without the provisioning tax. Concurrency: GitHub Actions matrix jobs would race on the schema; either lock via `pg_advisory_lock` at the start of the test run, or use unique-per-job schema names (`test_run_${{ github.run_id }}_${{ matrix.os }}`).

Decouples test data from production data — no risk of test runs polluting Joshua's Mnestra memories.

### 5. Version-gated doctor probes

Brad #4 — `termdeck doctor` probes for `search_memories()` (Mnestra ≤ 0.3.x function name) but Mnestra 0.4.0+ replaced it with `memory_hybrid_search()`. Doctor reports false-negative on every modern install.

**Fix:** doctor's RPC-presence probe takes a Mnestra-version-aware list. If `npm view @jhizzard/mnestra version` (or the installed mnestra package.json) reports ≥ 0.4.0, probe for `memory_hybrid_search`; else probe for `search_memories`. Probably 30 LOC + a small unit test.

This is a **Sprint 58 inclusion** because it's a doctor-environment-drift bug — exactly the class of bug the catch-net is supposed to find. Including it here lets us validate the catch-net's CI step would have caught it (run doctor against a fresh install on the test Supabase project; pre-fix doctor reports RED on `search_memories`; post-fix reports GREEN; CI passes only post-fix).

### 6. `docs/INSTALL-FIXTURES.md`

Documents what each fixture covers, how to add a new OS or scenario, and the contract every fixture must satisfy (boots from absolute zero install state, runs init `--yes`, runs doctor, exits 0 if and only if all probes are GREEN).

The doc's secondary purpose: **future Brad-class reports get triaged into "is there a fixture gap?"** Each report becomes a fixture-addition PR rather than a one-off bug fix. Over time the catch-net grows in coverage as the user base grows in environment diversity.

Sections:
- Coverage matrix (which Brad finding is caught by which fixture)
- How to add a new OS to the Docker matrix
- How to add a new test scenario (e.g. "systemd with custom PATH")
- Test Supabase project setup runbook (for orchestrator handoff)
- Local development loop (Multipass on Mac for fast iteration before pushing to CI)

## Lane carve (3+1+1)

| Lane | Scope | Files |
|---|---|---|
| **T1 GHACTIONS+DOCKER** | Pieces 1 + 2: GitHub Actions install-into-clean-Ubuntu workflow + Multi-OS Docker matrix (Ubuntu 24, Fedora 41, Alpine 3.20, Debian 12). | `.github/workflows/install-smoke.yml`, `docker/Dockerfile.{ubuntu,fedora,alpine,debian}` |
| **T2 SYSTEMD+DOCTOR** | Pieces 3 + 5: Hetzner nightly systemd VM smoke (provisioning script + nightly workflow) + Brad #4 version-gated doctor probes. | `.github/workflows/systemd-nightly.yml`, `scripts/hetzner-systemd-smoke.sh`, `packages/cli/src/doctor*.js` (or wherever the RPC probe lives), `tests/doctor-rpc-version-gate.test.js` |
| **T3 SUPABASE+DOCS** | Pieces 4 + 6: shared test Supabase project setup (ephemeral schema scaffolding, GitHub secrets wiring runbook, service-role key handling) + `docs/INSTALL-FIXTURES.md`. | `scripts/test-supabase-reset.sh`, `docs/INSTALL-FIXTURES.md`, secrets-runbook section in T3 lane brief |
| **T4-CODEX AUDITOR** | Adversarial audit: does the catch-net actually catch each of Brad's 9 findings? File:line evidence per finding showing which fixture would have caught it pre-Sprint-57. Coverage matrix verification against T3's INSTALL-FIXTURES.md doc. | (read-only across all the above) |

## Discipline (universal — applies to every lane)

1. **No feature work.** If a lane finds itself touching `packages/server/src/`, `packages/cli/src/` (except for piece #5's doctor probe), or `packages/client/`, it has scope-crept. Stop, post `### [T<n>] SCOPE-CHECK ...` and check with orchestrator before continuing.
2. **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`. Orchestrator handles close.
3. **Stay in lane.** Cross-lane reads OK. Cross-lane writes BANNED.
4. **Append-only STATUS.md.**
5. **Post shape:** `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory; T4 = `### [T4-CODEX]`).
6. **Verb whitelist:** BOOT, FINDING, FIX-PROPOSED, FIX-LANDED, DONE, BLOCKED, CHECKPOINT (T4 only — every phase boundary AND every 15 min).

## Acceptance criteria

1. Pushing to a test branch triggers the new GitHub Actions workflow; all 4 OS-matrix jobs pass against the test Supabase project.
2. The new systemd-nightly Hetzner workflow provisions, runs, and tears down cleanly; reports `active (running)` post-install.
3. Doctor probe version-gates correctly: against Mnestra ≥ 0.4.0 it probes `memory_hybrid_search` and reports GREEN; against ≤ 0.3.x it probes `search_memories` and reports GREEN; both are unit-tested.
4. `docs/INSTALL-FIXTURES.md` includes a coverage matrix mapping each of Brad's 9 findings to the fixture that would have caught it.
5. T4-CODEX final post: GREEN verdict on the catch-net's coverage of Brad's 5 P0 findings (#1, #2, #4, #5, #7). RED if any P0 finding has no fixture that would have caught it pre-ship.

## Out-of-Sprint-58 scope (Sprint 59 candidates)

Sprint 59 = **Brad bug fixes against the new catch-net.**

- **#1** nohup secrets.env not propagating to process.env (HIGH, distinct from Sprint 51.5 fix)
- **#2** DATABASE_URL quote-strip in init wizard write-out + audit-upgrade verification
- **#5** PTY shell fallback chain hardening (`cmdTrim || config.shell || process.env.SHELL || '/bin/sh'`)
- **#7** Launcher `--service` / `--non-interactive` flag that skips TTY check
- **Brad #6 docs** in install guide (`--include=optional` for Linux x64)
- **Brad #8 docs** systemd unit example with `Environment=PATH=` line

Sprint 59 lane discipline: every fix must turn the corresponding Sprint 58 fixture from RED to GREEN. **If the fix doesn't make the fixture turn green, the fix isn't done.** This is the mechanism that prevents Brad-class bugs from regressing into the future.

## Out-of-Sprint-58-and-Sprint-59 scope (Sprint 60+)

- Sprint 51 cost-monitoring expandable dashboard panel (deferred since Sprint 51.x)
- Auto-upgrade strategy for users on stale TermDeck installs (Sprint 57 #8 deferral)
- Cross-doctor coverage gap (`--full` flag or sibling note) — Sprint 57 #9 deferral
- Push Sprint 56 env-var override gates upstream to the rumen repo source so future syncs don't reset them (Sprint 57 deferral; resolved by either upstream PR or by documenting the divergence in `scripts/sync-rumen-functions.sh`)
- Rumen drain-stall root cause investigation (currently mitigated by `RUMEN_MAX_SESSIONS_OVERRIDE=10` — works, but the underlying Edge-Function-wall-clock-vs-batch-size relationship deserves canonization)

## Cross-references

- Brad's 2026-05-05 v1.0.9 + Mnestra 0.4.0 + rumen 0.4.4 field report: 9 findings on Ubuntu 24 / Dell R730 / Node 20 / nohup launch path; full text relayed mid-Sprint-57 close.
- Sprint 57 close + Brad-context note: `CHANGELOG.md` § [1.0.12] Notes
- Sprint 57 SCOPE-NARROW pattern (orchestrator vs PLANNING.md staleness): `docs/sprint-57-cleanup-and-deferrals/STATUS.md` § ORCH SCOPE-NARROW + ORCH CLARIFICATION
- 3+1+1 pattern + post-shape uniformity + auditor compaction-checkpoint: `~/.claude/CLAUDE.md` § MANDATORY: Sprint role architecture
- Release procedure: `docs/RELEASE.md` (no publish for Sprint 58 since no user-visible behavior changes; verify via "no `package.json` version field touched in this sprint's diff")
