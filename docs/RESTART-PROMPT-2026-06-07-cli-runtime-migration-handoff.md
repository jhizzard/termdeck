# RESTART-PROMPT — 2026-06-07 — CLI-runtime migration sprint (8-panel handoff)

**Why this handoff exists:** the prior orchestrator session (`8b808d39`) settled all
credentials and fully scoped the CLI-runtime migration, but reached ~57% context. An
8-panel, two-deck sprint (author ~10 docs → inject 8 → continuously poll STATUS +
buffers across 8 panels → steer → close out) would force mid-sprint compaction, which
craters orchestration quality. A **fresh orchestrator session executes** with full budget.

## Boot sequence (fresh orchestrator, cold start)
1. `memory_recall(project="termdeck", query="CLI-runtime migration sprint handoff panel mapping 2026-06-07")`
2. `memory_recall(project="termdeck", query="recent decisions credentials Gemini Antigravity Grok Build")`
3. `memory_recall(query="residue masquerades as loss MCP server removed verify with evidence")`
4. Read `~/.claude/CLAUDE.md`, then `./CLAUDE.md` (TermDeck read-order).
5. Read THIS doc fully. Then begin.

## State as of handoff (all VERIFIED this session)

### Credentials — SETTLED for working purposes (rotation deferred to project-end)
- All secrets in ONE place: `~/.termdeck/secrets.env` (mode 600) — `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`,
  `GROK_API_KEY`, `GEMINI_API_KEY`.
- `~/.gemini/settings.json` + `~/.claude.json` mnestra MCP blocks **de-secreted** (`env {}`);
  mnestra reads the `secrets.env` fallback (`dist/mcp-server/index.js:57-60`) — verified
  working (7,306 memories, growing).
- Retired PVB rag-system `memory` server removed; stale `mcp__memory__*` allowlist entries
  stripped from `~/.claude/settings.local.json` (4) and `~/.claude/.claude/settings.local.json` (2).
  **Photoshop-skill permissions fully preserved.** (Adding `mcp__mnestra__*` pre-approvals was
  auto-denied as self-permission-widening — Josh can add them; not required.)
- Gemini CLI flipped to **API-key auth** (`security.auth.selectedType: "gemini-api-key"`) and
  validated live (probe returned `AUTHOK`). Antigravity stays on OAuth → **auth-segregation is LIVE**.
