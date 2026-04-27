// Tests for sprint-routes.js — the in-dashboard 4+1 sprint runner endpoints
// (Sprint 37 T4).
//
// Covers:
//   - parseStatusMd counts FINDING/FIX-PROPOSED/DONE per lane and finds the
//     latest timestamp
//   - slugify produces safe filename slugs
//   - listExistingSprints + nextSprintNumber walk a project's docs/ dir
//   - POST /api/sprints scaffolds the expected files (PLANNING, T1-T4, STATUS)
//     and spawns 4 sessions when called via an Express test app
//   - GET /api/sprints/:name/status parses STATUS.md correctly
//   - validation rejects bad bodies (wrong lane count, bad slug, missing
//     project)
//
// Run: node --test tests/sprint-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const {
  createSprintRoutes,
  parseStatusMd,
  slugify,
  listExistingSprints,
  nextSprintNumber,
} = require('../packages/server/src/sprint-routes');

// ----- pure helpers --------------------------------------------------------

test('slugify produces filename-safe slugs', () => {
  assert.equal(slugify('Sprint Runner'), 'sprint-runner');
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('   spaced   '), 'spaced');
  assert.equal(slugify(''), 'lane');
  assert.equal(slugify(null), 'lane');
});

test('parseStatusMd counts FINDING / FIX-PROPOSED / DONE per lane', () => {
  const md = `# Sprint 37 — STATUS

Append-only.

---

## T1 — first lane

### FINDING — 2026-04-27 10:00 ET
something

### FIX-PROPOSED — 2026-04-27 10:30 ET
plan

### DONE — 2026-04-27 11:00 ET
shipped

---

## T2 — second lane

_(awaiting first entry)_

---

## T3 — third lane

### FINDING — 2026-04-27 12:00 ET
a

### FINDING — 2026-04-27 12:30 ET
b

---

## T4 — fourth lane

### DONE — 2026-04-27 09:00 ET
ok
`;
  const out = parseStatusMd(md);
  assert.equal(out.lanes.T1.finding, 1);
  assert.equal(out.lanes.T1.fixProposed, 1);
  assert.equal(out.lanes.T1.done, 1);
  assert.equal(out.lanes.T2.finding, 0);
  assert.equal(out.lanes.T2.fixProposed, 0);
  assert.equal(out.lanes.T2.done, 0);
  assert.equal(out.lanes.T3.finding, 2);
  assert.equal(out.lanes.T4.done, 1);
  // Latest timestamp seen anywhere wins.
  assert.equal(out.lastEntryAt, '2026-04-27 12:30');
  assert.equal(out.lanes.T1.lastEntryAt, '2026-04-27 11:00');
});

test('parseStatusMd handles empty / malformed input', () => {
  assert.deepEqual(parseStatusMd('').lanes, {});
  assert.deepEqual(parseStatusMd(null).lanes, {});
  // No `## T<n>` headers → no lanes.
  assert.deepEqual(parseStatusMd('just some prose').lanes, {});
});

// ----- listExistingSprints / nextSprintNumber ------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint-test-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

