# T2 — doctrine-scan (detect + synthesize) (rumen)

**cwd:** `~/Documents/Graciella/rumen` · **Model:** Claude Sonnet · **Repo:** rumen (native TS).

You own the **synthesize side**: DB-side density clustering over the curated memory pool → Haiku drafts → `doctrine_registry` staging rows. **You DETECT and DRAFT only. You do NOT write `memory_items`** — that flow-back is T3's job (hard lane boundary, `CONTRIBUTING.md:7` ground-rule-1 REJECTS any new non-`rumen_*` write path in a rumen PR).

## Boot
1. `memory_recall(project="termdeck", query="Sprint 79 doctrine-scan density clustering centroid Haiku curated pool rumen")`
2. `memory_recall(query="rumen doctrine_registry doctrine_jobs graph-inference edges cluster")`
3. Read `~/.claude/CLAUDE.md` (§ RLS hygiene) + rumen `./CLAUDE.md` + `CONTRIBUTING.md`.
4. Read `docs/...` → the termdeck `docs/sprint-79-elevation-capture/PLANNING.md` + `DISPATCH-GUIDE.md` §3-T2 + `ULTRAPLAN-2026-06-12.md` §3.4 (they live in the termdeck repo — read via absolute path `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-79-elevation-capture/`).
5. **Re-verify anchors.** rumen took the **0.6.1 hotfix on 07-01** (post-guide) touching the tick pipeline (index/relate/synthesize/db/types) — your README/init anchors may have line-drifted. `git checkout main && git pull`, branch `sprint-79-doctrine-scan`.

## Migration = `004_doctrine_registry.sql` (VERIFIED next-free on disk — NOT 003; ULTRAPLAN §4 "003" is stale)
- `doctrine_registry`: status enum `candidate|drafted|proposed|ratified|rejected|superseded`, `cluster_member_ids`, `centroid vector(1536)`, `occurrence_count`, `projects[]`, `reinforced_after_ratification`, member content-hash snapshot, `origin`.
- `doctrine_jobs` heartbeat — reuse the `rumen_jobs` shape (`migrations/001` ~L15-26).
- **Five RLS gates on BOTH tables** (ENABLE RLS + SECURITY DEFINER funcs REVOKE-FROM-PUBLIC + GRANT service_role + SET search_path).

## Edge Function `doctrine-scan`
- Drop `packages/server/src/setup/rumen/functions/doctrine-scan/{index.ts,tsconfig.json}` into the **termdeck** bundle — auto-enumerated by `listRumenFunctions()` (no FUNCTIONS-list edit).
- **The pg_cron SCHEDULE is NOT auto-wired** — `init-rumen.js` `SCHEDULE_MIGRATIONS` hardcodes only 002/003 matchers. Adding a doctrine-scan cron matcher is a **termdeck edit → HANDOFF-REQUEST to T3** (it owns termdeck). Schedule **03:30 UTC** (after graph-inference 03:00).
- **Version-pin:** if it imports `npm:@jhizzard/rumen`, add to `FUNCTIONS_WITH_VERSION_PLACEHOLDER` + use `__RUMEN_VERSION__` (like rumen-tick) — **never hardcode a stale literal.**

## Algorithm
- Curated pool only: `decision|architecture|preference|bug_fix` (~1,021 rows — quality gate AND cost cap).
- **Density clustering: mean pairwise similarity ≥ 0.85** (NOT bare connected-components — that gives transitive-chain mush), N≥3 AND (≥2 projects OR ≥21d spread). Consume the orphaned **graph-inference edges** (first consumer). Centroid-fingerprint dedup + reinforcement counting with the project-scope compliance guard (AMEND-13: reinforcement in a NEW project = scope expansion, append project, no flag).
- Haiku synthesis: **cap 10 calls/scan**, inputs truncated per call. Kitchen-vs-recipe 4-question classifier, coherence/split check, evidence = dates + gists (**NO verbatim quotes**). `trigger_hints` **shadow-mode only** — log `doctrine_hits`, NEVER inject pre-ratification. Rejected-with-reason rows kept (anti-rescan).
- **Fail-soft no-key:** no `ANTHROPIC_API_KEY` → Phase-A SQL detection still runs, candidates park `status='candidate'` with a jobs-row note (distinguishable from a flatline). Hash-drift re-synthesis capped 1/row/30d.
- Heartbeat records substrate sanity per scan (edge count, pool size, component histogram).

## Also (in rumen repo)
- Fix `README.md:188` false flow-back claim. **The `init-rumen.js:965` wording fix is a termdeck file → HANDOFF to T3, not your edit.**

## Acceptance (read-only dry-run FIRST)
- The three known clusters surface as candidates with sane membership: **auditor-checkpoint (~8), CPU-liveness (~7), RLS (~4)**.
- An incoherent synthetic cluster gets **split**.
- No-key path verified by unsetting the secret in a branch → parks candidate.
- `doctrine_jobs` row written every run; supabase advisors clean on new objects.

## Seams
- **HANDOFF-REQUEST to T3** for: (a) the `SCHEDULE_MIGRATIONS` doctrine-scan cron matcher, (b) the `init-rumen.js:965` fix.
- Post `### [T2] VERB 2026-07-05 HH:MM ET — gist`. No commits / version bumps / CHANGELOG.
