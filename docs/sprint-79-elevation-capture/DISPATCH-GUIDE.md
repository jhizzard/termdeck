# Sprint 79 — DISPATCH GUIDE (Rumen elevation + capture gates + web-write activation)

**Authored 2026-06-13 evening by the Sprint 78 close-out orchestrator, from a 5-agent re-grounding of `ULTRAPLAN-2026-06-12.md` §4/§5 against the LIVE post-Sprint-78 tree.** The ULTRAPLAN was written 2026-06-12, *before* Sprint 78 shipped — so its file:line anchors and migration numbers have drifted. **This guide is the corrected, dispatch-ready overlay. Read it WITH the ULTRAPLAN §4 lane table, not instead of it.** Every anchor below was verified on disk 2026-06-13/14; per the briefs-are-hypotheses doctrine, lanes STILL re-verify at boot and post divergences as FINDING.

---

## 0. Boot order for the dispatching orchestrator
1. `memory_recall(project="termdeck", query="Sprint 79 dispatch elevation capture gates doctrine-scan migration 028 004 web-chat promotion")`
2. `memory_recall(query="recent decisions and bugs")`
3. Read `~/.claude/CLAUDE.md` (esp. § inject mandate, § 3+1+1, § RLS hygiene) + the termdeck `CLAUDE.md`
4. Read `docs/RESTART-PROMPT-2026-06-13-evening.md` (state) + **this file** (the dispatch overlay)
5. Read `docs/sprint-78-memory-doctrine-loop/ULTRAPLAN-2026-06-12.md` §4 Sprint 79 table + §5 decisions + §1 loop diagram
6. Author `docs/sprint-79-elevation-capture/PLANNING.md` + 4 lane briefs (T1–T4) from §4 + the corrections here, then dispatch.

---

## 1. State at handoff — what is LIVE that Sprint 79 consumes (do NOT re-scope)
Sprint 78 SHIPPED + the webhook gate was ACTIVATED this session. The elevation loop's *first half* is in the tree:
- **Doctrine registry** — `doctrine/registry.jsonl` (17 entries, all `status:'active'`) + `doctrine/index.js` exporting `loadDoctrine / validateEntry / screenEntries / recordGateEvent / shouldNotify` + `doctrine/SCHEMA.md`. `doctrine_events` table wired in `database.js` (`setDb`). **T3 writes INTO this registry** — entries must pass `validateEntry`, and T3 should **reuse `screenEntries`** (the gitleaks shell-out) for AMEND-2 scrub rather than rolling a new one.
- **Recall telemetry (engram migration 027, applied)** — `memory_recall_log` (live, accumulating; ~28 rows) + `log_recall_hits(jsonb)` fire-and-forget write points + `recall_count`/`last_recalled_at` denorm on `memory_items` + `record_recall_feedback` + `purge_recall_log` (90d pg_cron). **T1 READS this for the elevation usage-signal; it does NOT build telemetry.** (ULTRAPLAN §2 Gap-2 "no usage log exists" is now FALSE.)
- **Webhook hardening (Sprint 78 T3)** — `:37778` is bound `127.0.0.1` + fail-closed on `MNESTRA_WEBHOOK_SECRET` (`x-mnestra-secret`/Bearer). The bridge + in-app caller send the secret (commits `74e1fe9` + `d5436cf`). The `op:'feedback'` `{memory_id,event:'cited'|'dismissed'}` handler exists. **Any webhook reuse rides this auth — do NOT re-add it.**
- **Advisor MVP** (`packages/server/src/advisor/*` + `advisory_events`) — **Sprint 79 does NOT touch it.** The advise→gate enforcement tiers (T-LOOP/T-LANE/T-GATE, PreToolUse deny) are explicitly **Sprint 80** (§6).
- **Shared primitives:** `packages/server/src/pty-submit.js` (server-sequenced submit; `{submit:true}`), `packages/server/src/sprint-frontmatter.js` (extend, never re-author).
- **The inbox→canonical PROMOTION PASS already exists** — `rumen/src/promote.ts` (v0.6.0, Sprint 76) + the bundled `inbox-promote` Edge Function. The web-write side is **deploy/wire/activate, NOT greenfield code** (see §4).
- **Contract gotcha (Sprint 78 T4 catch):** `doctrine.shouldNotify(...)` returns `{notify}` **NOT** `{ok}`. Any Sprint 79 consumer suppresses on `verdict.notify === false`.

