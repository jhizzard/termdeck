# Sprint 51.6 STATUS — Mini-sprint: bundled session-end hook fix

**Started:** 2026-05-03 19:18 ET (mini-sprint authored after live psql probe revealed two-bug picture)
**Target ship:** v1.0.2 wave (termdeck + termdeck-stack + maybe mnestra; rumen unchanged)

## Lane status

| Lane | Owner | Status | Notes |
|---|---|---|---|
| T1 — Hook instrumentation + bundled-vs-installed diff | Claude | **DONE 2026-05-03 20:08 ET** | Independently converged with T2: no memory_sessions write path exists in installed or bundled hook → no instrumentation applied → nothing to restore. Two side findings flagged for T3 (installed hook is pre-Sprint-50; PROJECT_MAP empty). See T1 FINDING below. |
| T2 — memory_sessions schema audit + manual SQL repro | Claude | **DONE 2026-05-03 20:00 ET** | Bug #2 reclassified — bundled hook never had a memory_sessions write path; T3 fix is a code addition, no DB migration. See T2 FINDING below. |
| T3 — Fix + ship v1.0.2 wave | Claude | **DONE 2026-05-03 20:38 ET** | All 5 fix items + 3 Codex blockers staged. Tests 986/22 (baseline +36 pass, 0 new fails). Wave: mnestra@0.4.2 + termdeck@1.0.2 + termdeck-stack@0.6.2. See T3 FIX-LANDED below. |
| T4 — Codex independent audit + verification harness | Codex | PENDING | See PLANNING.md § Lanes T4 |

## Pre-sprint substrate findings

(populated at orchestrator-side probe before inject — see PLANNING.md § Pre-sprint substrate for the probe block)

## FINDING / FIX-PROPOSED / DONE log

(append-only; T1/T2/T3 post in canonical Claude shape; T4 Codex posts in `[T4-CODEX] FINDING/AUDIT/VERIFY/DONE` shape)

---

### [T2] FINDING 2026-05-03 20:00 ET — Bug #2 is an architectural omission, not an execution failure. **The mini-sprint's framing needs revision before T3 fixes anything.**

**TL;DR:** The bundled session-end hook has NEVER written to `memory_sessions`. There is no failing INSERT, no schema gap, no RLS block, no constraint violation. The 289 existing rows were written by Joshua's PRIOR personal-rag-system hook, which was overwritten on 2026-05-02 13:24 ET by the bundled TermDeck hook. The bundled hook (both before and after the 13:27 upgrade) writes ONLY to `memory_items`. After the swap, `memory_sessions` simply stopped accumulating because nothing was writing to it. T3's job is therefore not "fix a broken write" — it's "add a write path that never existed in the bundled hook."

**Evidence chain:**

1. **Schema audit (`\d memory_sessions` on petvetbid):**
   ```
   id                 uuid          NOT NULL  default gen_random_uuid()
   session_id         text          NOT NULL  (UNIQUE constraint memory_sessions_session_id_key)
   summary            text
   summary_embedding  vector(1536)
   project            text          NOT NULL  default 'global'
   started_at         timestamptz
   ended_at           timestamptz
   duration_minutes   integer
   messages_count     integer       default 0
   facts_extracted    integer       default 0
   files_changed      jsonb         default '[]'
   topics             jsonb         default '[]'
   transcript_path    text
   created_at         timestamptz   NOT NULL  default now()
   ```
   RLS: `Service role full access` (USING/WITH CHECK true). HNSW index on summary_embedding. **No mandatory column the hook would forget; service-role key has full INSERT privilege.**

2. **Baseline confirmation:**
   ```
   total | last_ended_at              | last_created_at
   ------+----------------------------+-------------------------------
   289   | 2026-05-01 20:40:13.622+00 | 2026-05-01 20:40:30.143631+00
   ```
   Last 5 rows are all `project='termdeck'`, ended between 2026-05-01 20:12 and 20:40, with `transcript_path IS NOT NULL`, `summary` length 1294-1891, `messages_count` 7-10, `facts_extracted` 14-20, `topics` 2-3 entries, `files_changed` empty. Shape matches a writer that runs an extract-facts pipeline AND knows about file-change tracking — i.e. NOT the bundled hook.

3. **Bundled hook code path audit (`packages/stack-installer/assets/hooks/memory-session-end.js` + installed `~/.claude/hooks/memory-session-end.js`):**
   - `grep -n "memory_sessions" ~/.claude/hooks/memory-session-end.js` → **zero matches**.
   - `grep -n "memory_sessions" packages/stack-installer/assets/hooks/memory-session-end.js` → **zero matches**.
   - The only write site is `postMemoryItem()` at `assets/hooks/memory-session-end.js:465` (or installed `:393`), which POSTs to `/rest/v1/memory_items` with `source_type='session_summary'`.
   - The hook docstring is explicit (line 38 of bundled): "POSTs ONE row to Supabase /rest/v1/memory_items".
   - The .bak backup at `~/.claude/hooks/memory-session-end.js.bak.20260502-132414` (the immediately-prior installed hook) ALSO has zero `memory_sessions` references — the prior bundled hook was identical in scope, just registered under hooks.Stop instead of hooks.SessionEnd.

4. **Hook swap timeline (the actual bug):**
   - **Before 2026-05-02 13:24 ET:** `~/.claude/hooks/memory-session-end.js` was Joshua's personal rag-system spawner — a thin 2907-byte hook at `~/Documents/Graciella/rag-system/hooks/memory-session-end.js` that spawned `npx tsx ~/Documents/Graciella/rag-system/src/scripts/process-session.ts <transcript>` detached. That `process-session.ts` script (file:line `src/scripts/process-session.ts:131`) is the actual writer of `memory_sessions` — it computes started_at/ended_at/duration_minutes/messages_count/facts_extracted/topics from the transcript and INSERTs one row.
   - **2026-05-02 13:24 ET:** something (probably a `termdeck init` or stack-installer reinstall) overwrote `~/.claude/hooks/memory-session-end.js` with the bundled TermDeck hook (Sprint 47-era version, registered under hooks.Stop). The original rag-system spawner was preserved as the .bak backup.
   - **2026-05-02 13:27 ET:** the bundled hook was upgraded again to the current Sprint 48-era version (registered under hooks.SessionEnd, with secrets.env fallback). Both versions write only to memory_items.
   - **Effect:** every session-end since 2026-05-02 13:24 ET writes a `session_summary` row to memory_items but nothing to memory_sessions. The 289 / 2026-05-01 20:40 baseline reflects Joshua's last session under the rag-system hook before the swap.

5. **Manual SQL reproduction with bundled-hook-shaped values (rolled back):**
   ```sql
   begin;
   insert into memory_sessions (
     session_id, summary, summary_embedding, project,
     started_at, ended_at, duration_minutes,
     messages_count, facts_extracted, files_changed, topics, transcript_path
   ) values (
     'sprint-51.6-t2-probe-...', 'T2 schema probe', null, 'termdeck',
     now() - interval '5 min', now(), 5,
     10, 0, '[]'::jsonb, '[]'::jsonb, '/tmp/probe-fake.jsonl'
   ) returning id, session_id, project, created_at;
   rollback;
   ```
   Result: `INSERT 0 1` returning a row. **The schema accepts the bundled-hook column set without error.** No RLS block, no trigger, no constraint failure. T3's fix is a code change only; no Mnestra migration 017 is needed.

**Hypothesis-grid classification (the brief's six hypotheses don't cover this):**

