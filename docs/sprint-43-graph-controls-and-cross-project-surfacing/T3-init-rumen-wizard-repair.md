# Sprint 43 — T3: `init --rumen` wizard repair (rumenFunctionDir resolution + graph-inference deploy)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Sprint 42 close-out hit `Error: entrypoint path does not exist (supabase/functions/rumen-tick/index.ts)` because:
1. `rumenFunctionDir()` (`packages/server/src/setup/migrations.js:76`) tries `require.resolve('@jhizzard/rumen/package.json')` then falls back to `SETUP_DIR/rumen/functions/rumen-tick`.
2. The npm `@jhizzard/rumen` package's `files` array is `["dist", "migrations", "README.md", "LICENSE", "CHANGELOG.md"]` — **no `supabase/functions/`**.
3. The fallback path inside TermDeck's `setup/` is never populated either.

Result: any user without a sibling `~/Documents/Graciella/rumen` repo (= every fresh user) hits this error. Joshua manually deployed `graph-inference` from the rumen repo as a workaround; that doesn't generalize.

## Three options — lane brief picks one

**(a) Ship `supabase/functions/` in `@jhizzard/rumen` npm package.** 1-line change in `~/Documents/Graciella/rumen/package.json` `files` array + republish. Pro: zero TermDeck change. Con: extra rumen publish on every Edge Function update; couples Rumen npm release to TermDeck wizard's source-of-truth.

**(b) Bundle the Rumen Edge Function source into TermDeck.** Mirror the migrations pattern at `packages/server/src/setup/rumen/functions/{rumen-tick,graph-inference}/`. CI sync from sibling rumen repo at TermDeck release time. Pro: matches existing migrations bundling; one source of truth at TermDeck release; no Rumen-side change. Con: TermDeck repo grows; sync script needs to exist (NEW).

**(c) Detect source from a known set of paths.** Try `~/Documents/Graciella/rumen`, npm global, npm local, etc. Pro: no bundling needed. Con: brittle; depends on Joshua's directory layout; doesn't help fresh users without the rumen repo.

**Recommendation: option (b).** Matches how migrations are bundled. Sync script: `scripts/sync-rumen-functions.sh` runs `cp -r ~/Documents/Graciella/rumen/supabase/functions packages/server/src/setup/rumen/`. Add to TermDeck's pre-publish hook (or call manually before `npm publish` per RELEASE.md).

## Plus: extend `init --rumen` to deploy graph-inference too

Currently `deployFunction` only deploys `rumen-tick`. Sprint 42 T1's `graph-inference` deploy is manual. Refactor to deploy BOTH functions in one `init --rumen` flow.

## Files
- `packages/server/src/setup/migrations.js:76` — `rumenFunctionDir()` resolution chain
- `packages/cli/src/init-rumen.js::deployFunction` — extend to deploy both functions, or factor out a `deployFunctions()` helper that takes a list
- NEW `packages/server/src/setup/rumen/functions/rumen-tick/index.ts` (option b — bundle the source)
- NEW `packages/server/src/setup/rumen/functions/graph-inference/index.ts` (option b)
- NEW `scripts/sync-rumen-functions.sh` (option b — for TermDeck release flow)
- NEW `tests/init-rumen-deploy.test.js` — covers the multi-function deploy path with stubbed `supabase` shell calls

## Acceptance criteria
1. `init --rumen` succeeds on a fresh machine (no sibling rumen repo) without manual workarounds.
2. Both `rumen-tick` and `graph-inference` Edge Functions deploy successfully.
3. Migration 002 + 003 apply with correct project-ref substitution (already working post-Sprint-42 T3).
4. Existing tests still pass.
5. RELEASE.md updated with the new `npm run sync-rumen-functions` pre-publish step (or auto-hook into `prepublishOnly`).

## Lane discipline
- Append-only STATUS.md updates with `T3: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T3 owns init-rumen wizard + Edge Function source bundling. Does NOT touch graph viewer (T1), flashback (T2), or Telegram (T4)

## Pre-sprint context

- Sprint 42 T3 fixed the migration 003 templating (init-rumen now applies BOTH 002 and 003). This lane fixes the parallel Edge Function deploy gap.
- Joshua's manual workaround at Sprint 42 close: `cd ~/Documents/Graciella/rumen && supabase functions deploy graph-inference --project-ref luvvbrpaopnblvxdxwzb`. Worked because Joshua has the rumen repo locally; doesn't generalize.
- The `rumen-tick` Edge Function (Sprint 27 era) and `graph-inference` Edge Function (Sprint 38 / Sprint 42 rewrite) both live in `~/Documents/Graciella/rumen/supabase/functions/`. Both need to deploy as part of `init --rumen`.
