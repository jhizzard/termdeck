# T2 — Projection surfaces (P1-4 · P1-5 · P1-6)

You own the reading surfaces: folder routing, Bases dashboards, and graph defaults — the
layer that makes 9k notes browsable. Read `docs/VAULT-READABILITY-RESEARCH-2026-08-02.md`
in full first. Your work lives in `packages/cli/src/vault-export.js` alongside T1's —
coordinate on the board; T1 restructures export to two-pass, you route file placement, so
sequence your folder-routing change after (or in explicit coordination with) T1's pass-1
landing to avoid churning the same functions blind.

## P1-4 — Folder routing (folders for purpose; links for meaning)

- `notes/<project>/` for ordinary memories · `communities/` for consolidation summaries ·
  `doctrine/` for doctrine rows · `snapshots/` for `pre_compact_snapshot` +
  `document_chunk`.
- Wikilinks are name-based, so re-foldering breaks nothing — but filename COLLISIONS across
  folders do break name-based links. Detect collisions during export and disambiguate
  deterministically.
- The payoff is one-clause graph pruning (`-path:snapshots`) — your P1-6 must use it.
- T3 is triaging P2-8 (date-prefix session/snapshot filenames) to ship in the SAME release
  so users churn their vault layout once — sync with T3 before you freeze naming.

## P1-5 — Emit `Memories.base` (core Bases plugin)

- **MANDATORY FIRST STEP: fetch and read the official Obsidian Bases syntax docs
  (help.obsidian.md — Bases) via WebFetch before writing any YAML. Do not write from
  memory; the syntax is newer than your training data. Post a FINDING with the doc URL and
  the syntax version you verified against.**
- Views: Last-30-days with recency-bucket formula (`10 - Today` / `20 - This Week` style),
  Decisions-by-project, Bugs, Sessions timeline, Community hubs.
- Views embed into Home/MOCs — T1 owns those files; hand T1 the exact embed block syntax on
  the board (this is the T1↔T2 seam; settle it early, it gates both lanes' DONE).
- Bases reads frontmatter properties — your views must reference EXACTLY the property names
  T1 lands in P0-2 (`tags`, `date`, `aliases`, `edge_count`, `up`, `hub`). Confirm the
  literal names with T1 on the board.

## P1-6 — Emit `.obsidian/graph.json` write-if-missing

- Write-if-missing ONLY — never clobber user tuning. If the file exists, leave it
  byte-untouched and note it in the export summary.
- Defaults: orphans hidden, `-path:snapshots` filter, color groups per `tag:#type/*`
  (coordinate literal tag prefixes with T1's P0-2), dim-by-currency if the schema supports
  it per the docs you fetched.
- Validate your emitted JSON against a real Obsidian `graph.json` sample (there may be one
  in the daily-driver vault's `.obsidian/` — READ-ONLY peek is fine; never write there).

## Discipline

Post shape `### [T2] <VERB> 2026-MM-DD HH:MM ET — <gist>` (VERB: FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE). Stay in lane; no version bumps, no CHANGELOG, no commits. DB
facts via read-only psql, not Mnestra MCP. WebFetch for the Bases docs is sanctioned (it is
NOT a browser-MCP tool); playwright/browser MCPs are banned. Never write to
`/Volumes/Crucial X6/mnestra-vault`. When blocked on another lane, post it and end your
turn; ORCH shepherds.
