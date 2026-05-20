'use strict';

const {
  SprintRequestError,
  resolvePanelSessions,
  runTwoStageSubmit,
  sendError,
} = require('./inject');

const ALLOWED_NUDGE_KINDS = new Set([
  'post-landed-reminder',
  'status-check',
  'tooling-failure-recover',
  'custom',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateNudgeBody(body) {
  const input = isPlainObject(body) ? body : {};
  if (!Array.isArray(input.panels) || input.panels.length === 0) {
    throw new SprintRequestError('panels must be a non-empty array');
  }

  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!ALLOWED_NUDGE_KINDS.has(kind)) {
    throw new SprintRequestError(
      `kind must be one of: ${Array.from(ALLOWED_NUDGE_KINDS).join(', ')}`,
    );
  }

  const panels = input.panels.map((panel, index) => {
    if (!isPlainObject(panel)) {
      throw new SprintRequestError(`panels[${index}] must be an object`);
    }
    const tag = typeof panel.tag === 'string' ? panel.tag.trim() : '';
    const sessionId = typeof panel.sessionId === 'string' ? panel.sessionId.trim() : '';
    if (!tag) throw new SprintRequestError(`panels[${index}].tag is required`);
    if (!sessionId) throw new SprintRequestError(`panels[${index}].sessionId is required`);
    return { tag, sessionId };
  });

  const context = isPlainObject(input.context) ? input.context : {};
  if (kind === 'custom') {
    const text = typeof input.text === 'string'
      ? input.text
      : (typeof context.custom_text === 'string' ? context.custom_text : context.customText);
    if (typeof text !== 'string' || text.length === 0) {
      throw new SprintRequestError('custom nudge requires text or context.custom_text');
    }
  }
  if (kind === 'post-landed-reminder') {
    if (!context.open_red) {
      throw new SprintRequestError('post-landed-reminder requires context.open_red');
    }
    if (!context.test_repro && !context.testRepro) {
      throw new SprintRequestError('post-landed-reminder requires context.test_repro');
    }
  }

  return { panels, kind, context, text: input.text };
}

function valueFromMaybeObject(value, preferredKeys) {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return String(value || '');
  for (const key of preferredKeys) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  return JSON.stringify(value);
}

function buildNudgeText({ panel, kind, context, text }) {
  if (kind === 'custom') {
    return typeof text === 'string' ? text : (context.custom_text || context.customText);
  }

  if (kind === 'post-landed-reminder') {
    const sprintName = context.sprint_name || context.sprintName || 'current sprint';
    const fileLine = valueFromMaybeObject(context.open_red, ['file_line', 'fileLine', 'line']);
    const testRepro = context.test_repro || context.testRepro;
    return [
      `ORCHESTRATOR NUDGE — ${sprintName}.`,
      `${panel.tag}: T4 audit found ${fileLine} with repro ${testRepro}.`,
      `Your fix should land as \`### [${panel.tag}] LANDED ...\` to STATUS.md once tests pass and the auditor has reacted.`,
    ].join(' ');
  }

  if (kind === 'status-check') {
    const minutes = context.silent_minutes || context.silentMinutes || 'several';
    return [
      'ORCHESTRATOR STATUS-CHECK.',
      `STATUS.md has been silent for ${minutes} minutes.`,
      `Post a \`### [${panel.tag}] CHECKPOINT\` with your current progress, or \`LANDED\` if done.`,
    ].join(' ');
  }

  return [
    'ORCHESTRATOR RECOVERY — your shell tooling appears to have died.',
    'POST a final TOOLING-FAILURE CHECKPOINT to STATUS.md with what you have verified so far.',
    'The orchestrator will spawn a codex-rescue subagent as the verification fallback.',
  ].join(' ');
}

function createSprintNudgeHandler({ getSession, writeInput, sleep, options } = {}) {
  return async (req, res) => {
    try {
      const parsed = validateNudgeBody(req.body || {});
      resolvePanelSessions(parsed.panels, getSession);
      const panels = parsed.panels.map((panel) => ({
        ...panel,
        text: buildNudgeText({
          panel,
          kind: parsed.kind,
          context: parsed.context,
          text: parsed.text,
        }),
      }));
      const snapshots = await runTwoStageSubmit({
        panels,
        getSession,
        writeInput,
        sleep,
        options,
        source: 'sprint-nudge',
      });
      return res.json({ ok: true, panels: snapshots });
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function createSprintNudgeRoutes(opts) {
  if (!opts || !opts.app) throw new Error('app required');
  opts.app.post('/api/sprints/nudge', createSprintNudgeHandler(opts));
}

module.exports = {
  ALLOWED_NUDGE_KINDS,
  buildNudgeText,
  createSprintNudgeHandler,
  createSprintNudgeRoutes,
  validateNudgeBody,
};
