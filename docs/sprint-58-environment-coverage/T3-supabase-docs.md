# T3 — SUPABASE FIXTURES + DOCS lane

**Role:** Claude worker, Sprint 58.
**Scope:** Pieces 4 + 6 of the catch-net — shared test Supabase project setup + `docs/INSTALL-FIXTURES.md`.

## Goal

Stand up the dedicated test Supabase project (separate from the daily-driver), document the secret-name canonicalization that T1 + T2 reference, write the schema-reset scripting, and author `docs/INSTALL-FIXTURES.md` — the contract document that explains what every fixture covers, how to add new ones, and which Brad-class bug each catches.

## Pre-flight reads

1. `~/.claude/CLAUDE.md` (global rules)
2. `./CLAUDE.md` (project rules)
3. `docs/sprint-58-environment-coverage/PLANNING.md`
4. `docs/sprint-58-environment-coverage/STATUS.md`
5. Brad's 9-finding field report (cross-referenced in PLANNING.md § Why this sprint exists) — your INSTALL-FIXTURES.md coverage matrix maps each finding to a fixture
6. Existing Mnestra migration runner: `packages/server/src/setup/mnestra-migrations/` (you reuse this for test-project schema setup)
7. Existing audit-upgrade probes (find via grep) — your test-project schema must satisfy what audit-upgrade expects
8. Supabase CLI docs: project create, secrets management

## Tasks

### Task 3.1 — Provision dedicated test Supabase project

**Scope of orchestrator-coordination:** the actual project creation (clicking "New Project" in Supabase dashboard) is orchestrator-side, not lane-side — T3 documents the runbook in INSTALL-FIXTURES.md, orchestrator executes it. T3's deliverable is the runbook + the post-creation scripting.

Runbook to document (and orchestrator executes once):

