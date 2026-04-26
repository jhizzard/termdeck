# T1 — Writer-side audit + fix

You are Terminal 1 in Sprint 34. Your lane: every TermDeck-side code path that writes a `project` field on a `memory_items` row. Find which path emits `chopin-nashville` for TermDeck content, fix it, lock it down with a regression test.

## Read first
1. `docs/sprint-34-project-tag-fix/PLANNING.md` — full sprint context
2. `docs/sprint-34-project-tag-fix/STATUS.md` — protocol
3. `docs/sprint-33-flashback-debug/POSTMORTEM.md` — the BROKEN-AT-T3 finding that drives this sprint
4. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
5. `packages/server/src/rag.js` (`resolveProjectName`, `_projectFor`)
6. `packages/server/src/mnestra-bridge/index.js` (look for any tag-emission code path that doesn't go through `resolveProjectName`)
7. The v0.7.1 commit (6c46725) so you don't accidentally undo the analyzer fix

## You own
- `packages/server/src/rag.js`
- `packages/server/src/mnestra-bridge/index.js`
- `packages/server/src/session.js` — read-mostly. If you have to write here, post a CLAIM and keep edits MINIMAL.
- `tests/project-tag-resolution.test.js` (NEW)

## You DO NOT touch
- T2's SQL files (`scripts/migrate-chopin-nashville-tag.sql`, `docs/sprint-34-project-tag-fix/SQL-PLAN.md`)
- T3's test files (`tests/project-tag-invariant.test.js`, `tests/flashback-e2e.test.js`)
- T4's docs/version files (`CHANGELOG.md`, `package.json`, etc.)
- `~/Documents/Graciella/rumen/` — READ-ONLY for orientation. If Rumen also emits the wrong tag, post a FINDING noting the file/line; the Rumen-side fix is a separate `@jhizzard/rumen@0.4.4` ship and not in this sprint's scope.

## Audit checklist

1. **Trace `resolveProjectName(cwd, config)`** — does it actually do longest-prefix? Read the function carefully. Memory says it walks `config.projects`, sorts by `path.length` desc, picks the entry whose resolved path is a prefix of cwd. Confirm. If it's not actually longest-prefix (e.g. first-match wins after a sort that doesn't properly compare), that's the bug.
2. **Check every writer call site for `project`.** grep for `project:` in mnestra-bridge/index.js and session.js. Does every call go through `_projectFor()` or `resolveProjectName()`? If anything walks path segments directly (`cwd.split('/').includes('ChopinNashville')` or similar), THAT'S the path-segment hack memory called out in Sprint 22.
3. **Ground truth probe.** With a real config.yaml in `~/.termdeck/config.yaml`, instantiate `resolveProjectName('/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck', config)`. What does it return? If `chopin-nashville`, the function itself is broken. If `termdeck`, the function is right but a different writer is emitting the wrong tag.
4. **Audit Rumen extract/synthesis** (READ-ONLY, in `~/Documents/Graciella/rumen/`). Does Rumen tag synthesized insights with the same project as the source memories, or does it re-derive from session_id → cwd? If re-derive, it might have its own resolveProjectName — and that one might be broken.

## Fix shape

Once you find the bug:
- If `resolveProjectName` is broken → fix it in rag.js. Add tests that pin `/some/path/with/ChopinNashville/in/it/SideHustles/TermDeck/termdeck` resolves to `termdeck`, not `chopin-nashville`.
- If a writer bypasses `resolveProjectName` → route it through. Don't reimplement.
- Add a `[mnestra-bridge]` or `[rag]` log line on every memory write: `console.log('[<tag>] writing memory project=' + project + ' cwd=' + cwd)`. Future regressions become observable.
- New test `tests/project-tag-resolution.test.js`: at minimum, 4 cases:
  - leaf wins over ancestor (`/a/b/c/d` with config.projects.outer={path:/a/b}, config.projects.inner={path:/a/b/c} → resolves `inner`)
  - explicit `meta.project` wins over cwd resolution
  - missing config.projects → fallback to last path segment
  - empty config → returns `null` or sensible default

## Output

- `FINDING` line per code path with the verdict
- `FIX-PROPOSED` with diff stats and safety analysis
- `DONE` with file list and test count
- Do NOT bump versions, do NOT touch CHANGELOG.md, do NOT commit. T4 + orchestrator integrate.

## Reference memories
- `memory_recall("chopin-nashville tag bug Mnestra bridge directory path segments Sprint 22")`
- `memory_recall("resolveProjectName longest prefix config.projects")`
- `memory_recall("Rumen extract synthesis project tagging")`
