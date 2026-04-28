# Sprint 41 — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

## Pre-sprint context (orchestrator, 2026-04-28 morning)

- **chopin-nashville is NOT a code project.** It's a directory containing 30+ subdirectories, mostly non-code (Performances/, Sponsors/, Media/, JoshPhotos/, etc.). The current PROJECT_MAP regex `/ChopinNashville|ChopinInBohemia/i` matches every cwd under that tree, polluting the chopin-nashville tag with content from TermDeck, ClaimGuard, Chopin in Bohemia, the SchedulingApp, etc.
- **Post-Sprint-39 baseline:** 947 rows still tagged chopin-nashville. Sprint 39 T3's content-keyword backfill caught 192 rows (1,139 → 947). Sprint 41 finishes the job with: T1 new taxonomy, T2 broader deterministic re-tag, T4 LLM classification of residue.
- **Acceptance:** chopin-nashville count drops from 947 → < 100 (only legitimate competition-management work). Termdeck, podium, claimguard, etc. all climb correspondingly.
- **Joshua's roadmap after Sprint 41:** 1-2 ClaimGuard-AI sprints → Chopin in Bohemia → re-start Maestro. The taxonomy fix MUST land before the project switches or the junk drawer re-pollutes.

## Mid-inject orchestrator clarification — 2026-04-28 12:51 ET

**MAESTRO = chopin-scheduler.** They are the SAME project under two names. Joshua confirmed mid-inject: "Maestro is the name of the chopin scheduler app project." The on-disk path is `~/Documents/Graciella/ChopinNashville/SchedulingApp/` (and/or `~/Documents/Graciella/ChopinNashville/SideHustles/SchedulingApp/` per the global directory map). The existing `chopin-scheduler` tag (996 rows in memory_items) IS Maestro's memory store.

**For T1:** PROJECT-TAXONOMY.md MUST document this alias. Suggested entry: `chopin-scheduler` is the canonical tag; "Maestro" is the working / branding name. The PROJECT_MAP pattern stays `/ChopinNashville\/(SideHustles\/)?SchedulingApp/i` → `chopin-scheduler`. If Joshua eventually renames the on-disk dir from `SchedulingApp/` to `Maestro/`, add a parallel pattern at that priority order.

**For T2 + T4:** when re-tagging or LLM-classifying, treat content mentioning "Maestro" as `chopin-scheduler`. Add to T4's prompt: "If the content references 'Maestro' as a project name, that's an alias for `chopin-scheduler` — use that tag."

Lesson for future sprints: when a project name comes up that doesn't match the existing taxonomy table, run `memory_recall(query="<name>")` cross-project FIRST before treating it as new. Code-project working-names diverge from on-disk paths regularly.
- **Bonus lane:** T3 fixes the graph-view UX bug where "Loading graph…" + "No memories yet" overlays render simultaneously over visible nodes. Adds an "All projects" picker option.

Format:
```
## T<n> — <lane name>

### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
```

---

## T1 — Project taxonomy authoring + PROJECT_MAP overhaul

### FINDING — 2026-04-28 12:53 ET

Confirmed the bug shape against `~/.claude/hooks/memory-session-end.js` (outside the repo) and the bundled hook README. Also internalized the orchestrator's mid-inject clarification: **Maestro = chopin-scheduler alias** — single project, two names; on-disk dir is `SchedulingApp/`.

Current personal hook PROJECT_MAP (13 entries, lines 14–28) has these structural problems:

1. **The catch-all is mis-ordered.** Entry #3 is `{ pattern: /ChopinNashville|ChopinInBohemia/i, project: 'chopin-nashville' }`. Because `detectProject` returns first match, every cwd under `~/Documents/Graciella/ChopinNashville/...` (TermDeck, Podium, SchedulingApp, ClaimGuard sub-dir, the festival, plus all non-code dirs like Performances/, Sponsors/, Media/, JoshPhotos/) hits this entry before any specific pattern below could fire. Same for `ChopinInBohemia` swallowing `podium`.
2. **No specific entries for the active code projects under that umbrella.** No `termdeck` entry, no `podium`, no `chopin-in-bohemia`, no `mnestra` (engram folder), no `rumen`, no `claimguard` (Unagi path), no `dor`, no `portfolio`. Sessions in those repos either fall to the chopin-nashville catch-all (if under ChopinNashville/) or to `'global'` (if elsewhere). Both wrong.
3. **`chopin-scheduler` regex (`/chopin-scheduler|chopin_scheduler/i`) matches the literal token, not the on-disk path `SchedulingApp/`.** Sessions in `~/Documents/Graciella/ChopinNashville/SchedulingApp/` would have hit the chopin-nashville catch-all first. The pattern needs a path-based variant for both `SchedulingApp/` and `SideHustles/SchedulingApp/`.
4. **The hook does not export `detectProject`.** The stdin reader runs unconditionally at require time, so a test cannot `require()` the hook without hanging. Sprint 38 P0 introduced the `require.main === module` contract for the bundled hook; the personal hook never adopted it. T1 will adopt it now so a test can pin the taxonomy.
5. **Historical entries that don't conflict** (PianoCameraAI, ppn, stanczak, joshizpiano, autumn-artist, crosswords, gorgias, imessage-reader, antigravity, PVB) are kept — most are dead corpora but harmless and removing them risks losing tag continuity for any future session that lands in those dirs.

Bundled hook README at `packages/stack-installer/assets/hooks/README.md` already documents the empty-default + customization story (Sprint 38 P0 design). T1 will update its example block to mirror the most-specific-first ordering and link to the new `docs/PROJECT-TAXONOMY.md` so Brad-class users see the canonical pattern.

