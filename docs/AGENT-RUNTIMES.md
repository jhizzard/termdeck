# Agent Runtimes

The canonical reference for TermDeck's multi-agent capability — what agents are supported, where their auth keys go, how the cross-CLI instructional files stay in sync, and how to add a new agent.

If you came here because you want to run a lane on Codex / Gemini / Grok instead of Claude Code, this is the right doc. If you came here because you want to *add* a new agent, skip to § 6.

> **First-time orientation:** the design rationale that motivated this whole capability — capacity safety valve, audit-quality lever, the SuperGrok Heavy correction, the 3-sprint trilogy — lives in `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`. Read that *only* if you need the *why*. This doc is the *how*.

---

## 1. Overview

TermDeck spawns CLI agents in PTY-backed panels. Until Sprint 44 the assumption was implicit: every panel was Claude Code. The multi-agent capability lifts that assumption.

You reach for multi-agent for two reasons:

- **Capacity safety valve.** Claude Max 20x has a ceiling. Routing exploratory or scaffolding lanes to Gemini / Codex / Grok offloads from the metered tier without changing the orchestration pattern. Joshua hit the ceiling during Sprint 42 close-out despite disciplined token economy — multi-agent is the structural fix.
- **Audit-quality lever.** A T2 lane brief that specifies `agent: codex` audits T1's Claude output without Claude's framing pollution. Independent agents on parallel lanes is a different quality signal from one agent reviewing its own work.

The 4-agent landscape is **Claude / Codex / Gemini / Grok**. Each has its own CLI binary, its own instructional file convention, and its own cost band:

| Cost band | Meaning | Examples |
|---|---|---|
| `subscription` | Flat-rate plan, no per-token meter applies to TermDeck usage | Claude Code (on Claude Max), Grok CLI (on SuperGrok Heavy) |
| `pay-per-token` | Metered API key | Codex (OpenAI), Gemini (Google AI Studio), Claude API |
| `free` | Reserved for local-only / open-weights agents | (none in the supported set yet) |

Cost bands surface in PLANNING.md lane assignments starting Sprint 46 so the orchestrator can show estimated cost per sprint up-front.

---

## 2. Supported agents (Sprint 44 state)

| Agent | CLI binary | Instructional file | Sprint shipped | Cost band |
|---|---|---|---|---|
| Claude Code | `claude` | `CLAUDE.md` | Pre-existing (adapter migrated in Sprint 44 T3) | `subscription` (Max plan) / `pay-per-token` (API key) |
| Codex CLI | `codex` | `AGENTS.md` | Sprint 45 T1 | `pay-per-token` |
| Gemini CLI | `gemini` | `GEMINI.md` | Sprint 45 T2 | `pay-per-token` |
| Grok CLI | `grok` | `AGENTS.md` | Install Sprint 44 T1 / adapter Sprint 45 T3 | `subscription` (SuperGrok Heavy) |

**Sprint 44 ships only the Claude adapter** (lifted from the existing `PATTERNS` map at `packages/server/src/session.js:28-118` with snapshot-test parity). Codex / Gemini / Grok adapters land in Sprint 45 T1–T3. Mixed-agent 4+1 (per-lane agent assignment, per-agent boot prompts) lands in Sprint 46.

A note on the `AGENTS.md` collision: Codex and Grok both read the same filename. The sync mechanism (§ 4) generates one `AGENTS.md` from the canonical `CLAUDE.md`. If divergence emerges later, the fallback is per-agent paths (`.codex/AGENTS.md` vs `.grok/AGENTS.md`); not a problem to solve until you hit it.

**Grok install caveat:** the upstream `grok-cli` installer at `https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh` whitelists `darwin-arm64`, `linux-x64`, and `windows-x64` only — Intel Macs (`darwin-x64`) are not in the published binary set. On Intel Macs the documented path is a Bun source-build from the repo, with the community fork `@kazuki-ookura/grok-cli` as a fallback. See `docs/sprint-44-multi-agent-foundation/STATUS.md` § T1 and (when authored) `docs/sprint-44-multi-agent-foundation/T1-grok-install.md` for the host-specific runbook.

---

## 3. Where auth keys go

