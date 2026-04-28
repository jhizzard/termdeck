# Project taxonomy — canonical reference

This is the single source of truth for the `project` tag used in
Mnestra's `memory_items` table and across the TermDeck / Mnestra / Rumen
stack. Adding a new code project? Update this file **and** the
PROJECT_MAP in your session-end hook in lockstep.

## Why this exists

Before Sprint 41, every cwd under `~/Documents/Graciella/ChopinNashville/`
was stamped `chopin-nashville` regardless of which sub-project the work
was in — TermDeck, Chopin in Bohemia, ClaimGuard, the SchedulingApp, the
Podium app, and even non-code dirs like `Performances/`, `Sponsors/`,
`Media/`, `JoshPhotos/`. The result was a junk-drawer tag with 1,139
rows mixing every project under one umbrella, defeating the purpose of
`memory_recall(project=...)`.

The rule going forward:

> **Project tags must be specific to the actual code project, not the
> directory parent.** Each code project gets its own tag. The
> `chopin-nashville` tag is reserved for legitimate Chopin Nashville
> Piano Competition work — `Performances/`, `Sponsors/`, `Jury/`, year
> folders, etc.

The PROJECT_MAP in the session-end hook (`~/.claude/hooks/memory-session-end.js`)
is an **ordered** list. `detectProject(cwd)` returns the first matching
entry, so deeper / more-specific patterns must come BEFORE broader
parent-dir patterns. Inverting the order re-introduces the
junk-drawer bug.

## The taxonomy

Order matters. Earlier entries take precedence. The catch-all
chopin-nashville pattern is the LAST entry that can match a
ChopinNashville cwd; everything else above it is more specific.

### Block 1 — active code projects (most-specific-first)

| # | Project tag | cwd pattern (regex) | Repo / location | Description |
|---|---|---|---|---|
| 1 | `termdeck` | `/\/ChopinNashville\/SideHustles\/TermDeck\/termdeck/i` | github.com/jhizzard/termdeck — `npm: @jhizzard/termdeck` | Browser terminal multiplexer with metadata overlays |
| 2 | `mnestra` | `/\/Graciella\/engram(\/\|$)/i` | github.com/jhizzard/mnestra — `npm: @jhizzard/mnestra`. On-disk dir is still `engram/` (renamed Sprint 3). | pgvector memory store + MCP server |
| 3 | `rumen` | `/\/Graciella\/rumen(\/\|$)/i` | github.com/jhizzard/rumen — `npm: @jhizzard/rumen` | Async learning loop, Supabase Edge Function |
| 4 | `rag-system` | `/\/Graciella\/rag-system/i` | private | Joshua's private rag-system repo |
| 5 | `podium` | `/\/2026\/ChopinInBohemia\/podium/i` | private | Podium app for Chopin in Bohemia 2026 |
| 6 | `chopin-in-bohemia` | `/\/2026\/ChopinInBohemia/i` | private | Festival project itself, NOT podium |
| 7 | `chopin-scheduler` | `/\/ChopinNashville\/(SideHustles\/)?SchedulingApp/i` AND `/chopin-scheduler\|chopin_scheduler/i` | private | Scheduling tool for the Chopin Nashville competition. **Working name: "Maestro"** — same project. |
| 8 | `pvb` | `/\/Graciella\/PVB(\/\|$)/i` | private | PVB monorepo |
| 9 | `claimguard` | `/\/Unagi\/gorgias-ticket-monitor/i` AND `/\/ChopinNashville\/SideHustles\/ClaimGuard/i` | private | ClaimGuard-AI ticket-monitor (lives in Unagi org dir; alternate location under SideHustles) |
| 10 | `dor` | `/\/Documents\/DOR(\/\|$)/i` | private | DOR project |
| 11 | `portfolio` | `/\/Graciella\/joshuaizzard-dev/i` | github.com/jhizzard/joshuaizzard-dev | Personal portfolio site |
| 12 | `imessage-reader` | `/\/Graciella\/imessage-reader/i` | private | iMessage reader project |

### Block 2 — legacy / historical (rarely hit; kept for tag continuity)

| Project tag | cwd pattern | Notes |
|---|---|---|
| `piano-camera` | `/PianoCameraAI/i` | Historical — corpus exists, project dormant |
| `ppn` | `/Practice Piano Network/i` | Practice Piano Network |
| `stanczak` | `/StanczakJosh/i` | StanczakJosh |
| `joshizpiano` | `/JoshIzPiano/i` | JoshIzPiano |
| `autumn-artist` | `/AutumnArtist/i` | Autumn Artist |
| `crosswords` | `/Crosswords/i` | Crosswords |
| `gorgias` | `/gorgias/i` | TermDeck-internal tag for content referring to Gorgias the company. **Distinct from `claimguard`** — claimguard is the on-disk path; gorgias is content-keyword. |
| `antigravity` | `/antigravity/i` | Historical scratch project |

