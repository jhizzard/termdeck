# T3 — Golden-file test overhaul · docs · P2 triage

You own the proof layer: the test suite that pins the new projection shape, the doc
surfaces, and the P2 triage decisions. Read
`docs/VAULT-READABILITY-RESEARCH-2026-08-02.md` in full first.

## Golden-file test overhaul

- `packages/cli/tests/vault-export.test.js` + its fixtures/goldens: rebuild around the new
  topology. Goldens must cover: a consolidation summary with `## Members` piped wikilinks;
  a member note with `up:` + `Part of:`; multi-community membership (`up:` list); the
  no-member / dangling-member_id edge cases; P0-2 frontmatter (tags/date/aliases/
  edge_count); Home.md; one MOC; T2's folder routing; `Memories.base`; graph.json
  write-if-missing (present → untouched, absent → written).
- **Byte-stability fence:** a test that runs the export twice against the same fixture
  store and asserts byte-identical output trees. Any intentional nondeterminism
  (timestamps) must be either eliminated or explicitly fenced + documented — flag every
  instance you find as a FINDING.
- Build goldens against T1/T2's REAL landed output, not your guess — sequence behind their
  FIX-LANDED posts; audit their output while you wait (early FINDINGs are welcome and
  cheap).

## Docs

- Update the vault sections that now lie: check `docs/ARCHITECTURE.md`, `docs/
  GETTING-STARTED.md`, and any vault-export references for the flat-`notes/` assumption.
- Add a short "reading your vault" section: Home-first, Bases views, enabling core Bases,
  optional Breadcrumbs/Juggl (consume-our-frontmatter only). Keep it tight.
- CHANGELOG is ORCH's — don't touch it.

## P2 triage (implement-or-defer, with recorded rationale on the board)

- **P2-8 date-prefix session/snapshot filenames — presumption: IMPLEMENT.** It must ship in
  the same release as T2's P1-4 folder move so vault layout churns once. Coordinate the
  naming scheme with T2 before either freezes.
- **P2-7 weekly rollups** (`rollups/<project>/2026-W31.md`, prev/next links) — implement if
  the sprint clock allows after goldens are green; otherwise defer with rationale.
- **P2-9 Breadcrumbs-compatible typed fields** — T1's `up:` already feeds Breadcrumbs;
  additional per-edge-type list props are defer-by-default unless trivially cheap.
- Skip auto-Canvas (ruled out in research — record nothing).

## Gate

Root `npm test` full run green is YOUR gate to post DONE — run it, post the numbers.

## Discipline

Post shape `### [T3] <VERB> 2026-MM-DD HH:MM ET — <gist>` (VERB: FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE). Stay in lane; no version bumps, no CHANGELOG, no commits. DB
facts via read-only psql, not Mnestra MCP. No browser tools. Never write to
`/Volumes/Crucial X6/mnestra-vault`. When waiting on T1/T2 output, post the wait and end
your turn; ORCH shepherds you back the moment the dependency lands.
