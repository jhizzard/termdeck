'use strict';

// buildTools — assemble the read-only MCP tool descriptors.
//
// Dependencies are INJECTED (not require()d) so this module loads and unit-tests
// with no node_modules and without T2's policy.js or T1's server.js existing yet:
//   withEgressRedaction : (handler) => handler   — from server.js (A0/T1). Wraps
//                         every handler so its result is deep-redacted before egress.
//   policy              : { visiblePanels, requiresApproval?, assertReadOnly? } — T2.
//   clients             : { mnestra, termdeck }  — this lane (src/clients).
//
// Returned descriptor shape (T1 mounts each):
//   { name, title, description,
//     inputSchema: (z) => zodRawShape,   // mount: inputSchema: z.object(t.inputSchema(z))
//     annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint, title },
//     approval: boolean,                 // authoritative via policy.requiresApproval(name)
//     handler }                          // already wrapped → returns a redacted CallToolResult

const { buildMemoryTools } = require('./memory');
const { buildPanelTools } = require('./panels');

function buildTools({ withEgressRedaction, policy, clients }) {
  if (typeof withEgressRedaction !== 'function') {
    throw new Error('buildTools requires a withEgressRedaction(handler) function');
  }
  if (!policy || typeof policy.visiblePanels !== 'function') {
    throw new Error('buildTools requires policy.visiblePanels (from T2)');
  }
  if (!clients || !clients.mnestra || !clients.termdeck) {
    throw new Error('buildTools requires clients.{mnestra,termdeck} (from src/clients)');
  }

  const raw = [
    ...buildMemoryTools({ clients, policy }),
    ...buildPanelTools({ clients, policy }),
  ];

  return raw.map((t) => {
    // Defense-in-depth: assert read-only at build time too (T1 also asserts at
    // mount). Guarded so a not-yet-complete policy.js can't block this lane.
    if (typeof policy.assertReadOnly === 'function') policy.assertReadOnly(t);
    const approval = typeof policy.requiresApproval === 'function'
      ? policy.requiresApproval(t.name)
      : !!t.approval;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      approval,
      handler: withEgressRedaction(t.handler),
    };
  });
}

module.exports = { buildTools };
