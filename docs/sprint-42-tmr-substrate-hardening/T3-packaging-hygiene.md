# Sprint 42 — T3: Packaging hygiene — migration 003 templating + Mnestra main field

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Two small fixes paired into one lane.

**(a) Migration 003 templating fix.** `003_graph_inference_schedule.sql` ships with a `<project-ref>` placeholder; stack-installer should substitute at apply time using the user's Supabase project ref (already resolved during the Mnestra-MCP setup wizard).

**(b) Mnestra `main` field correction.** `package.json "main": "./dist/index.js"` is broken since v0.2.0 — the actual file is at `dist/src/index.js` due to tsconfig `rootDir: "."` preserving source layout. Cosmetic; consumers use `bin`. Trivial fix.

## Files
- NEW `packages/stack-installer/src/migration-templating.js` — reads each `*.sql` looking for `<project-ref>` markers, substitutes per the user's stored project ref, applies via psql
- `packages/stack-installer/src/index.js` — call the templating before psql apply
- `~/Documents/Graciella/engram/package.json` — correct main field (`./dist/index.js` → `./dist/src/index.js`)
- Tests for both changes

## Acceptance criteria
1. Stack-installer correctly substitutes `<project-ref>` in migration 003 during a fresh install (verified against a tmp test schema).
2. Mnestra `package.json "main"` field resolves cleanly via `node -e 'require("@jhizzard/mnestra")'` without throwing.

## Lane discipline
- Append-only STATUS.md updates with `T3: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T3 owns stack-installer migration apply path + Mnestra package.json. Does NOT touch graph-inference function (T1), pty-reaper server route (T2), or dashboard UI (T4)

## Pre-sprint context
- Migration 003 templating bug caught at Sprint 38 close. Cleanly bounds Brad-class fresh-install path.
- Mnestra `main` field has been latent broken since v0.2.0; consumers haven't hit it because the npm `bin` resolves correctly.
- Both cosmetic-but-correctness fixes; both bound the clean-install user experience.

## Coordination
- T3's migration 003 templating fix needs to play nicely with T1's re-enabled cron. Sequence at sprint close: T3 re-applies migration 003 with substituted project ref (orchestrator does this manually if T3 ships only stack-installer changes), then T1's manual cron fire validates the full path end-to-end.
