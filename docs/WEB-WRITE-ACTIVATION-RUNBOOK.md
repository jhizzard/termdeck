# Web-write activation runbook — the memory-propose and session-record channels (Josh-go-gated)

**Status: DOCS ONLY. Nothing here self-executes.** This runbook turns on the
one path by which a **web chat** (claude.ai / ChatGPT / Grok / Gemini) can write
to your Mnestra memory — not directly, but as a *proposal* that an asynchronous
Rumen gate promotes or rejects. It is **default-off by design** and stays off
until you deliberately run these steps. `packages/mcp-bridge/docs/cloud-origin.md`
explicitly defers this decision to "a deliberate operator decision outside that
runbook" — **this is that runbook.**

> **GATE — read before doing anything.** Do not run any command here without an
> explicit go. Enabling web-write means content authored in a provider's cloud
> chat can (after gating) enter your canonical developer memory and thereafter
> egress into every CLI session via recall. That is a real trust-surface change.
> Authored by Sprint 81 lane T5 as a runbook; **T5 did not deploy anything.**

---

## What "web-write" is

There are **two independent write channels**, each with its own default-OFF
flag. They share the connector-identity layer (Part B1) and nothing else — you
can run either, both, or neither.

### Channel 1 — `memory_propose` (Sprint 76): one vetted fact at a time

```
  web chat (claude.ai / chatgpt / grok / gemini)
      │  calls MCP tool  memory_propose   (only when ENABLED + identity-mapped)
      ▼
  MCP Bridge  packages/mcp-bridge/src/tools/propose.js
      │  identity → caps → rate-limit → ingress secret scan → forward
      ▼
  Mnestra  memory_inbox        (migration 026; status='pending', INVISIBLE to recall)
      ▼
  Rumen  inbox-promote Edge Fn (cron)   promoteInbox() gates:
      │  caps → source-whitelist → 24h rate-cap → dedup → kitchen-vs-recipe
      ├── promote → memory_items (canonical; source_agent preserved as *-web)
      └── reject  → memory_inbox.status='rejected' + rejection_reason (audit trail)
```

- **WRITE side (Bridge).** The `memory_propose` tool. Gated by
  `TERMDECK_BRIDGE_ENABLE_PROPOSE=1` **and** a full fail-closed pipeline
  (identity source + policy fns + a propose-capable Mnestra client). Absent any
  piece, the tool is *not even listed*. It never touches `memory_items`.
- **DRAIN side (Rumen).** `inbox-promote` — a Supabase Edge Function that drains
  `memory_inbox` on a cron cadence via `promoteInbox()` from `@jhizzard/rumen`.
  Async by design: a proposal becomes recallable minutes later, if it passes.

**Turn the DRAIN on FIRST, then the WRITE.** If you enable proposals before the
promoter runs, proposals pile up `pending` and nothing drains them. Part A
below reflects that ordering.

### Channel 2 — `memory_session_record` (Sprint 84): a whole conversation

```
  web chat (claude.ai / chatgpt / grok / gemini)
      │  calls MCP tool  memory_session_record  (only when ENABLED + identity-mapped)
      ▼
  MCP Bridge  packages/mcp-bridge/src/tools/session-record.js
      │  identity → caps → rate-limit → ingress secret scan → forward
      ▼
  Mnestra  memory_sessions     (migration 035, via the memory_session_record RPC;
      │                         session_id MINTED as web:<agent>:<key>, never
      │                         caller-supplied)
      ▼
  Rumen  rumen-tick (cron, */15)   extract → relate → synthesize
      └── insights → rumen_insights / memory_items, written by Rumen, not by the web surface
```

This is the **web equivalent of the panel-close capture path**: a CLI panel that
closes writes a `memory_sessions` row via the bundled SessionEnd hook, and the
tick sweeps it. A web chat has no panel and no hook, so until this channel its
conversations never entered the learning loop at all.

It is a *second quarantine*, not a hole in the first. No recall path reads
`memory_sessions` — it is the tick's input queue, and the tick's synthesis pass
is the gate. Two further guards live in the RPC itself:

1. **`session_id` is minted server-side** as `web:<source_agent>:<conversation_key>`.
   A CLI-written row's `session_id` is a bare Claude Code session UUID, so a web
   caller cannot construct a key that addresses one.
