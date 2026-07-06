'use strict';

// scripts/proof/lib/report.js — render a run into the human report (Markdown)
// and the machine record (JSON). Pure: no I/O, no clock; the CLI stamps
// `generatedAt` and writes the files.
//
// The report is the deliverable Josh asked for: a human can read it as
// "session X cold-started, recalled N rows totaling T tokens, and here is how
// the answer changed." Every honesty guardrail is visible in the output, not
// buried in code: the answerer is named (stub runs are stamped non-evidence),
// the full frozen probe set is listed with verdicts, the reinjected block is
// shown verbatim, and a Threats-to-Validity section is always present.

const { formatMix } = require('./metrics');

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncateCell(s, n = 60) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function fmtProvenance(p) {
  if (!p) return 'NULL (unattributed)';
  const sid = p.source_session_id != null ? `\`${p.source_session_id}\`` : 'NULL';
  const agent = p.source_agent != null ? `\`${p.source_agent}\`` : 'NULL';
  const grp = p.recall_group_id != null ? `\`${p.recall_group_id}\`` : 'NULL';
  const attr = p.attributed ? '' : ' — unattributed (see Threats: MCP-stdio G2)';
  return `recall_group_id=${grp}, source_session_id=${sid}, source_agent=${agent} (origin: ${p.origin || 'unknown'})${attr}`;
}

const VERDICT_LABEL = {
  'warm-wins': '✅ warm-wins',
  'no-delta': '➖ no-delta',
  'cold-wins': '⚠️ cold-wins',
};

