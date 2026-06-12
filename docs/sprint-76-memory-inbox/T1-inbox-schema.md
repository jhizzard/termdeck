# T1 — `memory_inbox` schema + `memory_propose` RPC (migration 026)

**Work repo:** `~/Documents/Graciella/engram`. STATUS.md lives in the termdeck repo —
post to the absolute path in PLANNING.md § Lane discipline.

## Boot context

Sprint 76 implements the adopted 2026-06-11 design: **CLIs write canonical; web chats write
proposals.** You own the quarantine substrate: a `memory_inbox` table whose pending rows are
provably invisible to every recall path, an insert-only-via-RPC write contract, the TS types,
and the webhook `propose` op the bridge (T2) will call. Prereqs are ALL shipped in 0.5.0:
the four `*-web` `SOURCE_AGENTS` values (`src/types.ts:115-136`, migration 025) and webhook
`source_agent` threading (`webhook-server.ts` remember case, `remember.ts`). Migration slot
**026 is the next free slot** — 024 (email-assistant) and 025 (web source_agents) are taken;
do not renumber anything.

## Scope

### 1. Inventory FIRST (post as FINDING)

Before writing SQL, enumerate **every read surface in the repo** that could conceivably
return memory content, with file:line — this list is the backbone of the quarantine proof
and T4 will independently rebuild it and diff against yours:

- `src/recall.ts` (`memory_hybrid_search` RPC consumer) and the RPC SQL itself
  (migration 023's `RETURNS TABLE` version is current — confirm which migration's definition
  is live by reading 023 + anything later that replaces it)
- `src/search.ts`, `src/layered.ts` (`memory_index` / `memory_timeline` / `memory_get`),
  `src/recall_graph.ts`, `src/status.ts`, `src/consolidate.ts`, `src/export-import.ts`,
  `src/summarize.ts`, `src/doctor-data-source.ts`
- `src/webhook-server.ts` dispatch ops (`remember/recall/search/status/index/timeline/get`)
- `mcp-server/index.ts` tool registrations
- Every SQL function across `migrations/` that SELECTs from a memory table
  (`grep -n "from .*memory" migrations/*.sql`)

For each: state whether it reads `memory_items` / `memory_sessions` / other, and confirm it
has no path to `memory_inbox` (which doesn't exist yet — the point is to pin the inventory
so "separate table ⇒ excluded by construction" is a proven claim, not an assumption).

### 2. Migration `migrations/026_memory_inbox.sql`

Table (column spec is binding; types/defaults are yours to finalize sensibly):

```sql
create table if not exists public.memory_inbox (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  source_agent        text not null,            -- constrained BY CONVENTION to the four *-web
                                                -- values; NO CHECK constraint (see below).
                                                -- The RPC whitelist is the enforcement point.
  project_hint        text,                     -- proposer's claimed project; advisory only —
                                                -- Rumen may re-map; never trusted as canonical
  text                text not null,            -- the proposal body
  status              text not null default 'pending'
                      check (status in ('pending','promoted','rejected')),
  promoted_memory_id  uuid references public.memory_items(id) on delete set null,
  rejection_reason    text,
  metadata            jsonb not null default '{}'::jsonb  -- connector metadata: client_id,
                                                -- connector label, bridge request id, caps
                                                -- snapshot, promotion-attempt counters
);
```

Design rationale to encode in SQL comments (and follow):

