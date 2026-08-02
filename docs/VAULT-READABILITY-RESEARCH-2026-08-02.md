# Vault readability — research + prioritized exporter plan (2026-08-02)

Research fan-out triggered by Josh: "mine isn't even readable" + the @SpikeCalls X post
(2069815843186176126, ~9.1M views). Full agent report in session `36a78c3b` transcript;
this doc is the durable synthesis and the **Sprint-69 prime-candidate scope**.

## The verdict in one line

Our architecture is exactly what the strongest critiques say is CORRECT (real DB as the
store, markdown vault as a read-only projection) — the vault is unreadable purely because
the projection is missing its **navigation layer**: topology (hubs + membership links) and
schema (tags/date/aliases frontmatter). Only the exporter can fix topology; no plugin can.

## What the viral setups actually do right

The X post ("Claude + Obsidian turned 400 dead notes into a brain…", installable Claude
Code plugin; command set closely matches github.com/eugeniughelbur/obsidian-second-brain):
every ingested item is **born linked** (8–15 cross-referenced pages per source, never an
orphan); a **maintenance loop de-orphans and repairs dead links**; a **single index note is
read first**. The graph screenshot is the marketing; the linking discipline is the product.
(The related "leaked 8,893-node vault" genre got community-noted as engagement bait — a
graph at our scale is only readable if deliberately pruned and hubbed.) Closest architectural
sibling: `agentcairn-obsidian` — color by project, size by importance, dim by currency,
**facet hub nodes** with members clustered around them.

## The 8 reliable patterns (condensed)

1. **Hub-and-spoke beats mesh** — Home → per-domain MOC hubs → leaves; layout physics turns
   named neighborhoods out of hairballs. Hub per ~5+ notes; a hub with thousands of links is
   as useless as none.
2. **"A note without links is a bug"** — and the reliable de-orphaning edge is
   **containment** (member-of-community, part-of-project, logged-on-week), which is always
   available, unlike sparse semantic edges.
3. **Frontmatter as schema, dashboards as the reading surface** — at 9k notes nobody browses
   files; they browse **Bases** views (core plugin, proven at 20k+ notes). Consistent flat
   properties, real dates, recency-bucket formulas (`10 - Today` / `20 - This Week`).
4. **Graph pruning is subtractive** — filter whole classes (`-path:snapshots`), hide
   orphans, color groups per type, dim stale.
5. **Folders for purpose (path-filters, quarantining noise); links for meaning.** Wikilinks
   are name-based — re-foldering breaks nothing.
6. **Time rollups** — weekly notes linking that period's items with prev/next; "what
   happened around then" is the most common human query and search doesn't answer it.
7. **Index-first + visible provenance** — Home.md read-first; generated-banner + freshness/
   superseded badges.
8. **Titles are claims; piped link aliases** so hub lists read as prose; `aliases:` so
   search shows human titles, not uuid slugs.

## The prioritized exporter plan (`packages/cli/src/vault-export.js`)

Grounding facts verified in code: flat `notes/`; frontmatter has id/project/source_type/
category/created_at/source_agent/edges but NO tags/date/aliases; **`renderNote()` reads
`metadata.consolidation` for the banner but never renders `member_ids` as wikilinks**
(fixture proves the data is there: `packages/cli/tests/vault-export.test.js:95`); nothing
emits `.obsidian/graph.json` (Josh's tuning is hand-made and wouldn't survive a fresh
target). Regeneration is atomic per run, so naming/layout changes are cross-run safe.

- **P0-1 (highest payoff, smallest effort): render community membership.** Consolidation
  summaries get a `## Members` section of piped wikilinks from `member_ids`; each member
  note gets `up: "[[<hub>]]"` frontmatter + a `Part of:` body line (reverse map built during
  export). Summaries get `hub: true`. **This one change converts the orphan cloud into
  hub-and-spoke clusters overnight** — the consolidation data started landing 2026-08-01
  precisely for this.
- **P0-2: frontmatter upgrades** — `tags: [project/<p>, type/<t>]` (nested → tag-pane nav +
  graph color groups), `date: YYYY-MM-DD`, `aliases: [<slug sans uuid>]`, `edge_count`.
  Additive; keeps the existing `edges:` block.
- **P0-3: generate `Home.md` + per-project `MOC - <project>.md`** — stats, community hubs
  by member_count, doctrine, 15 newest decisions/bug_fixes as static wikilinks + an embedded
  Bases block for the long tail. MOCs cap at communities + top-N; the tail is Bases/search.
- **P1-4: folder routing** — `notes/<project>/`, `communities/`, `doctrine/`, `snapshots/`
  (pre_compact_snapshot + document_chunk). Enables `-path:snapshots` one-clause pruning.
- **P1-5: emit `Memories.base`** (official Bases YAML syntax) — views: Last-30-days recency
  buckets, Decisions-by-project, Bugs, Sessions timeline, Community hubs; embed views in
  Home/MOCs. Core plugin — zero installs.
- **P1-6: emit `.obsidian/graph.json` write-if-missing** (never clobber user tuning) —
  orphans off, `-path:snapshots`, color per `tag:#type/*`. Fresh exports readable
  out-of-the-box.
- **P2-7: weekly rollups** `rollups/<project>/2026-W31.md` with prev/next.
- **P2-8: date-prefix session/snapshot filenames** (same release as P1-4 — churn once).
- **P2-9: Breadcrumbs-compatible typed fields** (`up:` from P0-1 already feeds it; optional
  per-edge-type list props). Skip auto-Canvas — low value for a read-only corpus.

## Plugins

Enable core **Bases** (exporter emits the .base files). Optional manual installs that
consume our frontmatter: **Breadcrumbs** (maintained), **Juggl**, Daily Notes Timeline
(after P2-7). Dataview = legacy for this use; kepano's agent skills are write-side, N/A for
a read-only projection. Everything that failed is topology + schema — export-generated only.

## Sizing

P0-1 + P0-2 + P0-3 = **one small sprint lane** in `vault-export.js` + golden-file test
updates. Delivers most of the visible transformation. P1 tier = the second lane of the same
sprint. Natural 3+1+1: T1 exporter topology (P0-1/2/3), T2 dashboards + graph defaults
(P1-4/5/6), T3 tests/docs/goldens + P2 triage, T4 audit.