2. **The upsert is narrowed** to rows of the *same* `source_agent` whose
   `rumen_processed_at` is still NULL. A caller may amend its own not-yet-swept
   record; it can never touch another agent's row, and never re-arm an
   already-consumed one for a second synthesis pass.

There is **no separate drain step** for this channel — `rumen-tick` is already
scheduled (`*/15`). Nothing to turn on first.

---

## Preconditions

- [ ] Explicit go from Josh for THIS activation (the gate above).
- [ ] The bridge is healthy and serving connectors today (`curl -s
      http://127.0.0.1:8870/healthz`). **Write down the `tools` number and the
      `mode` before you change anything** — that is your baseline, and it is
      origin-dependent: a `full` origin (Mac with panels) reports 6 read-only
      tools, a `memory-only` origin reports 2. Each write channel you enable
      adds exactly one. See B3 for the table.
- [ ] Supabase project reachable; you can run SQL in the Studio SQL editor / psql
      and deploy Edge Functions (`supabase` CLI logged in to the project).
- [ ] For **Channel 2 only**: Mnestra migration **035** applied (adds
      `memory_sessions.source_agent` / `.metadata` and the
      `memory_session_record` RPC), and the installed `@jhizzard/mnestra` is new
      enough to serve the webhook `session_record` op. An older build answers
      **501** and the bridge surfaces "this Mnestra build has no session_record
      op" rather than silently dropping the write. Channel 1 and its drain
      (Part A) need only migration 026.
- [ ] `pg_cron` and `pg_net` extensions enabled (Database → Extensions).
- [ ] The service-role key stored in Supabase **Vault** as `rumen_service_role_key`
      (reused from the existing `rumen-tick` / `doctrine-scan` schedules — if
      those are scheduled, this already exists).
- [ ] Model keys in hand: `OPENAI_API_KEY` (dedup embeddings, text-embedding-3-
      large @ 1536) and `ANTHROPIC_API_KEY` (the kitchen-vs-recipe Haiku gate).
      **Both are required** — without them the promoter returns HTTP 503 and
      leaves the inbox untouched rather than burning promotion attempts.
- [ ] The pooler `DATABASE_URL` (Shared Pooler IPv4) for the Edge Function.

Substitute your own `<project-ref>` throughout. Never paste real secrets into a
committed file.

---

## Part A — DRAIN side: deploy & schedule `inbox-promote`

### A1. Apply the inbox schema (Mnestra migration 026)

`memory_inbox` is created by `migrations/026_memory_inbox.sql` in the Mnestra
migration chain (the `engram/` repo / the bundled Mnestra migrations). Apply it
the normal way you apply Mnestra migrations (ORCH at sprint close; or
`termdeck init --mnestra`). Confirm:

```sql
select to_regclass('public.memory_inbox');            -- expect: public.memory_inbox
select count(*) from public.memory_inbox;             -- expect: 0 (fresh)
```

### A2. Deploy the Edge Function

Source lives at
`packages/server/src/setup/rumen/functions/inbox-promote/index.ts` (Deno; a thin
wrapper that freezes the `@jhizzard/rumen` version at deploy time).

```bash
supabase functions deploy inbox-promote

# Required secrets:
supabase secrets set DATABASE_URL="$DATABASE_URL"          # Shared Pooler IPv4 URL
supabase secrets set OPENAI_API_KEY="$OPENAI_API_KEY"      # dedup-gate embeddings
supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" # kitchen-vs-recipe Haiku gate

# Optional tuning (defaults shown):
supabase secrets set RUMEN_PROMOTE_BATCH=25
supabase secrets set RUMEN_PROMOTE_RATE_CAP_24H=50
supabase secrets set RUMEN_PROMOTE_MAX_ATTEMPTS=5
supabase secrets set RUMEN_PROMOTE_CLAIM_LEASE_MINUTES=10
```

Smoke it once by hand (empty inbox → a clean no-op pass):

```bash
curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/inbox-promote" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{}'
#   → { "ok": true, "summary": { "claimed": 0, "promoted": 0, "rejected": 0 } }
#   (a 503 with skipped_reason means a model key is missing — fix A2 secrets)
```

### A3. Schedule it on pg_cron

