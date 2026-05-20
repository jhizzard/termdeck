'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { buildNudgeText, createSprintNudgeRoutes } = require('../src/sprints/nudge');

function makeSession(id, globalWrites) {
  const session = {
    id,
    meta: {
      type: 'codex',
      status: 'active',
      statusDetail: 'Ready',
      lastActivity: '2026-05-20T17:00:00.000Z',
    },
    tracked: [],
    pty: {
      write(text) {
        globalWrites.push({ sessionId: id, text });
      },
    },
    trackInput(text) {
      this.tracked.push(text);
    },
  };
  return session;
}

async function makeHarness({ sessions, sleep }) {
  const app = express();
  app.use(express.json());
  createSprintNudgeRoutes({
    app,
    getSession: (id) => sessions.get(id),
    sleep,
    options: { snapshotDelayMs: 0 },
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function postJson(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('buildNudgeText post-landed-reminder includes sprint, open red, repro, and LANDED shape', () => {
  const text = buildNudgeText({
    panel: { tag: 'T2' },
    kind: 'post-landed-reminder',
    context: {
      sprint_name: 'Sprint 69',
      open_red: { file_line: 'packages/server/src/sprints/inject.js:42' },
      test_repro: 'node --test packages/server/tests/sprint-inject-endpoint.test.js',
    },
  });

  assert.match(text, /Sprint 69/);
  assert.match(text, /inject\.js:42/);
  assert.match(text, /node --test/);
  assert.match(text, /### \[T2\] LANDED/);
});

test('POST /api/sprints/nudge sends post-landed-reminder through two-stage submit', async () => {
  const writes = [];
  const sleeps = [];
  const sessions = new Map([
    ['s1', makeSession('s1', writes)],
    ['s2', makeSession('s2', writes)],
  ]);
  const h = await makeHarness({
    sessions,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }, { tag: 'T2', sessionId: 's2' }],
      kind: 'post-landed-reminder',
      context: {
        sprint_name: 'Sprint 69',
        open_red: { file_line: 'STATUS.md:40' },
        test_repro: 'npm test',
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.panels.length, 2);
    assert.deepEqual(writes.map((w) => w.sessionId), ['s1', 's2', 's1', 's2']);
    assert.ok(writes[0].text.startsWith('\x1b[200~ORCHESTRATOR NUDGE'));
    assert.ok(writes[0].text.includes('STATUS.md:40'));
    assert.ok(writes[0].text.endsWith('\x1b[201~'));
    assert.equal(writes[0].text.includes('\r'), false);
    assert.equal(writes[2].text, '\r');
    assert.equal(writes[3].text, '\r');
    assert.deepEqual(sleeps, [250, 400, 250]);
  } finally {
    await h.close();
  }
});

test('status-check nudge text asks for CHECKPOINT or LANDED', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T3', sessionId: 's1' }],
      kind: 'status-check',
      context: { silent_minutes: 12 },
    });
    assert.equal(result.status, 200);
    assert.match(writes[0].text, /STATUS-CHECK/);
    assert.match(writes[0].text, /12 minutes/);
    assert.match(writes[0].text, /### \[T3\] CHECKPOINT/);
    assert.match(writes[0].text, /LANDED/);
  } finally {
    await h.close();
  }
});

test('tooling-failure-recover nudge asks for a tooling failure checkpoint', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T4-GROK', sessionId: 's1' }],
      kind: 'tooling-failure-recover',
      context: {},
    });
    assert.equal(result.status, 200);
    assert.match(writes[0].text, /ORCHESTRATOR RECOVERY/);
    assert.match(writes[0].text, /TOOLING-FAILURE CHECKPOINT/);
    assert.match(writes[0].text, /codex-rescue/);
  } finally {
    await h.close();
  }
});

test('custom nudge uses top-level text verbatim', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }],
      kind: 'custom',
      text: 'custom exact text\nwith newline',
      context: { custom_text: 'ignored' },
    });
    assert.equal(result.status, 200);
    assert.equal(writes[0].text, '\x1b[200~custom exact text\nwith newline\x1b[201~');
  } finally {
    await h.close();
  }
});

test('custom nudge accepts context.custom_text when text is absent', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }],
      kind: 'custom',
      context: { custom_text: 'context exact text' },
    });
    assert.equal(result.status, 200);
    assert.equal(writes[0].text, '\x1b[200~context exact text\x1b[201~');
  } finally {
    await h.close();
  }
});

test('custom nudge rejects missing custom text', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }],
      kind: 'custom',
      context: {},
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /custom nudge requires/);
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('post-landed-reminder rejects missing open_red or test_repro context', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const missingOpenRed = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }],
      kind: 'post-landed-reminder',
      context: { test_repro: 'npm test' },
    });
    assert.equal(missingOpenRed.status, 400);
    assert.match(missingOpenRed.body.error, /context\.open_red/);

    const missingRepro = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }],
      kind: 'post-landed-reminder',
      context: { open_red: { file_line: 'x:1' } },
    });
    assert.equal(missingRepro.status, 400);
    assert.match(missingRepro.body.error, /context\.test_repro/);
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('nudge rejects unknown kind before writing', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', writes)]]);
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 's1' }],
      kind: 'wake-up',
      context: {},
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /kind must be one of/);
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('nudge rejects missing sessions before writing', async () => {
  const sessions = new Map();
  const h = await makeHarness({ sessions, sleep: async () => {} });

  try {
    const result = await postJson(h.port, '/api/sprints/nudge', {
      panels: [{ tag: 'T1', sessionId: 'missing' }],
      kind: 'status-check',
      context: {},
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'invalid_session');
  } finally {
    await h.close();
  }
});
