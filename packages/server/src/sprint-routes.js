'use strict';

// Sprint runner endpoints — the in-dashboard 4+1 sprint runner (Sprint 37 T4).
//
// Endpoints:
//   POST /api/sprints                       create + scaffold + spawn 4 panels + inject
//   GET  /api/sprints                       list known sprints under a project
//   GET  /api/sprints/:name/status          per-lane FINDING/FIX-PROPOSED/DONE counts
//   GET  /api/sprints/:name/tail?lines=N    raw tail of STATUS.md
//
// All endpoints scope to a single project (passed via `project` query/body), so
// sprint paths resolve to `<project_path>/docs/sprint-<N>-<name>/`.
//
// Worktree isolation is opt-in (`--isolation=worktree` equivalent). When the
// caller passes `worktree: true`, each lane spawns a `git worktree add` rooted
// at `<sprint_dir>/worktrees/T<n>`. Off-by-default for v0.9.0; orchestrator
// merges + removes worktrees at sprint close (Sprint 38+).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { injectSprintPrompts } = require('./sprint-inject');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function resolveProjectPath(config, projectName) {
  if (!projectName) throw new Error('project is required');
  const proj = (config && config.projects && config.projects[projectName]) || null;
  if (!proj || !proj.path) {
    throw new Error(`unknown project: ${projectName}`);
  }
  return path.resolve(expandHome(proj.path));
}

