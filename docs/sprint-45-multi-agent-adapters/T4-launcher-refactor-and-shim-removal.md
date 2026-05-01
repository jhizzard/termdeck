# Sprint 45 — T4: Launcher refactor + memory hook adapter-pluggable + PATTERNS shim removal + cross-adapter parity

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Now that T1/T2/T3 have shipped Codex/Gemini/Grok adapters alongside Claude (Sprint 44), refactor everything that still hardcodes per-agent logic to drive from the registry. Remove the `PATTERNS` shim that Sprint 44 T3 retained for one release. Ship a cross-adapter parity test suite confirming all four agents implement the contract uniformly.

## Files
- `packages/client/public/app.js:2422-2487` (launcher UI — remove hardcoded `claude`/`cc`/`gemini`/`python` regex branches; drive from `AGENT_ADAPTERS.matches`)
- `packages/stack-installer/assets/hooks/memory-session-end.js` (memory hook — adapter-pluggable transcript parser dispatch by adapter name)
- `packages/server/src/session.js` (remove `PATTERNS` top-level export shim retained by Sprint 44 T3 as one-release deprecation)
- NEW `tests/agent-adapter-parity.test.js` (cross-adapter contract assertions: every adapter implements the 7 fields, names are unique, sessionTypes are unique, costBand is one of the enum values, etc.)

## What the launcher refactor looks like

**Before** (`app.js:2470-2471` and similar):
```js
if (cmdLower.startsWith('claude') || cmdLower.startsWith('cc')) {
  resolvedType = 'claude-code';
} else if (cmdLower.startsWith('gemini')) {
  resolvedType = 'gemini';
} else if (cmdLower.startsWith('python')) {
  resolvedType = 'python-server';
}
```

**After**:
```js
const adapter = AGENT_ADAPTERS.find(a => a.matches(cmdLower));
const resolvedType = adapter ? adapter.sessionType : 'shell';
```

The `AGENT_ADAPTERS` array is exposed to the client via a server-rendered config (`/api/agent-adapters` endpoint, NEW) or compiled into a static client-side config at build time. Lane brief picks the cleanest path.

## What the memory hook refactor looks like

**Before** (`memory-session-end.js:83-116`):
```js
// Hardcoded Claude JSONL parsing
const messages = lines.map(line => JSON.parse(line)).map(m => ({
  role: m.message.role,
  content: m.message.content,
}));
```

**After**:
```js
const adapter = AGENT_ADAPTERS[sessionType];
const messages = adapter.parseTranscript(rawTranscript);
```

`sessionType` is read from the session metadata at hook-fire time (`{ session_id, transcript_path, cwd }` already includes it). If `sessionType` is unknown, fall back to Claude format (preserves backward-compat for any pre-Sprint-45 sessions that don't have the field).

## What the PATTERNS shim removal looks like

Sprint 44 T3 retained the `PATTERNS` export in `session.js` as a shim — external test files (`tests/rcfile-noise.test.js`, `tests/analyzer-error-fixtures.test.js`) imported it directly. T4 removes the shim. Two test files need updates to import from `agent-adapters/claude.js` directly.

## Cross-adapter parity test

```js
// tests/agent-adapter-parity.test.js
const { AGENT_ADAPTERS } = require('../packages/server/src/agent-adapters');

test('every adapter implements the 7-field contract', () => {
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    assert.equal(typeof adapter.name, 'string');
    assert.equal(typeof adapter.sessionType, 'string');
    assert.equal(typeof adapter.matches, 'function');
    assert.ok(adapter.spawn && adapter.spawn.binary);
    assert.ok(adapter.patterns && adapter.patterns.prompt instanceof RegExp);
    assert.equal(typeof adapter.statusFor, 'function');
    assert.equal(typeof adapter.parseTranscript, 'function');
    assert.equal(typeof adapter.bootPromptTemplate, 'function');
    assert.ok(['free','pay-per-token','subscription'].includes(adapter.costBand));
  }
});

test('adapter names are unique', () => {
  const names = Object.values(AGENT_ADAPTERS).map(a => a.name);
  assert.equal(new Set(names).size, names.length);
});

test('adapter sessionTypes are unique', () => {
  const types = Object.values(AGENT_ADAPTERS).map(a => a.sessionType);
  assert.equal(new Set(types).size, types.length);
});

test('matches functions are mutually exclusive on canonical inputs', () => {
  const inputs = ['claude', 'cc', 'codex', 'gemini', 'grok'];
  for (const input of inputs) {
    const matchers = Object.values(AGENT_ADAPTERS).filter(a => a.matches(input));
    assert.equal(matchers.length, 1, `expected exactly 1 adapter to match "${input}", got ${matchers.length}`);
  }
});
```

## Acceptance criteria

1. Launcher UI no longer has hardcoded `claude`/`cc`/`gemini`/`python` regex branches in `app.js:2422-2487`. Routing goes through `AGENT_ADAPTERS.matches`.
2. Memory hook dispatches transcript parser by adapter name. Existing Claude sessions still write memories correctly (no regression).
3. `PATTERNS` shim is removed from `session.js`. Two external test files updated to import from `agent-adapters/claude.js` directly. Tests still pass.
4. Cross-adapter parity test passes — all 4 adapters implement the contract uniformly.
5. Full server suite + root suite stay green (584+ tests; depends on T1/T2/T3 lanes' test counts).

## Lane discipline

- Append-only STATUS.md updates with `T4: FINDING / FIX-PROPOSED / DONE` lines.
- No version bumps, no CHANGELOG edits, no commits.
- Stay in lane: T4 owns the cross-cutting refactor + parity tests. Does NOT touch the individual adapter implementations (T1/T2/T3 own those).
- **Coordinate with T1/T2/T3 on `index.js` registration** — T4 may need to wait for the other three to land their adapter before the parity test passes. Recommendation: T4 authors the launcher refactor + memory hook + shim removal first (independent of T1/T2/T3), then the parity test last after all three adapters are registered.

## Pre-sprint context

- Sprint 44 T3 implemented the registry skeleton + Claude adapter and explicitly retained the `PATTERNS` shim "for one release." T4 is the deprecation horizon.
- The launcher refactor will require exposing the adapter registry to the client. Two paths: server-rendered `/api/agent-adapters` endpoint, or build-time compilation. Lane brief picks one (recommendation: server-rendered, simpler + dynamic).
- The memory hook lives in `packages/stack-installer/assets/hooks/memory-session-end.js` (out-of-repo at runtime: `~/.claude/hooks/memory-session-end.js` is the user's deployed copy). T4 ships the in-repo bundled version; users get it via the next stack-installer run.
