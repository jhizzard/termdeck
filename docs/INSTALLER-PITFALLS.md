# Installer Pitfalls — Cross-Project Reference

> **Why this file exists.** TermDeck has exactly one outside user: Brad. Every install or upgrade incident he has surfaced reveals a class of failure that almost certainly recurs on the next outside user we don't have yet. This doc is the synthesis — the chronological incident ledger, the failure-class taxonomy, and a pre-ship checklist that any installer or migration-runner work must clear before it ships.
>
> **Scope.** Canonical for `@jhizzard/termdeck`, `@jhizzard/termdeck-stack`, `@jhizzard/mnestra`, and `@jhizzard/rumen`. The patterns generalize to any project we publish that touches a user's filesystem, package cache, or remote database.
>
> **Last updated:** 2026-05-04. Append a new entry to the ledger every time an install/upgrade incident closes, then update the failure-class taxonomy if the incident exposed a new class.

---

## TL;DR — The pre-ship checklist

Before merging any change to the installer (`packages/stack-installer/`), wizard (`packages/cli/src/init-*.js`), bundled hook (`packages/stack-installer/assets/hooks/`), or any migration file, walk this list. Each item is here because we shipped without it once and Brad paid for it.

1. **Upgrade path tested, not just fresh-install.** Provision a Supabase project on the *previous* published version. Re-run the installer at the new version. Confirm new migrations land, new Edge Functions deploy, new vault keys exist. (Class **A**.)
2. **Idempotent re-runs.** Run the installer twice back-to-back. Second run should report "nothing to do" without breaking anything. (Class **A**.)
3. **`npm pack` shows the new file.** `cd packages/stack-installer && npm pack --dry-run | grep <new-file>` before publishing. Migration files, Edge Function source, and bundled hooks are the usual suspects. (Class **H**.)
4. **Post-install version probe.** `npm view <pkg> version` vs `<pkg> --version` after `npm install -g`. If they disagree, the user is in a cache trap — document the `npm cache clean --force` recovery path. (Class **G**.)
5. **Path parity with Claude Code's actual reads.** Wizard-written paths (MCP config, hooks, settings) must match what Claude Code v-current reads. Today: `~/.claude.json` (mcpServers), not `~/.claude/mcp.json`. Re-verify every release. (Class **B**.)
6. **No literal-placeholder writes.** Never write `'PAT_HERE'`, `'YOUR_TOKEN'`, or any sentinel string to a config the runtime will silently consume. Either prompt the user or fail loud. (Class **D**.)
7. **State-mutating writes before fallible calls.** Write the user's typed-in secrets to disk *before* opening the pg connection or applying migrations. If you must inverse the order, wrap in `try/finally` that always persists what the user typed. (Class **C**.)
8. **Zero dependency on developer-private paths.** `grep -r "Documents/Graciella" packages/stack-installer/assets/` should return nothing. Same for any hard-coded `~/.npm-global/`, `~/Documents/`, or unpublished sibling repos. (Class **E**.)
9. **Wizard defaults match the developer's actual runtime.** If Joshua runs `rag.enabled: false` (MCP-only) and the wizard defaults to `true`, the wizard is shipping into untested territory every install. Reconcile or label the asymmetry. (Class **F**.)
10. **Silent no-op detection.** Any cron, daemon, or Edge Function that can run N consecutive cycles with `processed=0 AND generated=0` must surface an explicit warning (in `mnestra doctor`, in dashboard, in logs). Brad's latest gap hid for ~6 days under an all-zeros health pattern. (Class **I**.)
11. **One logical operation per CLI invocation; never multi-line paste.** Every external CLI call that mutates state runs ONE logical operation per invocation — e.g., `supabase secrets set KEY1=VAL1` then `supabase secrets set KEY2=VAL2`, never `supabase secrets set KEY1=VAL1 KEY2=VAL2 KEY3=VAL3` (Brad observed silent drops + stray entries in v2.90.0). Every wizard step that asks the user to run a command emits a single-line `bash /tmp/<oneshot>.sh` invocation rather than a multi-line block — terminals that convert clipboard newlines to `\r\n` will shred multi-line bash pastes (`$'echo\r': command not found`). (Class **J**.)
12. **Every "this should write to table X" intent has an explicit write-path in code, audited by the probe set.** Don't rely on "the prior hook used to write this row" or "init script handles that" — verify the actual write-path is in the current bundled code. When a hook is replaced, the new code's write-path coverage must be a strict superset of the old; if it isn't, document the table-write-omission explicitly in the release notes AND check that no live data depends on it. Audit-upgrade probes should include "is there a row in `<critical_table>` newer than N hours?" not just "does column X exist?" (Class **M**.)
13. **Lockstep local-FS components are migrated as a unit, not piecemeal.** When the wizard touches a hook file, audit every other local-FS artifact that depends on it — `~/.claude/settings.json` event wiring, `~/.termdeck/config.yaml` flags, MCP config — and either update them in the same wizard pass or assert they're already correct. Self-heal probes run end-of-wizard to catch any drift the wizard couldn't repair (e.g. malformed settings.json, permission denied). E2E tests must drive a starting state matching the *previous* published version's state (e.g. `Stop`-wired settings.json from `@jhizzard/termdeck-stack@<=0.5.0`), not the developer's already-migrated current state. (Class **N**.)

---

## The chronological ledger

Each entry: incident date, version(s) involved, symptom, root cause, fix, failure class. Append in date order, never rewrite.

### #1 — npm name collision (2026-04-12, pre-launch)

- **Symptom:** `npx termdeck` resolves to "Junielton" (a Stream Deck Electron app), not our package.
- **Root cause:** Bare `termdeck` npm name was taken before we published.
- **Fix:** Scoped package `@jhizzard/termdeck`. All `npx` commands updated.
- **Class:** Distribution / namespace.

### #2 — `npm install` fails without C++ compiler (2026-04-12, pre-launch)

- **Symptom:** First-user `npm install -g @jhizzard/termdeck` errors on `node-pty` and `better-sqlite3` postinstall.
- **Root cause:** Native deps require Xcode CLI tools (or equivalent) and we never told the user.
- **Fix:** Documented prominently in `docs/INSTALL-FOR-COLLABORATORS.md`; tested prebuild-install path.
- **Class:** Native-dep precondition (no class assigned yet — keep an eye out for repeats).

