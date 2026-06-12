# T3 — flush-before-recall staleness audit (Brad R730 gap-map item 3)

**Work repo:** `~/Documents/Graciella/engram` (plus read-only reads of
`packages/mcp-bridge/src/clients/` + `src/tools/` in the termdeck repo). STATUS.md lives in
the termdeck repo (see PLANNING).

## Mission

Brad's design question, verbatim intent: when a web chat calls `memory_recall` through the
bridge, does the answer include memory captured moments earlier (panel session-end /
pre-compact / periodic-capture writes), **or is the connector a sync-cycle behind** —
read-after-write staleness between the auto-capture write path and the webhook recall path?
Answer it definitively with traced code, then prove it with a test.

## Scope

1. **Trace the write path** (FINDING #1): hook/periodic-capture POST → `mnestra serve`
   webhook → embedding generation → row insert → any indexing/queue/cache step. Identify
   every point where a write could be ACCEPTED (200 to the hook) but not yet RECALLABLE
   (async embedding job, batch insert, debounce, in-memory queue, transaction boundary).
2. **Trace the read path** (FINDING #2): bridge `memory_recall` tool → `MNESTRA_WEBHOOK_URL`
   → recall query. Note any cache layer (bridge-side or webhook-side) and its TTL.
3. **The verdict test:** an integration-style test against a local/fixture store — write via
   the webhook write endpoint, immediately recall via the recall endpoint, assert presence.
   If embeddings are generated async, the test must expose the real window (insert-to-
   recallable latency), not hide it behind a sleep.
4. **If staleness exists:** FIX-PROPOSED design (do not build without posting the design
   first) — candidate shapes: synchronous embed-on-write for small payloads; a
   `flush=true` recall option that drains pending work; recall falling back to
   keyword-match for rows whose embedding is pending. Weigh cost on the hot recall path;
   recommend ONE.
5. **If no staleness:** the deliverable is the evidence chain — the exact code points that
   make write→recallable synchronous — written so ORCH can forward it to Brad as-is.

## NOT in scope

- Rumen's 15-min insight cycle (that lag is by design — note it in the answer so Brad
  doesn't conflate the two, but don't touch it).
- Bridge auth/transport. Schema migrations (coordinate with T1 if you need a fixture column — you shouldn't).

## Acceptance

1. Both traces posted with file:line chains.
2. The verdict test, green, demonstrating the actual semantics.
3. A Brad-forwardable answer paragraph in the DONE post (no internal project name/ref).

## Lane discipline

Post shape: `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in the termdeck-repo STATUS.md
(absolute path in PLANNING.md). Stay in lane. No commits.
