# TermDeck Architecture

Reference doc for code modifications. Read before adding features, fixing bugs, or diagnosing runtime issues.

## What this project is

TermDeck is a web-based terminal multiplexer that embeds real PTY terminals in a browser dashboard. Each terminal panel has rich metadata overlays (project, status, last commands, AI agent state), per-terminal theming, flexible grid layouts, and a RAG integration that syncs session data to a Mnestra-backed Postgres (pgvector) store.

Think: tmux in the browser, but with a control-room UI showing what every terminal is doing, plus Flashback — proactive recall of similar past errors the moment a panel hits a problem.

## Architecture decisions (locked in — do not change without an explicit decision sprint)

1. **node-pty + xterm.js + WebSocket** is the terminal stack. One PTY per session, one WebSocket per session, xterm.js with addon-fit and addon-web-links on the client. Uses `@homebridge/node-pty-prebuilt-multiarch` so `npx termdeck` avoids any C++ compile step.
2. **Express** for REST API, **ws** library for WebSockets (not Socket.IO).
3. **SQLite** (better-sqlite3) for local persistence. Mnestra (Postgres + pgvector) for RAG sync. SQLite is the local source of truth; Mnestra is an async durable replica that also backs Flashback queries.
4. **Vanilla JS** on the client. No React, no build step. Three files: `index.html`, `style.css`, `app.js`. xterm.js loaded from CDN. This keeps `npx termdeck` zero-config.
5. **CSS Grid** for layouts. No drag-resize library — layout modes are preset grid templates.
6. **Per-terminal theming** via xterm.js ITheme objects. Theme state stored in session metadata.
7. **Output analyzer** runs server-side by watching PTY stdout. Pattern-based, not ML-based. Each Session instance has an `analyzeOutput()` method.
8. **Config** from `~/.termdeck/config.yaml`, secrets from `~/.termdeck/secrets.env` (dotenv format, referenced via `${VAR}` substitution).

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

- **index.js** — `termdeck` command. Parses `--port`, `--no-open`, `--session-logs`, `--help`. Boots server, opens browser. Stale-port reclaim. RAG state banner. Graceful shutdown on SIGINT.
- **init-mnestra.js** — `termdeck init --mnestra` wizard. Persists `~/.termdeck/secrets.env` first, applies Mnestra migrations, writes `config.yaml` with `rag.enabled: false` (MCP-only default since v0.7.3), verifies connection. Supports `--yes`, `--reset`, `--from-env`.
- **init-rumen.js** — `termdeck init --rumen` wizard. Deploys the Rumen Supabase Edge Function, applies migration, sets secrets, installs the `pg_cron` schedule. Gates on `pg_cron` and `pg_net` extensions via `auditRumenPreconditions`.
- **doctor.js** — `termdeck doctor` diagnostic. Two sections: (1) version-check across the four stack packages (Sprint 28), (2) Supabase schema-check (Sprint 35 — Mnestra modern, Mnestra legacy, transcript, Rumen, extensions). Use `--no-schema` to skip the DB probe.

### Config (`config/`)

- **config.example.yaml** — Template with project definitions, RAG settings, theme defaults.
- **secrets.env.example** — Template for API keys.
- **supabase-migration.sql** — Legacy v0.1 RAG DDL. Mirror; auto-applied via `mnestra-migrations/008_legacy_rag_tables.sql` (Sprint 35).
- **transcript-migration.sql** — Transcript table DDL (Sprint 6). Required for `termdeck_transcripts`. **Must be listed in `package.json` `files` array** for fresh installs to apply it.

## Testing approach

Manual testing was the baseline through v0.3.2. Since v0.3.3 the repo ships contract tests for `/api/health`, `/api/rumen/*`, and the transcript API. v0.4.5 added a Flashback end-to-end test and a failure-injection suite under `tests/`. Sprint 35 added schema-check tests to `tests/cli-doctor.test.js` and `tests/preconditions.test.js` using a fake-pg-client substring-routing pattern.