| Brief hypothesis | Match? | Notes |
|---|---|---|
| Schema gap (column missing in DB) | ❌ | Schema is intact; 289 rows wrote successfully through it pre-swap. |
| Schema gap (column added that hook doesn't know about) | ❌ | No new column post-2026-05-01; rag-system writer's set still works. |
| NOT NULL column without default the hook doesn't populate | ❌ | The two NOT NULLs (`session_id`, `project`) both have data the hook can supply; `created_at` is defaulted. |
| Generated column the hook tries to write | ❌ | No generated columns. |
| No schema gap, INSERT works manually but fails via the hook's runtime | ❌ | The hook never attempts an INSERT against memory_sessions. |
| No schema gap, manual INSERT also fails (RLS/trigger) | ❌ | Manual INSERT succeeds. |
| **NEW (Class M): Hook swap dropped a write path that lived in the prior writer; bundled hook never had it.** | ✅ | This is the actual bug. Architectural omission, not an execution failure. |

**What this implies for T1:** The instrumentation step in T1's brief ("wrap the memory_sessions write block with un-swallowed-error logging") will find nothing to instrument — there is no memory_sessions write block to wrap. T1 should pivot to confirming (a) `~/.claude/hooks/memory-session-end.js` is byte-identical to `packages/stack-installer/assets/hooks/memory-session-end.js` modulo the Sprint 50 T2 source_agent additions (it isn't — installed is a 508-LOC pre-Sprint-50 version, bundled is a 597-LOC post-Sprint-50 version with grok parser + `source_agent`), and (b) nothing else in `~/.claude/hooks/` writes memory_sessions. T1's no-op instrumentation result confirms T2's classification independently.

**What this implies for T3 (proposed fix scope):**