- **`status` gets a CHECK; `source_agent` does NOT.** The status writers are controlled code
  (the RPC always writes `'pending'`; Rumen stamps `'promoted'`/`'rejected'`) — a CHECK there
  is pure safety. `source_agent` stays plain text per the Sprint 50/74 fail-soft doctrine
  (migration 025's "no CHECK by design" comment): the whitelist lives in the RPC, where a
  violation produces a clean, attributable rejection instead of a 23514 inside a writer.
- **FK to `memory_items` with `on delete set null`** — forgetting a promoted memory must not
  orphan-error the inbox audit trail.
- Indexes: partial on `(status) where status = 'pending'` (the promotion pass's scan),
  `created_at desc`, and `(source_agent)` for per-connector accounting.
- **Status-consistency CHECK** (recommended): `promoted_memory_id is null or status = 'promoted'`
  and `rejection_reason is null or status = 'rejected'` — keeps the audit trail honest.

RPC — use the global CLAUDE.md migration template shape exactly:

```sql
create or replace function public.memory_propose(
  p_source_agent text,
  p_text         text,
  p_project_hint text default null,
  p_metadata     jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
  -- validate, insert, return id
$$;

revoke execute on function public.memory_propose(text, text, text, jsonb) from public;
grant  execute on function public.memory_propose(text, text, text, jsonb) to service_role;
```

Validation inside the RPC (reject with `raise exception` carrying a stable, machine-matchable
message prefix, e.g. `MEMORY_PROPOSE_REJECTED: <reason>`):

- `p_source_agent` ∈ exactly (`'claude-web'`, `'chatgpt-web'`, `'grok-web'`, `'gemini-web'`)
  — case-sensitive after trim/lower normalization; CLI values (`claude`, `grok`, …) and
  anything else are REJECTED. Web surfaces may never impersonate a CLI trust domain.
- Size caps: `p_text` non-empty after trim, `length(p_text) <= 4000`;
  `length(p_project_hint) <= 128`; `pg_column_size(p_metadata) <= 8192`. (4000 chars is the
  binding default; note it in a comment so T2/T3 mirror the same number.)
- `p_metadata` must be a JSON object (not array/scalar).

### 3. Five RLS hygiene gates — release-blocking, verify each explicitly

1. `alter table public.memory_inbox enable row level security;` **in this same migration.**
2. NO policies on the table at all (no `WITH CHECK (true)`, no PUBLIC, nothing) — anon and
   authenticated are denied everything; service_role bypasses RLS by design.
3. `REVOKE EXECUTE ... FROM PUBLIC` then `GRANT ... TO service_role` on `memory_propose`
   (and any helper function you add). Also `revoke all on table public.memory_inbox from
   anon, authenticated;` belt-and-suspenders against default grants.
4. `SET search_path = public, pg_catalog` on every function — SECURITY DEFINER makes this
   extra-load-bearing (shadow-attack primitive otherwise).
5. The RPC is the ONLY insert path for proposals: no anon-key writes, no PostgREST table
   insert from any client. (Rumen's later status UPDATEs ride its service-role/pg connection
   — that is T3's lane and is not an INSERT path.)

Include an apply-time `do $$ ... raise notice ... $$` receipt block (025 house style):
RLS state of the table, policy count (expect 0), and
`has_function_privilege('anon', 'public.memory_propose(text,text,text,jsonb)', 'EXECUTE')`
(expect false). Idempotent; write apply-ready; **do NOT apply to any remote project — ORCH
applies at close.**

### 4. TS types + webhook op `propose`

- `src/types.ts`: `MemoryInboxStatus` (`'pending'|'promoted'|'rejected'`), `MemoryInboxRow`,
  `ProposeInput { source_agent: string; text: string; project_hint?: string | null;
  metadata?: Record<string, unknown> }`, `ProposeResult { id: string }`. Export a
  `WEB_SOURCE_AGENTS` const (the four `*-web` values) derived from / consistent with
  `SOURCE_AGENTS` — single source of truth, no drift (same pattern as the zod-derived enum
  from Sprint 74).
- `src/propose.ts`: `memoryPropose(input, deps?)` — mirror-validate the RPC's whitelist and
  caps in TS (fail fast with a clean 4xx before a DB round-trip; the SQL validation remains
  the authoritative gate), then call the RPC via the supabase client
  (`.rpc('memory_propose', ...)`). Take an injectable deps seam cloned from `RememberDeps`
  (`remember.ts:20`) so tests run hermetic.
- `src/webhook-server.ts`: new `case 'propose'` in `dispatchOp` — validates presence of
  `source_agent` + `text`, forwards to `deps.propose`, returns
  `{ ok: true, id, status: 'pending' }` with HTTP 200; validation failures return 400 with
  the reason (the bridge surfaces it to the connector). Wire into `defaultDeps` + `OpDeps`.
- **Deliberate non-change:** the stdio MCP server gains NO `memory_propose` tool — local MCP
  callers are CLI trust domain and use `memory_remember`. The webhook op exists for the
  bridge (T2) only. State this in a comment.

### 5. Tests (canonical glob — `tests/*.test.ts`, green via `npm test`)

- **Quarantine proof (the headline test):** insert a fixture inbox row (pending) into the
  instrumented store, then drive every read surface from your § 1 inventory — recall, search,
  index, timeline, get, recall_graph, status, webhook recall op — and assert the proposal
  text NEVER appears. By construction these read `memory_items`, so the test's real job is
  to fail loudly if anyone ever points a read path at the inbox.
- Webhook `propose` round-trip: valid input → 200 + uuid; missing text → 400; CLI
  source_agent (`'grok'`) → 400; oversize text → 400; the dispatch never touches
  `memory_items`.
- `memoryPropose` unit tests: whitelist accept ×4 / reject (CLI values, unknown,
  empty), caps boundaries (4000 ok / 4001 rejected), metadata shape, deps-seam injection.
- A SQL-text assertion test on `migrations/026_memory_inbox.sql` (house idiom: the
  hygiene/gitleaks-style static checks): contains `enable row level security`,
  `revoke execute`, `set search_path = public, pg_catalog`, no `with check (true)`.

## NOT in scope

- The bridge tool surface (T2 owns it; you own the webhook op contract it calls — coordinate
  via STATUS.md `HANDOFF-REQUEST`/`HANDOFF-ACK` if the contract needs to move).
- The promotion pass and any UPDATE logic on inbox rows (T3 owns it — but your schema must
  give it what it needs: the partial pending index, the status CHECKs, metadata jsonb for
  attempt counters; read T3's brief for the consumer view before finalizing).
- Applying migrations anywhere. Publishing `@jhizzard/mnestra`. The mcp-server tool surface.

## Acceptance

1. Inventory FINDING with file:line for every read surface + per-surface no-inbox-path claim.
2. Migration 026 apply-ready, idempotent, all five gates satisfied + receipt block.
3. Webhook `propose` op + `src/propose.ts` + types landed; whitelist and caps enforced in
   BOTH SQL and TS.
4. Quarantine-proof test + propose tests green; full suite green over the merged working tree.
5. DONE post states the exact webhook op contract (field names, caps, error shapes) T2 needs,
   and the exact schema surface (columns, claim semantics, indexes) T3 needs.

## Lane discipline

Post shape: `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in the termdeck-repo STATUS.md
(absolute path in PLANNING.md). Idle-polls use `^(### )?\[T<n>\] <VERB>\b` tolerant regexes.
Before posting DONE, answer any unacknowledged HANDOFF-REQUEST naming T1; after DONE, enter
PERIPHERY WATCH (re-read STATUS.md until `^(### )?\[T4-GROK\] FINAL-VERDICT\b`; respond to
AUDIT-* naming your lane). Stay in lane. No commits, no version bumps, no CHANGELOG. ORCH
STATUS posts are binding, including post-DONE.