For new features, prefer the patterns already in `tests/` over adding a new framework. Test runner is `node --test`.

## File map (quick reference)

```
termdeck/
├── package.json                          # Workspace root — what publishes as @jhizzard/termdeck
├── README.md                             # Quickstart + pitch
├── CLAUDE.md                             # Agent read-order router
├── CHANGELOG.md                          # Release log
├── LICENSE                               # MIT
├── .gitignore
├── docs/
│   ├── RELEASE.md                        # Release protocol — read before npm publish
│   ├── ARCHITECTURE.md                   # This file
│   ├── GETTING-STARTED.md                # 4-tier install guide
│   ├── INSTALL.md                        # Install decision tree
│   ├── launch/                           # Show HN, Twitter, etc.
│   └── sprint-N-*/                       # Sprint planning + status logs
├── config/
│   ├── config.example.yaml
│   ├── secrets.env.example
│   ├── supabase-migration.sql            # Mirror; auto-applied via mnestra-migrations/008
│   └── transcript-migration.sql          # Required at install time
├── scripts/
│   ├── start.sh                          # Joshua's personal full-stack launcher (parity in CLI Sprint 36)
│   └── migrate-chopin-nashville-tag.sql  # Sprint 34 corpus repair
├── tests/                                # contract + integration tests (node --test)
└── packages/
    ├── server/src/                       # see "Server" section above
    ├── client/public/                    # see "Client" section above
    ├── cli/src/                          # see "CLI" section above
    └── stack-installer/                  # @jhizzard/termdeck-stack meta-installer
```

## Known issues and gotchas

1. **node-pty on source installs**: The published package uses prebuilt binaries. If you build from source and hit compile errors, macOS: `xcode-select --install`; then `npm rebuild node-pty`.
2. **better-sqlite3 compilation**: Ships prebuilt binaries for most platforms but may need rebuild on unusual architectures.
3. **xterm.js CDN versions**: Pinned to @5.5.0. If the CDN is unreachable, the dashboard renders blank. Vendoring is a candidate option if outages become common.
4. **WebSocket URL**: Hardcoded to `ws://${window.location.host}/ws`. Works for localhost; needs `wss://` for any non-local deployment.
5. **Claude Code inside TermDeck**: Output analyzer patterns match Claude Code's observed output format. If the Claude Code UI changes, update `PATTERNS.claudeCode` in `session.js`.
6. **Port detection**: Regex in `session.js` catches common patterns (`on port X`, `listening on :X`) but may miss unusual server frameworks.
7. **Supabase Connect modal IPv4 toggle**: Required for Rumen deploys. Documented in the Rumen install guide.
8. **Dashboard "dark veil"**: Stuck modal/overlay blocks pointer events to xterm.js terminals. Workaround: `Esc` then `Cmd+Shift+R`. Last-resort: `document.querySelectorAll('.modal-backdrop, [class*="modal"]').forEach(el => el.remove())` in dev console. Sprint 36 / Phase B candidate fix.
9. **Hard-refresh kills server-side PTYs**: `Cmd+Shift+R` causes `/api/sessions` to drop to 0 immediately. WebSocket close handler is misinterpreting client-disconnect as session shutdown. Sprint 36 / Phase B candidate fix.
10. **Personal-vs-product asymmetry**: Joshua's daily-driver box runs `rag.enabled: false` (MCP-only mode); the legacy `mnestra_*_memory` schema is therefore dormant on his box. Fresh users with `rag.enabled: true` exercise paths Joshua doesn't. v0.7.3 flipped the default to MCP-only and shipped the legacy schema as 008 — but personal-vs-product divergence remains a recurring failure mode to watch for.

## Pre-existing test debt (do not assume your sprint introduced these)

- `packages/server/tests/session.test.js` — three `Error detection` cases assert status `'errored'` but get `'active'`. Last commit on file: v0.2.5 (95c577d). Reproducible against `HEAD` via `git stash && node --test`. Flagged for a future analyzer-pattern fix sprint.
