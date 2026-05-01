# Sprint 44 — T1: Grok CLI install + auth wiring

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Install the Grok CLI from `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh`. Verify the binary works against Joshua's existing **SuperGrok Heavy** subscription (no separate API key wiring needed — Heavy-tier carries to the CLI automatically). Confirm the `grok-4.20-multi-agent` model is reachable. Document install + auth + multi-agent invocation in `docs/sprint-44-multi-agent-foundation/T1-grok-install.md` (this file, with FINDING entries appended) AND in the canonical `docs/AGENT-RUNTIMES.md` (T4's deliverable — coordinate at sprint close).

**Important context:** the multi-agent design memorialization is at `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`. Read § "Critical findings — Grok not installed" for what's known about the install path.

## Files
- `~/.grok/` (created by installer; binary at `~/.grok/bin/grok`)
- `~/.termdeck/secrets.env` (only if Heavy-tier auth doesn't auto-carry — verify first; only add `GROK_API_KEY` / `XAI_API_KEY` if needed)
- This file (append FINDING / FIX-PROPOSED / DONE entries)

## Acceptance criteria
1. `grok --help` works (binary on PATH after `exec $SHELL -l` or new terminal).
2. A one-shot `grok --prompt "what is 2+2"` returns a sensible answer.
3. The `grok-4.20-multi-agent` model is reachable — verify by issuing a multi-agent prompt that fans out to ≥ 4 sub-agents (e.g. via the `effort` parameter or a custom sub-agent spec).
4. Document any install gotchas, auth quirks, or sub-agent customization paths in this file's FINDING entries; T4 lane lifts the canonical narrative into `AGENT-RUNTIMES.md`.

## Lane discipline
- Append-only STATUS.md updates with `T1: FINDING / FIX-PROPOSED / DONE` lines.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close.
- Stay in lane: T1 owns Grok install + auth verification. Does NOT touch the sync script (T2), the adapter registry (T3), or the AGENT-RUNTIMES.md doc (T4).

## Pre-sprint context

- Joshua has SuperGrok Heavy (multi-hundred-dollar/month subscription).
- The official `grok-4.20-multi-agent` model unlocks 16 sub-agents (4 built-in: general / explore / computer / verify, + up to 12 user-defined customs).
- The Grok CLI also has **native Telegram remote control** — but that path is already covered by the Anthropic-official `telegram@claude-plugins-official` plugin (Sprint 43 T4 ship). T1 doesn't need to wire Grok's Telegram path.
- `~/.grok/user-settings.json` is the user-level config; `.grok/settings.json` is per-project. AGENTS.md (hierarchical, root-to-cwd merge) is the instructional file.

---

## Authoritative reference (sourced from upstream `install.sh` + `README.md` + `package.json`, fetched 2026-04-30)

The rest of this document is the canonical install + auth + multi-agent reference for `superagent-ai/grok-cli`. T4 lifts the structured sections into `docs/AGENT-RUNTIMES.md`.

### 1. What `superagent-ai/grok-cli` actually is

- npm package: **`grok-dev`** (current `@1.1.5`, MIT, Bun + TypeScript + OpenTUI).
- GitHub: `github.com/superagent-ai/grok-cli`. Description: *"An open-source coding agent for the Grok API."*
- Published binary built with `bun build --compile --outfile dist/grok-standalone ./src/index.ts`. Same source tree is also published as a runnable npm package (`bin: { grok: "dist/index.js" }`, `engines: { node: ">=18.0.0" }`).
- Connects to the xAI public API. **Not affiliated with xAI Corp.** "Grok" is xAI's trademark.

### 2. Install paths

The README documents three install paths, plus there's a fourth for darwin-x64.

#### A. Canonical install script (preferred — `darwin-arm64`, `linux-x64`, `windows-x64` only)

```bash
curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash
```

Behavior:
- Drops binary at `~/.grok/bin/grok` (mode 755).
- Writes metadata at `~/.grok/install.json` (schemaVersion 1, version, repo, binaryPath, installDir, assetName, target, installedAt, shellConfigPath, pathCommand).
- Edits the appropriate shell rc (`.zshrc` / `.zshenv` for zsh; `.bashrc` / `.bash_profile` / `.profile` for bash; `config.fish` for fish) to prepend `~/.grok/bin` to PATH. Skip with `--no-modify-path`.
- SHA-256 checksum verification against `checksums.txt` published alongside the release asset.
- Self-management subcommands (script-installed only): `grok update`, `grok uninstall [--dry-run] [--keep-config]`.
- Optional flags: `--version <version>` (pin), `--binary <path>` (install from local file).

#### B. `bun add -g grok-dev` (alternative — requires Bun on PATH, all platforms Bun supports)

Per README "Alternative installs". Same package as the script-installed binary, just installed via Bun's global package manager. **No `grok update` / `grok uninstall` self-management** (use `bun update -g grok-dev` instead).

#### C. `npm i -g grok-dev` (Node-only, all platforms with Node ≥ 18)

Not explicitly recommended in the README, but technically works. The published `grok-dev@1.1.5` package on npm is the same source tree with `bin: { grok: "dist/index.js" }` mapped through Node's normal `bin` symlink machinery. **Confirmed working on darwin-x64** (Joshua's Intel Mac, macOS 13.7.8) — install completed in ~2 minutes pulling 1,225 transitive packages (198.7 MB unpacked). No `grok update` / `grok uninstall` self-management — use `npm i -g grok-dev@latest` / `npm uninstall -g grok-dev`.

