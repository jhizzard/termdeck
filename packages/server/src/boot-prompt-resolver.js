'use strict';

// Per-agent boot-prompt resolver — Sprint 47 T2.
//
// Reads a Mustache-style template from
// docs/multi-agent-substrate/boot-prompts/boot-prompt-<agent>.md, interpolates
// {{var.path}} placeholders against the provided `vars` object, and returns
// the final paste-ready string for the 4+1 inject script.
//
// Sprint 47 T3 wires the inject helper to read `lane.agent` from the lane
// definition and call resolveBootPrompt(agent, vars) per lane — that's how
// mixed 4+1 (Sprint 48+) gets agent-correct boot prompts when a sprint
// declares e.g. T1=codex / T2=gemini / T3=grok / T4=claude.
//
// Contract:
//   resolveBootPrompt(agentName, vars) -> string
//     agentName ∈ {claude, codex, gemini, grok}
//     vars    : { lane: {tag, project, topic, briefing}, sprint: {n, name, docPath} }
//   Throws on unknown agent (with the four valid options listed) or any
//   missing placeholder variable (with the dotted path reported, e.g.
//   "Missing variable: lane.tag"). No template-engine dependency — hand-rolled
//   regex interpolation, ~10 LOC. Project is no-build vanilla JS.
//
// Pure read-only: re-reads the template file on each call so authors can edit
// templates without restarting the server. The Sprint-47 templates are <1KB
// each so the disk hit is negligible.

const fs = require('fs');
const path = require('path');

const VALID_AGENTS = ['claude', 'codex', 'gemini', 'grok'];

// Resolve template directory relative to this file. __dirname is
// packages/server/src; the templates live at <repo-root>/docs/multi-agent-substrate/boot-prompts.
const DEFAULT_TEMPLATE_DIR = path.join(
  __dirname, '..', '..', '..',
  'docs', 'multi-agent-substrate', 'boot-prompts'
);

function _resolveDotted(vars, dotPath) {
  const parts = dotPath.split('.');
  let cur = vars;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) {
      return undefined;
    }
    cur = cur[p];
  }
  return cur;
}

function _interpolate(template, vars) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, dotPath) => {
    const value = _resolveDotted(vars, dotPath);
    if (value === undefined || value === null) {
      throw new Error(`Missing variable: ${dotPath}`);
    }
    return String(value);
  });
}

function resolveBootPrompt(agentName, vars, options) {
  if (!VALID_AGENTS.includes(agentName)) {
    throw new Error(
      `Unknown agent: ${agentName}. Valid agents are: ${VALID_AGENTS.join(', ')}`
    );
  }
  const dir = (options && options.templateDir) || DEFAULT_TEMPLATE_DIR;
  const filePath = path.join(dir, `boot-prompt-${agentName}.md`);
  const template = fs.readFileSync(filePath, 'utf8');
  return _interpolate(template, vars || {});
}

module.exports = {
  resolveBootPrompt,
  VALID_AGENTS,
  DEFAULT_TEMPLATE_DIR,
  // Exported for unit tests; not part of the public contract.
  _interpolate,
  _resolveDotted,
};
