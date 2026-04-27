// Sprint 37 T3 — Orchestration preview helper.
//
// Renders the per-project scaffolding (CLAUDE.md, CONTRADICTIONS.md, etc.)
// without writing to disk so the dashboard can show "if you ran
// `termdeck init --project <name>` here, this is what would be created."
//
// All filesystem writes go through T2's initProject(); this file only
// renders previews. Templates and the writer are injected by the caller so
// the helper is unit-testable without depending on T2's CLI modules
// directly — server route wires the production deps; tests pass stubs.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same constraint T2's CLI validator should enforce. Keep these in sync if
// T2's regex differs at sprint close.
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PREVIEW_LINES = 30;

function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    const err = new Error(
      'Invalid project name: must be lowercase, start with a letter or digit, ' +
      'and contain only letters, digits, dots, underscores, or hyphens.'
    );
    err.statusCode = 400;
    throw err;
  }
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Decide where the scaffolding would land for a given project name:
//   1. If `projects[name]` exists in config, use its `.path` (tilde-expanded,
//      resolved). Preview shows what would be added/skipped against that dir.
//   2. Otherwise, target = path.resolve(cwd, name). Preview shows a fresh
//      project being created from scratch.
function resolveTargetPath({ name, projects, cwd }) {
  if (projects && Object.prototype.hasOwnProperty.call(projects, name)) {
    const proj = projects[name];
    if (proj && typeof proj.path === 'string' && proj.path) {
      return path.resolve(expandHome(proj.path));
    }
  }
  return path.resolve(cwd, name);
}

function previewContent(rendered) {
  const lines = rendered.split('\n');
  const totalLines = lines.length;
  const truncated = totalLines > PREVIEW_LINES;
  const contentPreview = truncated
    ? lines.slice(0, PREVIEW_LINES).join('\n')
    : rendered;
  return { contentPreview, totalLines, truncated };
}

// Normalize templates.listTemplates() output. T2's templates.js returns a
// flat array of filenames (e.g. 'CLAUDE.md.tmpl'); legacy/test stubs may
// return objects with explicit { name, targetPath }. Either is accepted.
//
// `destFor` maps a filename → absolute path inside the project tree. T2
// exports this from init-project.js as `_destFor`. The preview computes the
// path relative to `projectRoot` so the response payload uses repo-relative
// paths the UI can render directly.
function normalizeTemplateItems(rawItems, destFor, projectRoot) {
  const out = [];
  for (const item of rawItems) {
    if (typeof item === 'string') {
      if (typeof destFor !== 'function') {
        // No mapper available — best-effort: strip a trailing '.tmpl' and
        // use the bare name as the target path. Fine for tests and a
        // graceful fallback when init-project.js isn't on disk yet.
        const fallback = item.endsWith('.tmpl') ? item.slice(0, -'.tmpl'.length) : item;
        out.push({ name: item, targetPath: fallback });
        continue;
      }
      let abs;
      try {
        abs = destFor(item, projectRoot);
      } catch (err) {
        // Unknown template — skip rather than fail the whole preview.
        continue;
      }
      out.push({ name: item, targetPath: path.relative(projectRoot, abs) });
      continue;
    }
    if (item && typeof item === 'object' && item.name && item.targetPath) {
      out.push({ name: item.name, targetPath: item.targetPath });
    }
  }
  return out;
}