**Prefer the migration.** `rumen/migrations/006_pg_cron_inbox_promote.sql` does
exactly what follows and is the single source of truth for the registration:

```bash
psql "$DIRECT_URL" -f migrations/006_pg_cron_inbox_promote.sql
```

The SQL below is the same thing by hand, for an operator working in the Studio
SQL editor. Keep the two in step — if you change one, change the other.

**The job is named `rumen-inbox-promote`, not `inbox-promote`.** An earlier
revision of this runbook used the bare name while the migration used the
`rumen-` prefix, which meant an install that followed both ended up with the
promoter registered TWICE and firing twice per window — and with each artifact's
`cron.unschedule` cleaning up only its own name, so neither could remove the
other. That is why the unschedule step below drops *both* names, and why the
verify query matches on a pattern rather than the canonical name: the failure it
has to catch is a second registration under the old name, and a query for the
canonical name cannot see one.

```sql
-- Idempotent, AND collapses the legacy name. Drop both before scheduling:
-- an install that ever ran the pre-2026-07-31 version of this runbook has a
-- job called 'inbox-promote' that nothing else will ever clean up.
select cron.unschedule('inbox-promote')
  where exists (select 1 from cron.job where jobname = 'inbox-promote');
select cron.unschedule('rumen-inbox-promote')
  where exists (select 1 from cron.job where jobname = 'rumen-inbox-promote');

-- Every 10 minutes. NOT */15 — that is rumen-tick's slot, and a promoter
-- sharing it would contend with the tick on the same pooler on every single
-- firing. At */10 they coincide twice an hour instead of always.
select cron.schedule(
  'rumen-inbox-promote',
  '*/10 * * * *',
  $$
    select net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/inbox-promote',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret
                                         from vault.decrypted_secrets
                                        where name = 'rumen_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verify. Match the PATTERN, not the canonical name: exactly one row must come
-- back. Two rows means a legacy registration survived and the promoter is
-- double-firing.
select jobname, schedule, active
  from cron.job
 where jobname like '%inbox-promote%';
--  expect exactly 1 row: rumen-inbox-promote | */10 * * * * | t
```

**The drain is now live and idle** (nothing to promote yet). Confirm A2's smoke
returned `ok:true` before moving on.

Once proposals start arriving, the drain's liveness is one query — pending
proposals aging past 7 days mean the promoter has stopped, which otherwise looks
identical to an idle queue:

```sql
select * from public.memory_inbox_health;   -- Mnestra migration 036
```

---

## Part B — WRITE side: connector identity, then the `memory_propose` tool

B1 and B4 establish **connector identity**, which BOTH write channels share —
do them even if you only want Part C. B2/B3 flip Channel 1 specifically.

### B1. Map each web connector to its `*-web` source agent

The bridge NEVER lets a caller claim its own identity — `source_agent` is
derived from the per-request OAuth client and an **unmapped client is refused
outright**. Provide the map (this is why an accidental enable can't silently
mislabel provenance):

```bash
# ~/.termdeck/bridge-propose.json  (0600)
{
  "clients": {
    "<client_id_for_claude_web>":  "claude-web",
    "<client_id_for_chatgpt_web>": "chatgpt-web",
    "<client_id_for_grok_web>":    "grok-web",
    "<client_id_for_gemini_web>":  "gemini-web"
  }
}
```

Find each `client_id` in `~/.termdeck/bridge-auth.json` (the DCR client
registrations), or from the bridge log line emitted when that connector calls a
tool.

**Env alternative — CORRECTED 2026-07-31 (Sprint 84 T2).** Earlier revisions of
this runbook said `TERMDECK_BRIDGE_PROPOSE_MAP` takes "env-inlined JSON of the
same shape". **It does not, and never did.** The parser
(`packages/mcp-bridge/src/policy.js::loadProposeMap`) splits the value on
commas and then on the first `=` in each pair. Pasting JSON there yields a map
with **zero** usable entries, silently — every client falls through to the
heuristic in B4, or is refused outright under strict mode. The real shape:

```bash
TERMDECK_BRIDGE_PROPOSE_MAP=mcp_aaa=claude-web,mcp_bbb=chatgpt-web,mcp_ccc=grok-web
```

