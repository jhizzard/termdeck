# Changelog

All notable changes to TermDeck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Fully-local path: SQLite + local embeddings for Mnestra (currently requires Supabase + OpenAI)
- Multi-user data validation (today's testing is single-developer)
- Control panel dashboard with Yes/No buttons for AI agent permission prompts

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

[Unreleased]: https://github.com/jhizzard/termdeck/compare/v0.3.2...HEAD
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