function listExistingSprints(projectPath) {
  const docsDir = path.join(projectPath, 'docs');
  if (!fs.existsSync(docsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(docsDir)) {
    const m = entry.match(/^sprint-(\d+)-(.+)$/);
    if (!m) continue;
    const dir = path.join(docsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    out.push({
      number: parseInt(m[1], 10),
      slug: m[2],
      dir,
      relDir: path.join('docs', entry),
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

function nextSprintNumber(projectPath) {
  const all = listExistingSprints(projectPath);
  if (all.length === 0) return 1;
  return all[all.length - 1].number + 1;
}

function planningTemplate({ name, number, targetVersion, goal, lanes }) {
  const laneRows = lanes
    .map(
      (l, i) =>
        `| **T${i + 1} — ${l.name}** | ${l.goal} |`,
    )
    .join('\n');
  return `# Sprint ${number} — ${name}

**Status:** Planned.
**Target version:** ${targetVersion || '(unset)'}

## Goal

${goal || '(unset)'}

## Lanes

| Lane | Goal |
|---|---|
${laneRows}

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.
`;
}

function laneTemplate({ name, number, sprintName, lane, laneNumber, project, goal, worktree }) {
  const worktreeNote = worktree
    ? `\n## Isolation\n\nThis lane runs in a git worktree at \`docs/sprint-${number}-${sprintName}/worktrees/T${laneNumber}\` on branch \`sprint-${sprintName}-T${laneNumber}\`. Stay in that tree; the orchestrator merges at sprint close.\n`
    : '';
  return `# Sprint ${number} — T${laneNumber}: ${lane}

**Lane goal:** ${goal || '(unset)'}

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to \`docs/sprint-${number}-${sprintName}/STATUS.md\` under \`## T${laneNumber}\`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
${worktreeNote}`;
}

function statusTemplate({ name, number, lanes }) {
  const laneSections = lanes
    .map(
      (l, i) =>
        `## T${i + 1} — ${l.name}\n\n_(awaiting first entry)_\n\n---\n`,
    )
    .join('\n');
  return `# Sprint ${number} — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

Format:
\`\`\`
## T<n> — <lane name>

### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
\`\`\`

---

${laneSections}`;
}

function bootPromptTemplate({ project, number, sprintName, laneNumber, laneName, goal }) {
  // Standard 4+1 boot prompt. Format mirrors ~/.claude/CLAUDE.md § 4+1 mandate.
  return `You are T${laneNumber} in Sprint ${number} (${sprintName}). Boot sequence:
1. memory_recall(project="${project}", query="${sprintName} ${laneName}")
2. memory_recall(query="recent decisions and bugs")
3. Read ~/.claude/CLAUDE.md and ./CLAUDE.md
4. Read docs/sprint-${number}-${sprintName}/PLANNING.md
5. Read docs/sprint-${number}-${sprintName}/STATUS.md
6. Read docs/sprint-${number}-${sprintName}/T${laneNumber}-${slugify(laneName)}.md (your full briefing)

Lane goal: ${goal}

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in STATUS.md. Don't bump versions, don't touch CHANGELOG, don't commit.`;
}

function slugify(s) {
  return String(s || 'lane')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'lane';
}

// Parse STATUS.md → per-lane counts of FINDING/FIX-PROPOSED/DONE entries +
// most recent timestamp seen in any header. Cheap regex; no markdown AST.
function parseStatusMd(text) {
  const out = { lanes: {}, lastEntryAt: null };
  if (!text) return out;

  // Split by `## T<n>` headers. Anything before the first such header is
  // preamble and ignored.
  const sections = text.split(/^##\s+T(\d+)\s*[—\-:]?\s*([^\n]*)$/m);
  // sections[0] = preamble; then triples of (number, headline, body).
  for (let i = 1; i + 1 < sections.length; i += 3) {
    const num = sections[i];
    const headline = (sections[i + 1] || '').trim();
    const body = sections[i + 2] || '';
    const finding = (body.match(/^###\s+FINDING\s+—/gm) || []).length;
    const fixProposed = (body.match(/^###\s+FIX-PROPOSED\s+—/gm) || []).length;
    const done = (body.match(/^###\s+DONE\s+—/gm) || []).length;

    // Last timestamp in any `### <KIND> — YYYY-MM-DD HH:MM` header for this lane.
    let lastEntryAt = null;
    const tsRe = /^###\s+(?:FINDING|FIX-PROPOSED|DONE)\s+—\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/gm;
    let m;
    while ((m = tsRe.exec(body)) !== null) {
      if (!lastEntryAt || m[1] > lastEntryAt) lastEntryAt = m[1];
    }
    if (lastEntryAt && (!out.lastEntryAt || lastEntryAt > out.lastEntryAt)) {
      out.lastEntryAt = lastEntryAt;
    }

    out.lanes[`T${num}`] = {
      name: headline,
      finding,
      fixProposed,
      done,
      lastEntryAt,
    };
  }
  return out;
}

function findSprintDir(projectPath, sprintName) {
  const all = listExistingSprints(projectPath);
  return all.find((s) => s.slug === sprintName) || null;
}

function gitWorktreeAdd({ projectPath, worktreePath, branch }) {
  // Create the worktree directory if absent (git creates it, but parent dirs
  // must exist).
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', branch], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createSprintRoutes({ app, config, spawnTerminalSession, getSession }) {
  if (!app) throw new Error('app required');
  if (typeof spawnTerminalSession !== 'function') {
    throw new Error('spawnTerminalSession callback required');
  }
  if (typeof getSession !== 'function') {
    throw new Error('getSession callback required');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // POST /api/sprints — create scaffolding, spawn 4 panels, inject prompts.
  app.post('/api/sprints', async (req, res) => {
    const body = req.body || {};
    const {
      project,
      name,
      targetVersion,
      goal,
      lanes,
      worktree = false,
      autoInject = true,
      command,
      sprintNumber,
    } = body;

    if (!name || !SLUG_RE.test(name)) {
      return res.status(400).json({
        error: 'name must be a slug (lowercase a-z0-9 + hyphens, ≤40 chars)',
      });
    }
    if (!Array.isArray(lanes) || lanes.length !== 4) {
      return res.status(400).json({ error: 'exactly 4 lanes are required' });
    }
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i] || {};
      if (!l.name || typeof l.name !== 'string') {
        return res.status(400).json({ error: `lane T${i + 1} missing name` });
      }
    }

    let projectPath;
    try {
      projectPath = resolveProjectPath(config, project);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const number =
      Number.isInteger(sprintNumber) && sprintNumber > 0
        ? sprintNumber
        : nextSprintNumber(projectPath);

    const sprintDir = path.join(projectPath, 'docs', `sprint-${number}-${name}`);
    if (fs.existsSync(sprintDir)) {
      return res.status(409).json({ error: `sprint dir already exists: ${sprintDir}` });
    }

    // Scaffold sprint files.
    try {
      fs.mkdirSync(sprintDir, { recursive: true });
      fs.writeFileSync(
        path.join(sprintDir, 'PLANNING.md'),
        planningTemplate({ name, number, targetVersion, goal, lanes }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(sprintDir, 'STATUS.md'),
        statusTemplate({ name, number, lanes }),
        'utf8',
      );
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        const laneNumber = i + 1;
        const filename = `T${laneNumber}-${slugify(lane.name)}.md`;
        fs.writeFileSync(
          path.join(sprintDir, filename),
          laneTemplate({
            name,
            number,
            sprintName: name,
            lane: lane.name,
            laneNumber,
            project,
            goal: lane.goal,
            worktree,
          }),
          'utf8',
        );
      }
    } catch (err) {
      return res.status(500).json({ error: `scaffold failed: ${err.message}` });
    }

    // Optional worktree creation per lane.
    const worktreePaths = [];
    if (worktree) {
      try {
        for (let i = 0; i < 4; i++) {
          const wtPath = path.join(sprintDir, 'worktrees', `T${i + 1}`);
          const branch = `sprint-${name}-T${i + 1}`;
          gitWorktreeAdd({ projectPath, worktreePath: wtPath, branch });
          worktreePaths.push(wtPath);
        }
      } catch (err) {
        return res.status(500).json({
          error: `git worktree add failed: ${err.message}`,
          partialWorktrees: worktreePaths,
          sprintDir,
        });
      }
    }

    // Spawn 4 sessions.
    const sessionIds = {};
    const prompts = [];
    const panelSessions = [];
    for (let i = 0; i < 4; i++) {
      const lane = lanes[i];
      const laneNumber = i + 1;
      const cwd = worktree ? worktreePaths[i] : projectPath;
      const label = `Sprint ${number} · T${laneNumber} · ${lane.name}`;
      let session;
      try {
        session = spawnTerminalSession({
          command: command || 'claude',
          cwd,
          project,
          label,
          type: 'claude',
          reason: `sprint-${number}-${name} T${laneNumber}`,
        });
      } catch (err) {
        return res.status(500).json({
          error: `spawn failed for T${laneNumber}: ${err.message}`,
          sprintDir,
          sessionIds,
        });
      }
      panelSessions.push(session);
      sessionIds[`T${laneNumber}`] = session.id;
      prompts.push(
        bootPromptTemplate({
          project,
          number,
          sprintName: name,
          laneNumber,
          laneName: lane.name,
          goal: lane.goal,
        }),
      );
    }

    // Inject prompts (two-stage submit + verify-and-poke). Off → user kicks
    // off later via /api/sprints/:name/inject (not yet implemented for v0.9.0).
    let injectResult = null;
    if (autoInject) {
      const writeBytes = async (sessionId, bytes) => {
        const sess = getSession(sessionId);
        if (!sess || !sess.pty) throw new Error(`session ${sessionId} has no PTY`);
        sess.pty.write(bytes);
        if (typeof sess.trackInput === 'function') sess.trackInput(bytes);
        return { bytes: bytes.length };
      };
      const getStatus = async (sessionId) => {
        const sess = getSession(sessionId);
        if (!sess) return null;
        return { status: sess.meta && sess.meta.status, statusDetail: sess.meta && sess.meta.statusDetail };
      };
      try {
        injectResult = await injectSprintPrompts({
          sessionIds: panelSessions.map((s) => s.id),
          prompts,
          writeBytes,
          getStatus,
          sleep,
        });
      } catch (err) {
        injectResult = { ok: false, error: err.message };
      }
    }

    res.status(201).json({
      ok: true,
      sprintDir,
      sprintNumber: number,
      sprintName: name,
      sessionIds,
      worktreePaths,
      worktree,
      autoInject,
      inject: injectResult,
    });
  });

  // GET /api/sprints?project=foo — list sprints in a project.
  app.get('/api/sprints', (req, res) => {
    const project = req.query.project;
    if (!project) return res.status(400).json({ error: 'project query param required' });
    let projectPath;
    try {
      projectPath = resolveProjectPath(config, project);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const sprints = listExistingSprints(projectPath).map((s) => ({
      number: s.number,
      slug: s.slug,
      relDir: s.relDir,
    }));
    res.json({ project, sprints });
  });

  // GET /api/sprints/:name/status?project=foo — parse STATUS.md per-lane.
  app.get('/api/sprints/:name/status', (req, res) => {
    const project = req.query.project;
    const sprintName = req.params.name;
    if (!project) return res.status(400).json({ error: 'project query param required' });
    let projectPath;
    try {
      projectPath = resolveProjectPath(config, project);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const sprint = findSprintDir(projectPath, sprintName);
    if (!sprint) return res.status(404).json({ error: `sprint not found: ${sprintName}` });
    const statusPath = path.join(sprint.dir, 'STATUS.md');
    if (!fs.existsSync(statusPath)) {
      return res.status(404).json({ error: 'STATUS.md not found' });
    }
    const text = fs.readFileSync(statusPath, 'utf8');
    const parsed = parseStatusMd(text);
    const stat = fs.statSync(statusPath);
    res.json({
      project,
      sprintName,
      sprintNumber: sprint.number,
      lanes: parsed.lanes,
      lastEntryAt: parsed.lastEntryAt,
      lastModifiedAt: stat.mtime.toISOString(),
    });
  });

  // GET /api/sprints/:name/tail?project=foo&lines=N — raw tail of STATUS.md.
  app.get('/api/sprints/:name/tail', (req, res) => {
    const project = req.query.project;
    const sprintName = req.params.name;
    const lines = Math.max(1, Math.min(2000, parseInt(req.query.lines, 10) || 100));
    if (!project) return res.status(400).json({ error: 'project query param required' });
    let projectPath;
    try {
      projectPath = resolveProjectPath(config, project);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const sprint = findSprintDir(projectPath, sprintName);
    if (!sprint) return res.status(404).json({ error: `sprint not found: ${sprintName}` });
    const statusPath = path.join(sprint.dir, 'STATUS.md');
    if (!fs.existsSync(statusPath)) {
      return res.status(404).json({ error: 'STATUS.md not found' });
    }
    const text = fs.readFileSync(statusPath, 'utf8');
    const all = text.split(/\r?\n/);
    const tail = all.slice(-lines).join('\n');
    res.json({
      project,
      sprintName,
      sprintNumber: sprint.number,
      lines: tail.split('\n').length,
      tail,
    });
  });
}

module.exports = {
  createSprintRoutes,
  // Exported for tests + reuse:
  parseStatusMd,
  planningTemplate,
  laneTemplate,
  statusTemplate,
  bootPromptTemplate,
  slugify,
  listExistingSprints,
  nextSprintNumber,
};
