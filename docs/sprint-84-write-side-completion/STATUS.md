# Sprint 84 — STATUS

<!-- Canonical post shape (ALL lanes, including T4):
### [T<n>] VERB 2026-MM-DD HH:MM ET — <gist>
VERB ∈ FINDING | FIX-PROPOSED | FIX-LANDED | SCHEMA-READY | BLOCKED | CHECKPOINT | AUDIT-PASS | AUDIT-FAIL | FINAL-VERDICT | DONE
Example: ### [T1] FINDING 2026-07-31 18:25 ET — propose.js inserts via mnestra client RPC, not raw insert
Idle-poll regex (tolerant): ^(### )?\[T<n>\] DONE\b
-->

### [ORCH] DISPATCH 2026-07-31 18:15 ET — Sprint 84 injected; lanes T1 Sheets-intake / T2 session-record+identity / T3 inbox-hygiene+sweep / T4 Codex audit

### [T2] FINDING 2026-07-31 18:12 ET — the propose channel is ALREADY open to ChatGPT + Grok via the client_name heuristic; the explicit map only covers Claude

Ground truth, live, this host:

- `curl 127.0.0.1:8870/healthz` → `{"mode":"full","tools":7,...}`. 7 = 2 memory + 4 panel + **1 propose**. `TERMDECK_BRIDGE_ENABLE_PROPOSE` is set in `~/.termdeck/supervisor.env`. The write channel is live right now.
- `~/.termdeck/bridge-auth.json` holds **15 DCR client registrations**: 7 `client_name:"Claude"`, 3 `"ChatGPT"`, 5 `"Grok"`.
- `~/.termdeck/bridge-propose.json` maps **7 entries, all → `claude-web`** — i.e. exactly the seven Claude clients. No ChatGPT/Grok entry exists.

The gap between those last two facts is the finding. `policy.js::mapClientToSourceAgent` (`src/policy.js:244`) tries the operator map **first**, then falls through to `SOURCE_AGENT_HEURISTICS` (`src/policy.js:233`), which matches `/chatgpt|openai/i` → `chatgpt-web` and `/grok|xai/i` → `grok-web` against `client_name`. All 8 ChatGPT/Grok registrations carry exactly those names. **So those connectors already resolve to a valid `*-web` source agent and can already propose today** — the map's Claude-only contents do not restrict them.

This inverts my lane item 2. The task is not "open the channel to ChatGPT/Grok" — it is already open. The task is (a) make it *explicit* rather than name-inferred, and (b) give the operator a way to shut the inference off. Fail-closed was Sprint 76's stated posture; a `client_name` the connector supplies at DCR time is caller-influenced data, so heuristic-only identity is a weaker guarantee than the map implies. Not exploitable for *escalation* — the heuristic can only ever mint one of the four `*-web` values, never a CLI identity, and T1's RPC whitelist re-checks server-side — but it does mean provenance can be chosen by whoever picks the registration name.

Proposed (lands with my lane, see FIX-PROPOSED): keep the heuristic as the default so nothing changes under anyone mid-sprint, add `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1` (**default OFF**) which disables the fallback so only explicitly-mapped client_ids resolve, and ship the operator block that adds the 8 ChatGPT/Grok client_ids to `bridge-propose.json` so strict mode can be switched on without losing those connectors. ORCH/T4: flag if you want strict-map defaulted ON instead — that is an operator-posture call, not mine.

### [T2] FINDING 2026-07-31 18:12 ET — `memory_sessions` canonical-vs-live drift: `metadata` exists in mig 001 but NOT on the live table

Live column list (read-only introspection of the daily driver, 15 cols): `id, session_id (NOT NULL), summary, summary_embedding, project, started_at, ended_at, duration_minutes, messages_count, facts_extracted, files_changed, topics, transcript_path, created_at, rumen_processed_at`.

Canonical `migrations/001_mnestra_tables.sql:52` declares `memory_sessions` with `metadata jsonb not null default '{}'::jsonb`. **The live table has no `metadata` column** — the daily driver's `memory_sessions` came from the rag-system flavor and was reconciled *forward* by mig 017 (which added the rich rag-system columns to canonical installs) but never *backward* (nobody added mig-001's `metadata` to the rag-system-shaped table). Net: code written against canonical `memory_sessions.metadata` compiles, passes tests on a fresh install, and 42703-errors on the daily driver.

There is also no `source_agent` on `memory_sessions` at all, on either shape — provenance exists on `memory_items` (mig 015/025) but sessions carry none. That is fine while the only writer is the local SessionEnd hook; it is not fine the moment a web surface can write sessions, because nothing would distinguish a web-recorded session row from a CLI panel-close row.

Both are addressed by the migration in my SCHEMA-READY below (`add column if not exists`, idempotent, reconciles in the mig-017 direction).

### [T2] SCHEMA-READY 2026-07-31 18:12 ET — mnestra migration 035: `memory_sessions` provenance columns + `public.memory_session_record(...)` RPC

Per PLANNING contract 1, exact signature BEFORE I build against it. **No `memory_inbox` change from this lane.** Adopt verbatim if you need it.

Column adds on `public.memory_sessions` (both idempotent, both nullable/defaulted, no rewrite of existing rows):

```sql
alter table public.memory_sessions
  add column if not exists metadata     jsonb not null default '{}'::jsonb,  -- reconciles mig-001 canonical onto the live rag-system shape
  add column if not exists source_agent text;                                -- NULL = CLI/hook-written (all existing rows); non-NULL = *-web
```

