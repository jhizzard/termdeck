# T6 — miser Mac port (guest lane) · Sprint 81
**Deck :3002 · cwd `~/Documents/Graciella/miser` · Model Opus 4.8**

Brad Heath's `miser` (4th TermDeck-stack service) is already cloned to your cwd from `github.com/bheath-atx/miser`. Zero-dep Node ≥18 proxy on `127.0.0.1:20128`. Core proxy is **cross-platform — no code changes**. This lane is packaging + Mac install.

## Boot
1. `memory_recall(query="miser proxy Ollama fallback token compression Brad TermDeck stack service")` (may be thin — miser is new)
2. Read `~/.claude/CLAUDE.md`
3. Read `JOSH-SPEC.md` and `README.md` and `miser.service` **in your cwd** (Brad's spec + the systemd unit you port to launchd)
4. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-81-recall-reinjection-proof/PLANNING.md` — **your charter is § T6**, and the sibling `STATUS.md`

## Your work
- **`miser.plist`** (launchd, `~/Library/LaunchAgents/`) replacing `miser.service` (systemd). Env: `MISER_PORT`, `MISER_OLLAMA_URL`, `MISER_COMPRESSION_THRESHOLD`, `MISER_FALLBACK_MODELS`; `EnvironmentFile`-equivalent = source `~/.termdeck/secrets.env`; `KeepAlive`/restart-on-failure; `RunAtLoad`.
- **`install-mac.sh`**: brew/node/ollama preflight → resolve `command -v node` **at install time** and template that absolute path into the plist (handles Intel `/usr/local/bin/node` + Apple-Silicon `/opt/homebrew/bin/node` — **answers Brad Q1**) → pull Ollama fallback model (default smallest, larger optional) → write `~/.termdeck/secrets.env` → `launchctl load`. **Skip `npm install`** (zero deps — **answers Brad Q2**: plist + model-pull + secrets + preflight scope).
- **Ollama target = `:11434`** (Mac standard, NOT R730's `:11435`): set `MISER_OLLAMA_URL=http://127.0.0.1:11434`. (`ollama` confirmed at `/usr/local/bin/ollama`.)
- **Brad Q3 (stack integration):** standalone-first — **do NOT** wire into `termdeck-stack start` this sprint (Josh's decision).
- **Document (don't block on) security caveats** in the README: local TLS termination (prompts/code transit `:20128` plaintext; any local process can reach it); 429→Ollama silently downgrades frontier→3-14B mid-task; drop-oldest compression can break `tool_use`/`tool_result` pairing.
- Verify: `node --check src/*.js`, `npm test` (17 tests), and the plist loads + proxy answers `GET /api/miser/quota` locally.

## Discipline
- Post `### [T6] VERB 2026-07-05 HH:MM ET — gist`. This is Brad's repo — work on a branch; ORCH decides PR-vs-fork hand-back at close-out. No commits to Brad's main.
- Independent lane (no TMR upstream). Coordinate nothing except audit with T8.