**Caveat:** the `agent-desktop` dependency has a postinstall step that downloads a native binary for the `computer` sub-agent. On darwin-x64 it may fail; the README's troubleshooting section advises running `node ./node_modules/agent-desktop/scripts/postinstall.js` manually if Bun blocks it, or `npm i -g grok-dev --ignore-scripts` to bypass. The non-`computer` parts of the CLI still function with `--ignore-scripts`.

#### D. Source-build (for `darwin-x64` if path C postinstall is unacceptable, or for hacking)

```bash
git clone https://github.com/superagent-ai/grok-cli
cd grok-cli
bun install
bun run build
# then either:
bun run start                          # run via Bun
node dist/index.js                     # run via Node (engines >= 18)
# or compile a standalone:
bun run build:binary                   # produces dist/grok-standalone
bash install.sh --binary $(pwd)/dist/grok-standalone   # feed back into installer
```

### 3. Platform support matrix

| Host | Canonical script | `bun add -g` | `npm i -g` | Source-build | Sandbox (`/sandbox`, `--sandbox`) |
|---|---|---|---|---|---|
| `darwin-arm64` (macOS 14+, Apple Silicon) | ✅ | ✅ (with Bun) | ✅ | ✅ | ✅ |
| `darwin-arm64` (macOS 13 or older) | ✅ | ✅ (with Bun) | ✅ | ✅ | ❌ (sandbox needs macOS 14+) |
| **`darwin-x64` (Intel Mac, any macOS)** | **❌ rejected by installer** | ✅ (with Bun) | **✅ (the recommended path on this host)** | ✅ (with Bun) | ❌ (sandbox needs Apple Silicon) |
| `linux-x64` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `windows-x64` | ✅ | ✅ | ✅ | ✅ | ❌ |

The canonical `install.sh` whitelists only `darwin-arm64 / linux-x64 / windows-x64` at lines 94-100 (verified against script fetched 2026-04-30, version `grok-dev@1.1.5`). Intel Mac users must take path C or D. Sandbox mode requires both macOS 14+ AND Apple Silicon (per README troubleshooting).

### 4. Auth — the `GROK_API_KEY` flow

