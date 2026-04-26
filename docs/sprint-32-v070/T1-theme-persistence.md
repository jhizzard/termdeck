# T1 — Theme persistence

You are Terminal 1 in Sprint 32 / v0.7.0 of TermDeck. Your lane: render-time theme resolution so that editing `~/.termdeck/config.yaml` and restarting the server actually changes existing terminals' themes. Today the wizard writes the resolved theme into SQLite at session creation; existing rows never reflect later config edits.

## Read first
1. `docs/sprint-32-v070/PLANNING.md` — the sprint overview, especially the "Theme persistence (T1)" subsection of "Architectural decisions"
2. `docs/sprint-32-v070/STATUS.md` — the protocol for posting CLAIM / DONE / REQUEST / BLOCKED
3. `CLAUDE.md` — project conventions (CommonJS, no TypeScript, vanilla JS client, `[tag]` log prefixes)

## You own these files (everything else is off-limits)
- `packages/server/src/database.js` — schema migration code (the in-memory init, NOT a SQL file)
- `packages/server/src/session.js` — session class: theme write paths, meta.theme getter
- `packages/server/src/theme-resolver.js` — NEW file, the `resolveTheme(session, config)` helper
- `packages/client/public/app.js` — but ONLY the theme region: `changeTheme()`, `getThemeObject()`, the theme dropdown render block, and the new "Reset to default" link wiring
- `tests/theme-persistence.test.js` — NEW file

## You DO NOT touch
- `packages/server/src/index.js` (T3's lane — it touches index.js for the health endpoint)
- `packages/server/src/auth.js` (T2's lane)
- Any file in `packages/server/src/setup/` (those are the wizards — leave alone)
- Any other client region — only the theme-related code

## What "done" looks like

1. `sessions` table gets a new column `theme_override TEXT NULL`. Add this in `database.js`'s init code with a defensive `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS theme_override TEXT` (SQLite supports IF NOT EXISTS via better-sqlite3 if you wrap in try/catch on duplicate-column error — pick one approach and document why in a comment).
2. **Backfill on migration**: existing rows with `theme IS NOT NULL` get `theme_override = theme`. This treats existing values as user-set so customizations from before v0.7.0 survive the upgrade. Run this as a one-shot at db init, idempotent (only fires when `theme_override` is universally NULL).
3. Drop the dead `projects.default_theme` column (never read or written; remove from CREATE TABLE in `database.js` and add a defensive `ALTER TABLE projects DROP COLUMN IF EXISTS default_theme`). Confirm with grep that nothing reads it before dropping. *If grep shows ANY read, post BLOCKED in STATUS.md and stop.*
4. New file `packages/server/src/theme-resolver.js`:
   ```js
   function resolveTheme(session, config) {
     return (session.theme_override
       || (config.projects && session.project && config.projects[session.project] && config.projects[session.project].defaultTheme)
       || config.defaultTheme
       || 'tokyo-night');
   }
   module.exports = { resolveTheme };
   ```
5. In `session.js`, the `meta` object's `theme` field is now resolved at read time. Two ways to do this:
   - **Preferred**: `meta` becomes a getter / accessor that calls `resolveTheme(this, this.config)` whenever theme is read. Requires plumbing `config` into the Session instance — pass it via the constructor.
   - Alternative: keep `meta.theme` as a static field but recompute and write it on every metadata broadcast. Simpler but less elegant.
   Pick the cleaner one and document the choice in the session.js header comment.
6. User-initiated theme change via UI: server PATCH `/api/sessions/:id` with `{ theme: 'dracula' }` writes to `theme_override`. PATCH with `{ theme: null }` clears `theme_override` (reverts to config-derived default). Existing PATCH path in session.js already handles `theme` updates — adapt to write to `theme_override` instead of `theme`.
7. Client `getThemeObject(themeId)` is unchanged.
8. Client `changeTheme(sessionId, themeId)` is unchanged for the dropdown change path.
9. Client adds a small "Reset to default" link near the theme dropdown. Click handler: `api('PATCH', '/api/sessions/' + sessionId, { theme: null })` then re-fetch metadata.

## Tests (`tests/theme-persistence.test.js`)

Four cases minimum. Use better-sqlite3 in-memory mode (`':memory:'`) so tests don't touch the user's real db.

1. **Backfill preserves existing themes**: pre-create a `sessions` row with `theme='dracula'` on the old schema, run the migration, assert `theme_override === 'dracula'`.
2. **New session gets null override, resolves to config default**: insert a session, set config.defaultTheme='catppuccin-mocha', read effective theme, assert it equals 'catppuccin-mocha' even though the row's stored value is something else / null.
3. **Config edit propagates without DB write**: set config.defaultTheme='nord', read effective theme on an existing un-overridden session, assert 'nord'. Change config.defaultTheme='gruvbox-dark', read again, assert 'gruvbox-dark'. **No SQL UPDATE between the two reads.**
4. **User override wins over config**: set theme_override='solarized-dark', set config.defaultTheme='catppuccin-mocha', read effective theme, assert 'solarized-dark'.

Plus a smoke test for `resolveTheme()` directly with all four code paths (override, project default, global default, fallback to 'tokyo-night').

## Protocol

- Before writing any owned file, post `[Tn] CLAIM <file>` to STATUS.md
- When done, post `[Tn] DONE — <summary>, tests <pass>/<total>`
- If you hit anything unexpected (the projects.default_theme column IS read somewhere; the meta-object refactor breaks 5 unrelated tests; etc.), post `BLOCKED` and stop
- Do NOT bump versions, do NOT update CHANGELOG.md, do NOT commit. T4 owns those. Just leave your work in the working tree and post DONE.

## Reference memories
- `memory_recall("theme architecture deep-dive")` — the analysis from 2026-04-26 covering exactly this design space
- `memory_recall("v0.6.x failure classes")` — the longitudinal pattern that motivated the persist-first / render-time-resolve mindset
- `CLAUDE.md` — file map and conventions
