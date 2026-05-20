'use strict';

const DEFAULT_SUBMIT_OPTIONS = {
  gapMs: 250,
  settleMs: 400,
  snapshotDelayMs: 5000,
};

const ALLOWED_ROLES = new Set(['worker', 'auditor', 'orchestrator']);

class SprintRequestError extends Error {
  constructor(message, statusCode = 400, details = {}) {
    super(message);
    this.name = 'SprintRequestError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCliType(type) {
  if (type === 'claude') return 'claude-code';
  return type || 'shell';
}

function validateInjectBody(body) {
  const input = isPlainObject(body) ? body : {};
  if (!Array.isArray(input.panels) || input.panels.length === 0) {
    throw new SprintRequestError('panels must be a non-empty array');
  }
  if (!isPlainObject(input.variables)) {
    throw new SprintRequestError('variables must be an object');
  }

  const panels = input.panels.map((panel, index) => {
    if (!isPlainObject(panel)) {
      throw new SprintRequestError(`panels[${index}] must be an object`);
    }
    const tag = typeof panel.tag === 'string' ? panel.tag.trim() : '';
    const sessionId = typeof panel.sessionId === 'string' ? panel.sessionId.trim() : '';
    const role = typeof panel.role === 'string' ? panel.role.trim() : '';
    const laneBrief = typeof panel.lane_brief === 'string' ? panel.lane_brief.trim() : '';

    if (!tag) throw new SprintRequestError(`panels[${index}].tag is required`);
    if (!sessionId) throw new SprintRequestError(`panels[${index}].sessionId is required`);
    if (!ALLOWED_ROLES.has(role)) {
      throw new SprintRequestError(
        `panels[${index}].role must be one of: ${Array.from(ALLOWED_ROLES).join(', ')}`,
      );
    }
    if (!laneBrief) throw new SprintRequestError(`panels[${index}].lane_brief is required`);

    return { tag, sessionId, role, lane_brief: laneBrief };
  });

  return { panels, variables: { ...input.variables } };
}

function resolvePanelSessions(panels, getSession) {
  if (typeof getSession !== 'function') {
    throw new Error('getSession(sessionId) callback required');
  }
  return panels.map((panel) => {
    const session = getSession(panel.sessionId);
    if (!session) {
      throw new SprintRequestError(`session not found: ${panel.sessionId}`, 400, {
        code: 'invalid_session',
        tag: panel.tag,
        sessionId: panel.sessionId,
      });
    }
    return session;
  });
}

function defaultLoadTemplate(cliType, role, variables) {
  // T1 owns this module in Sprint 69. Resolve lazily so T2's route can load
  // before T1's engine has landed; endpoint calls surface a clear error.
  const engine = require('../templates/template-engine');
  if (!engine || typeof engine.loadTemplate !== 'function') {
    throw new Error('template-engine must export loadTemplate(cliType, role, variables)');
  }
  return engine.loadTemplate(cliType, role, variables);
}

function normalizeMissingVariables(err) {
  if (!err) return [];
  const raw =
    err.missingVariables
    || err.missing_variables
    || err.variables
    || err.variableNames
    || err.missing;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw) return [raw];
  return [];
}

function mapTemplateError(err) {
  const message = err && err.message ? err.message : String(err);
  const missingVariables = normalizeMissingVariables(err);
  const lower = message.toLowerCase();
  const name = err && err.name;
  const code = err && err.code;

  if (code === 'MODULE_NOT_FOUND' && /template-engine/.test(message)) {
    return new SprintRequestError('template engine unavailable', 503, {
      code: 'template_engine_unavailable',
      detail: message,
    });
  }

  if (
    name === 'MissingVariableError'
    || code === 'missing_variable'
    || code === 'missing_variables'
    || missingVariables.length > 0
    || (lower.includes('missing') && lower.includes('variable'))
  ) {
    return new SprintRequestError(message, 400, {
      code: 'missing_template_variables',
      missingVariables,
    });
  }

  if (
    code === 'unknown_template'
    || code === 'unknown_cli_type'
    || code === 'unknown_role'
    || lower.includes('unknown template')
    || lower.includes('unknown cli')
    || lower.includes('unknown role')
    || lower.includes('template not found')
  ) {
    return new SprintRequestError(message, 400, { code: 'template_error' });
  }

  return err;
}

