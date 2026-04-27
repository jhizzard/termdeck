# TermDeck Post-Sprint-38 Backlog

Single source of truth for everything queued beyond Sprints 37 (Orchestrator-as-product) and 38 (Knowledge graph + D3.js).

**Last updated:** 2026-04-27 (Sprint 36 v0.8.0 close-out)

This is the compressed view. Detailed audits and historical context live in `POST-LAUNCH-ROADMAP.md`, `IDEAS-AND-STATUS.md`, and the Mnestra memory store. Future sessions: read this file first; drop into the sources only when an item is scoped into an actual sprint.

## Scheduling note

Sprint 37 and Sprint 38 are the next two sprints, in that order. Their plans are at `docs/sprint-37-orchestrator-product/PLANNING.md` and `docs/sprint-38-knowledge-graph/PLANNING.md`. Joshua's stated goal at Sprint 36 close: ship 37 and 38 before Brad's next test round. Items below are POST-Sprint-38 unless explicitly tagged otherwise — **except the P0 section directly below, which is urgent enough to slot into 37/38 timeframe (exact placement TBD per orchestrator's recommendation)**.

---

## P0 — User-impacting blockers (urgent, schedule alongside 37/38)

**TermDeck has two users: Joshua (daily driver) and Brad (only outside user).** Anything that breaks the daily-driver flow for either is treated as a release-quality issue, not a backlog item.

- **🚨 FLASHBACK NOT FIRING IN JOSHUA'S DAILY FLOW (reported 2026-04-27 16:54 ET).** Joshua: "I still have not seen a SINGLE FLASHBACK since they stopped appearing." Sprint 21 fixed Flashback (root cause: stale RPC params causing 404 errors on `memory_hybrid_search`). Sprint 33 was a debug sprint that surface-validated the happy path: `[flashback] diagnostics fire in order, Mnestra returns 10 rows, proactive_memory WS frame delivered with real hit content`. **But Joshua has not actually seen a Flashback toast trigger in his real daily work since.** The likely cause is one of the deferred test failures from Sprint 36's "pre-existing 4" — specifically the two `PATTERNS.error` session.js cases (regex too narrow on Node errno + HTTP 5xx + canonical Unix shell `cat: /nope: No such file or directory` mid-line format). Sprint 33 identified the regex-too-narrow issue but the fix may not have shipped or may have regressed. **Action:** the "analyzer-pattern fix sprint" originally categorized in Section A.2 below is hereby promoted to P0 — it must ship before users will see what Sprint 21 promised. Likely shape: small focused sprint touching `packages/server/src/session.js` PATTERNS.error regex + a real-shell-fixture test pass + verification by triggering a `cat /nope` in a panel and confirming the toast renders. Could be folded into Sprint 38 sidecar (alongside Brad's hook fix) OR shipped as a v0.8.1/v0.9.1 hotfix. **Orchestrator's call at sprint planning time.**

- **🚨 Brad's empty-Mnestra ingestion fix — Mnestra-direct session-end hook.** Sprint 36 v0.8.0 shipped the MCP path migration + hook bundling, but the bundled `~/.claude/hooks/memory-session-end.js` delegates to `~/Documents/Graciella/rag-system/src/scripts/process-session.ts` — Joshua's private repo. Fresh users (i.e., Brad) get a hook that runs but silent-fails because `rag-system` doesn't exist on their box. Net effect: Brad's `pgvector` stays at 0 memories despite MCP wired and webhook bridge alive. **Joshua sent Brad a Mnestra-direct workaround hook on 2026-04-27 (`/tmp/brad-mnestra-hook.js`, ~120 LOC) — that proves the shape; the fix is to bring it home as the canonical bundled hook.** Two paths to close this in the published product:

- **🚨 Brad's empty-Mnestra ingestion fix — Mnestra-direct session-end hook.** Sprint 36 v0.8.0 shipped the MCP path migration + hook bundling, but the bundled `~/.claude/hooks/memory-session-end.js` delegates to `~/Documents/Graciella/rag-system/src/scripts/process-session.ts` — Joshua's private repo. Fresh users (i.e., Brad) get a hook that runs but silent-fails because `rag-system` doesn't exist on their box. Net effect: Brad's `pgvector` stays at 0 memories despite MCP wired and webhook bridge alive. **Joshua sent Brad a Mnestra-direct workaround hook on 2026-04-27 (`/tmp/brad-mnestra-hook.js`, ~120 LOC) — that proves the shape; the fix is to bring it home as the canonical bundled hook.** Two paths to close this in the published product:
  1. **Rewrite the bundled hook to call Mnestra MCP tools directly** (no `rag-system` dependency). The Brad workaround already does this — POSTs transcript JSONL summary to OpenAI for embeddings, then to Supabase REST `/rest/v1/memory_items`. Adapt and replace the current bundled file. **Recommended path** — closes the gap without depending on publishing another repo. ~120 LOC, well-bounded.
  2. Publish `rag-system` to npm. More work, exposes more surface area, doesn't help users who don't run `rag-system`. Not recommended.
  - **Scheduling decided 2026-04-27 16:55 ET:** **folded into Sprint 38 as orchestrator pre-sprint task.** Single-track, ~120 LOC, applied by orchestrator before the 4+1 graph lanes kick off, ships as part of the same v0.10.0/v1.0.0 release. Full scope in `docs/sprint-38-knowledge-graph/PLANNING.md` § "Orchestrator pre-sprint task — Brad's bundled-hook Mnestra-direct rewrite (P0)".

---

## A. Correctness gaps (test debt + flagged bugs)

- **~~Analyzer-pattern fix sprint~~** — **PROMOTED TO P0 above (2026-04-27 16:54 ET).** The 4 pre-existing test failures are no longer "deferred test debt" — at least 2 of them (the `PATTERNS.error` session.js cases) are the proximate cause of Flashback not firing in Joshua's daily flow. See P0 section.
- **V4-1 Rumen `relate` embedding test coverage** — 4 failure modes (AbortController timeout, non-2xx, malformed vector, network error) handled with zero unit tests. Mock `fetch` at the module boundary. Flagged by 4 auditors over Sprints 6/12.
- **V4-3 Mnestra direct-bridge contract drift** — bridge direct mode posts `recency_weight + decay_days` (10 args) but bundled `memory_hybrid_search` SQL takes 8; bridge reads `m.similarity`, SQL returns `score`. CONTRADICTIONS #1, open since Sprint 8. Partially closed by recent migration work; verify and close fully.
- **V4-5 Auth brute-force rate limiting** — `auth.js` does strict-equality token comparison with no failure delay or IP throttle. Add in-memory bucket delay; switch to `crypto.timingSafeEqual`. Flagged by 3 auditors.
- **V4-6 Security/deployment doc drift** — `SECURITY.md` says `termdeck_auth` cookie; code uses `termdeck_token`. `DEPLOYMENT.md` says `/healthz`; server exposes `/api/health`. Deployment example uses `server.host`; code reads `config.host`. Doc-only, low risk.
- **Migration-001 idempotency** — `CREATE OR REPLACE FUNCTION` return-type collision when re-running migrations against an already-upgraded store. Doesn't affect fresh installs. Two fix options: explicit `DROP FUNCTION ... CASCADE` before recreate, or a `schema_migrations` tracking table. Sprint-32 candidate, deferred. Currently in CHANGELOG `[Unreleased] Planned`.
- **Rumen-MCP gap** — Memories written via the MCP path land with NULL `source_session_id`, so they never reach Rumen Extract. Sprint-33 candidate. Currently in CHANGELOG `[Unreleased] Planned`.

## B. Adoption levers (cut new-user friction)

- **Supabase MCP in setup wizard** — Today's setup is 15+ manual steps for new users (Supabase project, 6 SQL migrations, secrets.env, config.yaml, mnestra serve, termdeck). The setup wizard could use a Supabase MCP server to automate provision + migrations + secrets, cutting it to "paste 2 credentials, click 3 buttons." Highest-leverage adoption lever in the backlog. Detail in `IDEAS-AND-STATUS.md` § Installation Fear.
- **Fully-local Mnestra path (V5-1)** — SQLite + local embeddings. Today Mnestra requires Supabase + OpenAI. Ship an opt-in local-only mode so TermDeck works with zero external dependencies. Already in CHANGELOG `[Unreleased] Planned`. Reinforces Codex "MCP mode least-proven" concern.
- **One-click install button** — A web page or CLI wizard that detects what's installed → provisions Supabase (or connects to existing) → runs migrations → writes config → starts everything. Pairs with Supabase MCP item.

## C. DX improvements (orchestration/dashboard polish)

- **PTY drag/drop window rearrangement** — Dashboard panel reorder via drag-handle. Inject identifier is the session UUID, not visual position, so drag-reorder won't break inject. Pure CSS Grid + drag-handle work in `packages/client/public/app.js`. Light lift. Sprint 36 candidate, deferred.
- **Control panel dashboard for agent permission prompts (V5-3)** — Aggregate activity feed with Yes/No buttons so AI agents running in panels can be approved without context-switching to each terminal. From March 31 ideas backlog.
- **`app.js` feature-module split (V5-4)** — Currently >3000 LOC and growing. Split into `app.js` + `health.js` + `transcripts-ui.js` + `settings.js` + `graph.js` (post-Sprint-38) before the next major UI addition. Flagged by Sprint 12 auditor.
- **Multi-tab dashboard sync hardening** — Sprint 36 T3 added `config_changed` WS broadcast for the RAG toggle; the same pattern should generalize to other config edits and session lifecycle events. Probably grows out of Sprint 37 dashboard work.

## D. Scaling concerns

- **Multi-user data validation (V5-2)** — All current testing is single-developer. Run a multi-user session against Mnestra and confirm no cross-tenant leakage. Required before any beyond-localhost story.
- **MCP bridge verification (V5-5)** — `mnestra-bridge` MCP mode (vs direct/webhook) jumps directly into `tools/call` against a stdio child with no repo-local test coverage. Add a contract test parallel to the direct/webhook paths. Flagged by Codex.
- **Edge inference for legacy tables** — Sprint 38 ships edge inference for `memory_items` only. Legacy `mnestra_*_memory` tables and transcripts are out of scope. If those corpora get re-activated (V0.5.x event-stream RAG users), inference needs to extend.
- **Cross-Mnestra-instance graph federation** — Multi-machine Mnestra users (Joshua + Brad sharing structural-mvp memories) will eventually want graph queries that span instances. Sprint 38 ships single-instance only; federation is a later sprint.

## E. Risky dependency upgrades (deferred indefinitely)

- **Express 5 migration** — High risk, currently pinned at 4.x. Likely blocks many other items if attempted.
- **Mnestra Zod 4 migration** — High risk, deferred. Mnestra is at Zod 3.x.
- **Node 18 → 20 LTS bump** — Not currently flagged but worth assessing as Node 18 EOLs.

## F. Companion artifacts (recommended but not required)

- **v0.8.0 blog post** at `docs-site/src/content/docs/blog/v08-launcher-parity.mdx` — Phase B reconciliation + the four-server-kill saga is good narrative material. Per RELEASE.md, recommended for notable releases. Joshua's voice required.
- **v0.9.0 blog post** at sprint 37 close — Orchestrator-as-product story. Should mark the moment TermDeck graduates from "browser tmux" to "orchestration platform."
- **v0.10.0 / v1.0.0 blog post** at sprint 38 close — Knowledge graph debut. Pair with marketing screenshots from T4's D3 view.

## How to use this file

When you (a future session) finish a scoped sprint and need to pick the next one, read this file top-to-bottom and pattern-match against:

1. **Urgency from external signals** — Brad reports a regression, an audit lands, a launch-readiness deadline arrives. Those override priority order.
2. **Theme grouping** — Don't run a Correctness sprint right after another Correctness sprint if morale needs a feature win. Mix categories.
3. **Compounding leverage** — A single fix that closes multiple items below counts higher than a 1:1 fix. Example: Mnestra-direct hook rewrite (B) closes Brad's full ingestion gap (B) AND obsoletes the rag-system publish path AND simplifies fresh-install testing.

When an item gets scoped into a sprint, move it from this file into the sprint's `PLANNING.md` and delete (or strike-through) it here. Don't leave it in two places — the sprint plan becomes authoritative once an item is in flight.

When new items surface (audit, user feedback, incident postmortem), add them here in the right category. Don't create a new ad-hoc roadmap doc; consolidate.