---

## 2. ⚠ GROUND-TRUTH DELTAS — corrections to ULTRAPLAN §4/§5 (verified on disk)
**These supersede the ULTRAPLAN where they conflict. A brief copied verbatim from §4 will be wrong on every line below.**

| ULTRAPLAN §4/§5 says | TRUTH (verified 2026-06-13/14) |
|---|---|
| engram "025/026 taken, next free" | **engram next-free = `028`** (027_recall_telemetry shipped). T1 capture-gates = **028**. T3 "doctrine ×1.5 boost" (AMEND-14) = **029**. **T1↔T3 must HANDOFF the 028/029 ordering** so they don't both grab 028. |
| rumen "Migration 003: doctrine_registry" | **rumen next-free = `004`** (`003_pg_cron_inbox_promote.sql` shipped Sprint 76). T2 doctrine_registry+doctrine_jobs = **004**. |
| T1 adds `content_hash GENERATED ALWAYS AS (md5(content)) STORED` (new) | **`content_hash` ALREADY EXISTS LIVE** on `memory_items` (generated, `md5(content)`) — applied out-of-band, NOT in any on-disk migration. T1 must use `ADD COLUMN IF NOT EXISTS` or SKIP it — re-declaring a generated column ERRORS. **Only `reinforcement_count`, `sprint_ref`, `rule_ref` are genuinely new.** (This corrects RESTART-PROMPT-2026-06-13-evening.md:35, which wrongly lists content_hash as new.) |
| Gap-2 "no recall/usage log table exists" | FALSE — 027 shipped it; it's accumulating. |
| Gap-3 "nothing writes insights back to memory_items"; store has no inbox→canonical path | The narrow rumen_INSIGHTS claim still holds (`surface.ts` never writes memory_items), but the **inbox→canonical promotion path EXISTS** (`promote.ts:616` writes memory_items). The §4 framing of the promotion pass as unbuilt Sprint 79 work is wrong. |
| §5 open-decision 1c "approve recall-log retention window" | Already DECIDED + shipped: 027 hardcodes 90d purge + pg_cron. Moot. |
| `remember.ts:89-133` / `100-133` dedup anchors | File is 151 lines now: thresholds `27-28`, match `89-94`, clobber band `100-134`, silent-disable-on-RPC-error `96-98` (still holds). Re-anchor ~88-134. |
| `recall.ts` TYPE_RANK | Lines `37-46`, consumed in `smartRank` line `74` (file 267 lines). The granularity='recipe' downweight tiebreaker lands in `smartRank` after the TYPE_RANK/importance compare. |
| MCP `memory_remember` "cannot set metadata/source_agent/sprint_ref (mcp-server/index.ts:214-242)" | The MCP **schema** still can't (tool block `216-267`, inputSchema `224-243`), BUT the underlying `RememberInput` type ALREADY carries `metadata`+`source_agent` (`types.ts:81,93`, Sprint 74). So T1's expansion is **thread-through** (metadata, source_agent) **+ net-new** (sprint_ref, rule_ref, supersedes, force). |
| MNESTRA-COMPATIBILITY.md:68 "confirms nothing writes memory_items" | Rewritten by Sprint 76 — line 68 now enumerates 3 write surfaces. README false-flow-back claim is now `README.md:188`; the init-rumen one is `packages/cli/src/init-rumen.js:965` (a **termdeck** file → cross-repo edit, T3/HANDOFF not pure-rumen T2). |
| branch `sprint-78-doctrine-loop` (session snapshot) | STALE — live tree is on `main` (Sprint 78 merged via PR #26, HEAD ~`d5436cf`). `git checkout main && git pull`, branch fresh `sprint-79-elevation-capture`. |

---

## 3. The four lanes (re-grounded). Keep the disjoint 3+1+1 shape.

### T1 — Capture gates (engram, `~/Documents/Graciella/engram`)
- **Migration `028_capture_gates.sql`** (verified next-free). Adds to `memory_items` (all `ADD COLUMN IF NOT EXISTS`): `reinforcement_count int DEFAULT 1`, `sprint_ref`, `rule_ref` — **and `content_hash` ONLY IF the live generated column is somehow absent at boot (it exists live; verify first).** **MUST NOT re-add `recall_count`/`last_recalled_at` (owned by 027).** Partial-unique-active index on `content_hash` (no existing unique index on memory_items — clean). 56-group dup backfill collapse (keep-oldest, sum reinforcement_count, supersede — reversible, never DELETE). `ingest_capture(jsonb)` RPC both ON-CONFLICT paths — **five RLS gates, copy 027's hard-failing receipt DO-block pattern (`027:476-487`).**
- **Dedup rewrite** `remember.ts` ~88-134: merge-not-clobber metadata, `reinforcement_count++`, `reinforcements[]` append (cap 10), keep-canonical unless `refresh:true`, cross-project second pass for kitchen rows. Preserve the `'inserted'|'updated'|'skipped'` `RememberResult` union (`types.ts:96`).
- **MCP expansion** (`mcp-server/index.ts:224-243` schema + `245-252` handler): thread `metadata`+`source_agent` (exist on RememberInput) + net-new `sprint_ref/rule_ref/supersedes/force` on RememberInput + memoryRemember + **webhook ingest parity** (`webhook-server.ts`). `rule_ref` auto-creates an `amends-rule` `memory_link` edge (`relationships.ts`).
- **New files:** `src/granularity.ts` (classifier) + the mandatory same-sprint consumer = `recall.ts` TYPE_RANK downweight (`smartRank:74`). `mnestra_capture_health` view (`security_invoker=true`). `summarize.ts` importance floor (default 'minor'=no-op per §5).
- **T1 READS** the live `memory_recall_log` + `recall_count` denorm for the elevation usage-signal — does NOT build telemetry.
- **Acceptance:** verified via supabase advisors (0011/0013 clean on 028) + live-store dry-runs, NOT termdeck `npm test`.

### T2 — doctrine-scan (rumen, `~/Documents/Graciella/rumen`)
- **Migration `004_doctrine_registry.sql`** (NOT 003): `doctrine_registry` (status enum candidate|drafted|proposed|ratified|rejected|superseded, cluster_member_ids, centroid vector(1536), occurrence_count, projects[], member content-hash snapshot) + `doctrine_jobs` heartbeat (reuse `rumen_jobs` shape, `migrations/001:15-26`). **Five RLS gates on both.**
- **Edge Function `doctrine-scan`** — drop `packages/server/src/setup/rumen/functions/doctrine-scan/{index.ts,tsconfig.json}` into the termdeck bundle; it's **auto-enumerated** by `listRumenFunctions()` (no FUNCTIONS-list edit). **BUT the pg_cron SCHEDULE is NOT auto-wired** — `init-rumen.js:793-796 SCHEDULE_MIGRATIONS` hardcodes only 002/003 matchers; a doctrine-scan cron migration needs a NEW matcher entry (**cross-lane seam with T3/init-rumen.js owner**). Schedule 03:30 UTC (after graph-inference 03:00). **Version-pin:** if it imports `npm:@jhizzard/rumen`, add to `FUNCTIONS_WITH_VERSION_PLACEHOLDER` + use `__RUMEN_VERSION__` (like rumen-tick), do NOT hardcode a stale literal.
- Density clustering (mean pairwise ≥0.85), N≥3 + (≥2 projects OR ≥21d), centroid dedup; Haiku synthesis (cap 10/scan), trigger_hints **shadow-mode only**, no-key fail-soft parks `status='candidate'`.
- **LANE BOUNDARY (hard):** `CONTRIBUTING.md:7` ground-rule-1 (Sprint 76) REJECTS any new non-`rumen_*` write path in a rumen PR. T2 stays **DB-detect-only inside `rumen_*` tables** — it must NOT add a `memory_items` writer. The doctrine flow-back INSERT is **T3's** job (termdeck), not T2's.
- Fix `README.md:188` false flow-back claim (rumen repo). The `init-rumen.js:965` fix is a **termdeck** edit → HANDOFF/T3.

### T3 — Materialize + ratify (termdeck)
- `packages/server/src/doctrine-sync.js` (NEW, CJS, default-OFF behind `TERMDECK_DOCTRINE_REPO`): hourly unref'd timer, operates in a `git worktree` under `~/.termdeck/doctrine-work/`, scrub via **`doctrine/index.js::screenEntries`** (reuse, not new), renders `docs/doctrine/D-<seq>-<slug>.md`, updates `doctrine/registry.jsonl`, `gh pr create`.
- **⚠ STATUS-ENUM BRIDGE (unaddressed by ULTRAPLAN — make it a boot FINDING):** repo `doctrine/registry.jsonl` STATUSES = `['active','proposed','deprecated']` (`doctrine/index.js:64`, validated `:172`); the rumen `doctrine_registry` staging table uses `candidate|drafted|proposed|ratified|rejected|superseded`. T3's `ratify` materializing a rumen `'ratified'` row INTO registry.jsonl must write repo-status **`'active'`** (or `'proposed'` pre-merge), NOT `'ratified'` — OR extend the repo STATUSES enum + SCHEMA.md. Decide explicitly.
- `termdeck doctrine list|ratify|reject|promote <id>` subcommand → register in `packages/cli/src/index.js:59,348` (KNOWN_SUBCOMMANDS/SKIP_SUBCOMMANDS). `ratify` verifies the PR merged via `gh`, flips status, **direct-INSERT flow-back** `memory_items` row `source_type='doctrine'` + explicit `stripPrivate` (engram `src/privacy.ts`) + `memory_link 'elevated_to'` edges.
- **AMEND-14 engram migration `029`** ("doctrine ×1.5 recall boost") — **T1↔T3 HANDOFF: T1 takes 028, T3 takes 029.**
- **Tests** → `packages/server/tests/doctrine-registry-shape.test.js` (NEW). The npm glob is `packages/*/tests/**` — **root `tests/` silently never runs** (Sprint 78 ORCH ruling §8.1). Sprint 78's `doctrine-registry.test.js`/`doctrine-throttle.test.js` must keep passing.
- **DO-NOT-re-author:** `sprint-frontmatter.js`, the `memory_propose` tool (`packages/mcp-bridge/src/tools/propose.js`, flag OFF) — T3 does not touch the bridge.

### T4 — Codex auditor (termdeck; read engram, rumen)
- Reproduce T2 clustering independently (read-only SQL); attempt the scrub-bypass leak (craft a drafted row with a denylisted string via local-only config — string never committed); verify keep-canonical (write a verbose restatement of a known kitchen row → `reinforcement_count++`, NOT a new row); verify default-OFF poller + preflight refusals; **five-gate SQL on every new object across BOTH repos (engram 028, rumen 004)**; verify the status-enum bridge maps correctly. CHECKPOINT every 15 min + phase boundary; FINAL-VERDICT GREEN/RED with command-output evidence per claim.
- **Optional extra target:** adversarially verify a `propose→inbox→promote→recall` round-trip on a branch (the web-write activation, §4) if Josh wants it audited.

---

## 4. The web-write fabric (Josh's caveat) — SCOPING DECISION + activation runbook
**Recommendation (do this): keep the four-lane shape UNCHANGED. The promotion pass is already built (`rumen/src/promote.ts` v0.6.0, Sprint 76) — it is NOT a 5th lane and NOT greenfield code.** What remains is **deploy + wire + activate**, which is sequential infra spanning engram-applied + rumen-deployed + termdeck-bridge-flag — not parallelizable lane work, and it flips a **write surface on a public bridge**. So fold it into the **ORCH close-out as a gated runbook**, on Josh's explicit go (per the Sprint 76 "PROD activation = Josh decides at close" rule). If Josh wants it audited, hand the round-trip to T4-Codex.

**Activation runbook (all 5 steps currently undone):**
1. **Deploy** `inbox-promote` (`supabase functions deploy inbox-promote`; bundled at `packages/server/src/setup/rumen/functions/inbox-promote/`, pins `rumen@0.6.0`; not in `list_edge_functions` yet).
2. **Secrets** for it: `DATABASE_URL` (Shared Pooler IPv4) + `OPENAI_API_KEY` (dedup embeddings) + `ANTHROPIC_API_KEY` (kitchen-vs-recipe Haiku). **Without BOTH model keys it 503s and claims zero rows.**
3. **Cron**: apply `rumen/migrations/003_pg_cron_inbox_promote.sql` (reuses the `rumen_service_role_key` Vault secret rumen-tick uses; no inbox-promote cron exists yet).
4. **Flip the dark-gate**: `TERMDECK_BRIDGE_ENABLE_PROPOSE=1` in the bridge env (supervisor unit / secrets.env) + per-client identity map (`~/.termdeck/bridge-propose.json` or `TERMDECK_BRIDGE_PROPOSE_MAP`: client_id → `claude-web|chatgpt-web|grok-web|gemini-web`).
5. **Smoke**: from a connected webchat, propose → row lands in `memory_inbox` (0 now) → ≤15 min → `status='promoted'`, `promoted_memory_id` set, recallable.

**Gemini-web** (the only surface with no MCP connector — needs the Enterprise seat): two separate enablement steps. (a) **READ** = the Gemini Enterprise custom-MCP connector over the bridge's **static-OAuth** path (Sprint 75; full runbook `packages/mcp-bridge/docs/connect-gemini-enterprise.md` — seed `TERMDECK_BRIDGE_STATIC_CLIENT_{ID,SECRET,REDIRECT_URIS}`, `*_ALLOW_NO_PKCE=1` if needed, scoped to that one confidential client). (b) **WRITE-via-quarantine** = the propose-map entry + the §4-step-4 dark-gate flip. **Seat timing:** buy month-to-month at THIS validation step (not before); $0 fallback = Drive-digest/Gem-knowledge push.

**Installer wiring gap (Brad / external users — Sprint 79 or 80 line item):** on a fresh `init --rumen`, `inbox-promote` *deploys* (directory-scanned) but is **never scheduled** — the bundled rumen migrations dir has only 001/002/003_graph_inference, and `SCHEDULE_MIGRATIONS` matches only 002/003. To wire it: copy the inbox-promote cron migration into the installer bundle (renumber to avoid the 003 collision) + add a `SCHEDULE_MIGRATIONS` matcher. Decide in-scope vs deferred.

---

## 5. §5 LOCKED decisions (restate in PLANNING; workers do not re-litigate)
Haiku doctrine-scan cap **10 calls/scan**; granularity Haiku tier-2 ships **OFF** env-gated; recall-log **90d** retention (shipped); advisory limits 5/session·1/10min·once-per-(session,dedup_key)·24h per-entry·3-injected/lane/hr→ORCH overflow·quarantine 3-unheeded-with-recurrence+7d·≤120 tok·5-min queue TTL; doctrine-PR ratify = **ORCH auto-ratifies when shadow-trigger evidence is clean, Josh spot-checks after**; advise→gate PreToolUse deny = **Sprint 80** (2 gates: publish-before-push, migration-without-RLS); summarize floor = **no-op now**; **pruning moratorium ≥1 full sprint cycle** before acting on `recall_count=0`; webhook **127.0.0.1-only**.

---

## 6. Dispatch mechanics (cold-boot checklist)
1. **SUBSTRATE FIRST** (global CLAUDE.md §PREFLIGHT): `curl -s http://127.0.0.1:3000/api/sessions` — **confirm the actual port** (Sprint 78 ran on **:3001** because :3000 was the daily-driver; STATUS [ORCH] 19:05). Need **4 panels at the termdeck cwd**; map T1–T4 by `meta.createdAt`. **Never substitute Agent-tool dispatch for worker panels.**
2. **Two-stage inject** (single-stage BANNED): paste-pass-1 all 4 (`\x1b[200~<brief>\x1b[201~`, ~250ms gaps, NO trailing `\r`) → 400ms settle → submit-pass-2 (lone `\r`, ~250ms gaps). Verify each `status:'thinking'` within 8s; `/poke {methods:['cr-flood']}` any idle panel. **NEW:** for single-panel relays the v1.10.1 `POST /input {submit:true}` (production path via `pty-submit.js`) collapses the dance server-side — prefer it; the 4-panel boot still uses paste-all/settle/submit-all.
3. **Post shape (all lanes):** `### [T<n>] VERB 2026-MM-DD HH:MM ET — gist`, VERB ∈ FINDING|FIX-PROPOSED|FIX-LANDED|AUDIT-PASS|AUDIT-FAIL|CHECKPOINT|HANDOFF-REQUEST|HANDOFF-ACK|DONE; auditor `[T4-CODEX]`; tolerant idle-poll `^(### )?\[T<n>\] DONE\b`; auditor CHECKPOINT every 15 min + phase boundary; PERIPHERY WATCH on cross-lane file touches.
4. **Known cross-lane seams → HANDOFF-REQUEST/ACK:** (a) **T1↔T3 engram migration numbering 028/029**; (b) **T2↔T3/init-rumen.js** SCHEDULE_MIGRATIONS matcher for doctrine-scan cron + the init-rumen.js:965 fix; (c) **T3 status-enum bridge** (rumen ratified → repo active).
5. **BRIEFS ARE HYPOTHESES (doubly true post-78):** every ULTRAPLAN anchor predates Sprint 78. First lane action = re-verify anchors, post divergences as FINDING. (Sprint 78 STATUS shows every worker did this and several found drift.)
6. **Close-out (ORCH-centralized):** after FINAL-VERDICT, ORCH reads full STATUS, runs Extract→Relate→Synthesize→Surface, writes ~5–8 KITCHEN memories itself. Then: version bumps per RELEASE.md (**npm publish BEFORE push; Passkey not --otp; Josh runs publish, ORCH runs commit+push**), CHANGELOG, BACKLOG, PLANNING Resolution, RESTART-PROMPT, gitleaks, **migration apply Josh-auth** (engram 028/029 + rumen 004), `get_advisors` (0011/0013) on the new objects, commit, hand-off, push, tag.
7. **🔁 BATCH THE 1.11.1 / stack 1.9.1 SUPERVISE PATCH:** the `start_bridge` secret-delivery fix is on termdeck `main` (`d5436cf`) **unversioned**; the vendored copy reaches Brad only on the next publish. Bump **1.11.1 / stack 1.9.1** in Sprint 79's publish so it ships. Not urgent (nothing breaks for external users until they activate the gate) but **must not be silently dropped.**
8. **Hygiene before branching:** termdeck → `checkout main && pull`, branch fresh. **engram working tree is DIRTY** (untracked `024_email_assistant_recall.sql` + `docs/sprint-privacy-tags/`) — land the small hygiene commit or stash-aware-branch so T1's 028 doesn't tangle with the untracked 024.

---

## 7. Carry-forward (non-blocking)
- **ChatGPT connector** (Josh action): disconnect+re-add in ChatGPT → Apps & Connectors → `https://bridge.joshuaizzard.dev/mcp` (stale OAuth grant → dead tunnel URL fails the RFC 8707 audience gate). DIFFERENT from the webhook-secret gate activated this session. Relevant if Sprint 79 assumes connector health for the webchat fabric.
- Sprint 80 (ULTRAPLAN §6): advise→gate enforcement tiers, doctrine→render.js/checks suite, frontmatter retrofit.