RPC (SECURITY DEFINER, `set search_path = public, pg_catalog`, EXECUTE revoked from PUBLIC/anon/authenticated and granted to `service_role` only — the same five-gate shape as mig 026's `memory_propose`):

```sql
public.memory_session_record(
  p_source_agent   text,               -- required; whitelisted to claude-web|chatgpt-web|grok-web|gemini-web
  p_conversation_key text,             -- required; the web surface's own conversation id, <= 200 chars
  p_summary        text,               -- required; non-empty after trim, <= 8000 chars
  p_project        text default null,  -- <= 128 chars; NULL/empty collapses to 'global'
  p_messages_count int  default null,  -- >= 0; NULL -> 0
  p_started_at     timestamptz default null,
  p_ended_at       timestamptz default null,   -- NULL -> now(); never left NULL (the Rumen picker requires it)
  p_topics         jsonb default '[]'::jsonb,  -- array only, <= 4096 bytes
  p_metadata       jsonb default '{}'::jsonb   -- object only, <= 8192 bytes
) returns uuid
```

Three contract points the other lanes should know:

1. **`session_id` is minted server-side, never caller-supplied.** The RPC writes `session_id = 'web:' || <source_agent> || ':' || <conversation_key>`. A web caller therefore cannot address — and cannot overwrite — a CLI/hook-written session row, whose `session_id` is a bare Claude Code session UUID. This is the load-bearing defense of the upsert; without it `on conflict (session_id) do update` would be an arbitrary-session-summary-overwrite primitive from a web surface.
2. **The upsert is narrowed twice more.** `do update` fires only where the existing row's `source_agent = v_agent` **and** `rumen_processed_at is null` — a caller can amend its own not-yet-swept record, and can never re-arm an already-consumed row for another Rumen synthesis pass. `rumen_processed_at` is never written by this RPC.
3. **Rejections use the stable prefix `MEMORY_SESSION_RECORD_REJECTED: <reason_code>`** (codes: `invalid_source_agent | empty_conversation_key | conversation_key_too_long | empty_summary | summary_too_long | project_too_long | negative_messages_count | topics_not_array | topics_too_large | metadata_not_object | metadata_too_large`), mirroring mig 026's `MEMORY_PROPOSE_REJECTED` convention so the bridge surfaces one error shape.

Consumer note for T3 (no action needed, just so the sweep math is right): Rumen's picker floor is `COALESCE(messages_count,0) >= minEventCount`, default **3** (`rumen/src/index.ts:140`, `extract.ts:116`). A recorded web session with fewer than 3 messages lands in `memory_sessions` and is simply never swept. The tool reports this back to the caller rather than silently rewriting the count.

### [T4] CHECKPOINT 2026-07-31 18:08 ET — phase 0 boot complete; read PLANNING.md, STATUS.md, T4 mandate, T1/T2/T3 briefs, WEB-WRITE runbook, ARCHITECTURE.md, project/global rules, and CRITICAL-READ-FIRST; verified-so-far: T4 bar requires WIP audit, hostile fixture reproduction, fail-closed bridge checks, non-superuser migration replay, and five RLS gates; pending: baseline diff/status scan; most recent worker FIX-LANDED: none

### [T4] CHECKPOINT 2026-07-31 18:10 ET — phase 1 baseline audit complete; verified-so-far: no tracked worker diff in termdeck/rumen/engram, bridge proposal baseline lines checked at packages/mcp-bridge/src/tools/index.js:59, packages/mcp-bridge/src/policy.js:207, packages/mcp-bridge/src/clients/mnestra.js:121, server registration checked at packages/mcp-bridge/src/server.js:105 and :413, memory_sessions schema checked at packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql:44 plus rumen_processed_at at 018:33, and bridge baseline tests `node --test packages/mcp-bridge/test/policy.test.js packages/mcp-bridge/test/propose.test.js packages/mcp-bridge/test/tools.test.js packages/mcp-bridge/test/server.test.js` passed 76/76; pending: worker WIP/FIX-LANDED diffs, T1 hostile fixture replay, T2 fail-closed session-record replay, T3 non-superuser migration replay; most recent worker FIX-LANDED: none

### [T4] CHECKPOINT 2026-07-31 18:11 ET — phase 2 live baseline reproduction started; verified-so-far: read-only SQL independently confirms memory_inbox_total=1, statuses=rejected:1, cron jobs present are doctrine-scan 30 3 / graph-inference-tick 0 3 / mnestra-recall-log-purge 17 3 / rumen-reinforce 45 3 / rumen-tick */15 with no inbox-promote, entity counts are memory_entities=0 and memory_entity_mentions=0, and 25 memory_items exist since 2026-07-31 17:35 ET with source types fact:20/session_summary:5; pending: audit T3 cron/extraction root-cause references, then worker WIP/FIX-LANDED diffs; most recent worker FIX-LANDED: none

### [T3] FINDING 2026-07-31 18:12 ET — inbox-promote cron was NEVER scheduled (deliberate, Activation-Day supervised mode); the migration exists but jobname/cadence disagree with the runbook

Ground truth, read-only on the daily driver:

- `cron.job` = 5 jobs: `rumen-tick` */15 (jobid 19), `graph-inference-tick` 0 3 (20), `mnestra-recall-log-purge` 17 3 (23), `doctrine-scan` 30 3 (24), `rumen-reinforce` 45 3 (25). No inbox-promote under any name.
- `cron.job_run_details` — every jobid that has ever fired is accounted for by the jobs above plus their pre-2026-05 ancestors; **max jobid ever run = 25**. No inbox-promote job ever executed. (jobids 21/22 were registered and unscheduled without ever firing; no run rows, not identifiable, and neither is a promoter — the promoter's Edge Function only went live 2026-07-30.)
- Cause is not drift: Activation Day (2026-07-30 ~19:45 ET) deployed the `inbox-promote` function and **deliberately did not schedule its pg_cron** — supervised/ratify-first mode. So: **never scheduled**, on purpose, and the ratify-first rationale has now been satisfied (one proposal ran the full loop → rejected `recipe-level`, which is the promoter working).
- The artifact already exists at `rumen/migrations/003_pg_cron_inbox_promote.sql` — jobname **`rumen-inbox-promote`**, cadence **`*/15`**. The runbook Part A §A3 says jobname `inbox-promote`, cadence `*/10`. Two names for one job is a re-registration hazard (schedule both and the promoter double-fires; `cron.unschedule` in either artifact then misses the other).
- Also note: `rumen/migrations/003_*` (inbox-promote) and the termdeck-bundled `setup/rumen/migrations/003_graph_inference_schedule.sql` are a number collision across two chains. Pre-existing, flagging not fixing.

Restore plan (FIX-PROPOSED to follow): keep the migration as the single source of truth, reconcile the runbook to it rather than the reverse, and make the unschedule step drop **both** names so the collision can't resurrect. Dry-run/report semantics of the promoter are untouched — the auto-promote flip stays Josh's ~08-13 gate.

### [T3] FINDING 2026-07-31 18:12 ET — extraction telemetry is zero because ALL THREE write paths miss it, not one; the flag never reaches any panel

`memory_entities`=0, `memory_entity_mentions`=0 against 95 `memory_items` written in the last 24h. Every one of those 95 was structurally incapable of producing an entity. Three independent gaps:

1. **Panel-originated `memory_remember` (94 of the 95 by category: 52 fact + 36 decision + 6 orchestrator).** `MNESTRA_EXTRACT_ENABLED=1` is set in `~/.termdeck/supervisor.env`, which only the supervisor/bridge process reads. I echoed the var from inside this TermDeck-spawned panel: **empty**. The `mnestra` MCP entry in `~/.claude.json` is `{"command":"mnestra"}` with **no `env` block**, so the stdio server inherits the panel's env — which does not carry the flag. `extractionEnabled()` (`engram/src/extract_write.ts:191`) is therefore false and `scheduleWriteExtraction` (`:607`) returns before doing anything. Installed `@jhizzard/mnestra@0.11.0` does ship `dist/src/extract_write.js`, so this is purely env-reach, not a stale binary. The ORCH hypothesis is confirmed and is stronger than stated: it isn't that stdio-MCP writes *also* miss extraction — they are the *majority* of the miss.
2. **SQL-direct `ingest_capture` (32 `pre_compact_snapshot` + 20 `session_summary` in 48h).** No TS in the path at all; `public.ingest_capture(jsonb)` (migration 030 §2) inserts straight into `memory_items`. Unfixable by any env change — this is the BACKLOG §A structural gap.
3. **NEW — the promoter itself.** `rumen/src/promote.ts:616` INSERTs into `memory_items` with raw SQL inside the promote transaction. Nothing in that path calls extraction. This matters *this sprint specifically*: T1's Sheets harvester and T2's session records both terminate in inbox rows, and every proposal they promote lands as an extraction-less memory. Ramping intake without the sweep ramps the hole.

Consequence for my lane: exporting the flag into panels would fix (1) only, and would leave the graph blind to exactly the rows Sprint 84 is about to start generating. The sweep is the systemic answer and it must cover all three origins — which it does for free, because it selects on `memory_items` state, not on who wrote the row. I'll still propose the env-reach fix as a separate one-liner (it makes writes extract at write time, which is cheaper and more timely than sweeping them), but the sweep does not depend on it.

SR-7 telemetry so far: 0 triples observed, because 0 extractions have run. I cannot justify `memory_entity_relationships` on this evidence. Holding at default NO unless the sweep's first dry-run surfaces real triples; will post the count either way.

### [ORCH] RULING 2026-07-31 18:20 ET — three rulings: strict-map posture (R1), 035 ratified (R2), inbox-promote restore shape (R3)

**R1 — T2's strict-map proposal RATIFIED AS PROPOSED: heuristic stays the default, `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` ships default OFF.** Rationale: nothing changes under the live connectors mid-sprint; the heuristic can only mint `*-web` values (no CLI-identity escalation) and the server-side whitelist re-checks. Ship the operator block that pre-adds the 8 ChatGPT/Grok client_ids to `bridge-propose.json` so Josh can flip strict ON with one paste — the flip itself is an operator-posture call at the ~08-13 gate, alongside the promotion review. T4: verify the OFF-path is byte-identical to today's behavior and the ON-path is fail-closed for an unmapped client_id.

**R2 — T2's SCHEMA-READY (migration 035) RATIFIED.** The server-minted `session_id` prefix (`web:<agent>:<key>`) is the load-bearing defense — T4, audit that specifically, plus the double-narrowed upsert (`source_agent` match AND `rumen_processed_at is null`) and the five gates on the RPC, on a non-superuser replay. T1/T3: 035's column adds are the only `memory_sessions` surface this sprint; adopt verbatim if you touch sessions.

**R3 — T3's inbox-promote restore shape RATIFIED: the migration is the single source of truth.** Jobname `rumen-inbox-promote`, cadence `*/15` (the shipped migration wins; reconcile the runbook §A3 text to it, not the reverse). Unschedule step must drop BOTH names (`inbox-promote` + `rumen-inbox-promote`) so the two-name hazard can't resurrect. Promoter stays in dry-run/ratify mode — the auto-promote flip remains Josh's ~08-13 gate, out of sprint scope. The 003 number collision across the two migration chains: flag in your FIX-LANDED notes for the BACKLOG, do not renumber anything this sprint.

**Note to all lanes:** T3's finding 3 (promoter INSERT bypasses extraction) upgrades the sweep from hygiene to prerequisite — T1/T2's intake ramps generate exactly the rows the sweep must cover. T3's sweep selecting on `memory_items` state (not writer) is the right shape; proceed.

### [T4] CHECKPOINT 2026-07-31 18:13 ET — phase 2 WIP audit continues; verified-so-far: T3 cron absence/history independently reproduced via read-only SQL, Rumen `003_pg_cron_inbox_promote.sql` uses jobname `rumen-inbox-promote` and cadence `*/15` at /Users/joshuaizzard/Documents/Graciella/rumen/migrations/003_pg_cron_inbox_promote.sql:29 and :36, extraction flag gate verified at /Users/joshuaizzard/Documents/Graciella/engram/src/extract_write.ts:190 and schedule short-circuit at :605, active panel env has no MNESTRA_EXTRACT_ENABLED, mnestra CLI is 0.11.0 with dist extract code present, promoter raw memory_items insert verified at /Users/joshuaizzard/Documents/Graciella/rumen/src/promote.ts:614, T2 live memory_sessions drift verified by SQL (metadata=false, source_agent=false) and canonical metadata at /Users/joshuaizzard/Documents/Graciella/engram/migrations/001_mnestra_tables.sql:52, Rumen picker contract verified at /Users/joshuaizzard/Documents/Graciella/rumen/src/extract.ts:115, and Rumen baseline `npm run test` passed 196/197 with 1 real-PG opt-in skip; nuance: ~/.claude.json mnestra env object exists but is empty, and my 24h distribution is source_type architecture:4/bug_fix:5/decision:19/fact:40/pre_compact_snapshot:16/session_summary:11, so final sweep must not over-filter by T3 prose counts; pending: code diffs/FIX-LANDED, non-superuser migration replay; most recent worker FIX-LANDED: none

### [T3] FIX-PROPOSED 2026-07-31 18:14 ET — four artifacts: cron restore (one name, */10), engram 035 purge+health-view, rumen extract-sweep as a SIBLING module (deviation flagged)

**1. inbox-promote cron restore → `rumen/migrations/006_pg_cron_inbox_promote.sql`.**
`003` already shipped inside the `@jhizzard/rumen@0.10.0` tarball (`files: ["dist","migrations",…]`), so it is immutable — a new migration supersedes it rather than an in-place edit. It `cron.unschedule`s **both** `inbox-promote` and `rumen-inbox-promote` before scheduling, so whichever name a given install picked up gets collapsed to one.
- Canonical jobname: **`rumen-inbox-promote`** — matches the shipped artifact and the `rumen-*` prefix already used by `rumen-tick` / `rumen-reinforce`.
- Canonical cadence: **`*/10`** — from the runbook, and required by PLANNING contract #2 ("nothing at `*/15`"). At `*/15` the promoter would fire simultaneously with `rumen-tick` on every single tick, both against the same pooler; `*/10` collides only twice an hour.
- I'll correct runbook §A3's jobname to match in the same lane, because two live names for one job is the actual hazard.
- Promoter semantics untouched. Restoring the cron restarts the **dry-run clock**; it does not flip auto-promote (still Josh's ~08-13 gate).

**2. inbox-purge → `engram/migrations/035_memory_inbox_hygiene.sql`.**
`purge_memory_inbox(p_retention_days int default 90) returns int`, modelled line-for-line on `purge_recall_log` (027 §6): `delete … where status <> 'pending' and created_at < now() - make_interval(days => greatest(p_retention_days,1))`. Note the live status vocabulary is `pending|promoted|rejected` — there is no `accepted`/`expired`, so `status <> 'pending'` is the exact expression of "non-pending only." Claimed-but-undrained rows stay `pending` (the promoter's lease lives in `metadata.rumen`), so the claim lease can never make a row purgeable. Five gates: SECURITY DEFINER + pinned `search_path`, REVOKE EXECUTE from public/anon/authenticated, GRANT service_role only, no new table, hard-failing receipt block.
Cron `mnestra-inbox-purge` at **`20 4 * * *`** (04:20 UTC) — clear of the owned 03:00–04:00 band *and* of graph-consolidation's 04:00.

**3. Pending-age alarm surface → a VIEW, `public.memory_inbox_health`, in the same 035.**
One row: `pending_count`, `oldest_pending_at`, `oldest_pending_age_hours`, `promoted_24h`, `rejected_24h`, `alarm`, `alarm_reason`. Declared `with (security_invoker = true)` so it inherits `memory_inbox`'s RLS (on, zero policies → anon/authenticated see nothing, service_role bypasses) instead of leaking as a definer view — Supabase lints the definer default as `security_definer_view`.
Why a view and not a line in a job's report: **the alarm's whole job is to fire when the drain is dead, so it must not be computed by the drain.** A view is evaluated at read time by whoever asks, so it is still correct when every promoter run has failed. It is also the cheapest surface that is actually read — one `select * from memory_inbox_health` is exactly how I ground-truthed everything in the FINDINGs above, and it works from an ORCH `execute_sql`, from `psql`, or from a monitor, with no deploy. The 7-day threshold is materialized in `alarm`, and the raw `oldest_pending_age_hours` is exposed alongside so a consumer can pick its own.

**4. `ingest_capture` extraction sweep → `rumen/src/extract-sweep.ts` + `rumen-extract-sweep` Edge Function + cron.**
**DEVIATION, flagging for an ORCH ruling:** the brief says "a NEW rumen phase … the way the tick sweeps `memory_sessions`." I'm building it as a **sibling module with its own function and cadence**, not a phase inside `runRumenJob`, and taking the "the way the tick sweeps" clause as describing the *shape* (batch / budgeted / idempotent / fail-open) rather than the deployment. Reason: the sweep makes one Haiku call per item, and the tick's whole-job budget is already 110s against a 150s platform wall (`DEFAULT_TICK_BUDGET_MS`, `src/index.ts:145`) — a 25-item sweep would starve extract/relate/synthesize and the symptom would present as "insights stopped," pointing at the wrong function. This is the same reasoning `reinforce.ts` states in its own header ("Sibling of rumen-tick / inbox-promote / doctrine-scan by design … NOT a step inside the insight tick") and that `doctrine-scan` and `graph-consolidation` both follow. Say the word if you want it folded into the tick anyway.
- **Idempotency without touching the corpus:** a rumen-owned table `rumen_extraction_sweep (memory_id uuid pk, swept_at, status, attempts, entities_written, mentions_written, same_pattern_edges, triples_found, error)`. Selection is `memory_items LEFT JOIN` it. Stamping the item itself would need a third amendment to "Rumen never modifies existing memory rows" (`src/index.ts:14-21`); a rumen-namespaced ledger needs none, and doubles as the sweep's telemetry.
- **Covers all three origins from the FINDING for free**, because it selects on `memory_items` state, never on who wrote the row: panel `memory_remember`, SQL-direct `ingest_capture`, and promoted proposals.
- **Persistence reuses the server-side drop-invalid RPCs** `upsert_memory_entities(uuid,jsonb)` / `upsert_memory_edges(jsonb)` (034 §§, returns `{created,linked,dropped}` / `{accepted,dropped,dropped_predicates}`) and reads the vocabulary live from `memory_entity_types` / `memory_relationship_types`. No vocabulary is transcribed into rumen — the same rule `extract_write.ts` states for itself, and the reason a second caller is safe at all.
- The deterministic `same_pattern_as` half runs with no model, so items still get their "you solved this before" edge when there is no key or no budget.
- Budget/batch/dry-run knobs namespaced `RUMEN_SWEEP_*`, disjoint from every sibling. `RUMEN_SWEEP_DRY_RUN=1` writes nothing at all, not even ledger rows.
- Errored items get a ledger row with `attempts`, and are re-selected while `attempts < 3` — fail-open per item, but not retry-forever.

**5. Separately — the env-reach one-liner.** Panels need `MNESTRA_EXTRACT_ENABLED=1` to actually reach the stdio MCP server (FINDING gap 1). Cheapest correct fix is an `env` block on the `mnestra` entry in `~/.claude.json` (or exporting it where panel shells are spawned) — an operator config change, not a code change, and outside every lane's file surface. Recommending it to ORCH/Josh rather than doing it. The sweep does not depend on it either way.

**Cron ledger after this sprint** (I own the namespace): `rumen-tick` */15 · `rumen-inbox-promote` */10 (restored) · `graph-inference-tick` 03:00 · `mnestra-recall-log-purge` 03:17 · `doctrine-scan` 03:30 · `rumen-reinforce` 03:45 · `graph-consolidation` 04:00 (ORCH-staged) · `mnestra-inbox-purge` 04:20 (new) · `rumen-extract-sweep` 04:40 (new). T1 — if your harvester wants a cron slot, post the cadence and I'll place it; 05:00+ is wide open.

### [T4] AUDIT-FAIL 2026-07-31 18:14 ET — [T2/T3] cross-lane migration-number collision before code lands: T2 SCHEMA-READY claims mnestra migration 035 for `memory_sessions` provenance + `memory_session_record` at docs/sprint-84-write-side-completion/STATUS.md:36, while T3 FIX-PROPOSED claims `engram/migrations/035_memory_inbox_hygiene.sql` for inbox purge/health at docs/sprint-84-write-side-completion/STATUS.md:113; both cannot own Engram/Mnestra migration 035. Need ORCH/lane reconciliation before either lane builds, mirrors, or tests against divergent filenames.

### [T1] FINDING 2026-07-31 18:13 ET — the "insert path" is a webhook op, not an RPC/raw insert; and Sheets intake CANNOT be pg_cron-driven (T3: I need no cron slot)

Ground-truthed `packages/mcp-bridge/src/tools/propose.js`, `src/clients/mnestra.js`, `src/clients/http.js`, `src/policy.js` before writing a line. Four findings, one of which changes a PLANNING contract assumption.

**1. The forward path is `clients/mnestra.js::propose` → webhook op, not a Supabase RPC and not a raw insert.**
`propose.js:255` calls `clients.mnestra.propose({sourceAgent,text,projectHint,metadata})`. That resolves to `clients/mnestra.js:121`, which POSTs `{op:'propose', source_agent, text, project_hint?, metadata?}` to `MNESTRA_WEBHOOK_URL` (default `http://localhost:37778/mnestra`) with an `x-mnestra-secret` header sourced from `MNESTRA_WEBHOOK_SECRET`, and projects the reply to `{id,status}` only. So "reuse, don't fork" = the harvester **requires `createMnestraClient` and calls `.propose()`** — same module, same op, same secret header, same bounded projection. Nothing new on the wire. No SCHEMA-READY needed from me: `metadata` is a free-form JSONB the caller supplies, so the row fingerprint rides in `metadata.sheets` with **zero schema change** to `memory_inbox`.

Note for T4's replay: everything above the client is bridge-connector-specific and does **not** apply to a local harvester — `propose.js` derives `source_agent` from the OAuth `client_id` (`policy.mapClientToSourceAgent`, fail-closed) because a *web chat* must not mint its own identity. A local supervised process has no OAuth request to derive from. I therefore resolve `source_agent` from the sheet row against the same canonical vocabulary (`policy.js::normalizeWebSourceAgent` / `WEB_SOURCE_AGENTS`, **imported read-only — I do not edit policy.js, that is T2's file this sprint**), defaulting to `gemini-web` per PLANNING contract 3 when the row's source cell is empty, and **quarantining rather than coercing** when the cell is non-empty but invalid. A typo'd source must never silently become `gemini-web`.

**2. Cadence: this lane needs NO pg_cron job — the dependency runs the wrong way.** The propose path terminates at `http://localhost:37778` (loopback, on Josh's Mac), and the service-account key + dedup ledger are both local files. A Supabase pg_cron job cannot reach any of the three. **T3: stand down on a cron slot for T1 — I am not requesting one, and PLANNING contract 2 is satisfied vacuously for my lane.** Cadence will be a supervisor-style local timer, default 300 s, `TERMDECK_SHEETS_POLL_INTERVAL_MS`, opt-in behind `TERMDECK_SHEETS_INTAKE_ENABLED` (default off). Stated per brief item 5.

**3. Zero Google surface exists in this repo, and zero Google credentials exist on the box.**
`grep -ril "googleapis|service_account|GOOGLE_SERVICE_ACCOUNT|SHEETS_"` across the repo returns exactly one hit: my own brief. `~/.termdeck/secrets.env` holds 8 keys (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `GROK_API_KEY`, `GEMINI_API_KEY`, `MNESTRA_WEBHOOK_SECRET`) — **no service-account credential of any kind** (`GEMINI_API_KEY` is a generative-API key, not a Sheets OAuth identity; it cannot read a spreadsheet).

Two consequences, both handled per brief item 4 without blocking the lane:
- **No new dependency.** `googleapis` is a large tree for what is two REST calls. The service-account flow is a self-signed RS256 JWT → `POST https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) → bearer token against `sheets.googleapis.com/v4`. RS256 signing is `node:crypto` `createSign('RSA-SHA256')`. That is dependency-free, matches the house style of `clients/http.js` + `policy.js` (Node built-ins only, supply-chain-inert), and keeps the zero-build-step/CommonJS hard rules. Transport reuses `clients/http.js::requestJson` where the shape fits.
- **E2E proof will be faked-transport with real request shapes asserted**, per the brief's explicit fallback — a real throwaway sheet is impossible without a minted service account. I will assert the exact URLs, the JWT claim set, `valueInputOption`, and the exact `{op:'propose',...}` body, so the day Josh mints the credential the only unproven step is Google's own 200. **Not a blocker; flagging so ORCH can decide whether to ask Josh for a credential mid-sprint.**

**4. Placement: `packages/mcp-bridge/src/harvest/`.** Root `package.json` `files` ships `packages/server/src/**` but **not** `packages/mcp-bridge/**` — the bridge runs from a git checkout under `scripts/termdeck-supervise.sh:122` (and Render via `cloud-origin-start.sh`), not from the npm tarball. So a harvester placed in `packages/server/src/` could not `require` the propose client without breaking the published tarball, which would force exactly the fork the brief forbids. Landing it beside the client it reuses is the only placement that satisfies "reuse, don't fork". It registers **no MCP tool** and is not imported by `server.js`, so the Bridge's read-only tool surface and `assertReadOnly` are untouched (inert on the Render origin).

Building now. FIX-PROPOSED with the module + tests to follow.

### [ORCH] RULING 2026-07-31 18:24 ET — collision reconciled (R4) + three lane approvals (R3b, R5, R6)

**R4 — migration-number collision (T4's AUDIT-FAIL): engram 035 belongs to T2.** T2's SCHEMA-READY was posted first and ratified in R2; renumbering a ratified contract reopens it for no gain. **T3's inbox-hygiene migration renumbers to `engram/migrations/036_memory_inbox_hygiene.sql`** — content unchanged, purge function + health view exactly as FIX-PROPOSED. T4: AUDIT-FAIL is resolved by this ruling; re-verify at FIX-LANDED that the filenames landed as ruled.

**R3b — amends R3 on cadence:** T3's argument stands — `*/15` would fire the promoter simultaneously with rumen-tick on every tick and violates PLANNING contract 2. Canonical: jobname `rumen-inbox-promote`, cadence `*/10`, delivered as NEW `rumen/migrations/006_pg_cron_inbox_promote.sql` superseding the immutable shipped 003, unschedule-both retained. Runbook §A3 reconciles to jobname `rumen-inbox-promote` + `*/10`.

**R5 — T3's sibling-module deviation APPROVED.** `rumen-extract-sweep` as its own Edge Function + cron (04:40 UTC), not a phase inside `runRumenJob`. The tick-budget starvation argument is decisive and matches the reinforce/doctrine-scan/graph-consolidation precedent. The rumen-owned ledger table (`rumen_extraction_sweep`) is the right idempotency shape — no third amendment to "Rumen never modifies existing memory rows."

**R6 — T1's faked-transport E2E ACCEPTED; no mid-sprint credential mint.** Zero Google credentials exist on the box; minting a service account is an operator activation step, queued for Josh POST-sprint via T1's activation README. T1's quarantine-not-coerce posture on invalid source cells and the `packages/mcp-bridge/src/harvest/` placement (tarball analysis) are both ratified. T4: hold T1 to the asserted-request-shape bar (exact URLs, JWT claim set, `valueInputOption`, exact `{op:'propose',...}` body).

**Env-reach one-liner (T3's item 5):** ORCH will apply the `~/.claude.json` mnestra `env` block at close-out, not mid-sprint — live-editing that file while three Claude panels run risks a rewrite race on panel exit. Queued.

### [T4] CHECKPOINT 2026-07-31 18:16 ET — phase 2 WIP audit updated after ORCH R4/R3b/R5/R6; verified-so-far: prior migration-number AUDIT-FAIL is resolved by ruling with Engram 035 assigned to T2 and T3 hygiene renumbered to 036, cadence ambiguity is resolved by R3b as jobname `rumen-inbox-promote` at `*/10` in a new Rumen 006 superseding immutable 003, T1 faked-transport E2E is accepted, and current termdeck/rumen/engram tracked diffs are still clean; pending: verify landed filenames and code obey those rulings, then run non-superuser migration replay plus hostile/fail-closed fixtures; most recent worker FIX-LANDED: none

### [T4] CHECKPOINT 2026-07-31 18:17 ET — phase 2 migration WIP audit pass 1 complete; verified-so-far: Engram WIP filenames now obey R4 (`migrations/035_memory_session_record.sql` for T2 and `migrations/036_memory_inbox_hygiene.sql` for T3), Rumen WIP filename now obeys R3b (`migrations/006_pg_cron_inbox_promote.sql`), 006 unschedules both `inbox-promote` and `rumen-inbox-promote` before scheduling canonical `rumen-inbox-promote` at `*/10`, 036 keeps `status <> 'pending'` as the purge predicate and grants `memory_inbox_health` SELECT only to service_role with `security_invoker=true`, and 035 mints `session_id = 'web:' || agent || ':' || key` then narrows updates to same `source_agent` plus `rumen_processed_at is null`; pending: actual non-superuser replay and hostile SQL fixtures before any AUDIT-PASS; most recent worker FIX-LANDED: none

### [T2] FIX-LANDED 2026-07-31 18:18 ET — mnestra migration 035 written + applied NON-SUPERUSER on pg17, all five gates + full behaviour matrix green

`~/Documents/Graciella/engram/migrations/035_memory_session_record.sql`. T3 has 036 — no collision.

**Non-superuser apply (S83 gate).** `pgvector/pgvector:pg17`, extensions installed by the container superuser (as Supabase pre-provisions), `anon`/`authenticated`/`service_role` created, then the **entire chain 001→035 applied by `mnestra_owner` (`rolsuper=false`, owner of schema public)** — the Supabase-`postgres` shape. 035 applies clean. Two PRE-EXISTING migrations fail in this container and neither is mine: `016` needs `vault.secrets`, `024` needs a database-level `comment on database`. Both are already live on the daily driver; I did not touch either. Harness: `<scratchpad>/s84t2-nonsuper-apply.sh`.

Apply receipt (verbatim NOTICEs):

```
[035] enabled RLS on public.memory_sessions (was off)
[035] memory_sessions RLS enabled: t (expect t)
[035] memory_sessions PUBLIC-reaching policies: 0 (expect 0)
[035] memory_sessions anon/authenticated table grants: 0 (expect 0)
[035] memory_session_record EXECUTE — anon: f, authenticated: f, public: f (expect f f f); service_role: t (expect t)
[035] memory_session_record proconfig: search_path=public, pg_catalog
```

Two of those deserve a second look, T4:

- **"enabled RLS on memory_sessions (was off)"** — on a clean 001→034 chain, `memory_sessions` ends up with RLS **OFF**. The live daily driver has it ON, so the live enablement did not come from the migration chain; something applied it by hand. That is gate-5 doctrine drift a fresh install would have inherited. 035 closes it idempotently (guarded ALTER — skipped when already on, so it stays non-owner-appliable in the common case).
- **anon/authenticated held full table grants on `memory_sessions`** (`DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE`) on the live daily driver — Supabase auto-grant residue; migration 014 grants tables to `service_role` only. RLS was already denying them (enabled + service_role-only policy = no matching policy for anon), so revoking cannot break a working path. 035 revokes and the receipt hard-fails if any survive.

**Behaviour matrix, all green** (`<scratchpad>/s84t2-behaviour.sql`, run against the applied container):

| # | assertion | result |
|---|---|---|
| 1 | happy path: trimmed summary, `duration_minutes` derived (20), topics/metadata stored, `ended_at` set, unprocessed | pass |
| 2 | **hostile:** web caller passes a CLI row's bare session UUID as `conversation_key` → gets its OWN `web:claude-web:<uuid>` row; the CLI row's summary and NULL `source_agent` are untouched | pass |
| 3 | amend own unprocessed row → same `id`, summary + count replaced | pass |
| 4 | after `rumen_processed_at` is stamped → `session_locked`, no re-arming a second synthesis pass | pass |
| 5 | cross-agent: `grok-web` and `chatgpt-web` sending the same key land on two distinct rows | pass |
| 6 | 13-case rejection matrix, each matched on its exact reason code | 13/13 |
| 7 | boundary sizes (8000-char summary, 128-char project) accepted | pass |
| 8 | **consumer query — Rumen `extract.ts:110-124` WHERE clause pasted verbatim — selects the web-recorded rows** | pass |
| 9 | sub-floor session (`messages_count=2`) lands in the table and the picker does NOT take it | pass |
| 10 | `anon/authenticated/public EXECUTE = f f f`, `service_role = t`, `search_path` pinned, 0 residual table grants | pass |

**Amendment to my SCHEMA-READY reason-code list** (no lane has built against it yet): the shipped set is 15, not 11 — added `invalid_conversation_key` (the key is the only caller-controlled component of `session_id`, so it is charset-bounded to `[A-Za-z0-9._:@-]`), `started_after_ended`, `ended_at_in_future` (a future `ended_at` would otherwise hold the row inside the picker's lookback window indefinitely; bounded at +24h to absorb clock skew), and `session_locked` (row exists but the upsert guard suppressed the update). Signature and the two guards are unchanged from SCHEMA-READY.

Next in this lane: engram TS mirror + webhook `session_record` op, then the bridge tool + `policy.js` strict-map knob, then the operator block.

### [T4] CHECKPOINT 2026-07-31 18:22 ET — phase 3 non-superuser migration replay complete for current WIP/FIX-LANDED SQL; verified-so-far: in disposable `pgvector/pgvector:pg17` DB `mnestra_s84_clean`, apply role `t4_migrator` has `rolsuper=false`, `rolcreaterole=false`, `rolcreatedb=false`; clean Engram replay 001→034 passed as that role, then 035 and 036 applied and re-applied cleanly; 035 hostile fixtures passed for valid `web:grok-web:<key>` insert, invalid CLI agent rejection, cross-agent conflict rejection, and processed-row `session_locked`; 035 catalog checks show memory_session_record EXECUTE anon/auth/public=`f/f/f`, service_role=`t`, search_path=`public, pg_catalog`, memory_sessions RLS=`t`, and zero PUBLIC-reaching policies; 036 fixtures show `purge_memory_inbox(90)` deletes only old settled rows, leaves old pending rows, health view alarms on stale pending, purge EXECUTE anon/auth/public=`f/f/f`, health SELECT anon/auth=`f/f` and service_role=`t`; Rumen 001→006 replay passed through a local cron stub and final cron shape is exactly one `rumen-inbox-promote` row at `*/10`; caveat: local image lacks real pg_cron, so 036 exercised its no-pg_cron branch while schedule semantics were verified through the stub, not the real extension; pending: audit T2 TS/bridge strict-map landing, T1 harvester landing, and T3 sweep code; most recent worker FIX-LANDED: T2 SQL migration 035 only

### [T4] AUDIT-FAIL 2026-07-31 18:29 ET — [T3] sweep tests are present but not release-gated and do not run cleanly when invoked directly: `/Users/joshuaizzard/Documents/Graciella/rumen/package.json:21` `npm run test` explicitly lists the older suites and omits `/Users/joshuaizzard/Documents/Graciella/rumen/tests/extract-sweep.test.ts`, so the normal Rumen gate passed 196/197 without exercising the new sweep; direct `npx tsx --test tests/extract-sweep.test.ts` began, failed `a missing ledger skips the pass rather than sweeping without idempotency`, then remained open until T4 interrupted it after repeated 30s polls. This blocks T3 FIX-LANDED until the new suite is wired into the default test command and the direct sweep suite exits cleanly.

### [T1] FIX-LANDED 2026-07-31 18:27 ET — Sheets harvester complete: 5 modules, 41 tests green (206/206 bridge suite), zero new dependencies, zero schema change

**Files (all new, none shared with another lane):**

| File | What |
|---|---|
| `packages/mcp-bridge/src/harvest/google-auth.js` | Service-account RS256 JWT to `oauth2.googleapis.com/token`. `node:crypto` only. |
| `packages/mcp-bridge/src/harvest/sheets-api.js` | `values.get` + `values:batchUpdate` over the Bridge's own `clients/http.js`. |
| `packages/mcp-bridge/src/harvest/ledger.js` | Append-only JSONL write-ahead dedup ledger, fsync'd. |
| `packages/mcp-bridge/src/harvest/sheets.js` | The harvest pass: classify, fingerprint, scan, propose, stamp. |
| `packages/mcp-bridge/src/harvest/run.js` | Local-timer runner + `--once`. |
| `packages/mcp-bridge/test/harvest-sheets.test.js` | 41 tests. |
| `docs/SHEETS-INTAKE.md` | Sheet schema + operator activation + troubleshooting. |

`node --test packages/mcp-bridge/test/*.test.js` → **206 pass / 0 fail** (41 mine + the 165 pre-existing; T4's 76-test baseline across the four files they pinned is inside that and unchanged). No edit to any existing source file. No `package.json` change needed — the root test glob already covers `packages/mcp-bridge/test/*.test.js`.

**Acceptance bar, item by item:**
- *fingerprint dedup* — `sha256(sheetId + tab + rowNumber + normalized text)`, separated by a byte that cannot occur in a sheet cell so no field pair can run together and collide. Tested for determinism, per-component sensitivity, and whitespace-insensitivity.
- *forwarded-row skip* — non-empty column E means skipped, and never rewritten.
- *crash-between-insert-and-mark* — the real work of the lane, below.
- *source_agent mapping* — blank goes to `gemini-web`; the four `*-web` values honoured case/space-insensitively; **invalid is quarantined, never coerced**; a CLI value (`claude`, `codex`, ...) can never be minted from a sheet.
- *malformed-row quarantine* — noted in column F, never dropped, never fatal to the batch (test lands 4 bad rows + 1 good; the good one still forwards).
- *E2E* — one fetch double standing in for all three real endpoints, asserting the exact bytes: the jwt-bearer form body + decoded JWT claims (signature verified against the public key), the Sheets GET URL with `'Intake'!A2:F`, the `{op:'propose', source_agent, text, project_hint, metadata}` webhook body with `x-mnestra-secret` in a **header only**, the `RAW` `E2:F2` stamp, and the ledger pair. Then it **reruns against the same unstamped sheet and asserts exactly one proposal ever crossed the wire.**

**The crash-safety design, since it is the part worth auditing.** Two writes per row, two different networks, no shared transaction. The sheet cannot be the dedup substrate because the sheet is precisely what is *not* updated at the moment of the crash. So the ledger is written **before** the insert and fsync'd, and any fingerprint present in *any* phase is never proposed again:

- `forwarded` on rerun: re-stamp the sheet from the ledger's timestamp, no second proposal.
- `inflight` only: indeterminate. Stamped with a visible `[harvest] in-flight when the harvester stopped` note and **never retried**. Deliberate asymmetry — one visible maybe-unforwarded row the operator can see beats a silent duplicate in canonical memory.
- A webhook **400** is the one definitive "not stored" signal (`clients/mnestra.js:138` reframes it with a fixed prefix): recorded `rejected`, reason written to column F. Timeouts/5xx are *not* treated as definitive and are never retried.

Quarantine is deliberately **not** ledgered — it is re-derived every pass, so fixing *any* offending cell un-sticks the row even when the text (and therefore the fingerprint) is unchanged. Ledgering it would have stranded every row whose defect was in column B or C.

**Two things I did beyond the brief, both defensive:**
1. **The ingress secret scan applies here too.** A sheet row is ingress that, once promoted, egresses into every CLI recall — the same inverted threat model `redact.js` exists for. Same rule set, same REJECT-don't-scrub policy, and the note names only the rule class (test asserts the matched secret never appears in the sheet). Without this the Sheets ramp would have been a documented bypass around the exact gate `memory_propose` puts in front of every web chat.
2. **Pinned a latent config-flag outage.** The metadata stamp carries a 64-char hex digest. Under `TERMDECK_BRIDGE_REDACT_ENTROPY=1` a high-entropy rule could plausibly flag it — which would quarantine *every* row and take intake to zero from a single env flag. It currently does not (pure hex is 2 character classes; the rule requires at least 3). There is now a test that fails loudly if that ever changes.

**Cross-lane note for T2 + T4 (no action needed unless T2 disagrees).** `harvest/sheets.js` imports `normalizeWebSourceAgent` and `WEB_SOURCE_AGENTS` from `policy.js` **read-only** — I made no edit to that file (`git diff` on it is entirely T2's in-flight work, which I verified keeps both exports). Reusing the validator rather than re-declaring the vocabulary is what keeps a fifth source-agent value from ever drifting into existence in my module. T2: please keep both exported.

**Flag, not fix (pre-existing, outside my lane).** `packages/mcp-bridge/src/redact.js` contains a literal NUL byte, which makes `grep`/`diff` treat the whole file as binary and silently return nothing — I lost a few minutes to it, and it is exactly how a line hides from an audit. I am not touching a security-critical file mid-sprint; ORCH's call whether it is worth a one-character fix at close-out. My own module holds the same value as a `u0000` escape sequence rather than a raw byte, for this reason.

### [T1] FINDING 2026-07-31 18:27 ET — no Google credentials exist on this machine, so the live-sheet proof is the one thing I cannot close

Restating the dispatch-time gap now that everything else is done, because it is the only open item in my lane and it needs an ORCH decision rather than more code.

`~/.termdeck/secrets.env` has no service-account credential of any kind, and `TERMDECK_SHEETS_*` is unset everywhere. Per brief item 4 I did not block: the code and tests are complete and the env contract is fully documented in `docs/SHEETS-INTAKE.md` § Activation (mint SA, **share the sheet as Editor not Viewer**, set 4 env vars, `node src/harvest/run.js --once`). The faked-transport E2E asserts the real request shapes, so the only thing unproven against Google is Google's own 200.

Two consequences worth ORCH's attention:
1. **This lane ships dark.** `TERMDECK_SHEETS_INTAKE_ENABLED` defaults off and the runner exits immediately without it, so nothing changes on the daily driver until Josh activates. That is the right default, but it means Sprint 84's headline goal — starting the promotion dry-run clock — **does not advance from my lane alone**. The clock starts when Josh does the ~5-minute activation, not when this commits.
2. **If a credential can be minted during the sprint**, the live proof is one command (`node src/harvest/run.js --once` against a throwaway sheet) and I can post the real inbox row id. If not, this is a documented operator step and I close the lane as-is.

### [T1] DONE 2026-07-31 18:27 ET — Sheets intake ramp complete; no cron slot requested from T3; no SCHEMA-READY needed; live-credential activation is the one open operator step

### [T4] CHECKPOINT 2026-07-31 18:30 ET — phase 4 T3 WIP replay complete and phase 5 T1 audit starting; verified-so-far: T3 sweep code has focused tests at /Users/joshuaizzard/Documents/Graciella/rumen/tests/extract-sweep.test.ts:25 and implementation guards at /Users/joshuaizzard/Documents/Graciella/rumen/src/extract-sweep.ts:280, :496, :665, but `/Users/joshuaizzard/Documents/Graciella/rumen/package.json:21` still omits the new suite from `npm run test`; direct sweep suite is green only when run with `ANTHROPIC_API_KEY` explicitly unset (`env -u ANTHROPIC_API_KEY npx tsx --test tests/extract-sweep.test.ts` => 22/22), so the 18:29 T3 AUDIT-FAIL remains as a release-gate/harness issue, not as a proven implementation failure; T3 non-superuser replay applied/re-applied Rumen 007/008 as `t4_migrator` with `rolsuper=false`, RLS on `rumen_extraction_sweep`, zero policies, anon/auth/public table privileges false, service_role SELECT/INSERT/UPDATE true, zero public true policies, `rumen-extract-sweep` scheduled at `40 4 * * *`, and `rumen-inbox-promote` still exactly `*/10`; Rumen `npm run typecheck` passed; caveat: cron command text still contains `<project-ref>` by existing Rumen migration convention and must be stamped at ORCH apply; pending: T1 hostile fixture reproduction, T2 strict-map/bridge landing, and T3 test-gate fix; most recent worker FIX-LANDED processed: T1 Sheets intake (posted 18:27)

### [T3] FIX-LANDED 2026-07-31 18:32 ET — both T4 AUDIT-FAIL items resolved; `npm run test` 219 tests / 218 pass / 0 fail, exit 0 in 5s

T4's audit caught real defects; both were fixed before the audit post landed, so here is the evidence rather than a claim.

**(1) Suite not wired in.** `package.json:21` now ends `… tests/graph-consolidation.test.ts tests/extract-sweep.test.ts`. Verified by running the default command, not by reading the file:
```
$ npm run test
ℹ tests 219   ℹ pass 218   ℹ fail 0   ℹ skipped 1
EXIT=0  WALL=5s
```
219 vs the previous 197 = the 22 new sweep cases. The 1 skip is pre-existing (not mine).

**(2a) The failing case — root cause was the TEST, not the sweep.** `probeSweepCapabilities` probes with `to_regprocedure('public.upsert_memory_entities(uuid,jsonb)')`, so the probe's SQL *contains the RPC's name as a literal*. My assertions searched the recorded calls for that bare substring and therefore matched the probe rather than a write — so "the sweep must not have called the RPC" failed on a call that was only asking whether the RPC exists. Six cases shared the bug. Fixed with an explicit discriminator in `tests/extract-sweep.test.ts`:
```ts
function isRpcCall(sql: string, fn: string): boolean {
  return sql.includes(`select public.${fn}(`);
}
```
The difference it encodes — asked-whether-it-exists vs actually-called-it — is exactly the distinction those assertions are for, so this makes them stricter, not looser.

**(2b) The non-exiting handle — root cause was real, in `src/extract-sweep.ts`.** Not a timer or an unclosed pool: `runExtractionSweep` constructed the Anthropic client *before* selecting candidates, so a test that injected no `deps.anthropic` fell through to `await import('@anthropic-ai/sdk')` and loaded the real SDK. Fixed by moving construction after selection and gating it on there being work:
```ts
const anthropic =
  summary.capabilities.vocabulary && candidates.length > 0
    ? (deps.anthropic ?? (await createAnthropic()))
    : null;
```
This is a production improvement independent of the test: a nightly pass with an empty backlog now costs one SELECT and never loads the SDK at all. Belt-and-suspenders in the test file, `delete process.env['ANTHROPIC_API_KEY']` at module load, so a future test that forgets to inject a model gets the documented no-key degradation instead of a network client.

Both were reproduced and re-verified from a cold `npm run test`, not from an incremental run. Re-verify at your convenience — the artifacts are `rumen/src/extract-sweep.ts`, `rumen/tests/extract-sweep.test.ts`, `rumen/package.json:21`.

Migration replay is in flight (container `s84t3-pg`, non-superuser role); FIX-LANDED for the migrations follows separately.

### [T1] CHECKPOINT 2026-07-31 18:31 ET — R6 compliance confirmed point-by-point; re-verified green against T2's landed policy.js

Read R1–R6 after posting DONE (my 18:27 FINDING was written before R6 was visible — **not** re-litigating it; R6 already answers it and I accept the ruling: no mid-sprint credential mint, activation is a post-sprint operator step via my README).

R6's four named bar items, each with where it is asserted in `test/harvest-sheets.test.js`:
1. **Exact URLs** — token endpoint (`https://oauth2.googleapis.com/token`), the Sheets GET with spreadsheet id + URL-encoded `'Intake'!A2:F`, `/values:batchUpdate`, and `http://localhost:37778/mnestra`. All four matched, and an unexpected URL throws in the fetch double.
2. **JWT claim set** — decoded and asserted in the E2E (`iss`/`scope`/`aud`), plus a dedicated test doing `deepEqual` on the full claim set (`iss`, `scope`, `aud`, `iat`, `exp`) AND verifying the RS256 signature against the generated public key.
3. **`valueInputOption`** — `assert.equal(stamp.valueInputOption, 'RAW')`, with the range pinned to `'Intake'!E2:F2`.
4. **Exact `{op:'propose',...}` body** — `op`, `source_agent`, `text`, `project_hint`, and every `metadata.sheets` field; plus `x-mnestra-secret` asserted present as a **header** and absent from the body.

Other rulings against my lane: R1 (strict-map) is orthogonal — the harvester has no OAuth client and never calls `mapClientToSourceAgent`; it uses `normalizeWebSourceAgent` only. R2 — I do not touch `memory_sessions`. R4/R3b/R5 — no overlap; I added no migration and requested no cron.

**Re-verified after T2's FIX-LANDED:** `node --test packages/mcp-bridge/test/*.test.js` → **206 pass / 0 fail**, exit 0. `policy.js` still exports `normalizeWebSourceAgent` (function) and `WEB_SOURCE_AGENTS` (the four `*-web` values), so my read-only import holds.

**Transient worth one line for T4:** at ~18:29 one run of the suite failed on `PROPOSE_TOOLS` `deepEqual(['memory_propose'])` vs actual `['memory_propose','memory_session_record']` — I caught T2 between landing the new tool and updating that assertion. It self-resolved within ~60s and three subsequent clean runs are 206/206. Flagging only so a stale failure screenshot isn't mistaken for a real regression.

### [T4] AUDIT-FAIL 2026-07-31 18:31 ET — [T1] hostile row-mutation fixture shows a changed sheet row can be marked forwarded even though only the old text was proposed: T4 fake Sheets returned row 2 text=`old text`, then changed the in-memory row to `new text typed before stamp` before `batchUpdateValues`; `harvestOnce` proposed `old text` but still wrote `"'Intake'!E2:F2"` with forwarded_at, leaving the mutated row marked forwarded and therefore skipped forever. Code evidence: `packages/mcp-bridge/src/harvest/sheets.js:236` reads the sheet once, `:346` proposes from that snapshot, and `:390` stamps by row number without re-reading or validating the current text/fingerprint. This blocks T1 AUDIT-PASS because T4's mandate explicitly includes “a row that mutates between read and mark,” and the current behavior can silently drop the edited content.

### [T4] AUDIT-FAIL 2026-07-31 18:33 ET — [T3] runbook still preserves the two-name cron hazard ORCH R3b ruled out: `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md:124` unschedules `inbox-promote`, `:129` schedules jobname `inbox-promote`, and `:146` verifies `where jobname = 'inbox-promote'`; R3b/006 made canonical jobname `rumen-inbox-promote` at `*/10` and T3's own FIX-PROPOSED said runbook §A3 would be reconciled. This blocks T3 AUDIT-PASS until Part A3 uses `rumen-inbox-promote`, unschedules both legacy and canonical names, and verifies the canonical row so an operator following the runbook cannot double-schedule the promoter.

### [T4] AUDIT-FAIL 2026-07-31 18:33 ET — [T2] operator surface for the new bridge writes is stale/misleading even though the code path is present: `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md:19-39` still describes only `memory_propose`, `:180-198` documents only `TERMDECK_BRIDGE_ENABLE_PROPOSE` and the old healthz count, and the runbook has no `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` or `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` activation block despite code gates at `packages/mcp-bridge/src/tools/index.js:81` and `packages/mcp-bridge/src/policy.js:276`. Also, `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md:177` says `TERMDECK_BRIDGE_PROPOSE_MAP` is “env-inlined JSON,” but the parser at `packages/mcp-bridge/src/policy.js:240-246` accepts comma-separated `client_id=source-agent` pairs. This blocks T2 AUDIT-PASS until the operator block matches the shipped gates/parser and states the changed tool-count expectation.

### [T4] CHECKPOINT 2026-07-31 18:35 ET — phase 6 post-compaction audit resumed; verified-so-far: no worker post after T4's 18:33 failures is visible in STATUS, `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` now contains a Part A3 delta toward canonical `rumen-inbox-promote` with both-name unschedule/rollback coverage, but T4 has not yet re-read the full operator surface or rerun hostile fixtures against the current file state; pending: re-audit T1 row-mutation guard, T2 session-record/strict-map operator docs, T3 runbook reconciliation, then only post AUDIT-PASS entries for independently reproduced fixes

### [T4] AUDIT-FAIL 2026-07-31 18:36 ET — [T1] the first row-mutation fix closes text edits but still loses same-text source/project edits: current `packages/mcp-bridge/src/harvest/sheets.js:112-127` correctly hashes A-D for the pre-stamp guard and `:437-452` withholds the stale stamp, so T4's old-text fixture now passes (`mutatedSkipped=1`, no write, next pass proposes `new text typed before stamp`). However `rowFingerprint()` at `packages/mcp-bridge/src/harvest/sheets.js:100-109` still keys only `(sheet, tab, row, text)`. T4 reproduced row 2 project changing from `old-project` to `new-project-before-stamp` during `propose()`: first pass proposed `{text:"same text", projectHint:"old-project"}` and wrote nothing; second pass made zero Mnestra calls, reported `restamped=1`, and wrote `"'Intake'!E2:F2"` over the current row whose project was `new-project-before-stamp`. Because source and project are part of the proposal payload, this still marks edited operator content forwarded without ever proposing it. T1 needs the dedup key or ledger/retry logic to account for all operator-authored payload fields, not text alone.

### [T3] FIX-LANDED 2026-07-31 18:38 ET — runbook §A3 + Rollback reconciled; full non-superuser replay green on container `s84t3-pg` (chain 001→034 → T2's 035 → my 036)

**Runbook reconcile (T4's 18:33 AUDIT-FAIL).** `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` §A3 now points at `rumen/migrations/006_pg_cron_inbox_promote.sql` as the source of truth, and the hand-SQL matches it: unschedules **both** names, schedules `rumen-inbox-promote` at `*/10`, and the verify query matches `like '%inbox-promote%'` rather than the canonical name — a query for the canonical name structurally cannot see the failure it is there to catch (a surviving legacy registration).

**T4 listed three sites; there was a fourth.** The **Rollback** block at :287 also carried only the legacy name, which is the worse instance: an operator rolling back would unschedule `inbox-promote`, see success, and leave `rumen-inbox-promote` running — believing the drain was stopped while it kept promoting. Fixed the same way, plus a confirm query (`expect 0 rows`). The remaining `inbox-promote` strings in the doc (:30, :40, :72, :89, :93, :110, :156) are the **Edge Function** name, which did not change and must not.

**Non-superuser replay — evidence.** Container `s84t3-pg` (`pgvector/pgvector:pg17`), applied as role `mig`: not superuser, not owner of anything it did not create. Production-shaped: `anon` / `authenticated` / `service_role` present, migration 014's `alter default privileges … grant execute on functions to service_role, authenticated, anon` in force, `vault.decrypted_secrets` shimmed, `pg_cron` installed as a shim extension so the guarded branches actually execute rather than always taking fail-soft.

| step | result |
|---|---|
| engram chain `001` → `034` as `mig` | **34/34 clean** |
| T2's `035_memory_session_record.sql` | clean (applied first — real production order) |
| my `036_memory_inbox_hygiene.sql` on top | clean, hard-failing receipt passed |
| `036` re-apply ×3 (incl. once with `pg_cron` present) | clean; job registered **once**, never stacked |
| rumen `007_extraction_sweep_ledger.sql` ×2 | clean; RLS=t, policies=0, anon/authenticated hold **zero** table grants |
| rumen `006` / `008` ×3 each | clean, idempotent |

Receipt output on the live-shaped apply:
```
[036] memory_inbox RLS enabled: t (expect t); policy count: 0 (expect 0)
[036] public.purge_memory_inbox(integer) EXECUTE — anon:f, authenticated:f, public:f; service_role:t; proconfig: search_path=public, pg_catalog
[036] memory_inbox_health security_invoker=true: t; SELECT — anon:f, authenticated:f; service_role:t
```

**Runtime privilege proof** (catalog agreement is not execution; both were checked):
```
anon          → permission denied for view memory_inbox_health
anon          → permission denied for function purge_memory_inbox
anon          → permission denied for table memory_inbox
authenticated → permission denied for view / function
service_role  → SUCCESS on both
```

**Purge behaviour matrix.** Fixture spanning status × age, including a 300-day pending row carrying a promoter claim lease in `metadata.rumen`:

| row | expected | actual |
|---|---|---|
| 200d **pending** | survives | survived |
| 300d **pending, claimed** | survives | survived |
| 200d rejected | deleted | deleted |
| 200d promoted | deleted | deleted |
| 10d rejected | survives | survived |
| 1h pending | survives | survived |

`purge_memory_inbox(90)` → 2. Adversarial: `purge(0)` → 1 (the 10-day settled row; `greatest(0,1)` clamps to a 1-day retention — settled rows past it are correctly in scope) and `purge(-5)` → 0. **Pending count was unchanged by every call at every retention value, which is the property that matters.**

**Alarm view matrix.** empty inbox → one row, `alarm=f`, `"ok: no pending proposals"` (no NULL-arithmetic blowup on the missing `oldest_pending_at`). Young pending → `alarm=f`. Boundary: 7d−1min → `f`; 7d+1min → `t`. Alarming state renders `ALARM: oldest pending proposal is 300d old (>7d) across 3 pending row(s) — the promotion drain is not running` plus the exact cron query to run next. Throughput counters (`arrived_24h` / `promoted_24h` / `rejected_24h`) verified against a mixed fixture.

**Cron collapse — the case the whole reconcile exists for.** Seeded the real double-fire state (both `inbox-promote` and `rumen-inbox-promote` registered, different cadences), applied `006`: collapsed to exactly one row, `rumen-inbox-promote | */10 * * * * | t`, and the migration's receipt confirmed `registrations after collapse: 1 (expect 1)`. Then ran the **reconciled runbook's** A3 block verbatim from a legacy-only state — converged to the identical single row — and its Rollback block — cleared to zero rows. Migration and doc now provably agree.

Final cron ledger on the replay container, no collisions:
```
rumen-inbox-promote | */10 * * * *
mnestra-inbox-purge | 20 4 * * *
rumen-extract-sweep | 40 4 * * *
```

**T1's cadence request is closed** — T1 posted at 18:13 that Sheets intake cannot be pg_cron-driven and needs no slot from me, and re-confirmed at DONE. No slot allocated; nothing left unanswered on contract #2.

### [T4] AUDIT-PASS 2026-07-31 18:37 ET — [T3] inbox hygiene + cron + extraction-sweep artifacts now meet the Sprint 84 T4 bar: independently re-read `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` §A3/rollback and confirmed canonical `rumen-inbox-promote`, both-name unschedule, `*/10` cadence, and pattern verification so the old two-name hazard is observable; re-ran `/Users/joshuaizzard/Documents/Graciella/rumen npm run test` with the sweep suite release-gated at `package.json:21` (219 tests / 218 pass / 1 pre-existing skip / 0 fail) and `npm run typecheck` (clean); prior T4 non-superuser replay remains valid for migrations 006/007/008 plus Engram 036, and T3's 18:38 replay independently exercised the reconciled runbook A3 and rollback. T3 has no remaining T4 blocker; still open outside T3: T1 row mutation same-text source/project loss and T2 stale operator docs.

### [T4] CHECKPOINT 2026-07-31 18:38 ET — phase 7 bridge re-audit complete; verified-so-far: `node --test packages/mcp-bridge/test/*.test.js` is green at 241/241 after current T1/T2 edits, including new first-pass row-mutation tests, but T4 independently re-ran the second-pass same-text project-edit fixture and it still fails exactly as 18:36 described (`proposed=0`, `restamped=1`, no Mnestra call, E2:F2 stamped over the edited project); T2 code-level session-record tests are green and show independent gates/strict-map/no-session-id, but `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` Part B still names only `memory_propose`, still documents `TERMDECK_BRIDGE_PROPOSE_MAP` as JSON rather than CSV pairs, still omits `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` and `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP`, and still says healthz `tools` moves 2→3 instead of the current 6→7→8 model. Lane state: T3 AUDIT-PASS, T1 AUDIT-FAIL open, T2 AUDIT-FAIL open.

### [T3] DONE 2026-07-31 18:38 ET — inbox hygiene + extraction sweep complete; SR-7 recommendation is NO with the evidence path now built

**Delivered — 8 artifacts.**

| # | artifact | what it is |
|---|---|---|
| 1 | `engram/migrations/036_memory_inbox_hygiene.sql` | `purge_memory_inbox(int)` (90d, settled-only) + `memory_inbox_health` view + `mnestra-inbox-purge` cron @ 04:20 UTC |
| 2 | `rumen/migrations/006_pg_cron_inbox_promote.sql` | restores the promoter as `rumen-inbox-promote` @ `*/10`, collapsing both legacy names |
| 3 | `rumen/migrations/007_extraction_sweep_ledger.sql` | `rumen_extraction_sweep` idempotency ledger |
| 4 | `rumen/migrations/008_pg_cron_extract_sweep.sql` | `rumen-extract-sweep` cron @ 04:40 UTC |
| 5 | `rumen/src/extract-sweep.ts` | the backstop sweep (~640 LOC), exported from `src/index.ts` |
| 6 | `rumen/tests/extract-sweep.test.ts` | 22 cases, wired into `npm run test` (219 total / 218 pass / 0 fail / exit 0) |
| 7 | `termdeck/packages/server/src/setup/rumen/functions/rumen-extract-sweep/` | Deno Edge Function + tsconfig, watchdog'd like its siblings |
| 8 | `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` §A3 + Rollback | reconciled to the migration |

**SR-7 (`memory_entity_relationships`) — recommendation: NO.** Not "not yet because I ran out of time" — **there is still zero evidence**, and that is itself the finding. `memory_entities` and `memory_entity_mentions` are at 0 because all three write paths miss extraction (my 18:12 FINDING), so no triple has ever been produced on this store. Building an entity-edge table now would be building storage for a volume nobody has measured, against a schema nobody has seen real data shaped like.

What I did instead is make the decision cheap to revisit with real numbers: the sweep extracts triples, caps them, reports `triples_found` + a 10-row `triples_sample` on every pass, and persists the per-item count in `rumen_extraction_sweep.triples_found`. After one live sweep the ruling becomes a query:
```sql
select count(*) filter (where triples_found > 0) as items_with_triples,
       sum(triples_found)                        as triples_total,
       round(avg(triples_found) filter (where triples_found > 0), 2) as avg_per_item
  from rumen_extraction_sweep;
```
If that comes back with real density, SR-7 has a case and a shape. If it comes back near zero, the table was never needed and we found out for the price of a column instead of a migration. No table created; nothing blocked either way.

**Two items for ORCH at close-out — both would silently no-op if missed.**

1. **Vendoring gap.** The bundled chains lag: `packages/server/src/setup/mnestra-migrations/` stops at `034`, and `packages/server/src/setup/rumen/migrations/` stops at `005`. **Rumen `007` in particular is load-bearing** — without the ledger the sweep skips every run with `rumen_extraction_sweep missing`, and that skip returns HTTP 500 rather than a fake 200, so it will be visible rather than silent, but it will also never do any work. ⚠ The two rumen chains **disagree at `003`** (repo = `pg_cron_inbox_promote`, vendored = `graph_inference_schedule`), so this is not a copy — someone has to decide the vendored numbering. Flagging, not guessing; it is above my lane.
2. **Edge Function version pin.** `rumen-extract-sweep/index.ts` imports `npm:@jhizzard/rumen@0.10.0`, which does **not** yet contain `runExtractionSweep`. Bump the specifier to whatever version ships this sprint **before** `supabase functions deploy rumen-extract-sweep`, or the deploy resolves to a package without the export.

**Apply order at close** (all ORCH/Josh — no lane applied anything to the daily driver):
```
engram   035 (T2) → 036 (T3)
rumen    006 → 007 → 008        # 008 only after the function is deployed
deploy   supabase functions deploy rumen-extract-sweep   (+ DATABASE_URL, ANTHROPIC_API_KEY)
```
Recommended first live run is `RUMEN_SWEEP_DRY_RUN=1` — it reports what it would write, touching nothing, exactly like graph-consolidation's first pass this evening.

**What restoring the promoter actually starts.** The `*/10` job restarts the promotion **dry-run clock** that PLANNING says the Phase 4 gate needs ~2 weeks of. It does not flip auto-promote; that remains Josh's ~08-13 decision. From tonight the inbox has both a working drain and an alarm that fires if the drain stops — which is the state the 2-week statistic requires to mean anything.

**Replay container `s84t3-pg` is still running** so T4 can re-verify without rebuilding it (`docker exec s84t3-pg psql -U mig -d postgres`; password `mig`). Teardown when done: `docker rm -f s84t3-pg`.

No version bumps, no CHANGELOG edits, no commits, nothing applied to the daily driver.

### [T4] AUDIT-FAIL 2026-07-31 18:40 ET — [T2] runbook WIP fixed the overview/map/strict-map pieces but the operator activation path is still stale: `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md:19-89` now describes both write channels, `:258-273` corrects `TERMDECK_BRIDGE_PROPOSE_MAP` to comma-separated `client_id=source-agent` pairs, and `:278-336` documents `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1`; however `:233` still titles Part B as enabling only `memory_propose`, `:338-348` still flips only `TERMDECK_BRIDGE_ENABLE_PROPOSE` and omits `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` plus its rate knobs, `:356-360` still says healthz `tools` goes 2→3, and rollback at `:404` still says tools return to 2. The code/test truth is `packages/mcp-bridge/test/session-record.test.js:510-522`: the two write channels are independently gated and operator-visible tools move 6→7→8. T2 AUDIT-PASS remains blocked until Part B and rollback match that model.

### [T1] FIX-LANDED 2026-07-31 18:41 ET — both AUDIT-FAILs closed: ONE fingerprint over A–D, used by the ledger AND the pre-stamp guard; 50 tests green (243/243 suite)

T4 is right on both counts, and the second call was the more important one: the half-fix was worse than either extreme because the two hashes *disagreed*, and the disagreement is what let a stamp land on content that was never proposed. Collapsed to one definition.

**`rowFingerprint({spreadsheetId, tab, row, cells})`** — `sha256` over sheet id, tab, row number, and **all four operator-authored cells** (`ts`, `source`, `project`, `text`). `rowStateHash` is **deleted**; `grep -rn rowStateHash src/ test/` returns nothing. The same value is now:
- the **ledger dedup key** (have I proposed this row?), and
- the **pre-stamp guard** (is this still the row I acted on?).

Computed once per row from the read-time snapshot, before any `await`, and passed through to every queued write. Columns E/F are excluded — including them would make the harvester's own stamp invalidate the fingerprint and every row would re-propose forever (asserted).

**T4's fixture added verbatim** — `T4 fixture: SAME TEXT with an edited project must re-propose on pass 2, not stamp over the edit`: project `old-project` → `new-project-before-stamp` mid-propose, text untouched. Pass 1 proposes with `projectHint='old-project'` and withholds the stamp (`mutatedSkipped=1`); **pass 2 now reports `restamped=0`, `proposed=1`, and calls Mnestra with `projectHint='new-project-before-stamp'`** and the same text. Previously pass 2 was `restamped=1` / zero Mnestra calls / stamped over the edit.

Also added: a direct unit assertion that a project-only edit moves the fingerprint, a separator test across the cell fields, and per-column sensitivity for all four of A–D.

**Tests: 50 in my file, 243/243 across the bridge suite, 0 fail.** Syntax clean, no NUL bytes.

**Consequence of the wider key, stated plainly so it is a decision and not a surprise.** Editing *any* of A–D on an already-forwarded row now yields a new fingerprint and therefore a new proposal — including a change to `ts` alone, which would re-propose identical text under a new `captured_at`. I think that is correct (`ts` becomes `captured_at` in the payload, so it *is* payload-affecting, and the promoter's dedup gates are the right place to collapse near-identical text), and it is what R-consistency demands. Flagging it rather than quietly narrowing the key back, because narrowing is exactly how this bug was born.

**Operational trap this creates, now documented.** A volatile formula in column A (`=NOW()`, `=TODAY()`) changes value on every read, so such a row would look edited on every pass and **never** get stamped. `docs/SHEETS-INTAKE.md` § Rules the sheet must obey now warns to paste a static timestamp or leave column A empty. Worth T4's eye — it is the one way a correct-looking sheet could silently never forward.

**Residual window, unclosed and I am not claiming otherwise.** The gate re-reads immediately before writing, which narrows the exposure from the whole propose pass to the re-read→write gap. It does not eliminate it: the Sheets `values` API has no compare-and-swap, so a mutation landing inside those milliseconds is still stampable. Closing it fully needs a per-row revision token the API does not expose. Documented in the code comment and in the operator doc.

### [T4] AUDIT-PASS 2026-07-31 18:42 ET — [T1] Sheets intake now meets T4's hostile row-mutation bar: `packages/mcp-bridge/src/harvest/sheets.js:121-133` computes one fingerprint over sheet id, tab, row, and A-D (`ts/source/project/text`), `:299-303` computes it once from the read-time snapshot, ledger lookup uses it at `:321-323`, queued writes carry it at `:265-286`, and pre-stamp verification recomputes the same value from the fresh row at `:455-461`; `rowStateHash` is gone. T4 independently reran the same-text project-edit fixture: pass 1 proposed `old-project` and withheld the stamp (`mutatedSkipped=1`, writes=0), pass 2 made a new Mnestra call with `projectHint="new-project-before-stamp"`, `proposed=1`, `restamped=0`, then stamped only after the row was stable. Verification: `node --test packages/mcp-bridge/test/harvest-sheets.test.js` passed 50/50 and `node --test packages/mcp-bridge/test/*.test.js` passed 243/243. Residual accepted caveat: Sheets has no compare-and-swap, so the tiny re-read→write window remains, and `docs/SHEETS-INTAKE.md:45-47` now warns against volatile timestamp formulas.

### [T2] FIX-LANDED 2026-07-31 18:42 ET — bridge tool + policy strict-map + client op + vendored 035 + runbook reconciled (answers T4 AUDIT-FAIL 18:33 and 18:40)

**Code.**

- `packages/mcp-bridge/src/tools/session-record.js` (NEW) — `memory_session_record`. Same fail-closed pipeline as `propose.js`: server-derived identity → caps → per-connector token bucket → ingress secret scan (REJECT, never scrub) → forward. Own bucket set, own gate.
- `packages/mcp-bridge/src/clients/mnestra.js` — `sessionRecord()`, the client's second and last write op. Maps webhook 400 → refusal with reason, **501 → "this Mnestra build has no session_record op"** rather than a generic 5xx that reads as retryable.
- `packages/mcp-bridge/src/policy.js` — `WRITE_CHANNEL_TOOLS = {memory_propose, memory_session_record}`; `PROPOSE_TOOLS` kept as an alias of the **same Set object** because `server.js:125` reads it by that name to decide which tools keep an honest `readOnlyHint:false`. Added `record`/`capture` to `MUTATING_VERBS` so a future `*_record` tool that forgets or lies about its hints is still rejected by-token. Added `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP` (**default OFF**) + `isStrictMapMode()`.
- `packages/mcp-bridge/src/tools/index.js` — `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` (**default OFF**), independent of the propose gate.
- Vendored `035_memory_session_record.sql` into `packages/server/src/setup/mnestra-migrations/` (byte-identical, `cmp`-verified), added its two-sided `MIGRATION_PROBES` entry, bumped `BUNDLE_MAX` 34 → 35. **T3: `sync-mnestra-migrations.js` also pulled your 036 — I deleted the vendored copy so it stays yours. When you vendor it, raise `BUNDLE_MAX` to 36; don't lower it.** The probe deliberately checks `memory_sessions.source_agent`, not `.metadata` — `metadata` is declared by migration 001, so probing it would report 035 applied on any canonical install where it never ran.

**Rate-limit default changed during the e2e run, and the reason is worth recording.** First draft was burst 2 / 6-per-hour. The end-to-end harness hit the ceiling on its **third legitimate call** and could not exercise the amend path at all. That is not a harness artifact: the bucket is keyed on `client_id`, and one `client_id` serves *every conversation on that surface* — so a tight burst throttles a busy hour, not a chatty conversation. Now 12/hour, burst 4, env-tunable. The durable backstops are downstream anyway (the RPC refuses another agent's row or an already-swept one), so an accepted burst buys at most a few extra rows in the learning queue.

**Live-shaped proof — 30/30 checks, every layer real.** `<scratchpad>/s84t2-e2e.mjs`: real bridge tool → real `policy.js` → real redact scan → real `createMnestraClient` → real HTTP → real engram `dispatchOp` → real `memorySessionRecord` TS mirror → **real RPC in the pg17 container with 001→035 applied non-superuser**. Only substitution is the supabase-js transport (no PostgREST in the container); the RPC executed is the shipped one. Ran with `STRICT_MAP=1` and the connector explicitly mapped — the posture Part B4 recommends.

```
mounted tools (7): memory_recall, memory_search, list_panels, panel_status, read_panel, recent_activity, memory_session_record
row: web:chatgpt-web:e2e-chatgpt-001|chatgpt-web|termdeck|9|true|25|["sprint-84","session-record"]|mcp_chatgpt_e2e
PASS  Rumen's own picker query WOULD sweep this row — picker matched 1
PASS  CLI row is untouched — got "CLI panel-close summary"
PASS  post-sweep amendment refused ... with session_locked surfaced to the connector
PASS  unmapped connector refused under strict map ... and nothing was written
ALL CHECKS PASSED
```

Covered: happy path → row → `duration_minutes` derived → bridge provenance stamp survived; **the hostile case** (web caller passes a CLI row's session UUID as its key → lands on its own namespaced row, CLI summary untouched); amend → then `session_locked` after the sweep stamp; strict-map refusal writes nothing; secret ingress refused end-to-end with the secret never echoed; token bucket gates at the burst edge.

**Tests.** mcp-bridge 243/243 · engram 458 (456 pass, 0 fail, 2 pre-existing skips) — 3 new engram files (`session-record`, `webhook-session-record`, `migration-035-hygiene`) + `test/session-record.test.js` in the bridge. Migration-drift suite 5/5. `scripts/lint-docs.sh` OK; gitleaks clean on the runbook.

**T4 AUDIT-FAIL responses (both rounds).**

1. **Overview described only propose** — rewritten as two explicitly independent channels, each with its own diagram and its own flag, plus why Channel 2 is a second quarantine rather than a hole in the first (no recall path reads `memory_sessions`; `rumen-tick` synthesis is the gate; the two RPC guards).
2. **Only `ENABLE_PROPOSE` documented** — B2 now states the channels are separately gated and points at Part C; **Part C** (C1–C5) is new: migration/build preconditions, `TERMDECK_BRIDGE_ENABLE_SESSION_RECORD` + its rate knobs, bounce, end-to-end verification using the picker's own WHERE clause, and what a repeat call does.
3. **Stale healthz count** — replaced the flat "2 → 3" with an origin-dependent table: **full origin 6 → 7 → 8**, memory-only origin 2 → 3 → 4, because the old text silently assumed a memory-only cloud origin while this host reports `mode:"full"`. Preconditions now tell the operator to record their own baseline first, with an explicit "an 8 is not drift" note. Matches `test/session-record.test.js`'s `both.length === 8` assertion.
4. **`TERMDECK_BRIDGE_PROPOSE_MAP` documented as env-inlined JSON** — **confirmed a real pre-existing doc bug, and worse than it looks.** `loadProposeMap` splits on commas then on the first `=`; JSON pasted there yields **zero** entries *silently*, so every client falls through to the heuristic (or, under strict mode, is refused). Corrected in place with the real shape, the trim/whitelist/override rules, and a note that both sources are re-read per call so adding a client needs no restart.

Also done in the same pass: Part B retitled (B1+B4 are shared identity, B2/B3 are Channel 1), rollback rewritten (independent flags; `tools` falls back to *this origin's* baseline, not a fixed 2; plus a no-restart narrowing via the strict map, and how to neutralize un-swept web rows without deleting the audit trail), safety notes extended, and the ORCH-at-close section updated — all three flags ship default-OFF, and B4 is flagged as the one item worth doing **even with both channels off**, since it concerns a channel that is already on.

**T3's heads-up honored:** every `inbox-promote` string is the Edge Function / job name and I changed none of them (22 occurrences, untouched). I did not touch Part A, and I left your `rumen-inbox-promote` rollback edit alone.

### [T2] DONE 2026-07-31 18:45 ET — session-record channel + identity-map extension complete; both acceptance bars met

Lane scope (arc 4.4 + 4.8) delivered in full. Files touched, all mine or explicitly coordinated:

- **engram (mnestra):** `migrations/035_memory_session_record.sql`, `src/session_record.ts`, `src/types.ts` (+`SessionRecordInput`/`Result`), `src/webhook-server.ts` (`session_record` op, 501 when a pre-84 deps object is in play — never a 200 for a write that did not happen), `tests/{session-record,webhook-session-record,migration-035-hygiene}.test.ts`.
- **termdeck:** `packages/mcp-bridge/src/tools/session-record.js`, `src/tools/index.js`, `src/clients/mnestra.js`, `src/policy.js`, `test/session-record.test.js`, `test/policy.test.js` (registry assertion widened 1 → 2 names), `packages/server/src/setup/mnestra-migrations/035_*.sql` + `migrations.js` probe + drift-test `BUNDLE_MAX`, `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md`.

**Acceptance bar 1 — tests.** All present and green: identity-map fail-closed for unknown clients (no write, explicit operator-actionable error), correct `source_agent` for each mapped connector, canonical `memory_sessions` shape, size caps at every boundary, gate-OFF path inert (tool absent from the listing, not present-and-erroring), healthz tool count asserted (`both.length === 8`). Plus the invariant that the design rests on, asserted three ways (TS mirror, webhook dispatch, bridge tool): **no `session_id` under any spelling ever crosses the wire.**

**Acceptance bar 2 — one live-shaped proof.** Delivered as 30/30 in `s84t2-e2e.mjs`, including the consumer-query requirement done the S83 T2 way: **Rumen's `extract.ts:110-124` WHERE clause pasted verbatim**, run against the real applied schema, matching the row the bridge had just written. Also proven the negative: a `messages_count=2` session lands and the picker does **not** take it.

**No `memory_inbox` schema change from this lane**, per PLANNING contract 1. My only schema change is `memory_sessions`, posted as SCHEMA-READY at 18:12 before I built against it; the shipped reason-code set grew from 11 to 15 (amendment recorded in the 18:18 FIX-LANDED — signature and both upsert guards unchanged).

**Three things ORCH should carry into close-out:**

1. **The propose channel is live and already open to ChatGPT + Grok** (18:12 FINDING). That is true *today*, independent of anything this sprint ships. If that is not the intended posture, the fix is Part B4 of the runbook — enumerate the 8 unmapped ChatGPT/Grok `client_id`s, add them explicitly, then set `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1`. I shipped the knob default-OFF because flipping it is an operator-posture call, not a lane decision.
2. **On a clean 001→034 chain, `memory_sessions` ends with RLS OFF.** The live daily driver has it ON, so that came from something other than the migration chain — a fresh install would have inherited the gap. 035 closes it idempotently and hard-fails its receipt if it is not. Worth a look at whether other tables share the pattern; that is beyond my lane.
3. **Both new gates and the strict-map knob ship default-OFF.** Nothing in this lane changes behaviour on Josh's machine until he sets a flag. The one thing that DOES change on `termdeck init --mnestra` is migration 035 itself — additive columns + a new RPC, no rewrite of existing rows.

Not in scope, deliberately untouched: T1's harvester, T3's cron/sweep surface and migration 036, Part A of the runbook.

Handing off. `<scratchpad>/` holds `s84t2-nonsuper-apply.sh`, `s84t2-behaviour.sql`, and `s84t2-e2e.mjs`; the `s84t2-pg` container is still up if T4 wants to re-run any of them against the same applied schema — `docker rm -f s84t2-pg` when finished with it.

### [T4] AUDIT-PASS 2026-07-31 18:44 ET — [T2] Session-record lane now meets T4's bar. Prior non-superuser replay already applied Engram 001→034 plus 035 as `t4_migrator` and verified valid web rows, invalid CLI-agent rejection, cross-agent conflict rejection, processed-row `session_locked`, pinned search_path, RLS on, and EXECUTE denied to anon/auth/public but granted to service_role. The TermDeck vendored copy is byte-identical to Engram 035 (`cmp -l` produced no output), `packages/server/src/setup/migrations.js:203-218` probes both the new RPC and `memory_sessions.source_agent`, and `packages/server/tests/mnestra-migration-bundle-drift.test.js:55-59` holds `BUNDLE_MAX=35` while explicitly leaving T3-owned 036 for close-out; `node --test packages/server/tests/mnestra-migration-bundle-drift.test.js` passed 5/5 with only the expected pending-sync note for 036. Bridge gating evidence remains green from T2/T4 replay: `packages/mcp-bridge/test/session-record.test.js:504-523` asserts default absence and independent 6→7→8 mounting, and full bridge verification passed 243/243. The operator runbook is no longer stale: `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md:19-89` defines both independent channels, `:272-290` documents the real CSV `TERMDECK_BRIDGE_PROPOSE_MAP` parser, `:375-390` gives origin-dependent healthz counts, `:398-485` adds the session-record activation/verification path, and `:520-638` covers independent rollback and Channel 2 safety. Residual caveat is operational, not a lane blocker: live daily-driver `memory_sessions` still lacks 035 until ORCH/Josh applies it.

### [T4] FINAL-VERDICT 2026-07-31 19:29 ET — GREEN — STATUS re-read confirms all three workers are DONE (T1 18:27, T3 18:38, T2 18:45) and all three have T4 AUDIT-PASS (T3 18:37, T1 18:42, T2 18:44), with no unresolved AUDIT-FAIL remaining. Basis: T4 independently reproduced the live pre-sprint baseline, ran non-superuser replays for Engram 035/036 and Rumen 006-008, verified 035 hostile RPC cases and five-gate RLS/EXECUTE posture, verified 036 purge/health semantics, verified canonical `rumen-inbox-promote` at `*/10`, ran the Rumen release gate at 219 tests (218 pass / 1 pre-existing skip / 0 fail) plus typecheck, ran the bridge suite at 243/243, reproduced and then cleared the Sheets same-text project-edit hostile fixture, and verified T2's default-off/independent-gate/no-session-id session-record path plus runbook/operator corrections. Accepted residuals: Sheets still has the documented no-CAS re-read-to-stamp window, and live 035/036 daily-driver apply remains pending ORCH close-out.
