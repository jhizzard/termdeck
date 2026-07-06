# Sprint 81 — Recall→Reinjection Proof (+ enforcement gates, Rumen learning loop, miser Mac port)

**ORCH:** Claude Opus 4.8 (session `0182b4bb`). **Opened:** 2026-07-05 ~16:35 ET.
**Substrate:** dual-deck **:3001 + :3002** (:3000 avoided — crashing terminals). **6 Opus-4.8 builders + 2 Codex auditors.** Zero Fable-5.

> **Numbering:** "Sprint 80" already shipped (Brad queue, v1.12.0, `docs/sprint-80-brad-queue/`). The RESTART/wrap docs call this scope "Sprint 80" — that's a label collision. **This is Sprint 81.**

---

## Mission — three pillars + one guest lane

1. **PROVE recall→reinjection (centerpiece).** Make it observable, visible, and measurable that memories are pulled into a session and change the work.
2. **Improve Rumen.** Synthesis-quality pass + a *recall-feedback learning loop* (Rumen consumes what actually got recalled/used and reinforces accordingly).
3. **Queued ULTRAPLAN §6 enforcement/hygiene.** advise→gate 2 gates · hook→`ingest_capture` + migration 030 · receipt-idiom OID sweep · `doctrine/render.js` + checks suite · web-write runbook (Josh-go-gated).
4. **miser Mac port (guest).** Brad's 4th stack service (local Claude↔Anthropic proxy: token-compression + Ollama fallback), Mac launchd/install, **standalone-first**.

## Grounding pivot — recall provenance ALREADY EXISTS (do NOT greenfield)

Migration **027** (Sprint 78) shipped `public.memory_recall_log` + RPCs `log_recall_hits`/`mark_recall_feedback`/`purge_recall_log` + denormalized `memory_items.recall_count`/`last_recalled_at` + `cited`/`dismissed`. All 5 recall surfaces already fire fire-and-forget telemetry (`recall.ts:263`, `search.ts:47`, `layered.ts:125/210`, `recall_graph.ts:126`, `webhook-server.ts`). **Two real gaps block the proof:**

- **G1:** `memory_recall_log` has no `source_type`, no `token_budget`, no per-recall grouping id.
- **G2 (the enabler):** `mcp-server/index.ts` `memory_recall` handler (`:369-395`) does **not** pass `log_session_id`/`log_source_agent` into `memoryRecall()` (`recall.ts:267-268` reads them; only the webhook path populates). → the primary MCP-stdio recall path logs `source_session_id=NULL`, `source_agent=NULL`. **This is why "which panel pulled which memory" is blank today.**

→ **We EXTEND 027, not fork it.** Building a parallel `recall_events` table would split the signal that pruning/elevation thresholds already key off.

---

## Lane map

| Lane | Deck | Repo | Model | Charter | Version |
|---|---|---|---|---|---|
| **T1** | :3001 | engram | Opus 4.8 | engram migration chain: **031** recall-log provenance + **G2 wiring fix**; **032** `recall_boost` column/RPC + bounded no-op ranking factor; **030** precompact coupled-unit; receipt OID sweep | mnestra 0.8.1→**0.9.0** |
| **T2** | :3001 | rumen | Opus 4.8 | synthesis-quality pass + **recall-feedback loop** (`reinforce.ts` + `rumen-reinforce` Edge Fn writes `recall_boost`) | rumen 0.7.0→**0.8.0** |
| **T3** | :3001 | termdeck | Opus 4.8 | **advise→gate** 2 PreToolUse deny gates + **pre-compact hook → `ingest_capture`** switch (coordinates 030 ordering) | termdeck 1.13.0→**1.14.0** / stack 1.11.0→**1.12.0** |
| **T4** | :3002 | termdeck | Opus 4.8 | **memory-proof surface** (`/api/recall-events` route + extend `renderMemoryTab`, doctrine-highlight) + `doctrine/render.js` extraction + checks starter | (same wave) |
| **T5** | :3002 | termdeck | Opus 4.8 | **cold-vs-warm demonstration harness** (empirical proof) + web-write activation runbook (Josh-go-gated, docs only unless go) | (same wave) |
| **T6** | :3002 | miser | Opus 4.8 | **miser Mac port**: launchd plist (both-arch node) + `install-mac.sh` + Ollama `:11434` + answer Brad's 3 Qs | Brad's repo (PR/fork) |
| **T7** | :3001 | termdeck | Codex | **Auditor A — DB/security/enforcement**: T1, T2, T3 | — |
| **T8** | :3002 | termdeck | Codex | **Auditor B — proof/app/miser**: T4, T5, T6 | — |

