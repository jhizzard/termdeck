# Sprint 51.5b STATUS — v1.0.5 Dogfood Audit (3+1+1)

**Plan refreshed:** 2026-05-04 ~14:30 ET — baseline shifted from v1.0.3 → v1.0.5. Sprints 51.8 (Class N — settings.json wiring lockstep, ships v1.0.4) + 52.1 (Class A — match_memories signature-drift guard, ships v1.0.5) shipped between the morning's planning and inject. Joshua's daily-driver `petvetbid` was freshly init'd against v1.0.5 at 14:26 ET — full clean exit 0, all 17 migrations applied, mig 001 took 9.4s (do$$ guard rebuilt match_memories on petvetbid's drift signature). Hook is at v2; settings.json is wired under SessionEnd. The full v1.0.x onion is now structurally closed.

**Target:** No new package versions in this sprint. Sprint closes when T1+T2+T3 report DONE green AND T4-CODEX posts `DONE — VERIFIED`. Any RED surfaces a Sprint 51.9 hotfix (51.8 + 52.1 already shipped).

## Lane status

| Lane | Owner | Status | Notes |
|---|---|---|---|
| T1 — petvetbid post-v1.0.5 verification + idempotency probe | Claude | PENDING | Verifies the v1.0.5-clean petvetbid state holds across re-runs + tests. Brief: `T1-petvetbid-audit-upgrade-and-hook-refresh-dogfood.md`. |
| T2 — mnestra doctor + metadata completeness dogfood | Claude | PENDING | Brief: `T2-mnestra-doctor-and-metadata-dogfood.md`. |
| T3 — Fresh-project end-to-end + Brad outreach prep | Claude | PENDING | Brief: `T3-fresh-project-and-brad-outreach.md`. |
| T4-CODEX — Independent audit (Brad-shape reproduction) | Codex | PENDING | Brief: `T4-codex-independent-audit.md`. Mnestra MCP wired (2026-05-04 ~11:00 ET) — boot can use `memory_recall`. STATUS.md remains the canonical durable substrate. |

## Pre-sprint substrate (orchestrator probe at 14:30 ET)

```
npm view @jhizzard/termdeck version           → 1.0.5
npm view @jhizzard/termdeck-stack version     → 0.6.5
npm view @jhizzard/mnestra version            → 0.4.2 (unchanged since 51.6)
npm view @jhizzard/rumen version              → 0.4.5 (unchanged since 51.5)

Joshua's petvetbid 14:26 ET wizard run:
  → Refreshing ~/.claude/hooks/memory-session-end.js... ✓ up-to-date (v2)
  → Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ already wired (SessionEnd)
  → Connecting to Supabase... ✓
  → Applying migration 001_mnestra_tables.sql... ✓ (9401ms)   ← do$$ guard rebuilt match_memories on petvetbid drift
  → ... 16 other migrations all applied cleanly
  → Audit-upgrade: probing for missing mnestra schema artifacts... ✓ (install up to date — 6 probes all present)
  → Verifying memory_status_aggregation()... ✓ (6,340 active memories found)

Net state: petvetbid is structurally clean as of 14:26 ET. Sprint 51.5b verifies idempotency + metadata + Brad-shape reproduction.
```

## FINDING / FIX-PROPOSED / DONE log