1. Create new Supabase project named `termdeck-test` in the same org as the daily-driver. Free tier (500MB storage, 2 free projects per org — currently using 1, so capacity exists).
2. Capture the project ref + URL + anon key + service-role key.
3. Add as GitHub Actions repo secrets (canonical names — see Task 3.2).
4. Apply the full Mnestra migration suite via `packages/server/src/setup/mnestra-migrations/` (run all 18 migrations).
5. Apply the Rumen schema via the standard `init --rumen --yes` flow (deploy Edge Functions, set up cron via pg_cron).
6. Document the project ref in the runbook (it's not a secret — anon key is enough to identify the project, but service-role-key access is what makes test runs functional).

### Task 3.2 — Canonical GitHub Actions secret names

T1 and T2 both need to reference test-project secrets. T3 owns the canonical names. Document AND set up in repo settings:

| Secret name | Purpose |
|---|---|
| `TEST_SUPABASE_URL` | Test project URL (e.g. `https://abcd1234.supabase.co`) |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Service-role JWT for migration + admin operations |
| `TEST_SUPABASE_ANON_KEY` | Anon JWT for client-shape probes |
| `TEST_DATABASE_URL` | Direct Postgres connection string (pooler URL) for psql-based reset operations |
| `TEST_ANTHROPIC_API_KEY` | Dummy or limited-budget key — init wizards probe presence |
| `TEST_OPENAI_API_KEY` | Dummy or limited-budget key |
| `TEST_GEMINI_API_KEY` | Dummy or limited-budget key |
| `HETZNER_API_TOKEN` | Hetzner Cloud token for T2's nightly VM provisioning |
| `HETZNER_SSH_KEY_NAME` | Name of the SSH key uploaded to Hetzner console |
| `HETZNER_SSH_PRIVATE_KEY` | Private key matching the Hetzner-uploaded public key |

Document in INSTALL-FIXTURES.md exactly which job/workflow uses which secret, so future fixture additions know what's available.

### Task 3.3 — `scripts/test-supabase-reset.sh`

Schema-reset script that runs at the start of each test job to ensure clean state. Two strategies, document both — pick the simpler one as default:

**Strategy A: Per-job ephemeral schema.** `CREATE SCHEMA test_run_${GITHUB_RUN_ID}_${MATRIX_OS}; SET search_path TO test_run_...;` then run migrations into the ephemeral schema. Drop schema in cleanup. Pros: no concurrency races, no global state. Cons: migrations may not all be schema-portable; extra complexity.

**Strategy B: Lock + truncate `public`.** `SELECT pg_advisory_lock(<sprint_58_lock_key>);` at start of each test run; truncate all Mnestra + Rumen tables; release lock at end. Pros: simpler, matches production schema exactly. Cons: serializes test runs (matrix jobs can't run in parallel against the same DB).

**Recommendation:** start with Strategy B (simpler, more representative). If matrix-job parallelism becomes a bottleneck, migrate to A in Sprint 60+. Document the tradeoff in INSTALL-FIXTURES.md.

The script:
```bash
#!/bin/bash
set -euo pipefail
DATABASE_URL="${TEST_DATABASE_URL:-}"
[ -z "$DATABASE_URL" ] && { echo "TEST_DATABASE_URL required"; exit 1; }

# Strategy B — advisory lock + truncate
psql "$DATABASE_URL" -c "SELECT pg_advisory_lock(58);"
psql "$DATABASE_URL" -c "
  TRUNCATE TABLE memory_items, memory_sessions, memory_relationships,
                  flashback_events, rumen_jobs, rumen_insights, rumen_questions
  RESTART IDENTITY CASCADE;
"
psql "$DATABASE_URL" -c "SELECT pg_advisory_unlock(58);"
echo "[reset] $(date '+%H:%M:%S ET') test schema reset complete"
```

T1 + T2 jobs both call this at the start of their work (gated by the advisory lock so they serialize cleanly).

### Task 3.4 — `docs/INSTALL-FIXTURES.md`

The contract document. Sections:

1. **Why this exists.** Brief preamble: Sprint 58 catch-net philosophy, link to PLANNING.md for full context.
2. **Coverage matrix.** Table mapping each of Brad's 9 findings (and any future-finding-class) to which fixture catches it:

   | Brad finding | Severity | Fixture that catches | How |
   |---|---|---|---|
   | #1 nohup secrets.env not propagating | HIGH | `install-smoke-ubuntu` | Workflow launches via nohup-equivalent; doctor checks if all probes see DATABASE_URL |
   | #2 quoted DATABASE_URL breaks Node URL parser | MEDIUM | `install-smoke-ubuntu` | Workflow deliberately writes quoted value; doctor expected RED pre-fix, GREEN post-fix |
   | #3 pgbouncer params unrecognized by psql | LOW | (docs only) | Documented in install guide; no fixture |
   | #4 search_memories vs memory_hybrid_search drift | LOW | `install-smoke-ubuntu` doctor probe | T2 Task 2.3 fix — doctor version-gates; CI verifies probe |
   | #5 PTY hardcoded /bin/zsh fallback | MEDIUM | `install-smoke-ubuntu` + `install-smoke-alpine` | Ubuntu fixture: `apt remove zsh` step; Alpine: zsh not installed by default |
   | #6 claude-code optional dep | HIGH for Linux | `install-smoke-ubuntu` | Workflow runs `claude --version`; expected fail pre-fix (docs gap) |
   | #7 launcher exits 0 under systemd Type=simple | BLOCKING | `systemd-nightly` | T2 fixture explicitly uses Type=simple; checks systemctl is-active |
   | #8 systemd doesn't inherit user PATH | HIGH | `systemd-nightly` | T2 fixture omits Environment=PATH=; checks claude-not-found in journal |
   | #9 Markdown paste corruption | N/A | (none) | Reporter tooling, not TermDeck |

3. **Fixture descriptions.** For each fixture (install-smoke-ubuntu, install-smoke-fedora, install-smoke-alpine, install-smoke-debian, systemd-nightly): what OS, what runner, what the test does, exit-code semantics, where the workflow YAML lives.
4. **How to add a new OS.** Step-by-step: clone existing Dockerfile, modify package-manager calls, add to matrix, update coverage matrix.
5. **How to add a new test scenario.** When a Brad-class report comes in: triage to "is there an existing fixture that should have caught this?" If no, add a new fixture. If yes, why didn't it? — fixture gap; close it.
6. **Test Supabase project runbook.** The orchestrator-coordination runbook from Task 3.1, fully written out so any future orchestrator can re-provision if needed (e.g. Supabase project deletion, free-tier downgrade, etc.).
7. **Local development loop.** Multipass on Mac for fast iteration before pushing to CI: `multipass launch 24.04 --name termdeck-test`, ssh in, run the same install-smoke sequence locally. Cuts the CI feedback loop from ~5 min to ~30 seconds.
8. **Cost projection.** Hetzner CX22 nightly with full teardown ≈ €1/month. Free tier on Supabase + GitHub Actions. Total operational cost ≈ €1-5/month.

## Discipline (universal)

- **Post shape:** `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (### prefix mandatory).
- **No version bumps**, no CHANGELOG edits, no `git commit`, no `npm publish`.
- **Stay in lane.** T1 owns workflow + Docker matrix; T2 owns systemd nightly + doctor fix. Cross-lane reads OK.
- **Append-only STATUS.md.**
- **No code shipping in T3.** Pure infra + docs. Task 3.3 ships shell scripts, which is allowed; no JS/TS code changes in lane.

## Coordination notes

- Task 3.1 (project creation) is **orchestrator-coordinated**. Post `### [T3] BLOCKED-ON-ORCH 2026-MM-DD HH:MM ET — Task 3.1 needs orchestrator to create test Supabase project + add secrets to GitHub repo` to STATUS.md after authoring the runbook. Orchestrator executes the runbook + adds secrets, then posts `### [ORCH] T3-UNBLOCK ...`. T3 then proceeds to 3.3 + 3.4.
- T1 + T2 both reference your canonical secret names (Task 3.2). They're allowed to start work referencing placeholder names (e.g. `TEST_SUPABASE_URL_PLACEHOLDER`) until Task 3.2 lands; they post `### [T1/T2] BLOCKED-ON-T3-NAMES` if needed. After your Task 3.2 ships, they update references in their workflow YAML.

## Success criteria

1. `### [T3] FIX-LANDED` posts for Tasks 3.2 (canonical secret names — table in INSTALL-FIXTURES.md), 3.3 (reset script), 3.4 (full INSTALL-FIXTURES.md including coverage matrix).
2. Orchestrator-coordinated Task 3.1 unblocked: test Supabase project exists, all 10 GitHub Actions secrets present, schema migrated.
3. INSTALL-FIXTURES.md coverage matrix has a row for each of Brad's 9 findings; T4-CODEX verifies the matrix maps to actual fixtures (no fictional coverage claims).
4. `### [T3] DONE 2026-05-05 HH:MM ET` posted with summary.
