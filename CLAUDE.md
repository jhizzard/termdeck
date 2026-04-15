# CLAUDE.md — TermDeck Build Specification

## What this project is

TermDeck is a web-based terminal multiplexer that embeds real PTY terminals in a browser dashboard. Each terminal panel has rich metadata overlays (project, status, last commands, AI agent state), per-terminal theming, flexible grid layouts, and a RAG integration that syncs session data to Supabase.

Think: tmux in the browser, but with a control-room UI showing what every terminal is doing.

## What is already built (scaffold)

The scaffold is complete and internally consistent. All files reference each other correctly. Here's what exists:

### Server (`packages/server/src/`)
- **index.js** — Express + WebSocket server. REST API for session CRUD, resize, themes, config, global status. WebSocket hub that binds one socket per terminal session. PTY spawning via node-pty. Periodic metadata broadcast every 2s. **Status: Fully written, needs dependency install and runtime testing.**
- **session.js** — Session class wrapping a PTY with metadata. Output analyzer with regex patterns for Claude Code, Gemini CLI, Python servers, and shell prompts. Detects status (thinking, editing, idle, listening, errored, exited), ports, HTTP request counts, and command history. SessionManager class with event emitter for RAG hooks. **Status: Fully written, pattern matchers need real-world tuning.**
- **database.js** — SQLite via better-sqlite3. Tables: sessions, command_history, rag_events, projects. WAL mode. Helper functions for logging commands, RAG events, querying history. **Status: Fully written.**
- **rag.js** — RAGIntegration class. Three-layer memory (session → project → developer). Local SQLite buffer with periodic Supabase sync. Event handlers for session lifecycle, commands, status changes, file edits. Configurable tables and sync interval. **Status: Fully written, Supabase push logic needs real endpoint testing.**
- **themes.js** — 8 curated xterm.js theme objects (Tokyo Night, Rosé Pine Dawn, Catppuccin Mocha, GitHub Light, Dracula, Solarized Dark, Nord, Gruvbox Dark) plus status indicator color map. **Status: Complete.**

### Client (`packages/client/public/`)
- **index.html** — Single-file dashboard (~1000 lines). Loads xterm.js + addons from CDN. Layout engine with 7 grid modes (1x1, 2x1, 1x2, 2x2, 3x2, 2x4, 4x2) plus focus and half modes. Panel creation with metadata headers, status dots, project tags, control strips, theme selectors, AI input fields. WebSocket connection per terminal. Keyboard shortcuts (Ctrl+Shift+N, Ctrl+Shift+1-6, Escape). Prompt bar launcher with command parsing and project dropdown. **Status: Fully written, needs live testing against running server.**

### CLI (`packages/cli/src/`)
- **index.js** — `termdeck` command. Parses --port, --no-open, --help. Boots server, opens browser. Graceful shutdown on SIGINT. **Status: Fully written.**

### Config (`config/`)
- **config.example.yaml** — Template with project definitions, RAG settings, theme defaults.
- **supabase-migration.sql** — DDL for all 4 RAG tables with indexes, RLS policies, trigram FTS, and a recent_activity view.

### Root
- **package.json** — npm workspaces config.
- **README.md** — Full documentation with layout table, keyboard shortcuts, architecture diagram, setup instructions.

## Architecture decisions (locked in — do not change)

1. **node-pty + xterm.js + WebSocket** is the terminal stack. One PTY per session, one WebSocket per session, xterm.js with addon-fit and addon-web-links on the client.
2. **Express** for REST API, **ws** library for WebSockets (not Socket.IO).
3. **SQLite** (better-sqlite3) for local persistence. Supabase for RAG sync. SQLite is the source of truth; Supabase is an async replica.
4. **Vanilla JS** on the client. No React, no build step. Single index.html with CDN-loaded xterm.js. This keeps `npx termdeck` zero-config.
5. **CSS Grid** for layouts. No drag-resize library in v0.1 — layout modes are preset grid templates.
6. **Per-terminal theming** via xterm.js ITheme objects. Theme state stored in session metadata.
7. **Output analyzer** runs server-side by watching PTY stdout. Pattern-based, not ML-based. Each Session instance has an `analyzeOutput()` method.
8. **Config** from `~/.termdeck/config.yaml`. Projects define path + default theme + default command.

