# CI secret re-provisioning runbook

**Authored:** 2026-05-17, Sprint 66 (T3 — CI reliability).
**Audience:** the maintainer restoring real integration coverage to the three
secret-gated workflows.

---

## Why this document exists

Three GitHub Actions workflows run real integration tests against live
infrastructure:

| Workflow | What it exercises |
|----------|-------------------|
| `install-smoke.yml` | Clean install + uninstall/reinstall on Ubuntu, plus Docker fixtures (Fedora/Debian/Alpine) and the Brad-finding reproducers. |
| `macos-install-smoke.yml` | The same clean-install / uninstall / reinstall cycle on macOS 14. |
| `systemd-nightly.yml` | Nightly Hetzner CX22 VM provision → install → `systemd Type=simple` + PATH fixture (Brad #7/#8). |

All three need GitHub Actions **secrets** that are **not currently
configured** (`gh secret list --repo jhizzard/termdeck` returns empty). As of
Sprint 66 each workflow has a **`preflight` job** that detects this and gates
every downstream job **skip-neutral** — the workflow run is green, not red,
and the Actions tab shows the jobs as `skipped` rather than `failed`.

**Skip-neutral is a holding pattern, not a fix.** While the secrets are
absent these workflows verify nothing. This runbook restores them.

> **Skipping is only ever caused by absent secrets.** Once the secrets below
> are set, `preflight` flips `secrets_present` to `true`, every job runs in
> full, and a genuine install regression fails the build **red** again. The
> preflight gate only ever *skips* jobs — it never converts a failure into a
> pass. See [Appendix A](#appendix-a--how-the-skip-neutral-gate-works).

---

## The secret inventory

Nine repository-level Actions secrets, in two groups. `preflight` requires
**all** the secrets a given workflow consumes — a partial set still
skip-neutrals (a partial set would otherwise abort mid-run).

### Group 1 — dedicated test Supabase project + API keys

| Secret | Used by | What it is |
|--------|---------|------------|
| `TEST_SUPABASE_URL` | install-smoke, macos, systemd | `https://<test-project-ref>.supabase.co` of the **dedicated test** Supabase project. |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | install-smoke, macos, systemd | The test project's `service_role` key. |
| `TEST_SUPABASE_ANON_KEY` | install-smoke, macos | The test project's `anon` / publishable key. (systemd-nightly does not use it.) |
| `TEST_DATABASE_URL` | install-smoke, macos, systemd | Postgres connection string for the **test** project. The reset script **refuses a generic `DATABASE_URL`** — see step 1. |
| `TEST_ANTHROPIC_API_KEY` | install-smoke, macos, systemd | An Anthropic API key. A low-spend / test key is fine. |
| `TEST_OPENAI_API_KEY` | install-smoke, macos, systemd | An OpenAI API key. A low-spend / test key is fine. |

### Group 2 — Hetzner Cloud (systemd-nightly only)

| Secret | Used by | What it is |
|--------|---------|------------|
| `HETZNER_API_TOKEN` | systemd | A Hetzner Cloud API token (read+write) for a **throwaway** Hetzner project. Used to create and delete the nightly CX22 VM. |
| `HETZNER_SSH_KEY_NAME` | systemd | The name of an SSH key uploaded to that Hetzner project. |
| `HETZNER_SSH_PRIVATE_KEY` | systemd | The matching SSH **private** key (PEM), so the runner can SSH into the provisioned VM. |

---

## Step 1 — Provision a dedicated *throwaway* test Supabase project

> ⚠ **Do NOT point `TEST_DATABASE_URL` at any project that holds real data.**
> `scripts/test-supabase-reset.sh` `TRUNCATE`s the Mnestra/Rumen tables
> between fixture runs. It deliberately **refuses to fall back to a generic
> `DATABASE_URL`** and **refuses to truncate** any database that does not
> carry the test-project canary row (exit code 3). That refusal is the safety
> interlock — honour it by using a brand-new, empty project.

1. Create a **new** Supabase project dedicated to CI. It exists only to be
   truncated; it holds no real data and is not a developer's daily driver.
2. From the project's **API settings**, collect:
   - Project URL → `TEST_SUPABASE_URL`
   - `service_role` key → `TEST_SUPABASE_SERVICE_ROLE_KEY`
   - `anon` key → `TEST_SUPABASE_ANON_KEY`
3. From **Database settings**, collect the Postgres connection string →
   `TEST_DATABASE_URL`. Either the pooled or the direct string works; the
   reset script connects with `psql`.

## Step 2 — Seed the test-project canary

`scripts/test-supabase-reset.sh` will not truncate a database unless it finds
a row in `_termdeck_test_canary` with `ref = 'sprint-58-test-project'`. This
is what prevents a mistyped `TEST_DATABASE_URL` from wiping a real project.

Run the canary DDL + seed once, against the new project, following
**`docs/INSTALL-FIXTURES.md` § Test Supabase project runbook** (it carries the
exact `CREATE TABLE _termdeck_test_canary` + `INSERT` statements). Verify:

```bash
psql "$TEST_DATABASE_URL" -c "SELECT ref FROM _termdeck_test_canary"
# expect a row: sprint-58-test-project
```

If the canary is missing, every fixture run aborts at the reset step with
`FATAL: canary precheck failed` — that is the interlock working, not a bug.

## Step 3 — (systemd-nightly only) Provision Hetzner

1. In the [Hetzner Cloud console](https://console.hetzner.cloud/), create a
   **throwaway project** for CI.
2. Project → **Security → API tokens** → generate a **Read & Write** token →
   `HETZNER_API_TOKEN`.
3. Generate an SSH keypair for CI and upload the **public** key to the Hetzner
   project (Security → SSH keys):

   ```bash
   ssh-keygen -t ed25519 -f ./termdeck-ci-hetzner -C "termdeck-ci" -N ""
   # upload ./termdeck-ci-hetzner.pub to Hetzner; give it a name, e.g. "termdeck-ci"
   ```

   - The name you give it in Hetzner → `HETZNER_SSH_KEY_NAME`
   - The contents of the **private** key file `./termdeck-ci-hetzner` →
     `HETZNER_SSH_PRIVATE_KEY`

   The smoke run costs ≈ €0.03/night (CX22, deleted on every exit path); the
   nightly's belt-and-suspenders teardown force-deletes any orphan VM.

## Step 4 — Set the GitHub Actions secrets

Repository-level secrets on `jhizzard/termdeck`, via the `gh` CLI. Each
`gh secret set NAME` prompts for the value (it is not echoed):

```bash
# Group 1 — test Supabase project + API keys
gh secret set TEST_SUPABASE_URL              --repo jhizzard/termdeck
gh secret set TEST_SUPABASE_SERVICE_ROLE_KEY --repo jhizzard/termdeck
gh secret set TEST_SUPABASE_ANON_KEY         --repo jhizzard/termdeck
gh secret set TEST_DATABASE_URL              --repo jhizzard/termdeck
gh secret set TEST_ANTHROPIC_API_KEY         --repo jhizzard/termdeck
gh secret set TEST_OPENAI_API_KEY            --repo jhizzard/termdeck

# Group 2 — Hetzner (systemd-nightly)
gh secret set HETZNER_API_TOKEN              --repo jhizzard/termdeck
gh secret set HETZNER_SSH_KEY_NAME           --repo jhizzard/termdeck

# The SSH private key is multi-line — pipe the file rather than typing it:
gh secret set HETZNER_SSH_PRIVATE_KEY --repo jhizzard/termdeck < ./termdeck-ci-hetzner
```

Then delete the local private key file — GitHub now holds it:

```bash
rm -f ./termdeck-ci-hetzner ./termdeck-ci-hetzner.pub
```

Confirm all nine are set:

```bash
gh secret list --repo jhizzard/termdeck
```

## Step 5 — Verify the workflows run in full

Trigger each workflow manually and confirm `preflight` now reports
`secrets_present=true` and the downstream jobs **run** (not skip):

```bash
gh workflow run install-smoke.yml       --repo jhizzard/termdeck
gh workflow run macos-install-smoke.yml --repo jhizzard/termdeck
gh workflow run systemd-nightly.yml     --repo jhizzard/termdeck --field reason="secret re-provisioning verification"

# watch the most recent run of each
gh run watch --repo jhizzard/termdeck
```

In each run, the `preflight` job's **summary** should read
**"running (all required secrets present)"**, and the integration jobs should
execute rather than show `skipped`. A genuine install failure will now fail
the run red — which is the point.

---

## Appendix A — how the skip-neutral gate works

Each of the three workflows has a first job, `preflight`, that reads the
required secrets into step `env:` and checks every one is non-empty:

- **All present** → it sets the job output `secrets_present=true`.
- **Any absent** → `secrets_present=false`, and it writes a
  "skipped — credentials not configured" note to the run summary.

Every other job carries:

```yaml
needs: preflight
if: needs.preflight.outputs.secrets_present == 'true'
```

When `secrets_present` is `false` the `if:` is false and the job is
**skipped** — GitHub renders skipped jobs as neutral, and a run whose jobs are
all `success` or `skipped` concludes **`success`**. So an unprovisioned repo
shows green, not red.

`install-smoke.yml`'s `fixture-status-meta` additionally keeps `always()` so a
`continue-on-error` reproducer failure does not skip the meta-check — but it is
still gated on `secrets_present` (`if: always() && needs.preflight.outputs.secrets_present == 'true'`),
because with no secrets there are no fixture artifacts to meta-check.

**The invariant:** the gate only ever *skips* jobs. It adds no `|| true` and
no `continue-on-error`. With the secrets present, every `if:` is true, every
job runs unchanged, and a real regression fails the build red exactly as
before.

## Appendix B — cross-references

- Canary table DDL + seed: `docs/INSTALL-FIXTURES.md` § Test Supabase project runbook
- Reset script (canary interlock, exit codes): `scripts/test-supabase-reset.sh`
- Hetzner smoke script: `scripts/hetzner-systemd-smoke.sh`
- Sprint 66 plan: `docs/sprint-66-public-scrutiny-cleanup/PLANNING.md`
