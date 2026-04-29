// Projects routes — POST /api/projects (add) + DELETE /api/projects/:name
// (remove) extracted into a small factory so tests can drive them without
// bootstrapping the full server. Sprint 42 T4.
//
// Surface contract:
//
//   POST   /api/projects                       → add (existing v0.2 behavior)
//   DELETE /api/projects/:name[?force=true]    → remove
//
// DELETE semantics:
//   - 404 if the project is not in config.yaml
//   - 409 if any live PTY session has meta.project === name (i.e.
//     meta.status !== 'exited'), unless ?force=true is set
//   - On success: rewrites ~/.termdeck/config.yaml (with .bak), updates the
//     in-memory config map, broadcasts `projects_changed` to all WS clients,
//     and returns { ok, removed, projects, files_on_disk: 'untouched' }
//
// File contents at the project's `path` are NEVER touched here — the user's
// source code stays put. The dashboard modal copy reflects this so users
// don't fear data loss.

function createProjectsRoutes({
  app,
  config,
  getSessions,           // () => array of session objects with .meta.{project,status}
  addProject,            // (opts) => updated projects map (mutates config.yaml)
  removeProject,         // (name) => updated projects map (mutates config.yaml)
  broadcast,             // ({ type, projects }) => void   (optional)
}) {
  if (!app) throw new Error('createProjectsRoutes: app is required');
  if (typeof addProject !== 'function') throw new Error('createProjectsRoutes: addProject is required');
  if (typeof removeProject !== 'function') throw new Error('createProjectsRoutes: removeProject is required');

  const safeBroadcast = (payload) => {
    if (typeof broadcast !== 'function') return;
    try { broadcast(payload); }
    catch (err) { console.error('[projects-routes] broadcast failed:', err); }
  };

  // POST /api/projects — add a project, persist to config.yaml, broadcast.
  // Body: { name, path, defaultTheme?, defaultCommand? }
  app.post('/api/projects', (req, res) => {
    const { name, path: projectPath, defaultTheme, defaultCommand } = req.body || {};
    try {
      const updatedProjects = addProject({ name, path: projectPath, defaultTheme, defaultCommand });
      config.projects = updatedProjects;
      safeBroadcast({ type: 'projects_changed', projects: updatedProjects });
      res.json({ ok: true, projects: updatedProjects });
    } catch (err) {
      console.error('[config] addProject failed:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/projects/:name — remove a project. ?force=true to override
  // the live-session 409 guard. Files on disk are untouched.
  app.delete('/api/projects/:name', (req, res) => {
    const name = req.params.name;
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Project name must be non-empty and contain only letters, digits, . _ or -' });
    }

    const projects = (config && config.projects) || {};
    if (!projects[name]) {
      return res.status(404).json({ error: `Project "${name}" not found` });
    }

    const force = req.query && (req.query.force === 'true' || req.query.force === '1');

    let liveSessions = [];
    try {
      const all = (typeof getSessions === 'function' ? getSessions() : []) || [];
      liveSessions = all.filter((s) => {
        if (!s || !s.meta) return false;
        return s.meta.project === name && s.meta.status !== 'exited';
      });
    } catch (err) {
      console.error('[projects-routes] getSessions failed:', err);
      liveSessions = [];
    }

    if (liveSessions.length > 0 && !force) {
      return res.status(409).json({
        error: `Project "${name}" has ${liveSessions.length} live PTY session${liveSessions.length === 1 ? '' : 's'}. Close them first, or pass ?force=true.`,
        liveSessions: liveSessions.length,
        sessionIds: liveSessions.map((s) => s.id).filter(Boolean),
      });
    }

    let updatedProjects;
    try {
      updatedProjects = removeProject(name);
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: err.message });
      }
      if (err && err.code === 'BAD_NAME') {
        return res.status(400).json({ error: err.message });
      }
      console.error('[config] removeProject failed:', err.message);
      return res.status(500).json({ error: err.message });
    }

    config.projects = updatedProjects;
    safeBroadcast({ type: 'projects_changed', projects: updatedProjects });

    res.json({
      ok: true,
      removed: name,
      forced: !!force,
      projects: updatedProjects,
      files_on_disk: 'untouched',
    });
  });
}

module.exports = {
  createProjectsRoutes,
};