function renderMarkdown(run) {
  const a = run.aggregate || {};
  const evidence = run.answererIsEvidence;
  const L = [];

  L.push(`# Cold-vs-Warm Recall→Reinjection Proof — \`${run.runId}\``);
  L.push('');
  L.push(
    `**Generated:** ${run.generatedAt} · **Mode:** ${run.mode} · ` +
    `**Recall:** ${run.recallAdapter} · **Answerer:** ${run.answerer} · ` +
    `**Probes:** ${a.probes} (frozen set \`${run.probeSetChecksum}\`${run.probeSetFrozen ? ', lock ✓' : ', ⚠ lock MISMATCH'})`
  );
  L.push('');

  // Honesty banner — the first thing a reader sees.
  L.push('> **Honesty contract.** Every probe in the frozen set is run and reported below,');
  L.push('> regardless of verdict — no probe is dropped for showing no delta. The "did recall');
  L.push('> change the work" test is a mechanical grep for a memory-resident `factKey`, not a');
  L.push('> subjective read. Retrieval `score` is an **RRF value (0.01–0.3 band)**, not a 0–1');
  L.push('> cosine similarity. Reproduction command is at the bottom.');
  if (!evidence) {
    L.push('>');
    L.push('> ⚠️ **ANSWERER = stub → THIS RUN IS A PLUMBING DEMO, NOT EVIDENCE.** The stub can only');
    L.push('> surface facts already in its context, so warm-wins here proves the *harness wiring*,');
    L.push('> not the *claim*. Re-run with `--answerer="cmd:<model-cli>"` (or `anthropic`) for the');
    L.push('> real proof; an out-of-distribution model (Codex/T8) reproducing it is the anti-rig check.');
  }
  L.push('');

  // Headline
  L.push('## Headline');
  L.push('');
  L.push(`- **${a.probes}** probes · **${a.warmWins}** warm-wins · **${a.noDelta}** no-delta (both-have ${a.bothHave} / both-lack ${a.bothLack}) · **${a.coldWins}** cold-wins`);
  L.push(`- **${a.totalRowsSurfaced}** memory rows reinjected across the warm arms · **${a.totalTokensReinjected}** tokens (recall-reported) / **${a.totalTokensReinjectedBlock}** tokens (full block, via \`ceil(len/4)\`)`);
  L.push(`- **source_type mix** (all warm arms): ${formatMix(a.sourceTypeMix)}`);
  L.push(`- **provenance:** ${a.provenanceAttributed}/${a.probes} warm recalls carried non-NULL caller attribution`);
  L.push('');
  L.push(`> ${a.honestyNote}`);
  L.push('');

  // Per-probe table
  L.push('## Per-probe results');
  L.push('');
  L.push('| # | probe | query | rows | tokens | source_type mix | cold fact? | warm fact? | verdict |');
  L.push('|---|-------|-------|-----:|-------:|-----------------|:----------:|:----------:|---------|');
  (run.results || []).forEach((r, i) => {
    L.push(
      `| ${i + 1} | \`${esc(r.id)}\` | ${esc(truncateCell(r.query, 44))} | ${r.rowsSurfaced} | ${r.tokensReinjected} | ${esc(formatMix(r.sourceTypeMix))} | ${r.coldHasFact ? 'yes' : 'no'} | ${r.warmHasFact ? 'yes' : 'no'} | ${VERDICT_LABEL[r.verdict] || r.verdict} |`
    );
  });
  L.push('');

  // Per-probe detail — the verbatim reinjection + both answers.
  L.push('## Probe details — the reinjection, verbatim');
  L.push('');
  (run.results || []).forEach((r, i) => {
    L.push(`### ${i + 1}. \`${r.id}\` — ${VERDICT_LABEL[r.verdict] || r.verdict}`);
    L.push('');
    L.push(`- **Query:** ${r.query}${r.project ? ` (project: \`${r.project}\`)` : ' (all projects)'}`);
    L.push(`- **Why this probe is fair (a priori):** ${r.rationale || '(none recorded)'}`);
    L.push(`- **factKey (the memory-resident fact a correct answer must contain):** ${r.factKey}`);
    L.push(`- **Reinjected:** ${r.rowsSurfaced} rows · ${r.tokensReinjected} tokens (recall-reported) · ${r.tokensReinjectedBlock} tokens (full block, ${r.reinjectionChars} chars)`);
    L.push(`- **Provenance:** ${fmtProvenance(r.provenance)}`);
    if (r.noDeltaReason) L.push(`- **no-delta reason:** ${r.noDeltaReason === 'both-have' ? 'the fact was NOT memory-exclusive (cold already had it)' : 'recall/answerer did not surface the fact even warm'}`);
    L.push('');
    L.push('<details><summary>Reinjected memory block (what a warm session receives)</summary>');
    L.push('');
    L.push('```text');
    L.push(String(r.reinjectionText || '(empty)'));
    L.push('```');
    L.push('</details>');
    L.push('');
    L.push('**COLD answer** (no reinjection):');
    L.push('');
    L.push('```text');
    L.push(String(r.coldAnswer || '(empty)'));
    L.push('```');
    L.push('');
    L.push('**WARM answer** (recall reinjected):');
    L.push('');
    L.push('```text');
    L.push(String(r.warmAnswer || '(empty)'));
    L.push('```');
    L.push('');
  });

  // Threats to validity — ALWAYS emitted.
  L.push('## Threats to validity / limitations');
  L.push('');
  const threats = (run.threats && run.threats.length) ? run.threats : DEFAULT_THREATS;
  threats.forEach((t) => L.push(`- ${t}`));
  L.push('');

  // Reproduction
  L.push('## Reproduction');
  L.push('');
  L.push('```bash');
  L.push(run.reproCommand || `node scripts/proof/cold-vs-warm.js --recall=${run.recallAdapterSpec || 'fixture'} --answerer=${run.answererSpec || 'stub'} --mode=${run.mode}`);
  L.push('```');
  L.push('');
  L.push(`Frozen probe-set checksum: \`${run.probeSetChecksum}\` (${run.probeSetFrozen ? 'matches lock' : '⚠ DOES NOT match scripts/proof/fixtures/probes.lock — the probe set changed'}).`);
  L.push('');

  return L.join('\n');
}

const DEFAULT_THREATS = [
  'Answerer model choice matters: a stronger model may already know a "memory-resident" fact from training, turning a warm-win into an honest no-delta (both-have). The frozen probe set targets session/project-specific, post-cutoff facts to minimize this, but it cannot be eliminated — hence no-delta is reported, not hidden.',
  'MCP-stdio panel provenance flows through TermDeck\'s panel-spawn env producer (MNESTRA_SESSION_ID / MNESTRA_SOURCE_AGENT) into engram\'s recall_log env-reader — both landed file-only (T1 031 reader + T4 producer), live once ORCH applies 031 and a panel runs. Claude panels inherit the env into their MCP server; Codex-panel inheritance to its static-config MCP is an open verification item. This harness supplies caller provenance EXPLICITLY over the webhook path, so ITS recalls are attributable regardless of the panel path. NULLs above are reported as NULL, never inferred.',
  'Token counts use the recall path\'s own ceil(len/4) heuristic, not a provider tokenizer — consistent and honest for comparison, but an approximation of true billed tokens.',
  'factKey is a necessary-condition check (the fact must appear), not a full-answer-quality judgement. A warm answer could contain the fact and still be worse elsewhere; a human read of the verbatim answers above is the backstop.',
  'The COLD arm withholds recall entirely; it does not model a session that recalled and ignored the result. This isolates the reinjection variable cleanly but is a stronger contrast than every real session.',
  'Recall is non-deterministic against a live store (embedding + RRF + a moving corpus). For a fixed record, run against the frozen fixtures; a live run captures a point-in-time snapshot and should record the corpus size/date.',
];

function renderJson(run) {
  return {
    runId: run.runId,
    generatedAt: run.generatedAt,
    mode: run.mode,
    recallAdapter: run.recallAdapter,
    recallAdapterSpec: run.recallAdapterSpec,
    answerer: run.answerer,
    answererSpec: run.answererSpec,
    answererIsEvidence: run.answererIsEvidence,
    probeSetChecksum: run.probeSetChecksum,
    probeSetFrozen: run.probeSetFrozen,
    aggregate: run.aggregate,
    threats: (run.threats && run.threats.length) ? run.threats : DEFAULT_THREATS,
    results: run.results,
  };
}

module.exports = { renderMarkdown, renderJson, fmtProvenance, DEFAULT_THREATS };
