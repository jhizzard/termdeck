# T1 — `grok-web` in mnestra's source-agent taxonomy (migration 024)

**Work repo:** `~/Documents/Graciella/engram`. STATUS.md lives in the termdeck repo (see PLANNING).

## Mission

Sprint 73 T1 (termdeck deck) is flipping the Grok web-chat panel's provenance to
`source_agent='grok-web'`. Today mnestra's taxonomy is `claude|codex|gemini|grok|orchestrator`
(see `migrations/015_source_agent.sql:43` and `migrations/022_source_agent_backfill.sql:182`).
Without your change, `grok-web` rows are either rejected or unfilterable — silent breakage.
Add `grok-web` everywhere the taxonomy is enforced or enumerated. You are the ATOMIC partner
of Sprint 73 T1: neither ships without the other.

## Scope

1. **Inventory first** (post as FINDING): every place the agent set is enforced or listed —
   `grep -rn "orchestrator" --include='*.sql' --include='*.js' --include='*.md' .` from the
   engram root. Expect at least: a CHECK constraint or domain (find the actual enforcement —
   migrations 015/022 comments describe, but locate the constraint), the MCP
   `memory_recall`/`memory_search` tool schemas' `source_agents` enum (the MCP server
   source), any writer-side validation in the webhook (`mnestra serve`) path, column
   COMMENTs, README/docs tables.
2. **Migration `migrations/024_source_agent_grok_web.sql`**: extend the
   constraint/enum + update the column COMMENT to add `grok-web`. Follow the global
   Supabase hygiene gates (PLANNING § Hard constraints) for any function you touch.
   Write it apply-ready; do NOT apply it to any remote project — ORCH applies at close.
3. **MCP tool schemas + recall filter**: add `grok-web` to the `source_agents` enum and any
   filter normalization; round-trip test (insert fixture row with `grok-web` → recall with
   `source_agents:["grok-web"]` returns it; `["grok"]` does NOT).
4. **Tests**: extend the existing migration/recall test idioms you find in the repo.

## NOT in scope

- The termdeck-side hooks/server changes (Sprint 73 T1 owns them; read their STATUS for
  coordination, never edit the termdeck repo).
- Applying migrations to any live project. Publishing `@jhizzard/mnestra`. Privacy_tags
  (#15/#20) — explicitly deferred, do not drift into it.

## Acceptance

1. Inventory FINDING with file:line for every enforcement/enumeration site.
2. Migration 024 apply-ready + hygiene-conformant.
3. Recall filter round-trip test green both directions (`grok-web` in, `grok` excludes).
4. DONE post names what Sprint 73 T1 must land for the atomic pair (exact hook constant + stamp).

## Lane discipline

Post shape: `### [T1] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in the termdeck-repo STATUS.md
(absolute path in PLANNING.md). Stay in lane. No commits, no version bumps, no CHANGELOG.

---

## ORCH ADDENDUM 2026-06-11 (scope expansion — binding)

The enum migration MUST add **all four** web-surface source_agents values in ONE migration —
`claude-web`, `chatgpt-web`, `grok-web`, `gemini-web` — not `grok-web` alone. Rationale: the
queued memory-inbox sprint (web chats write proposals via the bridge) depends on the other three,
and the enum + recall-filter + hooks surface should churn exactly once. Everything else in this
brief (recall-filter verification, RLS gates, atomicity with Sprint 73 T1) applies to all four
values identically. Only `grok-web` has a live producer today (the web-chat-grok panel); the other
three are forward-declarations — verify they are ACCEPTED by the enum/filters but do not invent
producers for them.
