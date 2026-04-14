# Release Checklist — TermDeck / Engram / Rumen v0.2

Manual checklist for Josh. Every step assumes the Sprint 2 diffs have been
reviewed, committed, and pushed to `main` for each repo. None of this is
automated — publishing is deliberately a human-in-the-loop gate.

Working directory references use Josh's local layout:

- `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`
- `~/Documents/Graciella/engram`
- `~/Documents/Graciella/rumen`

Order recommended for a clean cut: **Engram → Rumen → TermDeck**. TermDeck
depends on Engram (via `@jhizzard/engram` at runtime when the bridge is in
`mcp` mode) and Rumen reads Engram's schema, so publishing the layer
underneath first keeps the dependency graph clean.

---

## 0. Preflight (all repos)

Run these for every repo before touching `npm version`:

- [ ] Working tree clean (`git status` empty)
- [ ] On `main`, up to date with `origin/main`
- [ ] Node 24 LTS active locally (`node --version`)
- [ ] All CI checks green on the tip of `main`
- [ ] `CHANGELOG.md` has a `[0.2.0] - 2026-04-13` heading at the top (not under `Unreleased`)
- [ ] `README.md` install instructions reference the published package name and `bin`
- [ ] `npm whoami` returns `jhizzard` (or whichever identity owns `@jhizzard`)
- [ ] `~/.termdeck/secrets.env` has the rotated keys from the post-Sprint-1 rotation — publishing should not depend on the old credentials

---

## 1. `@jhizzard/engram` v0.2.0

```bash
cd ~/Documents/Graciella/engram
```

- [ ] `git pull --ff-only`
- [ ] `rm -rf node_modules && npm install`
- [ ] `npm run typecheck` — clean
- [ ] `npm test` — expect 21+ green (includes Sprint 2 webhook + privacy + layered tests)
- [ ] `npm run build` — verify `dist/mcp-server/index.js` and `dist/src/webhook-server.js` exist
- [ ] Smoke test stdio MCP: `node dist/mcp-server/index.js < /dev/null` exits cleanly
- [ ] Smoke test webhook: `node dist/mcp-server/index.js serve &` then `curl -s :37778/healthz` returns `{"ok":true,...}`; kill the background proc
- [ ] Apply production migration: open Supabase SQL editor, paste `migrations/004_engram_match_count_cap_and_explain.sql`, run, confirm "Success"
- [ ] `npm version 0.2.0 --no-git-tag-version` (skip if the CHANGELOG bump already synced `package.json`)
- [ ] Commit any version bump: `git add package.json package-lock.json && git commit -m "chore: release v0.2.0"`
- [ ] `git tag v0.2.0 && git push origin main --tags`
- [ ] `npm publish --access public`
- [ ] Verify on https://www.npmjs.com/package/@jhizzard/engram — version 0.2.0 listed, README rendered
- [ ] Post-publish smoke: in a scratch dir, `npx @jhizzard/engram serve` starts the webhook on :37778

---

## 2. `@jhizzard/rumen` v0.2.0

```bash
cd ~/Documents/Graciella/rumen
```

- [ ] `git pull --ff-only`
- [ ] `rm -rf node_modules && npm install`
- [ ] `npx tsc --noEmit` — clean
- [ ] GitHub Actions integration-test job is green on the tip of `main` (was red on commit 7e24750; Sprint 2 fix is in the Engram fixture)
- [ ] `npx tsc` — builds `dist/`
- [ ] `DATABASE_URL=... npx tsx scripts/test-locally.ts` against a throwaway DB, confirm at least one `rumen_insights` row written
- [ ] Bump `CHANGELOG.md` `[Unreleased]` → `[0.2.0] - 2026-04-13`
- [ ] `npm version 0.2.0 --no-git-tag-version`
- [ ] Commit: `git add CHANGELOG.md package.json package-lock.json && git commit -m "chore: release v0.2.0"`
- [ ] `git tag v0.2.0 && git push origin main --tags`
- [ ] `npm publish --access public`
- [ ] Verify on https://www.npmjs.com/package/@jhizzard/rumen — version 0.2.0 listed

---

## 3. `@jhizzard/termdeck` v0.2.0

```bash
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
```

- [ ] `git pull --ff-only`
- [ ] `rm -rf node_modules && npm install` — confirm `node-pty` and `better-sqlite3` install from prebuilds (no C++ compile)
- [ ] `node -c packages/server/src/index.js` — parses
- [ ] `node -c packages/server/src/session.js` — parses
- [ ] `node -c packages/cli/src/index.js` — parses
- [ ] Start the server: `npm run server`, open http://localhost:3000, spawn 2 panels, verify PTY + metadata + reply button all work
- [ ] Stop the server; with `ANTHROPIC_API_KEY` set in `~/.termdeck/secrets.env`, run `termdeck --session-logs`, open a panel, run some commands, close the panel, confirm `~/.termdeck/sessions/*.md` contains a Haiku summary
- [ ] Confirm `@jhizzard/termdeck` is not already squatted on npm (`npm view @jhizzard/termdeck` should 404 pre-publish or show 0.1.0)
- [ ] Bump `packages/cli/package.json` version 0.1.0 → 0.2.0
- [ ] Update `CHANGELOG.md` heading to `[0.2.0] - 2026-04-13`
- [ ] Commit: `git add packages/cli/package.json CHANGELOG.md && git commit -m "chore: release @jhizzard/termdeck v0.2.0"`
- [ ] `git tag v0.2.0 && git push origin main --tags`
- [ ] `cd packages/cli && npm publish --access public`
- [ ] Verify on https://www.npmjs.com/package/@jhizzard/termdeck — 0.2.0 listed, README rendered
- [ ] Post-publish smoke on a clean machine or a scratch dir: `npx @jhizzard/termdeck --no-open`, hit http://localhost:3000, spawn one shell panel, `ls`, close — should complete without touching the monorepo's local workspace

---

## 4. Post-release announcement

After all three packages are published:

- [ ] Update the docs-site (TermDeck repo, `docs-site/`) so the synced `README.md` + `CHANGELOG.md` files reflect v0.2.0. `node scripts/sync-content.mjs` then `npx astro build`.
- [ ] Deploy `docs-site/dist/` to the chosen host (Vercel or `termdeck.dev` — whichever is live).
- [ ] Cross-link the three npm pages in the docs-site Overview page.
- [ ] Post promotion drafts from `docs/promotion-drafts/` (if any) to the planned channels.

---

## 5. Rollback plan

If anything goes sideways after `npm publish`:

- `npm unpublish @jhizzard/<pkg>@0.2.0` is allowed within 72 hours of publish, otherwise deprecate with `npm deprecate @jhizzard/<pkg>@0.2.0 "see v0.2.1"`.
- Git: `git revert` the release commit, bump `0.2.1`, go through §1–§3 again.
- Do **not** re-publish the same version number; npm rejects it.
