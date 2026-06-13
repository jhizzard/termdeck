# T3 — Recall telemetry + webhook hardening (Sprint 78)

**Mission:** Close the auth/bind hole on the :37778 Mnestra webhook (so anything can later ship to a second machine without becoming a remote memory-poisoning endpoint), then stand up the recall-hit telemetry log so every future pruning/elevation threshold is data-driven — without adding one millisecond to recall latency. Repo: engram (`~/Documents/Graciella/engram`), natively TypeScript (the no-TS lock is termdeck-only; TS is correct here).

---

## Scope — files you own

### ITEM ZERO (blocker — do this first, it gates everything else)
`src/webhook-server.ts` — two hardening changes:

1. **Shared-secret header check.** Read the secret from `~/.termdeck/secrets.env` (already exists on disk, 16 keys; `0600`). Add a key like `MNESTRA_WEBHOOK_SECRET` if absent — but **do not invent/commit a value**; if the key is missing the server should boot with auth effectively required and reject all ops until the operator sets it (fail-closed for network, fail-soft for process: log once, do not crash). Parse the env file with a tiny `KEY=VALUE` reader (no new dep); ignore comments/blank lines. The check runs in the **HTTP request handler** (live tree: the `createServer` request callback that calls `dispatchOp(body, deps)` near `webhook-server.ts:339-343`) — compare an incoming header (e.g. `x-mnestra-secret` or `authorization: Bearer …`) against the configured secret using a constant-time compare (`crypto.timingSafeEqual` over equal-length buffers). On mismatch/absent header → `401 {ok:false,error:'unauthorized'}` and **never reach `dispatchOp`**. Localhost-loopback requests still present the secret (no IP-based bypass — keeps the contract uniform for the Sprint 79 materializer and T2's feedback POST).
2. **Default bind 127.0.0.1 with env override.** Today `server.listen(port, …)` at `webhook-server.ts:379` passes no host → binds all interfaces (`0.0.0.0`). Change to `server.listen(port, host, …)` where `host` defaults to `'127.0.0.1'`, overridable via env (e.g. `MNESTRA_WEBHOOK_HOST` / `MNESTRA_WEBHOOK_BIND`). Document the LAN override in a code comment only (PLANNING §2 dec.6: "LAN bind override documented only when asked").

> **Anchor divergence (verify + post FINDING):** PLANNING/lane-pointer say "before `dispatchOp` at `webhook-server.ts:282-303`." In the live tree line 282 is inside `handleObservation`; `dispatchOp` is the exported fn at **line 89**, and the actual pre-dispatch seam is the HTTP request handler at **~339-343** (`const result = await dispatchOp(body, deps);`). Put the secret gate in the HTTP handler (so it covers every op uniformly), not inside `dispatchOp`. Post this as a FINDING at boot.

### Migration — next free number is `027` (025 + 026 confirmed on disk)
New file `migrations/027_recall_telemetry.sql`. Contents:

- **`memory_recall_log` table** — columns: `id` (uuid pk default gen), `memory_id` (uuid, FK→memory_items not strictly required but index it), `query_hash` (text — stable hash of the normalized query), `query_preview` (text, **gitleaks-shape redacted** — see redaction note below), `score` (double precision), `rank` (int), `surface` (text — e.g. `recall|search|index|graph|webhook`), `source_session_id` (text), `source_agent` (text), `cited` (bool default false), `created_at` (timestamptz default now()).
- **`log_recall_hits(jsonb)` RPC** — `SECURITY DEFINER`, takes a JSON array of hit rows, does ONE statement-level insert of K rows (the returned set). **FIVE GATES, all of them:**
  1. `ALTER TABLE public.memory_recall_log ENABLE ROW LEVEL SECURITY;`
  2. No `WITH CHECK (true)` / no PUBLIC-writeable policy — service-role-only table gets NO insert policy at all (service role bypasses RLS).
  3. `SET search_path = public, pg_catalog` on the function.
  4. `REVOKE EXECUTE ON FUNCTION public.log_recall_hits(jsonb) FROM PUBLIC;` then targeted `GRANT EXECUTE … TO service_role;` (no anon/authenticated grant — recall logging is a server-side path).
  5. No raw anon-key write path to the table.
- **Denorm counters on `memory_items`:** add (if absent) `recall_count int DEFAULT 0` and `last_recalled_at timestamptz`. Bump them **batched / statement-level** inside `log_recall_hits` (one `UPDATE … WHERE id = ANY(...)` per call, not per-row) so 4-panel boots can't trigger hot-row lock storms on the most-recalled kitchen rows.
- **90-day retention purge** via `pg_cron`: a scheduled job that **first rolls up** (preserve the per-`memory_id` aggregate the counters already hold) **then deletes** `memory_recall_log` rows older than 90 days. Register with `cron.schedule(...)`. The rollup-then-purge order matters: counters survive, raw rows age out.

### Fire-and-forget recall-log write points (`.catch` + counter, **NEVER `await`ed**)
Recall latency must be byte-for-byte unchanged. Each write is fired after the result is computed, not before the return; failures increment a local error counter and log at most occasionally — never throw, never block the response.

- **`src/recall.ts`** — log the **RETURNED SET ONLY** (the `hits` array after `smartRank`/`dedupByContent`/token-budget slicing, near `recall.ts:213+`), **not** the 10–40 over-fetched candidate rows from `memory_hybrid_search`. K returned hits → K log rows. Fire the `log_recall_hits` RPC after building the return object, before `return`.
- **`src/search.ts`** — same pattern on its returned set, `surface:'search'`.
- **`src/layered.ts`** — `memoryIndex`/`memoryTimeline` log with `surface:'index'`; **`memoryGet` (layered.ts:189) marks `cited=true`** for the fetched ids (a `memory_get` is the strongest "this was actually used" signal). The cited update is itself fire-and-forget.
- **`src/recall_graph.ts`** — log graph-walk returned hits, `surface:'graph'`.
- **`src/webhook-server.ts`** — surface tagging: recall/search going through the webhook stamp `surface:'webhook'` (or pass through the underlying surface) so over-the-wire recall is distinguishable in the log.

### New webhook op (HANDOFF seam with T2)
Add `case 'feedback'` to the `switch(op)` in `dispatchOp` (`webhook-server.ts:~101`): `op:'feedback' {memory_id, event:'cited'|'dismissed'}`. `event:'cited'` → mark the most-recent log row for that `memory_id` cited (or bump `cited`/`recall_count` appropriately); `event:'dismissed'` → record the negative signal. T2's flashback "clicked" route POSTs this op. **If you touch T2's file, raise HANDOFF-REQUEST; otherwise just define the op contract and let T2 wire the client POST.**

---

## Applied amendments (from ULTRAPLAN §3.2 + §3.3)

- **Webhook auth + bind is item ZERO (blocker, §3.2):** "shared-secret header from `~/.termdeck/secrets.env` checked before `dispatchOp`; default listen host 127.0.0.1 with env override. Prerequisite for shipping anything to a second machine." → Do ITEM ZERO before anything else and post FIX-LANDED on it before opening the migration.
- **Renumber migrations (blocker, §3.2):** "engram already has 025 + 026 on disk → recall-log lands at the next free number; verify on disk at lane boot." → Confirmed at boot: next free = **027**.
- **recall-log retention + batched counters (§3.2):** "90d purge after rollup + statement-level/batched counter updates (no hot-row lock storms)." → Counters bumped once per RPC call via `ANY(...)`, never per-row; purge rolls up before delete.
- **Five-gate completeness (§3.2):** "explicit ENABLE RLS on the new log tables; gitleaks-shape redaction on query_preview (recall queries contain pasted secrets more often than memory content)." → All five gates on table + RPC; `query_preview` is redacted at the write site (see redaction note).
- **Fire-and-forget, returned-set-only (§3.2 + PLANNING §4):** "recall.ts (returned set ONLY — not the 10–40 over-fetched candidates) … NEVER awaited — recall latency must be unchanged." → Every write point is `.catch`-guarded, post-compute, un-awaited.
- **Five RLS hygiene gates (PLANNING §3, global CLAUDE.md):** verify with `get_advisors` (lints 0011 search_path / 0013 RLS) post-apply — must show ZERO new lints.

**`query_preview` redaction note:** before storing, run a gitleaks-SHAPE redaction (mask anything matching common secret shapes — JWTs, AWS/Stripe/OpenAI/GitHub keys, `KEY=VALUE` secret pairs) and truncate to a short preview (e.g. ≤120 chars). Do NOT shell out to the gitleaks binary on the hot path; use a small local regex set mirroring the shapes (fail-soft: if redaction errors, store an empty preview, never the raw query). Also screen for the forbidden-strings pair (never store it — but you will never type it).

---

## Acceptance (verbatim from PLANNING §4, expanded to behavior checklist)

> "`curl` without secret → 401; with secret → ok; bind verified 127.0.0.1. MCP `memory_recall` produces exactly K log rows for K returned hits (not 10–40 candidates); recall latency unchanged (log write not awaited); supabase advisors show zero new RLS/search_path lints; memory_get marks cited; purge job registered."

- [ ] `curl http://127.0.0.1:37778/...` **without** the secret header → `401 {ok:false,error:'unauthorized'}`; `dispatchOp` never invoked (verify by side-effect: no row written, no op executed).
- [ ] Same `curl` **with** the correct secret header → normal `200`/op result.
- [ ] Bind verified: `lsof -nP -iTCP:37778 -sTCP:LISTEN` (or `ss`/`netstat`) shows `127.0.0.1:37778`, **not** `0.0.0.0:37778` / `*:37778`. Confirm env override flips it.
- [ ] A real `memory_recall` returning K hits writes **exactly K** rows to `memory_recall_log` — not the over-fetched candidate count (10–40). Verify with a query whose candidate pool >> returned set.
- [ ] Recall latency unchanged: the `log_recall_hits` call is not awaited on the response path (assert by code-read AND by timing — recall time with logging on ≈ logging off within noise).
- [ ] `get_advisors` (Supabase) post-apply shows **zero new** 0011 (mutable search_path) and 0013 (RLS disabled) lints attributable to migration 027's objects.
- [ ] `memory_get` (layered.ts) flips `cited=true` on the fetched rows' most-recent log entries.
- [ ] The pg_cron purge job is registered (verify via `cron.job` / `list` of scheduled jobs) and rolls up before deleting >90d rows.
- [ ] FIVE GATES on table + RPC verified by SQL: RLS enabled (`pg_tables.rowsecurity`), no `WITH CHECK (true)`/PUBLIC policy, `search_path` set on the function (`proconfig`), `EXECUTE` revoked from PUBLIC and granted only to `service_role`, no anon write path.
- [ ] Webhook `op:'feedback'` accepts `{memory_id, event:'cited'|'dismissed'}` and records the signal; malformed payload → 400, never a throw.
- [ ] Fail-soft proven: kill Supabase/RPC availability and confirm recall still returns its hits (logging swallows the error, recall unaffected).

---

## Anchors (briefs-are-hypotheses — re-verify at boot, post divergence as FINDING)

- `~/Documents/Graciella/engram/migrations/` — **025_source_agent_web_surfaces.sql + 026_memory_inbox.sql are the highest on disk → next free is 027.** Migration-number caveat per PLANNING §3/§6: land at 027, re-confirm at boot (`ls migrations/`).
- `src/webhook-server.ts:89` — `dispatchOp(payload, deps)` (the op switch; add `case 'feedback'` here ~line 101).
- `src/webhook-server.ts:~339-343` — HTTP request handler, `const result = await dispatchOp(body, deps);` → **secret check goes HERE, pre-dispatch** (NOT at the stale `:282-303` anchor, which is inside `handleObservation`). Post FINDING on this divergence.
- `src/webhook-server.ts:379` — `server.listen(port, () => …)` binds all interfaces → add the `host` arg defaulting to `127.0.0.1`.
- `src/recall.ts:~213` — return set built after `smartRank(deduped)` + token-budget slice; log the `hits` array here, not the hybrid-search candidate pool.
- `src/search.ts` — analogous returned-set point.
- `src/layered.ts:189` — `memoryGet` (cited=true marker); `memoryIndex`/`memoryTimeline` earlier in file (index/timeline surfaces).
- `src/recall_graph.ts` — graph-walk returned hits.
- `~/.termdeck/secrets.env` — exists (`0600`, 16 keys); read the webhook secret from here.

If any anchor has moved, **post `### [T3] FINDING …` to STATUS.md** and continue against the live tree — never edit blind to a stale line number.

---

## Lane discipline

- **Post shape (uniform):** `### [T3] VERB 2026-MM-DD HH:MM ET — <gist>` where VERB ∈ FINDING / FIX-PROPOSED / FIX-LANDED / HANDOFF-REQUEST / HANDOFF-ACK / DONE. Use real local ET time (`date`).
- **Tolerant idle-poll regex** (for any cross-lane wait): `^(### )?\[T<n>\] DONE\b`.
- **HANDOFF seam:** the one known cross-boundary is `op:'feedback'` ↔ T2's flashback "clicked" route. Define the op contract on your side; if you need to touch T2's client file to wire the POST, post `### [T3] HANDOFF-REQUEST …` and wait for T2's `HANDOFF-ACK` before editing it. Default: you own the server op; T2 owns the client POST.
- **PERIPHERY WATCH:** if you edit any file another lane owns, post a FINDING immediately. Your lane is engram-only; T1/T2 are termdeck — there should be no overlap except the feedback seam.
- **In-lane:** post to STATUS.md only. **No version bumps, no CHANGELOG edits, no commits** — ORCH owns all close-out (including the migration *apply*, which Josh auth's). You author `027_recall_telemetry.sql`; you do **not** apply it to the live project from in-lane unless ORCH explicitly directs a dry-run.
- **Fail-soft is release-blocking:** the secret check, recall-log writes, and counter bumps must never throw into the recall/HTTP path. Errors log + exit 0 / swallow.

---

## Out of scope / do NOT touch

- **Capture-side dedup/reinforcement, `content_hash`, `ingest_capture` RPC, provenance/MCP inputSchema expansion** — that is **Sprint 79 T1**. You add the *recall-log* objects only; do NOT renumber for or pre-build the provenance migration.
- **`remember.ts` dedup rewrite, `summarize.ts` importance floor, `granularity.ts`, the `recall.ts` TYPE_RANK recipe downweight** — Sprint 79. Leave `recall.ts` ranking untouched; you only ADD a fire-and-forget log call.
- **The `'doctrine' ×1.5` Mnestra boost migration** — Sprint 79 T3 / AMEND-14. Not this sprint.
- **T1's `doctrine/registry.jsonl` / `doctrine/index.js`** and **T2's `packages/server/src/advisor/*`** — termdeck, other lanes. You only define the webhook `op:'feedback'` contract that T2 calls.
- **Supabase nightly sync of advisory/recall data to any external view** — out of scope (offline-complete per §3.3 A10); the recall log lives in the engram/Mnestra Supabase project, written via the service-role RPC only.
- **Editing any shipped migration (005–026)** — never. Land at 027.
- **The forbidden-strings pair** — never write it anywhere (code, comment, SQL, STATUS.md). The `query_preview` redaction must also screen for it as a backstop.
