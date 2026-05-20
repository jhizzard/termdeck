'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createSprintInjectRoutes } = require('../src/sprints/inject');

function makeSession(id, type, globalWrites, opts = {}) {
  const session = {
    id,
    meta: {
      type,
      status: opts.status || 'active',
      statusDetail: opts.statusDetail || 'Ready',
      lastActivity: opts.lastActivity || '2026-05-20T17:00:00.000Z',
    },
    tracked: [],
    pty: null,
    trackInput(text) {
      this.tracked.push(text);
    },
  };
  if (opts.pty !== false) {
    session.pty = {
      write(text) {
        globalWrites.push({ sessionId: id, text });
      },
    };
  }
  return session;
}

function fourPanelBody() {
  return {
    panels: [
      { tag: 'T1', sessionId: 's1', role: 'worker', lane_brief: 'T1.md' },
      { tag: 'T2', sessionId: 's2', role: 'worker', lane_brief: 'T2.md' },
      { tag: 'T3', sessionId: 's3', role: 'worker', lane_brief: 'T3.md' },
      { tag: 'T4', sessionId: 's4', role: 'auditor', lane_brief: 'T4.md' },
    ],
    variables: {
      sprint_name: 'Sprint 69',
      sprint_dir: 'docs/sprint-69-orchestration-hardening',
      project_name: 'termdeck',
    },
  };
}

async function makeHarness({ sessions, loadTemplate, sleep }) {
  const app = express();
  app.use(express.json());
  createSprintInjectRoutes({
    app,
    getSession: (id) => sessions.get(id),
    loadTemplate,
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

test('POST /api/sprints/inject renders templates and runs paste-all then submit-all', async () => {
  const writes = [];
  const sleeps = [];
  const calls = [];
  const sessions = new Map([
    ['s1', makeSession('s1', 'claude', writes)],
    ['s2', makeSession('s2', 'codex', writes)],
    ['s3', makeSession('s3', 'gemini', writes)],
    ['s4', makeSession('s4', 'grok', writes)],
  ]);
  const h = await makeHarness({
    sessions,
    sleep: async (ms) => { sleeps.push(ms); },
    loadTemplate: (cliType, role, vars) => {
      calls.push({ cliType, role, vars });
      return `Prompt ${vars.lane_tag}\n${vars.lane_brief}\n${vars.sprint_name}`;
    },
  });

  try {
    const { status, body } = await postJson(h.port, '/api/sprints/inject', fourPanelBody());
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.panels.length, 4);
    assert.deepEqual(
      body.panels.map((p) => [p.tag, p.sessionId, p.status, p.statusDetail]),
      [
        ['T1', 's1', 'active', 'Ready'],
        ['T2', 's2', 'active', 'Ready'],
        ['T3', 's3', 'active', 'Ready'],
        ['T4', 's4', 'active', 'Ready'],
      ],
    );

    assert.deepEqual(
      calls.map((c) => [c.cliType, c.role, c.vars.lane_tag, c.vars.lane_brief]),
      [
        ['claude-code', 'worker', 'T1', 'T1.md'],
        ['codex', 'worker', 'T2', 'T2.md'],
        ['gemini', 'worker', 'T3', 'T3.md'],
        ['grok', 'auditor', 'T4', 'T4.md'],
      ],
    );

    assert.equal(writes.length, 8);
    assert.deepEqual(writes.slice(0, 4).map((w) => w.sessionId), ['s1', 's2', 's3', 's4']);
    assert.deepEqual(writes.slice(4).map((w) => w.sessionId), ['s1', 's2', 's3', 's4']);
    assert.ok(writes[0].text.startsWith('\x1b[200~Prompt T1\nT1.md'));
    assert.ok(writes[0].text.endsWith('\x1b[201~'));
    assert.equal(writes[0].text.includes('\r'), false, 'paste stage must not include submit CR');
    for (const write of writes.slice(4)) assert.equal(write.text, '\r');
    assert.deepEqual(sleeps, [250, 250, 250, 400, 250, 250, 250]);
  } finally {
    await h.close();
  }
});

test('inject maps MissingVariableError from template engine to 400 with variable names', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', 'codex', writes)]]);
  const err = new Error('missing variable: sprint_name');
  err.name = 'MissingVariableError';
  err.missingVariables = ['sprint_name'];
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => { throw err; },
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 's1', role: 'worker', lane_brief: 'T1.md' }],
      variables: {},
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.code, 'missing_template_variables');
    assert.deepEqual(result.body.missingVariables, ['sprint_name']);
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('inject rejects unknown roles before loading templates', async () => {
  let loadCalls = 0;
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', 'codex', writes)]]);
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => { loadCalls += 1; return 'unused'; },
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 's1', role: 'captain', lane_brief: 'T1.md' }],
      variables: {},
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /role must be one of/);
    assert.equal(loadCalls, 0);
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('inject rejects missing sessions before loading templates', async () => {
  let loadCalls = 0;
  const sessions = new Map();
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => { loadCalls += 1; return 'unused'; },
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 'missing', role: 'worker', lane_brief: 'T1.md' }],
      variables: {},
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'invalid_session');
    assert.equal(loadCalls, 0);
  } finally {
    await h.close();
  }
});

test('inject requires variables to be an object', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', 'codex', writes)]]);
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => 'unused',
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 's1', role: 'worker', lane_brief: 'T1.md' }],
      variables: null,
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /variables must be an object/);
  } finally {
    await h.close();
  }
});

test('inject requires lane_brief on every panel', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', 'codex', writes)]]);
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => 'unused',
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 's1', role: 'worker' }],
      variables: {},
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /lane_brief is required/);
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('inject maps unknown template errors to 400', async () => {
  const writes = [];
  const sessions = new Map([['s1', makeSession('s1', 'unknown-agent', writes)]]);
  const err = new Error('unknown template: unknown-agent/worker');
  err.code = 'unknown_template';
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => { throw err; },
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 's1', role: 'worker', lane_brief: 'T1.md' }],
      variables: {},
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'template_error');
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});

test('inject returns 410 when the target panel has exited', async () => {
  const writes = [];
  const sessions = new Map([
    ['s1', makeSession('s1', 'codex', writes, { status: 'exited', pty: false })],
  ]);
  const h = await makeHarness({
    sessions,
    sleep: async () => {},
    loadTemplate: () => 'Prompt T1',
  });

  try {
    const body = {
      panels: [{ tag: 'T1', sessionId: 's1', role: 'worker', lane_brief: 'T1.md' }],
      variables: {},
    };
    const result = await postJson(h.port, '/api/sprints/inject', body);
    assert.equal(result.status, 410);
    assert.equal(result.body.code, 'panel_exited');
    assert.equal(writes.length, 0);
  } finally {
    await h.close();
  }
});
