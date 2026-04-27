# Sprint 36 — Launcher + UI parity (Phase B)

**Status:** Planned. Kickoff after Sprint 35 (v0.7.3) ships.
**Target version:** `@jhizzard/termdeck` v0.8.0 (minor bump).
**Stack-installer bump:** v0.4.0 (hooks bundling = new feature).

## Goal

Close the remaining personal-vs-product asymmetry. Sprint 35 (Phase A) made fresh installs *not break*. Sprint 36 (Phase B) makes fresh installs *equal Joshua's box*. After this lands, Joshua can switch his daily driver from `scripts/start.sh` to `npx @jhizzard/termdeck` with zero functional regression — Phase 0 of the reconciliation strategy completes.

## Why now

Five concrete behaviors live on Joshua's box that fresh users don't get:
1. Mnestra autostart with secrets-reload-on-empty-store (`scripts/start.sh:156–276`)
2. MCP-config absence hint (`scripts/start.sh:278–284`)
3. Rumen last-job age check (`scripts/start.sh:286–307`)
4. The full Step 1/4–Step 4/4 launcher choreography
5. The personal `~/.claude/hooks/memory-session-end.js` hook

Plus: every MCP write today goes to `~/.claude/mcp.json`, but current Claude Code (v2.1.119+) reads from `~/.claude.json`. Joshua's box has the new path; the installer ships the old.

Plus: Sprint 35 added MCP-only as the wizard default, but there's no in-product way for a user to flip RAG on without editing config.yaml by hand.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Full `start.sh` parity in CLI** | Port remaining behaviors from `scripts/start.sh` into the published CLI: Mnestra autostart with secrets reload-on-empty-store, MCP-config absence hint, Rumen last-job age check, full Step-1/4–Step-4/4 choreography. Preserve Sprint 35 T4's work (RAG state line, port reclaim, transcript hint). After this lane, `scripts/start.sh` becomes a 5-line wrapper or gets deleted. | `packages/cli/src/index.js`, NEW `packages/cli/src/stack.js` (or extend the existing one) |
| **T2 — MCP path drift fix** | Migrate all installer/CLI writes from `~/.claude/mcp.json` to `~/.claude.json` (the path current Claude Code actually reads). On install, detect existing entries in BOTH paths, merge into the new path, leave the old path untouched (don't delete — user may have it pinned). Idempotent. | `packages/stack-installer/src/index.js`, `packages/cli/src/init-rumen.js`, `packages/cli/src/index.js` (detector), `packages/server/src/setup/supabase-mcp.js` |
| **T3 — Dashboard RAG toggle UI** | Add a `Settings` panel (or extend the existing config drawer) with a clean toggle for `rag.enabled`. NEW endpoint `PATCH /api/config` writes the change to `~/.termdeck/config.yaml`. Toggle live-updates the boot banner state line (the one Sprint 35 T4 added) without restart. UI explains MCP-only mode in plain English + what flipping to ON does. | `packages/client/public/app.js`, `packages/client/public/style.css`, `packages/client/public/index.html`, `packages/server/src/index.js` (PATCH /api/config) |
| **T4 — Hook bundling** | Stack-installer drops `~/.claude/hooks/memory-session-end.js` and merges the `Stop` hook block into `~/.claude/settings.json`. Idempotent (don't duplicate if user already has the hook installed). Honor existing settings entries (don't clobber). Stack-installer prompts user with "Install TermDeck's session-end memory hook? (Y/n)" so it's opt-in but defaulted on. | `packages/stack-installer/src/index.js`, NEW `packages/stack-installer/assets/hooks/memory-session-end.js` (vendored copy), NEW `packages/stack-installer/assets/hooks/README.md` (explains what the hook does) |

## Out of scope (deferred)

- Orchestrator Guide content (Sprint 37)
- Per-project scaffolding generators (Sprint 37)
- Knowledge graph anything (Sprint 38)
- Drag-to-reorder PTY panels (backlog)

## Acceptance criteria

1. `npx @jhizzard/termdeck-stack` on a fresh machine installs: TermDeck + Mnestra + Rumen + the session-end hook + correct MCP wiring at `~/.claude.json`.
2. Boot output of `npx @jhizzard/termdeck` matches `scripts/start.sh` step-by-step (same labels, same status indicators, same hints).
3. Mnestra MCP entry written to `~/.claude.json` is detected by Claude Code v2.1.119+ on first session.
4. Dashboard `Settings → RAG mode` toggles `rag.enabled` in config.yaml; banner state updates within 5s on next reload (or live via SSE if T3 wires it).
5. **Phase 0 dogfood gate:** Joshua switches his daily driver from `scripts/start.sh` to `npx @jhizzard/termdeck`. Reports zero functional regressions over a 1-week observation window. Any issues found feed back into Sprint 36.5 as fast-follow patches.

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane. Orchestrator publishes at sprint close.

## Dependencies on prior sprints

- Sprint 35 must ship first (banner state line, port reclaim, transcript hint already in CLI).
- Sprint 35's `termdeck doctor` (T3) is referenced by some hint copy in T1's port — coordinate hint text.
