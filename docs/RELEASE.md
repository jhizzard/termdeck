# TermDeck Release Protocol

**The order is strict.** Violating it leaves `origin/main` lying about what's on npm — anyone running `git pull && npm install -g .` from the cloned repo gets one version while `npm install -g @jhizzard/termdeck` gets another. That kind of skew is hard to debug after the fact.

## When to release

| Sprint scope | Bump |
|---|---|
| Touched `packages/server/`, `packages/cli/`, `packages/client/`, `config/`, or root `package.json` | Patch (X.Y.**Z**+1) |
| New user-visible feature, no breaking changes | Minor (X.**Y**+1.0) |
| Breaking change to CLI flags, config schema, or HTTP API | Major (**X**+1.0.0) |
| Docs / sprint planning / blog posts only | No release — just commit |

The orchestrator decides at sprint close. Don't bump versions inside a lane.

## Files to bump

Update both, every release:

1. **`package.json`** (root) — this is `@jhizzard/termdeck` on npm.
2. **`packages/stack-installer/package.json`** — bump as **audit-trail-only** even if the installer code is unchanged. The convention: every published `@jhizzard/termdeck-stack` should declare which `@jhizzard/termdeck` version it validated against. This bump exists so the installer's published trail stays aligned with the rest of the stack.

Do NOT bump these on every release (they have independent versions, generally not republished):

- `packages/cli/package.json`
- `packages/server/package.json`
- `packages/client/package.json`

## CHANGELOG.md

Add a `## [X.Y.Z] - YYYY-MM-DD` block at the top, above the previous release. Match the existing dense-bullet-per-deliverable style (see [0.7.2] for the canonical shape).

Sections used: `### Added`, `### Changed`, `### Fixed`, `### Notes`. The `### Notes` section is the right home for: deferred items, pre-existing test debt, sprint wall-clock, what's queued for the next sprint, and any explicit out-of-scope flags.

## Publish sequence — strict order

1. **Verify the tarball.** From repo root:
   ```bash
   npm pack --dry-run
   ```
   Check the file list for every required asset. Common gaps: anything under `config/` that the runtime references at install time (e.g., `config/transcript-migration.sql` — confirmed required by `migration-runner.js:33`; must be listed in the root `package.json` `files` array). If the file isn't in the tarball but the code references it, fix the `files` array before publishing.

2. **Publish termdeck.** From repo root:
   ```bash
   npm publish --auth-type=web
   ```
   The `--auth-type=web` flag forces the browser-based Passkey flow (npm CLI ≥9.5). **Joshua taps his Passkey.** Publishes `@jhizzard/termdeck@X.Y.Z`. The terminal blocks until auth completes.

3. **Publish stack-installer.** From `packages/stack-installer/`:
   ```bash
   cd packages/stack-installer && npm publish --auth-type=web
   ```
   Same `--auth-type=web` flag, same Passkey flow. Publishes `@jhizzard/termdeck-stack@A.B.C`.

4. **Push to origin.** After both publishes succeed:
   ```bash
   git push origin main
   ```

If publish at step 2 or 3 fails — **do NOT push.** Either fix the issue and retry the publish, or `npm unpublish` (within 24h of accidental publish) and retry. Never push a commit claiming a version is shipped when it isn't.

## Authentication: Passkey, NOT OTP

**Joshua does NOT use OTP codes.** He has no authenticator app set up for npm, and no automation token. **Every `@jhizzard/*` publish authenticates via web Passkey** — modern npm CLI (≥9.5) opens a browser window when `npm publish` runs without an existing valid session, and Joshua taps his hardware-backed Passkey to authorize.

**For agent sessions:** run `npm publish --auth-type=web` (no `--otp` flag, no token). The `--auth-type=web` flag is required because the @jhizzard scope has `auth-and-writes` 2FA enabled, which without the flag will try to require an OTP and fail with `EOTP`. With the flag, npm opens a browser window on Joshua's machine, he taps his Passkey, and the agent terminal unblocks once auth completes.

If `npm publish` fails with `EOTP` or "requires a one-time password" — you forgot the `--auth-type=web` flag. Add it and retry. Do **not** ask Joshua for an OTP code — the answer will always be "I don't have one."

## Companion artifacts (recommended, not strictly required)

For notable releases:

- **Blog post:** `docs-site/src/content/docs/blog/vXX-NAME.mdx`. Start with `draft: true`; flip to `false` after Joshua reviews. Reference the CHANGELOG entry; lead with the user-visible change, not the internal lane structure.
- **Docs-site changelog mirror:** `docs-site/src/content/docs/termdeck/changelog.md`. Mirror the CHANGELOG.md entry verbatim or with light editing.
- **Portfolio bump:** `~/Documents/Graciella/joshuaizzard-dev/...` — version badge update.

For patch releases (most), skip these unless the patch fixes something user-facing that's been blogged about previously.

## Verification after publish

```bash
npm view @jhizzard/termdeck version           # expect X.Y.Z
npm view @jhizzard/termdeck-stack version     # expect A.B.C
```

Then dogfood: `npm install -g @jhizzard/termdeck@latest && termdeck --version` on the daily-driver machine. If anything regresses, file an immediate hotfix (X.Y.Z+1).

## Lessons locked in (don't rediscover these)

- **Sprint 35 close-out (2026-04-27):** orchestrator pushed before publishing, then `npm publish` blocked because the agent invoked it with `--otp=<code>` instead of the bare Passkey-flow form. Origin/main claimed v0.7.3 while npm still showed v0.7.2 for ~10 min. Recovery: bump stack-installer audit-trail, two publishes (bare `npm publish`, Passkey in browser), push the bump commit. **Lesson: publish first, push second, always. And never use `--otp` for `@jhizzard/*` — it's Passkey or nothing.**
- **Same close-out:** `config/transcript-migration.sql` was not in the root `package.json` `files` array but `migration-runner.js:33` referenced it. The `fs.existsSync` guard hid the gap (silent skip). Brad's 2026-04-27 crash log surfaced it. **Lesson: `npm pack --dry-run` and grep for every file the runtime references before publishing.**
- **Stack-installer audit-trail bump** is a convention, not a code-changes-required rule. Bump it every release even if its source is untouched, so the published trail matches the rest of the stack.
- **Passkey vs OTP confusion** has bitten this project at least once (Sprint 35 close-out). Memory has a global preference recording the constraint; CLAUDE.md hard rule references this doc; this doc says it explicitly. Three layers of redundancy because it's a high-friction failure mode.
