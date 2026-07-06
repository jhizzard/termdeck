'use strict';

// scripts/proof/lib/tokens.js — token accounting for the cold-vs-warm proof.
//
// HONESTY ANCHOR: the "tokens reinjected" number is the load-bearing claim of
// this harness, so it must match — byte for byte — what a real Mnestra recall
// actually puts into a session. Every function here mirrors the production
// recall path in `engram/src/recall.ts`:
//
//   estimateTokens(text) = Math.ceil(text.length / 4)          (recall.ts:49)
//   truncate(content, 300)                                     (recall.ts:53, MAX_CONTENT_LENGTH)
//   line = `- (${source_type}${impTag})${projectTag} ${content}` (recall.ts:238)
//   header = `${K} memories (${T} tokens${scope}):`            (recall.ts:253)
//   text = `${header}\n\n${lines.join('\n')}`                  (recall.ts:276)
//   tokens_used = Σ estimateTokens(line)  — header EXCLUDED    (recall.ts:239-247)
//
// If recall.ts ever changes its formatter, this file must change with it or the
// proof silently lies. The unit tests pin the exact numbers so drift is caught.

const MAX_CONTENT_LENGTH = 300; // recall.ts MAX_CONTENT_LENGTH

/** Exact copy of recall.ts estimateTokens — the ~4-chars-per-token heuristic. */
function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/** Exact copy of recall.ts truncate. */
function truncate(content, maxLen = MAX_CONTENT_LENGTH) {
  const s = typeof content === 'string' ? content : String(content == null ? '' : content);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + '...';
}

// Render one hit exactly as recall.ts would format its line. `project` is the
// recall's project filter: when a single project is filtered, recall.ts omits
// the per-row `[project]` tag; when unfiltered ("all projects") it appends it.
function renderHitLine(hit, project) {
  const sourceType = hit && hit.source_type != null ? String(hit.source_type) : 'fact';
  const imp = hit && hit.metadata && hit.metadata.importance
    ? hit.metadata.importance
    : (hit && hit.importance) || '';
  const impTag = imp ? `/${imp}` : '';
  const projectTag = project ? '' : ` [${hit && hit.project != null ? hit.project : 'global'}]`;
  const content = truncate(hit ? hit.content : '', MAX_CONTENT_LENGTH);
  return `- (${sourceType}${impTag})${projectTag} ${content}`;
}

/**
 * Rebuild the reinjection block (header + lines) from raw hits, byte-identical
 * to recall.ts. Used ONLY when a recall adapter returns hits without a `text`
 * field (e.g. a raw SQL/log capture). When the adapter already carries the real
 * `text` (the webhook/MCP RecallOutput), the harness uses THAT verbatim and
 * never calls this — measuring reality, not a reconstruction.
 *
 * Returns { text, tokens_used } where tokens_used sums per-line tokens and
 * EXCLUDES the header, exactly as recall.ts reports it.
 */
function renderReinjection(hits, { project = null } = {}) {
  const rows = Array.isArray(hits) ? hits : [];
  const lines = [];
  let tokensUsed = 0;
  for (const h of rows) {
    const line = renderHitLine(h, project);
    lines.push(line);
    tokensUsed += estimateTokens(line);
  }
  const scope = project ? `, project: ${project}` : ', all projects';
  const header = `${rows.length} memories (${tokensUsed} tokens${scope}):`;
  const text = rows.length ? `${header}\n\n${lines.join('\n')}` : 'No relevant memories found.';
  return { text, tokens_used: tokensUsed };
}

/**
 * The two honest token numbers for a reinjection, both via ceil(len/4):
 *   - tokens_used:  Σ per-line tokens as recall.ts reports it (header excluded).
 *                   This is the "payload" number recall itself advertises.
 *   - block_tokens: estimateTokens(full text) — header + blank line + lines.
 *                   This is what ACTUALLY enters the session context window.
 * We surface both so a reader can't be misled by either framing.
 */
function measureReinjection(recall) {
  const text = recall && typeof recall.text === 'string' ? recall.text : '';
  const reported = recall && Number.isFinite(recall.tokens_used) ? recall.tokens_used : null;
  const block_tokens = estimateTokens(text);
  return {
    tokens_used: reported != null ? reported : block_tokens,
    tokens_used_source: reported != null ? 'recall.tokens_used' : 'derived(estimateTokens(text))',
    block_tokens,
    chars: text.length,
  };
}

module.exports = {
  MAX_CONTENT_LENGTH,
  estimateTokens,
  truncate,
  renderHitLine,
  renderReinjection,
  measureReinjection,
};