## Build sequence (work these milestones in order)

### Milestone 1: Core PTY + WebSocket loop
**Goal:** Launch the server, open the browser, type in the prompt bar, see a real terminal appear and be fully interactive.

1. `npm install` in root (workspaces will install all packages)
2. Fix any node-pty compilation issues (may need `node-gyp` or Xcode CLT)
3. Start the server: `node packages/server/src/index.js`
4. Verify: open http://localhost:3000, see the dashboard UI
5. Type `bash` in the prompt bar, click launch
6. Verify: a terminal panel appears, you can type commands, see output
7. Test: `ls`, `pwd`, `echo hello`, `vim` (verify full terminal emulation)
8. Test: open 2-3 terminals, verify they're independent
9. Test: close a terminal via the X button, verify PTY is killed
10. Test: resize the browser window, verify terminals re-fit

**Key files:** `packages/server/src/index.js` (POST /api/sessions, WebSocket handler), `packages/client/public/index.html` (createTerminalPanel, launchTerminal)

### Milestone 2: Layout modes working
**Goal:** All 7 grid layouts switch correctly. Focus and half modes work.

1. Open 4+ terminals
2. Click through each layout button: 1x1, 2x1, 2x2, 3x2, 2x4, 4x2
3. Verify terminals re-fit on layout change
4. Test focus mode: click the □ button on any panel
5. Test half mode: click the ▯ button on any panel
6. Test Escape to exit focus/half
7. Test keyboard shortcuts: Ctrl+Shift+1 through 6
8. Fix any overflow or sizing issues at each density

### Milestone 3: Metadata and output analysis
**Goal:** Terminal panels show live, accurate metadata.

1. Open a shell, run some commands — verify "last command" updates in the metadata strip
2. Open a Python web server (e.g., `python3 -m http.server 8080`) — verify port detection, type changes to "Python Server", status shows "listening"
3. Test the status dot colors update correctly for each state
4. Verify the "opened X ago" timestamps are reasonable
5. Test the global stats in the top bar (active/thinking/idle counts)
6. Tune output analyzer patterns in `session.js` if detection is wrong

**Note on Claude Code detection:** You won't be able to test Claude Code detection from inside Claude Code (recursion). Test by launching `claude` from a TermDeck terminal and verifying the panel metadata updates. The patterns in session.js look for Claude Code's `>` prompt and `Edit`/`Create` output markers.

### Milestone 4: Theming
**Goal:** Each terminal can independently switch themes.

1. Open 2+ terminals
2. Use the theme dropdown on each panel's control strip
3. Verify: terminal background/foreground changes immediately
4. Verify: theme preference persists (PATCH /api/sessions/:id stores it)
5. Test: one terminal in Tokyo Night, another in Rosé Pine Dawn, simultaneously

### Milestone 5: Configuration and projects
**Goal:** `~/.termdeck/config.yaml` drives project definitions.

1. Copy `config/config.example.yaml` to `~/.termdeck/config.yaml`
2. Edit: set real project paths for your projects (scheduling-saas, claimsguard, ecommerce, etc.)
3. Restart server
4. Verify: project dropdown in prompt bar populates from config
5. Test: select a project, launch a terminal — verify it cd's to the project path
6. Test: project tag appears with correct color in the panel header
7. Test shorthand: type `cc scheduling` → should resolve to `claude` command in `~/scheduling-saas`

### Milestone 6: SQLite persistence
**Goal:** Sessions and command history persist across server restarts.

1. Open a few terminals, run some commands
2. Check `~/.termdeck/termdeck.db` exists
3. Restart the server
4. Verify: the dashboard reconnects to existing sessions (or gracefully shows them as exited)
5. Verify: GET /api/sessions/:id/history returns command history

### Milestone 7: RAG integration
**Goal:** Terminal events sync to Supabase.