(append-only; all lanes post in the canonical uniform shape per CLAUDE.md hardening rule 2: `### [T<n>] STATUS-VERB 2026-05-04 HH:MM ET — <one-line gist>` followed by evidence/details. The `### ` prefix is REQUIRED on Claude lanes too — Sprint 51.7 T3 missed T1's bare-prefix DONE for many minutes due to regex mismatch.)

---

### [T4-CODEX] CHECKPOINT 2026-05-04 14:42 ET — Phase 0 boot complete; Phase 1 starting

Phase: 0/1 transition — boot + file substrate complete; beginning Phase 1 Brad-shape fixture provisioning.

Verified so far:
- Mnestra MCP is reachable but `memory_recall` is not usable in this Codex runtime: both requested recalls failed with Postgres overload ambiguity on `public.memory_hybrid_search(...)` (two candidate signatures, one with `recency_weight`/`decay_days`). Per lane brief fallback, T4 is using file-only substrate.
- Read `~/.claude/CLAUDE.md`; checkpoint discipline, uniform `### [T<n>] STATUS-VERB ...` post shape, and tolerant idle-poll regex are binding for this audit.
- Read `./CLAUDE.md`, `docs/sprint-51.5b-dogfood-audit/PLANNING.md`, this `STATUS.md`, `docs/sprint-51.5b-dogfood-audit/T4-codex-independent-audit.md`, `docs/sprint-51.7-wizard-wire-up-and-metadata/STATUS.md`, and `docs/INSTALLER-PITFALLS.md` ledger #15/#16/#17.
- File evidence now in scope:
  - `docs/sprint-51.5b-dogfood-audit/STATUS.md` pre-sprint substrate says v1.0.5 is live and petvetbid 14:26 ET cleanly ran all 17 migrations, with mig 001 taking 9401ms on drift-shape `match_memories`.
  - `docs/sprint-51.5b-dogfood-audit/T4-codex-independent-audit.md` requires Phase 1 to hand-pre-create drift-shape `match_memories` with return order `(id, content, metadata, source_type, category, project, created_at, similarity)` before running `termdeck init --mnestra`.
  - `docs/INSTALLER-PITFALLS.md` #15 closes Class M bundled-hook write-path absence; #16 closes Class N settings.json Stop -> SessionEnd lockstep drift; #17 closes Class A `match_memories` return-type drift via the v1.0.5 `do $$` guard.

Pending:
- Provision/adopt a Brad-shape DB fixture without touching petvetbid unless explicitly needed.
- Create tmp HOME with no `~/.claude.json`, stale TermDeck-marked hook, and Stop-wired `~/.claude/settings.json`.
- Pre-create the adversarial drift-shape `match_memories` function, then run published v1.0.5 user path and verify hook refresh, settings migration, DB migration order/timing, exit code, and canonical recreated function.

Most recent worker FIX-LANDED reference about to verify: none in this sprint yet; T1/T2/T3 are still PENDING in this STATUS.md.

---

### [T1] FINDING 2026-05-04 14:43 ET — Phase 0 baseline clean; entering Phase A re-run idempotency

Phase: 0 complete; Phase A starting (Phase A through E queued; Phase E blocked on T3 provisioning the throwaway dogfood DB).

Verified so far (Phase 0 — pre-state baseline):
- `node -p require('/usr/local/lib/node_modules/@jhizzard/termdeck/package.json').version` → `1.0.5` ✓ (matches PLANNING.md substrate)
- `grep -n "@termdeck/stack-installer-hook" ~/.claude/hooks/memory-session-end.js` → line 64 = `v2` ✓ (Sprint 51.7 v1.0.3 stamp; landed via 14:26 ET wizard run)
- `grep -E '"Stop"|"SessionEnd"' ~/.claude/settings.json` → `"SessionEnd": [` only; no `"Stop"` entry ✓ (Sprint 51.8 Class N migration confirmed; settings.json wiring is canonical)
- petvetbid `memory_sessions`: total=302, last_session_end=2026-05-04 18:20:23 UTC (= 14:20 ET, ~22 min before this CHECKPOINT). 296/302 (98%) carry `started_at IS NOT NULL`; 296/302 (98%) carry `duration_minutes IS NOT NULL`; 283/302 (94%) carry `facts_extracted > 0`. The 6 missing-metadata rows are pre-Sprint-51.7 sessions written by v1 hook (which lacked the transcript-metadata parser). Post-v1.0.3 rows all carry full metadata.

Side-finding (NOT in scope; flagging for Sprint 52.2 candidate):
- Mnestra MCP `memory_recall` failed with PostgreSQL overload ambiguity on `public.memory_hybrid_search(...)` — two candidate signatures (one with `recency_weight`/`decay_days`, one without). Same root pattern as Class A `match_memories` drift that Sprint 52.1 closed: a `CREATE OR REPLACE FUNCTION` was authored with a new arg list while a prior overload still exists. The Sprint 52.1 do$$ guard pattern in mig 001 should be replicated for `memory_hybrid_search` in whichever migration first added the recency-aware overload. T4-CODEX flagged this same finding at 14:42 ET; consistent across two independent observers.
- This is OUT OF SCOPE for Sprint 51.5b (audit-only). Documenting here so the orchestrator can decide if a Sprint 52.2 hotfix is warranted.

Pending:
- Phase A: termdeck init --mnestra --yes re-run; expect all helpers up-to-date / already-wired / no new backups, sub-200ms mig 001, exit 0.
- Phase B: trigger fresh /exit, verify metadata-rich row + 1-row-per-session_id invariant.
- Phase C: pg_proc probe — exactly 1 match_memories overload with canonical signature; callable end-to-end.
- Phase D: 6-test-file matrix (~145 tests).
- Phase E: BLOCKED on T3 posting throwaway DB connection string in STATUS.md.

---

### [T3] STARTED 2026-05-04 14:43 ET — booting T3 lane (audit-only)

Boot complete:
- `memory_recall` (mnestra) failed with same `match_memories`-style overload ambiguity Codex hit; legacy `memory_recall` worked. Pulled 87 memories across the three queries — Sprint 51.5 T3 ensureVaultSecrets() + per-secret CLI + Vault deeplinks; Sprint 51.7 SHIPPED v1.0.3; Sprint 51.8 + 52.1 staged-locally (commit 6b68177 awaiting Joshua publish + push); Brad's standing WhatsApp wa.me preference + 2026-04-26 standing authorization.
- Read `~/.claude/CLAUDE.md` (three hardening rules at top), `./CLAUDE.md`, `PLANNING.md`, `STATUS.md`, my full T3 brief.
- Substrate probes: `npm view @jhizzard/termdeck version` → 1.0.5; `@jhizzard/termdeck-stack` → 0.6.5; local `/usr/local/bin/termdeck` linked to v1.0.5; `supabase projects list` works (Joshua's CLI is logged in via stored token, no credential harvest needed).
- Confirmed alignment with T1 + T4-CODEX side-finding: Mnestra MCP `memory_hybrid_search` has two candidate overloads (with/without `recency_weight`/`decay_days`); same Class A root pattern as `match_memories` drift Sprint 52.1 closed. THREE independent observers (T1 + T4-CODEX + T3) flagged this at ~14:42 ET. Sprint 52.2 candidate per T1's note. T3 will not duplicate the finding.

Lane plan: Phase A (provision) → B (init --mnestra clean HOME) → C (init --rumen GRAPH_LLM_CLASSIFY Y-path) → D (Vault deeplink fallback) → E (graph-inference llm_classifications > 0) → F (Vault wizard text grep) → idle-poll T1+T2 DONE with tolerant regex `^(### )?\[T(1|2)\] DONE\b` → G (Brad WhatsApp v1.0.5 draft).

### [T3] FINDING — Phase A in-flight 2026-05-04 14:44 ET — provisioning via supabase CLI

Path: `supabase projects create termdeck-dogfood-2026-05-04 --org-id pcaswmhlqsrbhoibdbht --region us-east-1 --db-password <random-32> --yes`. Org `jhizzard` (ID `pcaswmhlqsrbhoibdbht`) is the only one Joshua belongs to; matches petvetbid's billing org. Region `us-east-1` matches 3 of Joshua's 4 existing projects. DB password generated via openssl (32 chars), stashed at `/tmp/sprint-51.5b-t3-secrets.env` (chmod 600). Will post DATABASE_URL (scrubbed) once provision settles (~2 min). T1 + T2 unblocked at that point.

---

### [T2] FINDING 2026-05-04 14:48 ET — boot complete + CRITICAL doctor blindness on cron all-zeros (Phase A pre-T1-DONE exploratory)

Phase: 0 complete; Phase A exploratory baseline run (will re-run post-T1-DONE for idempotency); Phase E in progress; B/C blocked on T3 DOGFOOD_DB; D blocked on T1 /exit.

**Boot verified:**
- `mnestra --version` → `0.4.2` ✓; `which mnestra` → `/usr/local/bin/mnestra` → `dist/mcp-server/index.js`; `head -3 dist/src/doctor.js` → "Mnestra — `mnestra doctor` (Sprint 51.5 T2)" ✓.
- petvetbid baselines (independent of T1; numbers concur with T1 14:43 ET): `memory_sessions` total=302, latest=2026-05-04 18:20:23 UTC (=14:20 ET), 296/302 with started_at + duration_minutes, 283/302 with facts_extracted>0. `rumen_insights` total=321, last_insight=2026-05-01 20:45:02 UTC (3 days stale).
- Concurring side-finding with T1+T3+T4-CODEX: `memory_hybrid_search` has overloaded signatures, `mnestra` MCP recall fails with same Class A pattern Sprint 52.1 closed for `match_memories`. Sprint 52.2 candidate. Out of 51.5b scope.

**Phase A exploratory `mnestra doctor` against petvetbid (pre-T1-DONE):** exit=0, all 6 probes green:
```
✓ rumen-tick all-zeros — 0 of last 10 successful runs reported all-zero (below 6-cycle threshold)
✓ rumen-tick latency — p95 = 0.1s over last 10 runs
✓ graph-inference-tick all-zeros — only 5 successful run(s) observed (need ≥6 for confident detection)
✓ graph-inference-tick latency — p95 = 0.0s over last 5 runs
✓ schema drift — all 5 bundled artifacts present
✓ MCP config path parity — mnestra registered in /Users/joshuaizzard/.claude.json only (canonical)
Doctor complete. 0 red, 0 yellow, 6 green, 0 unknown. Exit 0.
```
Log: `/tmp/sprint-51.5b-t2-doctor-petvetbid-PRE-T1-DONE.log`.

**🚨 CRITICAL FINDING — doctor structural blindness on `rumen-tick all-zeros`:**

The doctor reports rumen-tick GREEN, but the underlying ground truth is RED:
- `rumen_jobs` (rumen Edge Function's own ledger) for last 10 ticks at petvetbid all show `sessions_processed=0 AND insights_generated=0`. This is the exact pattern INSTALLER-PITFALLS.md ledger #13 (Class A) catalogs.
- WHY the doctor green-blinks: `cron.job_run_details.return_message` for rumen-tick on Supabase is literally just the string `"1 row"` (the SQL row-count of the calling SELECT), NOT structured JSON or `key=value`. The doctor's `parseCronReturnMessage` correctly returns `{}` (no parseable fields) and excludes the run from the all-zeros count via the `if (Object.keys(fields).length === 0) return false` branch (`src/doctor.ts:224`).
- Result: doctor's `evalAllZeros` reports `0 of 10 all-zeros` because **all 10 are unclassifiable**, not because they're non-zero. Green-by-blindness is functionally indistinguishable from green-by-health in the current report shape.
- Evidence:
  ```
  $ psql ... -c "select substring(return_message,1,300) from cron.job_run_details where jobid in (select jobid from cron.job where jobname='rumen-tick') order by start_time desc limit 1"
   return_message
  ----------------
   1 row
  ```
- Root cause: doctor was designed assuming `cron.job_run_details.return_message` carries the Edge Function's response body. On Supabase pg_cron with HTTP-callback patterns (Joshua's setup), pg_cron writes the *invoking SQL's result text* (`"1 row"`), not the HTTP response payload. The Edge Function's structured payload with `sessions_processed`/`insights_generated` lives in `rumen_jobs` (Edge-Function-side ledger), not `cron.job_run_details`.
- **This is the exact share-blind pattern auditor lanes are supposed to catch.** All-Claude Sprint 51.5 lanes shipped a doctor that was never exercised against a real Supabase pg_cron run-detail format with HTTP callback. Sprint 51.5 unit tests presumably feed structured JSON return_message via mock data source. Real petvetbid feeds "1 row".

**Implication:** Sprint 51.5b cannot certify the cron-all-zeros probe as working on petvetbid. Two distinct things are unhealthy:
1. Doctor probe reads from wrong source (`cron.job_run_details` vs `rumen_jobs`).
2. Underlying Rumen chew is genuinely broken — `rumen_jobs` shows 0/0 for many hours; `rumen_insights` last_insight is 2026-05-01 (3 days stale, *predates* even the Sprint 51.6 21:19 ET hook fix). The PLANNING.md substrate's claim "Rumen has been recovering since Sprint 51.6 21:19 ET" is contradicted by evidence.

**Recommendation (out of 51.5b scope, audit-only — flagging for orchestrator decision):**
- Sprint 51.9 or 52.x: pivot doctor's all-zeros probe to read from `rumen_jobs` directly (it has the structured columns) instead of `cron.job_run_details.return_message`. The probe interface in `DoctorDataSource` would gain `rumenJobsRecent(limit)` returning `{sessions_processed, insights_generated, ...}`.
- Sprint 51.9 or 52.x: investigate WHY rumen-tick is reporting 0 sessions_processed despite memory_sessions having 296 v2-shape rows. Possibilities: rumen's chew filter is broken (stale `WHERE rumen_processed_at IS NULL` semantics), or the Edge Function is no-op'ing for an unrelated reason.

**Phase A status:** exploratory baseline complete. Will re-run post-T1-DONE to confirm idempotency. The verdict from this exploratory run is **green on the doctor's own terms but RED on ground truth** — the doctor's report cannot be trusted for cron-all-zeros without manual `rumen_jobs` cross-check.

Pending:
- Phase A formal re-run post-T1-DONE (expected: identical green output; tests doctor stability not Rumen health).
- Phase B (broken-project red detection) blocked on T3 DOGFOOD_DB URL post.
- Phase C (cold-boot tolerance) blocked on T3 DOGFOOD_DB URL post BEFORE Phase B mutation.
- Phase D blocked on T1 confirming /exit + new memory_sessions row.
- Phase E investigation continuing — checking why rumen_insights total grew 233→321 (+88 since 10:50 ET) but max(created_at) still 2026-05-01 (anomaly).

---

### [T3] FINDING — Phase A DONE 2026-05-04 14:51 ET — throwaway DOGFOOD_DB ready; T1+T2 unblocked

Provisioned `termdeck-dogfood-2026-05-04` (REF `haiurvrmnhtjrzwbqmnr`, region `us-east-1`, org `jhizzard/pcaswmhlqsrbhoibdbht`). PG accepted connection on first poll attempt (`select 1` returned in <1s). Both legacy ANON + service_role keys retrieved via `supabase projects api-keys --project-ref ... -o json` and stashed.

**Cross-lane connection details (T1 + T2 + T4-CODEX can `source` this file):**

```
. /tmp/sprint-51.5b-t3-secrets.env
echo $DOGFOOD_DB     # postgres://postgres:<32-char-pw>@db.haiurvrmnhtjrzwbqmnr.supabase.co:5432/postgres
echo $DOGFOOD_URL    # https://haiurvrmnhtjrzwbqmnr.supabase.co
echo $DOGFOOD_REF    # haiurvrmnhtjrzwbqmnr
echo $DOGFOOD_SVC_KEY  # legacy service_role JWT
echo $DOGFOOD_ANON_KEY # legacy anon JWT
```

File `/tmp/sprint-51.5b-t3-secrets.env` is chmod 600. Plan to delete the project after sprint close (no auto-cleanup wired; orchestrator should `supabase projects delete haiurvrmnhtjrzwbqmnr` post-VERIFIED).

**T1 Phase E + T2 Phase B ('broken project' tests):** I'll mutate the dogfood DB *only after my own Phases B-E are clean* (probably ~15:30 ET) to drop `memory_relationships.weight` + suspend `graph-inference-tick` cron, simulating Brad's mig-009 + TD-003 drift. T1/T2 watch for `### [T3] FINDING — broken-side-branch ready` post.

### [T3] FINDING — Phase F DONE 2026-05-04 14:51 ET — Vault wizard text grep PASS (with regex-overinclusion nit)

Tight grep for the actually-broken instruction patterns:

```
$ git grep -n -i 'click.*vault' packages/cli/src/init-mnestra.js packages/cli/src/init-rumen.js packages/server/src/setup/preconditions.js docs/GETTING-STARTED.md
(zero matches)

$ git grep -n -i 'vault.*tab' packages/cli/src/init-mnestra.js packages/cli/src/init-rumen.js packages/server/src/setup/preconditions.js docs/GETTING-STARTED.md
(zero matches)
```

Brief's broader `vault.*dashboard` regex is over-inclusive — returns 8 hits in active wizard surface (`init-rumen.js:526-527, 650, 960, 963`; `preconditions.js:226, 246`; `GETTING-STARTED.md:257`). Read each: every hit is **explanatory pivot text** that says "the Vault dashboard panel was removed/relocated, so SQL Editor is the canonical surface." This is the OPPOSITE of broken-instruction — it's the replacement banner that GUIDES users from Vault to SQL Editor (Sprint 51.5 STATUS.md:158 explicitly designed: 'Banner reads "The Supabase Vault dashboard panel has been removed in current Supabase UIs."'). Internal code comments (526-527, 960-963, 226) reference the same fact for future maintainers.

**Verdict:** PASS on intent (no broken "click Vault tab" instructions remain). The `vault.*dashboard` regex in PLANNING.md acceptance criterion 11 should be tightened to `'click.*vault\|vault.*tab'` only — the current expanded form will always return hits as long as the explanatory banner exists. NOT in scope to fix here; flagging as a documentation-nit-and-grep-tightening line item.

### [T3] CHECKPOINT 2026-05-04 14:51 ET — Phases A+F done; entering Phase B

Phase A: ✓ DONE — DOGFOOD_DB ready, T1+T2 unblocked, file at /tmp/sprint-51.5b-t3-secrets.env.
Phase F: ✓ DONE PASS — zero broken-instruction hits; over-inclusive regex catches explanatory banner only.
Phase B: STARTING — `HOME=/tmp/sprint-51.5b-t3-home termdeck init --mnestra --from-env` against fresh DB, expect `installed` (not `refreshed`) for hook + settings.json, mig 001 ~80-200ms (no drift), all 17 migrations clean.

---

### [T1] FINDING 2026-05-04 14:52 ET — Phases A through D PASS on petvetbid; Phase E queued behind T3 broken-side-branch signal

Phase: A/B/C/D complete (all GREEN); Phase E waiting for T3's `### [T3] FINDING — broken-side-branch ready` post (per T3 line 174, T3 owns the mutation after their own Phases B-E clear, ETA ~15:30 ET).

**Phase A — `termdeck init --mnestra --yes` re-run idempotency: PASS**

Stdout markers (full log at `/tmp/sprint-51.5b-t1-init-mnestra.log`):
```
→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ up-to-date (v2)
→ Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ already wired (SessionEnd)
→ Connecting to Supabase... ✓
→ Checking for existing memory_items table... ✓ found (6,343 rows)
→ Applying migration 001_mnestra_tables.sql... ✓ (80ms)            ← was 9401ms first run; do$$ guard now finds canonical only
→ Applying migration 002_…sql through 017_…sql... ✓ (40-74ms each)
→ Audit-upgrade: probing for missing mnestra schema artifacts... ✓ (install up to date — 6 probes all present)
→ Verifying memory_status_aggregation()... ✓ (6,340 active memories found)
exit=0
```

On-disk verification:
- `ls -lt ~/.claude/hooks/memory-session-end.js.bak.*` → most recent is `20260504155633` (= 11:56 ET first-install today, NOT this 14:43 run). NO new backup. ✓
- `ls -lt ~/.claude/settings.json.bak.*` → most recent is `20260502-132515` (= original Stack-installer Stop→SessionEnd write, May 2). NO new backup. ✓
- `diff ~/.claude/hooks/memory-session-end.js /usr/local/lib/node_modules/@jhizzard/termdeck/packages/stack-installer/assets/hooks/memory-session-end.js` → empty (BYTE-IDENTICAL). ✓
- `~/.termdeck/config.yaml.2026-05-04T18-43-46-051Z.bak` was written this run — expected, wizard always writes config.yaml backup; not in brief's no-backup criteria.

**Phase B — fresh `/exit` writes a metadata-rich row + v1.0.4 invariant: PASS**

Note: lane brief's `summary_len` query column doesn't exist in canonical schema (column is `summary text`; brief should be `length(summary)`). Used corrected query. Brief-text drift, not a wizard bug.

5 rows since 11:56 ET (when v2 hook first landed via this morning's first-install):

| session_id (head) | started_at | ended_at | duration_min | messages | facts | summary_len |
|---|---|---|---|---|---|---|
| dd831953… | 18:11:52+00 | 18:20:23+00 | 9 | 16 | 0 | 2277 |
| ed4e6b06… | 15:40:23+00 | 16:12:53+00 | 33 | 11 | 0 | 1699 |
| 64d2508c… | 14:24:44+00 | 16:11:28+00 | 107 | 65 | 3 | 7000 |
| 46e74336… | 14:53:35+00 | 16:04:39+00 | 71 | 27 | 0 | 4535 |
| 72313ec3… | 14:53:25+00 | 16:04:16+00 | 71 | 21 | 0 | 3744 |

Every row carries `started_at IS NOT NULL` + `duration_minutes IS NOT NULL` + `facts_extracted IS NOT NULL` + `messages_count IS NOT NULL` + populated `summary`. Sprint 51.7 T2 transcript-metadata parser is working as designed. ✓

`memory_items` `session_summary` rows (post-v2-hook): 6× `source_agent='claude'` + 1× `'codex'` (Codex's session 89313dc7…). `source_agent` mig-015 column is being populated correctly per agent type. ✓

v1.0.4 invariant — exactly 1 `session_summary` row per session_id over past hour: `dd831953-… → 1`. No duplicates. Brad's Class N regression is NOT present. ✓

(Cross-reference T2's 14:48 ET CRITICAL finding on doctor's all-zeros probe: T1 is OUT OF SCOPE for that finding — it's a doctor-side blindness on `cron.job_run_details.return_message` that does NOT affect the wizard or hook write-paths T1 audits. T2 owns the recommendation. T1 confirms the metadata write-path itself is GREEN.)

**Phase C — Sprint 52.1 mig 001 do$$ guard idempotency: PASS**

```
 sig                                                | body_bytes | return_type 
match_memories(vector,double precision,integer,text) |        493 | record
```

Exactly 1 overload, canonical signature `(vector, double precision, integer, text)`. Body 493 bytes. Returns `record` (table-returning). End-to-end callable: `select count(*) from match_memories(array_fill(0::double precision, ARRAY[1536])::vector, 0.0, 5, null)` → 5. ✓

**Phase D — full hook + migration test matrix: PASS**

```
ℹ tests 144
ℹ suites 0
ℹ pass 144
ℹ fail 0
ℹ duration_ms 3090.27
```

Brief expected ~145 ±1; landed 144/144. All 6 test files green:
- `tests/init-mnestra-settings-migration.test.js` (Sprint 51.8 Class N)
- `tests/init-mnestra-hook-refresh.test.js` (Sprint 51.6 Class M)
- `tests/init-mnestra-cli-refresh.test.js` (Sprint 51.7 wizard wire-up)
- `tests/stack-installer-hook-merge.test.js` (Sprint 51.8 hoist)
- `tests/migration-001-shape.test.js` (Sprint 52.1 Class A)
- `tests/project-taxonomy.test.js` (bundled hook PROJECT_MAP)

**Coordination note for T3:** brief at lines 137-144 has T1 doing the deliberately-broken mutation (`alter table memory_relationships drop column weight` + `select cron.unschedule('graph-inference-tick')`); T3 line 174 says T3 will do the mutation after T3 Phase B-E clears. To avoid two-lane DB mutation collision, T1 will WAIT for T3's `### [T3] FINDING — broken-side-branch ready` signal, then run only the wizard probe (`DATABASE_URL=$DOGFOOD_DB termdeck init --rumen`) against the post-T3-mutation state. If T3 prefers T1 to mutate, T3 should explicitly post `### [T3] FINDING — DOGFOOD_DB clean and ready for T1 mutation`.

Idle-polling STATUS.md with tolerant regex `^(### )?\[T3\] (FINDING|DONE)\b.*(broken-side-branch|DOGFOOD_DB clean and ready|broken project)` per CLAUDE.md hardening rule 3.

**Side-finding aside: lane brief drift items (Sprint 52.x doc-cleanup candidates):**
1. T1 brief Phase B `summary_len` column ref (line 79) should be `length(summary) summary_len` — column doesn't exist in canonical schema.
2. T1 brief Phase D test count `~145 ± 1` — actual landed 144 (close enough).
3. PLANNING.md acceptance criterion 11 (T3) `vault.*dashboard` regex is over-inclusive (T3 14:51 ET finding); should tighten to `'click.*vault\|vault.*tab'`.

---

### [T3] FINDING — Phase B 🔴 RED 2026-05-04 14:55 ET — `termdeck init --mnestra` FAILS on fresh project (mig 016 cron.* dependency)

**Reproduction:** clean `/tmp/sprint-51.5b-t3-home`, throwaway DB `haiurvrmnhtjrzwbqmnr`, ran:

```
HOME=/tmp/sprint-51.5b-t3-home DATABASE_URL=$DOGFOOD_DB SUPABASE_URL=$DOGFOOD_URL \
  SUPABASE_SERVICE_ROLE_KEY=$DOGFOOD_SVC_KEY OPENAI_API_KEY=$OPENAI_API_KEY \
  termdeck init --mnestra --from-env
```

**Outcome (real exit 5; tee-shadow gave initial false 0 — re-verified via separate exit):**

```
→ Writing ~/.termdeck/secrets.env... ✓
→ Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)... ✓ installed v2 (no prior copy)
→ Reconciling ~/.claude/settings.json hook event mapping (Stop → SessionEnd)... ✓ installed (SessionEnd)
→ Connecting to Supabase... ✓
→ Checking for existing memory_items table... ✓ not found (will create)
→ Applying migration 001_mnestra_tables.sql... ✓ (332ms)        ← fresh DB, no do$$ loop, no drift; ~1.5x the 80-200ms estimate due to Supabase pg cold-start
→ Applying migration 002..015... ✓ all clean
→ Applying migration 016_mnestra_doctor_probes.sql... ✗
    relation "cron.job_run_details" does not exist
[init --mnestra] Migration failed: 016_mnestra_doctor_probes.sql
```

**Root cause (Class A — schema drift):** Mig 016 (Sprint 51.5 T2 Mnestra doctor probes; `packages/server/src/setup/mnestra-migrations/016_mnestra_doctor_probes.sql`) creates `language sql security definer` functions referencing `cron.job_run_details` (line 42–43) and `cron.job` (line 94). Postgres parse-time-resolves identifiers in `language sql` functions, so the CREATE fails when `cron` schema doesn't exist. Fresh Supabase projects do NOT have `pg_cron` enabled by default — only `pg_stat_statements, pg_trgm, pgcrypto, plpgsql, supabase_vault, uuid-ossp, vector` are enabled out of the box. Confirmed via `select extname from pg_extension` on the fresh DOGFOOD project.

**Why this misses petvetbid + Brad's jizzard-brain:** both have Rumen installed (Rumen mig 002 issues `CREATE EXTENSION pg_cron`), so by the time mig 016 applies, `cron.*` exists. Petvetbid's 14:26 ET log shows `mig 016 ✓ (33ms)` — same migration, different prerequisite state. Brad's v1.0.5 `init --mnestra` against jizzard-brain SHOULD succeed because he previously ran init --rumen there. **A fresh user (no Rumen install yet) running ONLY `init --mnestra` against a freshly-provisioned Supabase project will hit this exit-5 dead-stop.** The Mnestra wizard description claims standalone usage ("Tier 2 memory layer") but mig 016 silently requires Rumen to have run first.

**Pre-failure state (still OK):** hook = `installed v2` (status correct, no prior copy); settings.json = `installed (SessionEnd)` (status correct, no prior settings.json + no Stop→SessionEnd migration since file didn't exist); migrations 001-015 = ✓ clean. So the wizard's pre-DB substrate (helper refresh + settings.json + connection probe) all behaved correctly per Phase B expectations.

**Severity:** RED for Sprint 51.5b — the canonical "fresh user, fresh project, install mnestra first" path is broken on v1.0.5. Sprint 51.9 hotfix candidate (pattern matches the existing Class A taxonomy ledger #17 that Sprint 52.1 closed for `match_memories` drift, but this is a different schema dependency).

**Fix surface (for orchestrator scoping; T3 is audit-only and won't write code):**
- Option A (cleanest): wrap mig 016 in `do $$ begin if exists (select 1 from pg_extension where extname='pg_cron') then ... end if; end $$;` — apply cron-touching functions only when pg_cron is enabled. Non-cron probes (`mnestra_doctor_column_exists`, `mnestra_doctor_rpc_exists`) ALWAYS apply. The doctor's cron probes can return `unknown` instead of red when the underlying SECURITY DEFINER wrapper is absent (Sprint 51.5 T2 already established the `unknown` band).
- Option B: have init --mnestra ensure `pg_cron` is enabled (call `CREATE EXTENSION IF NOT EXISTS pg_cron`) before mig 016. Cleaner UX but couples mnestra to a cron extension it doesn't otherwise need — and only the postgres role can CREATE EXTENSION on Supabase.
- Option C: move mig 016 to a Rumen-side migration. Pure architectural fix but breaks the doctor's standalone-mnestra promise.
- Recommended: **Option A**. Idempotent, safe for both fresh-install and existing-install, doesn't introduce new install-order dependencies.

**Workaround for this dogfood pass:** I will manually `CREATE EXTENSION IF NOT EXISTS pg_cron` on the throwaway DB, then re-run `init --mnestra --yes` and verify migs 016 + 017 apply. Phases C–E proceed under workaround; the RED stays RED for sprint verdict.

### [T3] CHECKPOINT 2026-05-04 14:56 ET — Phase B blocked on real bug; applying workaround

Phase: A ✓, F ✓, **B 🔴 RED** (canonical happy-path broken by mig 016 cron.* dependency), B-workaround in flight (manually enable pg_cron, then resume).

Verified so far:
- Hook + settings.json behave per Phase B expectation on clean HOME (`installed`, NOT `refreshed`/`migrated-from-stop`).
- Migrations 001–015 clean; mig 001 = 332ms (within tolerance for fresh DB).
- Mig 016 = exit 5 hard-fail with `relation "cron.job_run_details" does not exist`.
- Real exit code via stderr-only re-run = 5 (initial Phase B run's `=== exit code: 0 ===` was the tee shadow).

Pending:
- Apply pg_cron workaround.
- Re-run `init --mnestra --yes`; verify 016 + 017 apply, audit-upgrade passes, exit 0.
- Phase C: `init --rumen` GRAPH_LLM_CLASSIFY Y-path on workaround'd DB.
- Phase D: deeplink fallback (PAT withhold).
- Phase E: graph-inference llm_classifications validation.
- Idle-poll T1 + T2 DONE with tolerant regex `^(### )?\[T(1|2)\] DONE\b`.
- Phase G: Brad WhatsApp v1.0.5 draft (must caveat: jizzard-brain unaffected because Rumen already installed there; but Sprint 51.9 hotfix recommended before any NEW-user fresh-install onboarding).

---

### [T1] CHECKPOINT 2026-05-04 14:57 ET — Phases A-D PASS on petvetbid; ack T3's mig-016 RED; Phase E idle-polling

Phase: A/B/C/D ✓ on petvetbid (PASS evidence already posted at 14:52 ET); E still blocked.

**Acknowledging T3's 14:55 ET RED (mig 016 cron.* dependency on fresh project).** This is a separate Class A drift from anything T1 owns. T1 is OUT OF LANE for the fix; T3 owns the recommendation (Option A — `do $$ ... if exists pg_extension where extname='pg_cron'` guard). Cross-checking petvetbid is unaffected:

- Petvetbid has Rumen installed → mig 002 ran `CREATE EXTENSION pg_cron` → `cron.*` schema exists → mig 016 SECURITY DEFINER functions parse-resolve cleanly. T1's Phase A re-run showed `→ Applying migration 016_mnestra_doctor_probes.sql... ✓ (56ms)` (line 52 of `/tmp/sprint-51.5b-t1-init-mnestra.log`). Petvetbid's existing-install upgrade path is GREEN.
- The bug is specifically on the **fresh-project, mnestra-only-no-rumen** install path (T3's exact reproduction). Existing v1.0.x installs upgrading to v1.0.5 are NOT affected. This narrows Sprint 51.9's user-impact scope.

**Sprint verdict implication (orchestrator scoping aid):** the v1.0.x onion is structurally closed for **upgrade-path users** (petvetbid GREEN, Brad's jizzard-brain SHOULD be GREEN per T3 analysis since it has Rumen). The bug only impacts **fresh-install users who run `init --mnestra` first without `init --rumen`**. Brad's WhatsApp message at v1.0.5 GA can ship with caveat: "If you're a new user starting from scratch, run `init --rumen` first OR enable pg_cron manually before `init --mnestra` until v1.0.6 lands the fix."

**Phase E remains BLOCKED on T3.** T3 is applying pg_cron workaround to unblock their own Phases C-E, then will mutate DOGFOOD_DB (drop `memory_relationships.weight`, unschedule `graph-inference-tick`) and post `### [T3] FINDING — broken-side-branch ready`. Restarted idle-poll at 14:57 ET with content-since-baseline regex so the existing T3 RED post doesn't re-trigger.

T1 lane status: 4/5 phases GREEN, Phase E pending. Will post `### [T1] DONE` once Phase E lands or T3 explicitly waives Phase E (sprint-level scope decision if T3 cannot reach the broken-side-branch state due to their own RED).

---

### [T2] FINDING — Phase E DONE 2026-05-04 14:58 ET — Rumen NOT recovering; rumen-tick Edge Function pinned to stale @jhizzard/rumen@0.1.0 (vs published 0.4.5)

Phase E result: **DOCUMENT-ONLY** (not a sprint blocker per brief), but evidence is unambiguous and complementary to my 14:48 ET CRITICAL doctor-blindness finding above. Both findings have the same surface symptom (Rumen looks healthy when it isn't) but distinct independent root causes — closing only one will not fix the other. T3's 14:55 ET fresh-install RED is a third independent rumen/cron/doctor-surface issue clustered in the same hour. **Cumulative implication: the Brad green-light WhatsApp must NOT go out today even if T1/T2/T3 happy-paths re-converge to GREEN — three independent Reds need 51.9 closure first.**

**Evidence (petvetbid, 2026-05-04 14:48–14:53 ET):**

1. `rumen_insights`: total=321, last_insight=`2026-05-01 20:45:02 UTC` (3 days stale). Joshua's flag at 10:50 ET observed 233; total advanced to 321 via historical backfill (no rows have created_at > 2026-05-01). The PLANNING.md substrate's claim *"Rumen has been recovering since Sprint 51.6 21:19 ET"* is structurally wrong.

2. `rumen_jobs`: total=1836, productive=92, latest_productive=`2026-05-01 20:45:00 UTC`. Every tick since 2026-05-01 has been `sessions_processed=0 AND insights_generated=0` with `source_session_ids='{}'`. ~290 consecutive zero-runs (3 days × 96 ticks/day at 15-min cadence).

3. **Underlying cause is NOT empty memory_items.** Memory ingestion is healthy:
   - `memory_items` 2026-05-04 alone: 47 rows (fact=22, session_summary=4, decision=12, bug_fix=5, preference=2, code_context=1, architecture=1).
   - `memory_items` 2026-05-01 onward: 51 distinct `source_session_id` values across 302 items.
   - `session_summary` rows: 38 written, latest=2026-05-04 18:20:26 UTC. The v2 hook is writing memory_items normally (T1 14:52 ET PASS independently confirms this).
   - **33 of those 51 session_ids are NOT in any rumen_jobs.source_session_ids** — these are orphan sessions Rumen *should* have processed and didn't.

4. **Strong root-cause hypothesis: rumen-tick Edge Function imports stale rumen npm version.**
   - `supabase/functions/rumen-tick/index.ts:23` → `import { runRumenJob, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.1.0'`
   - `npm view @jhizzard/rumen version` → `0.4.5`
   - The Edge Function is running 4 minor versions stale.
   - rumen v0.3 source comment (`src/extract.ts:5-10`): *"Prior versions joined to memory_sessions on its UUID primary key, but in rag-system's actual schema memory_items.source_session_id references a separate ID space (the Claude Code session identifier) and never matches memory_sessions.id. Grouping memory_items directly is both correct and simpler... v0.3 still emits one signal per session."* — this comment describes a join bug pre-v0.3 versions had. **rumen@0.1.0 is pre-v0.3 and likely carries this exact join bug.**
   - Smoking-gun connection: rumen 0.1.0's chew filter joins memory_items.source_session_id (text) → memory_sessions.id (UUID). Type mismatch returns 0 rows → sessions_processed=0 every tick.

**Recommendation (out of 51.5b scope, audit-only — flagging for orchestrator decision):**
- **Sprint 51.9 priority-1**: redeploy `rumen-tick` Edge Function with `npm:@jhizzard/rumen@0.4.5`. One-liner change in `supabase/functions/rumen-tick/index.ts:23` + `supabase functions deploy rumen-tick`. Verify same for `graph-inference` Edge Function (didn't check but likely also pinned stale). Bundle with T3's mig-016 cron-extension fix (Option A from T3's 14:55 ET finding).
- **Sprint 51.9 or 52.x**: pivot doctor's all-zeros probe to read `rumen_jobs` directly (Phase A finding above), so even if the Edge Function regresses again the doctor catches it. Add `DoctorDataSource.rumenJobsRecent(limit)` returning structured `{sessions_processed, insights_generated}`.
- **Sprint 52.x**: add a doctor probe for "Edge Function npm version drift" — Supabase exposes the deployed function source via `supabase functions list`/`download`. If pinned version != latest published, fire YELLOW with recommendation to redeploy.

**Net Phase E verdict:** the Rumen recovery state Joshua hoped for after Sprint 51.6's hook fix did not materialize, and the doctor cannot detect this. Three days of all-zero ticks is a real production issue Brad will encounter on his end too. **Not a Sprint 51.5b BLOCKER (audit-only)** — but T3 should NOT send Brad a green-light WhatsApp until either Sprint 51.9 closes the rumen pin drift OR the message explicitly carves out: *"Rumen still has a stale Edge-Function pin we're shipping in 51.9 — your install will surface this same all-zeros pattern; ignore it for now."*

Phase E task: **completed**. Phase A formal re-run can fire now since T1 posted A-D PASS at 14:52 ET.

Pending (T2):
- Phase A formal re-run (idempotency check; expected unchanged from 14:48 exploratory).
- Phase D: T1 already showed 5 metadata-rich rows + 1-row-per-session_id. I'll add my Class N invariant probe + parser cross-check to confirm independently.
- Phase C: WAITING on T3 mig-016 workaround + post-workaround init --mnestra DONE on fresh DB BEFORE T3 mutates.
- Phase B: WAITING on T3 explicit `### [T3] FINDING — broken-side-branch ready` signal (per T1 14:52 ET line 277, T2+T1 share that mutation state).

---

### [T2] FINDING — Phases A+D DONE 2026-05-04 14:59 ET — A idempotent (identical diff); D PASS (metadata + Class N invariant + parser cross-check all clean)

**Phase A formal — `mnestra doctor` against post-T1-DONE petvetbid: PASS-with-blindness-caveat**

```
✓ rumen-tick all-zeros — 0 of last 10 successful runs reported all-zero (below 6-cycle threshold)
✓ rumen-tick latency — p95 = 0.1s over last 10 runs
✓ graph-inference-tick all-zeros — only 5 successful run(s) observed (need ≥6 for confident detection)
✓ graph-inference-tick latency — p95 = 0.0s over last 5 runs
✓ schema drift — all 5 bundled artifacts present
✓ MCP config path parity — mnestra registered in /Users/joshuaizzard/.claude.json only (canonical)
Doctor complete. 0 red, 0 yellow, 6 green, 0 unknown. Exit 0.
```

`diff /tmp/sprint-51.5b-t2-doctor-petvetbid-PRE-T1-DONE.log /tmp/sprint-51.5b-t2-doctor-petvetbid-FORMAL.log` → empty (BYTE-IDENTICAL). Doctor is **idempotent across T1's re-run** ✓. Verdict: doctor's own report IS green; my 14:48 ET CRITICAL finding (return_message blindness on rumen-tick all-zeros) STILL stands — green is green-by-blindness, not green-by-health. T1's re-run did not perturb the doctor's surface (expected, since petvetbid was clean both before and after).

**Phase D — metadata + Class N invariant + parser cross-check: PASS**

Phase D probe 1 — metadata completeness on post-v2-hook rows (`ended_at >= 2026-05-04 15:56 UTC` = 11:56 ET when first v2 row landed today):

```
total_v2_rows=5
with_started=5     (5/5 = 100%)
with_duration=5    (5/5 = 100%)
with_facts_nn=5    (facts_extracted IS NOT NULL: 5/5 = 100%)
with_facts_pos=1   (facts_extracted > 0: 1/5 = 20%)
avg_facts=3.0      (only 1 row, value is 3 from 64d2508c)
max_dur_min=107    (sane)
with_messages=5    (5/5 = 100%)
```

All 5 v2-hook rows carry full Sprint 51.7 transcript-derived metadata (`started_at`, `duration_minutes`, `facts_extracted`, `messages_count`). Brief acceptance threshold (`with_started == total_v2_rows`, `with_duration == total_v2_rows`, `with_facts >= 1`) is **met**. The 4 rows with `facts_extracted=0` reflect short / no-memory sessions (e.g. dd831953 was a quick mail-merge-ext check with zero memory_remember calls in transcript) — that's correct behavior, not a parser bug. ✓

Phase D probe 2 — Class N invariant (Brad's per-turn-fire bug check):

```
            source_session_id          | summary_rows
----------------------------------------+--------------
 46e74336-e584-487f-aca7-90f7dea88d4d  |      1
 64d2508c-417d-44f4-8b3c-1f11c82c9e11  |      1
 72313ec3-3cdb-4936-9890-a1ee8f714cb1  |      1
 89313dc7-cd32-452a-87a5-b3882a1d94b4  |      1
 93aa7f59-5d72-4968-82ed-5ba3a1c4409f  |      1
 dd831953-84a6-4adf-87e2-f76e9754a887  |      1
 ed4e6b06-229e-445f-945e-c4ed55f85785  |      1
```

7 distinct session_ids (note: 7 distinct summaries vs 5 memory_sessions rows — 2 sessions appear in memory_items.session_summary that aren't in the 11:56-onward window I queried for memory_sessions; consistent with the v2 hook firing on Stop OR SessionEnd events independently). Every `summary_rows == 1`. Class N regression is **NOT present** ✓. Sprint 51.8 lockstep migration + v2 hook holds the invariant.

Phase D probe 3 — parser cross-check (Codex 11:09 ET finding verification — does parser count BOTH `mcp__mnestra__` and legacy `mcp__memory__` shapes?):

Verified at parser-source level (`~/.claude/hooks/memory-session-end.js:483-485`):
```js
const FACT_TOOL_NAMES = new Set([
  'memory_remember',
  'mcp__mnestra__memory_remember',
  'mcp__memory__memory_remember',
]);
```
Then `tool_use` matcher at line 544: `FACT_TOOL_NAMES.has(b.name)` — exact-match against all three names. ✓

End-to-end parser cross-check on two recent sessions:
- `dd831953` (most recent, nicpc-mail-merge-ext project): grep transcript → `0` memory_remember tool_uses; DB facts_extracted=`0`. **Match** ✓
- `64d2508c` (termdeck project): grep transcript → `3` `mcp__mnestra__memory_remember` tool_uses; DB facts_extracted=`3`. **Match** ✓

Parser is producing exactly the right counts. Codex's 11:09 ET finding (parser must count legacy + new shapes) is **correctly addressed** in the v2 hook. ✓

**Phase A + D verdict: PASS.** Phase D confirms Sprint 51.7 T2 transcript-metadata work landed correctly and Sprint 51.8 Class N invariant is held. Phase A confirms the doctor is idempotent though structurally blind on cron return_message parsing.

Pending (T2):
- Phase B + Phase C: blocked on T3 — first T3's mig-016 workaround needs to clear, then I can run Phase C against post-init fresh DB BEFORE T3 mutates. Then Phase B against the post-mutation broken DB.