Approach (matches the briefing exactly — no scope drift):
- Replace personal hook PROJECT_MAP with the 13-entry ordered taxonomy from T1-project-taxonomy.md, preserving the historical tail (PianoCameraAI etc.) below the named-project block but above the chopin-nashville catch-all. Keep both the path-based `SchedulingApp/` pattern AND the legacy `/chopin-scheduler/i` token pattern at the same priority order — different match surfaces, both resolve to `chopin-scheduler`.
- Wrap the stdin reader in `if (require.main === module)` and add `module.exports = { detectProject, PROJECT_MAP }`.
- New `tests/project-taxonomy.test.js` requires the personal hook by absolute path and asserts the 10 representative cwds resolve correctly. Skips with a clear log line when the hook isn't installed (CI-safe — Brad doesn't have Joshua's hook).
- New `docs/PROJECT-TAXONOMY.md` mirrors the briefing table, adds the "How to add a new project" three-step procedure, AND documents the Maestro = chopin-scheduler alias per orchestrator clarification.
- Bundled README "Customizing the project map" example block updated to most-specific-first and references the taxonomy doc.

### FIX-PROPOSED — 2026-04-28 12:55 ET

Three files written, one rewritten:

1. **Rewrote** `~/.claude/hooks/memory-session-end.js` (out-of-repo, 91 → 133 lines). New PROJECT_MAP organized in three blocks: 14 active-code-project entries (most-specific-first), 8 legacy/historical entries kept for tag continuity, 1 chopin-nashville catch-all at the END. Stdin reader wrapped in `if (require.main === module)`; `module.exports = { detectProject, PROJECT_MAP }` added so tests can import without hanging.
2. **New** `tests/project-taxonomy.test.js` (185 lines, 25 tests). 22 cwd → tag cases pin every concrete claim in the taxonomy table. Plus 1 export-shape test, 1 empty-cwd test, and 1 structural-invariant test that asserts the chopin-nashville catch-all is the LAST entry that matches a `/ChopinNashville/` cwd — this catches the most likely future regression. CI-safe: skips with a log line when the personal hook isn't installed (Brad's machines).
3. **New** `docs/PROJECT-TAXONOMY.md` (154 lines). Sections: Why this exists, The taxonomy (3 blocks + fallback), Aliases (Maestro/chopin-scheduler, engram/mnestra, gorgias/claimguard distinction), How to add a new project (3-step procedure), What NOT to use as a project tag, Bundled hook coexistence, Related docs.
4. **Updated** `packages/stack-installer/assets/hooks/README.md` "Customizing the project map" section. Replaced the toy 3-line example with a most-specific-first walkthrough that mirrors the real ChopinNashville pattern (anonymized as MyOrg/SideProjects/...). Added a link to `docs/PROJECT-TAXONOMY.md` as the canonical worked example. Documented the module-export contract for users who want to test their own taxonomies.

Test run output (just before this entry): `tests 25 / pass 25 / fail 0 / duration_ms 131`.

### DONE — 2026-04-28 12:56 ET

T1 shipped. Files changed:

| File | Status | LOC |
|---|---|---|
| `~/.claude/hooks/memory-session-end.js` | rewritten (out-of-repo) | 133 |
| `tests/project-taxonomy.test.js` | new | 185 |
| `docs/PROJECT-TAXONOMY.md` | new | 154 |
| `packages/stack-installer/assets/hooks/README.md` | updated (Customizing the project map section) | 162 |

**For T2 (re-tag migration):** the canonical taxonomy is now `docs/PROJECT-TAXONOMY.md`. Use its exact tag names: `termdeck`, `mnestra`, `rumen`, `rag-system`, `podium`, `chopin-in-bohemia`, `chopin-scheduler`, `pvb`, `claimguard`, `dor`, `portfolio`, `imessage-reader`. Important alias to encode in your SQL: any row whose content references **"Maestro"** maps to `chopin-scheduler`, NOT a new `maestro` tag (per orchestrator clarification 12:51 ET).

**For T4 (LLM classification):** add Maestro=chopin-scheduler to your prompt's named-project list. Prompt should ask Haiku to choose from the exact tags in `docs/PROJECT-TAXONOMY.md` Block 1 (active code projects) PLUS `chopin-nashville` (legitimate competition work) PLUS `global` (no project signal). Don't let the model invent new tags.

**For T3 (graph UX):** independent of T1. T1's work doesn't affect the graph route or the picker.

**Acceptance criterion #1 verification (manual):**
- `node -e "console.log(require('/Users/joshuaizzard/.claude/hooks/memory-session-end.js').detectProject('/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck'))"` → `termdeck` ✔
- `node -e "console.log(require('/Users/joshuaizzard/.claude/hooks/memory-session-end.js').detectProject('/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium'))"` → `podium` ✔
- `node -e "console.log(require('/Users/joshuaizzard/.claude/hooks/memory-session-end.js').detectProject('/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SchedulingApp'))"` → `chopin-scheduler` ✔
- `node -e "console.log(require('/Users/joshuaizzard/.claude/hooks/memory-session-end.js').detectProject('/Users/joshuaizzard/Documents/Graciella/ChopinNashville/Performances'))"` → `chopin-nashville` ✔

(Equivalent assertions are encoded in the test suite — all 25 cases pass.)

**Behavioral effect on Joshua's environment:** starting with the next Claude Code session close, sessions in `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/...` will be tagged `termdeck` (was `chopin-nashville`). Sessions in podium, SchedulingApp, the festival dir, and ClaimGuard sub-dir will likewise route to their correct tags. The chopin-nashville tag will only receive new rows from legitimate competition-management dirs (Performances/, Sponsors/, Jury/, year folders, etc.). The pre-existing 947 mis-tagged rows are untouched by T1 — that's T2's job.

