# T4 — memory-proof surface + doctrine render/checks · Sprint 81
**Deck :3002 · cwd `…/TermDeck/termdeck` · Model Opus 4.8**

## Boot
1. `memory_recall(project="termdeck", query="TermDeck memory tab renderMemoryTab proactive_memory recall events route doctrine render flashback history")` then `memory_recall(query="recent decisions and bugs")`
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-81-recall-reinjection-proof/PLANNING.md` — **your charter is § T4**
4. Read the sibling `STATUS.md`

## Your work
**(1) DO FIRST — no upstream dep: `doctrine/render.js` extraction + checks starter.** Extract `renderDoctrineMarkdown()`/`buildRegistryEntry()` out of `packages/server/src/doctrine-sync.js` (`:173-259`) into new **zero-dep** `doctrine/render.js`; update both importers (`doctrine-sync.js`, `doctrine-cli.js`) + `packages/server/tests/doctrine-registry*.test.js`. Add a **starter checks suite** (frontmatter-present + one-principle-shape) + frontmatter retrofit per `doctrine/SCHEMA.md`. (Full 13-check battery from ULTRAPLAN §6 is large — starter subset now, note the remainder.) Keep vanilla-JS / CJS / zero-build.

**(2) THEN — gated on T1's 031: the memory-proof surface (CENTERPIECE UI).**
- Server: `GET /api/recall-events` (+ per-session variant) reading the extended `memory_recall_log`, modeled on the `flashback/history` route (`packages/server/src/index.js:3691`). **Fail-soft empty response** so you don't hard-park.
- Client: **EXTEND** `renderMemoryTab` (`packages/client/public/app.js:2376`) — it already renders `source_type`/`project`/`similarity`/`timeAgo` from `entry.memoryHits`. Add score, **doctrine chip highlight** for `source_type='doctrine'`, `recall_group_id` grouping (one recall = one reinjection event), and a link back to the consuming session. Cross-panel summary via existing `badge-memory-<id>`.

## Order / deps
Do (1) while T1 builds 031. **You will park** on T1's `FIX-LANDED` for 031 before (2) can read real columns — ORCH nudges you. Do NOT author engram migrations; you only READ `memory_recall_log`.

## Discipline
- Post `### [T4] VERB 2026-07-05 HH:MM ET — gist`. No version bumps / CHANGELOG / commits / publish.
- File-only; defer live queries to ORCH. Stage the read behind a fail-soft empty response so a missing table never breaks the panel.