function buildPreview({ name, projects, cwd, templates, destFor, version, now }) {
  validateName(name);
  if (!templates || typeof templates.listTemplates !== 'function' ||
      typeof templates.renderTemplate !== 'function') {
    const err = new Error('templates module is missing listTemplates / renderTemplate');
    err.statusCode = 503;
    throw err;
  }

  const targetPath = resolveTargetPath({ name, projects, cwd });
  const exists = fs.existsSync(targetPath);
  const renderedAt = (now && typeof now === 'function' ? now() : new Date()).toISOString();

  const vars = {
    project_name: name,
    project_path: targetPath,
    generated_at: renderedAt,
    termdeck_version: version || '0.0.0'
  };

  const items = normalizeTemplateItems(templates.listTemplates() || [], destFor, targetPath);
  const wouldCreate = [];
  const wouldSkip = [];

  for (const item of items) {
    if (!item || !item.name || !item.targetPath) continue;
    const filePath = path.join(targetPath, item.targetPath);
    let rendered;
    try {
      rendered = templates.renderTemplate(item.name, vars);
    } catch (err) {
      // Surface render errors as a wouldSkip entry rather than failing the
      // whole preview — gives the user actionable info without breaking the
      // pane. (Most likely cause: template references a placeholder we don't
      // populate yet — coordination point with T2.)
      wouldSkip.push({
        path: item.targetPath,
        contentPreview: '',
        totalLines: 0,
        renderedAt,
        reason: `render failed: ${err.message}`
      });
      continue;
    }
    const { contentPreview, totalLines } = previewContent(rendered);
    const entry = {
      path: item.targetPath,
      contentPreview,
      totalLines,
      renderedAt
    };

    // If targetPath dir doesn't exist yet, every file is a wouldCreate.
    // If it exists, individual files that already exist are wouldSkip.
    const fileExists = exists && fs.existsSync(filePath);
    if (fileExists) {
      wouldSkip.push({ ...entry, reason: 'file already exists' });
    } else {
      wouldCreate.push(entry);
    }
  }

  return {
    projectName: name,
    targetPath,
    exists,
    wouldCreate,
    wouldSkip
  };
}

// POST handler logic. Calls T2's initProject({ dryRun: false, force, cwd, name }),
// then returns preview-shape with `created` populated. T2's initProject is
// async and returns { exitCode, files } — we await it and translate a
// non-zero exitCode into an HTTP-mappable error.
async function generateScaffolding({ name, projects, cwd, force, initProject, templates, destFor, version, now }) {
  validateName(name);
  if (typeof initProject !== 'function') {
    const err = new Error('initProject is not available — T2 init-project module not loaded');
    err.statusCode = 503;
    throw err;
  }

  const targetPath = resolveTargetPath({ name, projects, cwd });

  // Refuse on existing non-empty dir without force, mirroring T2's CLI semantics.
  if (fs.existsSync(targetPath)) {
    const entries = (() => {
      try { return fs.readdirSync(targetPath); } catch { return []; }
    })();
    const nonEmpty = entries.length > 0;
    if (nonEmpty && !force) {
      const err = new Error(
        `Target ${targetPath} exists and is non-empty. Pass { force: true } to overwrite.`
      );
      err.statusCode = 409;
      throw err;
    }
  }

  // For fresh-name case, derive the cwd we hand to initProject from targetPath's
  // parent so initProject({ name, cwd }) lands at the same targetPath.
  const initCwd = path.dirname(targetPath);
  const result = await initProject({ name, dryRun: false, force: !!force, cwd: initCwd });

  if (result && typeof result === 'object' && typeof result.exitCode === 'number' && result.exitCode !== 0) {
    const err = new Error(`initProject returned exit code ${result.exitCode}`);
    err.statusCode = 500;
    err.initProjectResult = result;
    throw err;
  }

  // Re-render to return preview-shape with `created` populated. We re-read
  // each file from disk so the response reflects exactly what landed.
  const renderedAt = (now && typeof now === 'function' ? now() : new Date()).toISOString();
  const created = [];
  if (templates && typeof templates.listTemplates === 'function') {
    const items = normalizeTemplateItems(templates.listTemplates() || [], destFor, targetPath);
    for (const item of items) {
      if (!item || !item.name || !item.targetPath) continue;
      const filePath = path.join(targetPath, item.targetPath);
      if (!fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const { contentPreview, totalLines } = previewContent(raw);
        created.push({
          path: item.targetPath,
          contentPreview,
          totalLines,
          renderedAt
        });
      } catch (err) {
        // Skip unreadable files — caller can re-fetch the preview if needed.
      }
    }
  }

  return {
    projectName: name,
    targetPath,
    exists: true,
    created,
    initProjectResult: result || null
  };
}

module.exports = {
  buildPreview,
  generateScaffolding,
  resolveTargetPath,
  validateName,
  expandHome,
  _PREVIEW_LINES: PREVIEW_LINES,
  _NAME_RE: NAME_RE
};
