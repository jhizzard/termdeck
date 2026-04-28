# Sprint 41 — Project taxonomy redesign + graph UX fix

**Status:** Planned. Inject after Sprint 40 close.
**Target version:** `@jhizzard/termdeck` v0.10.3 (patch — no new feature surface, code-correctness + data-cleanup).

## Goal

Make memory `project` tags **specific to the actual code project**, not the directory parent. Today every cwd under `~/Documents/Graciella/ChopinNashville/` gets stamped `chopin-nashville` regardless of which sub-project the work is in — TermDeck, Chopin in Bohemia, ClaimGuard, the SchedulingApp, even non-code dirs like `JoshPhotos/` or `Sponsors/`. Result: 947 rows still under chopin-nashville post-Sprint-39 backfill, the chopin-nashville graph view shows mixed-project content, cross-project recall is noisy, and the Chopin Nashville competition itself (an actual music event project) loses its identity inside the junk drawer.

After this sprint: each code project has its own tag, the umbrella `chopin-nashville` tag is reserved for actual Chopin Nashville competition work, and the graph view's empty-state UX bug stops showing "no memories yet" simultaneously with rendered nodes.

## Constraints from Joshua (2026-04-28 morning)

- **chopin-nashville is NOT a code project.** It's the directory containing many code projects. The tag should mean "work specifically about the Chopin Nashville Piano Competition" — not "any work that happened in this directory tree."
- **Cross-project memories and graphs need specific project tags** to be useful. Mixing 947 rows under one umbrella tag defeats the purpose of `memory_recall(project=...)`.
- **Joshua is switching projects after Sprint 41 closes** — moving to ClaimGuard-AI for 1-2 sprints, then Chopin in Bohemia, then re-starting Maestro. The taxonomy needs to support all of those as distinct first-class projects.

## Pre-sprint substrate findings (orchestrator probe 2026-04-28 morning)

**Current `memory_items` project distribution (5,891 total rows):**

| project | count |
|---|---|
| pvb | 1,605 |
| chopin-scheduler | 996 |
| **chopin-nashville** | **947** ← target for re-classification |
| termdeck | 606 |
| gorgias | 468 |
| global | 397 |
| gorgias-ticket-monitor | 207 |
| podium | 121 |
| imessage-reader | 114 |
| rumen | 99 |
| antigravity | 30 |
| claimguard | 15 |
| (9 more under 10 rows each) | |

**`~/Documents/Graciella/ChopinNashville/` subdirectory inventory (30+ directories):**

Code projects:
- `SideHustles/TermDeck/termdeck/` → tag `termdeck` (606 rows currently — correct)
- `SideHustles/ClaimGuard/` (likely) or `~/Documents/Unagi/gorgias-ticket-monitor/` per CLAUDE.md → tag `claimguard`
- `SideHustles/SchedulingApp/` AND `SchedulingApp/` (top-level) → tag `chopin-scheduler` (already has 996 rows correctly)
- `2026/ChopinInBohemia/podium/` → tag `podium` (121 rows currently — correct)
- `2026/ChopinInBohemia/` (the festival project itself, NOT podium) → NEW tag `chopin-in-bohemia`

Operational/business (non-code, no tag needed — these should fall through to `global`):
- `Performances/`, `Sponsors/`, `Media/`, `JoshPhotos/`, `Sponsors/`, `Applications/`, `Jury/`, `MedalsTrophies/`, `Certificates/`, `CompetitionProgram/`, `MoxyHotel/`, `Publicity/`, `Advertising/`, `2025Competition/`, `2026/`, `2027/`, `AAF/`, `AshotAriyan/`, `Apsinthion/`, `AwardsPerformances/`, `BadgesAndFolders/`, `CORPORATE/`, `DMARC/`, `MusicTeacherLists/`, `PracticePianos/`, `SymphonyProgramsAds/`, `SystemAdmin/`

The actual **Chopin Nashville competition** project (operational logistics, not code) is what `chopin-nashville` SHOULD tag — likely cwds matching things like `Performances/`, `Sponsors/`, `Jury/`, the year-folder dirs, etc. when the user is doing legitimate competition-management work in Claude Code.