**Out of scope for T1 (per briefing):** no version bump, no CHANGELOG, no commits, no rerouting of bundled hook PROJECT_MAP (stays empty by Sprint 38 P0 design), no auto-detection from on-disk markers (Sprint 42+).

---

## T2 — Re-tag migration with new taxonomy

### FINDING — 2026-04-28 12:55 ET

**Baseline (cited from orchestrator pre-sprint substrate, 2026-04-28 morning):** 947 rows tagged `project='chopin-nashville'` in the live `petvetbid` `memory_items` table. This is the post-Sprint-39 state — Sprint 39 T3's `011_project_tag_backfill.sql` re-tagged 192 rows out of the original 1,139.

**Live-store audit queries (briefing § "Audit before writing SQL", three SELECTs) are not runnable from this lane.** No `DATABASE_URL` / Supabase service credentials in the working directory (`.env` absent, no `.env*` files), and the lane contract forbids applying / executing anything against live `petvetbid`. The orchestrator runs these three SELECTs at sprint close as part of pre-apply verification. The substrate's 947 figure is treated as ground truth for the migration's expected `BEFORE` count. Per-bucket distribution will be observed via `RAISE NOTICE` probes when the orchestrator applies.

**Orchestrator mid-inject clarification absorbed:** Maestro = chopin-scheduler (single project, two names). 012's chopin-scheduler bucket includes both path-style markers (`scheduling`, `schedulingapp`) AND the Maestro alias as a word-boundary capitalized token (`\mMaestro\M` POSIX regex — case-sensitive — to avoid matching unrelated lowercase `maestro:` log prefixes if any exist).

**Repo audit findings (these I can run from-lane):**