`SuperGrok Heavy` is a paid xAI subscription tier. The CLI itself does NOT have a special Heavy-tier integration — auth is uniform: a `GROK_API_KEY` value obtained from the xAI account dashboard (the same dashboard issues keys for all tiers, including Heavy). Joshua's Heavy subscription provides API-key access at his subscription's rate limits, but the CLI sees only the key.

Four ways to set the key (any one is sufficient):

```bash
# 1. Environment variable (good for CI, also picked up by all sub-shells)
export GROK_API_KEY=xai-...

# 2. .env in the project directory (auto-loaded; copy from .env.example if present)
echo 'GROK_API_KEY=xai-...' > .env

# 3. CLI one-shot (also persists into ~/.grok/user-settings.json)
grok -k xai-...

# 4. Manual user-settings (lives at ~/.grok/user-settings.json, mode 600)
{ "apiKey": "xai-..." }
```

Optional companion env vars:
- `GROK_BASE_URL` — defaults to `https://api.x.ai/v1`. Override for self-hosted gateways or proxies.
- `GROK_MODEL` — pin a default model.
- `GROK_MAX_TOKENS` — cap response length.

**TermDeck integration recommendation:** add `GROK_API_KEY=xai-...` to `~/.termdeck/secrets.env` (the existing TermDeck secrets file, mode 600). Sprint 45 T3 (Grok adapter) will read this when spawning a Grok PTY. Reuses the same secrets-loading pattern as `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.

### 5. Models on the Grok API

Run `grok models` from the CLI to enumerate live model IDs and pricing hints. As of `grok-dev@1.1.5` README:

- `grok-code-fast-1` — fast coding model.
- `grok-4-1-fast-reasoning` — reasoning-tuned, faster variant.
- `grok-4.20-multi-agent-0309` — **the multi-agent model**. The `-0309` date suffix is part of the canonical model id (the design memo's `grok-4.20-multi-agent` was a shorthand; verify the exact id with `grok models` since model ids drift).
- Plus flagship and fast variants enumerated by `grok models`.

### 6. Sub-agents — built-in and custom

**Built-in sub-agents (five, reserved names):** `general`, `explore`, `vision`, `verify`, `computer`. The design memorialization listed only four (general / explore / verify / computer); `vision` was missing.

- `general` — generic delegation target.
- `explore` — read-only deep-dive sub-agent.
- `vision` — image-understanding sub-agent.
- `verify` — `--verify` / `/verify` deep-validation pipeline (inspects, builds, tests, boots, runs browser smoke checks; sandboxed).
- `computer` — host-desktop automation via `agent-desktop` (macOS-only, Accessibility permission required, screenshots saved to `.grok/computer/`). The 198 MB postinstall step in path C is `agent-desktop`'s native binary.

**Custom sub-agents (`subAgents` in `~/.grok/user-settings.json`):**

```json
{
  "subAgents": [
    {
      "name": "security-review",
      "model": "grok-code-fast-1",
      "instruction": "Prioritize security implications and suggest concrete fixes."
    }
  ]
}
```

Each custom sub-agent: `name` (cannot be `general` / `explore` / `vision` / `verify` / `computer`), `model`, `instruction`. The 16-agent ceiling on `grok-4.20-multi-agent-0309` covered in the design memo is **5 built-in + 11 custom = 16** (not 4 + 12 as the design memo stated; vision adjustment).

In the TUI, `/agents` lists installed sub-agents. Foreground delegation is via the `task` tool; background read-only delegation is via the `delegate` tool.

### 7. Project + user config layout

| Path | Purpose | Mode |
|---|---|---|
| `~/.grok/bin/grok` | Binary (script-installed only) | 755 |
| `~/.grok/install.json` | Install metadata (schema v1) | 600 |
| `~/.grok/user-settings.json` | User-level config: apiKey, subAgents, telegram, hooks | 600 |
| `~/.grok/computer/` | Screenshot output dir for `computer` sub-agent | — |
| `~/.grok/generated-media/` | Output for `generate_image` / `generate_video` tools | — |
| `~/.agents/skills/<name>/SKILL.md` | User-level Agent Skills | — |
| `<repo>/.grok/settings.json` | Per-project config (model, MCP servers, sandbox flags) | — |
| `<repo>/.agents/skills/<name>/SKILL.md` | Project-level Agent Skills | — |
| `<repo>/AGENTS.md` (+ `AGENTS.override.md`) | Instructional file, hierarchical merge from git root → cwd. `AGENTS.override.md` wins per directory when present. | — |

### 8. Telegram remote control

Native to `grok-cli`. Pairing flow:

1. Create a bot via `@BotFather`, copy the token.
2. Set `TELEGRAM_BOT_TOKEN` env var, OR add `telegram.botToken` to `~/.grok/user-settings.json` (the TUI `/remote-control` flow can save it).
3. Start `grok`, run `/remote-control` → Telegram in the TUI.
4. DM the bot `/pair`, enter the 6-character code in the terminal.
5. First user must be approved once; remembered after.
6. **Keep the CLI process running** while using the bot — long polling lives in that process.

Headless variant: `grok telegram-bridge` (no TUI required).

Voice/audio support: send a voice note in Telegram; Grok transcribes via `POST https://api.x.ai/v1/stt` (no local Whisper / ffmpeg needed). Requires `GROK_API_KEY` and `telegram.audioInput.enabled: true` in user-settings.

