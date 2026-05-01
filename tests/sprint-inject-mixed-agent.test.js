// Sprint 47 T3 — mixed-agent dispatch tests for sprint-inject.js.
//
// Acceptance criteria from docs/sprint-47-mixed-4plus1/T3-inject-mixed-agent.md:
//   1. Existing Claude path unchanged (legacy sessionIds+prompts shape; or
//      new lanes[] shape with agent='claude' or agent omitted) — bracketed-
//      paste payload, lone-CR submit. Bit-for-bit identical to Sprint 46.
//   2. Mixed-agent dispatch: a 4-lane inject with T1=codex / T2=gemini /
//      T3=grok / T4=claude. Every lane currently declares acceptsPaste=true,
//      so all four use bracketed-paste; the test asserts the helper looked
//      up the right adapter and emitted the canonical paste payload per lane.
//   3. Adapter-contract extension: any adapter declaring acceptsPaste=false
//      triggers the chunked-stdin fallback. Tested with a stub adapter so
//      the path is exercised end-to-end without flipping a real adapter.
//   4. Paste-pattern parity test extended in agent-adapter-parity.test.js.
//
// Run: node --test tests/sprint-inject-mixed-agent.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  injectSprintPrompts,
  buildPayload,
} = require('../packages/server/src/sprint-inject');

const { AGENT_ADAPTERS } = require('../packages/server/src/agent-adapters');

function makeMocks({ statusByCall = {}, throwOnWrite = null } = {}) {
  const writes = []; // { sessionId, bytes }
  const sleeps = []; // ms

  const writeBytes = async (sessionId, bytes) => {
    if (throwOnWrite && throwOnWrite(sessionId, bytes)) {
      throw new Error('boom');
    }
    writes.push({ sessionId, bytes });
    return { bytes: bytes.length };
  };

  const statusCursor = {};
  const getStatus = async (sessionId) => {
    const list = statusByCall[sessionId];
    if (!list) return { status: 'thinking' }; // default: pretend everyone thinks
    const idx = statusCursor[sessionId] || 0;
    statusCursor[sessionId] = idx + 1;
    return { status: list[idx] || list[list.length - 1] || 'thinking' };
  };

  const sleep = async (ms) => { sleeps.push(ms); };

  return { writes, sleeps, writeBytes, getStatus, sleep };
}

// ──────────────────────────────────────────────────────────────────────────
// buildPayload — pure-function dispatch logic
// ──────────────────────────────────────────────────────────────────────────

test('buildPayload returns paste shape for unspecified agent (legacy default)', () => {
  const out = buildPayload('hello', null);
  assert.equal(out.kind, 'paste');
  assert.equal(out.bytes, '\x1b[200~hello\x1b[201~');
});

test('buildPayload returns paste shape for every shipped adapter', () => {
  for (const name of ['claude', 'codex', 'gemini', 'grok']) {
    const out = buildPayload('hello', name);
    assert.equal(out.kind, 'paste', `${name}: expected paste shape`);
    assert.equal(out.bytes, '\x1b[200~hello\x1b[201~', `${name}: bytes mismatch`);
  }
});

test('buildPayload returns chunked shape when adapter declares acceptsPaste=false', () => {
  const stubRegistry = {
    weird: { name: 'weird', acceptsPaste: false },
  };
  const out = buildPayload('line1\nline2\nline3', 'weird', stubRegistry);
  assert.equal(out.kind, 'chunked');
  assert.deepEqual(out.lines, ['line1', 'line2', 'line3']);
});

test('buildPayload falls back to paste when agent name is unknown (graceful degrade)', () => {
  // A typo in a lane brief should not throw mid-inject — it just defaults to
  // bracketed-paste, which works for any Claude-shaped TUI. Frontmatter
  // validation (Sprint 47 T1) is the right place to reject unknown agents.
  const out = buildPayload('hello', 'gpt5');
  assert.equal(out.kind, 'paste');
  assert.equal(out.bytes, '\x1b[200~hello\x1b[201~');
});

// ──────────────────────────────────────────────────────────────────────────
// Legacy claude-path parity (acceptance criterion 1)
// ──────────────────────────────────────────────────────────────────────────