1. Run `config/supabase-migration.sql` against your Supabase instance
2. Add `supabaseUrl` and `supabaseKey` to `~/.termdeck/config.yaml`
3. Set `rag.enabled: true`
4. Restart server
5. Open terminals, run commands
6. Verify: rows appear in `termdeck_session_memory`, `termdeck_project_memory`, `termdeck_developer_memory`
7. Test: check the `termdeck_recent_activity` view for cross-layer data
8. Verify: the "RAG synced" indicator appears in the top bar

### Milestone 8: Polish and edge cases
1. Handle terminal exit gracefully (show "Exited (0)" in panel, dim the status dot)
2. Handle WebSocket disconnection (reconnect logic or clear error state)
3. Handle server crash/restart (client reconnection)
4. Test with 8 simultaneous terminals under load
5. Test with long-running processes (leave a server running for hours)
6. Accessibility: ensure keyboard navigation works between panels
7. Mobile: not a target, but don't let it crash completely

## Coding conventions

- No TypeScript in v0.1 (keep the zero-build-step property)
- CommonJS require() in server (node-pty doesn't play well with ESM)
- Vanilla JS on client (no framework, no bundler)
- xterm.js loaded from CDN (jsdelivr)
- All API responses are JSON
- WebSocket messages are JSON: `{ type: 'input'|'output'|'resize'|'meta'|'exit'|'status_broadcast', ... }`
- SQLite tables use TEXT for IDs (UUIDs), TEXT for timestamps (ISO 8601)
- Config file is YAML (parsed with `yaml` npm package)
- Errors logged to console with `[tag]` prefixes: `[pty]`, `[ws]`, `[db]`, `[rag]`, `[config]`

## Testing approach

Manual testing for v0.1. The milestones above are the test plan. Each milestone has explicit verify steps. If something doesn't work, fix it before moving to the next milestone.

For v0.2, consider adding:
- Integration tests: spawn a server, connect WebSocket, send commands, verify output
- Unit tests for output analyzer patterns (session.js)
- E2E tests with Playwright for the browser UI

## Known issues and gotchas

1. **node-pty compilation**: Requires C++ compiler. On macOS: `xcode-select --install`. If compilation fails, try `npm rebuild node-pty`.
2. **better-sqlite3 compilation**: Same C++ requirement. Ships prebuilt binaries for most platforms but may need rebuild.
3. **xterm.js CDN versions**: Pinned to @5.5.0 in the HTML. If CDN is unreachable, the dashboard shows an empty page. Could vendor the files locally for robustness.
4. **WebSocket URL**: Hardcoded to `ws://${window.location.host}/ws`. Works for localhost but needs TLS (`wss://`) for any non-local deployment.
5. **Claude Code inside TermDeck**: The output analyzer's Claude Code patterns are based on observed output format. If Claude Code updates its UI, the patterns need updating. The patterns are in `packages/server/src/session.js` under `PATTERNS.claudeCode`.
6. **Port detection**: The regex in session.js catches common patterns (`on port X`, `listening on :X`) but may miss unusual server frameworks.

## File map (quick reference)

```
termdeck/
├── package.json                          # Workspace root
├── README.md                             # Full docs
├── CLAUDE.md                             # This file
├── LICENSE                               # MIT
├── .gitignore
├── config/
│   ├── config.example.yaml               # Template config
│   └── supabase-migration.sql            # RAG table DDL
└── packages/
    ├── server/
    │   ├── package.json                   # Server deps
    │   └── src/
    │       ├── index.js                   # Express + WS + PTY entry
    │       ├── session.js                 # Session class + output analyzer
    │       ├── database.js                # SQLite init + helpers
    │       ├── rag.js                     # Supabase sync layer
    │       └── themes.js                  # 8 xterm.js themes
    ├── client/
    │   ├── package.json
    │   └── public/
    │       └── index.html                 # Full dashboard UI (~1000 lines)
    └── cli/
        ├── package.json                   # CLI deps + bin entry
        └── src/
            └── index.js                   # termdeck launcher
```
