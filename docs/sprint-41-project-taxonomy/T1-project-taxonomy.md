# Sprint 41 — T1: Project taxonomy authoring + PROJECT_MAP overhaul

**Lane goal:** Define the canonical project taxonomy. Update Joshua's personal session-end hook PROJECT_MAP with specific patterns per code project, ordered most-specific-first so a cwd inside `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` resolves to `termdeck`, NOT `chopin-nashville`. Document the taxonomy as a first-class spec in `docs/PROJECT-TAXONOMY.md` so future code projects extend it via lockstep doc + hook updates.

**Target deliverable:**
1. NEW `docs/PROJECT-TAXONOMY.md` — canonical project taxonomy. Each entry: project tag, cwd pattern, GitHub repo (if any), short description, "use when" rule.
2. Updated `~/.claude/hooks/memory-session-end.js` PROJECT_MAP with the full ordered list.
3. Updated `packages/stack-installer/assets/hooks/README.md` "Customizing the project map" section to reference the taxonomy doc as the example.
4. A test or smoke-script proving the new PROJECT_MAP correctly resolves five+ representative cwds.

## The taxonomy

The full ordered list (most-specific-first; first match wins):

| Order | Pattern | Project tag | Notes |
|---|---|---|---|
| 1 | `/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/` | `termdeck` | The TermDeck monorepo |
| 2 | `/Documents/Graciella/engram` | `mnestra` | The Mnestra MCP server (folder kept as `engram` per the rename — see global CLAUDE.md) |
| 3 | `/Documents/Graciella/rumen` | `rumen` | Rumen async learning loop |
| 4 | `/Documents/Graciella/rag-system` | `rag-system` | Joshua's private rag-system repo |
| 5 | `/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium` | `podium` | Podium app for Chopin in Bohemia 2026 |
| 6 | `/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia` | `chopin-in-bohemia` | Festival project (NOT podium) |
| 7 | `/Documents/Graciella/ChopinNashville/SchedulingApp` OR `/Documents/Graciella/ChopinNashville/SideHustles/SchedulingApp` | `chopin-scheduler` | Scheduling tool — there appear to be two locations; both map to the same tag |
| 8 | `/Documents/Graciella/PVB` | `pvb` | PVB monorepo |
| 9 | `/Documents/Unagi/gorgias-ticket-monitor` | `claimguard` | ClaimGuard-AI (lives in Unagi org dir) |
| 10 | `/Documents/Graciella/ChopinNashville/SideHustles/ClaimGuard` (if exists) | `claimguard` | Alternate location for ClaimGuard if Joshua moved it |
| 11 | `/Documents/DOR` | `dor` | DOR project |
| 12 | `/Documents/Graciella/joshuaizzard-dev` | `portfolio` | Portfolio site |
| 13 | `/Documents/Graciella/imessage-reader` | `imessage-reader` | iMessage reader project |
| 14 | `/Documents/Graciella/ChopinNashville` (any other path under here) | `chopin-nashville` | **CATCH-ALL only for legitimate competition-management work** — Performances/, Sponsors/, Jury/, the year folders, etc. Operational, not code. |
| 15 | (any other path that doesn't match above) | `global` | Fallback for non-project work |

**Critical:** the order matters. Patterns at higher indices are MORE specific (deeper paths); they MUST be tested first. Otherwise a cwd inside `SideHustles/TermDeck` would match the catch-all `/ChopinNashville/` pattern at index 14 first and get the wrong tag — the bug Sprint 41 is fixing.

**Other projects** (lower priority, may not have rows yet):
- `gorgias` — appears to be a TermDeck-internal tag for code referring to gorgias the company; if there's no separate cwd, leave as historical-only (no MAP entry).
- `antigravity`, `high-ticket`, `claude-email-assistant`, `chopin-dispatch`, `photoshop-skill` — historical tags from prior projects. T1 does not create MAP entries for these unless Joshua confirms they're active.
- `maestro` — Joshua mentioned restarting it; if the project doesn't exist on disk yet, no MAP entry needed until the project is scaffolded via `termdeck init --project maestro`.

## PROJECT_MAP file change

The current `~/.claude/hooks/memory-session-end.js` PROJECT_MAP looks like this (approximately, per Joshua's prior file):

```js
const PROJECT_MAP = [
  { pattern: /\/PVB\//i, project: 'pvb' },
  { pattern: /chopin-scheduler|chopin_scheduler/i, project: 'chopin-scheduler' },
  { pattern: /ChopinNashville|ChopinInBohemia/i, project: 'chopin-nashville' },  // ← THE BUG
  { pattern: /rag-system/i, project: 'rag-system' },
  // ...
];
```

The third entry is the bug: it matches everything under ChopinNashville parent dir. The fix replaces it with the ordered taxonomy above:

```js
const PROJECT_MAP = [
  // Most-specific-first.  Code projects under ChopinNashville parent dir each
  // get their own tag; only legitimate Chopin Nashville competition work falls
  // through to the chopin-nashville catch-all.
  { pattern: /\/ChopinNashville\/SideHustles\/TermDeck\/termdeck/i, project: 'termdeck' },
  { pattern: /\/Graciella\/engram(\/|$)/i,                          project: 'mnestra' },
  { pattern: /\/Graciella\/rumen(\/|$)/i,                           project: 'rumen' },
  { pattern: /\/Graciella\/rag-system/i,                            project: 'rag-system' },
  { pattern: /\/2026\/ChopinInBohemia\/podium/i,                    project: 'podium' },
  { pattern: /\/2026\/ChopinInBohemia/i,                            project: 'chopin-in-bohemia' },
  { pattern: /\/ChopinNashville\/(SideHustles\/)?SchedulingApp/i,   project: 'chopin-scheduler' },
  { pattern: /\/Graciella\/PVB(\/|$)/i,                             project: 'pvb' },
  { pattern: /\/Unagi\/gorgias-ticket-monitor/i,                    project: 'claimguard' },
  { pattern: /\/ChopinNashville\/SideHustles\/ClaimGuard/i,         project: 'claimguard' },
  { pattern: /\/Documents\/DOR(\/|$)/i,                             project: 'dor' },
  { pattern: /\/Graciella\/joshuaizzard-dev/i,                      project: 'portfolio' },
  { pattern: /\/Graciella\/imessage-reader/i,                       project: 'imessage-reader' },
  // CATCH-ALL last — only matches when no specific code project matched first.
  // Keeps legitimate competition-management work (Performances/, Sponsors/, etc.)
  // tagged correctly.
  { pattern: /\/ChopinNashville(\/|$)/i,                            project: 'chopin-nashville' },
];
```

**Test cases** (write into `tests/project-taxonomy.test.js` OR a small smoke script):

| Input cwd | Expected project |
|---|---|
| `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` | `termdeck` |
| `/Users/joshuaizzard/Documents/Graciella/engram` | `mnestra` |
| `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium` | `podium` |
| `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia` | `chopin-in-bohemia` |
| `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SchedulingApp` | `chopin-scheduler` |
| `/Users/joshuaizzard/Documents/Graciella/PVB/pvb` | `pvb` |
| `/Users/joshuaizzard/Documents/Unagi/gorgias-ticket-monitor` | `claimguard` |
| `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/Performances` | `chopin-nashville` |
| `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/Sponsors` | `chopin-nashville` |
| `/Users/joshuaizzard/Documents/Random/some/path` | `global` |

## docs/PROJECT-TAXONOMY.md

NEW canonical doc. Sections:
- **Why this exists** — the chopin-nashville-junk-drawer pattern; the rule that project tags must be specific to code projects.
- **The taxonomy** — full table (mirroring above) with each project's identity.
- **How to add a new project** — three steps: (1) update PROJECT_MAP at the right priority order, (2) update this doc, (3) verify via the test suite.
- **What goes under `global`** — the fallback for non-project work (ad hoc shell sessions in random dirs, system maintenance, etc.).
- **What goes under `chopin-nashville`** — the catch-all for legitimate Chopin Nashville competition-management work that's NOT one of the named code projects.

## Coordination notes

- **T2 (re-tag migration)** consumes T1's taxonomy as the canonical truth. T2's SQL re-classifies historical rows according to T1's taxonomy. Coordinate via STATUS.md: T1 should publish the final taxonomy table by ~50% sprint mark so T2 can write the SQL deterministically.
- **T3 (graph UX fix)** is independent — it's a client-side fix that doesn't depend on the taxonomy.
- **T4 (LLM classification)** consumes T1's taxonomy too. The Haiku prompt asks "is this work about (a) Chopin Nashville competition, (b) Chopin in Bohemia, ... (n) other named project — list them" — the named-project list comes from T1's taxonomy.

## Test plan

- Smoke test or unit tests that exercise `detectProject(cwd)` with the 10+ representative cwds above.
- Manual: navigate to several cwds via `cd`, fire a Claude Code session-end, verify the right `project` tag lands in the next hook log line (`~/.claude/hooks/memory-hook.log`).
- Joshua's existing personal hook continues to work (no breaking change to the hook's overall shape — only the PROJECT_MAP array changes).

## Out of scope

- Don't write the re-tag migration — T2 owns it.
- Don't fix the graph empty-state bug — T3 owns it.
- Don't run LLM classification — T4 owns it.
- Don't auto-detect projects from on-disk markers (`package.json`, `.git`, etc.) — Sprint 42+ candidate.
- Don't update the bundled hook's PROJECT_MAP — that ships with PROJECT_MAP empty by Sprint 38 P0 design (fresh users add their own).
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-41-project-taxonomy/STATUS.md` under `## T1`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
