# Changelog

All notable changes to TermDeck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Fully-local path: SQLite + local embeddings for Mnestra (currently requires Supabase + OpenAI)
- Multi-user data validation (today's testing is single-developer)
- Control panel dashboard with Yes/No buttons for AI agent permission prompts

## [0.3.8] - 2026-04-17

### Added
- **Flashback modal**: clicking a Flashback toast now opens a proper centered modal with content, project tag, similarity score, and feedback buttons (previously opened buried drawer tab)
- **Project name resolution**: sessions and insights use config.yaml project names instead of directory path segments (fixes "chopin-nashville" appearing everywhere)
- **Insight confidence filter**: `GET /api/rumen/insights` accepts `?minConfidence=0.15` (default) to filter low-quality noise
- **Insight quality guide**: `docs/INSIGHT-QUALITY.md` with confidence score interpretation and tuning recommendations
- **`scripts/bump-version.sh`**: one-command version bump across package.json + all active docs

### Fixed
- **CLI banner right border**: dynamic version string now centers correctly in the ASCII box
- **Error detection false positive**: clean PTY exits (code 0) no longer persist "Error detected in output" status. Claude Code sessions use stricter line-start error matching to avoid flagging grep results and tool output
- **CLI bind guardrail bypass**: guard now enforced in the CLI entrypoint, not just the direct server path
- **Health badge false-green**: shows all checks when DATABASE_URL is configured, regardless of pass/fail

## [0.3.6] - 2026-04-16

### Added
- **`0.0.0.0` bind guardrail**: server refuses to start on a non-loopback host unless `auth.token` (or `TERMDECK_AUTH_TOKEN`) is configured; exits with `[security]` lines pointing to both configuration paths
- **Flashback end-to-end test** (`tests/flashback-e2e.test.js`): exercises `input → PTY error → analyzer → rag_events → mnestra-bridge` against a live server, observes via `rag_events` (write-once, race-free) rather than transient `meta.status`, skips gracefully when server or Mnestra are unavailable
- **Failure-injection test suite** (`tests/failure-injection.test.js`): 5 scenarios — Mnestra unreachable, component-failure isolation, PTY crash recovery, rapid create/destroy leak check, `/api/health` latency budget
- **`scripts/verify-release.sh`**: seven pre-publish checks (version alignment, working tree clean, `node -c` parse, `lint-docs.sh`, test suite, bin shebang, `files[]` coverage) with aggregated exit status
- `RELEASE_CHECKLIST.md`: rewritten as a TermDeck-only playbook that delegates mechanical checks to `verify-release.sh`

### Fixed
- `DEPLOYMENT.md` Binding section: previous wording was directionally correct but under-specified; now documents the exact `[security]` exit behavior, both config paths, and the three allowed loopback hosts (`127.0.0.1`, `localhost`, `::1`)

## [0.3.4] - 2026-04-16

### Added
- **Two-row toolbar layout**: replaces the horizontal-scroll toolbar; every button visible without scrolling
- **Optional token auth** (`packages/server/src/auth.js`): `Authorization: Bearer`, `?token=` query, and `termdeck_token=` cookie. Token source is `config.auth.token` OR `TERMDECK_AUTH_TOKEN`; unset = zero behavior change for local users
- **`docs/SECURITY.md`**: threat model, default posture, auth mechanics, secrets handling, transcript data hygiene
- **`docs/DEPLOYMENT.md`**: pre-exposure checklist, nginx/caddy reverse-proxy configs with 3600s WebSocket timeouts, systemd unit skeleton

### Changed
- **Status and Config buttons wired**: previously stubs; now open the status drawer and config viewer
- Removed the dead RAG indicator from the toolbar (never surfaced real state)
- `start.sh`: Node 18+ check, transcript-migration check, MCP hint, `--port` flag, stack summary on boot

## [0.3.3] - 2026-04-16

### Added
- **Contract tests** for `/api/health`, `/api/rumen/*`, and the transcript API (recent/search/replay shapes)

### Fixed
- Preflight Mnestra probe hits `/healthz` (not `/health`); resolves false-red health badge when Mnestra ≥0.2.0 is running correctly
- Toolbar overflow: tighter spacing, `overflow-x: auto`, `flex-shrink` on right section (stopgap before the 0.3.4 two-row redesign)
- `getRumenPool`: 30-second TTL retry after a transient failure, replacing the permanent per-process failure flag

### Changed
- `docs/GETTING-STARTED.md`: split `npx` vs. `clone` install paths

## [0.3.2] - 2026-04-16

### Fixed
- **RAG outbox data-loss bug**: rows were deleted before Supabase ack; writes now flushed durably
- **Transcript API contract**: request/response shape aligned with client expectations
- **Health badge**: tier-aware rendering; no longer reports false-green when Mnestra is offline
- Preflight Mnestra check: hits `/healthz` (not `/health`) and parses `store.rows`

### Changed
- Removed personal names from docs; bumped internal version refs to 0.3.2

## [0.3.1] - 2026-04-16

### Added
- **Preflight health check**: 6 parallel checks at startup (Node, ports, config, Mnestra, Rumen, Supabase)
- **Session transcripts**: schema + writer module; transcripts wired into server and surfaced via recovery UI
- **Health badge** in top bar with tier-aware display
- GETTING-STARTED.md: tier-aware guide (Tiers 1-4) with CLAUDE.md specifics and stop markers
- Tester brief: DM template + 5-step checklist for pre-launch feedback

### Fixed
- Transcript buffer cap
- RAG telemetry re-enabled with per-table 404 circuit breaker
- CI lint: bare catch blocks

## [0.3.0] - 2026-04-15

### Added
- **Rumen insights API**: async learning layer integration (Extract → Relate → Synthesize → Surface)
- **Vector embeddings** for hybrid recall across memory store
- **Client split**: `public/index.html` split into `index.html` + `style.css` + `app.js`
- **Launch collateral**: Show HN, Twitter, LinkedIn, dev.to drafts
- **Hero GIF** re-shot post-Rumen integration
- Supabase Edge Function + trigger script for Rumen
- RUMEN-UNBLOCK runbook
- `init-rumen` forwards `OPENAI_API_KEY`; migration self-heals

### Changed
- Flashback decoupled from `rag.enabled` — works standalone against Mnestra
- README rewritten with Flashback-first pitch and three-tier stack diagram

## [0.2.5] - 2026-04-15

### Added
- External audit remediation: test suite, PATCH field whitelist, hardened port regex

## [0.2.4] - 2026-04-14

### Added
- Hero GIF wired into README
- Flashback demo GIF and post-rename stills
- Tier 2 verification log

### Changed
- Sprint 3 launch materials + T1 docs sweep

## [0.2.3] - 2026-04-14

### Fixed
- Broken `termdeck init --mnestra` dispatch in 0.2.2

### Changed
- `init-engram.js` → `init-mnestra.js`
- `setup/engram-migrations/` → `setup/mnestra-migrations/`
- Stripped lingering Ingram refs (mid-session pivot residue)

## [0.2.2] - 2026-04-14

### Changed
- **Rename: Engram → Mnestra** (Ingram rejected via Ingram Industries sponsor conflict)
- Flashback toast header renders "Mnestra — possible match"
- Docs, setup wizard default package name updated
- `engram-bridge/` → `mnestra-bridge/`

### Added
- 4+1 orchestration blog post + X thread documenting the meta-moment where Flashback surfaced its own rename research mid-crisis

## [0.2.1] - 2026-04-14

### Added
- Help button links to live docs at `termdeck-docs.vercel.app`
- docs-site Vercel deploy config

## [0.2.0] - 2026-04-14

### Added
- **npm publishing**: flatten to root `@jhizzard/termdeck` with bundled server+client+config
- **Onboarding tour**: 13-step spotlight walkthrough, first-run auto-trigger, keyboard nav
- **Add-project modal** for adding projects from the UI
- **Engram bridge** (direct/webhook/mcp) — memory MCP integration (later renamed Mnestra in 0.2.2)
- **Proactive error events** surfaced as Flashback toasts
- **Session logger** and `POST /api/sessions/:id/input` for agent replies
- **INSTALL guide** and ship checklist
- Panel info tabs, switcher overlay, reply form, first-run empty state
- Alt-key handling via `e.code`, persistent launch buttons, panel indices
- dotenv secrets refactor; `@homebridge/node-pty` prebuilds
- Codespaces devcontainer; port 3000 silent auto-forward
- AI query scoped to project with `all:` prefix for cross-project search

### Changed
- Hoist runtime deps; mark CLI workspace pkg private
- Shell spawn fix (respect `SHELL` env var)
- zsh is the default shell
- Banner padding; session-logs fix

### Fixed
- Duplicate WebSocket on session create (claim `state.sessions` slot at entry)
- Disabled racy `status_broadcast` + 3s-poller auto-`createTerminalPanel` paths
- Respect `rag.enabled=false` — stop 404 push spam
- Codespaces: detect `CODESPACES` env var, skip auto-open

## [0.1.1] - 2026-04-11

### Added
- Hero screenshot and 30-second demo GIF in README
- `CONTRIBUTORS.md` documenting Joshua Izzard as sole author
- 4 reference docs in `docs/`: Rumen architecture plan, Rumen deploy checklist, Podium-derived lessons, cross-project analysis methodology
- Promotion drafts for v0.1 launch (Show HN, tweet thread, dev.to article, Reddit posts)

### Changed
- All 12 silent `catch {}` blocks replaced with `[tag]`-prefixed `console.error` calls. The 2 intentional require() fallbacks at module load are preserved.
- Established `[tag]` logging convention: `[pty]`, `[ws]`, `[db]`, `[rag]`, `[config]`, `[cli]`, `[client]`
- Tight loops (fitAll, 3-second session poll) use rate-limited one-shot warnings to avoid console spam

## [0.1.0] - 2026-03-19

### Added
- **Core PTY + WebSocket loop**: real PTY terminals via node-pty, one WebSocket per session, xterm.js client
- **6 grid layouts** (1x1, 2x1, 2x2, 3x2, 2x4, 4x2) plus focus and half modes
- **Output analyzer**: detects Claude Code, Gemini CLI, Python servers, plain shells; extracts status, ports, request counts, last commands
- **8 curated terminal themes**: Tokyo Night, Rosé Pine Dawn, Catppuccin Mocha, GitHub Light, Dracula, Solarized Dark, Nord, Gruvbox Dark
- **SQLite persistence** for sessions, commands, and RAG events
- **Project-aware launcher**: `~/.termdeck/config.yaml` defines projects with auto-cd and default themes
- **macOS .app launcher** (no terminal needed to start)
- **Windows installer** with Start Menu and Desktop shortcuts
- **WebSocket auto-reconnect** with exponential backoff
- **Status broadcast** every 2 seconds for live metadata updates
- **Keyboard shortcuts**: Ctrl+Shift+N for prompt bar, Ctrl+Shift+1-6 for layouts, Ctrl+Shift+]/[ to cycle terminals, Escape to exit focus

[Unreleased]: https://github.com/jhizzard/termdeck/compare/v0.3.8...HEAD
[0.3.8]: https://github.com/jhizzard/termdeck/compare/v0.3.4...v0.3.8
[0.3.4]: https://github.com/jhizzard/termdeck/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/jhizzard/termdeck/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jhizzard/termdeck/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jhizzard/termdeck/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jhizzard/termdeck/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/jhizzard/termdeck/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jhizzard/termdeck/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jhizzard/termdeck/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jhizzard/termdeck/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jhizzard/termdeck/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jhizzard/termdeck/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jhizzard/termdeck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jhizzard/termdeck/releases/tag/v0.1.0
