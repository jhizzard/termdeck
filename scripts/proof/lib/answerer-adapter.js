'use strict';

// scripts/proof/lib/answerer-adapter.js — pluggable "who answers the task".
//
// The harness holds EVERYTHING constant across the two arms except the
// reinjected memory block, then asks an answerer to produce an answer for each
// arm. Interface:
//
//   answerer.answer({ system, memoryBlock, task, prompt, probe, arm }) -> { text, meta? }
//
//   - memoryBlock is '' for the COLD arm and the recall text for the WARM arm.
//   - prompt is the fully composed string (system + memoryBlock + task) for
//     answerers that take one blob (cmd / anthropic).
//
// Three answerers:
//
//   stub      — deterministic, offline, ZERO evidentiary value. It simulates a
//               "context oracle": it can only surface facts that are in its
//               context (the memory block) plus an explicit worldKnowledge set
//               (default empty = a model that lacks the project-specific fact).
//               Used by the unit tests and for a plumbing dry-run. Every report
//               produced with the stub is stamped "PLUMBING DEMO — not evidence".
//
//   cmd:<cmd> — model-agnostic. Spawns <cmd>, pipes the composed prompt to its
//               stdin, reads the answer from stdout. This is the canonical LIVE
//               path and the one an out-of-distribution auditor (T8/Codex) uses
//               to reproduce the result with a DIFFERENT model — the strongest
//               possible anti-rig check. e.g. cmd:"claude -p" / cmd:"codex exec".
//
//   anthropic — convenience wrapper over @anthropic-ai/sdk (a repo devDep),
//               temperature 0, pinned model. Active only when ANTHROPIC_API_KEY
//               is set. ORCH runs this at close-out for the record.

const { spawn } = require('child_process');

const STUB_NO_INFO = '(no specific information available in my general knowledge)';

// ── stub ─────────────────────────────────────────────────────────────────────

function makeStubAnswerer({ worldKnowledge = [] } = {}) {
  const world = (Array.isArray(worldKnowledge) ? worldKnowledge : []).map(String);
  return {
    name: `stub(worldKnowledge=${world.length})`,
    live: false,
    evidence: false,
    async answer({ memoryBlock = '', arm = 'cold' } = {}) {
      // A real model synthesizes; this stub merely SURFACES what it can "see".
      // That crudeness is fine: the stub exists to test the harness plumbing
      // and verdict logic, not to be evidence. The report says so, loudly.
      const known = world.join(' ').trim();
      if (arm === 'cold' || !memoryBlock) {
        const body = known || STUB_NO_INFO;
        return { text: `Based on my general knowledge: ${body}`, meta: { stub: true, arm } };
      }
      const parts = [`Based on the recalled context:`, memoryBlock];
      if (known) parts.push(`Plus general knowledge: ${known}`);
      return { text: parts.join('\n'), meta: { stub: true, arm } };
    },
  };
}

// ── cmd ──────────────────────────────────────────────────────────────────────

function runCmd(command, input, { timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell:true so operators can pass a normal command line. This is a local
      // dev/proof tool driven by the operator's own command string — shell
      // parsing is the expected, wanted behavior, not an injection surface.
      child = spawn(command, { shell: true, env });
    } catch (err) {
      reject(new Error(`[proof] failed to spawn answerer command: ${err.message}`));
      return;
    }
    let out = '';
    let errOut = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`[proof] answerer command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`[proof] answerer command error: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`[proof] answerer command exited ${code}: ${command}\n${errOut.slice(0, 500)}`));
        return;
      }
      resolve(out);
    });
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`[proof] failed to write prompt to answerer stdin: ${err.message}`));
    }
  });
}

function makeCmdAnswerer(command, { env = process.env, timeoutMs } = {}) {
  if (!command || !String(command).trim()) {
    throw new Error('[proof] cmd answerer needs a command, e.g. --answerer="cmd:claude -p"');
  }
  const to = timeoutMs || Number(env.TERMDECK_PROOF_ANSWERER_TIMEOUT_MS) || 120000;
  return {
    name: `cmd(${command})`,
    live: true,
    evidence: true,
    async answer({ prompt, arm = 'cold' } = {}) {
      const text = await runCmd(command, prompt, { timeoutMs: to, env });
      return { text: String(text).trim(), meta: { command, arm } };
    },
  };
}

// ── anthropic (SDK) ──────────────────────────────────────────────────────────

function makeAnthropicAnswerer({ env = process.env } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY || '';
  const model = env.TERMDECK_PROOF_ANTHROPIC_MODEL || 'claude-sonnet-5';
  const maxTokens = Number(env.TERMDECK_PROOF_ANTHROPIC_MAX_TOKENS) || 1024;
  let SDK = null;
  return {
    name: `anthropic(${model})`,
    live: true,
    evidence: true,
    async answer({ system, memoryBlock = '', task, arm = 'cold' } = {}) {
      if (!apiKey) {
        throw new Error('[proof] anthropic answerer needs ANTHROPIC_API_KEY (or use --answerer="cmd:...")');
      }
      if (!SDK) {
        try {
          SDK = require('@anthropic-ai/sdk');
        } catch (err) {
          throw new Error(`[proof] @anthropic-ai/sdk not available (${err.message}); use --answerer="cmd:..." instead`);
        }
      }
      const Anthropic = SDK.default || SDK.Anthropic || SDK;
      const client = new Anthropic({ apiKey });
      const userContent = memoryBlock
        ? `## Recalled memory (reinjected at session start)\n${memoryBlock}\n\n## Task\n${task}`
        : `## Task\n${task}`;
      const msg = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: 0, // determinism — this is a measurement, not a chat
        system,
        messages: [{ role: 'user', content: userContent }],
      });
      const text = Array.isArray(msg.content)
        ? msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        : '';
      return { text, meta: { model, arm } };
    },
  };
}

/**
 * makeAnswerer('stub' | 'cmd:<command>' | 'anthropic', opts)
 * Defaults to the stub so a bare run is offline and safe (and clearly marked
 * non-evidence in the report).
 */
function makeAnswerer(spec = 'stub', { env = process.env, worldKnowledge } = {}) {
  const s = String(spec || 'stub').trim();
  if (s === 'stub') return makeStubAnswerer({ worldKnowledge });
  if (s.startsWith('cmd:')) return makeCmdAnswerer(s.slice('cmd:'.length).trim(), { env });
  if (s === 'anthropic') return makeAnthropicAnswerer({ env });
  throw new Error(`[proof] unknown answerer spec: "${spec}" (use stub | cmd:<command> | anthropic)`);
}

module.exports = {
  STUB_NO_INFO,
  runCmd,
  makeStubAnswerer,
  makeCmdAnswerer,
  makeAnthropicAnswerer,
  makeAnswerer,
};
