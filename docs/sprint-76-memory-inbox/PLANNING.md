# Sprint 76 — Memory Inbox: web chats write proposals, CLIs write canonical

**Staged:** 2026-06-12 ~12:48 ET by ORCH.
**Pattern:** 3+1+1 (T1–T3 Claude workers, T4 Grok auditor).
**Sprint docs live HERE in the termdeck repo; every lane posts to this directory's STATUS.md
by absolute path** (cross-repo posting is proven practice — Sprint 74 ran the whole engram
deck against a termdeck-repo STATUS.md).

## Goal

Give web-chat surfaces (claude.ai / ChatGPT / Grok / Gemini) a WRITE path into Mnestra that
cannot poison the canonical store. Adopted design (2026-06-11, binding — see
`docs/RESTART-PROMPT-2026-06-11-gemini-ha-windows-and-sprint-path.md` § 2b):

> **Policy: "CLIs write canonical; web chats write proposals."**

Concretely:

1. A new `memory_inbox` table in engram (migration 026) holds web-originated proposals in
   quarantine. The ONLY insert path is a validating `SECURITY DEFINER` RPC
   `memory_propose(...)`. Pending rows are **invisible to every recall path** until promoted.
2. The MCP Bridge exposes a `memory_propose` tool to web connectors ONLY. Canonical
   `memory_remember` stays absent from the web surface (the bridge's read-only-by-construction
   posture becomes "read-only plus exactly one quarantined proposal channel").
3. A Rumen promotion pass drains the inbox asynchronously: dedup vs canonical,
   kitchen-vs-recipe test, redaction/size/rate gates → promote (canonical insert with
   provenance preserved, `promoted_memory_id` + `status='promoted'` stamped) or reject
   (`status='rejected'` + `rejection_reason`).
4. A Grok auditor adversarially attacks all three lanes — the quarantine proof is the
   headline audit item.

**Why quarantine instead of direct write:** a web chat's context window contains whatever the
web page / pasted content / other tool results put there — prompt-injection in a web surface
must not be able to write directly into the store every CLI session trusts at boot. The inbox
is the trust boundary; Rumen's gates are the customs check; provenance (`source_agent` =
`*-web`) survives promotion so a poisoned row remains attributable and filterable forever.

## Dependency note — prereqs ALL SHIPPED (mnestra 0.5.0)

- **Four `*-web` enum values** (`claude-web` / `chatgpt-web` / `grok-web` / `gemini-web`):
  shipped in migration `025_source_agent_web_surfaces.sql` + `src/types.ts` `SOURCE_AGENTS`
  (Sprint 74 T1; applied to the daily-driver project 2026-06-12).
- **Webhook `source_agent` threading**: shipped in 0.5.0 (`webhook-server.ts` remember op
  forwards `args.source_agent`; `remember.ts` normalizes + threads it into INSERT;
  `RememberInput.source_agent` in `types.ts`).
- **Layered-schema awareness**: `src/layered.ts` (index/timeline/get) exists and is part of
  the recall-path inventory T1/T4 must prove clean of the inbox.
- Migration slot **026 is the next free slot** (025 = web source_agents, 024 = email-assistant
  recall, a separate initiative — do not touch it).

No lane blocks on any other sprint. T2 consumes T1's webhook op contract; the contract is
fully specified in the briefs so T2 can build against it before T1 posts FIX-LANDED, then
verify against T1's landed shape.

## Lanes

| Lane | cwd (panel working directory) | Scope | Brief |
|---|---|---|---|
| T1 | `~/Documents/Graciella/engram` | Migration 026 `memory_inbox` + `memory_propose` RPC (five RLS gates) + TS types + webhook op `propose` + quarantine-by-construction proof + tests | `T1-inbox-schema.md` |
| T2 | `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` (packages/mcp-bridge) | Bridge `memory_propose` tool — web connectors only; policy carve-out; connector→`*-web` identity; per-connector rate limits; ingress redaction scan; size caps; tests | `T2-bridge-propose-tool.md` |
| T3 | `~/Documents/Graciella/rumen` | Promotion pass — inbox as a new Rumen source: gates (dedup, kitchen-vs-recipe, caps) → promote or reject; batched, idempotent, fail-soft, edge-function-deployable; tests + fixtures | `T3-rumen-promotion.md` |
| T4 | `~/Documents/Graciella/engram` (read-only, cross-repo reads allowed) | Grok adversarial auditor: five-gate verification on live SQL, quarantine attack via EVERY recall path, propose-path abuse, CHECKPOINT discipline | `T4-grok-auditor.md` |

## Accepted trade-off — async promotion latency (by design)

A proposal is NOT immediately recallable. The promotion pass runs on Rumen's existing async
cadence (rumen-tick class scheduling); a web-chat proposal becomes canonical minutes later,
or never (rejected). This is the same accepted-staleness class as Sprint 74 T3's
flush-before-recall verdict — deliberate, documented, and the price of the quarantine. Do not
"fix" it in any lane. (Raw CLI captures remain synchronous and unaffected — Sprint 74 T3
proved that path has zero staleness.)