- **AT PROJECT-END (Josh's call):** rotate the `sb_secret_…` service-role key + the OpenAI key,
  edit `secrets.env` by hand (do NOT paste keys into chat), update any Rumen Edge Function secret,
  then delete the `*.bak-2026-06-07` files (`~/.gemini/settings.json.bak*`, `~/.claude.json.bak-2026-06-07`,
  both `settings.local.json.bak-2026-06-07`) — they hold the old cleartext keys. Then a quick verify test.

### CLI reality (verified — do not trust training/web over this)
- **Gemini CLI** OAuth/subscription serving ENDS **June 18 2026**; the binary survives via a
  **paid (billing-enabled) API key** — done. Replacement IDE-CLI `agy` (Antigravity) v1.0.0 installed.
- **Grok = Grok Build 0.2.33** (auto-updated from 0.1.216), authed via **grok.com login** (NOT the
  `GROK_API_KEY`, which is a separate api.x.ai key). `grok models` exposes **only** `grok-build`
  (default, coding, **rejects** reasoningEffort → HTTP 400) and `grok-composer-2.5-fast`. **No grok-4.x.**
  So a "reasoning-Grok auditor" is NOT achievable via Grok Build → use **Codex as the deep-reasoning
  auditor** + Grok Build as-is (`-p`/`--single`, `-m`, `--check`, `--output-format json`).

## The sprint(s)

### Deck A (:3000) — CLI-runtime migration 3+1+1
- **T1 (Claude):** Antigravity `agy` adapter — transcript via **in-flight stdout capture**
  (`unbuffer`/`stdbuf -oL`, not the dead JSONL/protobuf path); binary/prompt-regex/displayName/
  sessionType; boot-prompt resolver reads `AGENTS.md`; mcp_config `~/.gemini/antigravity-cli/mcp_config.json`.
- **T2 (Claude):** Gemini hardening — fix `packages/server/src/agent-adapters/gemini.js:130`
  `parseTranscript` (single `JSON.parse` on what is actually JSONL — already broken); wire/doc the
  API-key auth + a `doctor` probe.
- **T3 (Claude):** Mnestra `source_agent` enum extend `gemini`→`+agy/antigravity` (+ session-end hook
  allowlist so `agy` panels aren't normalized to `claude`); **rewrite `grok-models.js` to the Grok-Build
  namespace** (`grok-build`, `grok-composer-2.5-fast` — NOT grok-4.x; old file reverted to stale baseline,
  sprint owns it); `doctor` probes.
- **T4 (Codex):** adversarial auditor (INVERSION-QA, default-to-FAIL).

### Deck B (:3001) — Mnestra `privacy_tags` PR (ENGRAM repo `~/Documents/Graciella/engram` — different repo, zero collision)
Per Brad's 2026-05-18 proposal (in Gmail `admin@nashvillechopin.org`, 2 attachments
`PR-DESCRIPTION.md` + `023_privacy_tags_column.sql`): migration 023 (`privacy_tags text[]` + GIN index),
`src/recall.ts` `include_privacy[]` filter implemented at the recall layer (NOT in `memory_hybrid_search`
— keep the 8-arg RPC stable), MCP tool schema field, CHANGELOG, 1-2 tests. Unblocks Brad's `pka` project.
T4 Codex audit. (Open Q from Brad: also extend `memory_hybrid_search` RETURNS TABLE with privacy_tags — he recommends yes.)

## Panel mapping — RE-QUERY (IDs change if TermDeck restarts)
- `GET /api/sessions` on **:3000 AND :3001**. The API returns only `{id, meta, pid}` — **no agent
  type / no screen text** for idle-at-empty-input panels (Brad's §1.1 gap). **Do NOT try to detect
  the agent.** Map **T1–T4 by `meta.createdAt` order; T4 (last-created) = Codex auditor.**
- Current IDs (reference only; agents already running at empty input as of handoff):
  - Deck A :3000 — T1 `f708c49c`, T2 `19d8ab98`, T3 `4ddd94b8`, **T4 (Codex) `13edf41a`**
  - Deck B :3001 — **T4 (Codex) `1531c575`** (T1/T2/T3 = first three by createdAt)

## Inject (per `~/.claude/CLAUDE.md` § two-stage submit — MANDATORY)
- Author `docs/sprint-68-cli-runtime-migration/` (PLANNING.md, STATUS.md, T1–T4 briefs) + the Deck B
  sprint docs FIRST (lanes read them on boot).
- Then per panel: POST `/api/sessions/:id/input` `\x1b[200~<text>\x1b[201~` (paste, NO `\r`) → settle
  ~400ms → POST `\r` alone (submit). `/poke` `cr-flood` fallback if a panel stays idle after ~8s.
- Codex (T4) quirks: single-line/sidecar prompts, `TERM=xterm-256color`, cr-flood routine.

## Deferred / follow-ups
- **Sprint 67 → 1.6.2 close-out** (GREEN, uncommitted ~12 days in the working tree): read
  `docs/RELEASE.md` first, bump + CHANGELOG, **Josh does the Passkey `npm publish`** (never `--otp`),
  npm-before-push, then push/tag. Keep `grok-models.js` OUT of this commit (the sprint owns it).
- **Post-sprint GATE (Josh's priority):** the **4-CLI 360 verification** — open Claude + Codex +
  Antigravity + Grok Build panels and confirm all four work as TermDeck lanes/auditors (the
  360-review benefit Josh values). The migration is what makes Antigravity + Grok Build work as panels.

## Resume the PRIOR session (its accumulated mental model)
```
cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck && claude --resume 8b808d39-8e80-463c-a2cd-59883a9e1018
```

---

## 4-CLI 360 verification — EXECUTED 2026-06-08 (live, API-spawned panels)

The "post-sprint GATE" above was run. A fresh orchestrator brought up the TermDeck server (`secrets.env` sourced) and spawned Claude + Codex + Antigravity(`agy`) + Grok-Build via `POST /api/sessions`, then ran a per-CLI MCP-read smoke + a 4-provider demo.

**Result — all 4 run as panels at max-quality modes; MCP-read LIVE for 3 of 4:**
- **Claude** — `max/effort`; `memory_recall` → 40 results live. ✅
- **Codex** — `gpt-5.5 xhigh fast`; `memory_recall` → 40 results live. ✅
- **Grok-Build** — high-effort; discovered + called `mnestra__memory_recall` → 38 results live. ✅ (grok turns are SLOW — ~7 min at high effort.)
- **Antigravity (`agy`)** — signed in (Gemini 3.5 Flash), responds well; **MCP-read DEFERRED** (finding 1). Capture works (S70 byte-floor exempt).

**4-provider demo** (same task → 4 independent risk takes, 3 memory-grounded): Claude→silent-degradation/false-green in the auditor seat; Codex→runtime-drift (auth lifecycles / fs expectations / prompt semantics) needs lane health probes; agy→filesystem race conditions / no coordinated locking; Grok→[recalled 38, slow]. The diversity is the out-of-distribution value.

**Capture:** test-proven (S70/62/50 fence tests in the green `npm test` glob); all 4 fired `session_ended` on close. Live recall of just-captured summaries didn't surface in the real-time window (async summarize+embed lag + summary abstraction) — belt-and-suspenders over the green tests.

### Findings
1. **agy MCP-read is language-server-mediated, NOT file-config.** Antigravity's MCP is driven by its embedded exa language-server (`RefreshMcpServers`/`GetMcpServerStates` RPCs, `gemini.GeminiMCPServerConfig`). Ruled out live: de-secreted mnestra blocks at `~/.gemini/config/mcp_config.json` AND appDataDir `~/.gemini/antigravity-cli/mcp_config.json` both → `NO-MNESTRA-TOOL`; `~/.gemini/settings.json` has mnestra yet agy ignores it; no `agy mcp` subcommand; `agy plugin list` empty. **Fix landed:** `agy.js` `mcpConfig` → `null` (auto-wire cleanly skips, Claude-style) + finding documented in the adapter header. Real wiring is a follow-up via the Antigravity language-server registration mechanism. Was always a "non-load-bearing nicety" per S70.
2. **SECURITY — codex + grok configs inline the service-role + OpenAI keys (+ internal project ref) in cleartext.** `~/.codex/config.toml` + `~/.grok/user-settings.json` carry them raw; Claude + Gemini were de-secreted (`env:{}` + `secrets.env` fallback) on 2026-06-07 but codex + grok were missed — the two that were missed carry the most dangerous secret. Recommend de-secreting both. (Local files; flagged, not touched mid-run.)
3. **grok launch ergonomics:** bare `grok` types correctly as a `grok` panel; a multi-word command (`grok -c`) gets `/bin/zsh -c …`-wrapped → mistypes as `shell`. Bare grok shows a worktree/session menu, but typing a prompt directly bypasses it into a chat (no worktree created).
4. **Pre-existing test gap:** `tests/agent-adapter-parity.test.js` fails 2 on S72's `web-chat-grok` (no `spawn` block — by design); that root-level `tests/` dir is NOT in the `npm test` glob, so it went unnoticed. Not a regression; needs a web-chat parity exemption + the root `tests/` folded into a test lane.