async function renderInjectPanels({ panels, variables, sessions, loadTemplate }) {
  const loader = loadTemplate || defaultLoadTemplate;
  const rendered = [];

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    const session = sessions[i];
    const cliType = normalizeCliType(session && session.meta && session.meta.type);
    const templateVars = {
      ...variables,
      lane_brief: panel.lane_brief,
      lane_tag: panel.tag,
    };

    try {
      const text = await Promise.resolve(loader(cliType, panel.role, templateVars));
      if (typeof text !== 'string') {
        throw new Error('loadTemplate must return a string');
      }
      rendered.push({ ...panel, cliType, text });
    } catch (err) {
      throw mapTemplateError(err);
    }
  }

  return rendered;
}

function sessionSnapshot(panel, session) {
  const meta = (session && session.meta) || {};
  return {
    tag: panel.tag,
    sessionId: panel.sessionId,
    status: meta.status || null,
    statusDetail: meta.statusDetail || '',
    lastActivity: meta.lastActivity || null,
  };
}

function createDefaultWriteInput(getSession) {
  return async ({ sessionId, text }) => {
    const session = getSession(sessionId);
    if (!session) {
      throw new SprintRequestError(`session not found: ${sessionId}`, 400, {
        code: 'invalid_session',
        sessionId,
      });
    }
    if (!session.pty || (session.meta && session.meta.status === 'exited')) {
      throw new SprintRequestError(`Panel ${sessionId} has exited`, 410, {
        code: 'panel_exited',
        sessionId,
      });
    }
    try {
      session.pty.write(text);
      if (typeof session.trackInput === 'function') session.trackInput(text);
      session.meta.replyCount = (session.meta.replyCount || 0) + 1;
      return { ok: true, bytes: text.length, replyCount: session.meta.replyCount };
    } catch (err) {
      throw new SprintRequestError(err && err.message ? err.message : String(err), 500, {
        code: 'write_failed',
        sessionId,
      });
    }
  };
}

async function runTwoStageSubmit({
  panels,
  getSession,
  writeInput,
  sleep,
  options,
  source,
}) {
  const opts = { ...DEFAULT_SUBMIT_OPTIONS, ...(options || {}) };
  const wait = sleep || defaultSleep;
  const write = writeInput || createDefaultWriteInput(getSession);

  if (!Array.isArray(panels) || panels.length === 0) {
    throw new SprintRequestError('panels must be a non-empty array');
  }

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    await write({
      sessionId: panel.sessionId,
      text: `\x1b[200~${panel.text}\x1b[201~`,
      source: source || 'sprint',
      stage: 'paste',
      panel,
    });
    if (i < panels.length - 1) await wait(opts.gapMs);
  }

  await wait(opts.settleMs);

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    await write({
      sessionId: panel.sessionId,
      text: '\r',
      source: source || 'sprint',
      stage: 'submit',
      panel,
    });
    if (i < panels.length - 1) await wait(opts.gapMs);
  }

  if (opts.snapshotDelayMs > 0) await wait(opts.snapshotDelayMs);

  return panels.map((panel) => sessionSnapshot(panel, getSession(panel.sessionId)));
}

function sendError(res, err) {
  const mapped = err instanceof SprintRequestError ? err : new SprintRequestError(
    err && err.message ? err.message : String(err),
    err && err.statusCode ? err.statusCode : 500,
    err && err.details ? err.details : {},
  );
  return res.status(mapped.statusCode).json({
    ok: false,
    error: mapped.message,
    ...(mapped.details || {}),
  });
}

function createSprintInjectHandler({ getSession, loadTemplate, writeInput, sleep, options } = {}) {
  return async (req, res) => {
    let parsed;
    let sessions;
    try {
      parsed = validateInjectBody(req.body || {});
      sessions = resolvePanelSessions(parsed.panels, getSession);
      const rendered = await renderInjectPanels({
        panels: parsed.panels,
        variables: parsed.variables,
        sessions,
        loadTemplate,
      });
      const snapshots = await runTwoStageSubmit({
        panels: rendered,
        getSession,
        writeInput,
        sleep,
        options,
        source: 'sprint-inject',
      });
      return res.json({ ok: true, panels: snapshots });
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function createSprintInjectRoutes(opts) {
  if (!opts || !opts.app) throw new Error('app required');
  opts.app.post('/api/sprints/inject', createSprintInjectHandler(opts));
}

module.exports = {
  ALLOWED_ROLES,
  DEFAULT_SUBMIT_OPTIONS,
  SprintRequestError,
  createDefaultWriteInput,
  createSprintInjectHandler,
  createSprintInjectRoutes,
  defaultLoadTemplate,
  normalizeCliType,
  renderInjectPanels,
  resolvePanelSessions,
  runTwoStageSubmit,
  sendError,
  validateInjectBody,
};