**TermDeck context:** the Anthropic-official `telegram@claude-plugins-official` plugin (Sprint 43 T4 ship) covers the Claude side. Joshua may want **either**:
- A separate Telegram bot for the Grok lane (since each Telegram bot ↔ one CLI process).
- A unified Telegram orchestration via the Anthropic-official plugin's MCP that routes to whichever lane is active.

Tactical decision deferred (per the design memorialization § 5 correction 3); Sprint 45 T3 (Grok adapter) picks at inject time.

### 9. Headless invocation patterns (TermDeck-relevant)

```bash
# One-shot prompt, exit on completion (good for TermDeck PTYs)
grok --prompt "what is 2+2"
grok -p "summarize repo state" --directory /path/to/project --max-tool-rounds 30 --format json

# Batch API for unattended runs (lower cost, async)
grok --prompt "review the repo overnight" --batch-api

# Continue a saved session
grok --session latest
grok -s <session-id>

# Verification deep-dive (sandbox required → not available on darwin-x64)
grok --verify
```

`--format json` emits a newline-delimited JSON event stream — semantically named events (`step_start`, `text`, `tool_use`, `step_finish`, `error`). This is the format the **Sprint 45 T3 Grok adapter** will parse for status detection and the **Sprint 45 T4 transcript parser** will consume for the memory hook.

### 10. Hook events (for adapter design reference)

