# Sprint 37 — T2: Per-project scaffolding generator (`termdeck init --project`)

**Lane goal:** Ship a `termdeck init --project <name>` subcommand that generates a complete project skeleton in one command. The skeleton encodes the orchestration patterns Joshua uses (CLAUDE.md, CONTRADICTIONS.md, project_facts.md, docs/orchestration/, RESTART-PROMPT.md template, .claude/settings.json) so a developer running this on day one of a new project starts with the same scaffolding TermDeck itself uses.

**Target deliverable:**
- `npx @jhizzard/termdeck init --project hello-world` creates `./hello-world/` with the full scaffolding tree.
- `npx @jhizzard/termdeck init --project hello-world --dry-run` prints what *would* be created without writing anything.
- A developer reading the result understands the project structure and how to use it (acceptance criterion #2).

## Scaffolding tree

The generated project structure:

```
<project_name>/
├── CLAUDE.md                           # Project router, points at docs/ and global CLAUDE.md
├── CONTRADICTIONS.md                   # Audit-trail file for contradicting facts/decisions
├── project_facts.md                    # Stable per-project facts (paths, versions, conventions)
├── README.md                           # One-line description + "see CLAUDE.md for agents"
├── docs/
│   └── orchestration/
│       ├── README.md                   # Index of orchestration docs
│       └── RESTART-PROMPT.md.tmpl      # Template; copied to RESTART-PROMPT-YYYY-MM-DD.md per session
├── .claude/
│   └── settings.json                   # Sensible permission defaults for the project
└── .gitignore                          # Standard Node.js + .DS_Store + .termdeck/
```

## Templates

All templates live in NEW `packages/cli/templates/`. Plain-markdown files with `{{placeholder}}` syntax. Placeholders supported:

- `{{project_name}}` — the value passed to `--project`
- `{{project_path}}` — absolute path of the generated directory
- `{{generated_at}}` — ISO 8601 timestamp
- `{{termdeck_version}}` — read from root `package.json` at run time

Required template files:

- `packages/cli/templates/CLAUDE.md.tmpl`
- `packages/cli/templates/CONTRADICTIONS.md.tmpl`
- `packages/cli/templates/project_facts.md.tmpl`
- `packages/cli/templates/README.md.tmpl`
- `packages/cli/templates/docs-orchestration-README.md.tmpl`
- `packages/cli/templates/RESTART-PROMPT.md.tmpl`
- `packages/cli/templates/.claude-settings.json.tmpl`
- `packages/cli/templates/.gitignore.tmpl`

The `CLAUDE.md.tmpl` should mirror TermDeck's own short-router pattern (see `./CLAUDE.md` for the canonical example): identity + read-order + hard rules + current-state-pointer. Do NOT include TermDeck-specific rules (no TypeScript, no React, etc.) — keep it project-agnostic. The hard-rules section is generic ("never publish without reading docs/RELEASE.md if it exists" style).

The `.claude-settings.json.tmpl` permission defaults should be conservative — sensible read/grep/test allowances, no destructive ops without confirmation. Mirror the structure of TermDeck's own `.claude/settings.json` if one exists; if not, start from `~/.claude/settings.json` and strip user-specific bits.

## Implementation

NEW `packages/cli/src/init-project.js`:

- Exports `initProject({ name, dryRun, force, cwd })`.
- Validates `name` is a safe filesystem identifier (lowercase, hyphen-separated, no slashes, no `..`).
- Resolves target dir as `path.resolve(cwd, name)`.
- Refuses if target exists and is non-empty unless `--force` is set.
- For each template file, renders placeholders and writes to target. In `dryRun` mode, prints the file path + first 5 lines of rendered content + `... (N more lines)` instead of writing.
- Prints a "Next steps" block at the end:
  ```
  Created <project_name>/ at <project_path>.

  Next steps:
    cd <project_name>
    git init
    # Open <project_name>/ in TermDeck — it will pick up the .claude/settings.json automatically.
    # Read CLAUDE.md to see the agent read-order for this project.
  ```

Subcommand registration in `packages/cli/src/index.js`:

- Add `init` subcommand handling. If `--project <name>` flag is present, call `initProject(...)`. If `--mnestra` flag is present (existing path), keep that flow intact. If both present → error with clear message.
- Also add `--dry-run` flag (passes through to `initProject`).
- Update `printBanner` `--help` output to document the new subcommand.

## Primary files

- NEW `packages/cli/src/init-project.js` — the generator.
- NEW `packages/cli/templates/` directory with the 8 template files listed above.
- `packages/cli/src/index.js` — subcommand registration + `--help` text update. **Coordinate with T1's docs static-route addition** if T1 also touches `index.js`. Use line-range comments to make the diff easy to review.
- Root `package.json` — add `packages/cli/templates/**` to the `files` array so templates ship in the published tarball. **Critical** — Sprint 36 surfaced exactly this kind of packaging gap (T4's `assets/**` was missing). Verify with `npm pack --dry-run` before declaring DONE.

## Coordination notes

- **T3** depends on these templates for the orchestration-preview pane. Define the template directory and naming convention early in your lane so T3 can wire to the same path. Suggest a small shared module (`packages/cli/src/templates.js`) that exports `readTemplate(name)` and `renderTemplate(name, vars)` — both T2 and T3 call this. T3 imports it server-side.
- **T1** is writing the Orchestrator Guide. Its "per-project scaffolding files" section should reference YOUR template names. Communicate the final template filenames in your FINDING entry so T1 can cite them.

## Test plan

- New `tests/init-project.test.js`:
  - Happy path: `initProject({ name: 'hello', dryRun: false, cwd: tmpDir })` creates expected files.
  - Dry-run: same call with `dryRun: true` writes nothing; stdout contains expected file list.
  - Refuses on existing non-empty dir without `--force`.
  - Placeholder substitution: rendered `CLAUDE.md` contains `# hello-world` (or whatever the project name is).
- Manual: `node packages/cli/src/index.js init --project test-scaffold --dry-run` in a tmp dir. Then without `--dry-run`. Inspect the result.
- Verify `npm pack --dry-run` lists every `packages/cli/templates/*.tmpl` file.

## Out of scope

- Don't build the orchestration preview pane — T3 owns it (but it consumes your templates).
- Don't build the sprint runner — T4 owns it.
- Don't write the Orchestrator Guide doc — T1 owns it (but should reference your template names).
- Don't add a "publish to npm registry" step or any non-local action.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-37-orchestrator-product/STATUS.md` under `## T2`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
