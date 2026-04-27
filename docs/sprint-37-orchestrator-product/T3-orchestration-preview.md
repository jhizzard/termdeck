# Sprint 37 — T3: Orchestration document preview

**Lane goal:** Ship a dashboard surface that, for any project, shows: "If you ran `termdeck init --project <name>` here, here's exactly what would be created." Read-only preview. Optional generate button to commit. The user gets a transparent view of the scaffolding before it touches their disk.

**Target deliverable:**
1. NEW server endpoint `GET /api/projects/:name/orchestration-preview` returning the rendered file tree + per-file rendered contents (first N lines + total line count).
2. A preview pane in the dashboard's project drawer that displays the response.
3. Optional "Generate scaffolding" button in the pane that POSTs to a generate endpoint (which calls T2's `initProject({ dryRun: false })` server-side).

## Why this lane exists

T2's `init --project` is great for CLI users, but the dashboard is where most TermDeck users will live. A "preview before commit" surface accomplishes two things:

1. **Trust:** Users see exactly what will be written before they pull the trigger.
2. **Discoverability:** Users browsing their projects in the dashboard discover the orchestration scaffolding pattern by reading the preview, even if they never run the CLI.

Acceptance criterion #3: the preview accurately matches what `init --project` would generate. Same code path → same output.

## Endpoint design

`GET /api/projects/:name/orchestration-preview`

Response shape:

```json
{
  "projectName": "hello-world",
  "targetPath": "/abs/path/to/hello-world",
  "exists": false,
  "wouldCreate": [
    {
      "path": "CLAUDE.md",
      "contentPreview": "# hello-world — agent read-order\n\n...",
      "totalLines": 42,
      "renderedAt": "2026-04-27T16:50:00Z"
    },
    { "path": "CONTRADICTIONS.md", "contentPreview": "...", "totalLines": 3 },
    ...
  ],
  "wouldSkip": []
}
```

If `exists: true` (directory already exists), populate `wouldSkip` with files that would NOT be overwritten and explain in the UI.

`POST /api/projects/:name/orchestration-preview/generate`

Request body: `{ "force": false }`. Calls T2's `initProject({ name, dryRun: false, force, cwd })`. Returns the same shape as above with `wouldCreate` → `created`.

## Implementation

Server side (`packages/server/src/index.js`):

```js
const { renderTemplate, listTemplates } = require('../../cli/src/templates');
// or wherever T2 lands the shared module

app.get('/api/projects/:name/orchestration-preview', async (req, res) => {
  const { name } = req.params;
  // Validate name (same regex T2 uses).
  // Compute targetPath relative to a config-defined projects root.
  // For each template in listTemplates(), render with placeholders.
  // Return the JSON shape above.
});

app.post('/api/projects/:name/orchestration-preview/generate', async (req, res) => {
  const { name } = req.params;
  const { force = false } = req.body || {};
  // Call initProject({ name, dryRun: false, force, cwd: projectsRoot }).
  // Return result.
});
```

**Critical:** import T2's shared template module — do NOT duplicate template-loading logic. If T2's `packages/cli/src/templates.js` doesn't exist yet at your start time, coordinate via STATUS.md FINDING entries. Worst case, both lanes inline-render and orchestrator factors out the duplication at close.

Client side (`packages/client/public/app.js`):

- Project drawer gets a new "Orchestration" tab/section.
- When opened, fetch `/api/projects/:name/orchestration-preview`.
- Render the file tree as a collapsible list. Click a file → expand to show `contentPreview` + "X more lines" if `totalLines > previewLines`.
- "Generate scaffolding" button at bottom. Disabled if `exists: true && !force`. Shows confirm dialog before POSTing.
- Refresh the preview after generate.

## Primary files

- `packages/server/src/index.js` — two new endpoints. Keep them small; route logic in a helper module is fine if the file is getting long.
- `packages/client/public/app.js` — preview pane in project drawer.
- `packages/client/public/index.html` — drawer markup if the structure needs a new section.
- `packages/client/public/style.css` — preview pane layout. Should fit alongside existing project drawer content.

## Coordination notes

- **T2** owns templates and the `initProject` function. **You depend on T2's shared template module.** Read T2's brief; agree on the module shape via your respective FINDING entries before either lane writes the bridge code. Suggested module: `packages/cli/src/templates.js` exporting `listTemplates()`, `readTemplate(name)`, `renderTemplate(name, vars)`.
- **T1** is building the right-rail Guide panel. Both T1's panel (right side) and your preview pane (project drawer, left/center) coexist in the dashboard. Coordinate z-index and ensure the right-rail collapses cleanly when the project drawer is open. T1's lane brief notes the layout split.
- **T4** is building the sprint runner. After scaffolding lands, the user might want to immediately kick off a sprint in the new project. A "Run a sprint here" link from your preview pane to T4's runner is a nice-to-have; T4 ships its own UI, you just deep-link.

## Test plan

- New `tests/orchestration-preview.test.js`:
  - GET endpoint with valid project name returns expected shape.
  - GET endpoint with non-existent project shows `exists: false` and full `wouldCreate`.
  - GET endpoint with existing project populates `wouldSkip`.
  - POST endpoint actually writes files (in tmp dir).
  - POST endpoint with `force: false` on existing dir returns appropriate error.
- Manual: open dashboard, project drawer, Orchestration tab. Preview matches `node packages/cli/src/index.js init --project test --dry-run` output line-for-line.

## Out of scope

- Don't write templates — T2 owns them.
- Don't write the Guide doc — T1 owns it.
- Don't build the sprint runner — T4 owns it.
- Don't add per-file diff visualization (preview shows what would be created; diff against existing files is a follow-up).
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-37-orchestrator-product/STATUS.md` under `## T3`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
