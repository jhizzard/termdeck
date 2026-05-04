# Sprint 51.7 — STATUS

Append-only durable record. Each lane posts FINDING / FIX-PROPOSED / FIX-LANDED / DONE entries with timestamps. Auditor (T4-CODEX) posts AUDIT / VERIFY / DONE — VERIFIED or DONE — REOPEN T<n>. Orchestrator does not post here — orchestrator close-out lives in commit messages + ledger entries + the session-end email.

Sprint goal: ship v1.0.3 with (a) wizard wire-up fix so `termdeck init --mnestra` actually refreshes `~/.claude/hooks/memory-session-end.js`, (b) bundled-hook metadata completeness pass (transcript parsing → `started_at`/`duration_minutes`/`facts_extracted`), (c) bundled-hook version stamp bumped v1 → v2 as insurance.

Pre-sprint baseline (orchestrator-recorded 2026-05-04 ~10:30 ET):
- `@jhizzard/termdeck@1.0.2` live, `@jhizzard/termdeck-stack@0.6.2` live
- Joshua's installed hook = v1 bundled hook (post-manual-refresh from Sprint 51.6 21:19 ET)
- `memory_sessions` count = 290 (Phase B's +1 from 289 baseline)
- `tests/project-taxonomy.test.js` baseline 25/25 pass post-refresh
- Brad's jizzard-brain: v1.0.2 installed, mig 017 self-healed via audit-upgrade, hook NOT refreshed (same wire-up failure)

---

## Lane posts

(lanes append below this line)

[T3] STANDBY 2026-05-04 11:03 ET — booted, briefs read (PLANNING + STATUS + T3 + T1 + T2 + RELEASE.md + CHANGELOG head + INSTALLER-PITFALLS #15 + root + stack-installer package.json + cli/package.json), memory_recall hit on Sprint 51.6 ship + CHANGELOG style. Baseline confirmed: termdeck@1.0.2, termdeck-stack@0.6.2, cli-internal@0.3.2 (private, not bumped). Awaiting [T1] DONE + [T2] DONE before staging the v1.0.3 wave (versions, CHANGELOG, files-array verify, test matrix, tarball verify). Will idle-poll every ~2 min until both lanes post DONE.

### [T4-CODEX] FINDING 2026-05-04 11:07 ET — independent repro: published `init --mnestra` aborts before hook refresh on petvetbid.

Boot constraints acknowledged: Codex has no `memory_recall` MCP in this runtime, so T4 used this append-only STATUS.md plus Sprint 51.6 lines 690-1060 as the durable substrate. Worktree at boot had only the sprint-51.7 docs untracked; no T1/T2 code WIP was present (`git status --short` showed `?? docs/sprint-51.7-wizard-wire-up-and-metadata/`).

**Source/control-flow evidence:**

- CLI dispatch is the expected user path: `/usr/local/bin/termdeck -> ../lib/node_modules/@jhizzard/termdeck/packages/cli/src/index.js`; `packages/cli/src/index.js:126-134` lazy-requires `init-mnestra.js` for `termdeck init --mnestra`.
- Installed global package is `@jhizzard/termdeck@1.0.2`.
- `packages/cli/src/init-mnestra.js:665-669` runs `checkExistingStore()`, `applyMigrations()`, `runMnestraAudit()`, then `writeYamlConfig()` before the hook refresh step.
- The hook refresh step starts only at `packages/cli/src/init-mnestra.js:675-690`.
- Therefore any thrown migration failure before line 675 prevents `refreshBundledHookIfNewer()` from firing.

**Independent reproduction through the published binary, temp HOME, stale TermDeck-marked hook:**

Fixture:

```sh
HOME=/tmp/t4-global-init-... /usr/local/bin/termdeck init --mnestra --from-env --skip-verify
```

The temp installed hook started as a two-line unsigned-but-TermDeck-marked legacy file:

```text
// TermDeck session-end memory hook (legacy, pre-stamp era)
// old body
```

Observed output:

```text
→ Connecting to Supabase... ✓
→ Checking for existing memory_items table... ✓ found (6,323 rows)
→ Applying migration 001_mnestra_tables.sql... ✗
    cannot change return type of existing function

[init --mnestra] Migration failed: 001_mnestra_tables.sql

[T4 global probe result] exit=5 before_wc=2 after_wc=2 backups=0
[T4 global probe sig after] <none>
```

This reproduces the user-path symptom without touching Joshua's real hook: the canonical CLI exits 5 before `init-mnestra.js:675`, the temp hook remains stale (2 LOC), no `@termdeck/stack-installer-hook` stamp appears, and no backup is written.

**Control probe: direct helper still works on the same fixture.**

```sh
HOME=/tmp/t4-helper-... node -e "const m=require('/usr/local/lib/node_modules/@jhizzard/termdeck/packages/cli/src/init-mnestra.js'); const r=m.refreshBundledHookIfNewer({dryRun:false}); console.log(JSON.stringify(r));"
```

returned:

```json
{"status":"refreshed","from":null,"to":1,"backup":"/tmp/t4-helper-.../.claude/hooks/memory-session-end.js.bak.20260504150648"}
```

Post-helper evidence:

```text
after_wc=740 backups=1
54: * @termdeck/stack-installer-hook v1
```

So T4 confirms the same split Sprint 51.6 Phase B saw: helper works in isolation, production CLI path does not reach it.

**Database/migration evidence for the abort:**

- `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-116` does `create or replace function match_memories(...) returns table (id, content, source_type, category, project, metadata, similarity)`.
- Existing petvetbid function signature is different:

```text
match_memories(vector,double precision,integer,text) | TABLE(id uuid, content text, metadata jsonb, source_type text, category text, project text, created_at timestamp with time zone, similarity double precision)
```

Postgres rejects `CREATE OR REPLACE FUNCTION` when the return type changes. `packages/server/src/setup/pg-runner.js:65-87` returns `{ ok:false, error }` for that failed file, and `packages/cli/src/init-mnestra.js:336-342` throws `Migration failed: 001_mnestra_tables.sql`, which is caught by the outer `init --mnestra` catch at `init-mnestra.js:714-717` and returns exit 5 before hook refresh.

**T4 disposition on T1 target:** Root cause is at least H1-class control-flow: `applyMigrations()` can abort before the refresh call. T1 should not close this as "refresh returned up-to-date/custom-hook-preserved" unless their instrumentation proves another independent branch too. Concrete fix direction: move hook refresh earlier than fallible DB migration replay or make it run in a `finally`/pre-DB best-effort phase once inputs are known. Separately, migration 001 replay on an existing modern Mnestra database is not idempotent against return-type drift; that is Class A/H migration-runner debt and should be captured if not fixed in this mini-sprint.

### [T4-CODEX] AUDIT 2026-05-04 11:07 ET — T1 test warning: `--dry-run` does not exercise hook refresh.

`packages/cli/src/init-mnestra.js:643-650` has a `flags.dryRun` branch that calls `applyMigrations(null, true)`, `writeYamlConfig(true)`, prints `Dry run complete. No changes were made.`, and returns `0` before the hook refresh block at `init-mnestra.js:675-690`.

T4 verified with a temp stale hook:

```sh
HOME=/tmp/t4-dryrun-... node packages/cli/src/index.js init --mnestra --from-env --dry-run --skip-verify
```

Output ended:

```text
→ Updating ~/.termdeck/config.yaml (rag.enabled: false, MCP-only default)... ✓ (dry-run)

Dry run complete. No changes were made.

[T4 dry-run probe] exit=0 after_wc=2 backups=0 sig=<none>
```

Therefore a new `packages/cli/tests/init-mnestra-cli-refresh.test.js` that relies on `--dry-run` will **not** catch the Sprint 51.6 Phase B failure. Acceptance gate for T1 should require a non-dry-run path with DB work stubbed/mocked, or a refactor that exposes a test-friendly non-DB path which still executes the same refresh call site.

### [T4-CODEX] AUDIT 2026-05-04 11:09 ET — T2 parser pre-check: count both `mcp__mnestra__memory_remember` and `mcp__memory__memory_remember`.

T2's brief correctly says not to string-match `Remember:` and to count `tool_use` blocks instead. T4 sampled local Claude transcript structure without printing user text. Current Claude JSONL shape has top-level timestamps and nested `message.content` tool-use blocks:

```json
{
  "messageRole": { "user": 67, "assistant": 103 },
  "topTimestamp": 394,
  "messageTimestamp": 0,
  "messageContentArray": 166,
  "messageToolNames": {
    "ToolSearch": 2,
    "Bash": 37,
    "mcp__mnestra__memory_recall": 2,
    "Read": 14,
    "Write": 7,
    "Edit": 1
  }
}
```

Actual `memory_remember` tool names in `~/.claude/projects` include both current and older/generic MCP prefixes:

```text
.../9093ca8f-904c-4c8a-ba47-5d287210f03a.jsonl:125:"name":"mcp__mnestra__memory_remember"
.../03b55630-8c96-445c-a76b-c34fea0d817b.jsonl:263:"name":"mcp__mnestra__memory_remember"
.../5b2cbc85-053e-492b-8799-63b85ee032ee.jsonl:87:"name":"mcp__memory__memory_remember"
.../f97f5f33-f8f1-43b2-ab27-f8d13676051d.jsonl:269:"name":"mcp__memory__memory_remember"
```

A scan of the 50 most-recent local `.jsonl` transcripts found `filesWithRemember=13` and these relevant counts:

```json
{
  "mcp__mnestra__memory_remember": 36,
  "mcp__memory__memory_remember": 36
}
```

**T4 disposition on T2 acceptance:** `parseTranscriptMetadata()` should count at least:

- `memory_remember`
- `mcp__mnestra__memory_remember`
- `mcp__memory__memory_remember`

and should have a fixture asserting the generic `mcp__memory__memory_remember` prefix. Otherwise v2 will undercount `facts_extracted` for existing real Claude transcripts even if it passes the two names listed in the lane brief.

### [T2] FINDING — 2026-05-04 11:11 ET — scope confirmed, v1-stamp survey clean, T4 pre-audit acknowledged

Boot complete. Read PLANNING.md, STATUS.md (T3 + T4-CODEX posts present), T2 brief, the bundled hook (740 LOC), INSTALLER-PITFALLS ledger entry #15. Memory recall pulled Sprint 51.6 context including the deliberate "minimum viable row" decision Codex called out at Phase B (started_at/duration_minutes/facts_extracted intentionally NULL/0).

Note T4-CODEX's parallel finding pins T1's root cause to `applyMigrations()` aborting on `001_mnestra_tables.sql` return-type drift — interesting context but out-of-lane for T2. My v1→v2 stamp bump is still load-bearing-as-insurance: even if T1 lands an early-refresh refactor, an installed-v1 user upgrading to bundled-v2 hits the upgrade branch via either path. T4-CODEX line 81 confirms current on-disk stamp is v1 (matches PLANNING baseline).

T4-CODEX 11:09 ET pre-audit on T2: confirms my plan to count BOTH `mcp__mnestra__memory_remember` AND `mcp__memory__memory_remember` (36 hits each across 50 sampled transcripts in `~/.claude/projects/`). Plus bare `memory_remember` for forward/backward compat. My intended parser already covers all three — fixture will include the generic `mcp__memory__memory_remember` line per T4's spec.

Pre-edit survey of `stack-installer-hook v1` references across the repo:

| File | Hits | Risk to v1→v2 bump |
|---|---|---|
| `packages/stack-installer/assets/hooks/memory-session-end.js:54` | 1 (the literal stamp) | **EDIT TARGET** |
| `tests/init-mnestra-hook-refresh.test.js` | 13 | **None** — every reference is a synthetic tmp-file fixture used to drive `_hookSignatureUpgradeAvailable` / `refreshBundledHookIfNewer`. Each test sets BOTH src and dest stamps explicitly; none assume bundled = v1. |
| `tests/stack-installer-hook-merge.test.js:1206-1217` | 1 generic check (`v >= 1`) | **None** — passes for any positive integer |
| `tests/project-taxonomy.test.js`, `tests/audit-upgrade.test.js`, `tests/per-agent-hook-trigger.test.js` | 0 stamp hits | **None** |
| `CHANGELOG.md`, `docs/sprint-51.6-…/STATUS.md` | hits | **None** — historical, do not edit |
| `docs/sprint-51.7-…/T2-…md` + `T4-…md` + `PLANNING.md` | hits | **None** — sprint docs reference the bump itself |

Net: only ONE production line changes. Test surface is naturally version-agnostic because Sprint 51.6 T3 wrote it that way (synthetic fixtures + `v >= 1` assertion). Stamp bump merges cleanly with T1's lane regardless of T1's chosen fix shape.

Real-transcript fixture sourced: `~/.claude/projects/.../03b55630-…jsonl` carries actual `mcp__mnestra__memory_remember` tool_use blocks. Top-level `timestamp` per line, `message.role`/`message.content` shape; tool_use blocks under `message.content[]`. Will scrub identifiers, write 8-line trimmed copy plus a synthesized line carrying `mcp__memory__memory_remember` (per T4's spec) to `packages/stack-installer/tests/fixtures/transcript-sample.jsonl`.

### [T2] FIX-PROPOSED — 2026-05-04 11:11 ET — design summary

1. Add pure helper `parseTranscriptMetadata(rawJsonl)` to `packages/stack-installer/assets/hooks/memory-session-end.js`. Returns `{startedAt, endedAt, durationMinutes, factsExtracted}`. Pure, no I/O, exported for tests. Counts ONLY `tool_use` blocks named `memory_remember` / `mcp__mnestra__memory_remember` / `mcp__memory__memory_remember` (conservative — no string-match on "Remember:" which would over-match quoted text).
2. Wire into `buildSummary()` — call `parseTranscriptMetadata(raw)` immediately after the existing parser run, merge result into the returned object via `{summary, messagesCount, ...metadata}`. No second readFileSync.
3. Add `startedAt` / `durationMinutes` / `factsExtracted` to `postMemorySession()` signature (default null/null/0) and the JSON body. Update outdated comment block that previously said "v1.0.2 ships the minimum viable row."
4. Update `processStdinPayload()` to destructure new fields off `built` and pass through. Prefer parser-derived `endedAt` over hook-fire-time when available (matches rag-system writer semantics — `ended_at` = last-message timestamp, not hook-invocation time); fall back to `new Date()` when transcript carries no timestamps.
5. Bump `* @termdeck/stack-installer-hook v1` → `v2` at line 54.
6. Add `parseTranscriptMetadata` to module.exports.
7. New unit test file `packages/stack-installer/tests/hook-metadata-parser.test.js` — 6 brief-required cases (empty / single / 30-min / malformed-line / 3 memory_remember / 1 memory_remember + 1 Bash) plus 3 bonus (`mcp__mnestra__memory_remember` legacy-MCP-name match, `mcp__memory__memory_remember` legacy-MCP-name match per T4 11:09 ET, real-fixture sanity check on the trimmed transcript).
8. New fixture `packages/stack-installer/tests/fixtures/transcript-sample.jsonl` (8 scrubbed real lines + 1 synthesized line carrying `mcp__memory__memory_remember`).
9. Run targeted set: `tests/init-mnestra-hook-refresh.test.js`, `tests/stack-installer-hook-merge.test.js`, `tests/project-taxonomy.test.js`, plus the new unit file.

Beginning FIX-LANDED.

### [T4-CODEX] AUDIT 2026-05-04 11:12 ET — T2 WIP blocker: parser exists but metadata is not wired to the POST yet.

T4 audited the in-progress diff before T2 FIX-LANDED. Current WIP has a good start but is not yet acceptable:

**Good WIP:**

- Stamp bumped to v2 at `packages/stack-installer/assets/hooks/memory-session-end.js:64`.
- `FACT_TOOL_NAMES` includes all three required names at `memory-session-end.js:482-486`: `memory_remember`, `mcp__mnestra__memory_remember`, `mcp__memory__memory_remember`.
- `parseTranscriptMetadata(rawJsonl)` at `memory-session-end.js:488-535` reads top-level `timestamp` first, falls back to `msg.message.timestamp`, skips malformed JSONL, computes `durationMinutes`, and counts tool_use blocks conservatively.

**Blockers before T2 can post FIX-LANDED:**

1. `postMemorySession()` signature is unchanged at `memory-session-end.js:672-678`; it still accepts only `endedAt`, not `startedAt`, `durationMinutes`, or `factsExtracted`.
2. The POST body still omits all three required fields. `memory-session-end.js:696-710` still sends `ended_at`, `messages_count`, `transcript_path`, then the old v1 comment saying `started_at, duration_minutes, facts_extracted` are intentionally omitted.
3. `processStdinPayload()` destructures only `{ summary, messagesCount }` at `memory-session-end.js:784-787`; parser-derived `endedAt`, `startedAt`, `durationMinutes`, and `factsExtracted` are dropped.
4. `processStdinPayload()` still calls `postMemorySession(... endedAt: new Date())` at `memory-session-end.js:804-814`, so even parser-derived `endedAt` is not used.
5. `parseTranscriptMetadata` is not exported in `module.exports` (`memory-session-end.js:831-854`), so the planned unit test file cannot import it.
6. No `packages/stack-installer/tests/hook-metadata-parser.test.js` and no `packages/stack-installer/tests/fixtures/transcript-sample.jsonl` exist yet (`git status --short` shows only the hook file modified plus sprint docs).

**T4 disposition:** Do not accept T2 FIX-LANDED until the parser output reaches the actual `/rest/v1/memory_sessions?on_conflict=session_id` body and tests assert those body fields. A parser that only enriches `buildSummary()` but is dropped before `postMemorySession()` will still ship v2 rows with `started_at=NULL`, `duration_minutes=NULL`, and `facts_extracted=0/omitted`.

### [T1] FINDING 2026-05-04 11:20 ET — H1 confirmed by file-mtime forensics + stub-deps harness; T4-CODEX independently pinned the throw site to mig 001.

**Independent corroboration of T4-CODEX's repro at 11:07 ET.** I bisected via two paths:

**(a) File-mtime forensics — Joshua's Phase B run never reached `writeYamlConfig`.**

```
$ stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S %Z" \
    ~/.termdeck/config.yaml \
    ~/.termdeck/config.yaml.2026-05-01T19-01-19-571Z.bak \
    ~/.termdeck/config.yaml.2026-05-01T19-01-27-097Z.bak
2026-05-01 15:01:27 EDT
2026-05-01 15:01:19 EDT
2026-05-01 15:01:27 EDT
```

`~/.termdeck/config.yaml` last touched `2026-05-01 15:01:27 EDT`. Phase B was `2026-05-03 ~21:14 ET`. `writeYamlConfig()` calls `yaml.updateRagConfig() → backup()` which ALWAYS creates a timestamped `.bak` when `config.yaml` exists. There is NO `.bak.2026-05-03*` file. Therefore `writeYamlConfig` (init-mnestra.js:669) did not fire on Phase B → control flow stopped before line 669.

Of the call sites between 663 (try) and 669 (writeYamlConfig):

- `checkExistingStore` (666) — re-throws on pg query error.
- `applyMigrations` (667) — throws on first migration failure.
- `runMnestraAudit` (668) — internal try/catch; cannot throw outward.

T4-CODEX's 11:07 ET fixture against `init-mnestra.js:336-342` reproduced exactly:

```
→ Applying migration 001_mnestra_tables.sql... ✗
    cannot change return type of existing function
[init --mnestra] Migration failed: 001_mnestra_tables.sql
```

Outer catch at `init-mnestra.js:714-717` fires, returns 5, refresh at line 677 never reached.

**(b) Stub-deps harness — wire-up logic itself is correct.** Bisect script `/tmp/bisect-wireup.js` monkey-patches `pgRunner` / `migrations` / `auditUpgrade` / `yaml` / `preconditions` to be successful no-ops, then calls `main(['--from-env', '--skip-verify'])` against tmp HOME pre-seeded with Joshua's actual `.bak.20260504011632` (the 508-LOC pre-Sprint-50 hook).

```
→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ refreshed v0 → v1 (backup: memory-session-end.js.bak.20260504151106)
[bisect] main() returned: 0
[bisect] hook refreshed: true (size=30811)
[bisect] backup exists: true
```

Wire-up at lines 675-690 fires correctly when control reaches it. Bug is upstream coupling, not the call site.

**Hypothesis disposition:**

- **H1 (control flow drops out before line 677): CONFIRMED.** Specifically: `applyMigrations` throws on `001_mnestra_tables.sql` (T4-CODEX) — the `CREATE OR REPLACE FUNCTION match_memories(...)` return-type drift on petvetbid (existing fn returns `TABLE(id uuid, content text, metadata jsonb, source_type text, category text, project text, created_at timestamptz, similarity double precision)`, bundled mig 001 wants different ordering). Postgres rejects with `cannot change return type of existing function`.
- H2/H3/H4/H5 — ruled out for Joshua/Brad. The function works in isolation (`node -e` returned `would-refresh` per Sprint 51.6 21:14 ET T4-CODEX evidence) and works in the stubbed harness.

**Compound class:** This bug is **Class M (architectural omission of resilience)** layered on **Class A (schema-drift in migration replay)**. The migration-replay bug is real and worth tracking (the bundled `match_memories` signature has drifted from the historical petvetbid signature; users with an older mig 001 applied see CREATE OR REPLACE fail). But T1's lane scope is the **wire-up coupling** — the hook refresh should not be downstream of fragile DB-replay. T1 fixes the coupling; the migration-001 drift goes to followup (sprint-52 backlog candidate, see SIDE-FINDING below).

### [T1] FIX-PROPOSED 2026-05-04 11:21 ET — move `refreshBundledHookIfNewer` upstream of all DB work; gate test-friendly tracing behind `TERMDECK_DEBUG_WIREUP=1`.

**Architectural decision:** decouple the hook refresh from DB success.

The hook refresh is a LOCAL filesystem operation. It does not need pg, migrations, audit, yaml, or verify to have succeeded. Its only dependency is "user has typed in inputs" (or `--from-env` is set), which is true the moment we reach line 642 (after `writeSecretsFile`). Putting it after `writeSecretsFile` and before `Connecting to Supabase...` makes it resilient to every Class A schema-drift bug that has historically broken `applyMigrations` re-runs.

**Concrete plan:**

1. **Extract** the refresh logic at `packages/cli/src/init-mnestra.js:670-690` into a small inline block right after `writeSecretsFile` (line ~641). Pass `flags.dryRun` so dry-run mode reports `would-refresh` / `would-install` without writing.
2. **Remove** the now-duplicate refresh block at lines 670-690 (the old DB-coupled location).
3. **Restructure** `--dry-run` to NOT short-circuit before the refresh — currently lines 643-650 return 0 before reaching line 677, which is why T4-CODEX 11:07 ET dry-run probe also missed refresh. After step 1, dry-run naturally exercises the refresh because it's now upstream of the dry-run early-return.
4. **Add** a `TERMDECK_DEBUG_WIREUP=1` env gate that emits `[wire-up-debug]` stderr lines at: pre-refresh entry (HOOK_DEST, HOOK_SOURCE, bundled stamp, installed stamp), post-refresh status, and at the outer try-block entry/exit. Gated so production users never see noise. Useful for any future repro.
5. **Add** new test `tests/init-mnestra-cli-refresh.test.js` that SPAWNS the binary (`node packages/cli/src/index.js init --mnestra --from-env --dry-run`) against tmp HOME with a stale TermDeck-marked hook, with port-1 ECONNREFUSED `DATABASE_URL`. Asserts: (a) refresh status appears in stdout, (b) hook file changed (or `would-refresh` for dry-run mode), (c) backup file created. The test would have caught Sprint 51.6 Phase B failure pre-publish because it exercises the wire-up under realistic-failure conditions (DB unreachable) — exactly the conditions that strand the current implementation.

**SIDE-FINDING for orchestrator (out of T1 lane scope, file as backlog item):** `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-116` does `CREATE OR REPLACE FUNCTION match_memories(...) RETURNS TABLE(id, content, source_type, category, project, metadata, similarity)` but petvetbid's existing function returns `TABLE(id, content, metadata, source_type, category, project, created_at, similarity)`. Postgres rejects on column-order/extra-column drift. This is **Class A migration-replay drift** that has historically been silent (no users hit `init --mnestra` against an existing v1.0.0+ Mnestra DB until now). Suggested fix: wrap the function in `DROP FUNCTION IF EXISTS match_memories(vector, ...) CASCADE;` before `CREATE OR REPLACE`, or add a `do$$ ... $$` guard that drops the existing function when signature drift is detected. **Out of T1 lane scope; will not address in this sprint.** Captured here for orchestrator backlog.

Beginning FIX-LANDED.

### [T4-CODEX] AUDIT 2026-05-04 11:13 ET — T2 WIP blocker narrowed: flat `content[]` tool_use blocks are still missed.

T2 fixed the 11:12 wiring blocker in current WIP:

- `postMemorySession()` now accepts `startedAt`, `durationMinutes`, `factsExtracted` at `packages/stack-installer/assets/hooks/memory-session-end.js:672-686`.
- POST body now sends `started_at`, `duration_minutes`, `facts_extracted` at `memory-session-end.js:704-721`.
- `processStdinPayload()` now destructures parser metadata at `memory-session-end.js:784-793` and passes it to `postMemorySession()` at `memory-session-end.js:818-831`.
- `parseTranscriptMetadata` is exported at `memory-session-end.js:871-873`.

Remaining parser edge case from T4 brief Phase 2: "nested `message.content` arrays vs flat `content` arrays vs no content." Current parser only checks nested `msg.message.content`:

```js
const blocks = (msg.message && Array.isArray(msg.message.content))
  ? msg.message.content
  : null;
```

at `memory-session-end.js:515-519`.

T4 probe:

```sh
node -e "const { parseTranscriptMetadata } = require('./packages/stack-installer/assets/hooks/memory-session-end.js'); const rows=[{timestamp:'2026-05-04T00:00:00Z', role:'assistant', content:[{type:'tool_use', name:'memory_remember'}]},{timestamp:'2026-05-04T00:01:00Z', message:{role:'assistant', content:[{type:'tool_use', name:'memory_remember'}]}}]; console.log(JSON.stringify(parseTranscriptMetadata(rows.map(JSON.stringify).join('\n'))));"
```

Observed:

```json
{"startedAt":"2026-05-04T00:00:00.000Z","endedAt":"2026-05-04T00:01:00.000Z","durationMinutes":1,"factsExtracted":1}
```

Expected for this fixture: `factsExtracted=2` because both rows carry a memory_remember `tool_use`; one is nested under `message.content[]`, the other is flat top-level `content[]`.

**T4 disposition:** T2 should support `msg.content[]` as well as `msg.message.content[]` before FIX-LANDED, and add a unit test for the flat-content shape. Optional but prudent: support Codex-style `msg.payload.content[]` if `msg.type === 'response_item'`, because the hook already supports Codex summaries via `parseCodexJsonl`.

### [T4-CODEX] AUDIT 2026-05-04 11:18 ET — T2 parser blocker closed, remaining test blocker: POST body fields not asserted.

T2's current WIP closes the 11:13 parser-shape blocker:

- `extractContentBlocks()` now handles nested Claude `msg.message.content[]`, flat `msg.content[]`, and Codex `response_item.payload.content[]` at `packages/stack-installer/assets/hooks/memory-session-end.js:489-509`.
- T4's mixed flat+nested probe now returns `factsExtracted=2`:

```json
{"startedAt":"2026-05-04T00:00:00.000Z","endedAt":"2026-05-04T00:01:00.000Z","durationMinutes":1,"factsExtracted":2}
```

- New parser tests cover flat and Codex shapes at `packages/stack-installer/tests/hook-metadata-parser.test.js:256-303`.
- T4 ran `node --test packages/stack-installer/tests/hook-metadata-parser.test.js`: `21` tests, `21` pass.
- T4 ran `node --test tests/stack-installer-hook-merge.test.js tests/init-mnestra-hook-refresh.test.js tests/project-taxonomy.test.js`: `112` tests, `112` pass.

Remaining T2 acceptance gap: no test asserts that the new metadata fields reach the actual Supabase `memory_sessions` POST body.

Evidence:

- `tests/stack-installer-hook-merge.test.js:1057-1117` end-to-end `processStdinPayload` test still generates transcript lines with no timestamps and no memory_remember tool_use blocks (`lines.push(JSON.stringify({ message: { role, content: 'x'.repeat(300) } }))` at lines 1063-1066). It asserts only `messages_count`, `transcript_path`, and generic `ended_at`; it does **not** assert `started_at`, `duration_minutes`, or `facts_extracted`.
- `tests/stack-installer-hook-merge.test.js:1122-1155` direct `postMemorySession` test still does not pass `startedAt`, `durationMinutes`, or `factsExtracted`, and does not assert body keys `started_at`, `duration_minutes`, or `facts_extracted`.
- Repo grep confirms only old assertions:

```text
tests/stack-installer-hook-merge.test.js:1115: assert.match(sessionCall.body.ended_at, ...)
tests/stack-installer-hook-merge.test.js:1138: assert.match(body.ended_at, ...)
```

No test currently fails if `processStdinPayload()` drops parser metadata before `postMemorySession()` again, or if `postMemorySession()` omits the new JSON fields.

**T4 disposition:** T2 should add one of these before FIX-LANDED:

1. Update the end-to-end `processStdinPayload` test transcript to include timestamps and at least one `memory_remember` `tool_use`, then assert `sessionCall.body.started_at`, `duration_minutes`, and `facts_extracted`.
2. Or update the direct `postMemorySession` unit test to pass `startedAt`, `durationMinutes`, `factsExtracted` and assert the serialized body fields.

Best is both: one unit assertion for the serializer and one e2e assertion that parser metadata flows through `buildSummary()` → `processStdinPayload()` → `postMemorySession()`.

### [T4-CODEX] AUDIT 2026-05-04 11:19 ET — T1 WIP blocker: `runHookRefresh()` is dead code; old DB-coupled refresh remains.

T4 audited T1's current WIP after `[T1] FIX-PROPOSED`. The implementation has not yet moved the refresh upstream.

Evidence:

- New helper exists at `packages/cli/src/init-mnestra.js:602-639`.
- `rg -n "runHookRefresh\\(|refreshBundledHookIfNewer\\(\\{ dryRun" packages/cli/src/init-mnestra.js` returns:

```text
602:function runHookRefresh({ dryRun = false } = {}) {
612:    const r = refreshBundledHookIfNewer({ dryRun });
741:      const r = refreshBundledHookIfNewer({ dryRun: false });
```

- There is no `runHookRefresh(...)` call site outside the helper definition.
- `main()` still goes from `writeSecretsFile()` at `init-mnestra.js:697-705` directly to `step('Connecting to Supabase...')` at `init-mnestra.js:707`.
- The dry-run early-return is still before any refresh at `init-mnestra.js:707-714`.
- The only actual refresh remains the old DB-coupled block at `init-mnestra.js:734-754`, after `applyMigrations()` at line 731. That means T4's reproduced migration-001 abort still returns exit 5 before hook refresh.
- No new `tests/init-mnestra-cli-refresh.test.js` exists yet (`find . -path '*init-mnestra-cli-refresh.test.js' -print` returned no files).

**T4 disposition:** T1 must not post FIX-LANDED until:

1. `runHookRefresh({ dryRun: flags.dryRun })` is called immediately after `writeSecretsFile()`.
2. The old block at `init-mnestra.js:734-754` is removed.
3. `--dry-run` output includes `would-refresh` / `would-install` before the dry-run DB skip.
4. A binary-spawn integration test exists and fails on the current WIP.

### [T4-CODEX] AUDIT 2026-05-04 11:23 ET — T1 code blocker closed; integration-test blocker remains.

T1 fixed the 11:19 dead-code blocker in current WIP.

**Source evidence:**

- `runHookRefresh({ dryRun: flags.dryRun })` now runs immediately after `writeSecretsFile()` at `packages/cli/src/init-mnestra.js:707-716`.
- Dry-run early-return is now after hook refresh at `init-mnestra.js:718-724`.
- Old DB-coupled refresh block after `writeYamlConfig(false)` is removed; `init-mnestra.js:740-750` now contains only a comment pointing to the upstream call site.

**T4 dry-run probe (temp HOME, stale TermDeck-marked hook):**

```text
→ Writing ~/.termdeck/secrets.env... ✓ (dry-run)
→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ would-refresh v0 → v2 (dry-run)
→ Connecting to Supabase... ✓ (dry-run, skipped)
...
Dry run complete. No changes were made.

[T4 T1 dry-run probe] exit=0 after_wc=2 backups=0 sig=<none>
```

This closes T4's 11:07 dry-run critique: dry-run now exercises the refresh decision and reports `would-refresh`.

**T4 live-failure probe (temp HOME, stale TermDeck-marked hook, real petvetbid DB):**

```text
→ Writing ~/.termdeck/secrets.env... ✓
→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ refreshed v0 → v2 (backup: memory-session-end.js.bak.20260504152308)
→ Connecting to Supabase... ✓
→ Checking for existing memory_items table... ✓ found (6,324 rows)
→ Applying migration 001_mnestra_tables.sql... ✗
    cannot change return type of existing function

[init --mnestra] Migration failed: 001_mnestra_tables.sql

[T4 T1 live-fail probe] exit=5 after_wc=898 backups=1
[T4 T1 live-fail sig] 64: * @termdeck/stack-installer-hook v2
```

This is the desired resilience behavior for the sprint bug: even though the known migration-001 replay failure still returns exit 5, the local hook refresh has already landed v2 with a backup.

**Remaining T1 gate:** no `tests/init-mnestra-cli-refresh.test.js` exists yet (`find . -path '*init-mnestra-cli-refresh.test.js' -print` returned no files). T1 should still add the promised binary-spawn integration test before FIX-LANDED; otherwise the exact class of bug has no regression coverage.

### [T2] FIX-LANDED — 2026-05-04 11:23 ET — multi-shape parser + POST-body assertions per T4-CODEX 11:13 + 11:18 ET catches

T4-CODEX caught two real gaps in two separate audits before I posted FIX-LANDED:

**11:13 ET catch — multi-shape content extraction.** v1 of my parser only read `msg.message.content[]` (Claude shape), missing `msg.content[]` (Grok flat) and `msg.payload.content[]` (Codex `response_item`). Both shapes are produced by adapters this hook already ships parsers for. Under-counting on those would silently shrink `facts_extracted` whenever a non-Claude session writes to memory_sessions. **Fixed** at `packages/stack-installer/assets/hooks/memory-session-end.js:489-509` with new `extractContentBlocks(msg)` helper handling all three shapes plus null-safety on string content / missing content. T4's repro probe (mixed flat+nested) now returns `factsExtracted=2` (was 1 pre-fix). Three new unit tests pin the behavior.

**11:18 ET catch — POST-body assertions missing.** New unit tests covered `parseTranscriptMetadata` in isolation, but neither the integration test (`processStdinPayload end-to-end`) nor the direct `postMemorySession` unit test asserted that `started_at` / `duration_minutes` / `facts_extracted` actually reach the JSON body. A regression dropping parser metadata between `buildSummary()` and `postMemorySession()` would slip through silently. **Fixed** by:
- Updating the integration-test fixture to include timestamps (24-min span 20:00-20:24 UTC) + 1 `memory_remember` tool_use; added 4 new assertions on `started_at`, `ended_at`-as-parser-derived, `duration_minutes`, `facts_extracted`. `tests/stack-installer-hook-merge.test.js:1057-1126`.
- Updating the direct `postMemorySession` unit test to pass `startedAt: '2026-05-03T19:30:00.000Z'`, `durationMinutes: 30`, `factsExtracted: 5`; added 3 new body assertions for those keys. `tests/stack-installer-hook-merge.test.js:1131-1180`.
- New separate test pinning the v1-compat default path: when caller omits the new fields, body still serializes with `null/null/0` (not absent). Guards against future contract drift.

### [T2] FIX-LANDED — 2026-05-04 11:23 ET — full deliverable summary

**Files changed:**

| File | Change | LOC delta |
|---|---|---|
| `packages/stack-installer/assets/hooks/memory-session-end.js` | (1) Stamp `v1`→`v2` at line 64. (2) New `parseTranscriptMetadata(rawJsonl)` + `FACT_TOOL_NAMES` Set + `extractContentBlocks(msg)` helper at lines ~482-535 (all three exported). (3) `buildSummary` merges parser metadata into return object. (4) `postMemorySession` signature gains `startedAt`/`durationMinutes`/`factsExtracted` (defaults `null`/`null`/`0`); body serializes them. (5) `processStdinPayload` destructures parser metadata off `built` and prefers parser-derived `endedAt` (last-message timestamp) over `new Date()` when present. (6) Three new module exports. | 740 → 898 (+190 / −16) |
| `packages/stack-installer/tests/hook-metadata-parser.test.js` (NEW) | 21 tests: brief-required (empty / single / span / malformed / 3-remember / remember+Bash) + T4-CODEX 11:09 catch (legacy MCP name) + T4-CODEX 11:13 catch (flat shape, Codex shape, `extractContentBlocks` helper) + defensive cases (null/undefined, substring false-positive, tool_result-not-counted, `Remember:` text false-positive, `msg.message.timestamp` fallback, invalid timestamp string, sub-30s rounding) + real-fixture roundtrip. | 329 |
| `packages/stack-installer/tests/fixtures/transcript-sample.jsonl` (NEW) | 8 lines from `~/.claude/projects/.../03b55630-…jsonl` with all user-content scrubbed to placeholders. 3 memory_remember tool_use lines (mnestra + memory + bare), 1 Bash tool_use (must NOT inflate count), 1 tool_result (must NOT inflate count). Span 10:00:00→10:15:00 UTC = 15 min. Expected: `factsExtracted=3`, `durationMinutes=15`. | 8 |
| `tests/stack-installer-hook-merge.test.js` | T4-CODEX 11:18 ET catch: integration test fixture rewritten with timestamps + 1 memory_remember; 4 new POST-body assertions on the new metadata fields. Direct `postMemorySession` unit test passes new fields + asserts body. New v1-compat default-path test. | +71 / −10 |

**Version stamp confirmation:**

```text
$ grep -n "@termdeck/stack-installer-hook v1" packages/
(zero hits — production code is fully on v2)
$ grep -n "@termdeck/stack-installer-hook v2" packages/
packages/stack-installer/assets/hooks/memory-session-end.js:64: * @termdeck/stack-installer-hook v2
```

**Test counts (pass/fail before vs after T2):**

| Suite | Before T2 | After T2 |
|---|---|---|
| `packages/stack-installer/tests/hook-metadata-parser.test.js` (NEW) | n/a | 21/21 ✓ |
| `tests/stack-installer-hook-merge.test.js` | 71/71 | 72/72 ✓ (added 1, modified 2) |
| `tests/init-mnestra-hook-refresh.test.js` | 16/16 | 16/16 ✓ |
| `tests/project-taxonomy.test.js` | 25/25 | 25/25 ✓ |
| **Combined targeted matrix** | **112** | **134/134 ✓** |

**Lane discipline confirmed:**

```text
$ git status --short
 M packages/cli/src/init-mnestra.js               # T1's lane (not me)
 M packages/stack-installer/assets/hooks/memory-session-end.js  # T2 (mine)
 M tests/stack-installer-hook-merge.test.js       # T2 — added body assertions
?? docs/sprint-51.7-wizard-wire-up-and-metadata/  # sprint docs
?? packages/stack-installer/tests/fixtures/       # T2 fixture
?? packages/stack-installer/tests/hook-metadata-parser.test.js  # T2 new tests
```

T2 did NOT touch: `packages/cli/src/init-mnestra.js` (T1's lane — visible in `git status` because T1 landed concurrently), any `package.json` (T3's lane), `CHANGELOG.md` (T3's lane). No commits made by T2.

**Fixture redaction note:** All user/assistant text replaced with literal `<scrubbed>` / `<scrubbed assistant text>` / `<scrubbed result>` etc. JSON structure preserved verbatim — `parentUuid`, `sessionId` (set to `"fixture-sample"`), `timestamp`, `message.role`, `message.content[]` shape, `tool_use` block shape with `id`/`name`/`input` keys present. Tool inputs are also scrubbed to placeholder strings. No real session IDs, file paths, or transcript content survives in the fixture.

### [T2] DONE — 2026-05-04 11:23 ET

Sprint 51.7 T2 acceptance per PLANNING.md §3 + §4:

- ✅ **Acceptance #3 — transcript-parsing metadata population:** `parseTranscriptMetadata(rawJsonl)` extracts `startedAt` / `endedAt` / `durationMinutes` / `factsExtracted` from per-message timestamps and `tool_use` blocks. Wired into `buildSummary` and `postMemorySession`. New `memory_sessions` rows from the v2 bundled hook carry non-NULL metadata when transcript timestamps are present, NULL/0 fallback when they're absent (preserves v1 contract for fixture-style transcripts). Unit tests cover edge cases including the multi-adapter content-shape support T4-CODEX caught.
- ✅ **Acceptance #4 — version stamp v1 → v2:** Bumped at `packages/stack-installer/assets/hooks/memory-session-end.js:64`. Zero v1 hits in `packages/`. Insurance for T1's wire-up bug regardless of T1's chosen fix shape.
- ✅ **Out of lane (correctly avoided):** no `packages/cli/src/init-mnestra.js` edits (T1), no `package.json` version bumps (T3), no `CHANGELOG.md` edits (T3), no commits.

T3: green to integrate T2's deliverables. T4-CODEX: post-FIX-LANDED audit window open.

@T4-CODEX: thanks for the three pre-FIX-LANDED catches at 11:09 ET (count both MCP-name prefixes), 11:13 ET (multi-shape content extraction), and 11:18 ET (POST-body assertions). All three were real and would have shipped silent under-counting / silent regression-vulnerability into v1.0.3. Each one landed in the WIP before STATUS.md saw a `[T2] FIX-LANDED`. This is the 3+1+1 pattern paying off — none of these would have made it into a Sprint 51.5-style all-Claude lane without an independent auditor reading WIP rather than waiting for DONE.

### [T4-CODEX] VERIFY 2026-05-04 11:24 ET — T2 FIX-LANDED verified; T1 WIP code/tests green, awaiting T1 status post.

**T2 verification result: PASS.**

T4 independently verified T2's final claims:

- Stamp is v2 at `packages/stack-installer/assets/hooks/memory-session-end.js:64`.
- `FACT_TOOL_NAMES` contains `memory_remember`, `mcp__mnestra__memory_remember`, and `mcp__memory__memory_remember`.
- `extractContentBlocks()` handles nested Claude `message.content[]`, flat `content[]`, and Codex `response_item.payload.content[]`.
- `postMemorySession()` serializes `started_at`, `duration_minutes`, and `facts_extracted`.
- `processStdinPayload()` passes parser metadata through to `postMemorySession()` and uses parser-derived `ended_at`.
- `tests/stack-installer-hook-merge.test.js:1057-1148` now asserts parser-derived metadata reaches the actual memory_sessions POST body.
- `tests/stack-installer-hook-merge.test.js:1153-1197` now asserts direct `postMemorySession()` serialization of the new fields.
- `tests/stack-installer-hook-merge.test.js:1199-1220` pins v1-compat defaults `null/null/0`.
- Fixture `packages/stack-installer/tests/fixtures/transcript-sample.jsonl` is scrubbed: placeholder content only (`<scrubbed>` values), `sessionId:"fixture-sample"`, no real paths or transcript text.

T4 test runs:

```text
node --test packages/stack-installer/tests/hook-metadata-parser.test.js
# 21 tests, 21 pass

node --test tests/stack-installer-hook-merge.test.js tests/init-mnestra-hook-refresh.test.js tests/project-taxonomy.test.js
# 112 tests, 112 pass
```

Combined targeted matrix after T1/T2 WIP:

```text
node --test packages/stack-installer/tests/hook-metadata-parser.test.js \
  tests/stack-installer-hook-merge.test.js \
  tests/init-mnestra-hook-refresh.test.js \
  tests/init-mnestra-cli-refresh.test.js \
  tests/project-taxonomy.test.js
# 140 tests, 140 pass
```

**T1 WIP verification result: code behavior PASS; status still pending.**

T4 verified:

- `runHookRefresh({ dryRun: flags.dryRun })` is now upstream of DB work at `packages/cli/src/init-mnestra.js:707-716`.
- Dry-run reports `would-refresh` before the DB skip.
- Live temp-HOME probe against petvetbid refreshes stale hook to v2 before the known `001_mnestra_tables.sql` failure.
- New root-level `tests/init-mnestra-cli-refresh.test.js` exists and was included in the 140/140 targeted pass.

Minor note for T3/orchestrator: the T1 test lives at `tests/init-mnestra-cli-refresh.test.js`, not `packages/cli/tests/init-mnestra-cli-refresh.test.js` as the lane brief named. This matches the existing repo pattern (`tests/init-mnestra-hook-refresh.test.js`) and the test matrix includes it, but T3's tarball/checklist text should reference the actual path.

### [T1] FIX-LANDED 2026-05-04 11:25 ET — refresh decoupled from DB phase, gated stderr trace, CLI-binary integration test pinning the wire-up.

**Root cause (durable record):** `refreshBundledHookIfNewer()` was syntactically wired into `init-mnestra.js:677` but **architecturally coupled** to a fragile prerequisite chain — `pgRunner.connect` + 17-migration replay + `runMnestraAudit` + `writeYamlConfig` had to ALL succeed before refresh could fire. Joshua's 2026-05-03 Phase B run threw at `applyMigrations()` on `001_mnestra_tables.sql` (the `match_memories` `CREATE OR REPLACE FUNCTION` return-type drift on petvetbid; T4-CODEX 11:07 ET pinned the exact SQL error: `cannot change return type of existing function`). Outer catch fired, returned exit 5, refresh never reached. Brad's jizzard-brain reproduced the same. Confirmed by file-mtime forensics (`~/.termdeck/config.yaml` last touched `2026-05-01 15:01:27 EDT` — no `.bak.2026-05-03*` from Phase B → `writeYamlConfig` did not fire → control flow stopped before line 669) AND stub-deps harness (`/tmp/bisect-wireup.js` confirmed wire-up logic at lines 675-690 was structurally correct — bug was upstream coupling, not the call site).

**Fix shape:**

- New `runHookRefresh({ dryRun })` helper at `packages/cli/src/init-mnestra.js:573-636`. Encapsulates the step()/refreshBundledHookIfNewer/branch-print/error-handle pattern. Adds explicit `would-refresh` and `would-install` branches so dry-run reports match user intent.
- Call site at `init-mnestra.js:716` — right after the `writeSecretsFile` try/catch, BEFORE `step('Connecting to Supabase...')`. Hook refresh is local FS work; decoupling means a failed DB phase doesn't strand the bundled-hook upgrade.
- Removed the post-`writeYamlConfig` refresh block at the old line 670-690. Replaced with a 5-line back-pointer comment so future readers understand the intent. Verify block at `init-mnestra.js:746-771` unchanged.
- `--dry-run` now exercises the refresh path (it didn't before — Sprint 51.6 Phase B's dry-run-doesn't-fire issue T4-CODEX 11:07 ET flagged is also closed). Refresh fires upstream of the dry-run early-return, so `termdeck init --mnestra --dry-run` truthfully reports `would-refresh v0 → v2 (dry-run)` against a stale-marked installed hook.
- Stderr instrumentation gated behind `TERMDECK_DEBUG_WIREUP=1`. Emits `[wire-up-debug]` traces at refresh entry (HOOK_DEST + HOOK_SOURCE + exists checks), refresh return (full status JSON), and on throw (full stack). Silent by default; useful for any future wire-up bisect.

**Files changed:**

| File | Lines | What changed |
|---|---|---|
| `packages/cli/src/init-mnestra.js` | +88 / −24 | New `runHookRefresh()` helper (573-636); new call site (716) with explanatory comment (706-715); removed old refresh block (formerly 670-690); back-pointer comment (745-749). |
| `tests/init-mnestra-cli-refresh.test.js` (NEW) | +236 | 6 tests: (1) wire-up upstream-of-DB proof via port-1 ECONNREFUSED, (2) dry-run reports `would-refresh` without writing, (3) up-to-date case is idempotent, (4) custom-hook-preserved safety gate, (5) `TERMDECK_DEBUG_WIREUP=1` emits gated stderr, (6) env-var-unset is silent. |

**Test counts (pass/fail before vs after T1):**

| Suite | Before T1 | After T1 |
|---|---|---|
| `tests/init-mnestra-cli-refresh.test.js` (NEW) | n/a | 6/6 ✓ |
| `tests/init-mnestra-hook-refresh.test.js` | 16/16 | 16/16 ✓ |
| `tests/init-mnestra-resume.test.js` | 6/6 | 6/6 ✓ |
| `tests/stack-installer-hook-merge.test.js` | 71/71 | 72/72 ✓ (T2's +1) |
| `tests/audit-upgrade.test.js` | 14/14 | 14/14 ✓ |
| `tests/migration-loader-precedence.test.js` | 10/10 | 10/10 ✓ |
| **Targeted T1 matrix** | **117/117** | **124/124 ✓ (+7)** |

**The wire-up assertion (test #1) would have caught Sprint 51.6 Phase B pre-publish.** Spawning the actual binary against tmp HOME with a stale TermDeck-marked hook and an unreachable `DATABASE_URL` (`postgres://...@127.0.0.1:1/...` — guaranteed ECONNREFUSED) reproduces the canonical user-path failure mode. The test asserts:

1. `pg connect` fails with exit 3 (proves DB phase ran),
2. `→ Refreshing... ✓ refreshed v0 → v<n>` appears in stdout (proves refresh fired),
3. `Refreshing` line precedes `Connecting to Supabase` line in stdout order (proves architectural ordering),
4. The hook file content actually changed on disk (proves write happened),
5. A timestamped `.bak.YYYYMMDDhhmmss` exists with the original stale body (proves backup happened).

Pre-fix, this test would have failed assertions 2-5 because refresh was downstream of the failing connect. Post-fix, all 5 assertions pass.

**Lane discipline:**

```text
$ git status --short
 M packages/cli/src/init-mnestra.js                 # T1 (mine)
 M packages/stack-installer/assets/hooks/memory-session-end.js  # T2's lane
 M tests/stack-installer-hook-merge.test.js         # T2's lane
?? docs/sprint-51.7-wizard-wire-up-and-metadata/    # sprint docs
?? packages/stack-installer/tests/fixtures/         # T2's fixture
?? packages/stack-installer/tests/hook-metadata-parser.test.js  # T2's tests
?? tests/init-mnestra-cli-refresh.test.js           # T1 (mine, NEW)
```

T1 did NOT touch: `packages/stack-installer/assets/hooks/memory-session-end.js` (T2's lane), any `package.json` (T3's lane), `CHANGELOG.md` (T3's lane). No commits made by T1.

**Side-finding (out of T1 lane scope, for orchestrator backlog):**

`packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-116` declares `match_memories` with column ordering `(id, content, source_type, category, project, metadata, similarity)` but petvetbid's existing function (and presumably any v0.6.x-era install) returns `(id, content, metadata, source_type, category, project, created_at, similarity)`. Postgres rejects `CREATE OR REPLACE FUNCTION` when the return-type signature changes. This is **Class A migration-replay drift** — silent for users who never re-ran `init --mnestra` against an existing install, but a hard block for anyone who does. Suggested follow-up: either wrap in `DROP FUNCTION IF EXISTS match_memories(vector, ...) CASCADE;` before the create-or-replace, or add a `do$$ begin ... end$$` guard that detects signature drift and rebuilds. **Not in T1 scope; flagged for orchestrator close-out / sprint-52 backlog (likely the "match_memories return-type drift idempotency" mini-sprint).** The good news is T1's fix means this Class A drift no longer hides Class M (hook upgrade) — the hook still gets refreshed, the user still gets the v2 metadata-populating writer, and only the migration-replay surfaces as a visible failure.

### [T1] DONE — 2026-05-04 11:25 ET

Sprint 51.7 T1 acceptance per PLANNING.md §1 + §2:

- ✅ **Acceptance #1 — root cause identified.** H1 (control flow drops out before refresh), specifically: `applyMigrations()` throws on `001_mnestra_tables.sql` `match_memories` return-type drift → outer catch returns 5 → refresh stranded. Fix landed by moving refresh upstream of all DB work (`init-mnestra.js:716`), so the architectural class of the bug is closed regardless of which DB step throws on a given user's install.
- ✅ **Acceptance #2 — CLI-binary integration test.** New file `tests/init-mnestra-cli-refresh.test.js` (6 tests, all pass). Test #1 specifically pins the upstream-ordering invariant — it would have caught Sprint 51.6 Phase B failure pre-publish because it exercises the wire-up under realistic-failure conditions (DB unreachable) — exactly the conditions that strand the pre-fix implementation.
- ✅ **Out of lane (correctly avoided):** no bundled hook edits (T2), no `package.json` version bumps (T3), no `CHANGELOG.md` edits (T3), no commits.

T3: green to integrate T1's deliverables. T4-CODEX: post-FIX-LANDED audit window open.

@T4-CODEX: especially appreciate your 11:07 ET independent reproduction that pinned the exact SQL error (`cannot change return type of existing function` on `match_memories`) and the dry-run-doesn't-fire follow-up at the same time, plus the 11:24 ET pre-status-post WIP verification. Without the first, T1 might have shipped a fix that addressed only the control-flow class without surfacing the underlying mig-001 drift for orchestrator backlog. The 3+1+1 pattern paid off here exactly as it did on Sprint 51.6.

### [T4-CODEX] VERIFY 2026-05-04 11:29 ET — T1/T2 DONE independently verified; T3 green to stage with migration-drift caveat.

**T1 verification: PASS.**

Current code evidence:

- `packages/cli/src/init-mnestra.js:602-635` defines `runHookRefresh({ dryRun })` with fail-soft try/catch and gated `TERMDECK_DEBUG_WIREUP=1` stderr instrumentation.
- `packages/cli/src/init-mnestra.js:707-718` calls `runHookRefresh({ dryRun: flags.dryRun })` immediately after secrets persistence and before `step('Connecting to Supabase...')`.
- `packages/cli/src/init-mnestra.js:740-749` leaves only a back-pointer comment in the old DB-coupled region; no second post-DB refresh block remains.
- `tests/init-mnestra-cli-refresh.test.js:125-170` spawns the actual CLI source entrypoint with a stale hook and `127.0.0.1:1` DATABASE_URL, asserts pg connect fails, asserts refresh output exists, asserts refresh output precedes "Connecting to Supabase", asserts the hook was overwritten, and asserts the stale body was backed up.
- `tests/init-mnestra-cli-refresh.test.js:181-206` pins the dry-run path: `would-refresh` is emitted, hook content is unchanged, and no backup is written.
- `tests/init-mnestra-cli-refresh.test.js:260-294` pins custom-hook preservation plus debug-on/debug-off behavior.

Independent behavior check already run by T4 after T1 WIP: temp-HOME live-failure probe against petvetbid refreshed stale hook to v2 before the known `001_mnestra_tables.sql` failure (`after_wc=898`, v2 stamp observed, one backup). This confirms the original Sprint 51.6 bug class is closed: DB failure no longer strands the local hook upgrade.

**T2 verification: PASS.**

Current code evidence:

- `packages/stack-installer/assets/hooks/memory-session-end.js:64` stamps the bundled hook as `@termdeck/stack-installer-hook v2`.
- `packages/stack-installer/assets/hooks/memory-session-end.js:482-486` counts all three fact tool names: `memory_remember`, `mcp__mnestra__memory_remember`, and `mcp__memory__memory_remember`.
- `packages/stack-installer/assets/hooks/memory-session-end.js:502-545` parses timestamps and tool_use blocks across nested Claude `message.content[]`, flat adapter `content[]`, and Codex `response_item.payload.content[]`.
- `packages/stack-installer/assets/hooks/memory-session-end.js:694-743` serializes `started_at`, `duration_minutes`, and `facts_extracted` in `postMemorySession()` with `null/null/0` fallback.
- `packages/stack-installer/assets/hooks/memory-session-end.js:806-853` carries parser-derived metadata from `buildSummary()` through `processStdinPayload()` into `postMemorySession()`, including parser-derived `endedAt`.
- `packages/stack-installer/tests/hook-metadata-parser.test.js:125-163` pins the mixed-name `factsExtracted === 3` behavior and the legacy `mcp__memory__memory_remember` case.
- `packages/stack-installer/tests/hook-metadata-parser.test.js:235-250` pins the scrubbed fixture roundtrip: 15-minute span and 3 facts.
- `packages/stack-installer/tests/hook-metadata-parser.test.js:262-312` pins flat adapter and Codex response-item content shapes.
- `tests/stack-installer-hook-merge.test.js:1057-1148` asserts parser-derived metadata reaches the actual memory_sessions POST body in the end-to-end hook path.
- `tests/stack-installer-hook-merge.test.js:1153-1225` asserts direct `postMemorySession()` serialization and v1-compatible defaults.

T4 test command just rerun against the current dirty tree:

```text
node --test packages/stack-installer/tests/hook-metadata-parser.test.js tests/stack-installer-hook-merge.test.js tests/init-mnestra-hook-refresh.test.js tests/init-mnestra-cli-refresh.test.js tests/project-taxonomy.test.js
# tests 140
# pass 140
# fail 0
```

**T3 staging guidance / caveat:**

T3 is green to stage the v1.0.3 mini on the T1/T2 deliverables. Do not over-claim it as "init --mnestra now fully succeeds on petvetbid existing installs." The remaining out-of-scope failure is still the Class A migration replay drift: `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-96` declares `match_memories` with return columns `(id, content, source_type, category, project, metadata, similarity)`, while the live petvetbid function observed by T4 earlier has a different return signature including `metadata` earlier and `created_at`. Postgres rejects `CREATE OR REPLACE FUNCTION` on return-type drift. Sprint 51.7 fixed the Class M wire-up bug by moving hook refresh before that DB phase; it did not fix migration idempotency.

Required release wording shape: "v1.0.3 refreshes the bundled SessionEnd hook before DB work and writes parser-derived memory_sessions metadata." Avoid wording that implies the entire wizard/migration stack is now idempotent on old petvetbid-style installs.

### [T4-CODEX] AUDIT 2026-05-04 11:34 ET — T3 WIP partial pass, release-doc blocker before FIX-LANDED/publish.

T4 observed T3 WIP after the 11:33 ET poll.

**What is correct so far:**

- `package.json:2-3` is bumped to `@jhizzard/termdeck@1.0.3`. This matches `docs/RELEASE.md:18-21`, which requires bumping the root npm package every release.
- `packages/stack-installer/package.json:2-3` is bumped to `@jhizzard/termdeck-stack@0.6.3`. This matches the audit-trail bump convention in `docs/RELEASE.md:18-21`.
- `packages/cli/package.json` is not modified, which matches `docs/RELEASE.md:23-27` ("Do NOT bump" internal workspace packages on every release).

**Blocker before T3 can post FIX-LANDED / STAGED-FOR-PUBLISH:**

- `CHANGELOG.md` has no `## [1.0.3] - 2026-05-04` block. Current top of file is still `CHANGELOG.md:7-19`: `[Unreleased]` followed directly by `## [1.0.2] - 2026-05-04`.
- This violates `docs/RELEASE.md:29-33`, which requires a `## [X.Y.Z] - YYYY-MM-DD` block above the previous release and says `### Notes` is the right place for explicit out-of-scope flags.

**Required before acceptance:**

1. Add a top-of-file `CHANGELOG.md` entry for `1.0.3` that accurately scopes the release:
   - wizard hook refresh moved before DB work,
   - bundled hook v2 writes parser-derived `started_at` / `duration_minutes` / `facts_extracted`,
   - T4 caveat: migration-001 `match_memories` return-type drift remains out of scope.
2. Post T3 FIX-LANDED / staging evidence after the changelog lands.
3. Then T4 can run the pre-publish release audit (`npm pack --dry-run --json` root + stack-installer, file-list checks, full/targeted test matrix, staged CLI probe).

T4 disposition: do not publish and do not accept T3 DONE on package-version bumps alone.

### [T4-CODEX] AUDIT 2026-05-04 11:38 ET — T3 technical staging mostly passes; CHANGELOG accuracy blockers remain.

T3 responded to the 11:34 ET blocker by adding a `CHANGELOG.md` entry. T4 ran pre-publish checks independently.

**Tarball verification: PASS.**

Root package:

```text
npm pack --dry-run --json
# id: @jhizzard/termdeck@1.0.3
# filename: jhizzard-termdeck-1.0.3.tgz
# files include:
# - package.json
# - packages/cli/src/init-mnestra.js
# - packages/stack-installer/assets/hooks/memory-session-end.js
# - packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql
# - packages/server/src/setup/rumen/functions/rumen-tick/index.ts
# - packages/server/src/setup/rumen/functions/graph-inference/index.ts
```

Stack-installer package:

```text
npm pack --dry-run --json
# id: @jhizzard/termdeck-stack@0.6.3
# filename: jhizzard-termdeck-stack-0.6.3.tgz
# files include:
# - assets/hooks/memory-session-end.js
# - assets/hooks/README.md
# - src/index.js
# - src/launcher.js
# - src/mcp-config.js
```

Notes:

- Root tarball ships both relevant runtime pieces: `packages/cli/src/init-mnestra.js` and `packages/stack-installer/assets/hooks/memory-session-end.js`.
- Stack tarball correctly ships the hook asset as `assets/hooks/memory-session-end.js`; it does not and should not ship `packages/cli/src/init-mnestra.js`.

**Test matrix: PASS after required sandbox escalation for local listen() tests.**

T4 ran the T3 brief matrix:

```text
node --test packages/cli/tests/**/*.test.js
# no packages/cli/tests directory exists; no-op in current repo layout.

node --test packages/stack-installer/tests/**/*.test.js
# tests 39
# pass 39
# fail 0

node --test packages/server/tests/**/*.test.js
# tests 40
# pass 40
# fail 0

node --test tests/**/*.test.js
# first sandbox run failed on listen EPERM for tests that bind HTTP servers.
# escalated rerun:
# tests 1018
# pass 1015
# fail 0
# skipped 3
```

T1 staged CLI integration re-run:

```text
node --test tests/init-mnestra-cli-refresh.test.js
# tests 6
# pass 6
# fail 0
```

**Release docs still need correction before T3 FIX-LANDED / STAGED-FOR-PUBLISH:**

1. `CHANGELOG.md:25` has stale implementation line references: it says `runHookRefresh({ dryRun })` is at `packages/cli/src/init-mnestra.js:573-636` and the back-pointer comment is at `740-749`. Current source is `packages/cli/src/init-mnestra.js:602-635` for `runHookRefresh()`, `packages/cli/src/init-mnestra.js:716` for the call site, and `packages/cli/src/init-mnestra.js:745-749` for the back-pointer comment. Correct the changelog so the release note's file:line evidence matches the actual staged tree.
2. `CHANGELOG.md:34` says "`@jhizzard/termdeck-stack` 0.6.2 -> 0.6.3 audit-trail bump. Stack-installer source unchanged." That is inaccurate for this release. The stack-installer package content changed because `packages/stack-installer/assets/hooks/memory-session-end.js:64` carries v2 and `packages/stack-installer/assets/hooks/memory-session-end.js:482-545` carries the new metadata parser. If the intended claim is "installer JS source unchanged," say that narrowly; otherwise remove the sentence.

T4 disposition: pre-publish runtime/tarball/test gates pass, but T3 should correct the CHANGELOG accuracy issues and post its own FIX-LANDED/STAGED-FOR-PUBLISH evidence before orchestrator publish. Do not publish from the current release docs as-is.

### [T4-CODEX] VERIFY 2026-05-04 11:41 ET — CHANGELOG blockers closed; awaiting T3 formal staging post.

T4 rechecked `CHANGELOG.md` after the 11:38 ET blocker.

Resolved:

- `CHANGELOG.md:25` now points to the actual staged source: `packages/cli/src/init-mnestra.js:602-635` for `runHookRefresh()`, call site line `716`, and back-pointer comment `745-749`.
- `CHANGELOG.md:34` now says stack-installer JS source is unchanged but the hook asset changed, which matches the staged tree: `packages/stack-installer/assets/hooks/memory-session-end.js:64` carries v2 and `packages/stack-installer/assets/hooks/memory-session-end.js:482-545` carries parser metadata support.

Remaining:

- No `[T3] FIX-LANDED`, `[T3] STAGED-FOR-PUBLISH`, or `[T3] DONE` post exists yet. `STATUS.md` currently still only has `[T3] STANDBY` at line 20 plus T4's T3 audit posts.
- T4 already ran and passed the pre-publish technical gates: root pack, stack pack, package test matrix, root test matrix with listen()-permission escalation, and `tests/init-mnestra-cli-refresh.test.js` standalone.

T4 disposition: T3 release docs are now acceptable; T3 can post its formal staging report. Orchestrator should still wait for that T3 post before publish, because T3 owns the version/CHANGELOG lane and must explicitly hand off to the Passkey-authenticated publish step.

### [T3] FIX-LANDED 2026-05-04 11:40 ET — v1.0.3 wave staged + T4-CODEX accuracy catches addressed

Apologies for the late formal post — original Edit hit a stale-file race after T4-CODEX appended audit posts during my draft, and I had to re-cycle the staging summary against the live tree. T4's CHANGELOG accuracy catches landed in the live file before this post.

**T4-CODEX 11:38 ET catches addressed (CHANGELOG accuracy):**

1. **Stale `runHookRefresh()` line numbers** — CHANGELOG had `573-636` (sourced from T1's FIX-LANDED post number, which presumably reflected an intermediate WIP state). Actual current source is `602-635` for the helper, `716` for the call site, `745-749` for the back-pointer comment. **Fixed at `CHANGELOG.md:25`** — now reads `packages/cli/src/init-mnestra.js:602-635` and `lines 745-749` for back-pointer.
2. **"Stack-installer source unchanged" was inaccurate** — the bundled hook asset (`assets/hooks/memory-session-end.js`) WAS modified by T2. **Fixed at `CHANGELOG.md:34`** — now narrowly reads "Stack-installer JS source (`src/index.js`, `src/launcher.js`, `src/mcp-config.js`) is unchanged this release; bumped because the bundled hook asset (`assets/hooks/memory-session-end.js`, which the stack-installer ships) carries T2's parser + v2 stamp + multi-shape content extraction."

Independent re-verification of corrected line numbers via `grep -n "runHookRefresh\|Sprint 51.7 T1" packages/cli/src/init-mnestra.js`:

```text
602:function runHookRefresh({ dryRun = false } = {}) {
716:  runHookRefresh({ dryRun: flags.dryRun });
745:    // Sprint 51.7 T1: hook refresh moved upstream — see runHookRefresh()
```

`runHookRefresh()` body ends at line 635 (helper is 34 lines, verified via Read of lines 600-642).

**Version diffs (3 files staged):**

```diff
package.json
- "version": "1.0.2",
+ "version": "1.0.3",

packages/stack-installer/package.json
- "version": "0.6.2",
+ "version": "0.6.3",

CHANGELOG.md
+ ## [1.0.3] - 2026-05-04
+ (32-line dense-bullet block matching v1.0.2 style)
```

`packages/cli/package.json` is private internal (`@termdeck/cli-internal@0.3.2`) — NOT bumped, per RELEASE.md:23-27 + Sprint 51.6 precedent. Mnestra and Rumen package.json files NOT touched.

**Files-array verification — both tarballs ship the relevant deliverables.**

Root tarball (`jhizzard-termdeck-1.0.3.tgz`, 375 kB, 111 files):

```text
package.json (2112 bytes, version=1.0.3)
packages/cli/src/init-mnestra.js (33131 bytes, T1's edits inline)
packages/stack-installer/assets/hooks/memory-session-end.js (39066 bytes, T2's v2 stamp + parser inline)
packages/server/src/setup/audit-upgrade.js (18170 bytes)
packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql (per T4 11:38 ET probe — ships in tarball)
config/transcript-migration.sql (1532 bytes — Sprint 35 packaging-gap defense, intact)
```

Stack-installer tarball (`jhizzard-termdeck-stack-0.6.3.tgz`, 40 kB, 8 files):

```text
package.json (925 bytes, version=0.6.3)
assets/hooks/memory-session-end.js (39066 bytes — byte-identical to root tarball copy)
src/index.js, src/launcher.js, src/mcp-config.js (UNCHANGED this release)
README.md, CHANGELOG.md (stack-installer's own; not updated this release per post-Sprint-35 precedent)
```

Bundled hook is byte-identical across both tarballs (39066 bytes both places). T1's new test `tests/init-mnestra-cli-refresh.test.js` and T2's new test/fixture under `packages/stack-installer/tests/` are dev-only — correctly NOT in either `files: []` array (tests don't ship to npm).

**Path correction:** T1's CLI-binary integration test landed at root-level `tests/init-mnestra-cli-refresh.test.js` (matches existing `tests/init-mnestra-hook-refresh.test.js` pattern), NOT at `packages/cli/tests/init-mnestra-cli-refresh.test.js` as the lane brief named. Per T4-CODEX 11:24 ET catch. CHANGELOG entry uses the actual path.

**Test matrix — green across all suites (independently confirmed by T4-CODEX 11:38 ET re-run).**

| Suite | Tests | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|
| `tests/**/*.test.js` (root, 74 files) | 1018 | 1015 | 0 | 3 | 15.18s |
| `packages/stack-installer/tests/**/*.test.js` (3 files inc. T2 NEW) | 39 | 39 | 0 | 0 | 0.63s |
| `packages/server/tests/**/*.test.js` (2 files) | 40 | 40 | 0 | 0 | 5.49s |
| `packages/cli/tests/**/*.test.js` | 0 (dir empty — see path-correction note) | — | — | — | — |
| **Combined** | **1097** | **1094** | **0** | **3** | — |

T4-CODEX 11:38 ET independently ran the same matrix — same totals (1018/1015/3-skip root, 39/39 stack, 40/40 server) plus standalone re-run of `tests/init-mnestra-cli-refresh.test.js` (6/6 pass). Sprint 51.6 baseline was 1011/986 pass/22 fail/3 skip (root only). The 22 historical `tests/project-taxonomy.test.js` failures are CLOSED — Joshua's installed hook is post-Phase-B v1, the project-taxonomy probes pass 25/25.

**Lane discipline confirmed.** `git status --short` after T3 staging:

```text
 M CHANGELOG.md                                                  # T3 (mine)
 M package.json                                                   # T3 (mine)
 M packages/cli/src/init-mnestra.js                               # T1
 M packages/stack-installer/assets/hooks/memory-session-end.js    # T2
 M packages/stack-installer/package.json                          # T3 (mine)
 M tests/stack-installer-hook-merge.test.js                       # T2
?? docs/sprint-51.7-wizard-wire-up-and-metadata/                  # sprint docs
?? packages/stack-installer/tests/fixtures/                       # T2 fixture
?? packages/stack-installer/tests/hook-metadata-parser.test.js    # T2 NEW
?? tests/init-mnestra-cli-refresh.test.js                         # T1 NEW
```

Plus pre-existing out-of-lane edits in `docs/sprint-51.5b-dogfood-audit/*` (Joshua's deferred-sprint planning work, present at boot — NOT touched by T3). T3 made zero edits outside `CHANGELOG.md`, `package.json`, and `packages/stack-installer/package.json`. **No commits made by T3. No publishes made by T3.**

### [T3] STAGED-FOR-PUBLISH 2026-05-04 11:40 ET — handoff to orchestrator

Wave ready: `@jhizzard/termdeck@1.0.3` + `@jhizzard/termdeck-stack@0.6.3`. Per `docs/RELEASE.md` § Publish sequence (strict order):

1. **`npm run sync-rumen-functions`** from repo root (idempotent; rumen unchanged this sprint so likely a no-op, but RELEASE.md step 1 is unconditional).
2. **`npm pack --dry-run`** spot-check (T3 + T4-CODEX both ran with `--json`; both tarballs verified above).
3. **`npm publish --auth-type=web`** from repo root → `@jhizzard/termdeck@1.0.3`. Browser opens; Joshua taps Passkey. **No `--otp` flag — Sprint 35 lesson, locked in CLAUDE.md.**
4. **`cd packages/stack-installer && npm publish --auth-type=web`** → `@jhizzard/termdeck-stack@0.6.3`. Same Passkey flow.
5. **`git add -A && git commit -m "..." && git push origin main`** ONLY after both publishes succeed.

Verification after publish:

```bash
npm view @jhizzard/termdeck version          # expect 1.0.3
npm view @jhizzard/termdeck-stack version    # expect 0.6.3
```

Then dogfood: `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` against Joshua's daily-driver. Expect `→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ refreshed v1 → v2 (backup: ...)` to fire BEFORE `→ Connecting to Supabase...`. T4-CODEX will run the post-publish acceptance gates per planning §6.

**Brad re-ping (per planning §7):** post-publish, send WhatsApp to `+15127508576` via `wa.me/15127508576?text=...` deep-link inject (auto-authorized per Joshua's CLAUDE.md standing approval): "v1.0.3 ships the wizard wire-up fix; `npm install -g @jhizzard/termdeck@latest && termdeck init --mnestra` should refresh your installed hook to v2 automatically now (no more manual node -e helper)."

**Out-of-scope deferral explicit in CHANGELOG `### Notes`:** Class A migration-replay drift on `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-116` (`match_memories` `CREATE OR REPLACE FUNCTION` return-type drift on existing-install Mnestras) is **NOT fixed in v1.0.3**. T1's wire-up decoupling means this drift no longer hides Class M (hook upgrade) — the hook gets refreshed and the v2 metadata writer lands; only the migration-replay surfaces as exit 5 with a visible SQL error. Suggested follow-up sprint: "match_memories return-type drift idempotency" (sprint-52 candidate). Captured in CHANGELOG `### Notes` per T4-CODEX 11:29 ET caveat: "Avoid wording that implies the entire wizard/migration stack is now idempotent on old petvetbid-style installs."

@T4-CODEX: thanks for the 11:34 ET nudge that I'd skipped the formal `### [T3] FIX-LANDED` post, the 11:38 ET CHANGELOG accuracy catches (stale line numbers + over-broad "source unchanged" claim), and the independent test/tarball/CLI verification at 11:38/11:42 ET. The 3+1+1 pattern earned its keep again on T3 — without your audits, the release notes would have shipped with two factual inaccuracies that future readers would have caught later (and that orchestrator would have had to back-fill in a follow-up commit).

T3 done. Idling for orchestrator publish + T4-CODEX post-publish VERIFY.
