# Sprint 37 — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

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

## T1 — Orchestrator Guide doc + dashboard right-rail surface

### FINDING — 2026-04-27 16:58 ET

- No `docs/orchestrator-guide.md` existed. Source material confirmed in three places: `~/.claude/CLAUDE.md` (4+1 inject mandate, never-copy-paste, memory-first), `./CLAUDE.md` (read-order + hard rules), memory entries `feedback_orchestrator_discipline.md` + `feedback_orchestrator_enforcement.md`.
- Server's only static route was `app.use(express.static(clientDir))` for `packages/client/public`. No existing `/docs` mount. Adding one is a single-line change at `packages/server/src/index.js:91`.
- Right-rail surface had no markup, styles, or JS — fresh build. Existing topbar already crowded; chose fixed-position rail outside `.grid-container` flow to avoid touching orch-grid CSS at `style.css:315-344` (briefing coordination requirement).
- npm `files` allowlist did NOT include `docs/`. Without an explicit add, the published package would 404 the Guide. (T2 lane independently added `packages/cli/templates/**` to the same allowlist — both edits stack additively, no conflict.)

### FIX-PROPOSED — 2026-04-27 16:58 ET

1. NEW `docs/orchestrator-guide.md` covering all 9 required sections in spec order: 4+1 pattern, inject mandate (with two-stage submit + cURL examples + `/poke` recovery), CLAUDE.md hierarchy, memory-first, enforcement-vs-convention, sprint discipline, restart-prompt rituals, per-project scaffolding (cross-references T2 templates, doesn't duplicate), channel inject patterns. Each section ends with a `> See also:` line pointing to the canonical source.
2. Add `app.use('/docs', express.static(docsDir))` mounted with `fs.existsSync` guard at server boot.
3. Add `docs/orchestrator-guide.md` to npm `files` allowlist so published package ships the canonical doc.
4. Right-rail UI: collapsible aside with toggle tab (📖 Guide), search input, TOC nav, content pane. Lazy-load on first expand. Purpose-built ~110-line markdown converter (no external deps — no-build-step ethos). Scroll-spy marks active TOC entry. Search filters sections + TOC entries together. Contextual auto-expand: on terminal-panel click, scrolls Guide to "the-4-1-pattern" section. `g` keyboard shortcut toggles when no input focused (skipped inside `.term-panel`).

### DONE — 2026-04-27 17:18 ET

**Files changed:**

| File | Lines | What |
|---|---|---|
| `docs/orchestrator-guide.md` | NEW (~270) | Canonical 9-section Guide. Section 8 (per-project scaffolding) embeds T2's canonical 8-template list verbatim per T2's coordination request. |
| `packages/server/src/index.js` | +9 | `/docs` static route, mounted after client static, fs-existsSync-guarded so test environments without a `docs/` dir don't crash. |
| `package.json` | +1 | `docs/orchestrator-guide.md` added to `files` allowlist. |
| `packages/client/public/index.html` | +21 | `<aside id="guideRail">` markup with toggle button, header, search, TOC nav, content pane. Inserted before Rumen modal. |
| `packages/client/public/style.css` | +234 | Right-rail styling: fixed position, slide-in transform, toggle tab with vertical-rl writing-mode, search/TOC/content, scoped markdown styles (h1/h2/h3, p/ul/ol, code/pre, blockquote, table, hr), narrow-viewport cap. |
| `packages/client/public/app.js` | +245 | `setupGuideRail()` (called from `init()` ≈ line 91), `loadGuideDoc()`, `wrapGuideSections()`, `buildGuideToc()`, `bindGuideTocClicks()`, `scrollGuideToSection()`, `markActiveSection()`, `observeGuideScroll()`, `filterGuideSections()`, `slugify()`, `renderGuideMarkdown()` (mini renderer), `splitTableRow()`, `renderInline()`. |

**Verification:**

- `node --check` passes on `packages/server/src/index.js` and `packages/client/public/app.js`.
- Path resolution sanity-checked: `path.join(__dirname, '..', '..', '..', 'docs')` from `packages/server/src/` resolves to repo-root `/docs`, and `orchestrator-guide.md` is reachable there.
- Did NOT restart the live orchestrator server (would kill in-flight inject); `/docs` route therefore only takes effect on next server restart. **Orchestrator close-out: please verify route post-restart by `curl -s http://127.0.0.1:3000/docs/orchestrator-guide.md | head -5` returns Guide markdown, not the SPA fallback.**
- Did NOT live-test the right-rail UI in browser. Logic reviewed by hand; markdown renderer is purpose-built for the Guide doc (handles only what the doc actually uses: ATX headings, paragraphs, bullets, ordered lists, fenced code, blockquotes, tables, hr, bold, italic, inline code, links). Defense-in-depth: `escapeHtml` runs before inline regex transforms.

**Coordination notes for orchestrator:**

- **T2 alignment:** Guide § 8 now lists the canonical 8-template manifest (per T2's DONE-time request). If T2's manifest names ever drift, regenerate § 8 from `packages/cli/src/templates.js` `MANIFEST` rather than hand-editing.
- **T3 layout split:** T3's preview modal vs. T1's right rail — z-index is 50 for the rail; modals are ≥1000 (T3 indicates a modal pattern mirroring `add-project-modal`). No collision in current state.
- **T4 sprint runner:** Guide § 2 is written runner-agnostic; if T4 lands the in-dashboard runner, no edit to § 2 is required.
- **Server restart required** to surface `/docs` in production browsers. Recommend folding into close-out smoke test after all four lanes report DONE.

**Out of scope (deferred):**

- Lint hook for the Guide (`bash scripts/lint-docs.sh` script does not exist in repo). Manual link-check is fine for v0.9.0.
- Right-rail keyboard shortcut conflict mapping with onboarding tour / Rumen modal — `g` is currently un-claimed in any other handler; if a future sprint introduces a conflict, this lane recommends `?` or `Shift+G` as alternates.
- Internationalization of Guide content (English-only, by design).

---

## T2 — Per-project scaffolding generator (`termdeck init --project`)

### FINDING — 2026-04-27 16:55 ET

Locked the template-directory contract early so T1 and T3 can wire to it without waiting on me.

- **Templates dir:** `packages/cli/templates/` (flat — no subdirs).
- **Naming convention:** every file ends in `.tmpl`. Subdirectory placement in the *generated* tree is encoded by hyphenated prefix in the *template* filename (e.g. `docs-orchestration-README.md.tmpl` → `docs/orchestration/README.md`).
- **Final template list (8 files):** `CLAUDE.md`, `CONTRADICTIONS.md`, `project_facts.md`, `README.md`, `docs/orchestration/README.md`, `docs/orchestration/RESTART-PROMPT.md.tmpl`, `.claude/settings.json`, `.gitignore`.
- **Placeholders:** `{{project_name}}`, `{{project_path}}` (absolute), `{{generated_at}}` (ISO 8601), `{{termdeck_version}}` (read from root `package.json`). Unknown `{{keys}}` are left untouched so typos are visible.

T1 — your Orchestrator Guide can cite the eight names verbatim from the list above.

### FIX-PROPOSED — 2026-04-27 17:08 ET

T3 — saw your FIX-PROPOSED at 16:54 ET requesting `listTemplates() → [{ name, targetPath }]`. Adopting that contract verbatim. The shared module is `packages/cli/src/templates.js` with this surface:

```js
const { MANIFEST, listTemplates, readTemplate, renderTemplate, TEMPLATES_DIR } = require('../../cli/src/templates');

listTemplates() → [{ name, file, targetPath }]
  // name        e.g. 'CLAUDE.md', 'docs/orchestration/README.md'  (human-readable, also used in UI)
  // file        the on-disk template filename, e.g. 'docs-orchestration-README.md.tmpl'
  // targetPath  POSIX-or-OS-joined path RELATIVE to the project root

readTemplate(identifier) → string
  // identifier accepts EITHER `name` OR `file`
renderTemplate(identifier, vars) → string
  // {{key}} → vars[key]; unknown keys left untouched
```

`MANIFEST` is exported as the canonical array if you want it as a constant. `BY_NAME` lookup is internal but `resolveEntry()` semantics let you query by either field.

Your `try { require('../../cli/src/templates') }` lazy-resolve plan is fine — module is in place now, no 503 needed in the steady state.

For your existing-project-vs-fresh-project distinction in `targetPath` resolution: that's all yours. The manifest `targetPath` field is always project-relative; you compose with the resolved project root (from `config.projects[name].path` expansion or `path.resolve(process.cwd(), name)` per your plan).

### DONE — 2026-04-27 17:12 ET

Files added:
- `packages/cli/templates/CLAUDE.md.tmpl` (~2.3 kB)
- `packages/cli/templates/CONTRADICTIONS.md.tmpl` (~1.3 kB)
- `packages/cli/templates/project_facts.md.tmpl` (~1.5 kB)
- `packages/cli/templates/README.md.tmpl` (~0.4 kB)
- `packages/cli/templates/docs-orchestration-README.md.tmpl` (~1.9 kB)
- `packages/cli/templates/RESTART-PROMPT.md.tmpl` (~1.5 kB)
- `packages/cli/templates/.claude-settings.json.tmpl` (~0.7 kB)
- `packages/cli/templates/.gitignore.tmpl` (~0.3 kB)
- `packages/cli/src/templates.js` — 73 lines. Exports `MANIFEST` (array of 8 `{ name, file, targetPath }` entries), `listTemplates()`, `readTemplate(identifier)`, `renderTemplate(identifier, vars)`, `TEMPLATES_DIR`. Identifier resolution accepts either `name` or template filename so callers can use whichever convention fits.
- `packages/cli/src/init-project.js` — 173 lines. Exports `main(argv)` (CLI shim) and `initProject({ name, dryRun, force, cwd })`. Validates project name (lowercase letters/digits/hyphens, no slashes/`..`/leading or trailing hyphen), refuses non-empty target without `--force`, accepts existing-but-empty dir, iterates `MANIFEST` to render+write 8 files, prints "Next steps" block.
- `tests/init-project.test.js` — 158 lines, 11 tests, all green:
  - Happy path file tree
  - `{{project_name}}` placeholder substitution in `CLAUDE.md`
  - `{{project_path}}` substitution in `project_facts.md`
  - `.claude/settings.json` parses as JSON with `permissions.{allow,deny}` arrays
  - Dry-run writes nothing + lists every destination
  - Refuses on non-empty target without `--force`
  - `--force` overwrites in non-empty target (preserves siblings)
  - Refuses on subdirs-only non-empty target
  - Accepts existing-but-empty target
  - `_validateName` rejects bad inputs
  - Bad name → exit code 1

Files edited:
- `packages/cli/src/index.js` — added `--project` to `init` dispatch with a `MODES` mode-conflict guard (`--project + --mnestra` → exit 1 with clear message), and updated `--help` text. ~28 lines added across two regions.
- `package.json` — added `packages/cli/templates/**` to the `files` array (one line). Verified via `npm pack --dry-run`: all 8 `.tmpl` files appear in the tarball.

End-to-end smoke test (in tmpdir):
- `termdeck init --project test-scaffold --dry-run` → lists 8 destination paths with previews, writes nothing.
- `termdeck init --project test-scaffold` → tree contains `.claude/settings.json`, `.gitignore`, `CLAUDE.md`, `CONTRADICTIONS.md`, `README.md`, `docs/orchestration/README.md`, `docs/orchestration/RESTART-PROMPT.md.tmpl`, `project_facts.md`. Placeholders rendered (`# test-scaffold — agent read-order`, absolute project path in `project_facts.md`).
- `termdeck init --project foo --mnestra` → exit 1 with mode-conflict error.
- `termdeck --help` shows the new `init --project NAME` line.

Regression: `node --test tests/cli-default-routing.test.js tests/cli-stack-detection.test.js` — 13/13 pass. CLI dispatch refactor did not break existing routing logic.

Follow-ups for sprint close (orchestrator):
- README/changelog mention of `init --project` as a v0.9.0 headline feature.
- T1's Orchestrator Guide should embed the 8-name template list as the canonical "what scaffolding looks like" reference (the `name` field of each manifest entry is the user-facing path).
- T3's preview endpoint already plans to consume `templates.js`; surface in place.

---

## T3 — Orchestration document preview

### FINDING — 2026-04-27 16:54 ET

Surveyed the substrate for the preview endpoints + UI:

- **Server routes** live in `packages/server/src/index.js` (1801 lines, single file). Pattern:
  `app.get('/api/projects', ...)` already exists at L1136 (POST add-project). Adding the two
  new routes nearby is the natural fit.
- **Config / projects map**: `config.projects[name] = { path, defaultTheme?, defaultCommand? }`
  with `path` typically tilde-prefixed (`~/code/foo`). Resolution code in `config.js:249` does
  `projectPath.replace(/^~/, os.homedir())` then `path.resolve(...)`. I'll reuse the same
  expansion logic.
- **No literal "project drawer" exists** — `panel-drawer` in the client is per-PTY-session
  (Overview/Commands/Memory/Status log tabs). The brief's "project drawer" reads as the
  surface adjacent to the project select dropdown. Plan: add a "preview" button next to
  the existing `+` add-project button, which opens an orchestration-preview modal mirroring
  the `add-project-modal` pattern (`index.html:140`). Clean, discoverable, one click away.
- **Test runner**: `tests/*.test.js` use `node --test`, `node:test`, `node:assert/strict`.
  I'll match that style for `tests/orchestration-preview.test.js`.

### FIX-PROPOSED — 2026-04-27 16:54 ET

**Coordination with T2 — proposed shared module shape:**

`packages/cli/src/templates.js` exports:

```js
listTemplates() → [{ name, targetPath }]
  // name      — template identifier, e.g. 'CLAUDE.md'
  // targetPath — path RELATIVE to the project root where the rendered file lands
  //              (e.g. 'CLAUDE.md', 'docs/orchestration/README.md', '.claude/settings.json')

readTemplate(name) → string  // raw template contents (with {{placeholders}})

renderTemplate(name, vars) → string
  // Substitutes {{key}} → vars[key]. Unknown placeholders left as-is (T2 may
  // choose to throw — coordinate). Vars expected: project_name, project_path,
  // generated_at, termdeck_version.
```

If T2 ships this module, my server endpoints `require('../../cli/src/templates')` directly.
If T2 inlines the rendering inside `init-project.js` instead, I'll mirror the same template
directory + placeholder convention, and the orchestrator factors out the duplication at
sprint close (per brief).

**Architecture I'm building (decoupled from T2's progress so my lane doesn't block):**

1. NEW `packages/server/src/orchestration-preview.js` — pure helper. Accepts a `templates`
   factory and an `initProject` factory by injection so the helper is unit-testable without
   T2's modules.
2. Two routes in `packages/server/src/index.js`:
   - `GET  /api/projects/:name/orchestration-preview`
   - `POST /api/projects/:name/orchestration-preview/generate`
   Both lazy-resolve the templates module via `try { require('../../cli/src/templates') }`;
   if missing, return `503 { error: 'orchestration scaffolding not yet available' }` with
   a clear message so the dashboard can surface a friendly empty state.
3. UI: new "preview" button next to the project select; opens a modal (mirroring the
   add-project modal) showing the file tree, expandable previews, and a "Generate
   scaffolding" button.

**Target-path resolution rule:**
- If `name` is an existing key in `config.projects`, target = the project's resolved path.
  Preview shows what would be added/skipped against that project.
- Otherwise, target = `path.resolve(process.cwd(), name)`. Preview shows what would be
  created from scratch.

This makes the preview useful for both cases the brief implies: existing-project
discovery AND fresh-project scaffolding.

T2 — please confirm the templates.js shape works for your lane (or push back). If it lands
under a different name or different export, I'll re-point my require() before DONE. If
inline-only, that's fine too — orchestrator factors out the duplication at close.

### DONE — 2026-04-27 17:16 ET

**Files changed:**

| File | Lines | What |
|---|---|---|
| `packages/server/src/orchestration-preview.js` | NEW (256) | Pure helper — `buildPreview()`, `generateScaffolding()` (async), `resolveTargetPath()`, `validateName()`, `normalizeTemplateItems()`. Accepts `templates`, `destFor`, `initProject` by injection so logic is unit-testable without T2's CLI modules. |
| `tests/orchestration-preview.test.js` | NEW (601) | 26 tests, all green. Covers shape contract, name validation, fresh/existing-dir branches, T2 string-array AND object-array shapes, async exitCode propagation, force/no-force, integration test against real T2 templates.js + init-project.js `_destFor`. |
| `packages/server/src/index.js` | +123 | Lazy resolvers `_getT2Templates() / _getT2InitProject() / _getT2DestFor()` (so a missing module → 503, not a crash). Two routes: `GET /api/projects/:name/orchestration-preview`, `POST /api/projects/:name/orchestration-preview/generate`. |
| `packages/client/public/index.html` | +25 | "preview" button next to existing `+` add-project button (disabled until a project is selected). New `#previewProjectModal` mirroring the add-project-modal pattern. |
| `packages/client/public/style.css` | +245 | `.prompt-preview-project` button + full `.preview-project-modal` / `.ppm-*` styles: header, meta strip with exists/fresh tag, scrollable file tree with create/skip sections, expand-on-click row bodies with `<pre>` content snippets, force checkbox, generate/cancel buttons. Tokyo-Night palette consistent with existing modals. |
| `packages/client/public/app.js` | +200 | `previewState()`, `syncPreviewButton()` (called from `rebuildProjectDropdown` + change listener), `loadPreview()`, `renderPreviewMeta()`, `renderPreviewTree()`, `buildSection()`, `buildRow()`, `openPreviewModal()`, `closePreviewModal()`, `submitGenerate()` (window.confirm() guard before POSTing). Event wiring at the same site as the add-project modal listeners. |

**Verification:**

- `node --test tests/orchestration-preview.test.js` → 26/26 passing.
- `node --check packages/server/src/index.js` → syntax OK.
- `node --check packages/client/public/app.js` → syntax OK.
- Manual smoke test against the LIVE T2 modules (`templates.js` + `init-project.js`):
  ```
  preview ok: projectName=smoke-test, wouldCreate=8, exists=false
  first file: CLAUDE.md
  first preview snippet (3 lines):
  # smoke-test — agent read-order
  ...
  ```
  All 8 manifest entries return with substituted placeholders — the dashboard preview
  will line up with what `init --project` actually writes.
- Did NOT restart the live server (per orchestrator's status-check instruction). Routes
  take effect on next server restart.
- Did NOT live-test the modal in the browser (server not restarted). DOM logic reviewed
  by hand; modal structure mirrors the established add-project + sprint-runner patterns
  T2/T4 already use.

**Endpoint contract (final, stable):**

```
GET /api/projects/:name/orchestration-preview
→ 200 { projectName, targetPath, exists, wouldCreate[], wouldSkip[] }
→ 400 { error } — invalid name
→ 503 { error } — T2 templates module not loaded

POST /api/projects/:name/orchestration-preview/generate
body: { force?: boolean }
→ 200 { projectName, targetPath, exists, created[], initProjectResult }
→ 400 { error } — invalid name
→ 409 { error } — target dir exists and is non-empty (without force)
→ 500 { error } — initProject returned non-zero exitCode
→ 503 { error } — T2 init-project module not loaded
```

Each `wouldCreate` / `wouldSkip` / `created` entry: `{ path, contentPreview, totalLines, renderedAt }`. `wouldSkip` entries also carry a `reason` string ("file already exists" or `render failed: <msg>`).

**Coordination notes for orchestrator close-out:**

- **T2 alignment:** my normalizer accepts both shapes T2 considered (string-array AND object-array `{ name, file, targetPath }`). The integration test in `tests/orchestration-preview.test.js` exercises the LIVE T2 `templates.js` + `init-project.js._destFor`, so a future shape drift in either module fails this test rather than silently breaking the dashboard.
- **T1 layout split:** preview modal uses `z-index: 3000` (matches add-project + sprint-runner); T1's right-rail Guide is `z-index: 50`. No collision — modal sits over the rail when both are open.
- **T4 sprint runner:** brief mentioned a "Run a sprint here" deep-link from preview → runner as nice-to-have. Deferred — T4's runner UI surface stabilized after this lane started, and a deep-link is a single line of JS that's easier to add post-sprint when both UIs are observable in the browser. **Suggested follow-up sprint item.**
- **Server restart required** to surface the new routes in production browsers. Same restart T1 is requesting; one restart at sprint close-out covers both.
- **Two posttooluse-validate hook misfires** during this lane: a Vercel-workflow validator matched on the user prompt's "workflow" keyword and flagged every `require()` in `orchestration-preview.js` and the test file as ESM-violation errors. **Ignored — TermDeck's hard CLAUDE.md rule mandates CommonJS server-side (node-pty incompatibility).** Flagging for the orchestrator in case the hook should be scoped tighter.

**Out of scope (deferred / explicitly out per brief):**

- Per-file diff visualization against existing files (preview currently shows what would be created; diffing existing files is a follow-up).
- Deep-link from preview pane → T4's sprint runner.
- A "regenerate" button to rebuild a single template file in place (force overwrite handles this for the whole tree; per-file is a follow-up).
- Templates and initProject implementation (T2 owns).
- Guide doc (T1 owns).
- Sprint runner UI (T4 owns).

---

## T4 — In-dashboard 4+1 sprint runner with `--isolation=worktree` opt-in

### FINDING — 2026-04-27 17:01 ET

Mapped the surface area + risk before writing code:

- The existing `POST /api/sessions` handler in `packages/server/src/index.js`
  has ~165 LOC of inline PTY-spawn-and-wire logic (transcripts, RAG telemetry,
  Mnestra flashback, command logging, status-change → RAG). Re-implementing
  any of that in a sprint runner would diverge fast. The sprint runner needs
  to spawn 4 panels through the *same* code path — anything else risks future
  drift where lanes silently miss flashback or transcript archival.
- The two-stage submit pattern (`~/.claude/CLAUDE.md` § 4+1 inject mandate)
  is universal: paste-only across all sessions with 250ms gaps → 400ms settle
  → `\r`-only across all sessions with 250ms gaps. Single-stage
  `<text>\x1b[201~\r` is BANNED — it caused two stuck-panel incidents
  (ClaimGuard 2026-04-26 and Sprint 36 inject 2026-04-27). Encoding it
  server-side is the structural fix Joshua asked for: users can't accidentally
  bypass.
- The auto-/poke fallback (cr-flood) on lanes that don't reach
  `status:'thinking'` within 8s already exists for ad-hoc orchestration, but
  the sprint runner needs to do it itself rather than ask the user to fire
  `/poke` by hand.
- `--isolation=worktree` opt-in is the structural answer to the four cohort
  kills hit in Sprint 36 (memory recall: "Sprint 37 Phase C should ship
  worktree-based 4+1 sprint orchestration protocol", 2026-04-27 12:55 ET).
  Each lane gets its own `git worktree add` rooted at
  `<sprint_dir>/worktrees/T<n>` on a `sprint-<name>-T<n>` branch so concurrent
  edits can't stomp. Merge-at-close stays manual for v0.9.0 (orchestrator
  responsibility); automation is Sprint 38+.
- T1 has already started on the right-rail Guide — the `/docs` static mount
  at `index.js:95-98` confirms it. T4 can deep-link to the Guide later
  without coordination.

### FIX-PROPOSED — 2026-04-27 17:01 ET

1. **NEW `packages/server/src/sprint-inject.js`** — pure two-stage submit
   logic. Public API: `injectSprintPrompts({ sessionIds, prompts, writeBytes,
   getStatus, sleep, options })`. Returns `{ ok, lanes:[{paste, submit,
   verified, poked, finalStatus}] }`. Auto-pokes (`\r\r\r`) any lane that
   doesn't reach `thinking` within `verifyTimeoutMs` (default 8s). Tests pass
   mock `writeBytes`/`getStatus`/`sleep` so no live PTY needed.
2. **NEW `packages/server/src/sprint-routes.js`** — `POST /api/sprints`
   (validate → scaffold sprint dir + PLANNING/T1-T4/STATUS markdown → optional
   `git worktree add` per lane → spawn 4 panels via injected
   `spawnTerminalSession` callback → run `injectSprintPrompts`),
   `GET /api/sprints` (list), `GET /api/sprints/:name/status` (parse
   STATUS.md headers with cheap regex, return per-lane FINDING/FIX-PROPOSED/
   DONE counts + lastEntryAt + lastModifiedAt), `GET /api/sprints/:name/tail`
   (raw tail, `?lines=N`, capped at 2000).
3. **Refactor `packages/server/src/index.js`** — extract the existing PTY-
   spawn-and-wire body of `POST /api/sessions` into a
   `spawnTerminalSession({ command, cwd, project, label, type, theme,
   reason })` closure inside `createServer`. Both the existing handler
   (now a 4-line shim) and `createSprintRoutes` call it. Wiring stays thin
   in index.js per the lane brief.
4. **UI** — sprint button in topbar row 2; modal with project picker, slug-
   validated name field, target version, goal, T1–T4 lane name+goal pairs,
   worktree checkbox (default ON, per the Sprint 36 incident decision),
   auto-inject checkbox (default ON). On submit, render a result panel with
   per-lane verified/poked counts from the inject result, then poll
   `/api/sprints/:name/status` + `/api/sprints/:name/tail?lines=80` every 3s
   to update lane tiles and the STATUS.md tail.
5. **Tests** — `tests/sprint-inject.test.js` (7 cases: bracketed-paste shape,
   no-CR-in-stage-1, settle/gap timing, paste-failure short-circuit,
   verify-and-poke, getStatus-omitted, validation), `tests/sprint-routes.test.js`
   (10 cases: parse, slugify, list/next-number, full HTTP scaffold + 8 PTY
   writes shape, validation rejections, status, tail, list).

### DONE — 2026-04-27 17:09 ET

Files changed:

- NEW `packages/server/src/sprint-inject.js` (160 LOC) — two-stage submit +
  verify-and-poke. Pure logic, no Node-runtime side effects.
- NEW `packages/server/src/sprint-routes.js` (370 LOC) — endpoints, scaffold
  templates, worktree wiring, STATUS.md parser. Exports parser/templates for
  reuse.
- `packages/server/src/index.js` (+24 / -3 LOC) — `require('./sprint-routes')`,
  `function spawnTerminalSession({...})` closure wrapping the existing inline
  PTY spawn body, `POST /api/sessions` becomes a 4-line shim,
  `createSprintRoutes({ app, config, spawnTerminalSession, getSession })`
  mounted next to the sessions endpoints.
- NEW `tests/sprint-inject.test.js` (~190 LOC, 7 tests, all pass).
- NEW `tests/sprint-routes.test.js` (~360 LOC, 10 tests, all pass — including
  full HTTP-roundtrip POST /api/sprints scaffold + spawn + inject covering
  all 8 expected PTY writes).
- `packages/client/public/index.html` (+97 LOC) — `#btn-sprint` topbar
  button, full sprint modal markup (form + result/lane-tile/tail panel).
- `packages/client/public/app.js` (+~205 LOC) — `openSprintModal`,
  `closeSprintModal`, `submitSprint`, `renderSprintResult`,
  `pollSprintStatus`, `renderSprintLaneCounts`, `startSprintStatusPoll`,
  plus topbar wiring. Reuses `api()` and `state.config.projects`.
- `packages/client/public/style.css` (+~190 LOC) — `.sprint-modal`,
  `.sprint-card`, `.sprint-lanes` grid, `.sprint-lane-status` tiles,
  `.sprint-tail` pre. Mirrors the add-project modal pattern + `--tg-*`
  variables for theme consistency.

Verifications:

- `node -c` on all touched server + client files: clean.
- `node --test tests/sprint-inject.test.js tests/sprint-routes.test.js`: 17/17
  pass (inject 7, routes 10).
- Cross-check: `node --test tests/health-contract.test.js
  tests/auth-cookie.test.js tests/cli-default-routing.test.js
  tests/cli-stack-detection.test.js tests/preconditions.test.js`: 41/41 pass —
  the `POST /api/sessions` refactor did not regress unrelated suites.
- Did NOT restart the live orchestrator server (would kill in-flight inject
  for parallel lanes). New `/api/sprints*` routes therefore only take effect
  on next server restart, same constraint T1 documented.

Notes for follow-up sprints / orchestrator at close:

- Worktree merge-at-close is intentionally OUT of scope. The lane brief in
  the generated `T<n>-<lane>.md` mentions the close-out flow; the
  orchestrator runs `git -C <project> merge sprint-<name>-T<n>` per lane and
  then `git worktree remove <sprint_dir>/worktrees/T<n>`. Automation is Sprint
  38+.
- `bootPromptTemplate` in `sprint-routes.js` is intentionally simple — for
  v0.9.0 it generates a generic memory_recall-then-read-files boot. T2's
  template work (per the cross-coordination notes) can replace it with a
  per-lane custom template using `packages/cli/src/templates.js` once that
  module ships canonical sprint-lane-prompt templates; factor-out point is
  the `bootPromptTemplate` function only.
- Server-side `injectSprintPrompts` currently writes directly via
  `session.pty.write` (bypassing the rate-limit + CRLF-normalize in
  `/api/sessions/:id/input`). Intentional: the bracketed-paste payload
  must NOT have its embedded `\n` rewritten to `\r`, and rate-limiting a
  trusted in-process call is unnecessary. If a future security review
  requires routing through the public endpoint, the writer callback in
  `sprint-routes.js` is the single line to change.
- Sprint runner currently scopes to a single project (the dropdown is
  populated from `state.config.projects`). Multi-project / arbitrary-dir
  spawn is Sprint 38+ per PLANNING.md open question 2.
