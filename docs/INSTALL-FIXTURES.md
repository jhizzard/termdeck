# INSTALL-FIXTURES — TermDeck environment-coverage catch-net

**Status:** authored Sprint 58 (2026-05-05). Lives at `docs/INSTALL-FIXTURES.md`.

**Audience:** anyone touching CI workflow YAML, Dockerfiles, the systemd nightly, or the test Supabase project. Also: anyone triaging a new field-report bug — the question "is there a fixture gap?" lives here.

**Cross-references:**

- `docs/sprint-58-environment-coverage/PLANNING.md` — full sprint context and rationale ("Why this sprint exists").
- `docs/sprint-58-environment-coverage/T3-supabase-docs.md` — T3 lane brief (this doc's parent).
- `docs/sprint-58-environment-coverage/STATUS.md` § ORCH CLARIFICATION 16:21 ET — authoritative GATING-vs-REPRODUCER fixture mode taxonomy.
- `~/.claude/CLAUDE.md` § MANDATORY: Sprint role architecture — 3+1+1 pattern + auditor compaction-checkpoint discipline.
- `docs/INSTALLER-PITFALLS.md` — companion ledger of installer failure classes; this doc is the *prevention* layer, that doc is the *post-mortem* layer.

---

## 1. Why this exists

TermDeck's bug surface is shaped by environment, not by code review. Brad's 2026-05-05 nine-finding field report against `@jhizzard/termdeck@1.0.9` on Ubuntu 24 / Dell R730 / Node 20 / nohup launch path produced eight real engineering or docs gaps that no amount of in-sprint 3+1+1 audit could have caught — every bug only manifests in environments we don't run locally (Joshua develops on macOS; Brad runs Linux; CI is built only as the union of the two).

The catch-net is the closure of that gap. Sprint 58 builds the fixtures; **Sprint 59 ships the fixes against this catch-net**. From Sprint 59 onward, the rule is: a fix isn't done until the corresponding fixture flips from RED to GREEN.

Every future Brad-class report is triaged here first: *is there a fixture that should have caught this?* If no — that's a fixture gap; close it before writing the patch. If yes, but it didn't catch it — that's a fixture defect; fix the fixture and ALSO write the patch.

---

## 2. Two fixture modes — GATING vs REPRODUCER

(Authoritative source: `STATUS.md` § ORCH CLARIFICATION 2026-05-05 16:21 ET. Restated here for permanence.)

A naïve CI gate (`fail the build on any RED probe`) cannot coexist with an expected-RED reproducer fixture for a Sprint-59-pending bug. They are different jobs. The fixture set therefore has **two modes**, declared per coverage-matrix row.

### 2A. GATING fixture

Standard CI semantics: any RED fails the build. Used for happy-path probes that should ALWAYS be GREEN on a healthy install. If a GATING fixture flips RED, ship is blocked.

Workflow YAML shape: ordinary step, no `continue-on-error`. Exit-non-zero fails the job.

### 2B. REPRODUCER fixture

Marked `continue-on-error: true` in the workflow; output captured as a JSON artifact. A separate **meta-job** (`fixture-status-meta`, lives in `.github/workflows/install-smoke.yml`, owned by T1) reads each REPRODUCER artifact and asserts `actual_state == expected_state`. CI fails only on the meta-job mismatch — never on the reproducer's individual RED.

This is how a Sprint-58-built fixture for a Sprint-59-fix bug is allowed to be RED today (it correctly reproduces the bug) without breaking CI today.

When Sprint 59 ships the fix, the corresponding row's `expected-state` flips from `RED` to `GREEN`; the meta-job logic is unchanged.

### 2C. Coverage-matrix row schema

Every fixture in the coverage matrix declares these fields. `gating: true` means Mode A; `gating: false` means Mode B and the three reproducer fields below become required.

| Field | Required | Meaning |
|---|---|---|
| `mode` | yes | `GATING` or `REPRODUCER` |
| `fixture` | yes | The workflow / Dockerfile / script that runs the test (file path + line / step) |
| `os` | yes (where applicable) | `ubuntu-24`, `fedora-41`, `alpine-3.20`, `debian-12`, `hetzner-vm-systemd`, or `n/a` |
| `expected-state` | REPRODUCER only | `RED` (current Sprint 58 state) or `GREEN` (post-fix state) |
| `expected-red-until` | REPRODUCER only | Sprint that ships the fix (e.g. `Sprint 59`); becomes historical after flip |
| `proof-command` | REPRODUCER only | Exact shell command that produces parseable output proving RED/GREEN |

---

## 3. Coverage matrix — Brad's 9 findings

Each row maps a Brad finding to the fixture that catches it.

The "Source bug" column points at the LIVE code on `main` at Sprint-58 author time (`574c2eb` HEAD) — T4-CODEX should re-grep these on audit to verify the surfaces still exist where the matrix claims.

The "Fixture" column points at files T1 (`.github/workflows/install-smoke.yml`, `docker/Dockerfile.{ubuntu,fedora,alpine,debian}`) and T2 (`.github/workflows/systemd-nightly.yml`, `scripts/hetzner-systemd-smoke.sh`, `packages/cli/src/doctor.js`) ship in this sprint. T4-CODEX verifies fixture text by reading the workflow YAML / Dockerfile / script directly once T1/T2 land them.

**Proof-command exit-code convention:**

- **REPRODUCER** rows: exit 0 means the bug is present (matches `expected-state: RED`). Exit non-zero means no bug (would match `expected-state: GREEN` once Sprint 59 fixes land).
- **GATING** rows: exit 0 means the system is healthy (matches `expected-state: GREEN`). Exit non-zero means the gate has flipped RED — fail the build.

The meta-job (`fixture-status-meta`, § 4.6) compares actual to expected and fails CI on any mismatch — never on the proof-command's individual exit alone.

Proof-commands are best-effort empirical reproducers. Where Sprint 58's install-path catch-net cannot fully exercise a runtime path (e.g. Brad #8 requires a panel-spawn step that depends on Brad #7 being fixed first; full panel-spawn coverage is deferred to Sprint 60+ per § 12), the matrix row notes the partial nature explicitly.

| # | Finding | Severity | Mode | Fixture | OS | Source bug | Expected | Until | Proof-command |
|---|---------|----------|------|---------|----|----|-----|------|----|
| 1 | nohup secrets.env not propagating to `process.env` | HIGH | REPRODUCER | `.github/workflows/install-smoke.yml` step `nohup-process-env-probe` | `ubuntu-24` | secrets-env values not present in `process.env` of the nohup-detached server process when the parent shell didn't source `~/.termdeck/secrets.env` first (Sprint 51.5 SUPABASE_DB_URL fallback was Edge-Function-only; this is the host-process path) | RED | Sprint 59 | `unset DATABASE_URL && setsid nohup termdeck >/tmp/td.log 2>&1 & sleep 6 && PID=$(pgrep -f "node.*termdeck" \| head -1) && ! tr '\\0' '\\n' < /proc/$PID/environ \| grep -q '^DATABASE_URL='` (exit 0 = bug present: DATABASE_URL absent from server `process.env`; exit non-zero = no bug, env was inherited or auto-sourced) |
| 2 | Quoted `DATABASE_URL` breaks Node URL parser | MEDIUM | REPRODUCER | `.github/workflows/install-smoke.yml` step `quoted-database-url-probe` (Sprint 59 will identify the exact code path; current Sprint 58 fixture is approximate) | `ubuntu-24` | T4-CODEX 16:31 ET verified that on `574c2eb` baseline, both `packages/server/src/setup/dotenv-io.js:32-36` and `packages/server/src/config.js:45-49` already strip balanced single/double quotes. The bug surface is therefore **not** the dotenv file loader — it is a different path that uses `new URL()` on an unstripped value (likely `process.env.DATABASE_URL` set with literal quotes by the user's shell, or a non-dotenv code path that reads secrets directly). Exact path: TBD Sprint 59 root-cause | RED | Sprint 59 | `DATABASE_URL='"'"$TEST_DATABASE_URL"'"' termdeck doctor --json --no-update-check 2>/dev/null \| jq -e '(.schema.connectError != null) or (.schema.hasGaps == true)'` (exit 0 = bug present via `process.env` path; **note:** if doctor reads from `~/.termdeck/secrets.env` and ignores `process.env`, this proof returns false-GREEN — Sprint 59 root-cause investigation will refine the proof to target the actual failing path) |
| 3 | `pgbouncer=true` query param unrecognized by `psql` | LOW | (no fixture — docs only) | `docs/INSTALL.md` § Pooler URL note | n/a | psql ≥ 14 ignores unknown libpq params with a warning; cosmetic only | n/a | n/a | n/a |
| 4 | `search_memories` vs `memory_hybrid_search` drift | LOW (but doctor false-negative on every modern install) | **GATING** (after T2 Task 2.3 lands within Sprint 58) | `tests/doctor-rpc-version-gate.test.js` (unit) + `.github/workflows/install-smoke.yml` step `doctor-rpc-version-gate-integration` | `ubuntu-24` | `packages/cli/src/doctor.js:184-186` (post-fix; Mnestra-version-aware probe list) | GREEN | (n/a — fixed in Sprint 58) | `node --test tests/doctor-rpc-version-gate.test.js && termdeck doctor --json \| jq -e '.schema.hasGaps == false'` |
| 5 | Hardcoded `/bin/zsh` PTY fallback fatal on minimal Linux | MEDIUM | REPRODUCER | `docker/Dockerfile.alpine` (zsh not preinstalled) + `.github/workflows/install-smoke.yml` step `apt-remove-zsh-then-spawn` | `alpine-3.20` + `ubuntu-24` | `packages/server/src/index.js:958` — `(config.shell \|\| '/bin/zsh')` | RED | Sprint 59 | `apt-get remove -y zsh && termdeck >/tmp/td.log 2>&1 & sleep 5 && curl -sS -X POST localhost:3000/api/sessions -H 'content-type: application/json' -d '{}' \| jq -e '(.error // "") \| ascii_downcase \| contains("zsh") or contains("/bin/zsh") or contains("enoent")'` (exit 0 = bug surface reached: zsh fallback fired and failed) |
| 6 | `@anthropic-ai/claude-code` install needs `--include=optional` on Linux x64 | HIGH (Linux only) | REPRODUCER | `.github/workflows/install-smoke.yml` step `claude-code-availability-probe` | `ubuntu-24` | spawned panel cannot find `claude` binary because installer used npm config that suppressed optional deps | RED | Sprint 59 (docs) | `npm install -g @anthropic-ai/claude-code --omit=optional && ! command -v claude >/dev/null 2>&1` (exit 0 = bug present: claude binary missing post-install with `--omit=optional`) |
| 7 | Launcher exits 0 immediately under systemd `Type=simple` | BLOCKING | REPRODUCER | `.github/workflows/systemd-nightly.yml` + `scripts/hetzner-systemd-smoke.sh` | `hetzner-vm-systemd` (Ubuntu 24 / real systemd) | TTY check in launcher entry path returns false in non-interactive parent → graceful exit interpreted by systemd as success | RED | Sprint 59 (`--service` / `--non-interactive` flag) | `systemctl enable --now termdeck.service && sleep 30 && (! curl -sf -o /dev/null --max-time 5 http://localhost:3000/healthz)` (exit 0 = bug present: service "active" per systemd but no HTTP listener bound) |
| 8 | systemd doesn't inherit user PATH / `~/.bashrc` | HIGH | REPRODUCER | `.github/workflows/systemd-nightly.yml` extended panel-spawn step (after #7 fix lands) + `scripts/hetzner-systemd-smoke.sh` | `hetzner-vm-systemd` | `~/.npm-global/bin` absent from systemd-spawned shell PATH; spawned panels can't find `claude` | RED | Sprint 59 (docs + sample unit) | (gated on #7 fix — until then this proof is masked. Independent proof: `systemctl show termdeck.service --property=Environment \| grep -q '^Environment=$'` checks that no PATH= line is in the unit; combined with the journal grep `journalctl -u termdeck.service -n 500 \| grep -ciE 'command not found\|no such file\|claude.*not found'` for evidence of a panel-spawn that actually attempted to find `claude`. Full empirical reproducer requires a panel-spawn step which Sprint 60+ will add per the runtime-coverage gap deferral.) |
| 9 | Markdown auto-link wrapping in Brad's paste tooling | N/A | (no fixture) | n/a | n/a | reporter tooling — not TermDeck | n/a | n/a | n/a |

**Summary by mode:** 5 P0 findings (#1, #2, #4, #5, #7) all have fixtures. #4 is the only Sprint-58-internal fix (T2 Task 2.3) and ships GATING. The other four P0s are REPRODUCER, expected-red-until Sprint 59. #3 + #9 are out-of-fixture by design (docs / reporter tooling).

**T4-CODEX audit hooks:**

1. Each REPRODUCER row's `proof-command` should be runnable by a future T4 against pre-Sprint-58 HEAD and produce the claimed exit. Audit by execution where feasible.
2. Each GATING row should pass on a clean install and fail when the underlying source bug is reverted. Audit by reverting + re-running.
3. Any row whose `fixture` column references a file T1/T2 hasn't yet committed → flag as `FIXTURE-GAP` until landed.

---

## 4. Fixture descriptions

Each fixture's exit-code semantics, runner, and inputs.

### 4.1. `install-smoke-ubuntu` (T1)

- **Workflow:** `.github/workflows/install-smoke.yml` job `install-smoke-ubuntu`
- **Runner:** GitHub Actions `ubuntu-24.04` (or `ubuntu-latest` if 24.04 is the default at execution time)
- **Trigger:** `push` to `main`, `pull_request` to `main`, `workflow_dispatch`
- **Sequence:**
  1. Checkout
  2. Pre-step (host): `./scripts/test-supabase-reset.sh` — see § 7 for invariants
  3. Install Node 24 LTS (per Vercel platform default; TermDeck supports Node ≥ 20)
  4. `npm install -g .` (link to working tree for PR builds; published `@latest` for nightly main)
  5. Write `~/.termdeck/secrets.env` from `TEST_*` GitHub Actions secrets
  6. `termdeck init --mnestra --yes` — GATING
  7. `termdeck init --rumen --yes` — GATING
  8. `termdeck doctor --json` — GATING (post-fix for Brad #4)
  9. REPRODUCER sub-steps for #1, #2, #5 (apt-remove-zsh variant), #6 — `continue-on-error: true`, JSON artifacts emitted
- **Exit semantics:** the job step exits 0/1 normally. The meta-job (§ 4.6) is the authoritative gate.

### 4.2. `install-smoke-fedora` (T1)

- **Dockerfile:** `docker/Dockerfile.fedora` (Fedora 41 base, `dnf` package manager)
- **Workflow:** `.github/workflows/install-smoke.yml` matrix job `install-smoke-fedora`
- **Runner:** ubuntu-latest host runs `docker build` + `docker run`; install pass executes inside Fedora container
- **Trigger:** same as ubuntu
- **Sequence:** same install + init + doctor as ubuntu, but exposes any apt-vs-dnf assumptions in shell scripts (`install.sh`, `scripts/sync-rumen-functions.sh`, etc.)
- **Mode:** GATING for the install sequence on Fedora (no Brad finding is Fedora-specific). REPRODUCER sub-steps are Ubuntu-job-only.

### 4.3. `install-smoke-alpine` (T1)

- **Dockerfile:** `docker/Dockerfile.alpine` (Alpine 3.20 base, `apk` + busybox `ash`)
- **Workflow:** `.github/workflows/install-smoke.yml` matrix job `install-smoke-alpine`
- **Runner:** ubuntu-latest host runs `docker build` + `docker run`; install pass executes inside Alpine container
- **Mode:** REPRODUCER for Brad #5 (zsh not preinstalled by default — fatal on `(config.shell || '/bin/zsh')`); GATING for any other shell-portability gap (any unintentional bashism in `install.sh` or shipped scripts surfaces here as a FAIL because `ash` rejects `[[ ]]`, `<(...)`, `array=()`, `${var^^}`, etc.)
- **Bashism note:** `scripts/test-supabase-reset.sh` does NOT run inside the Alpine container. See § 7 for the host-only invariant. Alpine is meant to expose bashisms in TermDeck's *own* scripts (the surface a user would run on Alpine), not in our test harness.

### 4.4. `install-smoke-debian` (T1)

- **Dockerfile:** `docker/Dockerfile.debian` (Debian 12 base)
- **Workflow:** `.github/workflows/install-smoke.yml` matrix job `install-smoke-debian`
- **Mode:** GATING — the conservative "stable enterprise" target. No Brad finding is Debian-specific; Debian exists to catch any drift introduced by Ubuntu-only assumptions (e.g. snap-based binaries, ubuntu-only repo paths).

### 4.5. `systemd-nightly` (T2)

- **Workflow:** `.github/workflows/systemd-nightly.yml`
- **Trigger:** `schedule: cron '0 4 * * *'` (4am UTC) + `workflow_dispatch`
- **Runner:** GitHub Actions `ubuntu-latest` host; provisions a Hetzner Cloud CX22 VM via `hcloud` CLI; runs the test on the VM via SSH; tears down the VM in an always-run cleanup step.
- **Sequence:** see `scripts/hetzner-systemd-smoke.sh` once T2 lands it. Outline:
  1. `hcloud server create --type cx22 --image ubuntu-24.04 --ssh-key $HETZNER_SSH_KEY_NAME --name termdeck-systemd-smoke-$RUN_ID`
  2. SSH in; `git clone` TermDeck @ HEAD; `npm install -g .`
  3. Write `~/.termdeck/secrets.env` from `TEST_*` secrets
  4. Install `~/.config/systemd/user/termdeck.service` (Type=simple, no `Environment=PATH=` — deliberately reproduces #7 + #8)
  5. `systemctl --user enable --now termdeck.service`; `sleep 30`
  6. Three probes (REPRODUCER):
     - `systemctl --user is-active termdeck.service` → `RED` if `active`, but health probe fails (#7)
     - `curl -s localhost:3000/healthz` → `RED` if non-200 (#7 secondary signal)
     - `journalctl --user -u termdeck.service` grep for `claude: command not found` (#8)
  7. JSON output to artifact
  8. **Always-run cleanup:** `hcloud server delete termdeck-systemd-smoke-$RUN_ID` — even on probe failure, **never** orphan a VM (cost: €4.51/mo per orphan)
- **Mode:** REPRODUCER for #7 + #8; expected-red-until Sprint 59.

### 4.6. `fixture-status-meta` (T1)

- **Workflow:** `.github/workflows/install-smoke.yml` job `fixture-status-meta`
- **Runs after:** all install-smoke matrix REPRODUCER jobs **within the same workflow file** via `needs:`. GitHub Actions `needs:` cannot reach across workflow files (T4-CODEX FIXTURE-DRIFT 16:40 ET) — `systemd-nightly.yml` runs on its own schedule and reports separately via its own JSON artifact + run summary; it is **not** gated by `fixture-status-meta`. See `systemd-nightly` § 4.5 for that workflow's separate REPRODUCER status reporting.
- **Logic:** download all `fixture-status-*` JSON artifacts; assert the **complete expected set** is present (`brad-1-nohup-secrets`, `brad-2-quoted-database-url`, `brad-5-no-zsh-ubuntu`, `brad-5-alpine-bashism`, `brad-6-claude-code-optional`) — fail if any expected artifact is **missing** OR if any **unexpected** artifact name appears; only after set-completeness is verified, parse each JSON and assert `actual_state == expected_state`; emit summary report; fail the workflow run on any mismatch.
- **Why hard-code the expected set:** without explicit set-membership check, a reproducer job that skips, errors before artifact upload, or uploads under a typo'd name silently disappears from the gate — the meta-job validates the remaining artifacts and prints "ALL FIXTURES MATCH EXPECTED OUTCOMES" without noticing the missing Brad row (T4-CODEX FINDING 16:41 ET).
- **Exit semantics:** this job's exit code IS the workflow run's authoritative pass/fail signal **for install-smoke**. `systemd-nightly` is a parallel signal — when adding a new REPRODUCER, decide whether it lives in `install-smoke.yml` (gated by this meta-job) or `systemd-nightly.yml` (gated by its own artifact assertion); document the choice in the row's `fixture` column at § 3.

### 4.6.1. Cross-workflow REPRODUCER reporting (Brad #7 + #8)

Because `systemd-nightly.yml` is a separate workflow with a separate trigger (`schedule: cron '0 4 * * *'`), its REPRODUCER status (Brad #7 + #8) is reported via:

1. The workflow's **JSON artifact** uploaded with `if: always()` (`hetzner-systemd-smoke-report.json` per T2 Task 2.1).
2. The workflow's **GitHub Step Summary** dump that explains the pre-Sprint-59-RED-is-EXPECTED semantics so a failed nightly run is not misinterpreted as a regression.
3. (Sprint 60+ candidate) A scheduled meta-runner that reads the latest `systemd-nightly` artifact and posts its actual-vs-expected status to a shared dashboard. Out of Sprint 58 scope per § 12 deferral chain.

The pragmatic shape: `install-smoke` is the per-PR / per-push gate; `systemd-nightly` is the daily nightly gate. They report independently. CI does not fail a PR build because last night's systemd nightly was RED — that's the catch-net working as designed pre-Sprint-59.

### 4.7. `tests/doctor-rpc-version-gate.test.js` (T2)

- **Type:** unit test (`node --test`)
- **Mode:** GATING — must pass for the doctor fix to land in Sprint 58
- **Run on:** every install-smoke-ubuntu job, every PR, every push (this is plain `npm test`)

---

## 5. Canonical GitHub Actions secret names (Task 3.2)

These are locked at Sprint 58 open. T1 + T2 reference them verbatim in their workflow YAML; do not rename without coordinating across all three lanes.

| Secret name | Type | Used by | Purpose |
|---|---|---|---|
| `TEST_SUPABASE_URL` | string | T1 install-smoke (all OS) | Test project URL (e.g. `https://abcd1234.supabase.co`) |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | string (JWT) | T1, T2 | Service-role JWT for migrations + admin operations |
| `TEST_SUPABASE_ANON_KEY` | string (JWT) | T1 install-smoke | Anon JWT for client-shape probes |
| `TEST_DATABASE_URL` | string (psql conn string) | T1 reset-step, T2 systemd-smoke | Direct Postgres connection string (pooler URL with `pgbouncer=true&sslmode=require`) for `psql`-based reset operations |
| `TEST_ANTHROPIC_API_KEY` | string | T1, T2 | Dummy or limited-budget key — init wizards probe presence; tests never spend significantly |
| `TEST_OPENAI_API_KEY` | string | T1, T2 | Dummy or limited-budget key |
| `TEST_GEMINI_API_KEY` | string | T1, T2 | Dummy or limited-budget key |
| `HETZNER_API_TOKEN` | string | T2 systemd-nightly | Hetzner Cloud read-write token for VM provisioning + teardown |
| `HETZNER_SSH_KEY_NAME` | string | T2 systemd-nightly | Name of the SSH key uploaded to the Hetzner console; CLI uses this by name |
| `HETZNER_SSH_PRIVATE_KEY` | string (PEM block) | T2 systemd-nightly | Private key matching the Hetzner-uploaded public key; used by `ssh` for VM access during the smoke test |

**Naming convention:** all secrets are `TEST_*` (test-project) or `HETZNER_*` (Hetzner-specific). No bare `SUPABASE_URL` / `DATABASE_URL` to prevent collision with the real prod values that may exist in the org-level secret set.

**Rotation:** rotate `TEST_SUPABASE_SERVICE_ROLE_KEY` and `HETZNER_API_TOKEN` quarterly or on any suspected leak. The other secrets are lower-sensitivity (anon key is public-facing; SSH private key is project-test-only).

---

## 6. Test Supabase project setup runbook (Task 3.1 — orchestrator-coordinated)

This runbook is executed **once**, by the orchestrator, when the test project is first provisioned. T3 cannot do this lane-side because:

- It requires Supabase dashboard UI access (project creation requires an authenticated browser session — not lane-side automatable).
- It requires GitHub repo settings access (adding org/repo secrets requires write permission on the repo settings page, which is orchestrator-owned).

If the test project is ever lost (Supabase free-tier downgrade, accidental deletion, org migration, etc.), re-execute this runbook to re-provision.

### Step 6.1. Create the Supabase project

1. In the Supabase dashboard, in the same org as the daily-driver, click **New Project**.
2. **Name:** `termdeck-test`
3. **Region:** same as daily-driver (latency-equivalent CI runs)
4. **Plan:** Free (500 MB storage, 2-project limit per org — Sprint 58 author confirmed capacity exists; current usage is 1 project)
5. **Database password:** generate strong; store in 1Password or equivalent with name `Supabase termdeck-test DB password`
6. Click **Create new project**. Wait ~2 min for provisioning.
7. Once provisioned, capture from the dashboard:
   - **Project ref** (looks like `abcd1234efgh`) — visible in Settings → General → "Reference ID"
   - **Project URL** (looks like `https://abcd1234efgh.supabase.co`) — Settings → API → "Project URL"
   - **Anon key** — Settings → API → "anon public" key
   - **Service-role key** — Settings → API → "service_role secret" key (treat as password)
   - **Connection string** — Settings → Database → "Connection string" → "URI" tab. Copy the **Transaction Pooler** URL (port 6543, includes `pgbouncer=true&sslmode=require`)

### Step 6.2. Apply the bundled Mnestra migration suite

From a checkout of the TermDeck repo on a workstation with `psql` available:

```bash
export DATABASE_URL="<transaction-pooler-URL-from-step-6.1>"
for sql in packages/server/src/setup/mnestra-migrations/*.sql; do
  echo "Applying $sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$sql"
done
```

This applies all 18 migrations in order. Idempotent — safe to re-run.

### Step 6.3. Apply the bundled Rumen schema

```bash
export DATABASE_URL="<transaction-pooler-URL-from-step-6.1>"
for sql in packages/server/src/setup/rumen/migrations/*.sql; do
  echo "Applying $sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$sql"
done
```

Note: migrations 002 and 003 contain `<project-ref>` placeholders (templated for cron schedules). Apply them via `packages/server/src/setup/migration-templating.js` if you want full Rumen functionality on the test project. For the install-smoke fixture, plain pg-cron schedules are not required (the fixture exercises init wizards, not Rumen tick execution); minimal Rumen schema is sufficient.

### Step 6.4. Install the canary marker row

The reset script (§ 7) refuses to truncate any database that does not have this row. This is the primary safeguard against accidentally pointing `TEST_DATABASE_URL` at a developer's daily-driver project.

```bash
export DATABASE_URL="<transaction-pooler-URL-from-step-6.1>"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS _termdeck_test_canary (
  ref         TEXT PRIMARY KEY,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO _termdeck_test_canary (ref, note)
VALUES (
  'sprint-58-test-project',
  'Sprint 58 catch-net test project. scripts/test-supabase-reset.sh refuses to truncate without this row. See docs/INSTALL-FIXTURES.md § Test Supabase project runbook.'
)
ON CONFLICT (ref) DO NOTHING;
SQL
```

The canary row is **never truncated** by the reset script (it's not in the truncate list).

### Step 6.5. Add GitHub Actions repo secrets

In the TermDeck GitHub repo, **Settings → Secrets and variables → Actions → New repository secret**, add each of the 10 names from § 5. Use the values captured in step 6.1 plus the dummy/limited-budget keys for the AI providers and the Hetzner-specific values from the orchestrator's existing Hetzner Cloud account.

For `HETZNER_SSH_PRIVATE_KEY`: paste the full PEM block including the `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----` lines. GitHub Actions handles multi-line secret values correctly when entered via the dashboard.

### Step 6.6. Optional — Supabase CLI link state hygiene

If the orchestrator runs `supabase link` from `packages/stack-installer/` (e.g. to deploy Edge Functions for full Rumen support on the test project), the CLI writes state to `packages/stack-installer/supabase/.temp/` which is **not** covered by the root `.gitignore` rule on `supabase/.temp/` (T4-CODEX FINDING 16:16 ET).

To prevent accidental commit of project metadata, before linking either:

1. (preferred) Run `supabase link` from a directory outside the repo, or from the repo root only (where the `.gitignore` rule applies); OR
2. Add `**/supabase/.temp/` to the project root `.gitignore` (this would be a Sprint 59 housekeeping PR — out of Sprint 58 scope per the lane discipline rule "no source-code edits except T2 doctor probe")

Document the chosen path in the orchestrator post-execution report.

### Step 6.7. Verify

After all six prior steps, smoke-test the runbook from a clean shell:

```bash
export TEST_DATABASE_URL="<value from step 6.1>"
./scripts/test-supabase-reset.sh --dry-run
# Expected: prints SQL, exits 0

./scripts/test-supabase-reset.sh
# Expected: "[reset] HH:MM:SS test schema reset complete", exit 0

# Sanity-check the canary survived:
psql "$TEST_DATABASE_URL" -c "SELECT ref, note FROM _termdeck_test_canary"
# Expected: 1 row with ref='sprint-58-test-project'
```

If any step fails, the runbook has not completed. Do not consider Task 3.1 unblocked until § 6.7 verification passes.

---

## 7. `scripts/test-supabase-reset.sh` invariants (Task 3.3)

### 7.1. Host-only execution

The reset script runs on the **GitHub Actions runner host** (`ubuntu-latest`, bash 5+ pre-installed). It never runs inside a Dockerized container fixture, including the Alpine fixture (which uses `ash`).

This is intentional: the Alpine fixture exists to expose bashisms in **TermDeck's own scripts** (the surface a user would run on Alpine), not in our test harness. The reset script is harness, not surface.

T4-CODEX FINDING 2026-05-05 16:21 ET raised this concern; the resolution is documented here, not in the script's portability. Do not "fix" the script's bash shebang to POSIX `sh` without first removing this invariant from the doc — the bashism check is intentional in TermDeck source files, not in CI tooling.

### 7.2. Canary precheck

The script refuses to run unless `_termdeck_test_canary` contains a row with `ref='sprint-58-test-project'`. This is the primary safeguard against accidentally pointing `TEST_DATABASE_URL` at a developer's daily-driver project. The canary is installed once by the runbook (§ 6.4); no fixture re-installs it on every run.

`--skip-canary` exists for one-time setup paths (e.g. § 6.7 verification) where the canary table doesn't yet exist. **Never** use `--skip-canary` from CI workflow YAML.

### 7.3. Concurrency model

The reset transaction calls `pg_advisory_xact_lock(58)` — a transactional advisory lock that auto-releases at COMMIT. Concurrent invocations serialize on this lock. This is **defense-in-depth**, not the primary serialization.

Primary serialization is at the GitHub Actions workflow level. Both `install-smoke.yml` and `systemd-nightly.yml` should declare:

```yaml
concurrency:
  group: test-supabase-shared
  cancel-in-progress: false
```

This ensures only one workflow run holds the test project at any given time, which means tests never race on data state during a run (only the reset itself races — and the advisory lock catches that).

### 7.4. Truncate scope

The reset script's truncate list is exactly:

- Mnestra core (mig 001): `memory_items`, `memory_sessions`, `memory_relationships`
- Mnestra legacy RAG (mig 008, opt-in via `rag.enabled`): `mnestra_session_memory`, `mnestra_project_memory`, `mnestra_developer_memory`, `mnestra_commands`
- Rumen (rumen mig 001, opt-in via `init --rumen`): `rumen_jobs`, `rumen_insights`, `rumen_questions`

Missing tables are tolerated (`to_regclass` returns NULL → `EXECUTE` is skipped → logged). This handles partial-provisioning cases (e.g., test project initialized for Mnestra only).

The canary table `_termdeck_test_canary` is **never** in the truncate list. Sequences are reset (`RESTART IDENTITY`). FK dependents are cascaded (`CASCADE`).

### 7.5. Adding a new table

When a new Mnestra or Rumen migration adds a table, append it to the `tbls TEXT[]` array in the DO block. Order: FK-children before parents (CASCADE makes this an explicit-documentation choice rather than a correctness one, but keep the convention).

---

## 8. How to add a new OS to the Docker matrix

When TermDeck gets a field report from a new OS (RHEL 9, OpenSUSE Leap, FreeBSD, etc.):

1. **Triage** — is the bug OS-specific or universal? Check existing fixtures first; if Ubuntu+Fedora+Alpine+Debian don't catch it, the OS is genuinely novel.
2. **Add a Dockerfile.** Copy the closest existing fixture (e.g. `docker/Dockerfile.debian` for RHEL/CentOS-family, `docker/Dockerfile.fedora` for SUSE-family). Modify package-manager calls (`apt-get` → `dnf`, `dnf` → `zypper`, etc.). Avoid bashisms; the Alpine fixture is the canary for "would this break on a busybox shell?".
3. **Add to the matrix.** In `.github/workflows/install-smoke.yml`, add the new OS to the matrix.os list.
4. **Update the coverage matrix** (§ 3) — add a new row if the new OS catches a Brad finding none of the existing fixtures caught, or note the new OS as "additional GATING surface" in the existing row's `os` column.
5. **Update fixture descriptions** (§ 4) — add a § 4.X for the new fixture.

Cost: approximately +5 min build time per matrix cell. Free for public repos.

---

## 9. How to add a new test scenario

When a Brad-class field report comes in:

1. **Triage to fixture-gap-or-defect:**
   - Check § 3 — is there a row that should have caught this?
   - If yes → fixture defect. The fixture exists but didn't catch the bug. Audit why; fix the fixture; ALSO write the patch.
   - If no → fixture gap. Add a new row before writing the patch.
2. **For a fixture gap:**
   - Pick the fixture mode (GATING if the bug is universally bad and easy to detect; REPRODUCER if it's a known-bug-pending-fix scenario).
   - Add the row to § 3 with all required fields (see § 2C schema).
   - Implement the fixture step in the relevant workflow YAML (T1 owns install-smoke; T2 owns systemd-nightly; new fixtures live next to them).
   - For REPRODUCER: emit a JSON artifact and add the row to the meta-job's expected-state assertion list.
3. **Patch goes in the next sprint** — and only ships when the fixture flips from RED to GREEN.

This is the rule that prevents Brad-class bugs from regressing into the future: **a fix isn't done until the fixture turns GREEN**. The fixture is the canonical proof.

---

## 10. Local development loop (Multipass on macOS)

For fast iteration before pushing to CI, use Multipass to spin a local Ubuntu 24 VM on macOS:

```bash
brew install --cask multipass
multipass launch 24.04 --name termdeck-test --cpus 2 --memory 2G --disk 10G
multipass shell termdeck-test
# inside the VM:
sudo apt update && sudo apt install -y nodejs npm
git clone https://github.com/jhizzard/termdeck && cd termdeck
npm install -g .
# ... run install-smoke steps interactively
exit
# back on host:
multipass stop termdeck-test
multipass delete termdeck-test  # only when fully done
multipass purge
```

Cuts the CI feedback loop from ~5 min (push, wait for runner, wait for build) to ~30 sec (re-run a script in the persistent VM).

For Alpine: `multipass launch alpine` is not officially supported, but `docker run -it --rm alpine:3.20 sh` from a host shell achieves the same iteration loop for Alpine-specific bashism debugging.

For systemd: Multipass VMs run real systemd, so `--service` flag development can be done locally before pushing to the Hetzner nightly. Real systemd in a VM (Multipass) is functionally equivalent to real systemd on a Hetzner host for the bugs Sprint 58 catch-nets.

---

## 11. Cost projection

| Item | Frequency | Cost |
|---|---|---|
| GitHub Actions install-smoke (Ubuntu + 4-OS Docker matrix) | per push to `main` + per PR | Free (public repo, included in free tier) |
| GitHub Actions systemd-nightly (Hetzner provisioning step) | nightly | Free (single ubuntu-latest runner, ~10 min/run) |
| Hetzner CX22 VM (provisioned + torn down per nightly run) | nightly | ~€0.03/night × 30 = **€0.90/month** (per T2 16:20 ET projection) |
| Hetzner CX22 always-on alternative | (not recommended) | €4.51/month |
| Supabase free tier (test project) | continuous | **Free** (500 MB / 2-project limit; we use 1 of 2) |
| Test API budget (Anthropic + OpenAI + Gemini, dummy/limited keys) | per CI run | Negligible — wizards probe presence not usage; smoke tests do not invoke the LLMs |
| **Total operational cost** | monthly | **≈ €0.90 / mo + free tiers** |

If Supabase free tier becomes insufficient (project storage exceeds 500 MB), upgrading to **Pro** at $25/mo would cover both the daily-driver and the test project. Sprint 58 author estimate: 1+ year before this becomes necessary at current ingest rates.

---

## 12. Known coverage gaps (deferred to Sprint 60+)

Sprint 58's catch-net is **install-path coverage** — install, init wizards, doctor probes, schema verification, systemd unit launch. By design it does not exercise:

- Multi-session sprint inject path (`packages/server/src/sprint-inject.js`)
- WebSocket protocol parity (server emit + client handler — see `tests/ws-protocol-parity.test.js` for the existing unit-level coverage)
- Multi-panel runtime state (panel layout, focus, drag/drop, input routing)
- Sprint orchestration end-to-end (boot prompt → reasoning → STATUS.md write)

A regression in any of these surfaces would NOT be caught by Sprint 58's CI. (Source: `STATUS.md` § T4-CODEX COVERAGE-GAP 2026-05-05 16:23 ET — adversarial finding; § ORCH COVERAGE-GAP-ACK 2026-05-05 16:33 ET — orchestrator deferral.)

**Why deferred to Sprint 60+ rather than absorbed into Sprint 58:**

1. **Different fixture shape.** Install-path = boots from zero, ends in idle-with-doctor-green. Runtime-path = needs running server, simulated WebSocket clients, multi-panel state assertions, possibly Playwright in `--isolated` mode (per Sprint 57 #3 fix). That's a separate infrastructure stack.
2. **Brad's 9 findings are 100% install-path.** The catch-net is calibrated against the actual signal we have. The existing unit + integration test suite already covers the runtime paths we know about.
3. **The 3+1+1 audit pattern within sprints catches runtime regressions cheaply.** The catch-net Sprint 58 builds is for the bugs the 3+1+1 *can't* catch (environment-shape).
4. **Sprint 59 ships against Sprint 58's catch-net.** The compounding move is Sprint 58 → 59 → 60+ (runtime catch-net) → 61+ (runtime fixes against THAT catch-net). One sprint at a time.

**Sprint 60+ candidate, named for the deferral chain:** "Runtime / Inject / WebSocket Coverage Catch-Net Phase 2." Likely shape: per-PR Playwright `--isolated` job that boots a real TermDeck server, opens N panels, fires a sprint inject, waits for STATUS.md DONE posts, asserts panel state. Specs to be authored after Sprint 59 closes.

**Other known gaps the install-path catch-net does not cover (Sprint 60+ candidates):**

- **macOS install pass.** All Sprint 58 fixtures run on Linux. macOS-only regressions (e.g. brew vs apt, codesigning, launchd vs systemd) are out of scope for the GitHub Actions free-tier matrix. Mitigation: Joshua's daily-driver IS macOS, so most macOS regressions surface in dev-loop usage before they ship.
- **Windows / WSL.** Out of scope; TermDeck doesn't claim Windows support yet.
- **Network-degraded conditions.** Slow Supabase API, 503 from Anthropic, partial ANTHROPIC_API_KEY, etc. The `doctor` probe surface partially covers this, but no fixture deliberately injects network failures.
- **Multi-user concurrent install** (e.g. two users on the same Postgres project running `init --mnestra --yes` simultaneously). Mnestra migrations 015+ added explicit grants, but no fixture exercises the race.

When a future Brad-class report surfaces a bug in any of these surfaces, the triage flow (§ 9) applies: gap is closed before the patch ships.

---

## 13. Audit hooks for T4-CODEX

Sprint 58's coverage matrix is the contract document; every claim here is auditable. Suggested audit walk:

1. **Existence audit.** For each row in § 3, verify the `fixture` column points at a file that exists on `main` (or that the relevant lane has committed to author). FIXTURE-GAP if the file is absent at sprint close.
2. **Source-bug audit.** For each row's `Source bug` reference (e.g. `packages/server/src/index.js:958`), `grep` the file at the cited line and confirm the bug surface still matches the description. FIXTURE-DRIFT if the line has moved or the bug shape has changed.
3. **Proof-command audit.** For each REPRODUCER row, attempt to execute the `proof-command` against pre-Sprint-58 HEAD (e.g. `git checkout 574c2eb -- <file>; ./proof-command`) and confirm the claimed exit. PROOF-MISMATCH if the actual exit doesn't match expected.
4. **GATING-flip audit.** For the one Brad finding fixed in Sprint 58 (#4), confirm the GATING fixture passes on post-fix code AND fails on pre-fix code (revert T2's commit, re-run, expect RED). REGRESSION if it passes on pre-fix code (the fixture isn't actually checking what it claims).
5. **Mode-uniformity audit.** Sprint 58 fixtures REPORT bugs, they don't FIX them — except #4. If any other GATING fixture row is found in § 3 covering a known Sprint-59 bug, that's a SCOPE-CREEP signal.

Findings should be posted to `STATUS.md` as `### [T4-CODEX] FIXTURE-GAP` / `FIXTURE-DRIFT` / `COVERAGE-GAP` / `FIXTURE-VERIFIED` per the verb whitelist in `STATUS.md` § Lane post shape.
