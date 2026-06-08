'use strict';

// Shared helpers for tool handlers. Dependency-free.

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// A handled tool failure becomes a tidy isError result. Its `text` is still
// deep-redacted by withEgressRedaction before egress, so a backend error string
// that happens to contain a URL/token cannot leak. We never let a client
// exception propagate as an MCP transport fault — the consumer chat should see a
// clean, scrubbed message instead.
function toolError(name, err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: `⚠ ${name} failed: ${msg}` }], isError: true };
}

// A successful CallToolResult: human-readable text + machine-readable structured
// content. withEgressRedaction deep-redacts the WHOLE object as the last step.
function ok(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent };
}

module.exports = { clampInt, truncate, toolError, ok };
