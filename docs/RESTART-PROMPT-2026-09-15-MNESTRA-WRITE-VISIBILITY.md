# RESTART PROMPT — 2026-09-15 — Mnestra write-visibility incident (web surfaces silent since Sept 5)

Session: Fable General + 3 Opus commanders (C1 bridge, C2 CLI hooks, C3 DB ledger). Committed locally; publish + push pending Josh.

## Verdict
- **CLIs never stopped writing.** claude / codex / grok / orchestrator wrote `memory_items` every day Sept 1–15. The hook log labeled benign content-hash dedup (HTTP 409 / SQLSTATE 23505) as `memory_items=fail` — phantom failures.
- **Web surfaces (Claude.ai, ChatGPT, Grok web) never had a working write path.** The bridge is read-only by policy; their only channel is `memory_propose` → `memory_inbox` (quarantine) → Rumen `inbox-promote`. `memory_session_record` (automatic capture) was unmounted (flag unset) and needs mnestra ≥ 0.12 (global was 0.11.0). Claude.ai and ChatGPT have NEVER called `memory_propose` (0 rows ever); the tool description never told them when to. Last inbox row: 2026-09-06 01:28Z (grok-web, rejected "recipe-level") — that is the "nothing since Sept 5".
- **Rumen gate rejected 15/24 proposals as recipe-level, silently.**
- **Recall timeouts** (`memory_hybrid_search` statement timeout) presented to web chats as a dead connector: PostgREST runs RPCs under `authenticator`'s 8s timeout (SET ROLE does not re-evaluate role GUCs); project-filtered queries abandon HNSW and detoast every vector; two byte-identical 95 MB embedding indexes.
- Migrations 037–039 ARE applied (C1's probe searched for a function named after the FILE, `graph_walk`; the RPC is `memory_recall_graph_boosted`). Engram has no migration ledger table and no `migrate` subcommand — artifact-probe only.
- The `claude.ai Mnestra` connector banner "No claude.ai OAuth token available" in Claude Code is a claude.ai-side token gap (bridge saw 0 /authorize) — re-auth via `/mcp`.

## Commits (local, NOT pushed, NOT published)
| repo | commit | version |
|---|---|---|
| engram | f46c2a2 (+ follow-up) | @jhizzard/mnestra 0.14.0 — migrations 039 (tracked), 040 timeout+index hygiene, 041 `memory_inbox_staleness()` + `memory_propose_status(uuid)`; serve ops `propose_status`, `inbox_staleness` |
| rumen | 00af095 + pin commit | @jhizzard/rumen 0.13.0 — recipe verdicts PROMOTE tagged `category=recipe`, confidence 0.5 in metadata; `PromoteSummary.promoted_kitchen/promoted_recipe`; inbox verdict stamp; `supabase/functions/inbox-promote` pin 0.6.0 → 0.13.0 |
| termdeck | 6fa8897 + follow-up | @jhizzard/termdeck 1.22.0 + @jhizzard/termdeck-stack 1.19.0 — `memory_propose_status` tool, `/healthz.inbox`, `scripts/sync-propose-map.js`, propose description WHEN-TO-CALL, hooks 409→dup, `~/.termdeck/hook-project-map.local.json` overrides, pre-compact v4, doctor "Memory-write health" |

## Already live on this machine (no publish needed)
- `~/.termdeck/bridge-propose.json` 7 → 17 web clients (backup `.bak-2026-09-15`); loader re-reads per call.
- `~/.claude/hooks/memory-session-end.js` + `memory-pre-compact.js` byte-identical to repo (backups `.bak.20260915`, `.bak.20260915-v2`).
- `~/.termdeck/hook-project-map.local.json` (0600) carries the private project-map rule. Machine-local; recreate on rebuild.
- `~/.termdeck/supervisor.env` line 39: `#TERMDECK_BRIDGE_ENABLE_SESSION_RECORD=1` staged, commented.

## Josh's ordered runbook
See the "ordered command list" in the 2026-09-15 wrap email / session close message. Summary: npm login → publish mnestra 0.14.0, rumen 0.13.0, termdeck 1.22.0, termdeck-stack 1.19.0 → `npm view` each → push+tag 3 repos → `npm i -g @jhizzard/mnestra@0.14.0` + kickstart `com.jhizzard.mnestra-serve` → psql 040 (not in a tx) then 041 → uncomment SESSION_RECORD flag → kickstart `com.jhizzard.termdeck-supervise`, kill :8870 bridge → healthz tools 8 → `supabase functions deploy inbox-promote` (rumen) → `/mcp` re-auth claude.ai connector → one `memory_propose` per web surface → `select max(created_at), source_agent from memory_inbox group by 2`.

## Open follow-ups
1. Rumen edge-function pins drift: rumen-tick 0.6.1, doctrine-scan 0.7.0, rumen-reinforce 0.8.0, extract-sweep 0.11.0, objective-guard/graph-consolidation 0.11.1. Bump + redeploy in one sprint.
2. Engram migration ledger (`mnestra_migrations` table + `mnestra migrate`).
3. Open WebUI connectors unmappable: `policy.js::WEB_SOURCE_AGENTS` lacks the openwebui value migration 039 added (trust-boundary change).
4. `bridge-auth.json` expired-token prune (cosmetic; script in session scratchpad, Secret-Store write needs Josh).
5. `packages/server/src/memory-pressure.js` + test dirty from another session — not committed here.
6. Gemini web: 2 inbox rows Aug 2, none since; same propose/session_record fix applies if its connector is still attached. Gemini CLI / agy read via their own MCP configs.
7. Consider `hnsw.iterative_scan` A/B (documented in migration 040, not enabled).

## Memories written (Mnestra, project=termdeck/mnestra, sprint_ref=mnestra-silent-writes-2026-09-15)
Ledger-first triage; PostgREST authenticator timeout + HNSW abandonment; vendored-hook drift (stale vs private carve-out) + overrides pattern; bridge read-only exemption shape; SESSION STATE row.

## Addendum 17:15 ET — runbook executed, all surfaces verified
- Published + pushed: mnestra **0.14.1** (0.14.0 shipped a stale dist — no prepublishOnly; fixed), rumen 0.13.0, termdeck 1.22.0, termdeck-stack 1.19.0. Migrations 040/041 applied via the session pooler (`DATABASE_URL` in secrets.env is the transaction pooler with `?pgbouncer=true`; psql needs the query string stripped and port 6543→5432).
- **Origin skew found**: public hostname fronts iMac + Air + cloud origins. Air was at 1.20.1 / mnestra 0.6.0 / no flags / no propose map → 6 tools; ChatGPT's 7 client registrations live only on the Air, so chatgpt-web never saw memory_propose. Air brought to parity (82db36f, 0.14.1, flags, propose map 25 clients, local edits stashed as `air-local-2026-09-15`). Web connectors cache the tool list at add time: ChatGPT needed remove + re-add.
- End-to-end proof: grok-web proposal 20:34Z **promoted** by the redeployed gate; chatgpt-web 21:05Z and four claude-web (one per account) 21:09–21:13Z pending → promote on the next 10-min pass. Bridge /healthz on both origins: tools 9 + inbox field.
- New follow-up: cross-origin parity check (tool-count diff across imac-bridge / air-bridge / cloud) in `termdeck doctor` or the watchdog.