1. **011 migration shape.** `packages/server/src/setup/mnestra-migrations/011_project_tag_backfill.sql`, 238 lines. Uses `BEGIN`/`COMMIT`, sequential bucketed `UPDATE`s wrapped in anonymous `DO $$ DECLARE rows_updated int; BEGIN ... GET DIAGNOSTICS rows_updated = ROW_COUNT; RAISE NOTICE '[011-backfill] ...'` blocks (the bundled migration runner uses node-postgres `client.query`, which doesn't support `psql` `\gset`). 012 mirrors this idiom exactly: `[012-retaxonomy]` log prefix, bucketed DO blocks, BEFORE/AFTER audit blocks at top and bottom.

2. **011's keyword buckets and Sprint-39 results.** Five buckets, broadest-first: (1) termdeck/mnestra `[termdeck|mnestra|"4+1 sprint"]` → 130; (2) rumen `[rumen]` → 92; (3) podium `[podium]` → 58; (4) pvb `[PVB|petvetbid|"pet vet bid"]` → ~3 (overlapped with bucket 1); (5) dor `[\mDOR\M | /DOR/ | dor.config | "Rust LLM gateway" | openclaw]` → 3 after the word-boundary tightening. Cumulative dry-run ~286; live apply moved 192. Spot-check FP rate 0% on tightened patterns. **Implication for 012:** the 011 keyword set is already conservative; 012's job is to *widen* deterministically per the briefing's heuristic table, plus introduce three buckets 011 didn't have (`chopin-in-bohemia`, `chopin-scheduler`, `claimguard`).

3. **Engram repo migrations directory drift.** `~/Documents/Graciella/engram/migrations/` has 001–007, 009, 010 only. Missing 008 (Sprint 36+) and 011 (Sprint 39 T3). Pre-existing, NOT caused by Sprint 41. **OUT OF SCOPE for T2.** Flagging for Sprint 42+ cleanup. T2 mirrors 012 byte-identically anyway per briefing — 012 reads/writes only `memory_items.project` (created in 001/005), so no dependency on missing predecessors.

4. **`migration-loader-precedence.test.js` will break on 012 land.** Lines 47–60 (`fs.readdirSync(BUNDLED_DIR)` deepEquals an 11-entry array), line 66 (`list.length === 11`), lines 69–81 (basenames deepEqual same 11-entry array), line 143 (stale-mnestra test asserts 11 in two messages). Adding `012_project_tag_re_taxonomy.sql` requires bumping all of those to 12. T2 owns this collateral edit — the test breaks because of T2's deliverable.

5. **T4's 013 audit-column migration is downstream.** Per T4's FINDING above, T4 adds `reclassified_by` / `reclassified_at` columns in a 013 migration. 012 has no dependency on those columns — 012 just sets `project`. Order is fine: 011 → 012 (re-taxonomy) → 013 (audit columns) → T4's runner. No conflict.

**Conservative-rules confirmation:**
- `competition`, `performance`, `jury`, `sponsor`, `applicant`, `repertoire`, `Acceptd`, `NICPC`, `laureate` are NOT re-tag triggers — those are the legitimate chopin-nashville rows to preserve for T4 (or to remain as-is).
- `DOR` keyword reuses 011's tightened pattern (POSIX word-boundary `\mDOR\M` + path/identifier markers); doesn't widen.
- `Maestro` keyword uses the same word-boundary discipline (`\mMaestro\M`) — case-sensitive capitalized token.
- 012 is `WHERE project = 'chopin-nashville'` everywhere → idempotent (re-running updates 0 rows; RAISE NOTICE prints zeros).
- T4 LLM classification picks up the residue.

**Source_session_id-driven cwd resolution path (briefing audit query 3):** un-runnable from this lane (no DB access). The briefing scoped this as a *possible additional* signal, not required. Skipping it — keyword bucketing + T4's LLM pass should hit the < 100 chopin-nashville target. If the orchestrator's pre-apply audit shows high `source_session_id IS NOT NULL` density in the residue, a Sprint 42 follow-up could add transcript-path joins.

### FIX-PROPOSED — 2026-04-28 12:55 ET

**Deliverable shape (mirrors 011's idiom):**

```
BEGIN;

-- AUDIT BEFORE — RAISE NOTICE counts for chopin-nashville and every destination bucket.

-- BUCKET 1 — termdeck (broadest first; claims ambiguous multi-project rows)
--   Keywords: termdeck, mnestra, "4+1 sprint", xterm, node-pty, flashback,
--             memory_items, memory_relationships
-- BUCKET 2 — rumen
--   Keywords: rumen, rumen-tick, "insight synthesis"
-- BUCKET 3 — podium
--   Keywords: podium
-- BUCKET 4 — chopin-in-bohemia (festival, distinct from competition)
--   Keywords: bohemia, "chopin in bohemia", "2026 festival"
-- BUCKET 5 — chopin-scheduler (Maestro alias absorbed)
--   Keywords: scheduling, schedulingapp, \mMaestro\M
-- BUCKET 6 — pvb
--   Keywords: PVB, petvetbid, "pet vet bid"
-- BUCKET 7 — claimguard
--   Keywords: claimguard, gorgias-ticket-monitor, "gorgias ticket monitor"
-- BUCKET 8 — dor (reuse 011's tightened pattern verbatim)
--   Keywords: \mDOR\M, /DOR/, ~/Documents/DOR, dor.config,
--             "Rust LLM gateway", openclaw

-- AUDIT AFTER — RAISE NOTICE final chopin-nashville count + per-destination counts.

COMMIT;
```

**Bucket ordering rationale (broadest-first ownership):** termdeck claims any row mentioning "mnestra" / "4+1 sprint" first (these are TermDeck-context overwhelmingly); rumen claims rumen-specific tokens; podium / chopin-in-bohemia / chopin-scheduler / pvb / claimguard / dor each claim narrower keyword sets in decreasing-likelihood order. Once a row is re-tagged its `project` is no longer `'chopin-nashville'`, so subsequent buckets won't see it — order matters only when multiple buckets *would* match the same row, and broadest-first encodes the precedence rule. Same rule 011 applied; 012 extends it with more buckets and wider keyword sets.

**Files in scope:**
- NEW `packages/server/src/setup/mnestra-migrations/012_project_tag_re_taxonomy.sql` (bundled — the canonical copy that the migration runner sees)
- NEW `~/Documents/Graciella/engram/migrations/012_project_tag_re_taxonomy.sql` (byte-identical mirror — Mnestra repo for upstream-of-bundle parity)
- NEW `tests/migration-012-shape.test.js` (structural assertions: BEGIN/COMMIT, 8 RAISE NOTICE bucket probes + 2 audit probes, expected UPDATE patterns, idempotence guard via `WHERE project = 'chopin-nashville'`, no-LEGITIMATE-keyword guard)
- EDIT `tests/migration-loader-precedence.test.js` (length 11 → 12 in two places, basenames array adds `012_project_tag_re_taxonomy.sql`, four assert-message strings bump 11 → 12)

**Out of scope (T2):** PROJECT_MAP / hook (T1), graph UX (T3), LLM classification of residue + 013 audit migration (T4), version bump / CHANGELOG / commit (orchestrator), re-tagging legacy `mnestra_*` tables (Sprint 42+), backfilling missing 008/011 in engram repo (Sprint 42+).

### DONE — 2026-04-28 13:01 ET

Shipped exactly the FIX-PROPOSED scope. All 16 migration-shape + loader-precedence tests green; 56/58 in the broader migration/tag suite green (2 environmental skips, 0 failures). No version bumps, no CHANGELOG, no commits — orchestrator handles those at sprint close.

**Files changed (4 files, +1,079 / -23):**

| File | LOC | Notes |
|---|---|---|
| NEW `packages/server/src/setup/mnestra-migrations/012_project_tag_re_taxonomy.sql` | 397 | Bundled migration. 8 buckets in broadest-first order with widened keyword sets; reuses 011's tightened POSIX `\mDOR\M` pattern verbatim; adds three new buckets (chopin-in-bohemia, chopin-scheduler+Maestro alias, claimguard) that 011 lacked. BEGIN/COMMIT-wrapped, every UPDATE gated by `WHERE project = 'chopin-nashville'` (idempotent on re-run), `[012-retaxonomy]` RAISE NOTICE prefix on all 11 probes (BEFORE + 8 buckets + AFTER + acceptance-target message), `GET DIAGNOSTICS rows_updated = ROW_COUNT` per bucket. |
| NEW `~/Documents/Graciella/engram/migrations/012_project_tag_re_taxonomy.sql` | 397 | Byte-identical mirror per briefing. `diff -q` clean. |
| NEW `tests/migration-012-shape.test.js` | 285 | 12 structural tests: file existence, byte-identical mirror, BEGIN/COMMIT, RAISE NOTICE prefix count, idempotence-gate-on-every-UPDATE, all 8 expected destination tags, widened termdeck keyword set, chopin-scheduler path+Maestro alias, dor reuses 011's tightened pattern (and naked `%dor%` ILIKE is BANNED), legitimate-keyword guard (competition/laureate/applicant/etc. NEVER as a re-tag trigger), `GET DIAGNOSTICS ROW_COUNT` per bucket, BEFORE/AFTER audit blocks probe every tag. |
| EDIT `tests/migration-loader-precedence.test.js` | +6 / -6 | Bumped `length, 11` → `length, 12` in two places, added `'012_project_tag_re_taxonomy.sql'` to both basenames arrays, bumped `'expected 11 mnestra migrations from Sprint 39+'` → `'expected 12 mnestra migrations from Sprint 41+'`, bumped two stale-mnestra assert messages 11 → 12. |

**Bucket sequence in 012 (broadest-first):**

1. `termdeck` — `[termdeck | mnestra | "4+1 sprint" | xterm | node-pty | flashback | memory_items | memory_relationships]` (8 keywords; 011 had 3)
2. `rumen` — `[rumen | rumen-tick | "insight synthesis"]` (3 keywords; 011 had 1)
3. `podium` — `[podium]` (unchanged from 011)
4. `chopin-in-bohemia` — `[bohemia | "chopin in bohemia" | "2026 festival"]` (NEW bucket)
5. `chopin-scheduler` — `[scheduling | schedulingapp | \mMaestro\M]` (NEW bucket; case-sensitive Maestro per orchestrator's mid-inject clarification)
6. `pvb` — `[PVB | petvetbid | "pet vet bid"]` (unchanged from 011)
7. `claimguard` — `[claimguard | gorgias-ticket-monitor | "gorgias ticket monitor"]` (NEW bucket — bare "gorgias" intentionally excluded; the pre-existing `gorgias` and `gorgias-ticket-monitor` tags are separate categories)
8. `dor` — `[\mDOR\M | /DOR/ | ~/Documents/DOR | dor.config | "Rust LLM gateway" | openclaw]` (verbatim from 011)

**What follow-up sprints inherit / orchestrator needs to know at close:**

1. **Apply order at sprint close:** 012 BEFORE 013. T4's 013 migration adds `reclassified_by` + `reclassified_at` columns; 012 doesn't depend on them. T4's runner script then operates on the residue 012 leaves under `chopin-nashville`. T4's runbook in their DONE entry shows the full sequence — orchestrator should follow it as written.

2. **Pre-apply verification (briefing's three audit SELECTs).** Run these before applying 012, capture output, paste into orchestrator's close-out commit. They were un-runnable from this lane (no DB access) but ARE listed in the T2 briefing § "Audit before writing SQL" verbatim. Orchestrator decides whether the per-bucket distribution roughly matches T2's expected widening; if not, T2 spot-check criteria (≤ 5% FP per bucket, otherwise tighten and re-run) kicks in.

3. **Live-apply expectations.** Sprint 39's 011 dry-run predicted ~286 rows but the live apply moved 192 (some keyword overlap, some bucket-1 absorbing earlier). 012's widening should catch substantially more — best estimate is the residue drops from 947 toward ~200 ± 100 before T4's LLM pass. The acceptance target (chopin-nashville < 100 after T2 + T4) builds in headroom for T4 to cover the < 200 → < 100 gap.

4. **Engram repo migration drift (008 + 011 missing).** Out-of-scope for Sprint 41 T2. Flagged in FINDING for Sprint 42+ cleanup. The TermDeck bundle is the canonical source — anyone running `psql -f` from the engram repo would be missing 008 and 011 today, but that path isn't documented or supported. The bundled migration runner (which is the only documented apply path) sees all migrations correctly.

5. **Idempotence verification on re-run.** If the orchestrator applies 012, then accidentally re-applies it (e.g., via a re-run of `migration-runner.js` after a partial failure elsewhere), every bucket's `RAISE NOTICE [012-retaxonomy] bucket N (...): 0 rows re-tagged` is the expected idempotent signal. Non-zero counts on a confirmed second run would indicate WHERE-clause drift — which the shape test would have caught at CI time, but the runtime probe is the second line of defense.

6. **Maestro alias is now persisted in code.** The case-sensitive POSIX word-boundary `\mMaestro\M` regex is in 012 forever. If T1's PROJECT-TAXONOMY.md ever changes the canonical tag from `chopin-scheduler` to something else, this migration would already have run by then — no retroactive change is needed in 012, but a future migration would have to mass-rename the project tag globally (separate cleanup). Not a Sprint 41 concern.

7. **Test-loader bump pattern.** Future migrations (013 from T4, 014+ from later sprints) will need the same loader-precedence bump. The pattern is mechanical: two `length, N` assertions, two basename-array entries, one length-message string in the lexical-order test, two two-arm assert messages in the stale-mnestra test. Total ~6 lines per migration.

---

## T3 — Graph empty-state UX fix + "All projects" picker

### FINDING — 2026-04-28 12:52 ET

Inspected `packages/client/public/graph.js` (684 LOC) and confirmed all three failure modes from the briefing:

1. **State-reset race (lines 210–243).** `fetchGraph` calls `setLoading('Loading graph…')` at the top, then awaits the API. While in flight, the previous render's SVG content (`#graphZoomRoot > g.graph-edges|nodes|labels`) and the previous `#graphEmpty` overlay are still live. If the user switched mode/project (or the previous fetch left an empty state up), the new fetch overlaps with stale UI. The on-success path eventually clears via `renderGraph` (which does `rootSel.selectAll('*').remove()`), but the empty-state branch never clears the prior render — a previously-empty project leaves the "No memories yet" overlay visible, then a re-fetch with results paints nodes UNDER it, producing the screenshot Joshua sent.
2. **Sticky `#graphEmpty` body text (lines 257–273).** `showEmpty()` only mutates `graphEmptyTitle`, never `graphEmptyBody`. After `showDisabled()` rewrites the body to "Graph backend not configured", a subsequent normal empty-state still shows that body — another source of confusing UX.
3. **No "All projects" affordance.** Picker (`#graphProject`) is wired by name only; there is no fallback for users who want to inspect the global graph or recover from a mis-tagged project.

Server-side: `packages/server/src/graph-routes.js` exposes `/api/graph/project/:name`, `/memory/:id`, `/stats`, and `/stats/inference` but no global endpoint. `MAX_NODES_PER_PROJECT = 2000` already exists; the briefing wants a sibling `MAX_NODES_GLOBAL = 2000` plus a `truncated`/`totalAvailable` shape so the client can warn.

CSS gotcha at `style.css:3438`: `.graph-empty { pointer-events: none; }` — the new "View All Projects" button inside the overlay would be unclickable without an override.

### FIX-PROPOSED — 2026-04-28 12:53 ET

**Server (`packages/server/src/graph-routes.js`):**
- Add `MAX_NODES_GLOBAL = 2000` constant.
- Add `fetchAllGraph(pool)`: total-count query (active + non-archived) → CTE-bounded node fetch ordered by `created_at DESC LIMIT MAX_NODES_GLOBAL` with degree subquery → edges where both endpoints land in the node set.
- Register `GET /api/graph/all` returning `{ enabled, stats: { nodes, edges, byType, truncated, totalAvailable }, nodes, edges, totalAvailable, truncated }`. `disabledPayload({ nodes: [], edges: [], totalAvailable: 0, truncated: false })` for the no-pool branch.
- Export `fetchAllGraph` and `MAX_NODES_GLOBAL` from the module.

**Client (`packages/client/public/graph.js`):**
- New `clearGraphSvg()` helper: stops `state.sim`, removes children of `#graphZoomRoot`, nulls `nodeSel/edgeSel/labelSel`.
- New `showToast(msg, durationMs)` helper appended to `#graphStage` with auto-dismiss timer.
- Rewrite `fetchGraph` so the FIRST four lines are `hideEmpty(); clearGraphSvg(); state.nodes = []; state.edges = []; setLoading(...)`. Branch: `state.project === '__all__'` → `/api/graph/all` (showToast on `truncated`); else memory/project as today. On thrown error, `hideEmpty()` before `setLoading(failure msg)`.
- Rewrite `showEmpty` to set BOTH title and body for each branch (project / memory / __all__), and toggle visibility of the new `#graphEmptyAllProjects` button.

**HTML (`packages/client/public/graph.html`):**
- Add `<button id="graphEmptyAllProjects" hidden>View All Projects</button>` inside `.graph-empty`.

**Picker init (`graph.js:613-641`):**
- Prepend `<option value="__all__">All projects</option>` to `#graphProject` regardless of configured-projects count. Drop the `sel.disabled = true` branch (user can always use All Projects).
- Wire `#graphEmptyAllProjects` click → set state to __all__, sync select.value, call `fetchGraph()`.

**CSS (`packages/client/public/style.css`):**
- New `.graph-empty button` rule with `pointer-events: auto;` to defeat the parent's `pointer-events: none;`.
- New `.graph-toast` + `.graph-toast.show` rules positioned absolute top-right of `#graphStage`.

**Tests (`tests/graph-routes.test.js`):**
- `GET /api/graph/all` returns enabled=false when pool absent.
- `fetchAllGraph` returns `truncated:true` when total > MAX_NODES_GLOBAL.
- `fetchAllGraph` returns `truncated:false` when total ≤ MAX_NODES_GLOBAL.
- HTTP test: `GET /api/graph/all` returns `{ enabled, nodes, edges, totalAvailable, truncated, stats }`.

No version bumps, no CHANGELOG, no commits — orchestrator handles those at sprint close.

### DONE — 2026-04-28 12:57 ET

Shipped exactly the FIX-PROPOSED scope. All 27 graph-routes tests green (5 new + 22 existing). `node --check` clean on `graph.js` and `graph-routes.js`. No version bumps, no CHANGELOG, no commits.

**Files changed (5 files, +399 / -23):**

- `packages/server/src/graph-routes.js` (+100): `MAX_NODES_GLOBAL = 2000` constant, `fetchAllGraph(pool)` helper (count-probe → CTE-bounded node fetch ordered by `created_at DESC` with degree subquery → edges scoped to the node id set with `ANY($1::uuid[])`), `GET /api/graph/all` route returning `{ enabled, stats: { nodes, edges, byType, truncated, totalAvailable }, nodes, edges, totalAvailable, truncated }`. `disabledPayload` carries the same shape with empty arrays + zero counts when the pool is absent. New exports: `fetchAllGraph`, `MAX_NODES_GLOBAL`. The CTE pattern matches `fetchProjectGraph`'s shape so future maintainers don't have two query styles to reconcile.
- `packages/client/public/graph.js` (+142 / -23, now 779 LOC): NEW `clearGraphSvg()` (stops `state.sim`, drops it to null, removes children of `#graphZoomRoot`, nulls the three D3 selections); NEW `showToast(msg, durationMs=6000)` (top-right absolute toast in `#graphStage`, transition-based show/hide, single-instance with timer reset on re-fire). `fetchGraph` rewritten to do the four-step reset (`hideEmpty` → `clearGraphSvg` → `state.nodes=[]/edges=[]` → `setLoading`) BEFORE the await — fixes the three-way race. Branches: `__all__` → `/api/graph/all` (showToast on `truncated`), `memory` → unchanged, project default → unchanged. Error path also calls `hideEmpty()` before posting the failure message so the spinner doesn't stack on top of the empty-state. `showEmpty()` rewritten to set BOTH title and body for all three modes (project / memory / `__all__`) and toggle the new `#graphEmptyAllProjects` button visibility per-branch. `hideEmpty()` now also hides the button. Picker init prepends `<option value="__all__">All projects</option>` and never disables the select; the empty-state "View All Projects" button is wired to switch state and re-fetch.
- `packages/client/public/graph.html` (+1): `<button type="button" class="graph-empty-action" id="graphEmptyAllProjects" hidden>View All Projects</button>` inside `.graph-empty`.
- `packages/client/public/style.css` (+53): `.graph-empty .graph-empty-action` rule with `pointer-events: auto` to defeat the parent overlay's `pointer-events: none`, plus hover / focus-visible styling. `.graph-toast` + `.graph-toast.show` rules positioned `absolute` top-right at `z-index: 60` with opacity+translateY transition.
- `tests/graph-routes.test.js` (+126): five new tests — `MAX_NODES_GLOBAL` export contract, `fetchAllGraph` truncated:false branch, truncated:true branch, empty short-circuit (asserts edges query was NOT issued — parity with `fetchProjectGraph`), `GET /api/graph/all` enabled=false branch, full HTTP integration test asserting nodes/edges/byType/totalAvailable/truncated shape.

**What follow-up sprints inherit:**

1. The `__all__` sentinel is reserved at the URL/state layer (`?project=__all__` survives a refresh and renders the global view). Any future picker variant should preserve this exact sentinel — changing it would break shareable links emitted post-this-sprint.
2. `MAX_NODES_GLOBAL` lives next to `MAX_NODES_PER_PROJECT` (both 2000). If Sprint 42+ wants to raise either, do it in lockstep — there's no architectural reason for them to diverge.
3. The All Projects view trades cluster-fidelity for breadth (most-recent N, not most-relevant N). If users complain, Sprint 42+ can add server-side weighting (`ORDER BY degree DESC` or a degree+recency hybrid) without changing the client contract — the response shape stays the same.
4. The empty-state copy now nudges users toward the All Projects view AND mentions mis-tagging — directly references the T1+T2+T4 work landing this same sprint. Once T1's PROJECT-TAXONOMY.md exists, future polish could link to it from the empty state body.
5. `clearGraphSvg` is a reusable helper. If future lanes add more SVG-rendering modes (e.g., timeline view, project-cluster view), they should call it at the start of every render — same pattern.

**Manual reproduction guidance for the orchestrator at close:** load `/graph.html?project=termdeck`, switch picker to `chopin-nashville`, verify previous nodes are cleared and only the loading spinner shows during fetch. Switch to `All projects` and verify the toast fires when the corpus exceeds 2,000 rows. Click a project name in the picker that has no rows (e.g., a freshly-tagged future project) to confirm the new empty-state copy + "View All Projects" button render correctly and the button is clickable.

---

## T4 — LLM-classification of residual uncertain rows

### FINDING — 2026-04-28 12:54 ET

Substrate audit before writing the runner:

- **Residual count baseline:** 947 rows still tagged `chopin-nashville` per orchestrator probe. T2's deterministic re-tag will whittle this down further; T4 only sees what's left after T2 commits. The script's WHERE filter is `project = 'chopin-nashville'`, so it self-adjusts to whatever survives T2.
- **`memory_items` audit columns absent:** `reclassified_by` / `reclassified_at` do **not** exist on `memory_items` today. `inferred_by` lives on `memory_relationships` (Sprint 38 migration 009) but not `memory_items`. Without an audit stamp, rows the LLM votes to *keep* as chopin-nashville would be re-classified on every re-run — non-idempotent. Adding the columns is **required, not optional** as the briefing framed it.
- **Migration numbering in engram:** engram's `migrations/` stops at 010 (no 008, no 011 — bundled has both, engram skipped them; T2 will add 012). My new audit-column migration slots in at **013** per briefing.
- **`@anthropic-ai/sdk` is not in termdeck's package.json today.** Sibling repos use it (engram@^0.39.0, rumen@^0.30.1). T4 adds it to **`devDependencies`** at `^0.39.0` (matches engram) — keeps it out of the published runtime bundle. The script never runs at user runtime; it's a one-shot orchestrator-invoked tool.
- **`pg` is already a runtime dep** (^8.20.0) — script can `require('pg')` without further changes.
- **`tests/relationships.test.ts`:** scanned. It uses fake-Supabase clients, no shared LLM helper to extend. The briefing's "if shared LLM helper exists" condition isn't met — **no test changes from T4**.
- **Env-var prereqs:** `DATABASE_URL` (already used elsewhere in the stack — points to petvetbid Supabase Postgres) and `ANTHROPIC_API_KEY` (Joshua has this in `~/.termdeck/secrets.env` per Sprint 34 conventions). Script preflights both and exits early with a helpful message if missing.
- **Idempotency design:** WHERE clause filters `project = 'chopin-nashville' AND coalesce(reclassified_by, '') <> 'sprint-41-llm-residual'` so rows the LLM stamped "stays chopin-nashville" don't get re-asked next run. The UPDATE writes `reclassified_by` on every row, regardless of whether the project tag actually changes.
- **Robustness:** Haiku occasionally wraps JSON arrays in ```json fences when prompted with "Return ONLY the JSON array" — script strips ``` fences before `JSON.parse`. Also retries on 429/5xx with exponential backoff (matches the Gemini-API rate-limit recipe in global memory; same shape applies to Anthropic API).
- **Cost ceiling:** at briefing's estimate (~$0.004/batch × 48 batches for full 947 rows) ≈ $0.20 total. Default `MAX_BATCHES=50` matches the upper bound; orchestrator can pass `--max-batches=N` to cap or extend.
- **Maestro alias incorporated** (per orchestrator's mid-inject clarification): the prompt's taxonomy block notes that any content referencing "Maestro" as a project name is `chopin-scheduler` — same project, working name divergent from on-disk `SchedulingApp/`.

### FIX-PROPOSED — 2026-04-28 12:55 ET

Three deliverables, no test changes:

1. **`~/Documents/Graciella/engram/migrations/013_reclassify_uncertain.sql`** — adds nullable `reclassified_by text` + `reclassified_at timestamptz` columns to `memory_items` plus a partial index on `reclassified_by` filtered to non-NULL rows (keeps the index small — only stamped rows, never the bulk of the table). Idempotent (`add column if not exists`). Orchestrator applies this BEFORE running the script.
2. **`scripts/reclassify-chopin-nashville.js`** — the runner. CommonJS (matches the rest of the server-side codebase). Imports `pg` (already a runtime dep) and `@anthropic-ai/sdk` (newly-added devDep). Exits 2 on missing env vars; exits 0 on empty residual; exits 1 on unhandled error. Per-batch transactional UPDATE; `--dry-run` skips all DB mutations. Stops after 3 consecutive batch failures so a re-run can resume cleanly.
3. **`package.json`** — adds `@anthropic-ai/sdk@^0.39.0` to `devDependencies` (matches engram). Stays out of the published runtime bundle since the script is orchestrator-only, never user-runtime.

Prompt design: 14-tag canonical taxonomy in alphabetical-meaningful order, explicit Maestro/chopin-scheduler alias note, "default to global only when there is no clear project signal at all" guidance, "if it's clearly Chopin Nashville competition logistics, KEEP as chopin-nashville" reinforcement. Strict response shape: `[{"index":N,"project":"<tag>"}, ...]` only — no commentary, no fences. Script strips ``` fences defensively anyway.

Validation gate: any project tag returned by Haiku that isn't in the 14-tag whitelist is logged as `invalid` and the row stays untouched (no UPDATE). Bad indices (out of range, non-integer) are likewise skipped. Counters: `classified` / `invalid` / `errors` print per batch.

### DONE — 2026-04-28 12:56 ET

**Files changed:**

| File | LOC | Notes |
|---|---|---|
| NEW `~/Documents/Graciella/engram/migrations/013_reclassify_uncertain.sql` | 39 | adds `reclassified_by` + `reclassified_at` columns + partial index. Idempotent. |
| NEW `scripts/reclassify-chopin-nashville.js` | 335 | one-shot Haiku 4.5 batch classifier. `node -c` syntax-clean. |
| `package.json` | +3 | new `devDependencies` block with `@anthropic-ai/sdk@^0.39.0`. No `dependencies` change. |

**Orchestrator runbook for sprint close (paste-ready):**

```bash
# 1. Apply T2's deterministic re-tag (012) and T4's audit columns (013).
psql "$DATABASE_URL" -X -f ~/Documents/Graciella/engram/migrations/012_project_tag_re_taxonomy.sql
psql "$DATABASE_URL" -X -f ~/Documents/Graciella/engram/migrations/013_reclassify_uncertain.sql

# 2. Install the new devDependency.
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
npm install

# 3. Smoke test in dry-run, capped at 3 batches (~60 rows, $0).
source ~/.termdeck/secrets.env  # supplies DATABASE_URL + ANTHROPIC_API_KEY
node scripts/reclassify-chopin-nashville.js --dry-run --max-batches=3

# 4. If smoke output looks sane (spot-check 10–20 of the [dry-run] lines for
#    obvious mis-classifications), run for real with the full default cap.
node scripts/reclassify-chopin-nashville.js

# 5. Verify post-run counts.
psql "$DATABASE_URL" -c "
  select project, count(*) as rows
    from memory_items
   where reclassified_by = 'sprint-41-llm-residual'
   group by 1
   order by 2 desc;"

# 6. If the LLM was systematically wrong on a class, soft-rollback those rows:
#    UPDATE memory_items SET project = 'chopin-nashville', reclassified_by = NULL,
#      reclassified_at = NULL WHERE reclassified_by = 'sprint-41-llm-residual'
#      AND project = '<bad-tag>';
#    Then re-run with a tightened prompt.
```

**What follow-up sprints need to know:**

- **Audit query for any future sprint:** `select count(*), project from memory_items where reclassified_by = 'sprint-41-llm-residual' group by 2;` — this is the slice of rows whose project tag came from a Haiku call, distinguishable from T2's deterministic re-tag (T2 doesn't write `reclassified_by`).
- **Re-runnability:** the script is idempotent on repeat invocation. Adding new chopin-nashville rows later (e.g., a future Sprint 42 backfill) and re-running this script will only classify rows whose `reclassified_by` is NULL or differs from the constant `sprint-41-llm-residual`.
- **Cost actually spent:** logged at the end of each run (`Estimated spend: ~$X.XXX`). Real cost may differ ±20% from estimate based on actual content lengths and Anthropic's per-token pricing.
- **TAXONOMY constant** in the script MUST stay in lockstep with `docs/PROJECT-TAXONOMY.md` (T1's deliverable). If T1's doc grows a new project, update both the array AND the prompt's taxonomy bullet list. Two-line change.
- **Sprint 42 candidate cleanup:** rows the LLM kept as `chopin-nashville` but stamped `reclassified_by = 'sprint-41-llm-residual'` are the *legitimate* competition-management residue. If Joshua wants to inspect those: `select id, left(content, 200) from memory_items where reclassified_by = 'sprint-41-llm-residual' and project = 'chopin-nashville';`.

No version bump. No CHANGELOG. No commit. Orchestrator handles those at sprint close.