**Other planned projects to provision tags for** (from Joshua's roadmap):
- `chopin-in-bohemia` (festival in 2026, distinct from Nashville competition)
- `maestro` (planned re-start; may be a music-related agent project — to be confirmed by Joshua. Save as candidate; if Maestro is a typo for Mnestra, we already have that tag.)

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Project taxonomy authoring + PROJECT_MAP overhaul** | Define the canonical project taxonomy. Update `~/.claude/hooks/memory-session-end.js` PROJECT_MAP with specific patterns per code project, ordered most-specific-first. Update bundled hook README with extension guidance. The bundled hook ships with PROJECT_MAP empty (Sprint 38 P0 decision); only Joshua's personal hook gets the update. NEW `docs/PROJECT-TAXONOMY.md` documents the full taxonomy as the canonical reference. | `~/.claude/hooks/memory-session-end.js` (Joshua's personal), `packages/stack-installer/assets/hooks/README.md` (Brad-facing guidance), NEW `docs/PROJECT-TAXONOMY.md` |
| **T2 — Re-tag migration with new taxonomy** | NEW `012_project_tag_re_taxonomy.sql` re-classifies the 947 chopin-nashville rows AND any other mis-tagged rows using the new taxonomy. Lane writes idempotent SQL with `RAISE NOTICE` count probes per re-tag bucket; orchestrator applies at sprint close after reviewing affected counts. Conservative: rows with no clear signal STAY chopin-nashville (these are the legitimate competition-related ones — once T4 LLM-classifies the residue, the final chopin-nashville count should be ≤100). | NEW `packages/server/src/setup/mnestra-migrations/012_project_tag_re_taxonomy.sql`, mirror in `~/Documents/Graciella/engram/migrations/` |
| **T3 — Graph empty-state UX fix** | When `fetchGraph` switches modes (memory ↔ project) the previous SVG render isn't cleared and the loading/empty overlays don't reset. Result: "Loading graph…" + "No memories yet" can show simultaneously over rendered nodes. Fix: `fetchGraph` resets `state.nodes = []` + clears the SVG + hides both overlays at the START of every fetch, not just on success. Add an "all projects" picker option that fetches the full graph (with a node cap and warning for large corpora). | `packages/client/public/graph.js` (fetchGraph + setLoading/showEmpty/hideEmpty + new "All projects" picker option), `packages/client/public/graph.html` (picker option), tests/graph-routes.test.js (extend) |
| **T4 — LLM-classification of residual uncertain rows** | After T2's deterministic re-tag, the leftover chopin-nashville rows are the "uncertain" ones — content with no clear keyword signal. T4 ships a one-shot SQL function `reclassify_uncertain_chopin_nashville()` that calls Haiku 4.5 in batched 20-row groups, asks "given this content, is this work about (a) the Chopin Nashville competition, (b) Chopin in Bohemia festival, (c) general piano teaching/performance, (d) other code project — name it, (e) genuinely no project signal — keep as global?" Updates the row's project tag based on response. Bounded cost: ~700 rows × ~$0.0001/call ≈ $0.07. Lane writes the function + a one-shot script `scripts/reclassify-chopin-nashville.js`; orchestrator runs the script at sprint close. | NEW `~/Documents/Graciella/engram/migrations/013_reclassify_uncertain.sql` (the function), NEW `scripts/reclassify-chopin-nashville.js` (the runner), updates to `tests/relationships.test.ts` if shared LLM helper exists |

## Out of scope (Sprint 42+)

- Auto-detecting project boundaries from on-disk file presence (e.g., `package.json`, `.git`) — currently the hook uses regex against cwd. Auto-detection is a richer problem.
- Re-tagging the legacy `mnestra_*` tables (different schema, different write path).
- Graph-inference cron LATERAL+HNSW rewrite (still task #19, separate sprint).
- The chopin-scheduler / scheduling-app overlap (likely the same project; both have rows: 996 chopin-scheduler + ?? scheduling-app — investigate at sprint close, defer to Sprint 42 if non-trivial).

## Acceptance criteria

1. `~/.claude/hooks/memory-session-end.js` PROJECT_MAP correctly tags `cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck` as `termdeck`, `cd ~/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium` as `podium`, `cd ~/Documents/Graciella/ChopinNashville/SchedulingApp` as `chopin-scheduler`, `cd ~/Documents/Graciella/ChopinNashville/Performances` as `chopin-nashville` (legitimate). Tested via `node -e` invocation against the hook's `detectProject` export OR equivalent.
2. After T2 + T4 apply, `chopin-nashville` row count drops from 947 → < 100 (only legitimate competition-management work remains). Other project counts climb correspondingly: termdeck +X, podium +Y, claimguard +Z, etc.
3. Graph view at `/graph.html?project=termdeck` shows ~700+ nodes (after re-tagging picks up termdeck content currently mis-tagged). No "No memories yet" overlay when nodes ARE rendered. No "Loading graph…" spinner that persists past the API response.
4. NEW "All projects" option in the project picker dropdown loads the full graph (with a 2,000-node cap and a warning toast if exceeded).
5. NEW `docs/PROJECT-TAXONOMY.md` is the canonical reference for project tags. Future sprints adding new code projects update this doc + Joshua's PROJECT_MAP in lockstep.

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.

## Dependencies on prior sprints

- Sprint 39 T3 ran the first conservative chopin-nashville backfill (1,139 → 947). Sprint 41 T2 picks up where T3 left off with a more comprehensive re-tag using the new taxonomy.
- Sprint 38 D3 viz at `/graph.html` is the primary UI consumer. T3's UX fix lands inside its `graph.js`.
- Sprint 39 T1's `flashback-diag.js` ring buffer is a model for T4's LLM-classification observability — the script should log per-batch progress (rows classified, costs, errors) for re-runnability.

## Joshua's roadmap after Sprint 41 close

1. Sprint 41 ships → close-out (publish v0.10.3 + termdeck-stack@0.4.4).
2. **1–2 sprints in ClaimGuard-AI** (~/Documents/Unagi/gorgias-ticket-monitor or wherever the project lives — confirm at kickoff).
3. **Switch to Chopin in Bohemia** (festival, ~/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/).
4. **Re-start Maestro** (project pending confirmation — possibly typo for Mnestra; if it's a new music-related agent project, scaffold via `termdeck init --project maestro`).

The Sprint 41 taxonomy + tagging fix MUST land before the project switches; otherwise ClaimGuard / Chopin in Bohemia / Maestro work would re-pollute the chopin-nashville junk drawer all over again.
