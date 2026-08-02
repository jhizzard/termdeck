# T1 — Exporter topology (P0-1 · P0-2 · P0-3)

You own `packages/cli/src/vault-export.js`. Your three items are the highest-payoff of the
sprint: they convert the orphan cloud into hub-and-spoke overnight. Read
`docs/VAULT-READABILITY-RESEARCH-2026-08-02.md` in full before coding — it is the scope's
source of truth and is code-grounded.

## P0-1 — Render community membership (do this first)

- Consolidation-summary notes (`source_type='consolidation_summary'`): add a `## Members`
  section — one piped wikilink per entry in `metadata.consolidation.member_ids`, aliased to
  the member's human title so the list reads as prose: `[[<member-file>|<member title>]]`.
- Each member note gets `up: "[[<hub-file>]]"` in frontmatter AND a `Part of: [[<hub>|<hub
  title>]]` body line. Build the reverse map (member_id → hub) in a first pass over the
  store BEFORE rendering any note — export is currently single-pass; restructure to
  two-pass (collect, then render).
- Summaries get `hub: true` frontmatter.
- Edge cases you must handle, not punt: a member_id that resolves to no exported note
  (skip the link, count it, report the count in the export summary line — never emit a
  dangling wikilink); a note belonging to multiple communities (`up:` becomes a list);
  member_ids empty or missing (render no Members section, no crash).
- Fixture `packages/cli/tests/vault-export.test.js:95` proves `metadata.consolidation`
  reaches renderNote() today — start there to see the data shape.

## P0-2 — Frontmatter upgrades (additive; keep the existing `edges:` block)

- `tags: [project/<project>, type/<source_type>]` — nested tags, exactly this shape (they
  drive the tag pane + T2's graph color groups; coordinate the literal prefix strings with
  T2 before either of you lands).
- `date: YYYY-MM-DD` derived from created_at.
- `aliases: [<slug with uuid suffix stripped>]` so search shows human titles.
- `edge_count: <n>`.

## P0-3 — Generated `Home.md` + per-project `MOC - <project>.md`

- Home: generated banner, store stats (note/link counts, freshness), community hubs listed
  by member_count desc, doctrine links, 15 newest decisions/bug_fixes as static piped
  wikilinks, and an embedded Bases view block for the long tail — T2 owns `Memories.base`;
  agree on the embed syntax with T2 on the board before landing (leave a clearly marked
  placeholder if T2 hasn't confirmed syntax yet, and reconcile before DONE).
- MOC per project: cap at communities + top-N recent (N≈25); the tail belongs to
  Bases/search, not the MOC. Titles are claims; links are piped.
- Both regenerate every export (atomic per run — regeneration replaces them; no
  write-if-missing semantics here, that's only for T2's graph.json).

## Tests

Unit tests you need to develop safely are yours; the golden-file overhaul is T3's. Post
FIX-LANDED with file:line when each P0 lands so T4 can WIP-audit and T3 can build goldens
against real output. Coordinate the render order/format details T3 asks for.

## Discipline

Post shape `### [T1] <VERB> 2026-MM-DD HH:MM ET — <gist>` (VERB: FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE). Stay in lane; no version bumps, no CHANGELOG, no commits.
DB facts via read-only psql, not Mnestra MCP. No browser tools. Never write to
`/Volumes/Crucial X6/mnestra-vault` — temp dirs only. When blocked on another lane, post it
and end your turn; ORCH shepherds.
