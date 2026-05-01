# Sprint 45 — T1: Codex adapter implementation

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Implement the 7-field adapter contract for Codex CLI in `packages/server/src/agent-adapters/codex.js`, register it in `index.js`, and ship snapshot tests. The Codex binary is already on PATH at `/usr/local/bin/codex` (verified Sprint 44). This is **Codex-as-its-own-panel** — distinct from the existing `codex@openai-codex` Claude Code plugin which is delegate-from-Claude only.

## The contract (7 fields + 2 optional extras from Sprint 44 T3)

```js
{
  name: 'codex',
  sessionType: 'codex',
  matches: (cmd) => /^codex\b/.test(cmd),
  spawn: {
    binary: 'codex',
    defaultArgs: [],   // Codex's TUI mode if no `--prompt`
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  },
  patterns: {
    prompt: /* observe the Codex TUI prompt regex at lane-time */,
    thinking: /* observe */,
    editing: /* observe — does Codex have an "editing" status? */,
    tool: /* observe — Codex's tool-use markers */,
    error: /* observe — Codex's error patterns */,
  },
  patternNames: { error: 'codex-error', tool: 'codex-tool', /* ... */ },
  statusFor: (state) => { status: '...', statusDetail: 'Codex is reasoning...' },
  parseTranscript: (raw) => Memory[],   // reads ~/.codex/sessions/<id>/* — format lane-time discovery
  bootPromptTemplate: (lane, sprint) => `You are ${lane.tag} in ${sprint.name}. Read AGENTS.md ...`,
  costBand: 'pay-per-token',
}
```

## Files
- NEW `packages/server/src/agent-adapters/codex.js` (~100-150 LOC)
- `packages/server/src/agent-adapters/index.js` (register `codex` adapter alongside `claude`)
- NEW `tests/agent-adapter-codex.test.js` (snapshot tests against observed Codex behavior)
- `packages/stack-installer/assets/hooks/memory-session-end.js` (extend transcript parser to dispatch by adapter name — Codex format is distinct from Claude JSONL)

## Lane-time discovery checklist

These are unknowns the lane needs to characterize empirically:

- [ ] **Codex TUI prompt regex** — what does the Codex prompt look like? (e.g. `Codex>` or `> ` or something else)
- [ ] **Codex thinking marker** — when Codex is reasoning, does it emit a status string? `Thinking...` `Codex is processing...` `[reasoning]` ?
- [ ] **Codex tool-use marker** — when Codex calls a tool (file read, shell exec), what's the visible pattern?
- [ ] **Codex transcript persistence path** — `~/.codex/sessions/<id>/...` is the suspected location. Run a Codex session, then `ls -la ~/.codex/sessions/` to confirm.
- [ ] **Codex transcript format** — JSONL? JSON? Plain text? Same `{ message: { role, content } }` shape as Claude or different?
- [ ] **Codex error patterns** — what does an API error or tool failure look like in the TUI?

## Acceptance criteria

1. `AGENT_ADAPTERS.codex` exposes the full contract shape (matches Claude's contract for cross-adapter parity).
2. Snapshot tests pass: prompt detection, thinking detection, tool detection, error detection, transcript parsing.
3. A `codex` panel launched from the TermDeck dashboard:
   - Status badge updates within 3s of Codex starting reasoning
   - Status detail says "Codex is reasoning..." (or whatever the lane chose) when applicable
   - On session end, the memory hook writes a memory item via the Codex parser to Mnestra
4. The existing `codex@openai-codex` Claude Code plugin is unaffected (Claude can still delegate-to-Codex via the plugin's tools).
5. No regression in Claude or Gemini lanes (T2 lands its own adapter).

## Lane discipline

- Append-only STATUS.md updates with `T1: FINDING / FIX-PROPOSED / DONE` lines.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close.
- Stay in lane: T1 owns Codex adapter + its snapshot tests + its slice of the memory hook. Does NOT touch Gemini (T2), Grok (T3), or the launcher refactor (T4).
- **Coordinate on `index.js` registration** — orchestrator handles the merge at sprint close to avoid conflicts with T2/T3 also registering their adapters.

## Pre-sprint context

- The 7-field adapter contract was established by Sprint 44 T3 (`docs/AGENT-RUNTIMES.md` § 5).
- Claude adapter at `packages/server/src/agent-adapters/claude.js` is the reference implementation — read it first to understand the contract in practice.
- AGENT-RUNTIMES.md § 6 has a **worked example** for adding a Codex adapter — follow it as a recipe.
- The `OPENAI_API_KEY` env var is already in `~/.termdeck/secrets.env` (used by Mnestra embeddings); the Codex adapter reads the same value.