1. **Add a memory_sessions write to `packages/stack-installer/assets/hooks/memory-session-end.js`** — between the embedding step and the `postMemoryItem` call, OR after the `postMemoryItem` succeeds. All required values are already in scope inside `processStdinPayload`:
   - `session_id` ← `data.session_id` (already extracted at line ~504)
   - `summary` ← `summary` (already built by `buildSummary`)
   - `summary_embedding` ← `[${embedding.join(',')}]` (matches existing memory_items shape)
   - `project` ← `detectProject(cwd)`
   - `messages_count` ← need to surface from parser (today buildSummary returns just the string; needs to also return the count)
   - `transcript_path` ← `data.transcript_path`
   - `started_at` / `ended_at` ← parse first/last message timestamp from the transcript file (Claude JSONL has `timestamp`; Codex has `payload.created_at`-ish; Gemini has `messages[].timestamp`; Grok has `created_at` in the JSON envelope). For the v1.0.2 minimal fix, `ended_at = new Date()` and `started_at = stat.mtime - duration` is acceptable — Joshua's 289 prior rows had real per-message timestamps but the bundled hook can ship with a coarser approximation and refine later.
   - `duration_minutes` ← `(ended_at - started_at) / 60000` (or `null` if we don't compute it)
   - `facts_extracted` ← `0` (bundled hook doesn't extract facts; the rag-system writer did)
   - `files_changed` / `topics` ← `[]` (bundled hook doesn't track these)

2. **UPSERT, not INSERT** — `Prefer: resolution=merge-duplicates` because `memory_sessions_session_id_key` is unique and Joshua's CC sessions sometimes fire SessionEnd more than once (e.g. /exit then PTY close).

3. **No Mnestra migration needed.** No mnestra@0.4.2 publish needed. The v1.0.2 wave is termdeck@1.0.2 + termdeck-stack@0.6.2 only (rumen unchanged).

4. **Audit-upgrade probe set extension is OPTIONAL** for v1.0.2 — the schema is already correct on petvetbid; this is a hook-code fix, not a schema fix. T3 may want to add a probe asserting "memory_sessions accepts a bundled-hook-shaped INSERT" as a regression test, but that's belt-and-suspenders, not gating.

5. **Regression test in `packages/stack-installer/tests/memory-session-end.test.js`** — extend the existing `postMemoryItem` test with a `postMemorySession` analog (mocked fetch), assert both POSTs fire on a successful run.

**Coordination handoff:**

- T1: pivot per the note above — confirm by absence (no memory_sessions write to instrument) rather than by error trace.
- T3: scope locked to bundled-hook code change + regression test. No DB migration. No mnestra publish. Approximate started_at if exact extraction adds complexity.
- T4 (Codex): re-run the manual INSERT repro in step 5 above from a fresh psql session; verify the schema continues to accept the bundled-hook column set; after T3 ships v1.0.2 + Joshua reinstalls, end a fresh CC session and confirm `select count(*) from memory_sessions` grows by 1 from the current 289.

**Companion-artifacts note for the orchestrator:** ledger entry #15 in `docs/INSTALLER-PITFALLS.md` should document Class M (hook swap drops a write path the previous writer carried). The pre-ship checklist may grow item #12: "if the installer overwrites a hook, diff the previous content for any write path / Supabase table / external call the bundled version doesn't replicate." This is exactly the trap that took Joshua's memory_sessions ingestion offline for 2 days without a single error log to point at.

T2 lane DONE — read-only audit complete; no schema mutations, no code changes. Bug #2 reclassified from "broken hook execution" to "absent hook write path"; T3 unblocked.

---

### [T4-CODEX] FINDING 2026-05-03 20:05 ET - Phase A independent audit: T2 root cause confirmed; source_agent timing claim needs correction.

**CONFIRMED - memory_sessions is not failing at INSERT time.** Fresh psql against petvetbid matches T2's schema:

- `memory_sessions` has only two required caller-populated columns: `session_id text NOT NULL` and `project text NOT NULL default 'global'`; `created_at` defaults to `now()`.
- RLS policy is service-role full access (`USING true`, `WITH CHECK true`).
- Baseline remains `count=289`, `max(ended_at)=2026-05-01 20:40:13.622+00`, `max(created_at)=2026-05-01 20:40:30.143631+00`.
- Rolled-back manual repro with the column set T3 would need (`session_id, summary, summary_embedding, project, started_at, ended_at, duration_minutes, messages_count, facts_extracted, files_changed, topics, transcript_path`) returned one row successfully, then rolled back. No schema gap, no constraint failure, no RLS block.

**CONFIRMED - current hook has no memory_sessions branch to instrument.** Independent `rg -n "memory_sessions"` returned zero matches in both `~/.claude/hooks/memory-session-end.js` and `packages/stack-installer/assets/hooks/memory-session-end.js`. The bundled hook docstring at lines 17-39 says it "POSTs ONE row" to `/rest/v1/memory_items`; the only write function is `postMemoryItem()` at bundled lines 465-495, called from `processStdinPayload()` at lines 552-560. Therefore T2's reclassification is correct: Bug #2 is an omitted write path, not a swallowed runtime error from an existing write block.

**CONFIRMED - older rag-system path was the memory_sessions writer.** `~/Documents/Graciella/rag-system/hooks/memory-session-end.js` spawns `npx tsx .../src/scripts/process-session.ts`; `process-session.ts:131-143` inserts into `memory_sessions`. The current installed hook and its `memory-session-end.js.bak.20260502-132414` backup are TermDeck Mnestra-direct hooks, not the rag-system spawner.

**DIVERGENCE - installed hook is stale versus repo bundled hook.** Installed hook is 508 LOC, mtime `May 2 13:27:18 2026`; bundled hook is 597 LOC and includes Sprint 50 Grok parser plus `source_agent` plumbing. Diff evidence: installed lacks bundled lines 271-327 (`parseGrokJson`) and 447-563 (`normalizeSourceAgent`, `source_agent` write, sourceAgent log suffix). This is not T2's root cause for `memory_sessions`, but T3 must ensure the v1.0.2 install step refreshes the installed hook, not just package contents.

**DIVERGENCE - the "4 source_agent='claude' rows landed between 23:01-23:06 UTC" memory is not supported by live psql.** Explicit NULL-marker query shows:

```
source_agent | rows | first_seen                    | last_seen
<NULL>       | 6270 | 2026-03-04 22:42:31.216502+00 | 2026-05-04 00:02:27.794092+00
claude       |   23 | 2026-05-02 17:03:46.530223+00 | 2026-05-03 22:38:31.581146+00
codex        |    4 | 2026-05-03 22:50:42.257612+00 | 2026-05-03 22:53:33.799719+00
```

The four post-mig-015 Codex chopin-in-bohemia memories are `source_agent='codex'`, not `claude`. Recent TermDeck memories after `2026-05-03 23:00 UTC` are direct `memory_remember` rows with `source_agent IS NULL`. The source_agent column exists and is writable, but the current installed hook no longer proves a recent `claude` source_agent path after 22:38 UTC.

**GAP for T3 verification.** Post-fix proof must check both tables after installing v1.0.2: `memory_sessions` count must grow by 1, and the new `memory_items.session_summary` row from the same `/exit` must carry `source_agent='claude'`. Because the installed hook is currently stale, failing the second check means the installer did not refresh the hook or T3 regressed Sprint 50 provenance.

---

### [T1] FINDING — 2026-05-03 ~20:05 ET — confirms T2's reclassification by absence; flags two orthogonal installed-hook drifts T3 should fold into v1.0.2

T2 already nailed the headline (no memory_sessions write path exists in the bundled hook; the swap on 2026-05-02 13:24 ET dropped Joshua's rag-system spawner that was the actual writer). T1 ran the static-analysis + cross-repo-writer + live-log + live-psql audit independently and confirms the same conclusion. **No instrumentation applied** — there is no `try { INSERT memory_sessions } catch {}` block to wrap, so the lane's step 3 ("wrap with un-swallowed error logging") is a no-op by construction. **Nothing to restore** — `diff ~/.claude/hooks/memory-session-end.js packages/stack-installer/assets/hooks/memory-session-end.js` is unchanged from pre-T1 state.

T2 covered the schema audit + manual SQL repro + Class M classification thoroughly. T1 adds two orthogonal drifts that **also need v1.0.2 attention** — both surfaced during the bundled-vs-installed diff and both affect production right now:

**Side finding (a) — installed hook is the pre-Sprint-50 cut.** `diff ~/.claude/hooks/memory-session-end.js packages/stack-installer/assets/hooks/memory-session-end.js` shows:
- Installed (20083 bytes, mtime May 2 13:27, ~508 LOC) is missing `parseGrokJson` (Sprint 50 T1), `ALLOWED_SOURCE_AGENTS` + `normalizeSourceAgent` (Sprint 50 T2), the `'grok'` entry in `TRANSCRIPT_PARSERS`, the `source_agent` field in the `postMemoryItem` request body, and the `sourceAgent` plumbing through `processStdinPayload`.
- Bundled (23841 bytes, mtime May 2 15:15, ~597 LOC) has all of the above.
- The 4 source_agent='claude' rows that landed post-Codex's mig 015 (per the orchestrator's earlier memory) DID NOT come from the installed hook supplying `source_agent` — the installed hook doesn't send that field. They landed because mig 015's `source_agent` column has a DEFAULT of `'claude'` (the column shape Codex installed). So the post-mig-015 source_agent='claude' evidence is consistent with the installed hook silently relying on the column default; the moment a non-Claude panel (codex/gemini/grok) tries to write through the installed hook, it'll mis-tag as 'claude' instead of the true agent. **Brad and any future user who runs `termdeck init --mnestra` from v1.0.1 ALSO gets this stale hook**, because the v1.0.1 stack-installer presumably ships the same pre-Sprint-50 cut Joshua is running. T3 must verify what `npm pack --dry-run` for the v1.0.1 termdeck-stack tarball actually contains for `assets/hooks/memory-session-end.js` — if it's the pre-Sprint-50 version, that's a v1.0.1 ship gap.

**Side finding (b) — installed hook has empty PROJECT_MAP.** Same diff: the `PROJECT_MAP` array in the installed hook is `[]` (only commented examples). Sprint 41 T1 (memory-confirmed: "rewritten ~/.claude/hooks/memory-session-end.js (133 LOC, most-specific-first PROJECT_MAP + module-export contract)") landed a 14-entry map on 2026-04-28; the May 2 13:27 install reverted it. Live evidence: every recent `ingested:` line in `~/.claude/hooks/memory-hook.log` (4 entries from 2026-05-03 22:38 UTC = 18:38 ET) tags as `project="global"`. So **all memory_items written today by Joshua's Claude Code sessions are mis-tagged** (should be `termdeck` or `mnestra` or whatever the cwd implies, getting `global` instead). This is the SAME failure class as Sprint 35's chopin-nashville mis-tag, recurring two sprints later because PROJECT_MAP customizations don't survive hook reinstalls. T3 should pick one of:
- (i) Ship a non-empty default PROJECT_MAP in the bundled hook (the 14-entry Sprint 41 map is a good starting point, even if some entries are Joshua-personal and could be reduced for general-user shipping).
- (ii) Have the installer preserve any user-customized PROJECT_MAP across upgrades (parse the existing file before overwrite, port the array forward).
- (iii) Move PROJECT_MAP to `~/.termdeck/config.yaml` so it survives hook reinstalls — the cleanest long-term answer, but the highest-effort.

**Live evidence supporting (b):**

```
$ tail -5 ~/.claude/hooks/memory-hook.log | grep ingested
[2026-05-03T22:38:13.482Z] ingested: project="global" session=588edc1d-718c-4fa5-afa5-e3b9d9a6042b bytes=5459 sessionType=auto
[2026-05-03T22:38:19.993Z] ingested: project="global" session=f5b1e828-cdba-4c11-a0b5-a964524ca6f6 bytes=4864 sessionType=auto
[2026-05-03T22:38:25.641Z] ingested: project="global" session=a0ef58b9-d799-4cbf-9b5c-7f03977a2a86 bytes=3986 sessionType=auto
[2026-05-03T22:38:27.887Z] ingested: project="global" session=03b55630-8c96-445c-a76b-c34fea0d817b bytes=2940 sessionType=auto
```

All 4 today's writes tagged `global` — these were Sprint 51.5 sessions, all from cwd in `…/SideHustles/TermDeck/termdeck/`, should have tagged `termdeck`. Mis-tagged into `global` they're effectively orphaned in memory_recall queries scoped by project.

**Cross-validation with T2:** T2's evidence stack (schema audit, baseline confirmation, code-path audit, hook-swap timeline, manual SQL repro) and T1's evidence stack (diff, cross-repo writer audit, settings.json audit, .bak hook audit, live psql, hook-log audit) are independent and converge on the same Class M classification. **T1 and T2 are in agreement.** T3 has both lanes' joint sign-off to pivot scope.

**Files referenced (from T1's audit, additive to T2's list):**

- `~/.claude/hooks/memory-session-end.js.bak.20260502-132414` (16595 bytes) — the immediately-prior installed hook (Sprint 48-era, pre-source_agent). Confirms the architectural decision of `memory_items`-only has held since Sprint 38.
- `~/.claude/settings.json` + `~/.claude/settings.json.bak.20260502-132515` — both wire only `node ~/.claude/hooks/memory-session-end.js` under SessionEnd. No separate rag-system hook entry. Confirms there is no parallel hook to fall back to.
- `~/.claude/hooks/memory-hook.log` — 108 successful `ingested:` entries, all memory_items, **zero** memory_sessions chatter (no successes, no failures, no skips — confirming by absence).

### [T1] DONE — 2026-05-03 ~20:08 ET

- Lane discipline: no version bumps, no CHANGELOG edits, no commits.
- Hook un-modified — no instrumentation applied (would have wrapped a non-existent code block); no restore needed.
- Three findings posted: (main) confirmation of T2's Class M reclassification by absence, (a) installed hook is pre-Sprint-50, (b) PROJECT_MAP empty causing today's writes to mis-tag as `global`.
- T3 scope recommendation: A v1.0.2 wave that ships ALL THREE — (1) memory_sessions write path in bundled hook (T2's Class M fix), (2) ensure stack-installer brings down the post-Sprint-50 bundled hook (source_agent + grok parser), (3) PROJECT_MAP either restored as default in bundled hook OR preserved-across-reinstalls by the installer. Together those three close every drift T1+T2 surfaced; without (2) and (3), v1.0.2 ships with the same silent mis-tag and missing-source_agent behaviors that v1.0.1 had.

### [ORCHESTRATOR] FINDING — 2026-05-03 20:09 ET — Brad just reported TWO MORE v1.0.1 regressions; folding into v1.0.2 scope

Brad's CC delivered a 4-project install pass debrief on `jizzard-brain` running v1.0.1 just now. Two new bugs in `init-rumen.js` + `audit-upgrade.js` — same release wave T3 is already touching, fold in cleanly.

**Bug C (subprocess link-state isolation):** `termdeck init --rumen` runs `supabase link --project-ref <ref>` successfully (audit-upgrade probes immediately after confirm the link is alive), then a few subprocess calls later runs `supabase functions deploy graph-inference --no-verify-jwt` which errors with `Cannot find project ref. Have you run supabase link?`. Same machine, same shell session, same Supabase CLI v2.90.0. Brad's hypothesis (verified by `init-rumen.js` reading): `supabase link` persists state to the workdir's `supabase/config.toml` + `.temp/`. The wizard runs link from one cwd, `functions deploy` from a different cwd. Second subprocess doesn't see the link. Brad workarounded via direct Supabase MCP `deploy_edge_function` with `__RUMEN_VERSION__` substituted to 0.4.5; both functions now at v15/v2 on jizzard-brain. **Fix vector (Brad's own diagnosis):** pass `--project-ref <ref>` explicitly to every `supabase functions deploy` invocation in `init-rumen.js`, dodging link-state coupling entirely. Optional: add a post-link verification step (`supabase status --linked` or similar) that fails fast if link state didn't persist.

**Bug D (audit-upgrade only checks function existence, not source):** Brad's deployed Edge Functions are the OLD source (no `SUPABASE_DB_URL` fallback). `audit-upgrade` reports "install up to date — 5/7 probes all present" because it only checks "is the function deployed?" not "is the deployed function the bundled source?" Class A — Schema drift logic should extend to function-source drift. **Fix vector:** add a probe that fetches the deployed function source via Supabase Management API (or `supabase functions download`) and diffs against `packages/server/src/setup/rumen/functions/<name>/index.ts`. If they diverge, the function needs redeploy.

**T3 scope addition (request):** fold both into v1.0.2. The original 3-part fix (memory_sessions write path + post-Sprint-50 hook bundling + PROJECT_MAP preservation) becomes a 5-part fix:
1. memory_sessions write path in bundled hook (Class M).
2. Bundle the post-Sprint-50 hook with source_agent + grok parser (closes T1's side finding (a)).
3. PROJECT_MAP either restored as bundled default OR preserved-across-reinstalls (closes T1's side finding (b)).
4. Pass `--project-ref` explicitly to `supabase functions deploy` in `init-rumen.js` (closes Brad's Bug C).
5. Extend audit-upgrade to diff deployed function source vs bundled (closes Brad's Bug D).

Rationale for folding in (vs spinning Sprint 51.7): same code surface (`init-rumen.js` + `audit-upgrade.js` + bundled hook); we are already shipping a v1.0.2 wave; ALL v1.0.1 users will hit Bug C on the upgrade path until v1.0.2 ships, so the urgency is real.

T3 — please ack scope expansion in your next FIX-PROPOSED post. If the 5-part fix is too large for one wave, propose a split (e.g., #1-3 in v1.0.2, #4-5 in v1.0.3 same-day) and the orchestrator will decide.

T4 (Codex) — your Phase B verification scope grows accordingly: v1.0.2 install on a fresh machine + `termdeck init --rumen` runs end-to-end without the Bug C error; new function-source-diff probe correctly detects out-of-date deployed functions on a deliberately-stale fixture project.

---

### [T4-CODEX] AUDIT 2026-05-03 20:09 ET - T1/T2 convergence confirmed; correct one T1 source_agent mechanism before T3 relies on it.

**CONFIRMED - T1 and T2 converge on the core root cause.** T4 independently verified:

- No `memory_sessions` string appears in installed or bundled hook.
- `~/.claude/settings.json` wires exactly one SessionEnd command: `node ~/.claude/hooks/memory-session-end.js`.
- The old private rag-system hook at `~/Documents/Graciella/rag-system/hooks/memory-session-end.js` spawns `process-session.ts`; that script writes `memory_sessions` at lines 131-143.
- T1's "no instrumentation applied because no write block exists" is the right behavior. There was nothing to restore.

**CONFIRMED - T1 side finding (installed hook stale) is real.** Installed hook is the 508-LOC May 2 13:27 cut; bundled hook is 597 LOC and includes source_agent/grok parser plumbing. T3 must verify the installed hook after `npm install -g @jhizzard/termdeck@1.0.2` plus `termdeck init --mnestra`, not merely verify package tarball contents.

**CONFIRMED - T1 side finding (PROJECT_MAP empty) is real.** Installed hook's `PROJECT_MAP` is only commented examples, and recent log lines from `2026-05-03 22:38 UTC` all show `project="global"` for TermDeck sprint sessions. That means v1.0.2 acceptance should include project tagging for a TermDeck cwd, not only row-count growth.

**DIVERGENCE - source_agent rows did not come from a column DEFAULT.** T1's explanation says the four `source_agent='claude'` rows landed because mig 015's `source_agent` column has a DEFAULT. Live schema says otherwise:

```
memory_items.source_agent default: <NULL>
pg_attrdef for source_agent: <NULL>
triggers on memory_items: 0
```

Canonical migration 015 explains the actual mechanism: it adds a nullable `source_agent` column, then backfills historical `source_type='session_summary' AND source_agent IS NULL` rows to `claude`. Therefore the 22:38 UTC `claude` rows are explainable as migration-015 backfill over already-existing session_summary rows, not proof that the currently installed stale hook writes source_agent and not proof of a default that will protect future rows.

**T3 gate implication.** The v1.0.2 hook must explicitly send `source_agent: normalizeSourceAgent(sourceAgent)` on future `memory_items` writes. If the post-v1.0.2 `/exit` creates a `memory_items.session_summary` with `source_agent IS NULL`, T3 must reopen even if `memory_sessions` grew.

---

### [T4-CODEX] GAP 2026-05-03 20:11 ET - Phase B command path cannot refresh the hook unless T3 changes installer wiring.

The sprint brief's canonical Phase B path says: install v1.0.2, run `termdeck init --mnestra` against petvetbid, then trigger `/exit`. Current code cannot make that pass by itself:

- `packages/cli/src/init-mnestra.js` applies Mnestra migrations and audit-upgrade only; it never calls `installSessionEndHook()` and never copies `packages/stack-installer/assets/hooks/memory-session-end.js` to `~/.claude/hooks/memory-session-end.js`.
- Hook installation lives only in `packages/stack-installer/src/index.js::installSessionEndHook()`.
- Even that stack-installer path currently preserves an existing different hook by default under `--yes`: line 587 sets `overwrite = opts.assumeYes ? false : ...`. So an automated `npx @jhizzard/termdeck-stack --yes` rerun would keep the stale 508-LOC hook unless T3 changes the overwrite/upgrade policy or adds a version-aware hook refresh.

**GAP for T3.** Shipping a fixed bundled hook is insufficient. T3 must provide one of these before T4 can verify the user path:

1. `termdeck init --mnestra` also refreshes the installed session-end hook when a vendored TermDeck hook is present and stale; or
2. stack-installer gains a version-aware/idempotent hook-upgrade path that overwrites old TermDeck-managed hooks while preserving genuinely custom hooks; and Phase B instructions change to run that path; or
3. T3 explicitly documents that v1.0.2 requires `npx @jhizzard/termdeck-stack` with a force/upgrade flag, and that flag is tested.

Without this, Phase B will still run the stale installed hook and `memory_sessions` will stay flat no matter how correct the bundled code is.

---

### [T3] FIX-PROPOSED 2026-05-03 20:15 ET — single v1.0.2 wave, 5-part scope acked, **CRITICAL schema discovery forces Path C (mnestra mig 017)** for Bug #2

**Scope expansion ACKED.** Single wave (no v1.0.2/v1.0.3 split — same release ships all five). Effort estimate ~250 LOC across 4 files + 4 test additions. Tight but breaks the cycle the mini exists to break.

**T4-CODEX correction noted:** source_agent column default is NULL on petvetbid; the 4 `source_agent='claude'` rows landed via mig 015 backfill of historical session_summary rows, not via the installed hook supplying the field. The pre-Sprint-50 installed hook (Joshua's current) doesn't emit `source_agent` at all. The post-Sprint-50 bundled hook (which v1.0.2 install will land) does. **T3 doesn't need to add source_agent emission — it's already there in the bundled hook (line 482 of `assets/hooks/memory-session-end.js`).** Item #2 of the 5-part scope is satisfied by the existing bundled-hook source — Joshua just needs to reinstall (which `npm install -g @jhizzard/termdeck@1.0.2 && termdeck init --mnestra` triggers anyway).

**CRITICAL schema discovery (forces Path C, not B-thin):**

T2's audit listed petvetbid's `memory_sessions` schema. I cross-referenced against canonical engram `001_mnestra_tables.sql:52-58` and the two are **incompatible**, not "petvetbid is a superset":

| Column | Canonical engram (mig 001) | petvetbid (rag-system flavor) |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | uuid PK default gen_random_uuid() |
| `project` | text NOT NULL default 'global' | text NOT NULL default 'global' |
| `summary` | text | text |
| `metadata` | **jsonb NOT NULL default '{}'** | **(absent)** |
| `created_at` | timestamptz NOT NULL default now() | timestamptz NOT NULL default now() |
| `session_id` | (absent) | **text NOT NULL UNIQUE** |
| `summary_embedding` | (absent) | vector(1536) |
| `started_at` | (absent) | timestamptz |
| `ended_at` | (absent) | timestamptz |
| `duration_minutes` | (absent) | integer |
| `messages_count` | (absent) | integer default 0 |
| `facts_extracted` | (absent) | integer default 0 |
| `files_changed` | (absent) | jsonb default '[]' |
| `topics` | (absent) | jsonb default '[]' |
| `transcript_path` | (absent) | text |

There's NO column intersection beyond `(id, project, summary, created_at)` — and you can't write a useful row with just those four. Petvetbid REQUIRES `session_id NOT NULL`; canonical doesn't have that column. Petvetbid has NO `metadata` column; canonical's metadata is NOT NULL.

**Implications:**
- Path B-thin (write canonical-only `(project, summary, metadata)`) breaks on petvetbid: `column "metadata" of relation "memory_sessions" does not exist`.
- Path B-rich (write rag-system shape `session_id, summary, summary_embedding, ...`) breaks on canonical: `column "session_id" of relation "memory_sessions" does not exist`.
- **Only Path C works:** ship Mnestra mig 017 that brings canonical schema in line with petvetbid's rag-system flavor, then bundled hook writes the rich shape on both.

This is a stronger Path-C requirement than my earlier recon FINDING surmised. T2's "no migration needed" must be revised — it's needed for universal correctness, not optional. Mnestra@0.4.2 publish required.

**Migration 017 design (idempotent, safe on both schemas):**

```sql
-- 017_memory_sessions_session_metadata.sql
-- Reconciles canonical engram memory_sessions with the rag-system writer's
-- richer column set, so TermDeck v1.0.2's bundled session-end hook can write
-- a uniform shape on both fresh-canonical installs and Joshua's petvetbid.
-- Idempotent: every column add uses IF NOT EXISTS; the unique constraint is
-- guarded by a do-block.

alter table public.memory_sessions
  add column if not exists session_id text,
  add column if not exists summary_embedding vector(1536),
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists duration_minutes integer,
  add column if not exists messages_count integer default 0,
  add column if not exists facts_extracted integer default 0,
  add column if not exists files_changed jsonb default '[]'::jsonb,
  add column if not exists topics jsonb default '[]'::jsonb,
  add column if not exists transcript_path text;

-- Unique constraint on session_id (skip if already present from rag-system bootstrap).
-- Joshua's petvetbid has memory_sessions_session_id_key; fresh canonical installs do not.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memory_sessions_session_id_key'
  ) then
    alter table public.memory_sessions
      add constraint memory_sessions_session_id_key unique (session_id);
  end if;
end $$;

-- HNSW index on summary_embedding (skip if already present).
create index if not exists memory_sessions_summary_embedding_hnsw_idx
  on public.memory_sessions using hnsw (summary_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```

**NOTE:** The migration deliberately leaves `session_id` NULLABLE on canonical installs (a NOT NULL ADD COLUMN would error if the table has rows; canonical has 0 or N rows from prior writes). The bundled hook always supplies `session_id`, so this works in practice. Joshua's petvetbid keeps its existing NOT NULL constraint untouched. Future canonical installs can tighten if needed in a later sprint.

**5-part fix concrete plan:**

| # | Bug | File(s) | LOC est | Tests |
|---|---|---|---|---|
| 1 | memory_sessions write missing | `packages/stack-installer/assets/hooks/memory-session-end.js` (add `postMemorySession`, refactor `buildSummary` to return `{summary, messagesCount}`) + `packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql` (new) + sync into `~/Documents/Graciella/engram/migrations/017_*.sql` | ~80 hook + 30 mig | tests/stack-installer-hook-merge.test.js: extend the existing `postMemoryItem` mock-fetch test pattern with a `postMemorySession` analog asserting both POSTs fire on a successful run. |
| 2 | Pre-Sprint-50 installed hook | (no code change — bundled hook in v1.0.1 already has source_agent + grok parser; user reinstall via `termdeck init --mnestra` lands it) | 0 | T4 verifies post-install. |
| 3 | PROJECT_MAP empty default | `packages/stack-installer/assets/hooks/memory-session-end.js` (replace empty `PROJECT_MAP = []` with the 14-entry Sprint 41 map, generalized — non-Joshua-specific paths kept; Joshua-specific paths kept as comments OR shipped because they're benign on other machines, e.g. `/PVB/i` simply doesn't fire on Brad's cwd) | ~20 | tests/project-taxonomy.test.js's 22 pre-existing failures should all pass post-fix. |
| 4 | --project-ref explicit on `supabase functions deploy` | `packages/cli/src/init-rumen.js` (every `supabase functions deploy <name>` invocation gains `--project-ref <ref>`) | ~10 | New test: mock subprocess runner asserts every functions-deploy spawn carries `--project-ref`. |
| 5 | audit-upgrade source-diff probe | `packages/server/src/setup/audit-upgrade.js` (new probe kind: `functionSource` — fetches deployed function via Management API GET `/v1/projects/<ref>/functions/<slug>/body`, diffs against bundled `packages/server/src/setup/rumen/functions/<name>/index.ts`. If diverges, redeploys.) + extend PROBES set with `rumen-tick` and `graph-inference-tick` source-diff entries | ~80 | tests/audit-upgrade.test.js: mock the Management API fetch, assert source-diff probe fires `applied[]` when source diverges. |

**Wave (revised from prior FINDING):**
- `@jhizzard/termdeck@1.0.2` — items #4, #5 land in `packages/cli/` and `packages/server/` (root)
- `@jhizzard/termdeck-stack@0.6.2` — items #1, #3 land in `packages/stack-installer/assets/hooks/`
- `@jhizzard/mnestra@0.4.2` — item #1 mig 017 lands in `~/Documents/Graciella/engram/migrations/`
- `@jhizzard/rumen` — unchanged

**Order (per RELEASE.md strict-order rule):** mnestra@0.4.2 first (`cd engram && npm publish --auth-type=web`), then `npm run sync-rumen-functions` from termdeck root, then `npm pack --dry-run` verification, then termdeck@1.0.2, then termdeck-stack@0.6.2, then `git push origin main` on engram + termdeck. All publishes Passkey, never `--otp`.

**audit-upgrade probe extension also covers item #1's mig 017** — adding mig 017 to PROBES means a v1.0.1 user running `termdeck init --mnestra` after upgrading to v1.0.2 gets mig 017 auto-applied via the existing schema-introspection path (no manual SQL needed; matches the v1.0.1 audit-upgrade pattern Sprint 51.5 T1 shipped). Need to extend PROBES with:
```js
{
  name: 'memory_sessions.session_id',
  kind: 'mnestra',
  migrationFile: '017_memory_sessions_session_metadata.sql',
  probeSql:
    "select 1 as present from information_schema.columns " +
    "where table_schema = 'public' " +
    "  and table_name = 'memory_sessions' " +
    "  and column_name = 'session_id' limit 1",
  presentWhen: 'rowReturned'
}
```

**Test suite gate:**
- Root `node --test tests/*.test.js` must report ≥950 pass post-fix; the 22 pre-existing project-taxonomy.test.js failures should ALL pass post-fix #3 (a strong corroboration signal). New tests (4-5 additions) are additive.
- `cd packages/stack-installer && node --test tests/*.test.js` must pass.

**Lane discipline:** no version bumps, no CHANGELOG edits, no commits — orchestrator handles all close-out.

**Beginning code work now — will post FIX-LANDED with file:line references and test-pass counts.**

---

### [T4-CODEX] AUDIT 2026-05-03 20:12 ET - REOPEN T3 assumption before code lands: `termdeck init --mnestra` does not install the hook.

T3 FIX-PROPOSED says item #2 needs no code change because "user reinstall via `termdeck init --mnestra` lands it." That is contradicted by the current code.

Evidence:

- `packages/cli/src/init-mnestra.js` imports setup helpers only (`prompts`, `dotenv`, `yaml`, `supabaseUrl`, `migrations`, `pgRunner`, `preconditions`, `auditUpgrade`). It does not import `packages/stack-installer/src/index.js` or call `installSessionEndHook()`.
- `init-mnestra.js` main flow at lines 576-580 runs: `checkExistingStore`, `applyMigrations`, `runMnestraAudit`, `writeYamlConfig`. No hook copy or settings merge occurs.
- `installSessionEndHook()` exists only in `packages/stack-installer/src/index.js:539-642`.
- Existing-different hook behavior in that installer currently preserves the stale hook under `--yes`: `const overwrite = opts.assumeYes ? false : ...` at line 587.

Therefore the proposed wave cannot pass T4 Phase B as written. Installing package bits plus running `termdeck init --mnestra` will leave Joshua's stale 508-LOC hook in place, so `/exit` will still run the old memory_items-only hook with empty PROJECT_MAP and no source_agent emission.

**Required T3 correction:** item #2 is not satisfied by existing bundled source. Add an explicit hook-upgrade path. Acceptable options:

1. stack-installer version-aware upgrade: if the existing hook is recognized as an older TermDeck-managed hook, overwrite it automatically even under `--yes`; preserve genuinely custom hooks by backup + prompt or by requiring a force flag.
2. termdeck CLI path: `termdeck init --mnestra` invokes the same version-aware hook refresh after migrations, so the sprint brief's Phase B command path is true.
3. documented force path: add and test a force/upgrade flag, then revise Phase B to run it before `/exit`.

Until one of those lands, T4 will treat T3 as incomplete regardless of hook code, migration 017, or test results.

---

### [T4-CODEX] AUDIT 2026-05-03 20:14 ET - early hook diff check: memory_sessions upsert needs explicit `on_conflict=session_id`.

T3's in-progress `postMemorySession()` is directionally correct, but the current REST call is not actually idempotent for duplicate SessionEnd fires:

```js
fetch(`${supabaseUrl}/rest/v1/memory_sessions`, {
  method: 'POST',
  headers: {
    ...
    'Prefer': 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify({ session_id: sessionId, ... })
})
```

For Supabase/PostgREST upsert, `Prefer: resolution=merge-duplicates` must target the relevant conflict key. Because the hook does not send `id`, default primary-key conflict handling will not merge duplicate `session_id` attempts. A second fire for the same session is expected to hit `memory_sessions_session_id_key` and fail unless the URL includes `?on_conflict=session_id` (or equivalent client behavior).

**Required T3 fix:** change the endpoint to:

```js
`${supabaseUrl}/rest/v1/memory_sessions?on_conflict=session_id`
```

and add a unit assertion that the memory_sessions fetch URL contains `on_conflict=session_id` when the header uses `resolution=merge-duplicates`.

**Related migration nit:** the migration-017 constraint guard should scope the `pg_constraint` lookup to `conrelid = 'public.memory_sessions'::regclass`, not just `conname = 'memory_sessions_session_id_key'`, so an unrelated same-named constraint cannot cause a false skip.

---

### [T4-CODEX] AUDIT 2026-05-03 20:17 ET - hook refresh path must be packaged in `@jhizzard/termdeck`, not only stack-installer.

T3 added `refreshBundledHookIfNewer()` to `packages/cli/src/init-mnestra.js`, which is the right user-path correction. But the current source path will not exist in the published root package unless package contents change:

```js
path.join(__dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js')
```

In the monorepo this resolves to `packages/stack-installer/assets/hooks/memory-session-end.js`. In published `@jhizzard/termdeck`, root `package.json` currently ships:

```
packages/cli/src/**
packages/cli/templates/**
packages/server/src/**
packages/client/public/**
config/...
docs/...
```

It does **not** ship `packages/stack-installer/assets/**`. Therefore the Phase B path (`npm install -g @jhizzard/termdeck@1.0.2 && termdeck init --mnestra`) will likely return `no-bundled` from `refreshBundledHookIfNewer()` and leave the stale installed hook unchanged.

**Required T3 fix:** either:

1. add `packages/stack-installer/assets/hooks/memory-session-end.js` (or all needed stack-installer assets) to root `package.json.files` and verify with root `npm pack --dry-run`; or
2. place a copy of the hook under a path already shipped by `@jhizzard/termdeck` (for example `packages/cli/templates/`) and point `refreshBundledHookIfNewer()` there; or
3. make Phase B explicitly install/run `@jhizzard/termdeck-stack@0.6.2` and use its packaged hook source.

Also audit the overwrite gate: current `_hookSignatureUpgradeAvailable()` treats any unsigned installed hook as upgradeable. That refreshes Joshua's stale unsigned TermDeck hook, but it would also auto-overwrite a genuinely custom unsigned hook. Safer gate: auto-overwrite unsigned installed hooks only if they look TermDeck-managed (for example contain `TermDeck session-end memory hook` or `@jhizzard/termdeck-stack`); otherwise keep + report/manual force.

---

### [T4-CODEX] AUDIT 2026-05-03 20:23 ET - current T3 patch still has two Phase B blockers plus one overwrite-safety gap.

Snapshot from the in-progress patch after T3 started coding:

**BLOCKER 1 - `postMemorySession()` still lacks `?on_conflict=session_id`.** The current hook endpoint remains:

```js
fetch(`${supabaseUrl}/rest/v1/memory_sessions`, {
  headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal', ... }
})
```

That does not satisfy the idempotent duplicate-SessionEnd requirement. T3 should change the endpoint and assert it in `tests/stack-installer-hook-merge.test.js`.

**BLOCKER 2 - `@jhizzard/termdeck` still does not package the hook source used by `init --mnestra`.** Root `package.json.files` still contains only:

```json
"packages/cli/src/**",
"packages/cli/templates/**",
"packages/server/src/**",
"packages/client/public/**",
...
```

but `refreshBundledHookIfNewer()` points at `packages/stack-installer/assets/hooks/memory-session-end.js`. In the monorepo this exists; in the published root package it will not unless `package.json.files` changes or the hook source moves under a shipped path. This blocks the exact Phase B path in the sprint brief.

**SAFETY GAP - unsigned custom hooks are still auto-overwritten under `--yes`.** `packages/stack-installer/src/index.js` currently treats `installed === null` as upgradeable with no TermDeck-managed fingerprint check. That fixes Joshua's stale TermDeck hook but can clobber a user's genuinely custom unsigned hook. Acceptable fix: unsigned + contains a TermDeck marker auto-refreshes; unsigned + no TermDeck marker is kept unless `forceOverwrite`/interactive approval.

**Already improved:** migration 017 now detects any unique constraint on `public.memory_sessions(session_id)`, not just a bare constraint name, and `init-rumen.js` now threads `--project-ref` into deploy calls. Those two earlier audit items look addressed pending test results.

---

### [T4-CODEX] AUDIT 2026-05-03 20:25 ET - current test coverage does not yet cover two proposed T3 guarantees.

T3's FIX-PROPOSED promised tests for the new hook-refresh path and for explicit `--project-ref` on function deploys. Current patch snapshot does not yet have those tests:

- `packages/cli/src/init-mnestra.js` exports `refreshBundledHookIfNewer`, and even comments "exported for tests/init-mnestra-hook-refresh.test.js", but no `tests/init-mnestra-hook-refresh.test.js` exists. There is also no test that the published root package includes the hook source path this function reads.
- `deployFunctions()` is not exported from `packages/cli/src/init-rumen.js`, and `tests/init-rumen-deploy.test.js` currently covers function staging only. There is no assertion that every `supabase functions deploy` spawn includes `--project-ref <ref>`, so Bug C could regress silently.
- `tests/stack-installer-hook-merge.test.js` currently asserts the old bad memory_sessions URL (`/rest/v1/memory_sessions`) instead of the required upsert URL (`/rest/v1/memory_sessions?on_conflict=session_id`).

T4 gate expectation before `FIX-LANDED`: add focused tests for these paths or explicitly downgrade them in the sprint status as accepted residual risk. The code may be directionally correct, but the promised regression net is not in place yet.

---

### [T4-CODEX] AUDIT 2026-05-03 20:28 ET - HARD BLOCKER confirmed by `npm pack`: root package still excludes the hook.

I ran root package verification with an isolated npm cache:

```sh
env npm_config_cache=/private/tmp/termdeck-npm-cache npm pack --dry-run --json
```

The dry-run package contents include `packages/cli/src/init-mnestra.js` and `packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql`, but **do not include**:

```text
packages/stack-installer/assets/hooks/memory-session-end.js
```

That is the exact path `refreshBundledHookIfNewer()` reads by default:

```js
path.join(__dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js')
```

Therefore the current v1.0.2 root package would ship a hook-refresh function that cannot find its bundled source. `termdeck init --mnestra` would report `no-bundled` and leave Joshua's stale installed hook in place. This is a Phase B fail even if all unit tests pass in the monorepo.

**Required before `FIX-LANDED`:** root `npm pack --dry-run --json` must show the hook source path that `refreshBundledHookIfNewer()` uses, or `refreshBundledHookIfNewer()` must be repointed to a path already included in root package contents.

---

### [T4-CODEX] AUDIT 2026-05-03 20:32 ET - two hard blockers resolved in current diff; one overwrite-safety residual remains.

Follow-up after T3 reacted to T4's 20:23/20:28 blockers:

**RESOLVED - memory_sessions upsert URL now targets the session_id constraint.**

- `packages/stack-installer/assets/hooks/memory-session-end.js` now posts to:

```js
`${supabaseUrl}/rest/v1/memory_sessions?on_conflict=session_id`
```

- `tests/stack-installer-hook-merge.test.js` now asserts both the end-to-end call and the `postMemorySession()` unit call use `?on_conflict=session_id`.

**RESOLVED - root package now includes the hook source path used by `init --mnestra`.**

- Root `package.json.files` now includes:

```json
"packages/stack-installer/assets/hooks/**"
```

- Re-running root package verification with isolated cache:

```sh
env npm_config_cache=/private/tmp/termdeck-npm-cache npm pack --dry-run --json
```

now shows:

```text
packages/stack-installer/assets/hooks/memory-session-end.js
packages/stack-installer/assets/hooks/README.md
```

That clears the Phase B packaging blocker: published `@jhizzard/termdeck` should have the bundled hook source that `refreshBundledHookIfNewer()` reads.

**RESIDUAL GAP - unsigned custom hook overwrite policy remains aggressive.** The new hook-refresh tests intentionally assert "installed unsigned -> overwrites (treats unsigned as v0)" and only verify the old body is backed up. That fixes Joshua's stale unsigned TermDeck-managed hook, but it still auto-overwrites a genuinely custom unsigned hook under `init --mnestra` or stack-installer `--yes`. T4 is not treating this as a Phase B blocker for Joshua's v1.0.2 proof, because the stale installed hook is exactly what must be replaced. It should be documented as residual release risk or tightened before publish if T3 wants the upgrade path to preserve arbitrary custom hooks by default.

---

### [T4-CODEX] AUDIT 2026-05-03 20:35 ET - targeted tests mostly pass; installed-hook taxonomy remains a Phase B gate.

T4 ran:

```sh
node --test tests/stack-installer-hook-merge.test.js tests/init-mnestra-hook-refresh.test.js tests/init-rumen-project-ref.test.js tests/audit-upgrade.test.js tests/migration-loader-precedence.test.js tests/project-taxonomy.test.js
```

Result: `139` tests total, `117` pass, `22` fail. The 22 failures are all `tests/project-taxonomy.test.js`.

This is not a bundled-hook source failure. `tests/stack-installer-hook-merge.test.js` now passes the new bundled PROJECT_MAP assertions. The failing `project-taxonomy.test.js` is explicitly wired to Joshua's installed hook at:

```js
~/.claude/hooks/memory-session-end.js
```

and that installed hook has not been refreshed yet. It still exports `PROJECT_MAP = []`, so every taxonomy case returns `global`.

**Interpretation:** pre-Phase-B targeted tests are green except for the intentionally stale installed hook. This must flip after the v1.0.2 install + `termdeck init --mnestra` step. T4 Phase B acceptance therefore includes:

```sh
node --test tests/project-taxonomy.test.js
```

passing after hook refresh, in addition to the canonical `memory_sessions` row-count growth and `memory_items.source_agent='claude'` checks.

Additional T4 check: the same targeted set excluding the installed-hook taxonomy test passes cleanly:

```sh
node --test tests/stack-installer-hook-merge.test.js tests/init-mnestra-hook-refresh.test.js tests/init-rumen-project-ref.test.js tests/audit-upgrade.test.js tests/migration-loader-precedence.test.js
```

Result: `114` tests, `114` pass. The three `✗ deployFunctions: projectRef is required...` lines in stdout are expected validation messages from the negative test; Node reports the test as passing.

---

### [T3] FIX-LANDED 2026-05-03 20:38 ET — all 5 fix items + 3 Codex blockers staged; tests 986/22 (Sprint 51.5 baseline +36 pass, 0 new fails)

All five v1.0.2 fix items + the three Codex blockers from audits 20:17/20:23/20:25/20:28 are staged in the working tree. **Lane discipline preserved:** no version bumps, no CHANGELOG edits, no commits — orchestrator handles all close-out.

**Files changed (working tree):**

| Path | Change |
|---|---|
| `packages/stack-installer/assets/hooks/memory-session-end.js` | (1) Sprint-41 14-entry default `PROJECT_MAP` (most-specific-first + chopin-nashville catch-all LAST) — closes T1 side-finding (b). (2) `buildSummary` returns `{summary, messagesCount}`. (3) New `postMemorySession` with `?on_conflict=session_id` upsert URL + `Prefer: resolution=merge-duplicates,return=minimal` (closes T4-CODEX Blocker 1). (4) `processStdinPayload` calls both `postMemoryItem` and `postMemorySession`. (5) `// @termdeck/stack-installer-hook v1` version stamp for upgrade-aware overwrite. |
| `packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql` | NEW. Idempotent `ADD COLUMN IF NOT EXISTS` for session_id/summary_embedding/started_at/ended_at/duration_minutes/messages_count/facts_extracted/files_changed/topics/transcript_path. Unique constraint on session_id wrapped in a do-block scoped by `conrelid = 'public.memory_sessions'::regclass` (closes T4-CODEX 20:17 nit). HNSW index on summary_embedding. ended_at index. |
| `~/Documents/Graciella/engram/migrations/017_memory_sessions_session_metadata.sql` | Same content; canonical engram source for npm publish of mnestra@0.4.2. |
| `packages/server/src/setup/audit-upgrade.js` | New probe `memory_sessions.session_id` (mig 017). New `probeKind: 'functionSource'` with Management API fetch + marker check. Two new probes for `rumen-tick` and `graph-inference` deployed-source drift (Bug D). functionSource probes go to `skipped[]` (no auto-apply; redeploy via init --rumen). |
| `packages/cli/src/init-rumen.js` | `deployFunctions(rumenVersion, projectRef, dryRun)` — projectRef now required + threaded into `--project-ref <ref>` argv on every `supabase functions deploy` call (Bug C). Validation rejects missing/empty projectRef early. runRumenAudit surfaces `skipped[]` entries with `⊘ skipped` line. |
| `packages/cli/src/init-mnestra.js` | New `refreshBundledHookIfNewer()` step in `main()` after writeYamlConfig. Reads bundled hook signature from `packages/stack-installer/assets/hooks/memory-session-end.js`. Compares against installed signature; refreshes when bundled is strictly newer. Timestamped `.bak.<YYYYMMDDhhmmss>` backup. **Safety gate:** unsigned installed hook only auto-overwrites when it carries TermDeck-managed markers (closes T4-CODEX Blocker 3). |
| `packages/stack-installer/src/index.js` | `_hookSignatureUpgradeAvailable()` for version-aware overwrite under `--yes`. Same TermDeck-marker safety gate. Timestamped backup before overwrite. Exports for tests. |
| `package.json` (root) | Added `packages/stack-installer/assets/hooks/**` to `files` glob — bundled hook source now ships in `@jhizzard/termdeck` tarball (closes T4-CODEX Blocker 2; verified via `npm pack --dry-run`). |
| `tests/stack-installer-hook-merge.test.js` | Updated PROJECT_MAP-defaults assertions (was empty → Sprint-41 14-entry). Updated buildSummary tests for `{summary, messagesCount}`. processStdinPayload integration test asserts 3 calls. 5 new postMemorySession unit tests (on_conflict URL, sessionId-required, non-2xx, fetch-exception, null-embedding). Bundled-hook version-stamp pin. |
| `tests/audit-upgrade.test.js` | PROBES count 7→10. Dependency-order includes mig 017. `SQL_PROBES` filter for existing tests (8 entries). 4 new functionSource tests. Bundled mig-017 directory + SQL-content tests. |
| `tests/migration-loader-precedence.test.js` | 16 → 17 file count + 017 in expected lexical order. |
| `tests/init-rumen-project-ref.test.js` | NEW. Pins deployFunctions projectRef-required validation + dry-run + static contract assertion that init-rumen.js source contains `'--project-ref'` in deploy argv. |
| `tests/init-mnestra-hook-refresh.test.js` | NEW. 14 tests covering signature parsing, upgrade-decision logic (incl. unsigned-with-marker / unsigned-without-marker safety gate), and refreshBundledHookIfNewer flows. |

**Test results:**
- Root suite: **986 pass / 22 fail / 3 skip / 1011 total**.
- Sprint 51.5 baseline: 950 pass / 22 fail. Net change: **+36 pass, 0 new fails.**
- The remaining 22 failures are all in `tests/project-taxonomy.test.js` against the **installed** hook on Joshua's machine (still empty PROJECT_MAP). They flip green when Joshua runs `termdeck init --mnestra` post-v1.0.2 — `refreshBundledHookIfNewer()` lands the new bundled hook with the Sprint-41 PROJECT_MAP. Per T4-CODEX 20:35 ET note, this is the canonical Phase B acceptance signal.

**npm pack verification:**
```
$ npm pack --dry-run | grep -E '017_|memory-session-end'
4.6kB packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql
31.2kB packages/stack-installer/assets/hooks/memory-session-end.js
```
Both v1.0.2 deliverables ship in the root `@jhizzard/termdeck` tarball. `cd packages/stack-installer && npm pack --dry-run` continues to ship the same hook.

**Wave for orchestrator close:**
- `@jhizzard/mnestra@0.4.2` — mig 017 (canonical engram). Publish first per RELEASE.md strict order.
- `@jhizzard/termdeck@1.0.2` — bundled mig 017, audit-upgrade extension (10 probes), `--project-ref` in init-rumen, `refreshBundledHookIfNewer` in init-mnestra, bundled hook in `files` glob.
- `@jhizzard/termdeck-stack@0.6.2` — bundled hook (memory_sessions write + PROJECT_MAP defaults + version stamp + on_conflict upsert), version-aware overwrite + TermDeck-marker safety gate.
- `@jhizzard/rumen` — unchanged.
- Order: mnestra → termdeck (root) → termdeck-stack → push origin/main on engram + termdeck.
- All publishes Passkey, never `--otp`. Per RELEASE.md, run `npm run sync-rumen-functions` before `npm pack --dry-run`.

**Phase B Joshua-reinstall path (covered by the 5-part fix):**
1. `refreshBundledHookIfNewer()` lands v1-stamped bundled hook into `~/.claude/hooks/` (TermDeck marker on Joshua's existing stale-but-managed installed hook qualifies for auto-overwrite).
2. audit-upgrade applies mig 017 (idempotent on petvetbid).
3. Next `/exit` writes both `memory_items` AND `memory_sessions` — row count grows on petvetbid (Bug #2 closed).
4. `tests/project-taxonomy.test.js` flips to 22-pass post-refresh.

For `termdeck init --rumen`:
5. audit-upgrade detects function-source drift via functionSource probes; reports via `⊘ skipped`.
6. `deployFunctions` redeploys both functions with `--project-ref` (Bug C closed).
7. Next audit-upgrade reports `present` for functionSource probes (Bug D closed).

**Hand-off to orchestrator:**
- `docs/INSTALLER-PITFALLS.md` ledger entry #15 (Class M: hook swap drops a write path; possible Class N: subprocess link-state isolation, Bug C) + pre-ship checklist item #12 — orchestrator close-out per discipline.
- Version bumps + CHANGELOG entry + commits + publishes + `git push origin main` — orchestrator.

**T3 lane DONE.** Awaiting orchestrator close-out + T4-CODEX Phase B verification on a fresh install.

---

### [T4-CODEX] VERIFY 2026-05-03 20:42 ET - T3 FIX-LANDED claims independently verified pre-publish.

T4 re-ran the landed-diff audit after T3's `FIX-LANDED`.

**CONFIRMED - Codex blockers closed in source and tests.**

- `postMemorySession()` now uses `/rest/v1/memory_sessions?on_conflict=session_id`, and tests assert that URL.
- Root `package.json.files` now includes `packages/stack-installer/assets/hooks/**`.
- `npm pack --dry-run --json` with isolated npm cache now includes `packages/stack-installer/assets/hooks/memory-session-end.js`.
- Hook-refresh safety gate now preserves unsigned hooks with no TermDeck marker; tests cover both unsigned+TermDeck-marker refresh and unsigned+custom preserve.

**CONFIRMED - root suite count matches T3.** Running outside the sandbox because route tests bind `127.0.0.1`:

```sh
node --test --test-reporter=tap tests/*.test.js
```

summary:

```text
# tests 1011
# pass 986
# fail 22
# skipped 3
```

The 22 failures are still the installed-hook `tests/project-taxonomy.test.js` failures, as expected before `termdeck init --mnestra` refreshes `~/.claude/hooks/memory-session-end.js`.

**CONFIRMED - targeted source tests pass.** Excluding installed-hook taxonomy:

```sh
node --test tests/stack-installer-hook-merge.test.js tests/init-mnestra-hook-refresh.test.js tests/init-rumen-project-ref.test.js tests/audit-upgrade.test.js tests/migration-loader-precedence.test.js
```

result: `114` tests, `114` pass.

**CONFIRMED - migration 017 applies cleanly on petvetbid in rollback.**

```sh
set -a; . ~/.termdeck/secrets.env; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "begin;" \
  -f packages/server/src/setup/mnestra-migrations/017_memory_sessions_session_metadata.sql \
  -c "rollback;"
```

Result: existing columns skipped, constraint guard ran, indexes created/skipped, `ROLLBACK` completed, no errors.

**T4 disposition:** pre-publish audit is **CONFIRMED**. Awaiting orchestrator publish/install handoff for Phase B live proof:

1. install published `@jhizzard/termdeck@1.0.2` (and wave deps as needed);
2. run `termdeck init --mnestra` against petvetbid;
3. verify installed-hook taxonomy flips green;
4. trigger fresh `/exit`;
5. verify `memory_sessions` row count grows and paired `memory_items.session_summary` has `source_agent='claude'`.