test('legacy sessionIds+prompts shape produces identical bytes to Sprint 46', async () => {
  const m = makeMocks();
  // Omit getStatus → verify+poke block is skipped entirely. Total write
  // count is then deterministic (4 paste + 4 submit) without depending on
  // mock status bookkeeping.
  const result = await injectSprintPrompts({
    sessionIds: ['s1', 's2', 's3', 's4'],
    prompts: ['p1', 'p2', 'p3', 'p4'],
    writeBytes: m.writeBytes,
    sleep: m.sleep,
  });

  // 8 writes total: 4 pastes + 4 lone CRs (Sprint 37 baseline shape).
  assert.equal(m.writes.length, 8, 'expected 4 paste + 4 submit writes');
  for (let i = 0; i < 4; i++) {
    assert.equal(m.writes[i].sessionId, ['s1', 's2', 's3', 's4'][i]);
    assert.equal(m.writes[i].bytes, `\x1b[200~p${i + 1}\x1b[201~`);
    assert.ok(!m.writes[i].bytes.includes('\r'), 'paste must not contain CR');
  }
  for (let i = 4; i < 8; i++) {
    assert.equal(m.writes[i].sessionId, ['s1', 's2', 's3', 's4'][i - 4]);
    assert.equal(m.writes[i].bytes, '\r');
  }
  assert.equal(result.ok, true);
  for (const lane of result.lanes) {
    assert.equal(lane.paste.mode, 'paste');
    assert.equal(lane.agent, null);
  }
});