| Agent | Auth surface | Where it lives |
|---|---|---|
| Claude Code | `claude login` (subscription) or `ANTHROPIC_API_KEY` (pay-per-token) | OS keychain via `claude login`, or `~/.termdeck/secrets.env` for the env-var path |
| Codex CLI | `OPENAI_API_KEY` (or codex's own `codex login` flow) | `~/.termdeck/secrets.env`. The `codex@openai-codex` Claude Code plugin already uses this for delegate-from-Claude flows. |
| Gemini CLI | `GEMINI_API_KEY` | `~/.termdeck/secrets.env` |
| Grok CLI | SuperGrok Heavy carries the API key automatically — no separate config required. Fallback `GROK_API_KEY` / `XAI_API_KEY` for non-Heavy users. | `~/.grok/install.json` (Heavy) or `~/.termdeck/secrets.env` (fallback) |

`~/.termdeck/secrets.env` is sourced by the orchestrator and by smoke-test scripts; CLIs spawned in panels inherit the env from the TermDeck server process. Don't commit it. (`set -a; source ~/.termdeck/secrets.env; set +a` is the canonical load idiom across the project's runbooks.)

---

## 4. How `AGENTS.md` / `GEMINI.md` sync works

`CLAUDE.md` (project root) is the **canonical** source. `AGENTS.md` (Codex + Grok) and `GEMINI.md` (Gemini) are **generated mirrors**. They're committed to the repo so that contributors landing on GitHub from the Codex / Grok / Gemini ecosystems see the right file at the right path without needing to know about the sync mechanism.

The script lives at `scripts/sync-agent-instructions.js`. The npm entry point is:

```bash
npm run sync:agents
```

Each generated mirror gets an auto-banner at the top:

```markdown
<!-- AUTO-GENERATED from CLAUDE.md by sync-agent-instructions.js. Do not edit directly. -->
```

The script is idempotent — re-running on already-synced files produces no diff. Edit `CLAUDE.md`, run `npm run sync:agents`, commit all three. If you edit `AGENTS.md` or `GEMINI.md` directly your changes are lost on the next sync.

`prepare-release.sh` invokes `npm run sync:agents` so a fresh release never ships stale mirrors. Sprint 44 T2 picked **commit-the-mirrors** over .gitignore for external visibility — if that decision changes later, the script flips one flag.

---

## 5. The adapter contract

Each agent ships a single module at `packages/server/src/agent-adapters/<name>.js` that implements a 10-field contract (Sprint 47 T3 added `acceptsPaste`; Sprint 48 T1 added `mcpConfig`; Sprint 50 T1 added `resolveTranscriptPath`):

```js
{
  matches: (cmd) => boolean,                   // does this cmd string indicate this adapter?
  spawn: { binary, defaultArgs, env },          // PTY spawn config
  patterns: { prompt, thinking, editing, tool, error }, // for the output analyzer
  statusFor: (state) => { status, statusDetail },       // status-badge generator
  parseTranscript: (raw) => Memory[],          // for the session-end memory hook
  resolveTranscriptPath: async (session) => string | null, // Sprint 50 T1 — locate the on-disk transcript for an exited panel
  bootPromptTemplate: (lane, sprint) => string, // 4+1 inject prompt
  costBand: 'free' | 'pay-per-token' | 'subscription',  // for Sprint 46 cost annotations
  acceptsPaste: boolean,                        // Sprint 47 T3 — bracketed-paste capable
  mcpConfig: { path, format, ... } | null,      // Sprint 48 T1 — per-agent MCP auto-wire
}
```