### Block 3 — chopin-nashville catch-all

| Project tag | cwd pattern | What it actually means |
|---|---|---|
| `chopin-nashville` | `/\/ChopinNashville(\/\|$)/i` | **Only legitimate Chopin Nashville Piano Competition work.** Cwds like `Performances/`, `Sponsors/`, `Jury/`, `Applications/`, year folders (`2025Competition/`, `2026/`, `2027/`), `MedalsTrophies/`, `MoxyHotel/`, `Publicity/`, `MusicTeacherLists/`, etc. — operational, not code. |

### Block 4 — fallback

| Project tag | When | What it actually means |
|---|---|---|
| `global` | No PROJECT_MAP entry matches | Ad-hoc shell sessions in random dirs, system maintenance, one-off scripts. Not associated with any tracked project. |

## Aliases and cross-references

- **Maestro = chopin-scheduler.** Joshua's working / branding name for
  the scheduling app project is "Maestro." The canonical tag stays
  `chopin-scheduler` (996 rows of memory pre-date the rename). If the
  on-disk dir is ever renamed from `SchedulingApp/` to `Maestro/`, add
  a parallel pattern at the same priority order — do NOT introduce a
  separate `maestro` tag.
- **engram = mnestra.** The on-disk folder is still `engram/` (Sprint 3
  rename was project-name-only, not directory rename). The npm package,
  the GitHub repo, and the project tag are all `mnestra`.
- **gorgias vs claimguard.** Two distinct tags. `claimguard` is the
  on-disk project under `~/Documents/Unagi/gorgias-ticket-monitor/`.
  `gorgias` is a historical content-keyword tag for content referring
  to Gorgias the helpdesk company. New code work goes under
  `claimguard`.

## How to add a new project

Three-step procedure. Doing only one of the three creates drift.

1. **Update the PROJECT_MAP** in `~/.claude/hooks/memory-session-end.js`
   at the right priority order. More-specific patterns go higher in the
   array. If your new project lives under an existing parent dir
   (e.g. another sub-project under `ChopinNashville/`), it MUST appear
   above the chopin-nashville catch-all.

2. **Update this file.** Add a row to the right block (active /
   historical / catch-all) with the regex, location, and description.

3. **Verify via the test suite.** Add at least one cwd → tag case to
   `tests/project-taxonomy.test.js`, then run:

   ```sh
   node --test tests/project-taxonomy.test.js
   ```

   The structural invariant test will catch the most common regression:
   the chopin-nashville catch-all must remain the LAST entry that
   matches a `/ChopinNashville/` cwd.

## What NOT to use as a project tag

- **Generic descriptors** like `frontend`, `backend`, `tests`,
  `migration`, `experimental`. The project tag identifies the
  long-lived project, not the work-type. Use a category column for
  work-type.
- **Sprint numbers** like `sprint-41`. Sprint state lives in the doc
  tree (`docs/sprint-N-*/`), not in memory tags.
- **Person names**. Memory project tags are project-scoped, not
  collaborator-scoped.

## Bundled hook coexistence

The bundled hook shipped by `@jhizzard/termdeck-stack` (lives at
`packages/stack-installer/assets/hooks/memory-session-end.js`) ships
with PROJECT_MAP **empty** by Sprint 38 P0 design. Brad-class users
add their own entries; they do not inherit Joshua's taxonomy. The
bundled README at `packages/stack-installer/assets/hooks/README.md`
points to this doc as the canonical example pattern.

Joshua's personal hook at `~/.claude/hooks/memory-session-end.js`
(out-of-repo) IS the implementation of this taxonomy. The two hooks
are intentionally separate: the bundled one is portable; the personal
one encodes one user's project layout.

## Related docs

- `docs/ARCHITECTURE.md` — overall TermDeck / Mnestra / Rumen system
  architecture
- `docs/sprint-41-project-taxonomy/` — the sprint that authored this
  doc and re-tagged the historical corpus
- `~/.claude/CLAUDE.md` § Project Directory Map — the path → project
  alias map for cross-project navigation
- `packages/stack-installer/assets/hooks/README.md` — bundled hook docs