### #3 — Empty dashboard, no first-run guidance (2026-04-12, pre-launch)

- **Symptom:** First load of the TermDeck UI is blank. New user has no idea what to do.
- **Fix:** Welcome state with explicit instructions in `packages/client/public/app.js`.
- **Class:** UX onboarding.

### #4 — v0.6.0 npm cache trap (2026-04-25)

- **Symptom:** Brad ran `npm install -g @jhizzard/termdeck@latest`. `termdeck --version` reported the *previous* version.
- **Root cause:** npm's cache pinned the old tarball. The install command "succeeded" but resolved from cache.
- **Fix:** `npm cache clean --force` then reinstall. Documented in install troubleshooting.
- **Class:** **G — Stale-cache pinning.**

### #5 — v0.6.2 wizard exited mid-write, lost secrets (2026-04-25)

- **Symptom:** Brad ran `termdeck init --mnestra`. Wizard prompted for and accepted DATABASE_URL, then died during the migration step. `secrets.env` never got the Postgres line.
- **Root cause:** `writeLocalConfig()` ran *after* `pgRunner.connect()` and `applyMigrations()`. Any pg-side throw exited before the user's typed-in secrets persisted.
- **Fix (v0.6.3):** Reordered — `writeLocalConfig()` first, then connect/migrate. Brad re-runs no longer lose state.
- **Class:** **C — Order-of-operations: state-mutating write after fallible call.**

### #6 — v0.6.4 init --rumen broke after init --mnestra succeeded (2026-04-26)

- **Symptom:** After v0.6.3 unblocked Mnestra, Brad ran `termdeck init --rumen` and hit a downstream cascade.
- **Root cause:** Multiple interlocking bugs in the Rumen wizard path. (See ledger entries in CHANGELOG and Sprint 35 STATUS for the full chain.)
- **Fix (v0.6.4 → v0.6.8):** Series of patches.
- **Meta:** This was incidents #4–#7 in a 36-hour window — what triggered the global `~/.claude/CLAUDE.md` rule about "onion of bugs" and "longitudinal failure-class analysis."
- **Class:** **C** (mostly), composite.

### #7 — v0.6.8 migration 007 never picked up despite "6 migrations applied" (2026-04-26)

- **Symptom:** Wizard reported success, but Brad's DB schema didn't have the columns the new migration was supposed to add.
- **Root cause:** The migration runner (in `packages/server/src/setup/`) was loading migration files from a folder root that, when installed globally, didn't contain the freshly-shipped 007 file. The runner silently iterated over a stale folder.
- **Fix (v0.6.8):** Forced bundled-first resolution — `rumenFunctionsRoot()` and `listRumenFunctions()` now check the bundled location before the npm package location. The pattern was reused for graph-inference Edge Function bundling in Sprint 42.
- **Class:** **H — Migration runner blindness: runner reads from wrong root after install.**

### #8 — SUPABASE_ACCESS_TOKEN written as literal placeholder (2026-04-26)

- **Symptom:** Brad's `~/.claude/mcp.json` had `SUPABASE_ACCESS_TOKEN: 'SUPABASE_PAT_HERE'`. Supabase MCP server failed to authenticate, but the failure was buried in MCP startup logs nobody reads.
- **Root cause:** `packages/stack-installer/src/index.js:299` wrote the literal string when it wired the MCP server config, intended as a "user fills this in later" placeholder. No prompt, no warning, no validation.
- **Fix:** Either prompt for the PAT during install or detect the placeholder at runtime and fail loud. (Status: partial — verify in current release.)
- **Class:** **D — Silent placeholder.**

### #9 — MCP config path mismatch (2026-04-26)

- **Symptom:** Mnestra MCP server configured by the wizard, but Claude Code couldn't see it. Brad ran an entire sprint without Mnestra MCP access.
- **Root cause:** Stack-installer wrote MCP config to `~/.claude/mcp.json`. Claude Code v2.1.119+ reads `mcpServers` from `~/.claude.json` (the consolidated settings file). Our wizard targeted the deprecated path.
- **Fix (Sprint 36 → v0.8.0):** Migrated to `~/.claude.json`. Forward-migration logic added: `wireMcpEntries()` now reads legacy `~/.claude/mcp.json`, merges into canonical `~/.claude.json`, surfaces malformed config cleanly.
- **Prevention:** Re-verify path parity with Claude Code's current `mcpServers` read every minor Claude Code release. This will break again.
- **Class:** **B — Path mismatch.**

### #10 — Bundled hook silent-failed on private dependency (Sprint 36 → 38)

- **Symptom:** Brad's Mnestra `pgvector` table stayed at 0 rows for 5+ days despite the MCP wired correctly, the webhook bridge alive (PID changed across restarts), and the session-end hook firing on every Claude Code stop.
- **Root cause:** Bundled `~/.claude/hooks/memory-session-end.js` delegated to `~/Documents/Graciella/rag-system/src/scripts/process-session.ts` — Joshua's private, unpublished repo. Brad didn't have it. The hook ran, the import failed, the failure was swallowed.
- **Fix (Sprint 38 v0.10.0):** Bundled hook rewritten to call Mnestra MCP tools directly. Zero dependency on `rag-system`. ~120 LOC, well-bounded. 49/49 tests pass at `packages/stack-installer/assets/hooks/memory-session-end.js`.
- **Class:** **E — Untested hidden dependency on developer-private path.**

### #11 — rag.enabled wizard-vs-runtime asymmetry (2026-04-27)

- **Symptom:** Brad's TermDeck crashed overnight. Stack trace pointed at writes to `mnestra_session_memory` (legacy table) that no init path creates.
- **Root cause:** Joshua runs `rag.enabled: false` (MCP-only mode, the path he tests daily). The wizard ships `rag.enabled: true` by default, which routes to legacy tables that the wizard never creates. Brad got the path Joshua doesn't exercise.
- **Fix (Sprint 35 hotfix v0.7.3):** Reconciled the asymmetry — wizard default flipped to match what's actually exercised, or the legacy-table init path is created and tested.
- **Class:** **F — Default-vs-runtime asymmetry.**

### #12 — v0.7.2 npm cache trap, redux (2026-04-28)