| Field | Type | What it does | Example (Claude) |
|---|---|---|---|
| `matches` | `(cmd: string) => boolean` | Routes a launched command string to the right adapter. The launcher UI calls each adapter's `matches` in registry order; the first true wins. | `cmd => /^claude(\s|$)/.test(cmd) \|\| /^cc(\s|$)/.test(cmd)` |
| `spawn` | `{ binary: string, defaultArgs: string[], env: object }` | Provided to `node-pty.spawn`. `env` is merged on top of `process.env` and TermDeck's `TERMDECK_SESSION_ID` / `TERMDECK_PROJECT` injections. | `{ binary: 'claude', defaultArgs: [], env: {} }` |
| `patterns` | `{ prompt: RegExp, thinking: RegExp, editing: RegExp, tool: RegExp, error?: RegExp }` | Lifted from the existing `PATTERNS.claudeCode` map. The output analyzer reads these to detect what the agent is doing. | `{ prompt: /^[>❯]\s/m, thinking: /\b(thinking\|Thinking)\b/, … }` |
| `statusFor` | `(state) => { status, statusDetail }` | Replaces the hard-coded `switch(meta.type)` blocks in `_updateStatus`. `state` is the analyzer's `{ matchedKey, captureGroups }` payload. | `state => state.matchedKey === 'thinking' ? { status: 'thinking', statusDetail: 'Claude is reasoning...' } : …` |
| `parseTranscript` | `(raw: string) => Memory[]` | The session-end memory hook calls this to lift the agent's transcript format into Mnestra-shaped `Memory[]`. Claude's format is JSONL `{ message: { role, content } }`; Codex/Gemini/Grok formats are agent-specific. | Reads JSONL, normalizes `{ role, content }` pairs into `Memory{ project, sessionId, content, … }`. |
| `resolveTranscriptPath` | `async (session) => string \| null` | Sprint 50 T1. Locates the chat-shape transcript for a session that just closed, given `session.id`, `session.meta.cwd`, and `session.meta.createdAt`. The server-side `onPanelClose` consumer calls this and feeds the result to the bundled `~/.claude/hooks/memory-session-end.js` so non-Claude agents (Codex / Gemini / Grok) write `session_summary` rows the same way Claude Code already does. Returns `null` when no transcript exists or the dependency can't load (e.g. Grok needs `better-sqlite3` available in the server's tree, which is the case in production but is the no-op fallback for safety). Claude implements this for contract uniformity, but `onPanelClose` skips claude-typed sessions to avoid double-writes — Claude's own SessionEnd hook handles its rows. | **Claude:** lists `~/.claude/projects/<dir-hash>/`, picks newest `.jsonl` whose mtime is at-or-after `session.meta.createdAt`. **Codex:** walks today's + yesterday's `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, parses each first line, returns the rollout where `session_meta.payload.cwd === session.meta.cwd`. **Gemini:** picks newest `~/.gemini/tmp/<basename(cwd)>/chats/session-*.json`. **Grok:** opens `~/.grok/grok.db` via `better-sqlite3`, finds the workspace by `canonical_path`, picks the most recent session, materializes its `messages.message_json` rows as a JSON-array envelope to `os.tmpdir()/termdeck-grok-<id>.json`, and returns that tempfile path (the bundled hook can't reach `better-sqlite3` from `~/.claude/hooks/`). |
| `bootPromptTemplate` | `(lane, sprint) => string` | Generates the multi-line bracketed-paste body for 4+1 inject. Sprint 46's inject script reads `lane.agent` and dispatches to the right adapter's template. | Emits the 6-step boot sequence (`memory_recall`, read CLAUDE.md, etc.) the orchestrator currently writes by hand. |
| `costBand` | `'free' \| 'pay-per-token' \| 'subscription'` | Surfaces in PLANNING.md cost annotations starting Sprint 46. | `'subscription'` for Claude Max, `'pay-per-token'` for the API path. |
| `acceptsPaste` | `boolean` | Whether the agent's CLI accepts bracketed-paste cleanly in its input box. `true` lets the 4+1 inject helper use the two-stage submit pattern; `false` triggers chunked-stdin fallback in `sprint-inject.js`. Sprint 47 T3 addition. | `true` for Claude Code, Codex, Gemini, Grok (all four supported agents). |
| `mcpConfig` | `{ path, format, mnestraBlock, detectExisting } \| { path, format, mcpServersKey, mnestraBlock } \| { path, format, merge } \| null` | Per-agent MCP auto-wire descriptor consumed by `packages/server/src/mcp-autowire.js`. The shared helper ensures a Mnestra MCP block is present in the agent's config file on panel spawn — out-of-the-box `memory_recall` for non-Claude agents. Three shapes supported (precedence top → bottom): the **escape-hatch** (adapter owns the entire merge via a `merge(rawText, {secrets}) => {changed, output}` function — needed for non-record schemas like Grok's array shape), the **JSON-record-merge** shape (adapter declares `mcpServersKey` and returns the value to merge under it as an object), and the **TOML-append / JSON-append** shape (adapter returns the rendered block as a string + supplies `detectExisting` for idempotency). `null` means the agent's MCP config is user-managed and the helper short-circuits to `{ skipped: 'no-mcpConfig' }` — Claude only. Sprint 48 T1 addition. | `null` for Claude (user-managed via `claude mcp add`); TOML-append shape for Codex; JSON-record shape for Gemini; merge escape-hatch shape for Grok. |

The registry export at `packages/server/src/agent-adapters/index.js` is a flat map:

```js
const claude = require('./claude');
// const codex = require('./codex');   // Sprint 45 T1
// const gemini = require('./gemini');  // Sprint 45 T2
// const grok = require('./grok');      // Sprint 45 T3

module.exports.AGENT_ADAPTERS = {
  claude,
  // codex, gemini, grok — added in Sprint 45
};
```

