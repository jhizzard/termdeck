# Sprint 69 — Vault Readability (the navigation layer for the Obsidian projection)

**Date:** 2026-08-02 · **Substrate:** TermDeck deck on :3001, 4 panels at the termdeck repo cwd
**ORCH:** Claude session `680c5f56` (successor to `36a78c3b`) · **Pattern:** 3+1+1 (3 Claude workers + 1 Codex auditor + orchestrator)
**Scope source:** `docs/VAULT-READABILITY-RESEARCH-2026-08-02.md` (code-grounded; read it in full before writing code)

## Mission

The vault (`termdeck vault export`, 9,118 notes / 5,970 wikilinks as of 2026-08-02) is a
correct read-only projection of the Mnestra store — and unreadable, because the projection
is missing its **navigation layer**: topology (hubs + membership links) and schema
(tags/date/aliases frontmatter). Only the exporter can emit that layer. This sprint makes a
fresh export open in Obsidian as hub-and-spoke neighborhoods with a Home note, per-project
MOCs, Bases dashboards, and sane graph defaults — instead of an orphan cloud.

**Grounding facts (verified in code, do not re-litigate):**
- Exporter: `packages/cli/src/vault-export.js`. Flat `notes/` today.
- `renderNote()` reads `metadata.consolidation` for the banner but never renders
  `member_ids` as wikilinks. Fixture `packages/cli/tests/vault-export.test.js:95` proves
  the data flows.
- Frontmatter today: id/project/source_type/category/created_at/source_agent/edges — NO
  tags/date/aliases.
- Nothing emits `.obsidian/graph.json` or any `.base` file.
- Regeneration is manifest-swept in place (unlink prior manifest files, then write —
  `vault-export.js:438-468`; NO temp-tree rename/rollback; see board RULING R-1) →
  naming/layout changes are cross-run safe ONLY for manifest-tracked files; generated
  files must join the manifest, and `graph.json` must be excluded from the sweep.
- Consolidation data is LIVE: 40 `consolidation_summary` rows this morning, draining
  toward ~72 nightly (04:00 UTC). `member_ids` is populated.

## Scope by lane

| Lane | Owns | Items |
|---|---|---|
| T1 | Exporter topology | P0-1 member wikilinks + `up:` backlinks + `hub: true` · P0-2 frontmatter upgrades (tags/date/aliases/edge_count) · P0-3 generated `Home.md` + per-project `MOC - <project>.md` |
| T2 | Projection surfaces | P1-4 folder routing (`notes/<project>/`, `communities/`, `doctrine/`, `snapshots/`) · P1-5 `Memories.base` emission (official Bases YAML — read the docs first) · P1-6 `.obsidian/graph.json` write-if-missing |
| T3 | Tests / docs / P2 triage | Golden-file test overhaul + byte-stability fence · doc surfaces · P2 triage (P2-8 date-prefix filenames SHOULD ship with P1-4 — churn once; P2-7 rollups + P2-9 typed fields implement-or-defer with recorded rationale) |
| T4 | Codex adversarial audit | Fresh-export-to-empty-dir acceptance harness · dangling-link + reverse-map verification · goldens byte-stable across two runs · WIP audit before FIX-LANDED · FINAL-VERDICT |

**Non-goals (do NOT touch):** installer surface (Brad's Windows + migration-safety items —
separate BACKLOG track) · Gemini read-ramp mirror · Dataview · auto-Canvas · anything in
`packages/stack-installer` beyond what the wave bump requires (ORCH-owned anyway).

## Acceptance (sprint is GREEN only if all hold)

1. Root `npm test` green, zero fails.
2. Fresh export into an empty temp dir: every `consolidation_summary` note carries a
   `## Members` section of piped wikilinks; every member note carries `up:` pointing at an
   existing hub file; zero dangling generated wikilinks (scripted check, not eyeball).
3. `Home.md` + MOCs exist and link only to files that exist; `Memories.base` is valid per
   official Bases syntax; `.obsidian/graph.json` is valid JSON and is NOT overwritten when
   already present.
4. Two consecutive exports of the same store state are byte-identical (any intentional
   timestamp exceptions explicitly fenced and documented).
5. Real vault regen on the daily driver (`/Volumes/Crucial X6/mnestra-vault`) run at close
   by ORCH — structural spot-checks pass. (Josh's Obsidian eyeball happens when he's back
   at the machine; structural checks are the sprint gate.)

## Wave (ORCH-only, at close)

`@jhizzard/termdeck` 1.18.0 → **1.19.0** · `@jhizzard/termdeck-stack` 1.16.0 → **1.17.0**
(audit-trail bump). Version bumps, CHANGELOG, commit, publish hand-off, push, tag: all
orchestrator, per RELEASE.md strict order. No lane touches any of it.

## Lane discipline (all lanes)

- Post shape, exact: `### [T<n>] <VERB> 2026-MM-DD HH:MM ET — <gist>` where VERB ∈
  FINDING · FIX-PROPOSED · FIX-LANDED · BLOCKED · DONE (T4 adds AUDIT-PASS · AUDIT-FAIL ·
  CHECKPOINT · FINAL-VERDICT, posting as `[T4-CODEX]`).
- Stay in lane. Cross-lane 2-line fixes require explicit ORCH authorization on the board.
- Verify DB facts via **read-only psql** (`DATABASE_URL` in `~/.termdeck/secrets.env`) —
  the Mnestra MCP recall path hangs under load (S68R: three wedges). One boot-time recall
  attempt is fine; if it stalls, skip it and move on. No MCP calls on your critical path.
- No browser/playwright MCP tools — known hang/OOM vector, will be culled on sight.
- Do NOT write to the daily-driver vault (`/Volumes/Crucial X6/mnestra-vault`) — dev/test
  against temp export dirs only.
- Workers: if you finish available work and are waiting on another lane, post the wait on
  the board and END YOUR TURN — ORCH shepherds handoffs; don't poll.

## Resolution

**FINAL-VERDICT GREEN 2026-08-02 11:26 ET** — inject 10:55, verdict 11:26 (~31 min), zero
RED verdict cycles; every defect was caught and fixed in-flight via T4 WIP audit + ORCH
rulings (R-1 atomicity correction, R-2 ten-item seam consolidation, R-3 dangling-gate
narrowing + SEAM-NOTE on the `wroteGraph` two-lanes-one-file break). Lane closes: T1 DONE
11:12 (P0 topology verified on a real 9,169-note export, 429↔429 symmetric reverse map,
0 dangling generated links) · T3 DONE 11:21 (11-fence harness + goldens + net-new
ARCHITECTURE/GETTING-STARTED vault docs; root gate 1,343/1,338/0/5) · T2 DONE 11:25
(P1-4/5/6 + P2-8, Bases verified against official 1.10.3 docs, two-layer graph.json
manifest exclusion). P2-7 + P2-9 deferred with recorded designs (BACKLOG). Acceptance #5
executed at close: real daily-driver regen (9,171 notes + Home + 31 MOCs + 40 linked hubs +
Memories.base; pre-existing tuned graph.json left byte-untouched — write-if-missing proven
live). Wave shipped as termdeck **1.19.0** + stack **1.17.0**. Six follow-on BACKLOG items
recorded. **Acceptance FULLY CLOSED 2026-08-03: Josh's Obsidian eyeball verified hubs +
members opening normally (after an Obsidian metadata-cache rebuild — the vault itself was
correct throughout) and `#ProjectFeed` RENDERING ROWS — the one undocumented Bases
construct (`this.<noteProperty>`) is CERTIFIED working. All 31 MOCs carry live
self-filtering feeds.**
