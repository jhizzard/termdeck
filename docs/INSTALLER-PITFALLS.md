# Installer Pitfalls — Cross-Project Reference

> **Why this file exists.** TermDeck has exactly one outside user: Brad. Every install or upgrade incident he has surfaced reveals a class of failure that almost certainly recurs on the next outside user we don't have yet. This doc is the synthesis — the chronological incident ledger, the failure-class taxonomy, and a pre-ship checklist that any installer or migration-runner work must clear before it ships.
>
> **Scope.** Canonical for `@jhizzard/termdeck`, `@jhizzard/termdeck-stack`, `@jhizzard/mnestra`, and `@jhizzard/rumen`. The patterns generalize to any project we publish that touches a user's filesystem, package cache, or remote database.
>
> **Last updated:** 2026-05-03. Append a new entry to the ledger every time an install/upgrade incident closes, then update the failure-class taxonomy if the incident exposed a new class.

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
