# T4 — Docs, version bumps, blog draft, integration

You are Terminal 4 in Sprint 32 / v0.7.0 of TermDeck. Your lane: docs + version bumps + the v0.7 blog post. You do NOT touch any source code. You watch STATUS.md and only bump the versions / write the changelog after T1, T2, and T3 have all posted DONE.

## Read first
1. `docs/sprint-32-v070/PLANNING.md` — sprint overview, especially the v0.7.0 narrative ("Trust the install at runtime")
2. `docs/sprint-32-v070/STATUS.md` — your trigger condition is "T1 DONE + T2 DONE + T3 DONE all present"
3. The v0.6.9 changelog entries in `CHANGELOG.md` and `packages/stack-installer/CHANGELOG.md` — match the structure
4. `packages/cli/src/init-mnestra.js` and `init-rumen.js` — for cross-references
5. The two existing draft blog posts you'll be working alongside:
   - `docs-site/src/content/docs/blog/v06-lineage.mdx` (already drafted, just published)
   - The portfolio blog at `~/Documents/Graciella/joshuaizzard-dev/src/content/blog/five-bug-reports-in-thirty-six-hours.mdx`

## You own these files
- `package.json` (root) — version bump `0.6.9` → `0.7.0`
- `packages/cli/package.json` — version bump
- `packages/stack-installer/package.json` — version bump `0.2.8` → `0.3.0` (minor bump matches root)
- `CHANGELOG.md` — new `## [0.7.0]` section
- `packages/stack-installer/CHANGELOG.md` — new `## [0.3.0]` section
- `docs-site/src/content/docs/termdeck/changelog.md` — mirror the root changelog entry
- NEW `docs-site/src/content/docs/blog/v07-runtime.mdx` — `draft: true`. The "v0.7 — runtime health" companion to the v06-lineage post.
- `README.md` — only if it has "Recent releases" or pinned version mentions; check first, edit only if drift is real
- `~/Documents/Graciella/joshuaizzard-dev/src/app/page.tsx` — TermDeck status line bump `v0.6.9` → `v0.7.0`. CROSS-REPO file. Commit separately.

## You DO NOT touch
- Anything in `packages/server/src/` (T1, T3 lanes)
- Anything in `packages/client/public/` (T1 lane)
- Anything in `tests/` (T1, T2, T3 lanes)
- `packages/server/src/setup/preconditions.js` (settled in v0.6.9, leave alone)

## What "done" looks like

### Phase A — early work, can start immediately

1. Draft the v0.7 blog post `docs-site/src/content/docs/blog/v07-runtime.mdx`. Frontmatter:
   ```
   ---
   title: "v0.7 — trust the install at runtime"
   description: "v0.6 closed install-time correctness with auditPreconditions and verifyOutcomes. v0.7 extends that pattern into runtime: themes that follow your config edits, auth that doesn't ask twice, and a /api/health/full endpoint that answers 'is this install actually healthy right now?'"
   draft: true
   ---
   ```
   Three sections:
   - **What v0.7 changes** — theme persistence (T1), auth-cookie 30 days (T2), `/api/health/full` (T3). Brief, user-facing. Reference Brad's incident reports as the motivating signals.
   - **The arc from v0.6 to v0.7** — install-time correctness → runtime correctness. The `auditPreconditions()` framework grew up.
   - **Upgrade path** — `npm cache clean --force && npm i -g @jhizzard/termdeck@latest`, restart termdeck, themes start tracking config.yaml, cookies persist 30 days, `curl http://localhost:3000/api/health/full | jq` works.

2. Write the CHANGELOG.md `## [0.7.0]` block with PLACEHOLDER bullets you'll fill from STATUS.md DONE summaries. Same for stack-installer changelog and docs-site changelog. The structure is the v0.6.9 pattern: ### Added, ### Notes, recovery line.

3. Update the portfolio status line at `~/Documents/Graciella/joshuaizzard-dev/src/app/page.tsx` — search for `Live · v0.6.9` and bump to `Live · v0.7.0`. Type-check with `cd ~/Documents/Graciella/joshuaizzard-dev && npx tsc --noEmit`.

### Phase B — after T1 + T2 + T3 all DONE in STATUS.md

4. Read each Tn DONE summary from STATUS.md. Fill the placeholder bullets in the changelog entries with the actual landed details. Match the v0.6.9 voice — concrete, name the user-visible change, name the file paths, name the recovery if any.

5. Bump the three package.json files: root `0.6.9` → `0.7.0`, cli-internal `0.2.7` → `0.3.0`, stack-installer `0.2.8` → `0.3.0`.

6. Add the docs-site changelog compare-link block at the bottom:
   ```
   [0.7.0]: https://github.com/jhizzard/termdeck/compare/v0.6.9...v0.7.0
   ```

7. **DO NOT COMMIT.** Post `[T4] READY` in STATUS.md. The orchestrator (terminal 5 / this conversation) reviews everything together and creates the v0.7.0 commit.

## Test plan you DO NOT run yourself

The orchestrator runs the full CLI suite once T1+T2+T3+T4 are all done, before commit. If anything fails, it bounces back to the relevant Tn. You don't need to run tests yourself — your changes are docs/versions only and don't affect the test suite directly.

## Protocol

- Post `[T4] CLAIM <file>` before each edit (multiple files, expect a few CLAIM lines)
- After Phase A is done, post `[T4] PHASE A DONE — blog draft + placeholder changelogs ready, awaiting T1/T2/T3`
- After Phase B is done, post `[T4] READY — all changelogs filled, versions bumped, awaiting orchestrator review`
- Do NOT push to GitHub. Do NOT publish to npm. The orchestrator handles those.

## Reference memories
- `memory_recall("v0.6.9 changelog audit verify")` — voice, structure
- `memory_recall("publishing constraint passkey browser")` — Josh authenticates npm publish via passkey, NEVER --otp
- `memory_recall("audit-trail bump pattern")` — why stack-installer bumps alongside termdeck even when its behavior is unchanged
