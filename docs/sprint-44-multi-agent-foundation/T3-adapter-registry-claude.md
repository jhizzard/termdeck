# Sprint 44 — T3: Agent adapter registry skeleton + Claude adapter migration

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Create the agent adapter registry. NEW `packages/server/src/agent-adapters/index.js` exports `AGENT_ADAPTERS` map keyed by adapter name. NEW `packages/server/src/agent-adapters/claude.js` lifts the existing `PATTERNS` + `_detectType` + `_updateStatus` logic from `packages/server/src/session.js:28-312` into the adapter. **Critical: snapshot tests pin every existing detection path so behavior is bit-for-bit identical post-refactor.** Codex / Gemini / Grok adapters are **out of scope** — Sprint 45.

## Files
- NEW `packages/server/src/agent-adapters/index.js`
- NEW `packages/server/src/agent-adapters/claude.js`
- `packages/server/src/session.js` (refactor `_detectType` + `_updateStatus` to consume the registry; keep existing `PATTERNS` export as a shim for one release for any external caller)
- NEW `tests/agent-adapter-claude.test.js` (snapshot tests against current behavior)

## Adapter contract (from memorialization doc § 4)

```js
{
  matches: (cmd) => boolean,                          // does this cmd string indicate this adapter?
  spawn: { binary, defaultArgs, env },                // PTY spawn config
  patterns: { prompt, thinking, editing, tool, error }, // for analyzer
  statusFor: (state) => { status, statusDetail },     // status badge
  parseTranscript: (raw) => Memory[],                 // for the session-end hook
  bootPromptTemplate: (lane, sprint) => string,       // inject prompt
  costBand: 'free' | 'pay-per-token' | 'subscription',
}
```

For Sprint 44, only `claude.js` implements the contract. `parseTranscript` for Claude reads the existing `{ message: { role, content } }` JSONL format (move from `packages/stack-installer/assets/hooks/memory-session-end.js:83-116` — make it importable from the adapter).

## Acceptance criteria
1. `AGENT_ADAPTERS.claude` exposes the full contract shape.
2. Snapshot tests for every existing PATTERN-based detection (type, prompt, thinking, editing, tool, error) match pre-refactor behavior **bit-for-bit**.
3. `session.js::_detectType` and `session.js::_updateStatus` route through `AGENT_ADAPTERS` instead of the hardcoded `PATTERNS` table — but produce **identical output** for Claude sessions.
4. Existing 35/35 server suite + 544 root suite stays green. `tests/ws-handler-contract.test.js` parity guard still passes.
5. The existing `PATTERNS` export from `session.js` is retained as a shim (for one release) so any external import doesn't break.
6. `flashback-diag.js` integration unchanged — the adapter's pattern matches feed the same ring buffer.

## Lane discipline
- Append-only STATUS.md updates with `T3: FINDING / FIX-PROPOSED / DONE`.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close.
- Stay in lane: T3 owns the adapter registry + Claude adapter. Does NOT add Codex / Gemini / Grok adapters (Sprint 45). Does NOT touch the launcher UI (Sprint 45 T4). Does NOT write the AGENT-RUNTIMES.md doc (T4).

## Pre-sprint context

The five hardcoded touchpoints requiring abstraction are mapped in `docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md` § 2. T3 only addresses **two** of them:
- Type detection (`session.js:243-256` `_detectType`) — moved into adapter `matches` + `patterns.prompt`
- Status badge rendering (`session.js:258-312` `_updateStatus`) — moved into adapter `statusFor`

The other three (launcher UI command parsing in `app.js:2422-2487`, memory hook transcript parser, server PTY spawn) stay untouched in Sprint 44. **Sprint 45 T4** does the final launcher refactor and memory hook adapter-pluggable parser. PTY spawn was already agent-agnostic per Phase 1 exploration.

## Backward-compat strategy

- Keep the `PATTERNS` export in `session.js` as a top-level constant that the adapter populates from. Any external import gets the same object.
- Add a deprecation comment: `// PATTERNS is retained for one release as a shim; consume packages/server/src/agent-adapters/claude.js directly for new code.`
- Sprint 45 T4 removes the shim.
