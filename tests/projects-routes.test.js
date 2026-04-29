// Tests for projects-routes.js — POST /api/projects (add) and
// DELETE /api/projects/:name (remove). Sprint 42 T4.
//
// Covers:
//   - POST happy path delegates to addProject and broadcasts projects_changed
//   - POST surfaces addProject errors as 400
//   - DELETE 404 when project is unknown
//   - DELETE 409 when live PTY sessions exist for that project
//   - DELETE 200 with ?force=true overriding the live-session guard
//   - DELETE happy path when no live sessions exist
//   - DELETE rejects bad project name regex with 400
//   - DELETE returns the canonical "files_on_disk: untouched" envelope
//   - removeProject() helper: regex validation, NOT_FOUND code, .bak before
//     overwrite, returns the post-delete projects map
//
// Run: node --test tests/projects-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createProjectsRoutes } = require('../packages/server/src/projects-routes');
const { removeProject } = require('../packages/server/src/config');

// ----- helpers -------------------------------------------------------------

function listenOnce(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function postJSON(port, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function delJSON(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'DELETE' });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

function makeApp({ initialProjects, sessions, addProjectImpl, removeProjectImpl, broadcastImpl }) {
  const app = express();
  app.use(express.json());
  const config = { projects: { ...(initialProjects || {}) } };
  const broadcasts = [];
  createProjectsRoutes({
    app,
    config,
    getSessions: () => sessions || [],
    addProject: addProjectImpl || (() => { throw new Error('addProject not stubbed'); }),
    removeProject: removeProjectImpl || (() => { throw new Error('removeProject not stubbed'); }),
    broadcast: (payload) => {
      broadcasts.push(payload);
      if (broadcastImpl) broadcastImpl(payload);
    },
  });
  return { app, config, broadcasts };
}

// ----- POST /api/projects --------------------------------------------------

test('POST /api/projects delegates to addProject and broadcasts', async () => {
  const { app, config, broadcasts } = makeApp({
    initialProjects: {},
    sessions: [],
    addProjectImpl: ({ name, path: p }) => ({ [name]: { path: p } }),
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await postJSON(port, '/api/projects', {
      name: 'demo',
      path: '/tmp/demo',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.projects, { demo: { path: '/tmp/demo' } });
    assert.deepEqual(config.projects, { demo: { path: '/tmp/demo' } });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'projects_changed');
  } finally { server.close(); }
});

test('POST /api/projects returns 400 when addProject throws', async () => {
  const { app } = makeApp({
    addProjectImpl: () => { throw new Error('Project path does not exist: /nope'); },
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await postJSON(port, '/api/projects', {
      name: 'demo',
      path: '/nope',
    });
    assert.equal(status, 400);
    assert.match(body.error, /Project path does not exist/);
  } finally { server.close(); }
});

// ----- DELETE /api/projects/:name -----------------------------------------

test('DELETE /api/projects/:name returns 404 for unknown project', async () => {
  const { app } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' } },
    sessions: [],
    removeProjectImpl: () => { throw new Error('should not be called'); },
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await delJSON(port, '/api/projects/bar');
    assert.equal(status, 404);
    assert.match(body.error, /not found/i);
  } finally { server.close(); }
});

test('DELETE /api/projects/:name returns 409 when live PTY sessions exist', async () => {
  const sessions = [
    { id: 's1', meta: { project: 'foo', status: 'active' } },
    { id: 's2', meta: { project: 'foo', status: 'thinking' } },
    { id: 's3', meta: { project: 'foo', status: 'exited' } }, // ignored
    { id: 's4', meta: { project: 'bar', status: 'active' } }, // different project
  ];
  let removeCalled = false;
  const { app, config } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' }, bar: { path: '/tmp/bar' } },
    sessions,
    removeProjectImpl: () => { removeCalled = true; return {}; },
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await delJSON(port, '/api/projects/foo');
    assert.equal(status, 409);
    assert.equal(body.liveSessions, 2);
    assert.deepEqual(body.sessionIds, ['s1', 's2']);
    assert.equal(removeCalled, false, 'removeProject must not be invoked when 409 fires');
    // Config should not have changed.
    assert.ok(config.projects.foo);
  } finally { server.close(); }
});

test('DELETE /api/projects/:name with ?force=true bypasses 409 and removes', async () => {
  const sessions = [
    { id: 's1', meta: { project: 'foo', status: 'active' } },
  ];
  let removeArg = null;
  const { app, config, broadcasts } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' }, bar: { path: '/tmp/bar' } },
    sessions,
    removeProjectImpl: (name) => { removeArg = name; return { bar: { path: '/tmp/bar' } }; },
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await delJSON(port, '/api/projects/foo?force=true');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.removed, 'foo');
    assert.equal(body.forced, true);
    assert.equal(body.files_on_disk, 'untouched');
    assert.deepEqual(body.projects, { bar: { path: '/tmp/bar' } });
    assert.equal(removeArg, 'foo');
    assert.deepEqual(config.projects, { bar: { path: '/tmp/bar' } });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'projects_changed');
  } finally { server.close(); }
});