test('lanes[] shape with all-claude is bit-for-bit identical to legacy shape', async () => {
  const m = makeMocks();
  const result = await injectSprintPrompts({
    lanes: [
      { sessionId: 's1', prompt: 'p1', agent: 'claude' },
      { sessionId: 's2', prompt: 'p2', agent: 'claude' },
      { sessionId: 's3', prompt: 'p3', agent: 'claude' },
      { sessionId: 's4', prompt: 'p4', agent: 'claude' },
    ],
    writeBytes: m.writeBytes,
    sleep: m.sleep,
  });

  assert.equal(m.writes.length, 8);
  for (let i = 0; i < 4; i++) {
    assert.equal(m.writes[i].bytes, `\x1b[200~p${i + 1}\x1b[201~`);
  }
  for (let i = 4; i < 8; i++) {
    assert.equal(m.writes[i].bytes, '\r');
  }
  assert.equal(result.ok, true);
  for (const lane of result.lanes) {
    assert.equal(lane.agent, 'claude');
    assert.equal(lane.paste.mode, 'paste');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Mixed-agent dispatch (acceptance criterion 2)
// ──────────────────────────────────────────────────────────────────────────

test('mixed-agent: T1=codex / T2=gemini / T3=grok / T4=claude all use bracketed paste', async () => {
  const m = makeMocks();
  const result = await injectSprintPrompts({
    lanes: [
      { sessionId: 's1', prompt: 'codex-prompt',  agent: 'codex'  },
      { sessionId: 's2', prompt: 'gemini-prompt', agent: 'gemini' },
      { sessionId: 's3', prompt: 'grok-prompt',   agent: 'grok'   },
      { sessionId: 's4', prompt: 'claude-prompt', agent: 'claude' },
    ],
    writeBytes: m.writeBytes,
    sleep: m.sleep,
  });

  // All four currently declare acceptsPaste=true → 4 paste + 4 submit writes.
  assert.equal(m.writes.length, 8);
  const expectedPrompts = ['codex-prompt', 'gemini-prompt', 'grok-prompt', 'claude-prompt'];
  const expectedSids = ['s1', 's2', 's3', 's4'];
  for (let i = 0; i < 4; i++) {
    assert.equal(m.writes[i].sessionId, expectedSids[i]);
    assert.equal(m.writes[i].bytes, `\x1b[200~${expectedPrompts[i]}\x1b[201~`);
  }
  for (let i = 4; i < 8; i++) {
    assert.equal(m.writes[i].sessionId, expectedSids[i - 4]);
    assert.equal(m.writes[i].bytes, '\r');
  }
  assert.equal(result.ok, true);
  assert.equal(result.lanes[0].agent, 'codex');
  assert.equal(result.lanes[1].agent, 'gemini');
  assert.equal(result.lanes[2].agent, 'grok');
  assert.equal(result.lanes[3].agent, 'claude');
});

test('mixed-agent: parallel agents[] array is equivalent to lanes[] shape', async () => {
  const m = makeMocks();
  const result = await injectSprintPrompts({
    sessionIds: ['s1', 's2', 's3', 's4'],
    prompts:    ['c-p',  'g-p',  'k-p',  'a-p'],
    agents:     ['codex', 'gemini', 'grok', 'claude'],
    writeBytes: m.writeBytes,
    sleep: m.sleep,
  });

  assert.equal(m.writes.length, 8);
  assert.equal(m.writes[0].bytes, '\x1b[200~c-p\x1b[201~');
  assert.equal(m.writes[1].bytes, '\x1b[200~g-p\x1b[201~');
  assert.equal(m.writes[2].bytes, '\x1b[200~k-p\x1b[201~');
  assert.equal(m.writes[3].bytes, '\x1b[200~a-p\x1b[201~');
  assert.equal(result.ok, true);
});

// ──────────────────────────────────────────────────────────────────────────
// Chunked fallback (acceptance criterion 3)
// ──────────────────────────────────────────────────────────────────────────

test('chunked fallback: adapter with acceptsPaste=false writes line+CR per chunk', async () => {
  const m = makeMocks();
  // Inject a stub registry where one adapter rejects bracketed-paste. Mirrors
  // what would happen if grok's Bun+OpenTUI input handler were observed to eat
  // paste markers at lane time.
  const stubRegistry = {
    weird: { name: 'weird', acceptsPaste: false },
    claude: AGENT_ADAPTERS.claude,
  };
  const result = await injectSprintPrompts({
    lanes: [
      { sessionId: 's1', prompt: 'line1\nline2\nline3', agent: 'weird'  },
      { sessionId: 's2', prompt: 'cprompt',             agent: 'claude' },
    ],
    writeBytes: m.writeBytes,
    sleep: m.sleep,
    options: { adapters: stubRegistry, chunkedDelayMs: 5 },
  });

  // s1 is chunked: 3 line+CR writes, no stage-2 lone CR (already submitted).
  const s1Writes = m.writes.filter((w) => w.sessionId === 's1');
  assert.equal(s1Writes.length, 3, 's1 should have 3 chunked writes');
  assert.equal(s1Writes[0].bytes, 'line1\r');
  assert.equal(s1Writes[1].bytes, 'line2\r');
  assert.equal(s1Writes[2].bytes, 'line3\r');

  // s2 is paste: 1 paste write + 1 lone CR.
  const s2Writes = m.writes.filter((w) => w.sessionId === 's2');
  assert.equal(s2Writes.length, 2, 's2 should have 1 paste + 1 submit write');
  assert.equal(s2Writes[0].bytes, '\x1b[200~cprompt\x1b[201~');
  assert.equal(s2Writes[1].bytes, '\r');

  // Result: chunked lane reports mode:'chunked' and submit:skipped.
  const lane1 = result.lanes.find((l) => l.sessionId === 's1');
  assert.equal(lane1.paste.mode, 'chunked');
  assert.equal(lane1.paste.ok, true);
  assert.equal(lane1.submit.skipped, 'chunked-already-submitted');
  assert.equal(result.ok, true);
});

test('chunked fallback: write failure mid-chunks marks paste as failed', async () => {
  // Throw on the second write only → first chunk lands, second errors,
  // remaining chunks short-circuit, lane reports paste.ok=false.
  let writeCount = 0;
  const writes = [];
  const writeBytes = async (sessionId, bytes) => {
    writeCount += 1;
    if (writeCount === 2) throw new Error('mid-chunk boom');
    writes.push({ sessionId, bytes });
    return { bytes: bytes.length };
  };
  const sleep = async () => {};
  const stubRegistry = { weird: { name: 'weird', acceptsPaste: false } };

  const result = await injectSprintPrompts({
    lanes: [{ sessionId: 's1', prompt: 'line1\nline2\nline3', agent: 'weird' }],
    writeBytes,
    sleep,
    options: { adapters: stubRegistry },
  });

  assert.equal(writes.length, 1, 'only the first chunk should have been recorded');
  assert.equal(result.lanes[0].paste.ok, false);
  assert.equal(result.lanes[0].paste.mode, 'chunked');
  assert.match(result.lanes[0].paste.error, /mid-chunk boom/);
  assert.equal(result.lanes[0].submit.skipped, 'paste-failed');
  assert.equal(result.ok, false);
});

// ──────────────────────────────────────────────────────────────────────────
// Input validation (extended for new shapes)
// ──────────────────────────────────────────────────────────────────────────

test('lanes[] empty array rejected', async () => {
  const m = makeMocks();
  await assert.rejects(
    () =>
      injectSprintPrompts({
        lanes: [],
        writeBytes: m.writeBytes,
        sleep: m.sleep,
      }),
    /at least one lane required/,
  );
});

test('lanes[] entry missing sessionId rejected', async () => {
  const m = makeMocks();
  await assert.rejects(
    () =>
      injectSprintPrompts({
        lanes: [{ prompt: 'p', agent: 'claude' }],
        writeBytes: m.writeBytes,
        sleep: m.sleep,
      }),
    /sessionId/,
  );
});

test('lanes[] entry missing prompt rejected', async () => {
  const m = makeMocks();
  await assert.rejects(
    () =>
      injectSprintPrompts({
        lanes: [{ sessionId: 's1', agent: 'claude' }],
        writeBytes: m.writeBytes,
        sleep: m.sleep,
      }),
    /prompt/,
  );
});

test('agents[] length mismatch rejected', async () => {
  const m = makeMocks();
  await assert.rejects(
    () =>
      injectSprintPrompts({
        sessionIds: ['s1', 's2'],
        prompts: ['p1', 'p2'],
        agents: ['claude'],
        writeBytes: m.writeBytes,
        sleep: m.sleep,
      }),
    /agents must be an array of the same length/,
  );
});
