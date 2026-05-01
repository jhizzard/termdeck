# Sprint 45 — T3: Grok adapter implementation

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Implement the Grok adapter using the SuperGrok Heavy install verified end-to-end on 2026-05-01. **Default to TUI mode** (conversation persists naturally in the PTY process). **Implement the `chooseModel(taskHint)` heuristic** so the orchestrator picks the right model from Grok's 11-model lineup — preventing $2/$6 per-1M-token Heavy spending on routine tasks that fit cheap-fast at $0.2/$0.5.

> **Required reading before lane work:** `docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md` — captures the empirical findings on Grok session persistence + the model-selection heuristic table + 5 lane-time open questions. Don't re-research what Sprint 44 close already discovered.

## The contract

```js
{
  name: 'grok',
  sessionType: 'grok',
  matches: (cmd) => /^grok\b/.test(cmd),
  spawn: {
    binary: 'grok',
    defaultArgs: [],   // TUI mode — conversation persists in the PTY
    env: {
      GROK_API_KEY: process.env.GROK_API_KEY,
      GROK_MODEL: chooseModel(taskHint),    // see grok-models.js below
    },
  },
  patterns: {
    prompt: /* observe Grok's TUI prompt — runs on Bun + OpenTUI, may differ from Claude */,
    thinking: /* observe */,
    tool: /* observe — Grok's sub-agent invocation markers (▸ bash:, ▸ read:, etc. seen in Joshua's smoke test) */,
    error: /* observe */,
  },
  patternNames: { error: 'grok-error', tool: 'grok-tool' },
  statusFor: (state) => { status: '...', statusDetail: 'Grok is reasoning...' },
  parseTranscript: (raw) => Memory[],   // ~/.grok/sessions/ — format lane-time discovery
  bootPromptTemplate: (lane, sprint) => `You are ${lane.tag} in ${sprint.name}. Read AGENTS.md ...`,
  costBand: 'subscription',  // SuperGrok Heavy carries the rate limits
}
```

## NEW `packages/server/src/agent-adapters/grok-models.js`

The `chooseModel` heuristic + 11-tier model map. See `docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md` § "Concern 2: Model selection heuristic" for the full table. Skeleton:

```js
const MODELS = {
  'fast-non-reasoning': 'grok-4-1-fast-non-reasoning',  // $0.2/$0.5 — DEFAULT
  'fast-reasoning':     'grok-4-1-fast-reasoning',      // $0.2/$0.5
  'code':               'grok-code-fast-1',             // $0.2/$1.5
  'reasoning-deep':     'grok-4.20-0309-reasoning',     // $2/$6 (Heavy)
  'reasoning-non-cot':  'grok-4.20-0309-non-reasoning', // $2/$6
  'multi-agent':        'grok-4.20-multi-agent-0309',   // $2/$6 (parallel sub-agents)
  'flagship':           'grok-4-0709',                  // $3/$15
};

function chooseModel(taskHint) {
  switch (taskHint) {
    case 'code':            return MODELS.code;
    case 'multi-agent':     return MODELS['multi-agent'];
    case 'reasoning-deep':  return MODELS['reasoning-deep'];
    case 'reasoning-quick': return MODELS['fast-reasoning'];
    case 'flagship':        return MODELS.flagship;
    default:                return MODELS['fast-non-reasoning'];
  }
}

module.exports = { MODELS, chooseModel };
```

## Files
- NEW `packages/server/src/agent-adapters/grok.js` (~120-180 LOC)
- NEW `packages/server/src/agent-adapters/grok-models.js` (~40 LOC)
- `packages/server/src/agent-adapters/index.js` (register `grok`)
- NEW `tests/agent-adapter-grok.test.js`
- NEW `tests/grok-models.test.js` (test the `chooseModel` heuristic)
- `packages/stack-installer/assets/hooks/memory-session-end.js` (extend parser dispatch for Grok)

## Lane-time discovery checklist (from SPRINT-45-PREP-NOTES.md § "Open questions")

- [ ] **Where does Grok persist sessions on disk?** Likely `~/.grok/sessions/<session-id>/...`. Run `grok` in TUI, do a few prompts, then `ls -la ~/.grok/sessions/`.
- [ ] **Grok session file format** — JSON, JSONL, plain text? Affects `parseTranscript` design.
- [ ] **Does Grok's TUI accept bracketed-paste correctly?** Joshua's two-stage submit pattern is mandatory for Claude panels; Grok runs on Bun + OpenTUI which is a different reader. **Lane-time test:** paste a 200-line prompt into a Grok TUI panel via the `/api/sessions/:id/input` endpoint and confirm it lands intact.
- [ ] **Grok's tool-use event format** — Joshua's smoke test showed `▸ bash:` markers. Map these to the `patterns.tool` regex. There may be `▸ read:`, `▸ write:`, `▸ web-search:`, `▸ vision:`, etc. for the 5 built-in sub-agents.
- [ ] **Does `--session latest` survive across orchestrator restarts?** If sessions persist on disk, yes. Test: open a Grok session, send a prompt, kill the orchestrator, restart, run `grok --session latest --prompt "do you remember our last conversation"`.

## Acceptance criteria

1. `AGENT_ADAPTERS.grok` exposes the full contract shape.
2. `chooseModel(taskHint)` returns the correct model id for each of: `code` / `reasoning-deep` / `multi-agent` / `flagship` / default. Tests pin the table.
3. A `grok` panel launches in TUI mode (interactive REPL inside the PTY).
4. Status badge updates within 3s of Grok starting reasoning.
5. **Verified end-to-end:** open a Grok panel, paste a "code" task in the boot prompt, confirm `grok-code-fast-1` was used (visible in Grok's panel output or via `GROK_MODEL` env in the spawn).
6. Memory hook writes Grok session memories via the new parser.
7. The 5 built-in sub-agents (general / explore / vision / verify / computer) are documented; the adapter doesn't need to re-implement their behavior — Grok's TUI handles sub-agent fan-out internally on the multi-agent model.

## Lane discipline

- Append-only STATUS.md updates with `T3: FINDING / FIX-PROPOSED / DONE` lines.
- No version bumps, no CHANGELOG edits, no commits.
- Stay in lane: T3 owns Grok adapter + grok-models.js + tests + memory hook slice. Does NOT touch Codex (T1), Gemini (T2), or launcher (T4).

## Pre-sprint context

- **Read SPRINT-45-PREP-NOTES.md FIRST.** It captures the model tier table, session persistence findings, and 5 open questions empirically resolved at Sprint 44 close.
- The Grok npm package is `grok-dev` (NOT `grok-cli`). Already installed globally at `/usr/local/lib/node_modules/grok-dev/` with binary at `/usr/local/bin/grok`.
- `GROK_API_KEY` is in `~/.termdeck/secrets.env` (set 2026-05-01 by Joshua).
- Multi-agent model id is `grok-4.20-multi-agent-0309` (date suffix is canonical). Heavy reasoning is `grok-4.20-0309-reasoning` (alias `grok-beta`).
- Built-in sub-agents are FIVE: general / explore / **vision** / verify / computer (vision was missing from the Sprint 43-era memorialization).
- "SuperGrok Heavy" is Joshua's subscription tier, NOT a model name. The CLI sees only the API key.
- AGENT-RUNTIMES.md § 6 has a worked example for adding an adapter — adapt it for Grok.