test('DELETE /api/projects/:name happy path with no live sessions', async () => {
  const { app, config, broadcasts } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' }, bar: { path: '/tmp/bar' } },
    sessions: [
      { id: 'ex', meta: { project: 'foo', status: 'exited' } }, // exited → ignored
    ],
    removeProjectImpl: () => ({ bar: { path: '/tmp/bar' } }),
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await delJSON(port, '/api/projects/foo');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.removed, 'foo');
    assert.equal(body.forced, false);
    assert.equal(body.files_on_disk, 'untouched');
    assert.deepEqual(config.projects, { bar: { path: '/tmp/bar' } });
    assert.equal(broadcasts.length, 1);
  } finally { server.close(); }
});

test('DELETE /api/projects/:name rejects bad project names with 400', async () => {
  const { app } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' } },
    sessions: [],
    removeProjectImpl: () => ({}),
  });
  const { server, port } = await listenOnce(app);
  try {
    // URL-encoded space in :name decodes to "foo bar", which fails the regex.
    const { status, body } = await delJSON(port, '/api/projects/foo%20bar');
    assert.equal(status, 400);
    assert.match(body.error, /letters, digits/);
  } finally { server.close(); }
});

test('DELETE surfaces NOT_FOUND from removeProject as 404', async () => {
  const { app } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' } },
    sessions: [],
    removeProjectImpl: () => {
      const err = new Error('Project "foo" not found in config.yaml');
      err.code = 'NOT_FOUND';
      throw err;
    },
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await delJSON(port, '/api/projects/foo');
    assert.equal(status, 404);
    assert.match(body.error, /not found/i);
  } finally { server.close(); }
});

test('DELETE surfaces unexpected errors as 500', async () => {
  const { app } = makeApp({
    initialProjects: { foo: { path: '/tmp/foo' } },
    sessions: [],
    removeProjectImpl: () => { throw new Error('disk on fire'); },
  });
  const { server, port } = await listenOnce(app);
  try {
    const { status, body } = await delJSON(port, '/api/projects/foo');
    assert.equal(status, 500);
    assert.match(body.error, /disk on fire/);
  } finally { server.close(); }
});

// ----- removeProject() helper ---------------------------------------------

function makeTmpConfig(initialProjects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-rmproj-test-'));
  const cfg = path.join(dir, 'config.yaml');
  const yaml = require('yaml');
  fs.writeFileSync(cfg, yaml.stringify({
    port: 3000,
    projects: initialProjects || {},
  }), 'utf-8');
  return { dir, cfg };
}

test('removeProject deletes the named project and writes a .bak', () => {
  const { dir, cfg } = makeTmpConfig({
    keep: { path: '/tmp/keep' },
    drop: { path: '/tmp/drop' },
  });
  try {
    const updated = removeProject('drop', cfg);
    assert.deepEqual(Object.keys(updated), ['keep']);
    // .bak file should exist
    const baks = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));
    assert.ok(baks.length >= 1, 'expected at least one .bak file');
    // Reload + assert
    const yaml = require('yaml');
    const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
    assert.deepEqual(reloaded.projects, { keep: { path: '/tmp/keep' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeProject throws NOT_FOUND for unknown project', () => {
  const { dir, cfg } = makeTmpConfig({ a: { path: '/tmp/a' } });
  try {
    assert.throws(
      () => removeProject('nope', cfg),
      (err) => err.code === 'NOT_FOUND' && /not found/i.test(err.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeProject rejects bad name regex with BAD_NAME', () => {
  const { dir, cfg } = makeTmpConfig({ a: { path: '/tmp/a' } });
  try {
    assert.throws(
      () => removeProject('bad name with spaces', cfg),
      (err) => err.code === 'BAD_NAME',
    );
    assert.throws(
      () => removeProject('', cfg),
      (err) => err.code === 'BAD_NAME',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeProject is a no-op write when projects map ends up empty', () => {
  const { dir, cfg } = makeTmpConfig({ only: { path: '/tmp/only' } });
  try {
    const updated = removeProject('only', cfg);
    assert.deepEqual(updated, {});
    const yaml = require('yaml');
    const reloaded = yaml.parse(fs.readFileSync(cfg, 'utf-8'));
    assert.ok(reloaded.projects && Object.keys(reloaded.projects).length === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