- **Symptom:** Brad ran an update, `termdeck --version` reported `0.7.2`. Latest published was 8 minor versions ahead.
- **Root cause:** Same as #4 — npm cache pinned the old tarball.
- **Fix:** `npm cache clean --force`. Same recovery path.
- **Lesson:** This will keep happening. The recovery is one command, but the *detection* requires the user to know to check. Document it where the user looks: `termdeck doctor`, README install section, error text on actual mismatch.
- **Class:** **G — Stale-cache pinning (recurrence).**

### #13 — Schema-vs-package drift on existing installs (2026-05-02 — Brad's latest)

- **Reported:** 2026-05-02 by Brad's Claude Code. Project: `jizzard-brain` (ref `rrzkceirgciiqgeefvbe`), originally provisioned 2026-04-25.
- **Versions on Brad's machine, all latest:** `@jhizzard/termdeck@1.0.0`, `@jhizzard/termdeck-stack@0.6.0`, `@jhizzard/mnestra@0.4.0`, `@jhizzard/rumen@0.4.4`.
- **Symptom:** Everything added Sprint 38 onward never landed on his existing project, even though his npm packages bundled it:
  - `graph-inference` Edge Function: never deployed (`list_edge_functions` only showed `rumen-tick`).
  - Vault secret `graph_inference_service_role_key`: never created.
  - `graph-inference-tick` cron (TermDeck migration 003): never applied.
  - Mnestra migrations 009 (graph metadata), 010 (`memory_recall_graph`), 012 (re-taxonomy), 013 (audit cols), 014 (explicit grants), 015 (`source_agent`): none applied.
  - `memory_relationships` table still at base 001 — no `weight`, no `inferred_at`, no `inferred_by`. No `source_agent` on `memory_items`. No `memory_recall_graph` RPC.
  - Confirmed via direct probe: the Edge Function's own `isMissingColumnError` diagnostic returned `{"ok":false,"since":null,"candidates_scanned":0,"error":"awaiting migration 009","ms_total":37}`.
- **Root cause:** **Stack-installer has no upgrade-detection path.** `init-rumen.js::applySchedule` correctly applies migrations 002 *and* 003 with templating — but only on the *fresh-install* code path. There is no code that checks an existing install against the bundled migration set and applies the diff. After `npm install -g @jhizzard/termdeck-stack@latest`, the npm packages are current, but the database is frozen at whenever the project was first kickstarted.
- **Compounding symptom (Class I):** `rumen-tick` kept successfully running every 15 minutes with `sessions_processed=0, insights_generated=0` for ~6 days. Looked healthy. Wasn't.
- **Brad's manual fix (idempotent, reproducible):**
  1. Deployed `graph-inference` Edge Function from `~/.npm-global/lib/node_modules/@jhizzard/termdeck/packages/server/src/setup/rumen/functions/graph-inference/index.ts`.
  2. Cloned `rumen_service_role_key` → `graph_inference_service_role_key` in vault.
  3. Applied TermDeck migration 003 with `<project-ref>` templated to the real ref.
  4. Applied Mnestra migrations 009, 010, 012, 013, 014, 015 in order.
  5. Verified by manually firing `graph-inference`: returned 200 with `candidates_scanned=1, edges_inserted=1, ms_total=66`. First cron-tagged edge written (similarity 0.8686, type `relates_to`).
- **Fix area (proposed by Brad, both reasonable):**
  1. **Schema introspection diff.** Probe for `memory_relationships.weight`, `memory_items.source_agent`, `cron.job WHERE jobname='graph-inference-tick'`, `pg_proc WHERE proname='memory_recall_graph'`. Apply the corresponding migration if absent. Cheap, no new state.
  2. **Migration-tracking table.** Dedicated `mnestra_migrations` / `rumen_migrations` table the runner consults on every re-run. Expensive to introduce now (back-fill required for existing installs), but self-heals all future drift.
  3. **Symptom-side regardless:** Add to `mnestra doctor` (planned for upcoming release) — if `rumen-tick` runs N consecutive cycles with `sessions_processed=0 AND insights_generated=0`, surface a one-line warning. Brad's "silent no-op" pattern is what hid this for 6 days.
- **Status:** Captured as **P0** in `docs/BACKLOG.md`. Suggested sprint shape: "Stack-installer upgrade-aware migration detection."
- **Class:** **A — Schema drift** (primary), **I — Silent no-op** (compounding).

### #14 — Multi-arg `supabase secrets set` drops + Vault UI removal + Edge Function env friction (2026-05-03 — Brad's 4-project install pass)

- **Reported:** 2026-05-03 by Brad's Claude Code, after a clean install run across four Supabase projects (`jizzard-brain`, `Structural`, `aetheria-phase1`, `aetheria-payroll`). All four ended at full post-Sprint-50 state (Mnestra 001-007 + 009/010/012/013/014/015, Rumen 001/002, TermDeck 003, both Edge Functions deployed, Vault secrets + Edge Function secrets set, GRAPH_LLM_CLASSIFY=1).
- **Five distinct symptoms:**
  1. **Edge Function `DATABASE_URL` friction.** Bundled source at `packages/server/src/setup/rumen/functions/{rumen-tick,graph-inference}/index.ts` reads `Deno.env.get('DATABASE_URL')` only. Supabase Edge Runtime auto-injects `SUPABASE_DB_URL` as a built-in env var; users can avoid the manual `supabase secrets set DATABASE_URL=…` step entirely if the source falls back. Brad hand-patched all 4 deployed copies. **Class:** Wizard friction (no class — folded into pre-ship checklist behavior).
  2. **Vault dashboard panel removed/relocated.** Brad couldn't find the "Vault" tab in current Supabase UI; the extension is enabled and `vault.create_secret()` works fine, but the dashboard surface for managing secrets has been quietly removed. Wizard text saying "click Vault in the dashboard" is now broken instructions. Fix: emit a SQL-Editor deeplink with `vault.create_secret(...)` pre-filled, OR run the call automatically via `supabase db query --linked`. **Class:** **B — Path mismatch** (instructions point at a UI surface that no longer exists).
  3. **`supabase secrets set` v2.90.0 multi-arg unreliable.** Setting `KEY1=val1 KEY2=val2 KEY3=val3` in a single CLI call sometimes lands only one secret and silently drops the rest, sometimes leaves stray entries (Brad observed `brad.a.heath@gmail.com` materialize as a secret name from a prior misparse). Fix: one CLI call per secret, exit code checked per call. Verified at `packages/cli/src/init-rumen.js:setFunctionSecrets` (lines 403-426 — single multi-arg call). **Class:** **J — Multi-arg CLI parse drift** (new).
  4. **Clipboard `\r\n` shred on multi-line `!` pastes.** Brad's terminal converts newlines on paste; bash chokes with `$'echo\r': command not found` when a multi-line block is pasted. Fix: write the bootstrap script to disk (`/tmp/setup-mnestra-secrets.sh`) and emit a single-line `bash /tmp/setup-mnestra-secrets.sh` invocation. **Class:** **J — Multi-line clipboard shred** (same new class as #3 — they share the same root: assume one-keystroke / one-invocation atomicity at every wizard handoff).
  5. **Class-A drift root cause confirmed identical on `jizzard-brain`** — re-confirms ledger #13. Bonus finding: Rumen migration 002 still ships with raw `<project-ref>` placeholder. The fresh-install schedule path at `init-rumen.js:472-505` does call `applyTemplating()` for both 002 and 003, but Brad's note flags that *any new audit-upgrade applier* (Sprint 51.5 T1) must mirror that templating call — silently re-applying mig 002 without templating would push the literal placeholder string to the database.
