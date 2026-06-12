# T3 — Rumen promotion pass (memory_inbox → canonical, or rejected with reasons)

**Work repo:** `~/Documents/Graciella/rumen`. STATUS.md lives in the termdeck repo — post to
the absolute path in PLANNING.md § Lane discipline.

## Boot context

Rumen is the async learning loop over Mnestra-compatible pgvector stores: **Extract → Relate
→ Synthesize → Surface** (`src/extract.ts` / `relate.ts` / `synthesize.ts` / `surface.ts`,
orchestrated by `runRumenJob` in `src/index.ts`), raw `pg` via `src/db.ts`, Claude Haiku for
synthesis, deployed as Supabase Edge Functions (`supabase/functions/rumen-tick`,
`graph-inference`). Non-destructive doctrine: v0.x only INSERTs into its own tables.

Sprint 76 gives Rumen its second job: the **promotion pass**. Web chats write proposals into
`memory_inbox` (T1's table, quarantined, invisible to recall); Rumen is the customs check
that promotes the worthy ones into `memory_items` and rejects the rest with an audit trail.
This is a deliberate, narrow extension of the non-destructive doctrine: the pass INSERTs into
`memory_items` (canonical-path semantics below) and UPDATEs ONLY `memory_inbox` status fields
on rows it has claimed — it still never modifies or deletes existing memory rows. Update the
doctrine comments accordingly; do not silently violate them.

**Async-promotion latency is the accepted design** (PLANNING § trade-off): proposals become
recallable on the pass's cadence, not instantly. Do not add a synchronous fast path.

## Read first

- T1's brief (`T1-inbox-schema.md`) — the schema you consume: `memory_inbox(id, created_at,
  source_agent, project_hint, text, status pending/promoted/rejected, promoted_memory_id,
  rejection_reason, metadata jsonb)`, partial index on pending, status-consistency CHECKs.
  Build against the brief's contract now; verify against T1's FIX-LANDED post (the table
  won't exist on the daily driver during the sprint — your tests run on fixtures).
- engram `src/remember.ts` — the canonical-write semantics you must reproduce (read it in the
  engram repo, read-only): embed with **text-embedding-3-large @ dimensions:1536**, dedup via
  the `match_memories` RPC — **>0.95 similarity ⇒ skip (content already canonical), >0.88 ⇒
  in-place update of the near-dup, else insert** content+embedding in one row.
- `~/.claude/CLAUDE.md` § "Kitchen vs recipes" — the classification gate's spec, verbatim.
- `docs/MNESTRA-COMPATIBILITY.md` + `tests/fixtures/` (the mnestra-minimal fixture) — your
  fixture story extends these.

## Scope

### 1. Design FINDING first

Post the pass's shape before coding: claim strategy, gate order, batch/caps numbers, where it
hangs off `rumen-tick`. Cheap to review, expensive to rework.

### 2. The promotion pass (`src/promote.ts` + wiring)

**Claim (idempotent + concurrency-safe):** select a batch of pending rows with
`update memory_inbox set metadata = jsonb_set(...attempt counter/claim stamp...) where id in
(select id from memory_inbox where status = 'pending' order by created_at limit $batch
for update skip locked) returning *` — one transaction per claim. Two concurrent passes
(overlapping ticks, edge-fn retry) must never double-promote a row; re-running the pass over
an already-processed inbox is a no-op. Batch default **25 rows/run** (env-tunable).

**Gates, in order (cheap → expensive); first failure rejects with that reason:**

1. **Caps re-check** (`oversize`): text ≤ 4000 chars, metadata sane — T1's RPC and T2's
   bridge already enforce this; re-check because the DB is the only gate that can't be
   bypassed by a future writer. Belt-and-suspenders, not redundancy theater.
2. **Source whitelist re-check** (`invalid-source-agent`): the four `*-web` values only.
3. **Per-connector rate cap** (`rate-capped`): max **N promotions per source_agent per
   24 h** (default 50, env-tunable) — the durable backstop behind T2's in-memory bridge
   buckets. Rows over the cap stay PENDING (not rejected) for a later pass — being patient
   is not a crime.
4. **Dedup vs canonical** (`duplicate`): embed the text (3-large@1536 — extend/reuse the
   embedding path in `relate.ts`; keyword-only fallback is NOT acceptable for this gate: if
   `OPENAI_API_KEY` is unavailable the row stays pending, fail-soft) and run the same
   `match_memories` thresholds as remember.ts: >0.95 ⇒ reject `duplicate` and stamp the
   matched id in metadata; 0.88–0.95 ⇒ DO NOT update the near-dup (that would mutate
   canonical from web-originated content — tighter than remember.ts, deliberately): reject
   as `near-duplicate` with the matched id recorded for a human/UI to merge later.
5. **Kitchen-vs-recipe** (`recipe-level`): Haiku classification via the existing
   `synthesize.ts` client pattern. Prompt encodes the four concrete tests from
   `~/.claude/CLAUDE.md` § Kitchen vs recipes (true-after-rewrite? / transfers-across-
   projects? / greppable-in-git-log? / names file:line-version?). Recipe ⇒ reject. Require a
   structured verdict (JSON with verdict + one-line rationale → stored in metadata);
   unparseable/errored LLM response ⇒ row stays pending (fail-soft, NOT auto-promote —
   the gate fails closed).

**Promote (all gates passed):** INSERT into `memory_items` with canonical-path semantics —
content = proposal text, embedding from gate 4 (no second embed call), `source_type` `'fact'`
(default; Haiku verdict may suggest `'decision'`/`'preference'` — accept only known
SourceType values), `project` = project_hint when present (else `'global'`), **`source_agent`
preserved from the inbox row** (the `*-web` value — provenance is the point; never rewrite to
a CLI value), `metadata` carrying provenance: `{ inbox_id, promoted_by: 'rumen-promotion',
promoted_at, connector metadata passthrough, kitchen_rationale }`. Then stamp the inbox row
`status='promoted'`, `promoted_memory_id=<new id>` in the same transaction as the insert
(atomic: a crash never yields a promoted memory with a still-pending inbox row, nor the
reverse).

**Reject:** `status='rejected'`, `rejection_reason` = the gate tag (stable vocabulary above),
structured detail in metadata. Never delete inbox rows — they are the audit trail.

**Fail-soft, per row:** one bad row (embed failure, LLM hiccup, constraint surprise) logs,
increments `metadata.attempts`, stays pending, and the batch continues. Rows exceeding
**5 attempts** reject as `attempts-exhausted`. The pass as a whole never throws on row-level
failures.

### 3. Edge-function deployability

Wire the pass per the existing `rumen-tick` pattern: either a step inside the tick (after the
insight cycle, budgeted) or a sibling function `supabase/functions/inbox-promote` — your
call, justify in the design FINDING. Same env surface (`DATABASE_URL` pooler discipline per
the Rumen pre-deployment checklist, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), same fail-soft
posture, runtime budget bounded by the batch size. Deployable ≠ deployed: do NOT deploy to
any live project — ORCH at close.

### 4. Tests (canonical glob — `tests/*.test.ts`, fixtures under `tests/fixtures/`)

Extend the fixture schema with `memory_inbox` (mirroring T1's migration 026 DDL — keep a
comment pointing at the engram file as the source of truth):

- Clean kitchen-level proposal → promoted; provenance assertions (source_agent preserved,
  inbox_id in metadata, promoted_memory_id + status stamped, embedding present).
- One rejection test per gate with the exact `rejection_reason` tag; near-duplicate records
  the matched id and does NOT mutate the existing canonical row.
- Idempotency: run the pass twice over the same fixture — second run is a no-op (no double
  insert, no status churn). Concurrency: two interleaved claims never process the same row
  (SKIP LOCKED semantics; if the CI pg fixture allows, an actual two-connection test).
- Fail-soft: an embed-throwing row leaves status pending + attempts incremented while the
  rest of the batch completes; attempts-exhaustion rejects.
- Rate cap: 51st same-connector row in 24 h stays pending.
- Mock the LLM + embedding clients per the existing test idioms (`tests/helpers.ts`).

## NOT in scope

- The inbox schema/RPC (T1) — if the schema contract doesn't fit the pass, HANDOFF-REQUEST
  to T1 in STATUS.md; never edit the engram repo. The bridge (T2). Any UI for manual review.
  Touching `rumen_insights`/`rumen_jobs` semantics beyond wiring the new pass. No deploys, no
  commits, no version bumps, no CHANGELOG.

## Acceptance

1. Design FINDING (claim strategy, gate order + numbers, tick wiring) posted before
   implementation.
2. Pass implemented: batched, idempotent, concurrency-safe, fail-soft, atomic
   promote+stamp; gates in the specified order with the stable rejection_reason vocabulary.
3. Provenance preserved end-to-end (`*-web` source_agent + inbox_id traceability).
4. Edge-function-deployable per the existing pattern; rumen suite green including the new
   fixture tests.
5. DONE post states: the rejection_reason vocabulary (T4 audits against it), the env knobs +
   defaults, and what ORCH must do at close to activate (apply 026, deploy/schedule the
   function, set envs).

## Lane discipline

Post shape: `### [T3] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in the Sprint 76 STATUS.md at the
absolute path in PLANNING.md. Watch T1's schema contract with the tolerant regex
`^(### )?\[T1\] (FIX-LANDED|DONE)\b`. Before posting DONE, answer any unacknowledged
HANDOFF-REQUEST naming T3; after DONE, enter PERIPHERY WATCH (re-read STATUS.md until
`^(### )?\[T4-GROK\] FINAL-VERDICT\b`; respond to AUDIT-* naming your lane). Stay in lane.
ORCH STATUS posts are binding, including post-DONE.
