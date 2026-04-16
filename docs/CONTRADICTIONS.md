# Known Contradictions & Temporary Drift

Ledger of known inconsistencies between code, docs, and launch assets. Each entry has a target resolution sprint. Living document — append new entries as they're discovered.

Last reviewed: 2026-04-16

| # | What | Where | Target |
|---|------|-------|--------|
| 1 | Mnestra `hybrid_search` takes 8 args in the bundled migration, 10 args in the Rumen `relate.ts` call site | `config/supabase-migration.sql` vs `rumen/src/relate.ts` | Sprint 8 |
| 2 | Preflight probe hits `/health`, Mnestra docs reference `/healthz` (fix landed in commit `ddb2e53` for the probe, docs drift still in upstream Mnestra repo) | `packages/server/src/preflight.js` vs mnestra docs | Sprint 8 |
| 3 | `engram_*` table names still appear in the RAG tables section of the example config | `~/.termdeck/config.yaml` template and any deployed copies | Sprint 8 |
| 4 | `getRumenPool` failure flag is permanent within a process — no TTL or retry, so a transient Rumen outage at boot permanently disables insights until restart | `packages/server/src/index.js` | Sprint 8 |
| 5 | Rumen `relate` embedding path has zero unit test coverage; the 8-vs-10-arg mismatch (#1) would not be caught by the existing suite | `rumen/tests/relate.test.ts` | Sprint 8 |
| 6 | `docs-site/src/content/docs/engram/` directory still contains "Mnemos" branding throughout (index.md, source-types.md, integration.md, changelog.md, blog posts) — T1 Sprint 7 cleans blog posts only, not the `engram/` subdirectory | `docs-site/src/content/docs/engram/**` | Sprint 8 |
| 7 | Version skew: `package.json` at 0.3.2, but historical `CHANGELOG.md` entries stopped at 0.1.1 until Sprint 7 T1 backfills 0.2.x and 0.3.x | `package.json` vs `CHANGELOG.md` | Sprint 7 (T1) |
| 8 | `docs-site/src/content/docs/engram/` is routed under `/engram/*` paths; renaming to `/mnestra/*` will break any external links that have been shared | docs-site routing + any external backlinks | Sprint 8 |

## How to add entries

1. Observe drift between two sources of truth (code/docs/config/launch copy).
2. Add a row with the shortest accurate description, both locations, and the earliest sprint in which you intend to resolve it.
3. If the target sprint passes without resolution, re-date the row or escalate in that sprint's STATUS.md.

## Triage rules

- A contradiction that actively misleads a *first-run user* is Sprint N (current) — block release.
- A contradiction only visible to contributors / in historical narrative is Sprint N+1.
- A contradiction that is load-bearing for an architectural decision becomes its own spec doc, not a ledger row.