---

## Per-lane detail

### T1 — engram DB chain (SOLE owner of engram migrations)
**Kitchen constraint (Sprint 79):** exactly ONE lane authors the engram migration chain — the 028/029 CHECK-collision was caught only because two lanes touched engram migrations. **T2/T3/T4 must NOT author engram migrations.** Highest existing = 029; T1 owns 030/031/032.

**Priority order (031 first — it unblocks T4/T5):**
1. **031 — recall-log provenance extension + G2 wiring fix (CENTERPIECE).**
   - `migrations/031_recall_provenance.sql`: `ALTER TABLE memory_recall_log ADD COLUMN source_type text, ADD COLUMN token_budget int, ADD COLUMN recall_group_id uuid`. Do **not** re-CREATE `recall_count`/`last_recalled_at` (owned by 027, guard at `027:30-34`).
   - Extend `log_recall_hits(jsonb)` payload to carry `source_type` (per returned memory), `token_budget`, `recall_group_id` (one id per recall call, groups its K hit-rows into a "reinjection event"). Prefer extending the existing RPC over a new write path (avoids a 2nd RLS surface).
   - `src/recall_log.ts` (`:194-204`) + write sites (`recall.ts:263`, `search.ts:47`, `layered.ts`, `recall_graph.ts`): pass the new fields; generate one `recall_group_id` per call. **Preserve the fire-and-forget contract** (never awaited, never throws into caller, returned-set-only).
   - **G2 FIX:** thread `log_session_id`/`log_source_agent` through `mcp-server/index.ts` `memory_recall` handler (`:369-395`) into `memoryRecall()`. Without this the proof stays blank regardless of columns.
   - Honor `MNESTRA_DISABLE_RECALL_LOG=1` (`recall_log.ts:173`) in all new instrumentation so `npm test` never writes to the live store.
