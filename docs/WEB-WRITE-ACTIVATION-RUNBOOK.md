# Web-write activation runbook — the memory-propose channel (Josh-go-gated)

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

## What "web-write" is (the two halves)

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
promoter runs, proposals pile up `pending` and nothing drains them. Order below
reflects that.

---

## Preconditions

- [ ] Explicit go from Josh for THIS activation (the gate above).
- [ ] The bridge is healthy and serving connectors today (`curl -s
      http://127.0.0.1:8870/healthz` → `tools: 2`, i.e. propose is currently OFF).
- [ ] Supabase project reachable; you can run SQL in the Studio SQL editor / psql
      and deploy Edge Functions (`supabase` CLI logged in to the project).
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

Mirror the existing schedules (`002_pg_cron_schedule.sql` /
`005_doctrine_scan_schedule.sql`). Run in the Studio SQL editor:

```sql
-- idempotent: drop any prior registration first
select cron.unschedule('inbox-promote')
  where exists (select 1 from cron.job where jobname = 'inbox-promote');

-- every 10 minutes (tune to taste; the promoter is batched + idempotent)
select cron.schedule(
  'inbox-promote',
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

-- verify
select jobname, schedule, active from cron.job where jobname = 'inbox-promote';
```

**The drain is now live and idle** (nothing to promote yet). Confirm A2's smoke
returned `ok:true` before moving on.

---

## Part B — WRITE side: enable the `memory_propose` tool on the bridge

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
tool. (Alternatively set `TERMDECK_BRIDGE_PROPOSE_MAP` as an env-inlined JSON of
the same shape.)

### B2. Flip the flag + (optional) rate knobs

Add to the bridge's environment — on the Macs that's
`~/.termdeck/supervisor.env`; on the cloud origin it's `~/.termdeck/bridge.env`:

```bash
TERMDECK_BRIDGE_ENABLE_PROPOSE=1
# optional (defaults shown): per-connector token bucket
TERMDECK_BRIDGE_PROPOSE_RATE_PER_HOUR=10
TERMDECK_BRIDGE_PROPOSE_BURST=3
```

### B3. Restart the bridge and confirm the tool appeared

```bash
# bounce the bridge so the supervisor restarts it with the new env
lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill
# wait one supervisor tick (~60s), then:
curl -s http://127.0.0.1:8870/healthz            # → "tools": 3   (was 2)
```

`tools` going **2 → 3** is the confirmation `memory_propose` mounted. If it stays
2, one pipeline piece is missing (identity source, policy fns, propose-capable
client, or the flag) — the tool is fail-closed absent, by design.

The `memory_propose` tool is `approval:true`, so a web chat user explicitly
approves each proposal call; the tool's own description tells the model to say a
memory was *proposed for review*, never *saved to memory*.

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

Both halves are independently reversible; the WRITE side is the instant kill.

```bash
# WRITE off — stop accepting new proposals immediately:
#   remove TERMDECK_BRIDGE_ENABLE_PROPOSE from the bridge env, then bounce:
lsof -nP -ti TCP:8870 -sTCP:LISTEN | xargs kill      # tools returns to 2
```

```sql
-- DRAIN off — stop the promoter (pending rows simply stay quarantined + invisible):
select cron.unschedule('inbox-promote')
  where exists (select 1 from cron.job where jobname = 'inbox-promote');
```

Pending proposals are invisible to recall by construction, so turning WRITE off
and leaving the inbox as-is is safe. To fully undeploy: `supabase functions
delete inbox-promote`. Migration 026's table can stay (empty + harmless).

---

## Safety notes (why this is acceptable when gated)

- **Fail-closed everywhere.** No flag, no identity map, no propose-capable
  client ⇒ the tool does not exist. An unmappable connector is refused, not
  defaulted.
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
- **RLS hygiene** on `memory_inbox` / the promoter path is covered by the Mnestra
  migration's own five-gate receipt; re-run `get_advisors(type='security')`
  after applying 026 as the standing release check.

## What ORCH does at close vs. what stays deferred

- **ORCH at sprint close** applies live migrations (incl. 026 if not already) and
  may run Part A to have the drain ready — *only with Josh's go*.
- **Deferred until an explicit activation decision:** Part B (flipping
  `TERMDECK_BRIDGE_ENABLE_PROPOSE=1`). The channel ships dark; enabling it is the
  operator decision this runbook exists to make deliberate.
