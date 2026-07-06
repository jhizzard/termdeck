'use strict';

// scripts/proof/lib/runner.js — the per-probe orchestration, factored out of the
// CLI so the unit tests exercise the REAL arm-wiring (compose → cold → recall →
// warm → compute) rather than a reimplementation that could drift from it.

const { computeProbeResult, rankDelta } = require('./metrics');

function composePrompt(system, memoryBlock, task) {
  return memoryBlock
    ? `${system}\n\n## Recalled memory (reinjected at session start)\n${memoryBlock}\n\n## Task\n${task}`
    : `${system}\n\n## Task\n${task}`;
}

// Axis 1 (headline): COLD (no reinjection) vs WARM (recall reinjected). The ONLY
// variable between the arms is the memory block, so any answer delta is
// attributable to reinjection.
async function runReinjectionProbe({ probe, recallAdapter, answerer, system, sessionId, sourceAgent }) {
  const coldPrompt = composePrompt(system, '', probe.task);
  const coldAnswer = await answerer.answer({
    system, memoryBlock: '', task: probe.task, prompt: coldPrompt, probe, arm: 'cold',
  });

  const recall = await recallAdapter.recall(probe, { variant: 'warm', sessionId, sourceAgent });
  const memoryBlock = recall.text || '';
  const warmPrompt = composePrompt(system, memoryBlock, probe.task);
  const warmAnswer = await answerer.answer({
    system, memoryBlock, task: probe.task, prompt: warmPrompt, probe, arm: 'warm',
  });

  return computeProbeResult({ probe, recall, coldAnswer, warmAnswer });
}

// Axis 2 (parks on T1 032 + T2): both arms recall; the delta is RANKING. "cold"
// role = boost-off, "warm" role = boost-on; the verdict is "did boost-on surface
// the fact boost-off missed", and rankDelta captures the ordering change.
async function runBoostProbe({ probe, recallAdapter, answerer, system, sessionId, sourceAgent }) {
  const recallOff = await recallAdapter.recall(probe, { variant: 'boost-off', sessionId, sourceAgent });
  const recallOn = await recallAdapter.recall(probe, { variant: 'boost-on', sessionId, sourceAgent });
  const offPrompt = composePrompt(system, recallOff.text || '', probe.task);
  const onPrompt = composePrompt(system, recallOn.text || '', probe.task);
  const offAnswer = await answerer.answer({
    system, memoryBlock: recallOff.text || '', task: probe.task, prompt: offPrompt, probe, arm: 'cold',
  });
  const onAnswer = await answerer.answer({
    system, memoryBlock: recallOn.text || '', task: probe.task, prompt: onPrompt, probe, arm: 'warm',
  });
  const result = computeProbeResult({ probe, recall: recallOn, coldAnswer: offAnswer, warmAnswer: onAnswer });
  result.rankDelta = rankDelta(recallOff, recallOn);
  result.boostOff = {
    rowsSurfaced: (recallOff.hits || []).length,
    tokensReinjected: recallOff.tokens_used,
  };
  return result;
}

module.exports = { composePrompt, runReinjectionProbe, runBoostProbe };
