# Sprint 19 — Setup Wizard Lite

Append-only coordination log.

## Mission

Add a `/setup` route that detects what's installed, shows tier status, and guides configuration. Behind `--setup` flag or accessible from the "config" button.

## Terminals

| ID | Spec | Primary file ownership |
|----|------|------------------------|
| T1 | T1-setup-api.md | packages/server/src/index.js (GET /api/setup endpoint) |
| T2 | T2-setup-ui.md | packages/client/public/app.js (setup modal), packages/client/public/style.css |
| T3 | T3-first-run-detect.md | packages/server/src/index.js (first-run detection), packages/cli/src/index.js |
| T4 | T4-setup-docs.md | docs/GETTING-STARTED.md (reference setup wizard), README.md |

## Rules
1. Append only to STATUS.md. 2. Never edit another terminal's files.
3. Flag blockers with `[Tn] BLOCKED`. 4. Sign off with `[Tn] DONE`.

---
(append below)