Rules the parser enforces: whitespace around ids and agents is trimmed; the
agent must be exactly one of the four `*-web` values (case-insensitive) or the
pair is **ignored**, leaving that client unmapped; env entries override
file entries on conflict. An operator typo can therefore only ever fail closed.

Both sources are re-read per call, so adding a client does **not** require a
bridge restart — only the `TERMDECK_BRIDGE_ENABLE_*` flags do.

### B4. ChatGPT and Grok — the connectors that are already mapped by accident

Read this before assuming the file in B1 is what controls access.

`mapClientToSourceAgent` tries the explicit map **first**, then falls back to a
`client_name` heuristic: `/chatgpt|openai/i` → `chatgpt-web`, `/grok|xai/i` →
`grok-web`, `/claude/i` → `claude-web`, `/gemini|google/i` → `gemini-web` (a
name matching two families resolves to nothing — ambiguity fails closed).

On a host whose `bridge-propose.json` lists only its Claude clients, the
ChatGPT and Grok registrations therefore **still resolve** — via their
registration names — and can already write. That is not an escalation path (the
heuristic can only ever produce one of the four `*-web` values, never a CLI
identity, and Mnestra's RPC whitelist re-checks server-side), but provenance is
being chosen by whoever picked the DCR display name rather than by the
operator. Two steps close it.

**Step 1 — enumerate the connectors and add the missing ones explicitly.** This
prints one `client_id=agent` line per registration, using the same heuristic as
a starting suggestion; review it before pasting anything:

```bash
python3 - <<'PY'
import json, os
auth = json.load(open(os.path.expanduser('~/.termdeck/bridge-auth.json')))
try:
    mapped = json.load(open(os.path.expanduser('~/.termdeck/bridge-propose.json'))).get('clients', {})
except FileNotFoundError:
    mapped = {}
guess = [('chatgpt-web', ('chatgpt', 'openai')), ('grok-web', ('grok', 'xai')),
         ('claude-web', ('claude',)), ('gemini-web', ('gemini', 'google'))]
for cid, rec in (auth.get('clients') or {}).items():
    name = (rec or {}).get('client_name') or ''
    hits = [a for a, keys in guess if any(k in name.lower() for k in keys)]
    agent = hits[0] if len(hits) == 1 else '<UNRESOLVED — set by hand>'
    print(f'{"MAPPED  " if cid in mapped else "MISSING "}{cid} = {agent}    # client_name: {name!r}')
PY
```

Add every `MISSING` line to the `clients` object in
`~/.termdeck/bridge-propose.json` (keep it `0600`). A client whose name matched
nothing, or matched two families, must be resolved by hand — check which
connector it is before choosing, because this value IS the provenance stamp on
everything that client ever writes.

**Step 2 — turn the heuristic off.**

```bash
# ~/.termdeck/supervisor.env   (or ~/.termdeck/bridge.env on the cloud origin)
TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1
```

With this set, **only** explicitly-mapped `client_id`s resolve; every other
connector is refused with an operator-actionable error naming the unmapped
`client_id`. It defaults **OFF**, so nothing changes until you set it — which
also means a connector you forgot in Step 1 stops working the moment you do.
Run Step 1 first, confirm zero `MISSING` lines, then set this and bounce.

Applies to both write channels — they share this identity layer.

### B2. Flip the flag + (optional) rate knobs

Add to the bridge's environment — on the Macs that's
`~/.termdeck/supervisor.env`; on the cloud origin it's `~/.termdeck/bridge.env`:

```bash
TERMDECK_BRIDGE_ENABLE_PROPOSE=1
# optional (defaults shown): per-connector token bucket
TERMDECK_BRIDGE_PROPOSE_RATE_PER_HOUR=10
TERMDECK_BRIDGE_PROPOSE_BURST=3
```

Channel 2 has its **own** flag; see Part C. Enabling one never enables the other.

**TermDeck API base (panel tools).** Since 2026-07-31 the bridge finds the live
deck automatically; `TERMDECK_API_BASE` no longer needs to be set (and the
supervisor no longer hardcodes it). Resolution order: `TERMDECK_API_BASE` /
`TERMDECK_BASE_URL` env if set (explicit pin, wins outright) →
`~/.termdeck/ports.json` (written by the TermDeck server at listen-time;
dead-pid entries skipped, freshest deck wins, candidate verified live) → port
probe `3000 → 3001 → 3002 → 3099` (~500ms each; first port whose
`GET /api/sessions` returns a JSON array wins). The result is cached ~60s and
re-resolved after failures, so a deck restart on another port heals itself.
Set `TERMDECK_API_BASE` in `supervisor.env` only to pin one specific deck.

### B3. Restart the bridge and confirm the tool appeared

```bash
# bounce the bridge so the supervisor restarts it with the new env
lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill
# wait one supervisor tick (~60s), then:
curl -s http://127.0.0.1:8870/healthz
```

**Reading the `tools` count.** It is a TOTAL, and its baseline depends on the
origin — so `2` is not a universal starting point. Count from the baseline this
origin actually reports, then add one per enabled write channel:

| origin | baseline read-only tools | + propose | + session record |
|---|---|---|---|
| full (`"mode":"full"` — a Mac with panels) | **6** (2 memory + 4 panel) | 7 | **8** |
| memory-only (`"mode":"memory-only"` — cloud origin, `TERMDECK_BRIDGE_MEMORY_ONLY=1`) | **2** (memory only) | 3 | **4** |

The count going **up by one** is the confirmation the channel mounted. If it
does not move, one pipeline piece is missing (identity source, policy fns, a
capable Mnestra client, or the flag itself) — the tool is fail-closed absent,
by design, not present-and-erroring.

> Operator note for anyone watching this number: on a full origin it moves
> 6 → 7 → 8 as the two channels come on. An `8` is not drift.

The `memory_propose` tool is `approval:true`, so a web chat user explicitly
approves each proposal call; the tool's own description tells the model to say a
memory was *proposed for review*, never *saved to memory*.

---

## Part C — WRITE side: enable `memory_session_record` (Sprint 84)

Independent of Part B. B1 + B4 (connector identity) are shared prerequisites;
Part A is **not** — this channel drains through the existing `rumen-tick`
schedule, which is already running.

### C1. Confirm the store can serve it

```sql
-- migration 035 landed?
select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'memory_session_record';   -- expect 1 row
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'memory_sessions'
   and column_name in ('source_agent', 'metadata');                    -- expect 2 rows
```

If either is empty, apply 035 (`termdeck init --mnestra`, or ORCH at close-out)
before flipping the flag. With the flag on and the RPC missing, every call
fails at the store with a clear error — nothing is silently lost — but there is
no reason to ship that state.

### C2. Flip the flag + (optional) rate knobs

```bash
# ~/.termdeck/supervisor.env   (or ~/.termdeck/bridge.env on the cloud origin)
TERMDECK_BRIDGE_ENABLE_SESSION_RECORD=1
# optional (defaults shown): per-connector token bucket, SEPARATE from propose's
TERMDECK_BRIDGE_SESSION_RECORD_RATE_PER_HOUR=12
TERMDECK_BRIDGE_SESSION_RECORD_BURST=4
```

The bucket is keyed on the OAuth `client_id`, and one `client_id` serves every
conversation on that surface — so these numbers bound *conversations per hour*
for the whole connector, not turns within one chat. Twelve with a burst of four
leaves normal multi-conversation use alone; lower it if you want a tighter cap.

### C3. Bounce and confirm

```bash
lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill
# wait one supervisor tick (~60s), then:
curl -s http://127.0.0.1:8870/healthz     # tools: baseline + 1 per enabled channel
```

On a full origin with both channels on, that is **8**. See the B3 table.

### C4. Verify end-to-end, once

From a mapped web connector, end a real conversation and ask it to record the
session summary. Then:

```sql
-- 1) the row landed, with server-minted key and *-web provenance:
select session_id, source_agent, project, messages_count,
       started_at is not null as started_set, ended_at is not null as ended_set,
       metadata->'bridge'->>'client_id' as connector
  from public.memory_sessions
 where source_agent is not null
 order by created_at desc limit 5;
-- expect session_id like 'web:<agent>:<key>', ended_set = t

-- 2) would rumen-tick sweep it? (this is the picker's own WHERE clause)
select id, project, left(summary, 60) as preview, coalesce(messages_count,0) as events
  from public.memory_sessions s
 where s.rumen_processed_at is null
   and s.ended_at is not null
   and s.ended_at >= now() - ('72' || ' hours')::interval
   and coalesce(s.messages_count, 0) >= 3
   and s.summary is not null and s.summary <> ''
 order by coalesce(s.started_at, s.ended_at) desc nulls last
 limit 25;

-- 3) after the next tick (≤ 15 min), it is claimed:
select session_id, rumen_processed_at from public.memory_sessions
 where source_agent is not null order by created_at desc limit 5;
```

**If the row exists but step 2 does not return it**, the usual cause is the
`messages_count >= 3` floor — a two-turn conversation is stored and never
analysed, and the tool says so in its own success message. That is working as
intended; do not re-record it with an inflated count.

### C5. What a repeat call does

Re-recording the same `conversation_key` **amends** the row while
`rumen_processed_at` is still NULL. Once the tick has claimed it, a further
call is refused with `MEMORY_SESSION_RECORD_REJECTED: session_locked` — the
learning pass has already consumed that content and re-arming it would buy a
second synthesis of the same conversation. Start a new conversation key
instead.

---

## Verification — end-to-end, once

From a mapped web connector, ask it to propose a durable, kitchen-level fact.
Then walk the pipeline:

```sql
-- 1) it landed in quarantine, pending, with the right *-web provenance:
select id, source_agent, status, left(text, 60) as preview
  from public.memory_inbox order by created_at desc limit 5;   -- status='pending'

-- 2) after the next cron tick (≤ your schedule interval), it drains:
select status, rejection_reason, promoted_memory_id, left(text,60)
  from public.memory_inbox order by created_at desc limit 5;   -- 'promoted' or 'rejected'

-- 3) a PROMOTED proposal is now canonical + recallable, provenance preserved:
select id, source_agent, source_type, left(content,60)
  from public.memory_items
 where id = '<promoted_memory_id>';                            -- source_agent still *-web
```

A `rejected` row is not a failure — read `rejection_reason` (stable vocabulary:
`oversize` · `invalid-source-agent` · `rate-capped` · `duplicate` ·
`near-duplicate` · `recipe-level` · `attempts-exhausted`). Rejections are the
audit trail; inbox rows are never deleted by the promoter (only the 90-day purge
ages raw rows out).

---

## Rollback

Every piece is independently reversible; the WRITE side is the instant kill.

```bash
# WRITE off — stop accepting new writes immediately. Remove whichever flags you
# set from the bridge env (~/.termdeck/supervisor.env, or bridge.env on the
# cloud origin), then bounce:
#
#   TERMDECK_BRIDGE_ENABLE_PROPOSE          → drops memory_propose
#   TERMDECK_BRIDGE_ENABLE_SESSION_RECORD   → drops memory_session_record
#
# They are independent: removing one leaves the other mounted.
lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill

# Confirm: `tools` falls back to this origin's read-only baseline — 6 on a full
# origin, 2 on a memory-only one (B3's table), minus nothing else. It does NOT
# return to a fixed "2" unless that was your baseline to begin with.
curl -s http://127.0.0.1:8870/healthz
```

Narrower alternative, no restart required: leave the flags on and empty
`~/.termdeck/bridge-propose.json` with `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1`
already set — the map is re-read per call, so every connector becomes unmapped
and every write is refused while the tools stay listed. Useful when you want to
stop writes from one specific connector rather than all of them: delete just
its line.

Rolling back Channel 2's storage is separate and rarely necessary — the RPC can
be dropped without touching the rows it wrote (see migration 035 § 4b). Rows
already recorded stay in `memory_sessions`; those the tick has not yet claimed
will still be swept. If you want them excluded, stamp them first:

```sql
-- Neutralize un-swept web-recorded sessions without deleting the audit trail:
update public.memory_sessions
   set rumen_processed_at = now()
 where source_agent is not null and rumen_processed_at is null;
```

```sql
-- DRAIN off — stop the promoter (pending rows simply stay quarantined + invisible).
-- Both names, for the same reason A3 drops both: a rollback that only knows the
-- legacy name leaves the canonical job running, which is the worst outcome here
-- — you would believe the drain is stopped while it keeps promoting.
select cron.unschedule('rumen-inbox-promote')
  where exists (select 1 from cron.job where jobname = 'rumen-inbox-promote');
select cron.unschedule('inbox-promote')
  where exists (select 1 from cron.job where jobname = 'inbox-promote');

-- Confirm it is actually off: expect 0 rows.
select jobname from cron.job where jobname like '%inbox-promote%';
```

Pending proposals are invisible to recall by construction, so turning WRITE off
and leaving the inbox as-is is safe. To fully undeploy: `supabase functions
delete inbox-promote`. Migration 026's table can stay (empty + harmless).

---

## Safety notes (why this is acceptable when gated)

- **Fail-closed everywhere.** No flag, no identity map, no capable client ⇒ the
  tool does not exist. An unmappable connector is refused, not defaulted. Each
  channel is gated separately, so neither can arrive as a side effect of the
  other.
- **Identity is derived, never claimed.** `source_agent` comes from the
  per-request OAuth client. A caller-supplied `source_agent` argument is
  ignored outright, and no path can mint a CLI value (`claude`, `codex`,
  `gemini`, `grok`, `orchestrator`) from a web surface — the bridge map and
  Mnestra's RPC whitelist both permit only the four `*-web` values. Set
  `TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1` (B4) to require an explicit operator
  mapping rather than a `client_name` inference.
- **Ingress secret scan, REJECT not scrub.** A proposal is scanned with the same
  denylist + secret patterns as tool-result egress; a match is refused (rule
  *class* named, never the matched text — it must not echo back through the
  provider cloud). A silently-sanitized memory is a corrupted memory.
- **Quarantine + async gates.** Proposals are invisible to recall until promoted;
  promotion runs caps → source-whitelist → 24h rate-cap → dedup (>0.95 skip,
  0.88–0.95 near-dup reject, no canonical mutation) → kitchen-vs-recipe (Haiku).
  Fail-soft per row; the gate fails *closed* (unparseable verdict → stays
  pending, never auto-promoted).
- **Provenance preserved.** A promoted memory keeps its `*-web` `source_agent` —
  you can always tell canonical CLI-authored memory from promoted web proposals.
  Session rows carry it too (migration 035): `source_agent IS NULL` means
  CLI/hook-written, non-NULL means a web surface recorded it, so one predicate
  separates the two populations forever.
- **Channel 2 cannot reach a CLI session row.** `session_id` is minted
  server-side as `web:<agent>:<key>`, and the upsert only touches rows of the
  same `source_agent` whose `rumen_processed_at` is NULL. A web caller cannot
  overwrite a panel-close summary, cannot amend another surface's record, and
  cannot re-arm an already-swept row for a second synthesis pass.
- **Nothing Channel 2 writes is recallable on its own.** No recall path reads
  `memory_sessions`; the only consumer is `rumen-tick`, whose synthesis is the
  gate. Insights derived from a web-recorded session are written by Rumen, not
  by the web surface.
- **RLS hygiene** on `memory_inbox` / the promoter path is covered by the Mnestra
  migration's own five-gate receipt (026); migration 035 carries the same
  hard-failing five-gate receipt for `memory_sessions` +
  `memory_session_record`, and additionally revokes the residual
  anon/authenticated table grants on `memory_sessions`. Re-run
  `get_advisors(type='security')` after applying either as the standing release
  check.

## What ORCH does at close vs. what stays deferred

- **ORCH at sprint close** applies live migrations (026 and 035 if not already)
  and may run Part A to have the drain ready — *only with Josh's go*.
- **Deferred until an explicit activation decision:** every flag flip. Part B
  (`TERMDECK_BRIDGE_ENABLE_PROPOSE=1`), Part C
  (`TERMDECK_BRIDGE_ENABLE_SESSION_RECORD=1`), and the identity hardening in B4
  (`TERMDECK_BRIDGE_PROPOSE_STRICT_MAP=1`) all ship **default-OFF**. Both
  channels ship dark; enabling either is the operator decision this runbook
  exists to make deliberate.
- **B4 is the one item worth doing even with both channels off**, because it
  concerns a channel that may already be on: if `TERMDECK_BRIDGE_ENABLE_PROPOSE`
  is set today, every ChatGPT/Grok connector registered against this bridge can
  already propose via the `client_name` heuristic, whether or not the operator
  map lists it.
