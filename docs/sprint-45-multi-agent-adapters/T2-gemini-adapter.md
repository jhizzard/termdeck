# Sprint 45 — T2: Gemini adapter implementation

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Migrate the existing hardcoded `gemini` branches in `app.js:2470-2471` and `session.js:71-118` (`PATTERNS.gemini`) into a proper adapter at `packages/server/src/agent-adapters/gemini.js`. Register in `index.js`. Ship snapshot tests. Boot prompt template points at `GEMINI.md` (generated from `CLAUDE.md` by Sprint 44 T2's sync script). The Gemini binary is already on PATH at `/usr/local/bin/gemini` (verified Sprint 44).

## The contract

```js
{
  name: 'gemini',
  sessionType: 'gemini',
  matches: (cmd) => /^gemini\b/.test(cmd),
  spawn: {
    binary: 'gemini',
    defaultArgs: [],
    env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY },
  },
  patterns: {
    prompt: /^gemini>\s/m,    // already in PATTERNS.gemini — lift verbatim
    thinking: /* observe — Gemini's thinking marker */,
    editing: /* observe */,
    tool: /* observe */,
    error: /* observe */,
  },
  patternNames: { error: 'gemini-error', tool: 'gemini-tool' },
  statusFor: (state) => { status: '...', statusDetail: 'Gemini is generating...' },
  parseTranscript: (raw) => Memory[],   // Gemini CLI session format — lane-time discovery
  bootPromptTemplate: (lane, sprint) => `You are ${lane.tag} in ${sprint.name}. Read GEMINI.md ...`,
  costBand: 'pay-per-token',
}
```

## Files
- NEW `packages/server/src/agent-adapters/gemini.js` (~100-150 LOC; lift `PATTERNS.gemini` from `session.js:71-118`)
- `packages/server/src/agent-adapters/index.js` (register `gemini`)
- NEW `tests/agent-adapter-gemini.test.js`
- `packages/server/src/session.js` (remove the hardcoded gemini branch from `_detectType` / `_updateStatus`; T4 will remove the launcher's hardcoded gemini branch in `app.js`)
- `packages/stack-installer/assets/hooks/memory-session-end.js` (extend parser dispatch for Gemini)

## Lane-time discovery checklist

- [ ] **Gemini transcript persistence path** — likely `~/.config/gemini-cli/sessions/...` or `~/.gemini/sessions/...`. Run a Gemini session and `ls -la ~/.gemini ~/.config/gemini-cli` to find.
- [ ] **Gemini transcript format** — Gemini CLI may use a different JSON shape than Claude.
- [ ] **Gemini thinking/tool markers** — observe by running Gemini with verbose output.
- [ ] **`GEMINI_API_KEY` env var name** — confirm via `gemini --help` or Gemini CLI docs.

## Acceptance criteria

1. `AGENT_ADAPTERS.gemini` exposes the full contract shape.
2. Snapshot tests pass — prompt detection regex from `PATTERNS.gemini` is preserved bit-for-bit (lifting check).
3. A `gemini` panel works identically to before the migration (no UX regression):
   - Same status badge behavior
   - Same prompt detection
4. Memory hook writes Gemini session memories via the new parser (improvement over current state where Gemini sessions don't write correctly because the hook assumes Claude JSONL).
5. `session.js` no longer references `PATTERNS.gemini` directly (routes through the registry).

## Lane discipline

- Append-only STATUS.md updates with `T2: FINDING / FIX-PROPOSED / DONE` lines.
- No version bumps, no CHANGELOG edits, no commits.
- Stay in lane: T2 owns Gemini adapter + tests + memory hook slice. Does NOT touch Codex (T1), Grok (T3), or launcher (T4).

## Pre-sprint context

- Existing `PATTERNS.gemini` lives at `packages/server/src/session.js:71-118`. Read it first.
- Hardcoded launcher branch lives at `packages/client/public/app.js:2470-2471`. T4 removes it; T2 doesn't touch app.js.
- The Sprint 44 T3 `claude.js` adapter is the reference implementation pattern.