2. **032 — recall-usage boost (bounded, no-op default).** `migrations/032_recall_boost.sql`: `ALTER TABLE memory_items ADD COLUMN recall_boost numeric NOT NULL DEFAULT 1.0` + `set_recall_boost(jsonb)` service-role RPC + extend `memory_hybrid_search` (last rewritten in 029, `:185-208`) with a **bounded multiplicative** `recall_boost` factor that is a **strict no-op at 1.0**. This is the column T2 writes; ranking effect is inert until T2 populates it. Respect the pruning moratorium (nobody penalizes `recall_count=0` for ≥1 sprint cycle — a fresh memory simply lacks telemetry).
3. **030 — precompact coupled unit (RESTART follow-up A).** `migrations/030_precompact_rolling.sql`, in the **locked 3-step order**: (1) collapse existing `pre_compact_snapshot` dups **keep-newest-per-session** (reversible: `is_active=false` + `superseded_by`, never DELETE — mirror 028's backfill at `:141-161`); (2) *hook switch is T3's job* — see ordering; (3) create the deferred partial-unique index (exact SQL at `028:217-219`). **ORCH applies step 3 at close-out, after confirming T3's hook switch.**
4. **Receipt OID sweep.** Rewrite the 3 active text-signature receipt blocks — `026:316-319`, `027:463-466`, `028:557-560` — to the **029 OID pattern** (`029:265-292` is the correct reference). **ORCH RULING:** editing the receipt BLOCKS in place is sanctioned (receipt-only, no DDL/backfill change) — it only affects fresh-install/CI replay and makes them robust, identical in kind to the 029→0.8.1 hotfix. T7 verifies the edits touch only receipts.

**T1 scope knobs (if time-pressed):** must-haves = 031 (+G2) and 032's column/RPC. 032's `memory_hybrid_search` wire-in and 030's index can slip to ORCH-apply/follow-on; 031 is non-negotiable.

### T2 — rumen improvement + recall-feedback loop
- **THING 1 (independent, do first):** `src/synthesize.ts` + `src/confidence.ts` + `tests/synthesize.test.ts`. Recalibrate `computeConfidence` (`:579`) against the RRF band (0.01–0.3) so similarity isn't drowned by `crossProjectBonus`; down-rank near-duplicate "prior art"; enrich `buildUserPrompt` with recency/age + cross-project spread.
- **THING 2 (recall-feedback loop, depends on T1's 032 column):** new `src/reinforce.ts` + `rumen-reinforce` Edge Fn (thin-wrapper pattern like `doctrine-scan`). Window over `memory_recall_log` + denorm `recall_count`/`last_recalled_at` (read the denorm rollup — raw rows purge at 90d), compute a **smoothed EWMA/decayed reinforcement weight** per memory, write it to `memory_items.recall_boost` via T1's `set_recall_boost` RPC. **Stay doctrine-clean:** Rumen writes ONLY the reinforcement weight (like `doctrine_registry.occurrence_count`), never ranking content, never mutates existing memory rows. Build on `cited` (auto-populated), NOT `rumen_insights.acted_upon` (manual/sparse).
- Extend `tests/fixtures/mnestra-minimal.sql` with `memory_recall_log` rows + `recall_count` so the loop is offline-unit-testable.

### T3 — advise→gate enforcement + pre-compact hook switch
- **2 PreToolUse deny gates** (net-new bundled hooks under `packages/stack-installer/assets/hooks/`): `gate-publish-before-push.js`, `gate-migration-without-rls.js`. Each a small **fail-soft** node script (errors exit 0 / allow — INSTALLER-PITFALLS high-risk surface). Registry-driven via `doctrine/index.js` (`BLOCK_ALLOWED_SURFACES` already permits `preToolUse-deny`; `doctrine-cli.js cmdPromote:405` already stages the metadata). Mirror the PreCompact installer trio: add `installPreToolUseHook`/`_mergePreToolUseHookEntry`/`_isPreToolUseHookEntry` to `packages/stack-installer/src/index.js` (template at `:573/:847`), wire into main install (`~:1149`) **and** `init-mnestra.js:571 refreshBundledHookIfNewer`. `settings.hooks.PreToolUse` matcher scoped to `Bash` for the git gates. **Keep to exactly these two rules; do not generalize.**
- **Pre-compact hook → `ingest_capture` (030 step 2):** switch `packages/stack-installer/assets/hooks/memory-pre-compact.js` (`:138-181`) from raw `POST /rest/v1/memory_items` to `POST /rest/v1/rpc/ingest_capture` (`{content, source_type:'pre_compact_snapshot', source_session_id, ...}`). **Verify the hook sends a stable non-null `source_session_id`** or the rolling ON-CONFLICT never engages. Add to `init-mnestra` refresh set too.
- **Ordering (load-bearing):** T1's dup-collapse (030 step 1) can land anytime. T3's hook switch must be ready before the index exists. **ORCH creates the index last at close-out**, after confirming the hook switched. If the index existed before the switch, the current append-per-compaction hook's next insert would violate it (fail-soft → silent capture loss).

### T4 — memory-proof surface + doctrine render/checks
- **Do first (no upstream dep):** extract `renderDoctrineMarkdown()`/`buildRegistryEntry()` out of `doctrine-sync.js` (`:173-259`) into new zero-dep `doctrine/render.js`; update both importers (`doctrine-sync.js`, `doctrine-cli.js`) + `doctrine-registry*.test.js`. Add a **starter checks suite** (frontmatter-present + one-principle-shape) + frontmatter retrofit per `doctrine/SCHEMA.md`. (Full 13-check battery from ULTRAPLAN §6 line 200 is large — starter subset this sprint, note the rest.)
- **Then (gated on T1's 031):** `GET /api/recall-events` (+ per-session variant) reading extended `memory_recall_log`, modeled on `flashback/history` route (`index.js:3691`), **fail-soft empty response**. Client: **extend** `renderMemoryTab` (`app.js:2376`) — it already renders `source_type`/`project`/`similarity`/`timeAgo`; add score, **doctrine chip highlight** for `source_type='doctrine'`, `recall_group_id` grouping, and a link back to the consuming session. Cross-panel summary via existing `badge-memory-<id>`.

### T5 — cold-vs-warm demonstration harness + web-write runbook
- **Cold-vs-warm harness (the empirical proof):** a reproducible script that runs a representative task/query **recall-OFF vs recall-ON** (and/or `recall_boost` off vs on once 032 lands) and captures the delta — token-in, rows surfaced, `source_type` mix, and the observable output difference. **Must be HONEST** — no cherry-picking; T8 audits this hard (it's the credibility crux). While parked on 031/032, author the harness scaffold + fixtures + the report format.
- **Web-write activation runbook (Josh-go-gated):** deploy `inbox-promote` + secrets + cron + `TERMDECK_BRIDGE_ENABLE_PROPOSE=1` — **docs/runbook only; do NOT execute the deploy without explicit Josh go.**

### T6 — miser Mac port (guest lane, `~/Documents/Graciella/miser`)
Cloned from `github.com/bheath-atx/miser` (zero-dep Node ≥18 proxy on `127.0.0.1:20128`). Core proxy is cross-platform — **no code changes**; this is packaging:
- `miser.plist` (launchd, `~/Library/LaunchAgents/`) replacing `miser.service` (systemd). **Answer Brad Q1 (node path):** `install-mac.sh` resolves `command -v node` at install time and templates the absolute path into the plist → robust across Intel (`/usr/local/bin/node`) + Apple-Silicon (`/opt/homebrew/bin/node`).
- `install-mac.sh`: brew/node/ollama preflight + Ollama model pull (default smallest, larger optional) + write `~/.termdeck/secrets.env` + load plist. **Answer Brad Q2 (scope):** plist + model-pull + secrets + preflight; **skip `npm install`** (zero deps). **Answer Brad Q3 (stack integration):** standalone-first, defer `termdeck-stack start` wiring (Josh's call).
- **Ollama target:** Mac standard is `:11434` (not R730's `:11435`) → set `MISER_OLLAMA_URL=http://127.0.0.1:11434` in secrets/plist. (`ollama` confirmed at `/usr/local/bin/ollama`.)
- **Document (don't block on) security caveats:** miser terminates TLS locally (prompts/code transit `:20128` in plaintext; any local process can reach it); 429→Ollama silently downgrades frontier→3-14B mid-task; drop-oldest compression can break `tool_use`/`tool_result` pairing. Note these in the README; they're acceptable for a local dev proxy but must be visible.

### T7 — Codex Auditor A (DB / security / enforcement)
Adversarially reproduce, don't rubber-stamp. **T1:** 030 3-step ordering; 031 preserves fire-and-forget + honors `MNESTRA_DISABLE_RECALL_LOG` + G2 wiring actually lands non-null; 032 boost is bounded/no-op-at-1.0 + no rich-get-richer + no re-CREATE of 027's columns; receipt sweep is receipt-only (no DDL change); all new objects pass the 5 RLS gates (OID receipts from day one). **T2:** Rumen writes ONLY `recall_boost`, never ranking content/existing rows; RLS on any new object. **T3:** both gates fail-soft (errors allow) + registry-gated + don't block legit git ops; installer merge/refresh trio complete.

### T8 — Codex Auditor B (proof / app / miser)
**T4:** proof surface reads REAL `recall_events` (not mocked), fail-soft empty, doctrine chip correct. **T5:** cold-vs-warm is HONEST — reproduce it independently, confirm it's not cherry-picked (the whole "proof" hinges on this). **T6:** plist correctness on both arches, `command -v node` templating works, 429→Ollama fallback actually triggers, compression doesn't corrupt tool pairing, security caveats documented.

---

## Cross-lane ordering (critical path)

```
T1:031 (+G2)  ──unblocks──▶  T4 proof-surface route/UI
                └──────────▶  T5 cold-vs-warm (recall-on path)
T1:032 column/RPC ──────────▶  T2 THING-2 reinforce.ts (writes recall_boost)
T1:030 dup-collapse  +  T3 hook→ingest_capture  ──▶  ORCH creates precompact index (close-out, LAST)
```
Independent-first work (no upstream dep → do while parked): T2 THING-1, T3 gates, T4 render.js/checks, T5 harness scaffold + web-write runbook, T6 entire lane. **Auditors:** baseline first, re-verify on each `FIX-LANDED`/`DONE`. **ORCH shepherds parked lanes** — nudge downstream the moment its upstream posts (parked lanes do NOT auto-resume).

## ORCH rulings (locked)
1. **EXTEND 027, do not greenfield** a `recall_events` table.
2. **Receipt OID sweep edits 026/027/028 receipt blocks in place** — receipt-only, sanctioned (fresh-install/CI robustness, like the 029 hotfix).
3. **`recall_boost` defaults to 1.0 (no-op)**; T2 populates it; ranking effect inert until then; bounded multiplier + pruning moratorium.
4. **Single lane owns engram migrations (T1).**
5. **web-write deploy is Josh-go-gated** — runbook only this sprint.
6. **miser standalone-first** — no `termdeck-stack` wiring this sprint.

## Version wave (ORCH bumps at close-out — NOT in-lane)
mnestra **0.9.0** · rumen **0.8.0** · termdeck **1.14.0** · stack **1.12.0** · miser = Brad's repo (PR/fork, separate). Follow `docs/RELEASE.md` STRICT (npm publish before push, Passkey not `--otp`, stack audit-trail bump).

## Lane discipline (ALL lanes, uniform)
- **Post shape (exact):** `### [T<n>] <VERB> 2026-07-05 HH:MM ET — <gist>` where VERB ∈ FINDING · FIX-PROPOSED · FIX-LANDED · BLOCKED · CHECKPOINT · DONE (auditors add AUDIT-PASS/AUDIT-FAIL). Claude workers prefix `### ` too.
- **In-lane prohibitions:** no version bumps, no CHANGELOG edits, no commits, no `npm publish`. ORCH does all close-out.
- **Workers file-only:** local code/tests/docs. **Defer ALL live SQL / migration apply / Supabase checks to ORCH close-out** (host RAM pressure wedges MCP-calling lanes). No live MCP recall/SQL from worker lanes.
- **Auditors (T7/T8):** post `### [T<n>] CHECKPOINT` at every phase boundary AND every ≤15 min (compaction self-orientation substrate). Independent reproduction + file:line evidence.
- **Idle-poll (tolerant regex):** downstream lanes waiting on an upstream use `^(### )?\[T<n>\] (DONE|FIX-LANDED)\b` — but you WILL park; ORCH nudges you when your upstream lands.

## Runtime monitors (ORCH, background, whole sprint)
1. STATUS.md watcher — anchored `^(### )?\[T<n>\] (FIX-LANDED|BLOCKED|AUDIT-FAIL|AUDIT-PASS|DONE) 2026-`.
2. CPU-subtree delta (~12s) — WEDGE = claims-working + CPU-flat + lastActivity-frozen ≥75s; PARKED WORKER = non-auditor idle ≥180s.
3. Panel strand self-healer (~15s) — submit lone `\r` to any panel with `inputBufferLength>0` while not working.
4. Frozen-panel + host-memory alarm — Esc-recover a `Using tools`+0-CPU+frozen>90s panel; alert on load/swap spike. **Liveness = subtree-CPU delta + lastActivity, NEVER the status badge.**
