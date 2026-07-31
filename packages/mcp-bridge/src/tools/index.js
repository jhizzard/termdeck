'use strict';

// buildTools — assemble the read-only MCP tool descriptors.
//
// Dependencies are INJECTED (not require()d) so this module loads and unit-tests
// with no node_modules and without T2's policy.js or T1's server.js existing yet:
//   withEgressRedaction : (handler) => handler   — from server.js (A0/T1). Wraps
//                         every handler so its result is deep-redacted before egress.
//   policy              : { visiblePanels, requiresApproval?, assertReadOnly? } — T2.
//   clients             : { mnestra, termdeck }  — this lane (src/clients).
//                         (clients.termdeck is optional when memoryOnly is set.)
//   memoryOnly          : boolean — TERMDECK_BRIDGE_MEMORY_ONLY / options.memoryOnly
//                         (resolved by bootstrap). A panel-less host (cloud origin,
//                         no TermDeck server) must not expose panel tools at all.
//   identity            : OPTIONAL { getClient(clientId) } — the OAuth clients
//                         store (Sprint 76). BOTH quarantined write channels
//                         (memory_propose, memory_session_record) mount ONLY
//                         when this is present AND policy carries the identity
//                         fns: no identity source ⇒ no write channel
//                         (fail-closed; legacy callers without it keep today's
//                         tool set untouched). Orthogonal to memoryOnly — both
//                         are memory-family tools.
//   env                 : OPTIONAL env bag for the write channels (hermetic
//                         tests; defaults to process.env). Each channel has its
//                         own default-OFF gate: TERMDECK_BRIDGE_ENABLE_PROPOSE
//                         and TERMDECK_BRIDGE_ENABLE_SESSION_RECORD.
//
// Returned descriptor shape (T1 mounts each):
//   { name, title, description,
//     inputSchema: (z) => zodRawShape,   // mount: inputSchema: z.object(t.inputSchema(z))
//     annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint, title },
//     approval: boolean,                 // authoritative via policy.requiresApproval(name)
//     handler }                          // already wrapped → returns a redacted CallToolResult

const { buildMemoryTools } = require('./memory');
const { buildPanelTools } = require('./panels');
const { buildProposeTools } = require('./propose');
const { buildSessionRecordTools } = require('./session-record');

function buildTools({ withEgressRedaction, policy, clients, memoryOnly = false, identity, env }) {
  if (typeof withEgressRedaction !== 'function') {
    throw new Error('buildTools requires a withEgressRedaction(handler) function');
  }
  if (!policy || typeof policy.visiblePanels !== 'function') {
    throw new Error('buildTools requires policy.visiblePanels (from T2)');
  }
  if (!clients || !clients.mnestra) {
    throw new Error('buildTools requires clients.mnestra (from src/clients)');
  }
  if (!memoryOnly && !clients.termdeck) {
    throw new Error('buildTools requires clients.termdeck (from src/clients) unless memoryOnly is set');
  }

  // Sprint 76: the quarantined proposal channel mounts ONLY when (a) the
  // operator has EXPLICITLY enabled it (TERMDECK_BRIDGE_ENABLE_PROPOSE=1 —
  // DEFAULT-OFF, the outermost registration condition per ORCH 13:35: the
  // live bridge runs from this working tree under supervisor auto-restart,
  // so without the gate a crash-restart would mount the write tool as a side
  // effect; absent flag = tool absent from the listing entirely) and (b)
  // every piece of its fail-closed pipeline is present (identity source +
  // policy identity fns + a propose-capable mnestra client). Anything
  // missing ⇒ the tool simply does not exist on this origin.
  const environ = env || process.env;
  const proposeEnabled = String(environ.TERMDECK_BRIDGE_ENABLE_PROPOSE || '') === '1';
  const identityReady = !!(identity && typeof identity.getClient === 'function'
    && typeof policy.mapClientToSourceAgent === 'function'
    && typeof policy.loadProposeMap === 'function');
  const canPropose = !!(proposeEnabled
    && identityReady
    && clients.mnestra && typeof clients.mnestra.propose === 'function');

  // Sprint 84: the session-capture channel gets its OWN gate,
  // TERMDECK_BRIDGE_ENABLE_SESSION_RECORD=1 — DEFAULT-OFF, and independent of
  // the propose gate on purpose. They are different trust surfaces (one queues
  // a single vetted fact for promotion; the other files a whole conversation
  // into the learning pass's input queue), so an operator who wants one is not
  // forced to take the other. Same fail-closed pipeline requirements: absent
  // any piece — flag, identity source, policy identity fns, or a
  // session-record-capable mnestra client — the tool is absent from the
  // listing entirely rather than present-and-erroring.
  const sessionRecordEnabled = String(environ.TERMDECK_BRIDGE_ENABLE_SESSION_RECORD || '') === '1';
  const canRecordSession = !!(sessionRecordEnabled
    && identityReady
    && clients.mnestra && typeof clients.mnestra.sessionRecord === 'function');

  // memoryOnly: the panel family is never BUILT — absent from tools/list rather
  // than present-but-always-erroring, so a panel-less host doesn't burn the
  // consumer chat's tool-call budget on tools that can only fail.
  const raw = [
    ...buildMemoryTools({ clients, policy }),
    ...(memoryOnly ? [] : buildPanelTools({ clients, policy })),
    ...(canPropose ? buildProposeTools({ clients, identity, policy, env }) : []),
    ...(canRecordSession ? buildSessionRecordTools({ clients, identity, policy, env }) : []),
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