Sprint 44 ships the registry shape with **only Claude registered**. `session.js::_detectType` and `_updateStatus` route through the registry; the existing `PATTERNS` export stays available as a one-release shim so external imports don't break.

---

## 6. How to add a new agent (worked example: Codex)

This is the recipe Sprint 45 T1 follows. It also doubles as the recipe for any future agent (a hypothetical `Llama CLI`, an internal Anthropic preview build, a custom open-weights wrapper).

**Step 1 — Read the CLI's documentation.** Find:

- Binary name and PATH (`which codex` → `/usr/local/bin/codex`).
- Prompt regex (what does the input prompt look like in the terminal?).
- Status keywords (does it print `Thinking…`? `Working…`? `Generating…`?).
- Editing / tool-use markers (Codex prefixes? bullet shapes? command tags?).
- Transcript file format (Codex is suspected JSONL at `~/.codex/sessions/*.jsonl`; verify before relying on it).
- Auth surface (`OPENAI_API_KEY` env? interactive `codex login`?).
- Instructional file (Codex reads `AGENTS.md`).
- Cost model (`pay-per-token`).

**Step 2 — Implement the 7-field contract.** New file `packages/server/src/agent-adapters/codex.js`:

```js
// packages/server/src/agent-adapters/codex.js
module.exports = {
  matches: (cmd) => /^codex(\s|$)/.test(cmd),
  spawn: {
    binary: 'codex',
    defaultArgs: [],
    env: {}, // CODEX_COMPANION_SESSION_ID is injected by index.js, not here
  },
  patterns: {
    prompt: /^codex>\s/m,
    thinking: /\b(Thinking|Working)\b/,
    editing: /^(Edit|Create|Update|Delete)\s/m,
    tool: /^→\s/m, // verify against real codex output
    error: /(?:^|\n)\s*(?:Error:|error:)/m,
  },
  statusFor: (state) => {
    if (state.matchedKey === 'thinking') {
      return { status: 'thinking', statusDetail: 'Codex is reasoning...' };
    }
    if (state.matchedKey === 'editing') {
      return { status: 'editing', statusDetail: state.captureGroups?.[0] ?? 'Editing files' };
    }
    if (state.matchedKey === 'tool') {
      return { status: 'active', statusDetail: 'Using tools' };
    }
    return { status: 'idle', statusDetail: 'Waiting for input' };
  },
  parseTranscript: (raw) => {
    // Read ~/.codex/sessions/*.jsonl format; normalize to Memory[]
    // …
    return [];
  },
  bootPromptTemplate: (lane, sprint) => [
    `You are T${lane.n} in Sprint ${sprint.n} (${sprint.name}). Boot sequence:`,
    `1. memory_recall(project="${sprint.project}", query="${lane.topic}")`,
    `2. memory_recall(query="recent decisions and bugs")`,
    `3. Read ~/.claude/CLAUDE.md and ./AGENTS.md`,
    `4. Read ${sprint.docPath}/PLANNING.md`,
    `5. Read ${sprint.docPath}/STATUS.md`,
    `6. Read ${sprint.docPath}/${lane.briefing}`,
    ``,
    `Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md.`,
  ].join('\n'),
  costBand: 'pay-per-token',
};
```

**Step 3 — Register the adapter.** Edit `packages/server/src/agent-adapters/index.js`:

```js
const codex = require('./codex');

module.exports.AGENT_ADAPTERS = {
  claude,
  codex, // ← new
};
```

**Step 4 — Write snapshot tests.** New file `tests/agent-adapter-codex.test.js`. Lock down each `patterns` regex against a real captured Codex session log. Lock down `statusFor` for each `matchedKey` branch. The bar Sprint 44 T3 set: every existing PATTERN-based detection has a matching snapshot test. New adapters meet that bar.

**Step 5 — Update the docs.** Move the agent's row in this doc's § 2 table from a future sprint to the current one. Update CHANGELOG. Update the `AGENT_ADAPTERS` skeleton example in § 5 to uncomment the `require`.

**Step 6 — Smoke test.** Open a TermDeck panel, type the agent's launch command, confirm the status badge cycles through the right states (thinking / editing / idle) and the session-end hook produces a Mnestra-shaped transcript.

That's the full recipe. ~150–250 LOC per adapter plus tests. Less than a single 4+1 lane of work.

---

## 7. TheHarness alignment

