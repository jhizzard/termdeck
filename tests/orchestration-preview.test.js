// Sprint 37 T3 — tests for the orchestration-preview helper.
//
// These exercise buildPreview / generateScaffolding without the real
// Express server and without depending on T2's CLI modules. Templates and
// initProject are stubbed so this lane is self-contained: at sprint close,
// the orchestrator wires the production templates.js + init-project.js
// into the route layer.
//
// Run: node --test tests/orchestration-preview.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildPreview,
  generateScaffolding,
  resolveTargetPath,
  validateName,
  _PREVIEW_LINES
} = require(path.resolve(__dirname, '..', 'packages', 'server', 'src', 'orchestration-preview.js'));

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-preview-test-'));
}

// Minimal fake "templates" module matching the shape T3 proposed for T2's
// packages/cli/src/templates.js (see STATUS.md FINDING).
function fakeTemplates(spec) {
  // spec: { [name]: { targetPath, body } }
  return {
    listTemplates() {
      return Object.entries(spec).map(([name, v]) => ({ name, targetPath: v.targetPath }));
    },
    readTemplate(name) {
      if (!spec[name]) throw new Error(`unknown template ${name}`);
      return spec[name].body;
    },
    renderTemplate(name, vars) {
      if (!spec[name]) throw new Error(`unknown template ${name}`);
      return spec[name].body.replace(/\{\{(\w+)\}\}/g, (_m, k) => {
        return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{{${k}}}`;
      });
    }
  };
}

const sampleTemplates = fakeTemplates({
  'CLAUDE.md': {
    targetPath: 'CLAUDE.md',
    body: '# {{project_name}}\n\nGenerated at {{generated_at}}\n\nTermDeck v{{termdeck_version}}\nPath: {{project_path}}\n'
  },
  'CONTRADICTIONS.md': {
    targetPath: 'CONTRADICTIONS.md',
    body: '# Contradictions log for {{project_name}}\n'
  },
  'gitignore': {
    targetPath: '.gitignore',
    body: 'node_modules\n.DS_Store\n.termdeck/\n'
  }
});

// ─────────────────────────────────────────────────────────────────────────
// validateName
// ─────────────────────────────────────────────────────────────────────────

test('validateName: accepts safe identifiers', () => {
  assert.doesNotThrow(() => validateName('hello'));
  assert.doesNotThrow(() => validateName('hello-world'));
  assert.doesNotThrow(() => validateName('hello_world'));
  assert.doesNotThrow(() => validateName('hello.world'));
  assert.doesNotThrow(() => validateName('h123'));
  assert.doesNotThrow(() => validateName('1abc'));
});

test('validateName: rejects unsafe identifiers', () => {
  for (const bad of ['', 'Hello', 'hello world', 'hello/world', '../escape', 'foo..bar', '-leading', '.leading', '_leading', null, undefined, 42]) {
    assert.throws(() => validateName(bad), /Invalid project name/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('validateName: errors carry statusCode 400 for HTTP mapping', () => {
  try {
    validateName('Bad Name');
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.statusCode, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTargetPath
// ─────────────────────────────────────────────────────────────────────────

test('resolveTargetPath: existing project resolves to projects[name].path', () => {
  const tmp = freshTmpDir();
  const target = resolveTargetPath({
    name: 'foo',
    projects: { foo: { path: tmp } },
    cwd: '/some/other/cwd'
  });
  assert.equal(target, path.resolve(tmp));
});

test('resolveTargetPath: tilde-prefixed project paths expand to homedir', () => {
  const target = resolveTargetPath({
    name: 'foo',
    projects: { foo: { path: '~/some-project' } },
    cwd: '/some/other/cwd'
  });
  assert.equal(target, path.resolve(path.join(os.homedir(), 'some-project')));
});

test('resolveTargetPath: missing project falls back to cwd/name', () => {
  const tmp = freshTmpDir();
  const target = resolveTargetPath({
    name: 'fresh',
    projects: { other: { path: '/elsewhere' } },
    cwd: tmp
  });
  assert.equal(target, path.resolve(tmp, 'fresh'));
});

test('resolveTargetPath: empty projects map falls back to cwd/name', () => {
  const tmp = freshTmpDir();
  const target = resolveTargetPath({ name: 'fresh', projects: {}, cwd: tmp });
  assert.equal(target, path.resolve(tmp, 'fresh'));
});

// ─────────────────────────────────────────────────────────────────────────
// buildPreview — non-existent target (fresh name)
// ─────────────────────────────────────────────────────────────────────────

test('buildPreview: fresh name → exists:false, all templates in wouldCreate', () => {
  const tmp = freshTmpDir();
  const result = buildPreview({
    name: 'hello-world',
    projects: {},
    cwd: tmp,
    templates: sampleTemplates,
    version: '0.9.0'
  });

  assert.equal(result.projectName, 'hello-world');
  assert.equal(result.targetPath, path.resolve(tmp, 'hello-world'));
  assert.equal(result.exists, false);
  assert.equal(result.wouldCreate.length, 3);
  assert.equal(result.wouldSkip.length, 0);

  const claudeMd = result.wouldCreate.find(f => f.path === 'CLAUDE.md');
  assert.ok(claudeMd, 'CLAUDE.md present');
  assert.match(claudeMd.contentPreview, /^# hello-world/);
  assert.match(claudeMd.contentPreview, /TermDeck v0\.9\.0/);
  assert.match(claudeMd.contentPreview, new RegExp(`Path: ${path.resolve(tmp, 'hello-world').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // Body has 6 newlines → split() yields 7 entries (trailing empty from final \n).
  assert.equal(claudeMd.totalLines, 7);
  assert.match(claudeMd.renderedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('buildPreview: shape matches the documented JSON envelope', () => {
  const tmp = freshTmpDir();
  const result = buildPreview({
    name: 'shape-check',
    projects: {},
    cwd: tmp,
    templates: sampleTemplates,
    version: '0.9.0'
  });

  // Top-level keys
  assert.deepEqual(
    Object.keys(result).sort(),
    ['exists', 'projectName', 'targetPath', 'wouldCreate', 'wouldSkip']
  );

  // Per-entry keys (per T3 brief)
  for (const entry of result.wouldCreate) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['contentPreview', 'path', 'renderedAt', 'totalLines']
    );
    assert.equal(typeof entry.path, 'string');
    assert.equal(typeof entry.contentPreview, 'string');
    assert.equal(typeof entry.totalLines, 'number');
    assert.equal(typeof entry.renderedAt, 'string');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// buildPreview — existing target
// ─────────────────────────────────────────────────────────────────────────

test('buildPreview: existing project with one pre-existing file populates wouldSkip', () => {
  const tmp = freshTmpDir();
  // Pre-create CLAUDE.md so it shows up as wouldSkip.
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing\n', 'utf-8');

  const result = buildPreview({
    name: 'existing',
    projects: { existing: { path: tmp } },
    cwd: '/unused',
    templates: sampleTemplates,
    version: '0.9.0'
  });

  assert.equal(result.exists, true);
  assert.equal(result.targetPath, path.resolve(tmp));
  // CONTRADICTIONS.md and .gitignore not on disk → wouldCreate
  // CLAUDE.md is on disk → wouldSkip
  assert.equal(result.wouldCreate.length, 2);
  assert.equal(result.wouldSkip.length, 1);
  assert.equal(result.wouldSkip[0].path, 'CLAUDE.md');
  assert.match(result.wouldSkip[0].reason, /already exists/);
});

test('buildPreview: empty existing dir → exists:true but everything in wouldCreate', () => {
  const tmp = freshTmpDir();
  // Tmp dir exists but has no scaffolding files yet.
  const result = buildPreview({
    name: 'empty',
    projects: { empty: { path: tmp } },
    cwd: '/unused',
    templates: sampleTemplates,
    version: '0.9.0'
  });
  assert.equal(result.exists, true);
  assert.equal(result.wouldCreate.length, 3);
  assert.equal(result.wouldSkip.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// buildPreview — placeholder substitution & truncation
// ─────────────────────────────────────────────────────────────────────────

test('buildPreview: placeholders all substitute correctly', () => {
  const tmp = freshTmpDir();
  const result = buildPreview({
    name: 'sub-test',
    projects: {},
    cwd: tmp,
    templates: sampleTemplates,
    version: '1.2.3',
    now: () => new Date('2026-04-27T20:00:00Z')
  });
  const claudeMd = result.wouldCreate.find(f => f.path === 'CLAUDE.md');
  assert.match(claudeMd.contentPreview, /^# sub-test\n/);
  assert.match(claudeMd.contentPreview, /Generated at 2026-04-27T20:00:00\.000Z/);
  assert.match(claudeMd.contentPreview, /TermDeck v1\.2\.3/);
});

test('buildPreview: long template gets truncated at PREVIEW_LINES', () => {
  const tmp = freshTmpDir();
  const longBody = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const longTpl = fakeTemplates({
    'long.md': { targetPath: 'long.md', body: longBody }
  });
  const result = buildPreview({
    name: 'longy',
    projects: {},
    cwd: tmp,
    templates: longTpl,
    version: '0.9.0'
  });
  const entry = result.wouldCreate[0];
  assert.equal(entry.totalLines, 100);
  const previewLines = entry.contentPreview.split('\n');
  assert.equal(previewLines.length, _PREVIEW_LINES);
  assert.equal(previewLines[0], 'line 1');
  assert.equal(previewLines[_PREVIEW_LINES - 1], `line ${_PREVIEW_LINES}`);
});

// ─────────────────────────────────────────────────────────────────────────
// buildPreview — error handling
// ─────────────────────────────────────────────────────────────────────────

test('buildPreview: invalid project name throws 400', () => {
  const tmp = freshTmpDir();
  try {
    buildPreview({ name: '../evil', projects: {}, cwd: tmp, templates: sampleTemplates });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /Invalid project name/);
  }
});

test('buildPreview: missing templates module throws 503', () => {
  try {
    buildPreview({ name: 'foo', projects: {}, cwd: '/tmp', templates: null });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.statusCode, 503);
  }
});

test('buildPreview: render-time failure surfaces in wouldSkip with reason', () => {
  const tmp = freshTmpDir();
  const flakyTpl = {
    listTemplates() {
      return [
        { name: 'good.md', targetPath: 'good.md' },
        { name: 'bad.md', targetPath: 'bad.md' }
      ];
    },
    renderTemplate(name) {
      if (name === 'bad.md') throw new Error('boom');
      return '# ok\n';
    }
  };
  const result = buildPreview({
    name: 'flaky',
    projects: {},
    cwd: tmp,
    templates: flakyTpl,
    version: '0.9.0'
  });
  assert.equal(result.wouldCreate.length, 1);
  assert.equal(result.wouldSkip.length, 1);
  assert.equal(result.wouldSkip[0].path, 'bad.md');
  assert.match(result.wouldSkip[0].reason, /render failed: boom/);
});

// ─────────────────────────────────────────────────────────────────────────
// generateScaffolding
// ─────────────────────────────────────────────────────────────────────────

function fakeInitProject(spec) {
  // Writes the rendered files to disk so the post-write reread in
  // generateScaffolding finds them. Return shape mirrors what T2 might emit.
  return ({ name, dryRun, force, cwd }) => {
    if (dryRun) throw new Error('test stub: dryRun should be false in generateScaffolding path');
    const target = path.resolve(cwd, name);
    fs.mkdirSync(target, { recursive: true });
    for (const [tplName, body] of Object.entries(spec)) {
      const filePath = path.join(target, body.targetPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body.body.replace(/\{\{project_name\}\}/g, name), 'utf-8');
    }
    return { name, written: Object.keys(spec).length, force: !!force };
  };
}

test('generateScaffolding: writes files to fresh dir and returns created list', async () => {
  const tmp = freshTmpDir();
  const initProject = fakeInitProject({
    'CLAUDE.md': { targetPath: 'CLAUDE.md', body: '# {{project_name}}\n' },
    'CONTRADICTIONS.md': { targetPath: 'CONTRADICTIONS.md', body: '# log\n' }
  });

  const result = await generateScaffolding({
    name: 'newproj',
    projects: {},
    cwd: tmp,
    force: false,
    initProject,
    templates: sampleTemplates,
    version: '0.9.0'
  });

  assert.equal(result.projectName, 'newproj');
  assert.equal(result.targetPath, path.resolve(tmp, 'newproj'));
  assert.equal(result.exists, true);
  assert.equal(result.initProjectResult.written, 2);

  // Files actually exist
  assert.ok(fs.existsSync(path.join(tmp, 'newproj', 'CLAUDE.md')));
  // CLAUDE.md re-read into the response
  const claudeEntry = result.created.find(f => f.path === 'CLAUDE.md');
  assert.ok(claudeEntry);
  assert.match(claudeEntry.contentPreview, /^# newproj/);
});

test('generateScaffolding: refuses non-empty existing dir without force', async () => {
  const tmp = freshTmpDir();
  const dir = path.join(tmp, 'dirty');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'preexisting.txt'), 'hi', 'utf-8');

  const initProject = fakeInitProject({});
  await assert.rejects(
    () => generateScaffolding({
      name: 'dirty',
      projects: {},
      cwd: tmp,
      force: false,
      initProject,
      templates: sampleTemplates,
      version: '0.9.0'
    }),
    (err) => err.statusCode === 409 && /exists and is non-empty/.test(err.message)
  );
});

test('generateScaffolding: force:true bypasses the non-empty check', async () => {
  const tmp = freshTmpDir();
  const dir = path.join(tmp, 'overwrite-me');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'old.txt'), 'old', 'utf-8');

  const initProject = fakeInitProject({
    'CLAUDE.md': { targetPath: 'CLAUDE.md', body: '# {{project_name}}\n' }
  });
  const result = await generateScaffolding({
    name: 'overwrite-me',
    projects: {},
    cwd: tmp,
    force: true,
    initProject,
    templates: sampleTemplates,
    version: '0.9.0'
  });
  assert.equal(result.exists, true);
  // The old file is still there (initProject doesn't necessarily clear) but
  // CLAUDE.md was written.
  assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
});

test('generateScaffolding: surfaces a non-zero exitCode from initProject as 500', async () => {
  const tmp = freshTmpDir();
  const failingInit = async () => ({ exitCode: 1, files: [] });
  await assert.rejects(
    () => generateScaffolding({
      name: 'fails',
      projects: {},
      cwd: tmp,
      force: false,
      initProject: failingInit,
      templates: sampleTemplates,
      version: '0.9.0'
    }),
    (err) => err.statusCode === 500 && /exit code 1/.test(err.message)
  );
});

test('generateScaffolding: missing initProject throws 503', async () => {
  const tmp = freshTmpDir();
  await assert.rejects(
    () => generateScaffolding({
      name: 'foo',
      projects: {},
      cwd: tmp,
      force: false,
      initProject: null,
      templates: sampleTemplates,
      version: '0.9.0'
    }),
    (err) => err.statusCode === 503
  );
});

test('generateScaffolding: invalid name throws 400 before touching disk', async () => {
  const tmp = freshTmpDir();
  let initCalled = false;
  const initProject = async () => { initCalled = true; };
  await assert.rejects(
    () => generateScaffolding({
      name: 'Bad Name',
      projects: {},
      cwd: tmp,
      force: false,
      initProject,
      templates: sampleTemplates,
      version: '0.9.0'
    }),
    (err) => err.statusCode === 400
  );
  assert.equal(initCalled, false, 'initProject must not be called for invalid name');
});

// ─────────────────────────────────────────────────────────────────────────
// Compatibility with T2's templates module shape (listTemplates → string[])
// ─────────────────────────────────────────────────────────────────────────

test('buildPreview: accepts T2-style listTemplates() returning string[] with destFor mapper', () => {
  const tmp = freshTmpDir();
  const t2Templates = {
    listTemplates() {
      return ['CLAUDE.md.tmpl', 'docs-orchestration-README.md.tmpl', '.claude-settings.json.tmpl'];
    },
    renderTemplate(name) {
      if (name === 'CLAUDE.md.tmpl') return '# claude\nbody\n';
      if (name === 'docs-orchestration-README.md.tmpl') return '# orch\n';
      if (name === '.claude-settings.json.tmpl') return '{"permissions":{}}\n';
      throw new Error(`unknown ${name}`);
    }
  };
  const destFor = (filename, projectRoot) => {
    const map = {
      'CLAUDE.md.tmpl': 'CLAUDE.md',
      'docs-orchestration-README.md.tmpl': path.join('docs', 'orchestration', 'README.md'),
      '.claude-settings.json.tmpl': path.join('.claude', 'settings.json')
    };
    return path.join(projectRoot, map[filename]);
  };

  const result = buildPreview({
    name: 't2-shape',
    projects: {},
    cwd: tmp,
    templates: t2Templates,
    destFor,
    version: '0.9.0'
  });

  assert.equal(result.wouldCreate.length, 3);
  const paths = result.wouldCreate.map(f => f.path).sort();
  assert.deepEqual(paths, [
    '.claude/settings.json',
    'CLAUDE.md',
    path.join('docs', 'orchestration', 'README.md')
  ].sort());
});

test('buildPreview: T2-style strings without destFor → falls back to stripping .tmpl', () => {
  const tmp = freshTmpDir();
  const t2Templates = {
    listTemplates() { return ['CLAUDE.md.tmpl', 'README.md.tmpl']; },
    renderTemplate() { return 'body\n'; }
  };
  const result = buildPreview({
    name: 'no-dest',
    projects: {},
    cwd: tmp,
    templates: t2Templates,
    version: '0.9.0'
    // no destFor passed
  });
  const paths = result.wouldCreate.map(f => f.path).sort();
  assert.deepEqual(paths, ['CLAUDE.md', 'README.md']);
});

// Integration: exercise buildPreview against the real T2 templates.js + the
// real init-project.js destFor. Locks the cross-lane contract so a future
// shape change in templates.js or init-project.js fails this test rather
// than silently breaking the dashboard preview.
test('integration: buildPreview against real T2 templates module', () => {
  const tmp = freshTmpDir();
  let realTemplates;
  let realDestFor;
  try {
    realTemplates = require(path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'templates.js'));
    const initMod = require(path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'init-project.js'));
    realDestFor = initMod._destFor;
  } catch (err) {
    // T2 module not present yet — skip rather than fail. Sprint contract
    // permits T3 to ship before T2 wires in (helper has 503 fallback).
    return;
  }

  const result = buildPreview({
    name: 'integration-test',
    projects: {},
    cwd: tmp,
    templates: realTemplates,
    destFor: realDestFor,
    version: '0.9.0'
  });

  assert.equal(result.exists, false);
  // Manifest is 8 entries — preview should produce the same count.
  assert.equal(result.wouldCreate.length, 8);
  // Spot-check that the canonical files are present with their final dest paths.
  const paths = new Set(result.wouldCreate.map(f => f.path));
  assert.ok(paths.has('CLAUDE.md'));
  assert.ok(paths.has('.gitignore'));
  assert.ok(paths.has(path.join('.claude', 'settings.json')));
  assert.ok(paths.has(path.join('docs', 'orchestration', 'README.md')));
  // Placeholder substitution actually happened against the real CLAUDE.md.tmpl.
  const claude = result.wouldCreate.find(f => f.path === 'CLAUDE.md');
  assert.ok(claude);
  assert.ok(claude.contentPreview.includes('integration-test'),
    'CLAUDE.md should contain the project_name placeholder substituted');
  assert.ok(claude.totalLines > 0);
});

test('buildPreview: destFor that throws on unknown template skips that file', () => {
  const tmp = freshTmpDir();
  const t2Templates = {
    listTemplates() { return ['known.tmpl', 'unknown.tmpl']; },
    renderTemplate() { return 'x\n'; }
  };
  const destFor = (name, root) => {
    if (name === 'known.tmpl') return path.join(root, 'known');
    throw new Error(`Unknown template file: ${name}`);
  };
  const result = buildPreview({
    name: 'partial',
    projects: {},
    cwd: tmp,
    templates: t2Templates,
    destFor,
    version: '0.9.0'
  });
  // Only the known template lands in wouldCreate; the unknown one is silently dropped.
  assert.equal(result.wouldCreate.length, 1);
  assert.equal(result.wouldCreate[0].path, 'known');
});
