# CLAUDE.md — TermDeck Project Notes

## What this project is

TermDeck is a web-based terminal multiplexer that embeds real PTY terminals in a browser dashboard. Each terminal panel has rich metadata overlays (project, status, last commands, AI agent state), per-terminal theming, flexible grid layouts, and a RAG integration that syncs session data to a Mnestra-backed Postgres (pgvector) store.

Think: tmux in the browser, but with a control-room UI showing what every terminal is doing, plus Flashback — proactive recall of similar past errors the moment a panel hits a problem.

**Current version:** v0.6.4 (published to npm as `@jhizzard/termdeck`). All v0.1 milestones shipped on 2026-03-19. Sprints 4–31 layered on onboarding, UI polish, preflight, transcripts, contract tests, a two-row toolbar, optional auth, a non-loopback bind guardrail, release-verification tooling, the meta-installer (`@jhizzard/termdeck-stack`), the Supabase MCP wizard integration, the auto-orchestrator, the persist-first init wizard (v0.6.3), and the Rumen access-token hint (v0.6.4).

## Where code lives

### Server (`packages/server/src/`)
- **index.js** — Express + WebSocket server. REST API for session CRUD, resize, themes, config, global status, transcripts, preflight. WebSocket hub that binds one socket per terminal session. PTY spawning via `@homebridge/node-pty-prebuilt-multiarch`. Periodic metadata broadcast every 2s.
- **session.js** — Session class wrapping a PTY with metadata. Output analyzer with regex patterns for Claude Code, Gemini CLI, Python servers, and shell prompts. Detects status (thinking, editing, idle, listening, errored, exited), ports, HTTP request counts, and command history. SessionManager class with event emitter for RAG hooks.
- **database.js** — SQLite via better-sqlite3. Tables: sessions, command_history, rag_events, projects. WAL mode. Helper functions for logging commands, RAG events, querying history.
- **rag.js** — RAGIntegration class. Three-layer memory (session → project → developer). Local SQLite buffer with periodic Mnestra sync. Event handlers for session lifecycle, commands, status changes, file edits.
- **themes.js** — 8 curated xterm.js theme objects (Tokyo Night, Rosé Pine Dawn, Catppuccin Mocha, GitHub Light, Dracula, Solarized Dark, Nord, Gruvbox Dark) plus status indicator color map.
- **config.js** — YAML config loader with `${VAR}` substitution against `~/.termdeck/secrets.env`.
- **preflight.js** — Startup health checks (Mnestra `/healthz`, Postgres reachability, OpenAI key presence). Surfaces a health badge in the top bar.
- **transcripts.js** — Session transcript capture and retrieval API.
- **session-logger.js** — Optional markdown session log writer on PTY exit (`--session-logs`).
- **mnestra-bridge/index.js** — Bridge layer between TermDeck RAG events and Mnestra (direct HTTP, webhook, or MCP modes).
- **setup/** — First-run bootstrap helpers: migrations runner, pg-runner, yaml/dotenv IO, Supabase URL resolver, Mnestra migrations, Rumen setup.

### Client (`packages/client/public/`)
- **index.html** — Dashboard shell. Loads xterm.js + addons from CDN, imports `style.css` and `app.js`.
- **style.css** — All dashboard styles extracted from the original single-file HTML (Sprint 5).
- **app.js** — Full dashboard behavior: layout engine (7 grid modes + focus/half), panel creation, WebSocket handlers, onboarding tour (13 steps), reply button, terminal switcher, Flashback toasts, add-project modal, panel drawer (Overview/Commands/Memory/Status tabs).

### CLI (`packages/cli/src/`)
- **index.js** — `termdeck` command. Parses `--port`, `--no-open`, `--session-logs`, `--help`. Boots server, opens browser. Graceful shutdown on SIGINT.
- **init-mnestra.js** — `termdeck init --mnestra` wizard. Persists `~/.termdeck/secrets.env` first (so a pg failure can't lose typed-in keys), then applies Mnestra migrations, writes `config.yaml`, verifies connection. Supports `--yes` (reuse saved secrets, skip prompts), `--reset` (re-prompt from scratch), and `--from-env` (skip every prompt, read all five secrets from env vars — bypass for terminals that fight with raw-mode secret prompts and for CI installs).
- **init-rumen.js** — `termdeck init --rumen` wizard. Deploys the Rumen Supabase Edge Function, applies migration, sets secrets, installs the `pg_cron` schedule. On `supabase link` failure, detects the "Access token not provided" stderr signature and prints a path-aware hint pointing at the Supabase PAT dashboard plus the exact `export SUPABASE_ACCESS_TOKEN=sbp_...` command.

### Config (`config/`)
- **config.example.yaml** — Template with project definitions, RAG settings, theme defaults.
- **secrets.env.example** — Template for API keys.
- **supabase-migration.sql** — Legacy v0.1 RAG table DDL (kept for reference; Mnestra migrations are the current source of truth).
- **transcript-migration.sql** — Transcript table DDL (Sprint 6).

## Architecture decisions (locked in — do not change)

1. **node-pty + xterm.js + WebSocket** is the terminal stack. One PTY per session, one WebSocket per session, xterm.js with addon-fit and addon-web-links on the client. Uses `@homebridge/node-pty-prebuilt-multiarch` so `npx termdeck` avoids any C++ compile step.
2. **Express** for REST API, **ws** library for WebSockets (not Socket.IO).
3. **SQLite** (better-sqlite3) for local persistence. Mnestra (Postgres + pgvector) for RAG sync. SQLite is the local source of truth; Mnestra is an async durable replica that also backs Flashback queries.
4. **Vanilla JS** on the client. No React, no build step. Three files: `index.html`, `style.css`, `app.js`. xterm.js loaded from CDN. This keeps `npx termdeck` zero-config.
5. **CSS Grid** for layouts. No drag-resize library — layout modes are preset grid templates.
6. **Per-terminal theming** via xterm.js ITheme objects. Theme state stored in session metadata.
7. **Output analyzer** runs server-side by watching PTY stdout. Pattern-based, not ML-based. Each Session instance has an `analyzeOutput()` method.
8. **Config** from `~/.termdeck/config.yaml`, secrets from `~/.termdeck/secrets.env` (dotenv format, referenced via `${VAR}` substitution).

## Completed milestones (historical reference)

All v0.1 milestones completed 2026-03-19. Sprints 4–6 built on that foundation.

- **M1 — Core PTY + WebSocket loop.** Shipped.
- **M2 — Layout modes (7 grids + focus + half).** Shipped.
- **M3 — Metadata + output analysis.** Shipped. Pattern tuning ongoing — patterns in `session.js` under `PATTERNS.*`.
- **M4 — Per-terminal theming.** Shipped.
- **M5 — Config + projects from `~/.termdeck/config.yaml`.** Shipped. `cc <project>` shorthand works.
- **M6 — SQLite persistence.** Shipped. DB at `~/.termdeck/termdeck.db`.
- **M7 — RAG integration.** Shipped, but the backing store migrated from a v0.1 Supabase schema to Mnestra (v0.3+). `termdeck init --mnestra` replaces the manual migration steps.
- **M8 — Polish + edge cases.** Shipped.
- **Sprint 4 — Onboarding tour.** 13-step interactive tour, replayable, auto-fires on first visit.
- **Sprint 5 — UI polish + CSS/JS extraction.** Split `index.html` into `index.html` + `style.css` + `app.js`. Add-project modal, panel drawer, Flashback toasts.
- **Sprint 6 — Preflight + transcripts.** Health badge, `/healthz` preflight checks, transcript capture + retrieval.

## Coding conventions

- No TypeScript (keeps the zero-build-step property)
- CommonJS `require()` in server (node-pty doesn't play well with ESM)
- Vanilla JS on client (no framework, no bundler)
- xterm.js loaded from CDN (jsdelivr)
- All API responses are JSON
- WebSocket messages are JSON: `{ type: 'input'|'output'|'resize'|'meta'|'exit'|'status_broadcast'|'proactive_memory', ... }`
- SQLite tables use TEXT for IDs (UUIDs), TEXT for timestamps (ISO 8601)
- Config file is YAML (parsed with `yaml` npm package)
- Errors logged to console with `[tag]` prefixes: `[pty]`, `[ws]`, `[db]`, `[rag]`, `[config]`, `[preflight]`, `[mnestra]`

## Testing approach

Manual testing was the baseline through v0.3.2. Since v0.3.3 the repo ships contract tests for `/api/health`, `/api/rumen/*`, and the transcript API; v0.4.5 added a Flashback end-to-end test and a failure-injection suite under `tests/`. For v0.4+, consider adding:
- Integration tests: spawn a server, connect WebSocket, send commands, verify output
- Unit tests for output analyzer patterns (`session.js`)
- E2E tests with Playwright for the browser UI

## Known issues and gotchas

1. **node-pty on source installs**: The published package uses prebuilt binaries. If you build from source and hit compile errors, macOS: `xcode-select --install`; then `npm rebuild node-pty`.
2. **better-sqlite3 compilation**: Ships prebuilt binaries for most platforms but may need rebuild on unusual architectures.
3. **xterm.js CDN versions**: Pinned to @5.5.0. If the CDN is unreachable, the dashboard renders blank. Vendoring is a v0.4 option.
4. **WebSocket URL**: Hardcoded to `ws://${window.location.host}/ws`. Works for localhost; needs `wss://` for any non-local deployment.
5. **Claude Code inside TermDeck**: Output analyzer patterns match Claude Code's observed output format. If the Claude Code UI changes, update `PATTERNS.claudeCode` in `session.js`.
6. **Port detection**: Regex in `session.js` catches common patterns (`on port X`, `listening on :X`) but may miss unusual server frameworks.
7. **Supabase Connect modal IPv4 toggle**: Required for Rumen deploys. Documented in the Rumen install guide.

## File map (quick reference)

```
termdeck/
├── package.json                          # Workspace root
├── README.md                             # Quickstart + pitch
├── CLAUDE.md                             # This file
├── LICENSE                               # MIT
├── .gitignore
├── config/
│   ├── config.example.yaml               # Template config
│   ├── secrets.env.example               # Template secrets
│   ├── supabase-migration.sql            # Legacy v0.1 RAG DDL
│   └── transcript-migration.sql          # Sprint 6 transcripts DDL
├── docs/
│   ├── GETTING-STARTED.md                # 4-tier install guide
│   ├── INSTALL.md                        # Install decision tree
│   ├── launch/                           # Show HN, Twitter, etc.
│   └── sprint-N-*/                       # Historical sprint logs
└── packages/
    ├── server/
    │   ├── package.json
    │   └── src/
    │       ├── index.js                   # Express + WS + PTY entry
    │       ├── session.js                 # Session + output analyzer
    │       ├── database.js                # SQLite init + helpers
    │       ├── rag.js                     # Mnestra sync layer
    │       ├── themes.js                  # 8 xterm.js themes
    │       ├── config.js                  # YAML + secrets loader
    │       ├── preflight.js               # Startup health checks
    │       ├── transcripts.js             # Transcript API
    │       ├── session-logger.js          # Optional markdown logs
    │       ├── mnestra-bridge/index.js    # direct/webhook/mcp bridge
    │       └── setup/                     # First-run bootstrap helpers
    ├── client/
    │   ├── package.json
    │   └── public/
    │       ├── index.html                 # Dashboard shell
    │       ├── style.css                  # Dashboard styles
    │       └── app.js                     # Dashboard behavior
    └── cli/
        ├── package.json
        └── src/
            ├── index.js                   # termdeck launcher
            ├── init-mnestra.js            # termdeck init --mnestra
            └── init-rumen.js              # termdeck init --rumen
```