[TheHarness](file:///Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/) is the parallel multi-LLM orchestrator Joshua's building — same agents, different transport. TermDeck spawns CLIs in PTYs; TheHarness opens browser tabs (Claude.ai, ChatGPT, Gemini, Grok) and drives them via Playwright. The thesis: rent reasoning at flat-rate chat prices, own the orchestration and the memory.

The adapter contract in § 5 is **deliberately portable to TheHarness's browser-based world**. Specifically:

- `matches` stays as-is — it routes a lane's `agent` field to an adapter regardless of transport.
- `spawn` becomes "open a Playwright tab with this URL" instead of "spawn a PTY". The shape (`{ binary, defaultArgs, env }`) becomes (`{ url, defaultParams, sessionConfig }`) but the role is identical.
- `patterns` adapts to DOM selectors instead of stdout regexes — same conceptual job (detect "thinking", "editing", "tool use" states from the rendered surface).
- `statusFor`, `parseTranscript`, `bootPromptTemplate`, `costBand` carry over **unchanged**.

This is why the contract started at 7 fields and grew to 9 deliberately — each one earns its place by surviving the transport-swap test. `acceptsPaste` (Sprint 47 T3) and `mcpConfig` (Sprint 48 T1) both extend cleanly to TheHarness: `acceptsPaste` becomes "DOM input element accepts a synthetic paste event"; `mcpConfig` is irrelevant because browser-tab agents inherit MCP config from the chat product, not from a local file (so `mcpConfig: null` is the correct value for every harness/* adapter). When TheHarness's Phase 1 begins (post-BHHT per `WHY.md`), Sprint 47+ can lift the contract verbatim and add a `harness/claude-pro` adapter alongside the existing `claude` adapter — same registry, different transport, no abstraction fork.

---

## 8. Sprint sequencing

Multi-agent ships across three sprints. Each one stands alone and ships independently usable.

| Sprint | Scope | Target version |
|---|---|---|
| **Sprint 44 (Foundation)** | Grok install + AGENTS.md sync mechanism + adapter registry skeleton + this doc. Claude adapter migrated with snapshot-test parity. **No Codex / Gemini / Grok adapters yet.** | `termdeck@0.13.0` + `termdeck-stack@0.4.8` |
| **Sprint 45 (Adapters)** | Codex + Gemini + Grok adapter implementations. Launcher UI refactor (removes hardcoded `claude` / `cc` / `gemini` / `python` branches in `app.js`). Memory hook adapter-pluggable transcript parser. | `termdeck@0.14.0` (estimated) |
| **Sprint 46 (Mixed 4+1)** | Per-lane `agent:` field in PLANNING.md. Per-agent boot-prompt templates. Inject script reads `lane.agent` and dispatches. Cross-agent STATUS.md merger. | `termdeck@0.15.0` — or `1.0.0` if Joshua deems multi-agent + cron + observability "production-ready for outside users." |
| **Sprint 47+** | TheHarness as a TermDeck lane agent (`agent: harness/claude-pro`). Cross-Mnestra federation. Graph-aware recall in Flashback. | TBD |

The order matters: Sprint 45 needs Sprint 44's registry; Sprint 46 needs Sprint 45's adapters. Sprint 43 (graph controls + flashback persistence) is **independent** of this trilogy and could ship before, after, or in parallel — see the memorialization doc § 11 for sequencing options.

---

## 9. Cross-references

- **Design rationale (the *why*):** [`docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md`](./multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md). Read this if you need to understand why the contract has these 7 fields and not others, or what the SuperGrok Heavy correction was.
- **Compact plan file:** `~/.claude/plans/that-should-do-it-flickering-rain.md`. Decision-focused; what got chosen and why.
- **Sprint 44 plan:** [`docs/sprint-44-multi-agent-foundation/PLANNING.md`](./sprint-44-multi-agent-foundation/PLANNING.md).
- **Sprint 45 plan:** `docs/sprint-45-multi-agent-adapters/PLANNING.md` (when authored).
- **Sprint 46 plan:** `docs/sprint-46-mixed-4plus1/PLANNING.md` (when authored).
- **Adapter source:** `packages/server/src/agent-adapters/`.
- **Sync script:** `scripts/sync-agent-instructions.js`.
- **Existing PATTERNS map (pre-adapter shim):** `packages/server/src/session.js:28-118`.
- **Orchestrator Guide (4+1 inject pattern, two-stage submit):** [`docs/orchestrator-guide.md`](./orchestrator-guide.md).
- **TheHarness vision (parallel track):** `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TheHarness/VISION.md` + `WHY.md`.

---

*Last updated: Sprint 44 (2026-04-30). Codex / Gemini / Grok rows in § 2 graduate from "Sprint 45" to "shipped" as those adapters land.*