## Hard constraints

- **Supabase hygiene — all FIVE gates apply to migration 026** (global `~/.claude/CLAUDE.md`
  § "MANDATORY: Supabase RLS + privilege hygiene"; use the migration template there):
  1. RLS **enabled** on `memory_inbox` in the same migration that creates it.
  2. **No** `WITH CHECK (true)` / PUBLIC policies — in fact NO policies at all on this table;
     service_role and the DEFINER RPC are the only actors.
  3. Every function: `REVOKE EXECUTE ... FROM PUBLIC;` then targeted
     `GRANT EXECUTE ... TO service_role;` only.
  4. Every function: `SET search_path = public, pg_catalog`.
  5. No raw anon-key write path — `memory_propose(...)` (validating SECURITY DEFINER RPC) is
     the only INSERT path for proposals.
- Migrations are written + tested locally; **nobody applies anything to the daily-driver
  project from a lane** — ORCH applies at close.
- The internal Supabase project name/ref NEVER appears in any artifact (use `<project-ref>`).
- No version bumps, no CHANGELOG edits, no commits, no publishes inside lanes — ORCH at close.
- All new tests land inside each repo's canonical test glob (engram: `tests/*.test.ts` compiled
  + run by `npm test`; termdeck bridge: `packages/mcp-bridge/test/*.test.js`; rumen:
  `tests/*.test.ts`) — a test that exists but isn't picked up by `npm test` does not count.
- ORCH STATUS.md decisions are binding on all lanes, **including after a lane has posted DONE**.

## Acceptance (ORCH judges at close)

1. **T4 FINAL-VERDICT GREEN** — the sprint does not close on worker DONEs alone.
2. **The quarantine proof**: demonstrated evidence (test + audit) that a `status='pending'`
   inbox row is unreachable through EVERY read surface — `memory_recall`,
   `memory_hybrid_search` (direct RPC), `memory_search`, `memory_index`, `memory_timeline`,
   `memory_get`, `memory_recall_graph`, webhook ops, MCP tools, and the bridge read tools.
3. T1: migration 026 apply-ready + five-gate-conformant; webhook `propose` op + TS types +
   tests green over the merged working tree.
4. T2: `memory_propose` mounted for web connectors with honest annotations; policy carve-out
   is explicit and tested (memory_remember/memory_forget still rejected at mount); ingress
   redaction + size caps + per-connector rate limits tested; bridge suite green.
5. T3: promotion pass promotes a clean fixture, rejects each gated class with the right
   `rejection_reason`, is idempotent under re-run/concurrency, fail-soft per row, and is
   deployable per rumen's existing edge-function pattern; rumen suite green.

## Out of scope

- **Gemini Enterprise connector (static-OAuth client)** — that is Sprint 75 (bridge wave).
  This sprint does not touch `mcp-bridge/src/auth.js`'s client-registration model.
- **Turning ON any web connector's write access in PROD config** (mounting `memory_propose`
  live on the public bridge + applying migration 026 to the daily-driver project) **stays a
  Josh decision at sprint close** — lanes ship the capability dark; ORCH stages the rollout.
- Bridge HA / cloud third origin (Sprint 75 T3); Windows support (demand-gated backlog);
  privacy_tags design answers (mnestra #15/#20); Brad R730 cutover.
- Any UI for browsing/manually approving the inbox (future sprint; the schema's status
  fields are designed so a UI can be added without migration churn).

## Lane discipline (all lanes — Sprint 73/74 lessons baked in)

- **Post shape, ALL posts, ALL lanes (workers included):**
  `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` — the `### ` prefix is mandatory.
  Verbs: FINDING / FIX-PROPOSED / FIX-LANDED / BLOCKED / DONE / AUDIT-PASS / AUDIT-FAIL /
  AUDIT-CONCERN / CHECKPOINT / FINAL-VERDICT / HANDOFF-REQUEST / HANDOFF-ACK.
- STATUS.md absolute path (every lane posts here, regardless of cwd):
  `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-76-memory-inbox/STATUS.md`
- **Idle-polls use tolerant regexes**: `^(### )?\[T<n>\] DONE\b` (and
  `^(### )?\[T4-GROK\] FINAL-VERDICT\b` for the periphery watch) — never anchor on the
  `### ` prefix alone.
- **PERIPHERY WATCH after DONE**: posting DONE does not end your lane. BEFORE posting DONE,
  re-read STATUS.md for unacknowledged `HANDOFF-REQUEST`s addressed to you and answer them.
  AFTER posting DONE, keep re-reading STATUS.md until T4 posts FINAL-VERDICT — answer any
  `AUDIT-*` finding or `HANDOFF-REQUEST` that names your lane. A RED/AUDIT-FAIL against your
  lane re-opens it; RED ≠ parked.
- T4 posts `### [T4-GROK] CHECKPOINT ...` at every phase boundary AND at least every 15
  minutes of active work (compaction self-orientation — see T4 brief).