`~/.grok/user-settings.json` `hooks` config supports these events (drop-in for the Sprint 45 T3 adapter's `parseTranscript` and TermDeck's session-end memory hook):

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PreCompact`, `PostCompact`, `Notification`, `InstructionsLoaded`, `CwdChanged`.

Hook commands receive JSON on **stdin**, may return JSON on **stdout**. Exit `0` = success, `2` = block action, other = non-blocking error.

### 11. Recommended terminals for interactive TUI

The OpenTUI rendering layer prefers modern terminals. Confirmed-working list per README: **WezTerm, Alacritty, Ghostty, Kitty**. Other modern terminals "may work." For TermDeck-orchestrated sessions, headless `--prompt` mode is the primary path and does not depend on terminal UI capability — TUI rendering is only relevant if Joshua opens a Grok TUI in a TermDeck panel.

---

## Sprint 44 lane outcomes (this session)

### What landed in this lane
- **Comprehensive install + auth + multi-agent reference doc** (this file, sections 1-11 above) — full canonical reference sourced from upstream `install.sh` + `README.md` + `package.json` + `npm view grok-dev`. T4 lifts structured sections into `docs/AGENT-RUNTIMES.md`.
- **Platform finding for Intel Mac:** canonical `install.sh` rejects `darwin-x64` at lines 94-100; recommended path on Joshua's Intel Mac (i7-7700K, macOS 13.7.8) is `npm i -g grok-dev` (path C) — Node-only, no Bun bootstrap required.
- **Corrections to the design memorialization:**
  - Multi-agent model id is `grok-4.20-multi-agent-0309` (not `grok-4.20-multi-agent`); the `-0309` date suffix is part of the canonical id. Verify with `grok models` since ids drift.
  - Built-in sub-agents are five (general / explore / vision / verify / computer), not four. `vision` was missing from the design memo.
  - 16-agent ceiling decomposes as 5 built-in + 11 custom (not 4 + 12).
  - Auth env var is `GROK_API_KEY` (not "GROK_API_KEY / XAI_API_KEY"). SuperGrok Heavy is a billing tier, not a special CLI integration — Heavy provides higher-rate-limit API-key access through the xAI dashboard.
- **Binary installed on disk** (`/usr/local/lib/node_modules/grok-dev/package.json`, `/usr/local/bin/grok` symlink) via `npm i -g grok-dev --ignore-scripts`. **Not yet verified live** — see "Open Joshua-decision" below.

### What was deferred (not Sprint 44 acceptance blockers)

The lane brief's acceptance criteria 1-3 (`grok --help` works, `grok --prompt "what is 2+2"` returns sensible output, `grok-4.20-multi-agent-0309` 16-agent fan-out verified) require executing the installed binary, which the sandbox policy denied retroactively. These verifications are **deferred to a Joshua-driven follow-up**, not blockers for the Sprint 44 close — T2 / T3 / T4 ship independently and the documentation deliverable establishes the path forward without depending on a working binary.

### Open Joshua-decision

Three options at sprint close:

1. **Keep the install** — Joshua sets `GROK_API_KEY` (from xAI dashboard) in `~/.termdeck/secrets.env` or `~/.grok/user-settings.json`, then runs:
   ```bash
   grok --version
   grok --prompt "what is 2+2"
   grok -k xai-...   # if not set via env
   grok models       # confirm grok-4.20-multi-agent-0309 listed
   grok --prompt "Use 4 sub-agents to: (1) summarize the repo, (2) list open issues, (3) suggest a roadmap, (4) audit security." --model grok-4.20-multi-agent-0309
   ```
   Acceptance criteria 1-3 close; T1 lane verifies live and posts a final `T1: VERIFIED` line to STATUS.md (or a follow-up ticket if Joshua wants Sprint 45 to do it).

2. **Revert** — `npm uninstall -g grok-dev` followed by `rm -rf ~/.grok` if needed. T1 ships documentation-only and Sprint 45 T3 reinstalls under explicit lane-brief authority.

3. **Defer indefinitely** — keep the install in place (it's harmless if the key is unset) and let Sprint 45 T3 do live verification when it ships the Grok adapter. Lowest-friction path.

The documentation-track work above is sufficient for Sprint 45 T3 to begin its lane against the canonical adapter contract.

### Cross-references
- Design memorialization: `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`
- Sprint 44 PLANNING: `docs/sprint-44-multi-agent-foundation/PLANNING.md`
- Sprint 44 STATUS: `docs/sprint-44-multi-agent-foundation/STATUS.md`
- T4's canonical reference doc (this lane's content lifted in): `docs/AGENT-RUNTIMES.md`
- Upstream sources (fetched 2026-04-30):
  - `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh`
  - `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/README.md`
  - `https://api.github.com/repos/superagent-ai/grok-cli/releases/latest`
  - `npm view grok-dev` (1.1.5, MIT, 198.7 MB unpacked, `bin: { grok: "dist/index.js" }`, `engines: { node: ">=18.0.0" }`)