- **Fix area:** Sprint 51.5 lanes T1 (Edge Function env fallback + audit-upgrade templating coverage), T3 (per-secret CLI calls + Vault SQL-Editor URL pivot + GRAPH_LLM_CLASSIFY prompt), T4 (this entry + Class J + checklist item #11).
- **Status:** Folded into Sprint 51.5 PLANNING.md § "Brad 2026-05-03 takeaways" 2026-05-03.
- **Class:** **J — Multi-arg CLI parse drift / multi-line clipboard shred** (primary, new); **B — Path mismatch** (Vault UI); various wizard-friction reductions (DATABASE_URL fallback).

### #15 — Bundled session-end hook never had a `memory_sessions` write path (2026-05-03 — discovered mid-Sprint-51.6 via live psql probe)

- **Reported:** 2026-05-03 19:13 ET by orchestrator (Joshua's session) via authorized live `psql` probe of `petvetbid` (Joshua's daily-driver Mnestra, ref `luvvbrpaopnblvxdxwzb`). Triggered the Sprint 51.6 mini-sprint.
- **Symptom:** `memory_sessions` table stuck at 289 rows / `max(ended_at) = 2026-05-01 20:40 UTC` for ~2 days. Every Claude Code session ended in that window produced ZERO new rows in `memory_sessions`. `memory_items` was still growing (33+ rows during Sprint 51.5), so the gap was specifically in the `memory_sessions` write path. Background cron telemetry looked healthy (Class I-adjacent).
- **Initial misdiagnosis (corrected by T2 + Codex auditor):** orchestrator first hypothesized this was Class A drift on `memory_items.source_agent` (Codex had just discovered + fixed that on the same DB at 19:01 ET). Live probe of the schema and bundled hook source disproved it: `memory_items` writes WERE landing successfully via the MCP path (which doesn't pass `source_agent`). The `memory_sessions` write was a separate failure mode entirely.
- **Root cause (T2 finding 2026-05-03 20:00 ET, T1 confirmed 20:05 ET):** the bundled session-end hook (`packages/stack-installer/assets/hooks/memory-session-end.js`) **never had a `memory_sessions` write path.** `grep -n "memory_sessions"` against installed AND bundled returned ZERO matches. The 289 existing rows came from Joshua's PRIOR personal `~/Documents/Graciella/rag-system/hooks/memory-session-end.js` spawner, which invoked `~/Documents/Graciella/rag-system/src/scripts/process-session.ts:131` as the actual writer. That writer parsed transcripts, computed `started_at`/`ended_at`/`duration_minutes`/`messages_count`/`facts_extracted`/`topics`, and INSERT'd one row per session. **2026-05-02 13:24 ET:** a `termdeck init` overwrote `~/.claude/hooks/memory-session-end.js` with the bundled TermDeck hook (Sprint 47-era version, registered under `hooks.Stop`). The original rag-system spawner was preserved as `.bak.20260502-132414`. Both pre- and post-swap bundled hook versions write ONLY to `memory_items`. **Effect:** every session-end since 2026-05-02 13:24 ET writes a `session_summary` row to `memory_items` but nothing to `memory_sessions`. The 289 baseline is Joshua's last session under the rag-system hook before the swap. **This is not a broken write that fails at runtime — there is no write to break.** Architectural omission, not execution failure.
- **Why the misdiagnosis was natural:** Brad's drift bug (entry #13) was Class A schema drift, fresh in the orchestrator's mind. Codex's chopin-in-bohemia memory dump revealed `source_agent` column drift on the same DB at 19:01 ET (also Class A). Three drift signals in 24 hours primed the orchestrator to assume drift again. Live psql probe + Codex's static-source audit broke the pattern-match.
- **Fix (Sprint 51.6, ships v1.0.2 wave 2026-05-03 20:50 ET):**
  1. NEW `postMemorySession()` function in bundled hook — POSTs to `/rest/v1/memory_sessions?on_conflict=session_id` with `Prefer: resolution=merge-duplicates,return=minimal` (idempotent on duplicate SessionEnd fires; Codex T4-CODEX 20:14 ET catch).
  2. NEW Mnestra migration 017 reconciles canonical engram schema (`mig 001`) with the rag-system writer's richer column set so the bundled hook can write a uniform shape on both fresh-canonical installs and Joshua's petvetbid (which already had the rich shape from the rag-system bootstrap).
  3. NEW `refreshBundledHookIfNewer()` in `init-mnestra.js` lands the post-Sprint-50 bundled hook onto users' machines via `termdeck init --mnestra`. Version stamp + TermDeck-marker safety gate (Codex T4-CODEX 20:23 ET catch — protects genuinely-custom user hooks).
  4. Sprint-41 14-entry default `PROJECT_MAP` restored in the bundled hook (chopin-nashville catch-all LAST). Closes T1 side-finding (b): all writes today were tagging as `project="global"` instead of cwd-correct.
  5. Bundled hook source now ships in root `@jhizzard/termdeck` tarball — `packages/stack-installer/assets/hooks/**` added to `package.json.files` (Codex T4-CODEX 20:17/20:23/20:28 ET HARD BLOCKER; empirically verified via `npm pack --dry-run --json` with isolated cache).
- **Phase B verification 2026-05-03 21:19 ET:** Joshua manually invoked `refreshBundledHookIfNewer()` (wizard wire-up bug — see Sprint 51.6.1 below). Triggered fresh `/exit`. `memory_sessions` count grew 289 → 290; `tests/project-taxonomy.test.js` flipped from 3-pass/22-fail to 25-pass/0-fail. `[T4-CODEX] DONE — VERIFIED (post-manual-refresh)`.
- **Sprint 51.6.1 / v1.0.3 follow-up — CLOSED 2026-05-04 ~12:00 ET (Sprint 51.7).** Root cause was deeper than expected: `refreshBundledHookIfNewer()` was structurally wired into `init-mnestra.js:677` but architecturally coupled to a fragile prerequisite chain. `applyMigrations()` threw on `001_mnestra_tables.sql` (the `match_memories` `CREATE OR REPLACE FUNCTION` return-type drift on long-lived installs like petvetbid + jizzard-brain), outer catch returned exit 5, refresh never reached. Codex T4 pinned the exact SQL error (`cannot change return type of existing function`) at 11:07 ET via independent reproduction. T1's fix moved `runHookRefresh()` to `init-mnestra.js:716` — UPSTREAM of `pgRunner.connect`/`applyMigrations`/`runMnestraAudit`/`writeYamlConfig`. Hook refresh is local FS work; decoupling means a failed DB phase no longer strands the bundled-hook upgrade. New CLI-binary integration test at `tests/init-mnestra-cli-refresh.test.js` (6/6) pins the upstream-of-DB invariant: spawns the actual binary against tmp HOME with stale hook + unreachable DATABASE_URL, asserts refresh fires + precedes `Connecting to Supabase` in stdout order. Plus T2's metadata-completeness pass: bundled hook v1 → v2 with `parseTranscriptMetadata()` populating `started_at` / `duration_minutes` / `facts_extracted` (parser counts BOTH `mcp__mnestra__memory_remember` AND legacy `mcp__memory__memory_remember` per Codex 11:09 ET catch). **Sprint 51.7 was the second sprint to use 3+1+1 (Orchestrator + 3 Claude Workers + 1 Codex Auditor); Codex caught 6 real bugs before publish (root cause, dry-run audit, parser pre-check, T2 WIP blocker, T3 missing CHANGELOG, T3 CHANGELOG accuracy). Three hardening rules canonized in `~/.claude/CLAUDE.md` — auditor compaction-checkpoint discipline, lane post-shape uniformity, tolerant idle-poll regex.**

  **Out-of-scope follow-up (Sprint 52.1 candidate):** Class A migration-replay drift in `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-96` remains. The `match_memories` CREATE OR REPLACE still fails on existing v0.6.x-era installs with a different return-type signature. Sprint 51.7 fixed Class M (DB failure no longer strands hook upgrade); the underlying migration drift is now visible-but-non-blocking. Fix direction: wrap in `DROP FUNCTION IF EXISTS match_memories(vector, ...) CASCADE;` OR add a `do$$ ... end$$` signature-drift guard. Single-lane mini-sprint, ~30 min.
- **Class:** **M — Architectural omission (write-path absence)** (NEW). Pattern: a write that someone-else's-code used to perform is preserved in the database (rows accumulating successfully) but the new code that replaced the someone-else's-code never had the write-path at all. Pre-ship checklist gains item #12: "every database table the wizard or hook is supposed to populate must have an explicit write-path in the bundled code that the audit-upgrade probe set verifies, not 'inherited' from a prior writer." Sprint 51.6 was the **first sprint to use the canonical 3+1+1 (Orchestrator + Workers + Codex Auditor) pattern** documented in `~/.claude/CLAUDE.md` § Sprint role architecture; Codex caught 4 real bugs in T3's WIP that all-Claude Sprint 51.5 missed.

### #18 — `memory_hybrid_search` 10-arg drift overload on long-lived v0.6.x-era installs (2026-05-04 — Codex T4-CODEX live catch during Sprint 51.5b, closed in Sprint 51.9)

- **Reported:** 2026-05-04 14:42 ET by Codex (T4-CODEX auditor) during Sprint 51.5b dogfood. The CHECKPOINT in `docs/sprint-51.5b-dogfood-audit/STATUS.md:42-60` cites: "Mnestra MCP is reachable but `memory_recall` is not usable in this Codex runtime: both requested recalls failed with Postgres overload ambiguity on `public.memory_hybrid_search(...)` (two candidate signatures, one with `recency_weight`/`decay_days`)." Closed in Sprint 51.9 (v1.0.6) within ~25 minutes of the catch.
- **Symptom:** PostgREST + MCP clients calling `memory_hybrid_search(query_text, query_embedding, ...)` with the canonical 8-arg shape hit `function memory_hybrid_search(...) is not unique` because TWO overloads coexisted in petvetbid (and likely jizzard-brain): the canonical 8-arg from mig 002 + mig 004, AND a 10-arg drift overload with extra `recency_weight`/`decay_days` parameters from a pre-canonical Mnestra iteration or the rag-system writer's bootstrap.
- **Root cause:** mig 002 + mig 004 both `CREATE OR REPLACE FUNCTION memory_hybrid_search` with the 8-arg signature, but neither dropped pre-existing overloads with different arg lists. Postgres preserves overloads with non-matching argument lists across `CREATE OR REPLACE`, so the 10-arg drift sat alongside the canonical 8-arg indefinitely. Same Class A pattern Sprint 52.1 closed for `match_memories` four hours earlier (ledger #17).
- **Why this hid through Sprints 51.5/51.6/51.7/51.8/52.1:** Joshua's daily-driver Claude Code usage uses the local rag-system spawner at `~/Documents/Graciella/rag-system/hooks/...` for hook fires, and the Mnestra MCP `memory_remember`/`memory_recall` calls are routed via different code paths internally that don't depend on `memory_hybrid_search` getting an unambiguous overload resolution. The Mnestra MCP server WAS calling memory_hybrid_search internally on Joshua's machine — but apparently the routing OR client wasn't hitting the ambiguity. Codex's MCP-wired runtime (added 2026-05-04 ~11:00 ET) was the FIRST probe to actually surface this on petvetbid. The 3+1+1 pattern's auditor role caught what five all-Claude-or-mostly-Claude sprints share-blind missed.
- **Fix (Sprint 51.9, ships v1.0.6 wave 2026-05-04 ~15:00 ET):**
  1. NEW `do $$` block in `002_mnestra_search_function.sql`, immediately before `create or replace function memory_hybrid_search`. Same shape as mig 001's match_memories guard. Iterates `pg_proc` joined to `pg_namespace`, filters `proname = 'memory_hybrid_search' AND nspname = 'public'`, executes `drop function <regprocedure-cast>` per overload. Drops every overload regardless of arg list. Idempotent on greenfield. Scoped to `public`. No CASCADE.
  2. mig 004 subsequently `CREATE OR REPLACE`s the same 8-arg signature with the match_count cap variant. Net end-state: ONE 8-arg `memory_hybrid_search` in public schema.
  3. Mirrored byte-identical to `~/Documents/Graciella/engram/migrations/002_mnestra_search_function.sql`.
  4. NEW shape regression suite at `tests/migration-002-shape.test.js` (7 tests). Pins same invariants as mig 001's shape test, plus the canonical 8-arg signature.
- **Class:** **A — Schema drift** (sixth incident, second in the v1.0.x onion). Sister of #17. Same single-day discovery+fix cycle. Migration-authoring linter for `CREATE OR REPLACE FUNCTION` without drift-guard prelude is now well-justified; two incidents from the same author shape on the same day = pattern.

### #17 — `match_memories` return-type drift on long-lived v0.6.x-era installs (2026-05-04 — Sprint 51.7 deferred side-finding, closed in Sprint 52.1)

- **Reported:** 2026-05-04 11:38 ET by Codex (T4-CODEX auditor) during Sprint 51.7. Independent reproduction of `applyMigrations()` exit 5 on Joshua's petvetbid pinned the exact SQL error (`cannot change return type of existing function`) and the exact migration line (`packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-116`). Carried forward as a deferred side-finding through v1.0.3 + v1.0.4. Closed in Sprint 52.1 (v1.0.5).
- **Symptom:** On any Mnestra install where `match_memories` was created by a prior Mnestra version with a different RETURN-table column order — specifically the rag-system writer's drift shape `(id, content, metadata, source_type, category, project, created_at, similarity)` vs the canonical `(id, content, source_type, category, project, metadata, similarity)` — `termdeck init --mnestra` throws at `001_mnestra_tables.sql` with `cannot change return type of existing function`. Outer catch returns exit 5. Joshua's petvetbid (`luvvbrpaopnblvxdxwzb`) and Brad's jizzard-brain both reproduced this.
- **Root cause:** Postgres rejects `CREATE OR REPLACE FUNCTION` when the return-table shape changes — column order and column types are part of the function signature. The `001_mnestra_tables.sql` migration was authored without a drift guard because the canonical greenfield path always succeeds (no prior function). Long-lived installs that bootstrapped from the rag-system writer (which creates `match_memories` with the drift shape) hit the constraint when they replay the canonical migration.
- **Why this hid through Sprints 51.5/51.6/51.7:** the wizard's outer try/catch returned exit 5 and the user's terminal showed a generic error. Joshua attributed early failures to other causes (auth, key shape, config). Sprint 51.7's wire-up fix (Class M) decoupled hook refresh from the DB phase, so the hook upgrade landed cleanly even when DB phase failed — but the DB phase still failed visibly with exit 5. Sprint 51.8 closed Class N (settings.json wiring) and made the wizard's local-FS work fully clean. This entry is the last remaining onion ring.
- **Fix (Sprint 52.1, ships v1.0.5 wave 2026-05-04):**
  1. NEW `do $$` block in `001_mnestra_tables.sql:81-95`, immediately before `create or replace function match_memories`. Iterates `pg_proc` joined to `pg_namespace`, filters `proname = 'match_memories' AND nspname = 'public'`, executes `drop function <regprocedure-cast>` per overload. Drops every overload regardless of arg list. Idempotent on greenfield (loop iterates zero times). Scoped to schema `public`. No CASCADE — true hard dependencies (views, generated columns) surface as loud errors rather than silent destruction.
  2. Mirrored to `~/Documents/Graciella/engram/migrations/001_mnestra_tables.sql` (byte-identical). The Sprint 51.5 T1 hygiene: TermDeck bundled mirror and Mnestra-repo canonical primary MUST stay in lockstep.
  3. NEW shape regression suite at `tests/migration-001-shape.test.js` (8 tests). Pins: file existence, byte-identical to Mnestra-repo primary, do$$ guard placement (must precede CREATE OR REPLACE), schema scope (`nspname = 'public'`), no CASCADE, pg_proc-with-regprocedure-execute pattern, canonical return-table column order, no stale `created_at` in return-table.
- **Class:** **A — Schema drift** (existing class, fifth incident). Pattern is well-canonized — every `CREATE OR REPLACE FUNCTION` on a long-lived install needs a drift-tolerant prelude. Sprint 52+ candidate: codify into a migration-authoring linter that flags any `create or replace function` without a corresponding drift guard. Pre-ship checklist item #1 already covers "upgrade path tested, not just fresh-install" — this entry is what happens when that test isn't run because the developer's daily-driver was bootstrapped via the rag-system writer (= a non-canonical-greenfield path).

### #16 — v1.0.3 wizard refreshed hook FILE but left `settings.json` wired under `Stop` (2026-05-04 — Brad's jizzard-brain repro)

- **Reported:** 2026-05-04 ~13:30 ET by Brad via Telegram, with full diagnosis attached. Triggered the Sprint 51.8 mini-sprint (single-lane fix, ships v1.0.4).
- **Symptom:** After running `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` against a project upgraded from v1.0.0/v1.0.1/v1.0.2, the wizard prints `✓ refreshed v1 → v2 (backup: ...)` for the hook file but does NOT print any line about `~/.claude/settings.json`. `grep -E '"Stop"|"SessionEnd"' ~/.claude/settings.json` shows the memory hook still wired under `Stop`. Net behavior: v2 hook FILE on disk + `Stop` wiring → v2 hook (which doesn't gate by event type) fires every assistant turn. Each fire writes a fresh `memory_items` row with `source_type='session_summary'`. `memory_sessions` stays correct (mig 017's `Prefer: resolution=merge-duplicates,return=minimal` upserts on `session_id`), but `memory_items` accumulates duplicates. Net effect: N `session_summary` rows in `memory_items` per session instead of 1. Brad's workaround: `sed -i 's/"Stop": \[/"SessionEnd": [/' ~/.claude/settings.json`. Single-line fix, takes effect on next session.
- **Root cause:** The settings.json Stop→SessionEnd migration logic exists at `packages/stack-installer/src/index.js:451 _mergeSessionEndHookEntry` and is called from `installSessionEndHook` (`src/index.js:594`) — full migration semantics, well-tested in `tests/stack-installer-hook-merge.test.js`. But Sprint 51.7 lifted only the file-copy half (`refreshBundledHookIfNewer`) into `packages/cli/src/init-mnestra.js`; the settings.json migration stayed behind in stack-installer. The Mnestra wizard's main flow runs `runHookRefresh()` (file copy) + nothing else. Users who first wired their hook via `@jhizzard/termdeck-stack@<=0.5.0` (= anyone who ran `termdeck init --mnestra` before Sprint 48 ~2026-04-30, which covers all v1.0.0/v1.0.1 first-installs) had their hook registered under `Stop`. The v1.0.3 hook-file refresh upgraded them to v2 but left the `Stop` wiring; v2's lack of an event-type gate turned that into Brad's per-turn-fire bug.
- **Why this kept happening across THREE consecutive sprints (Sprint 51.5/51.6/51.7):** The acceptance criteria across all three sprints checked file existence ("the v2 hook file is at `~/.claude/hooks/memory-session-end.js` with `@termdeck/stack-installer-hook v2`"), never end-to-end behavior ("after the wizard, exactly 1 `session_summary` row writes to `memory_items` per session"). The behavioral probe was never run against a starting state with `Stop` wiring because the workers' dev machines all had pre-migrated `SessionEnd` wiring from earlier `termdeck-stack` runs. Dogfood-from-current-state ≠ install-from-v1.0.0. Brad's machine retained `Stop` wiring from v1.0.0 first-install, so his repro is the first run of the actual e2e probe.
- **Fix (Sprint 51.8, ships v1.0.4 wave 2026-05-04):**
  1. NEW `migrateSettingsJsonHookEntry()` + `_mergeSessionEndHookEntry()` + `_isSessionEndHookEntry()` hoisted into `packages/cli/src/init-mnestra.js`. The merge primitive is a 1:1 hoist of the same-named function in `packages/stack-installer/src/index.js:451` — the hoist is required because the published `@jhizzard/termdeck` tarball ships only `packages/stack-installer/assets/hooks/**`, not `.../src/**`, so the wizard cannot `require()` the migration logic across package boundaries at runtime.
  2. `runSettingsJsonMigration({ dryRun })` wires the migration into `init-mnestra.js:main()` immediately after `runHookRefresh()`. Prints `migrated Stop → SessionEnd (was firing on every turn; backup: <name>)` for Brad's repro shape, `already wired (SessionEnd)` for already-correct installs, `installed (SessionEnd)` for fresh installs.
  3. Best-effort timestamped `.bak.<YYYYMMDDhhmmss>` backup of `~/.claude/settings.json` before any write. Atomic write via `<path>.tmp` + rename.
  4. NEW regression suite at `tests/init-mnestra-settings-migration.test.js` (17 tests). Critical case: Brad's exact `Stop`-wired fixture → migrate → assert SessionEnd present + Stop entry stripped + backup written + backup contains original Stop-wired shape. Plus already-migrated-no-op, idempotent-second-run, fresh-install, empty-file, malformed-JSON, dry-run-truthfulness, mixed-cases (unrelated Stop hooks preserved, SessionEnd with another user's hook + our hook in Stop), and cross-package parity (hoisted merge primitive ≡ stack-installer's merge primitive on identical inputs).
  5. INSTALLER-PITFALLS.md gains pre-ship checklist item #13 ("lockstep local-FS components are migrated as a unit") + new Class **N** in the failure-class taxonomy + this ledger entry.
- **Class:** **N — Lockstep drift** (NEW). Pattern: two or more local-FS components that must stay in sync (the hook FILE and the `settings.json` event wiring; or the bundled migration file and the audit-upgrade probe set; or `~/.termdeck/config.yaml` flags and the running daemon's reload state) get updated piecemeal. The wizard repairs one and silently leaves the other stale. The shared blind spot across Sprints 51.5/51.6/51.7 was treating the hook system as `{file, location}` rather than `{file, file-version, settings.json wiring, event semantics}` — a 4-tuple where any one element can drift independently and the others can still look correct. Detection requires e2e probes that drive from the *previous* published version's starting state, not the developer's already-migrated current state. New Class N is also a useful frame for past incidents that didn't fit cleanly elsewhere — e.g. v0.6.5's `source_session_id` column shipped without the audit-upgrade probe being updated to require it (entries #6/#7 era).

---

## Settings.json invariants the wizard must enforce

Brad framed this in the v1.0.3 bug report: "settings.json invariants the wizard must enforce — a checklist that runs at end of every wizard pass and self-heals any gap, not just on first install." This section lists those invariants. Every wizard pass (`termdeck init --mnestra`, `termdeck init --rumen`, `termdeck-stack` re-runs) should self-heal any divergence from this list.

| # | Invariant | Self-heal | Failure mode if violated |
|---|---|---|---|
| 1 | If `~/.claude/hooks/memory-session-end.js` exists at v ≥ bundled, `~/.claude/settings.json` has the matching command wired under `hooks.SessionEnd`. | `migrateSettingsJsonHookEntry()` (Sprint 51.8). | Hook fires never (wired-nowhere) or every-turn (wired-Stop). Brad's #16 repro. |
| 2 | The memory-session-end command is wired under `SessionEnd` ONLY — never under `Stop` or any other event. | Same. Migrates from Stop, no-op when correct. | v2 hook (no event-type gate) fires per-turn instead of per-session-close. Per-turn writes pollute `memory_items`. |
| 3 | If a memory-session-end command appears in any non-`SessionEnd` event group, it's the only such occurrence (no double-wire across events). | Migration strips from Stop; would also strip from any other non-SessionEnd group if extended. | Hook fires N+1 times per session (once per wired event). |
| 4 | User-authored hooks under `Stop` (or any other event) that are NOT memory-session-end are preserved verbatim. | Migration's `_isSessionEndHookEntry` substring match is conservative — only entries whose `command` includes `memory-session-end.js` are touched. | User loses their own hooks. Trust violation. |
| 5 | The `settings.json` file is parseable JSON with an object top-level. | If malformed, wizard logs `(skipped: settings.json malformed: <error>)` and continues — never overwrites a malformed file. | Wizard nukes user's settings if it tried to write past a parse failure. |
| 6 | A best-effort timestamped backup is written before any modification (`<path>.bak.<YYYYMMDDhhmmss>`). | `migrateSettingsJsonHookEntry()` writes the backup then atomic-renames the new file in. | User has no recovery path if our merge logic ever has a regression. |

These invariants apply to `~/.claude/settings.json` specifically. The same shape — "list the invariants, give each a self-heal step, run them at end of wizard" — should be applied to `~/.termdeck/secrets.env` (env-var presence + shape), `~/.termdeck/config.yaml` (rag.enabled + ${VAR} refs + Mnestra connection block), `~/.claude.json` (mcpServers entry shape), and any other local-FS artifact the wizard provisions. Sprint 52+ candidate: extract the pattern into a reusable `wizardInvariants[]` table the wizard's epilogue iterates.

---

## Failure-class taxonomy

Every entry above maps to one of these classes. New incidents either fit an existing class (reinforcing the pattern) or expose a new class (which goes here).

| Class | Name | Diagnostic question | Where it bites |
|---|---|---|---|
| **A** | Schema drift | Does the installer detect missing migrations on a re-run against an existing install? | Multi-version users; long-lived projects |
| **B** | Path mismatch | Does the wizard write to the same path the runtime/Claude-Code/MCP-host actually reads? | Whenever upstream tools change config paths |
| **C** | Order-of-operations | Are state-mutating writes (secrets, config) committed *before* fallible calls (DB, network)? | Wizard mid-flight failures lose user input |
| **D** | Silent placeholder | Does the wizard ever write a literal `'PAT_HERE'`-style sentinel into a config the runtime will consume? | Auth fails silently; user blames our code |
| **E** | Hidden dependency | Does any bundled file (hook, script, asset) import or invoke a developer-private path? | Fresh users get silent no-ops |
| **F** | Default-vs-runtime asymmetry | Does the wizard's default config match the path the developer exercises daily? | Outside users hit untested code paths |
| **G** | Stale-cache pinning | Did `npm install -g` actually install the new version, or did npm cache trap? | Recurring; needs detection at the user surface |
| **H** | Migration-runner blindness | Does the runner load files from the right root after global install? Does `npm pack` include them? | New migrations ship but never apply |
| **I** | Silent no-op | Do background jobs surface a warning when they succeed-but-do-nothing for N cycles? | Schema gaps and missing data hide for days |
| **J** | Multi-arg CLI parse drift / multi-line clipboard shred | Does every wizard CLI hand-off run one logical operation per invocation, and does every user-facing command fit on one line? | External CLIs (e.g. `supabase secrets set` v2.90.0) silently drop args on multi-arg invocations; terminals that convert clipboard newlines shred multi-line pastes |
| **M** | Architectural omission (write-path absence) | Does every "this should write to table X" intent have a real write-path in code, or is it implicit / inherited from a prior writer that's been overwritten? | Hook swap drops a write that lived in the prior writer; bundled hook never had it; data silently stops landing while every other signal looks healthy |
| **N** | Lockstep drift (local-FS components must stay in sync) | When the wizard updates a hook file, does it also update every other local-FS artifact that depends on it (settings.json wiring, config flags, MCP config)? Does the e2e test drive from the *previous* published version's starting state, not the developer's already-migrated state? | A code path that handles "thing A and thing B together" gets bisected during a refactor — wizard ships with thing A repaired but thing B silently stale; users on the old wiring stay broken until a future incident surfaces it |

Use the table as a code-review prompt. Any installer/wizard PR should be traceable to "this PR avoids classes X, Y."

---

## Cross-project applicability

This doc lives in TermDeck because TermDeck owns the stack-installer package. But the failure classes are not TermDeck-specific. They apply to any project we publish that:

- Writes to a user's filesystem (config files, hooks, settings).
- Provisions or migrates a remote database.
- Bundles assets that need to be present after `npm install`.
- Wires into a host tool (Claude Code, Cursor, an MCP host) whose config paths can change.

Mnestra (`~/Documents/Graciella/engram`) and Rumen (`~/Documents/Graciella/rumen`) inherit all of this — they ship migrations, they're invoked through the stack-installer, they have their own version-bump cadence. Both should consult this doc before any installer-adjacent change. Pointer files in those repos' `docs/` link back here.

For other projects that publish CLIs or do filesystem provisioning (PVB, ChopinScheduler, ClaimGuard, future Sundials tooling): the **pre-ship checklist** at the top is portable. Apply it.

---

## How to add a new entry

1. New incident reported (Brad, Joshua, future user, or an audit).
2. Triage to root cause (don't ship a symptom-fix without naming the class).
3. Append to **The chronological ledger** with the standard fields: date, versions, symptom, root cause, fix, class.
4. If the incident exposed a class not in the taxonomy, add it to **Failure-class taxonomy** and update **The pre-ship checklist** with a corresponding line item.
5. If the fix is non-trivial, store the synthesis in Mnestra: `memory_remember(category="architecture", source_type="bug_fix", text="...", project="termdeck")`. Cross-link this doc.
6. Update `docs/BACKLOG.md` if the fix isn't in this sprint.

The point of this doc is that the next session can read it cold and avoid repeating any of these classes. Keep it that way.
