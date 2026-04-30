# Sprint 44 — Multi-agent foundation: Grok install + AGENTS.md sync + adapter registry skeleton

**Status:** Inject-ready. Lane briefs + STATUS.md template + paste-ready orchestrator prompt + inject script all staged.
**Target version:** `@jhizzard/termdeck@0.13.0` + `@jhizzard/termdeck-stack@0.4.8` (audit-trail).
**Foundation only.** Codex / Gemini / Grok adapters land in Sprint 45; mixed 4+1 in Sprint 46.
**Last-published baselines (2026-04-30 evening):** `termdeck@0.12.0`, `mnestra@0.3.3`, `termdeck-stack@0.4.7`, `rumen@0.4.4`. (These bumps are pending Joshua's Passkey at session close — verify with `npm view @jhizzard/termdeck version` before inject.)

## Why this sprint (one-paragraph context)

Joshua tapped Claude Max 20x during Sprint 42 close-out despite disciplined token economy. Multi-agent isn't a luxury — it's a capacity safety valve and an audit-quality lever. The full design rationale + adapter contract + 3-sprint trilogy is at `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`. Sprint 44 is the **foundation only**: install Grok, build the agent-instruction sync mechanism, set up the adapter registry skeleton with Claude as the first migration target (snapshot-test parity), and write the canonical reference doc. **No Codex / Gemini / Grok adapters yet** — those are Sprint 45.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Grok CLI install + auth wiring** | Run `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh`. Verify `grok` is on PATH. Confirm SuperGrok Heavy carries the API key automatically (no separate config). Smoke-test a one-shot `grok --prompt "say hi"` and a multi-agent invocation against `grok-4.20-multi-agent`. Document install gotchas + `~/.grok/user-settings.json` location for sub-agent customization. | `~/.grok/` (created by installer), `~/.termdeck/secrets.env` (verify GROK / XAI key wiring if needed), NEW notes in `docs/sprint-44-multi-agent-foundation/T1-grok-install.md` |
| **T2 — `scripts/sync-agent-instructions.js`** | Pure-Node script that reads `CLAUDE.md` (canonical) and emits `AGENTS.md` (Codex + Grok shared) + `GEMINI.md` mirrors with agent-specific lead-in banners. Header on each generated file: `<!-- AUTO-GENERATED from CLAUDE.md by sync-agent-instructions.js. Do not edit directly. -->`. Add `npm run sync:agents` to root `package.json`. Generated mirrors are committed (visible to external GitHub readers); the script is idempotent — re-running on already-synced files produces no diff. NEW `tests/sync-agent-instructions.test.js`. | NEW `scripts/sync-agent-instructions.js`, `package.json` (`scripts.sync:agents`), NEW `tests/sync-agent-instructions.test.js`, NEW `AGENTS.md` + `GEMINI.md` at repo root (gitignored? committed? — lane brief T2 picks committed for external visibility) |
| **T3 — Agent adapter registry skeleton + Claude adapter migration** | NEW `packages/server/src/agent-adapters/index.js` exports `AGENT_ADAPTERS` map keyed by adapter name. NEW `packages/server/src/agent-adapters/claude.js` lifts the existing `PATTERNS` + status logic from `packages/server/src/session.js:28-118` + `_detectType` + `_updateStatus` into the adapter — **no behavior change**. Snapshot tests pin every existing PATTERN-based detection: type-detection, prompt regex, thinking/editing/tool patterns, error patterns, status badge strings. **No Codex / Gemini / Grok adapters in this sprint** — those are Sprint 45. | NEW `packages/server/src/agent-adapters/{index,claude}.js`, refactor entry-points in `packages/server/src/session.js` to consume the registry (keeping the existing PATTERNS export available for one release as a shim), NEW `tests/agent-adapter-claude.test.js` (snapshot tests) |
| **T4 — `docs/AGENT-RUNTIMES.md`** | The canonical reference. Audience: Joshua-future-self after a 3-month gap; Brad/other testers; future contributors; the Unagi SWE lead. Covers: which agents are supported (Claude in Sprint 44; Codex/Gemini/Grok added in 45), where their auth keys go, how the AGENTS.md / GEMINI.md sync works, the adapter contract spec (`matches`, `spawn`, `patterns`, `statusFor`, `parseTranscript`, `bootPromptTemplate`, `costBand`), how to add a new agent (a worked example), and the TheHarness alignment note (same contract, different transport). | NEW `docs/AGENT-RUNTIMES.md` |

## Out of scope (Sprint 45+)

- **Codex / Gemini / Grok adapter implementations** — Sprint 45 T1-T3.
- **Launcher UI refactor** (removing hardcoded `claude` / `cc` / `gemini` / `python` branches in `app.js`) — Sprint 45 T4.
- **Mixed-agent 4+1** (per-lane agent assignment in PLANNING.md frontmatter, per-agent boot prompts, inject script extension) — Sprint 46.
- **TheHarness as a TermDeck lane agent** — Sprint 47+.
- **Memory hook adapter-pluggable transcript parser** — Sprint 45 T4 (paired with the launcher refactor).
- **Cost annotations in PLANNING.md** — deferred until Joshua has felt the multi-vendor bill once.
- **`mnestra doctor` subcommand** — Brad's third upstream suggestion. Sprint 45+ candidate.

## Acceptance criteria

1. **T1:** `grok --help` works on Joshua's machine. A one-shot `grok --prompt "what is 2+2"` returns a sensible answer using the SuperGrok Heavy key. The `grok-4.20-multi-agent` model is reachable (verified by a multi-agent prompt that fans out to ≥4 sub-agents).
2. **T2:** `npm run sync:agents` from TermDeck root produces `AGENTS.md` + `GEMINI.md` with banner + identical body content to `CLAUDE.md`. Diff against `CLAUDE.md` shows only the agent-specific banner and any agent-specific lead-in. Re-running produces no diff. Tests pass.
3. **T3:** Snapshot tests for every existing PATTERN-based detection match pre-refactor behavior **exactly**. The adapter registry exports a callable `AGENT_ADAPTERS.claude` with the contract shape. `session.js::_detectType` + `_updateStatus` route through the registry without behavior change. Existing 35/35 server suite + 544 root suite stays green.
4. **T4:** `docs/AGENT-RUNTIMES.md` reads cleanly to a 3-month-future-Joshua / Brad / Unagi-SWE audience. Covers all four bullets in the lane brief.
5. **Net:** all four lanes ship in ≤ 25 minutes wall-clock. (Sprint 41 was 9 min; Sprint 42 was 12 min; Sprint 43 was 17 min. Cumulative dependencies in Sprint 44 are loose — T1 is independent of T2/T3/T4; T2/T3/T4 don't share files.)

## Pre-sprint substrate findings (orchestrator probe at sprint kickoff — re-run before injecting)

```bash
# 1. Confirm Sprint 43's bumps published (or queue them)
npm view @jhizzard/termdeck version           # expect 0.12.0
npm view @jhizzard/termdeck-stack version     # expect 0.4.7

# 2. Verify Rumen + graph-inference crons still active
set -a; source ~/.termdeck/secrets.env; set +a
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql
$PSQL "$DATABASE_URL" -At -c "SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('rumen-tick','graph-inference-tick');"
# expect: rumen-tick|*/15 * * * *|t  AND  graph-inference-tick|0 3 * * *|t

# 3. Verify TermDeck server is on v0.12.0 source
curl -s http://127.0.0.1:3000/api/pty-reaper/status | head -c 100
# expect: {"enabled":true,"tickCount":N,...}

# 4. Verify flashback_events table exists (Sprint 43 T2)
sqlite3 ~/.termdeck/termdeck.db "SELECT count(*) FROM flashback_events;"
# expect: a number (0 is fine — means no fires yet but table exists)

# 5. Verify Telegram channel is live (Sprint 43 T4)
ls ~/.claude/channels/telegram/access.json && jq -r '.policy' ~/.claude/channels/telegram/access.json
# expect: file exists; policy = "allowlist"
```

If any of these fail, flag to Joshua before injecting.

## Inject readiness

When Joshua signals "go, inject":

1. Orchestrator session (running in a `claude-tg` Telegram-listening panel) confirms 4 fresh sessions exist via `GET /api/sessions` sorted by `meta.createdAt`.
2. Orchestrator runs `node docs/sprint-44-multi-agent-foundation/scripts/inject-sprint44.js` with the four session UUIDs in `SPRINT44_SESSION_IDS` env var.
3. Two-stage submit pattern (paste-then-submit, no manual Enter) — same as Sprint 42 / 43.
4. After 8s verify: all four panels should show `status=thinking` or `status=active "Using tools"`. Any `status=active "idle"` triggers `/poke cr-flood` recovery.

## Coordination notes

- **T1 ↔ T2/T3/T4 independent** — Grok install touches Joshua's machine state, not the repo.
- **T2 ↔ T3** — both live in `packages/server/src/` adjacent areas; T3 doesn't read T2's output, T2 doesn't read T3's. Independent.
- **T3 ↔ T4** — T4 documents what T3 builds. T4 can author the doc against the lane-brief contract while T3 is still implementing; final-pass prose verification at sprint close.
- **T2 emits `AGENTS.md` + `GEMINI.md` to repo root.** Make sure the sync script doesn't accidentally overwrite any existing file at those paths (currently neither exists).

## Joshua's roadmap context (2026-04-30 evening)

Sprint 44 is **the first lane of the multi-agent trilogy**. After it lands:
- Sprint 45 ships the actual Codex / Gemini / Grok adapters (using Sprint 44's registry skeleton)
- Sprint 46 ships mixed-agent 4+1 (per-lane agent assignment, per-agent boot prompts)
- Sprint 47+ candidates: TheHarness as a TermDeck lane agent (BHHT-economy unlock); cross-Mnestra federation; graph-aware recall in Flashback path

Sprint 44 is **inject-ready** — when Joshua opens 4 fresh sessions and signals "go, inject", the orchestrator fires.