test('listExistingSprints + nextSprintNumber walk docs/', () => {
  const proj = makeTmpProject();
  try {
    fs.mkdirSync(path.join(proj, 'docs', 'sprint-1-foo'));
    fs.mkdirSync(path.join(proj, 'docs', 'sprint-3-bar'));
    fs.mkdirSync(path.join(proj, 'docs', 'sprint-12-baz'));
    fs.mkdirSync(path.join(proj, 'docs', 'NotASprint'));

    const sprints = listExistingSprints(proj);
    assert.equal(sprints.length, 3);
    assert.deepEqual(
      sprints.map((s) => s.number),
      [1, 3, 12],
    );
    assert.equal(nextSprintNumber(proj), 13);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('nextSprintNumber starts at 1 for a fresh project', () => {
  const proj = makeTmpProject();
  try {
    assert.equal(nextSprintNumber(proj), 1);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ----- HTTP endpoint tests -------------------------------------------------

function makeTestApp({ projectPath, spawnTerminalSessionImpl, getSessionImpl }) {
  const app = express();
  app.use(express.json());
  const config = {
    projects: { test: { path: projectPath } },
  };
  createSprintRoutes({
    app,
    config,
    spawnTerminalSession: spawnTerminalSessionImpl,
    getSession: getSessionImpl,
  });
  return app;
}

function listenOnce(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function postJSON(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function getJSON(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test('POST /api/sprints scaffolds files + spawns 4 sessions', async () => {
  const proj = makeTmpProject();
  // Initialize git so the worktree codepath could fire (even though we don't
  // use worktree here — keep it simple).
  try {
    let nextId = 0;
    const writes = [];
    const sessionsById = {};
    const spawnTerminalSessionImpl = ({ command, cwd, project, label, type }) => {
      const id = `sess-${++nextId}`;
      const sess = {
        id,
        meta: { status: 'active', statusDetail: '' },
        pty: {
          write(bytes) {
            writes.push({ id, bytes });
          },
        },
        toJSON() {
          return { id, label, project, type, cwd };
        },
      };
      // Flip to 'thinking' immediately so verify passes fast.
      sess.meta.status = 'thinking';
      sessionsById[id] = sess;
      return sess;
    };
    const getSessionImpl = (id) => sessionsById[id];

    const app = makeTestApp({
      projectPath: proj,
      spawnTerminalSessionImpl,
      getSessionImpl,
    });
    const { server, port } = await listenOnce(app);

    try {
      const { status, body } = await postJSON(port, '/api/sprints', {
        project: 'test',
        name: 'demo',
        targetVersion: '0.9.0',
        goal: 'demo goal',
        worktree: false,
        autoInject: true,
        lanes: [
          { name: 'lane-one', goal: 'a' },
          { name: 'lane-two', goal: 'b' },
          { name: 'lane-three', goal: 'c' },
          { name: 'lane-four', goal: 'd' },
        ],
      });
      assert.equal(status, 201);
      assert.equal(body.ok, true);
      assert.equal(body.sprintName, 'demo');
      assert.equal(body.sprintNumber, 1);
      assert.deepEqual(Object.keys(body.sessionIds), ['T1', 'T2', 'T3', 'T4']);

      // Files exist.
      const sprintDir = path.join(proj, 'docs', 'sprint-1-demo');
      assert.ok(fs.existsSync(path.join(sprintDir, 'PLANNING.md')));
      assert.ok(fs.existsSync(path.join(sprintDir, 'STATUS.md')));
      assert.ok(fs.existsSync(path.join(sprintDir, 'T1-lane-one.md')));
      assert.ok(fs.existsSync(path.join(sprintDir, 'T2-lane-two.md')));
      assert.ok(fs.existsSync(path.join(sprintDir, 'T3-lane-three.md')));
      assert.ok(fs.existsSync(path.join(sprintDir, 'T4-lane-four.md')));

      // 4 sessions × 2 writes each (paste + submit).
      assert.equal(writes.length, 8);
      // First 4 are bracketed-paste payloads.
      for (let i = 0; i < 4; i++) {
        assert.ok(writes[i].bytes.startsWith('\x1b[200~'));
        assert.ok(writes[i].bytes.endsWith('\x1b[201~'));
      }
      // Last 4 are lone CR.
      for (let i = 4; i < 8; i++) {
        assert.equal(writes[i].bytes, '\r');
      }
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/sprints rejects bad bodies', async () => {
  const proj = makeTmpProject();
  try {
    const app = makeTestApp({
      projectPath: proj,
      spawnTerminalSessionImpl: () => {
        throw new Error('should not spawn');
      },
      getSessionImpl: () => null,
    });
    const { server, port } = await listenOnce(app);
    try {
      // Wrong lane count.
      let r = await postJSON(port, '/api/sprints', {
        project: 'test',
        name: 'demo',
        lanes: [{ name: 'a', goal: 'a' }],
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /4 lanes/);

      // Bad slug.
      r = await postJSON(port, '/api/sprints', {
        project: 'test',
        name: 'BAD NAME',
        lanes: Array.from({ length: 4 }, (_, i) => ({ name: `l${i + 1}`, goal: 'g' })),
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /slug/);

      // Unknown project.
      r = await postJSON(port, '/api/sprints', {
        project: 'nope',
        name: 'demo',
        lanes: Array.from({ length: 4 }, (_, i) => ({ name: `l${i + 1}`, goal: 'g' })),
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /unknown project/);

      // Missing lane name.
      r = await postJSON(port, '/api/sprints', {
        project: 'test',
        name: 'demo',
        lanes: [
          { name: 'a', goal: 'g' },
          { goal: 'g' },
          { name: 'c', goal: 'g' },
          { name: 'd', goal: 'g' },
        ],
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /T2 missing name/);
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('GET /api/sprints/:name/status parses STATUS.md', async () => {
  const proj = makeTmpProject();
  try {
    const sprintDir = path.join(proj, 'docs', 'sprint-7-foo');
    fs.mkdirSync(sprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(sprintDir, 'STATUS.md'),
      `# Sprint 7 — STATUS

## T1 — alpha

### FINDING — 2026-04-27 10:00 ET
x

### DONE — 2026-04-27 11:00 ET
y

---

## T2 — beta

_(awaiting)_
`,
      'utf8',
    );

    const app = makeTestApp({
      projectPath: proj,
      spawnTerminalSessionImpl: () => null,
      getSessionImpl: () => null,
    });
    const { server, port } = await listenOnce(app);
    try {
      const r = await getJSON(port, '/api/sprints/foo/status?project=test');
      assert.equal(r.status, 200);
      assert.equal(r.body.sprintName, 'foo');
      assert.equal(r.body.sprintNumber, 7);
      assert.equal(r.body.lanes.T1.finding, 1);
      assert.equal(r.body.lanes.T1.done, 1);
      assert.equal(r.body.lanes.T2.finding, 0);
      assert.ok(r.body.lastModifiedAt);

      // 404 for missing sprint.
      const r2 = await getJSON(port, '/api/sprints/nonexistent/status?project=test');
      assert.equal(r2.status, 404);
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('GET /api/sprints/:name/tail returns last N lines', async () => {
  const proj = makeTmpProject();
  try {
    const sprintDir = path.join(proj, 'docs', 'sprint-2-tail');
    fs.mkdirSync(sprintDir, { recursive: true });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(sprintDir, 'STATUS.md'), lines.join('\n'), 'utf8');

    const app = makeTestApp({
      projectPath: proj,
      spawnTerminalSessionImpl: () => null,
      getSessionImpl: () => null,
    });
    const { server, port } = await listenOnce(app);
    try {
      const r = await getJSON(port, '/api/sprints/tail/tail?project=test&lines=5');
      assert.equal(r.status, 200);
      const tailLines = r.body.tail.split('\n');
      assert.equal(tailLines.length, 5);
      assert.equal(tailLines[0], 'line 46');
      assert.equal(tailLines[4], 'line 50');
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('GET /api/sprints lists existing sprints under a project', async () => {
  const proj = makeTmpProject();
  try {
    fs.mkdirSync(path.join(proj, 'docs', 'sprint-1-alpha'));
    fs.mkdirSync(path.join(proj, 'docs', 'sprint-2-beta'));
    const app = makeTestApp({
      projectPath: proj,
      spawnTerminalSessionImpl: () => null,
      getSessionImpl: () => null,
    });
    const { server, port } = await listenOnce(app);
    try {
      const r = await getJSON(port, '/api/sprints?project=test');
      assert.equal(r.status, 200);
      assert.equal(r.body.sprints.length, 2);
      assert.deepEqual(
        r.body.sprints.map((s) => s.slug).sort(),
        ['alpha', 'beta'],
      );
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
