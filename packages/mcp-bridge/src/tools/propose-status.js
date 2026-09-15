'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// memory_propose_status — the READ half of the proposal channel (Sprint 86).
//
// WHY THIS EXISTS. `memory_propose` (Sprint 76) is fire-and-forget by design:
// the proposal lands in quarantine and an asynchronous pass promotes or rejects
// it minutes-to-hours later. That asymmetry had a cost nobody could see — a
// proposer could not distinguish "promoted", "rejected as recipe-level", and
// "the channel has been dead for six weeks". On this host the inbox went silent
// on 2026-09-06 and the silence read, from every web surface, exactly like
// success. This tool makes the disposition legible to the surface that
// submitted it.
//
// THIS IS A READ. It reports on a row that already exists; it creates nothing,
// changes nothing, and takes no argument that could. It therefore declares
// `readOnlyHint: true` honestly. Its NAME, however, tokenizes to
// ['memory','propose','status'] and 'propose' is in policy.js's MUTATING_VERBS,
// so the blunt name heuristic would reject it — hence the exact-name entry in
// policy.js::READ_ONLY_NAME_EXEMPTIONS, which demands the explicit
// readOnlyHint:true this descriptor provides. The heuristic stays blunt for
// everyone else; this is a needle, not a hole.
//
// WHAT IT DELIBERATELY DOES NOT RETURN. The proposal TEXT. The caller already
// sent it, and tool results egress through the provider cloud (see redact.js's
// inverted threat model) — re-emitting stored content for no benefit is how a
// read tool turns into a leak. Status, reason, promoted id and timestamps only.
//
// SCOPE NOTE. Mounted under the SAME TERMDECK_BRIDGE_ENABLE_PROPOSE flag as
// memory_propose: a surface that cannot propose has nothing to ask about, and
// tying them together means an operator can never end up with a status tool
// reporting on a channel they believe is off.
//
// House conventions: descriptor shape matches ./memory.js and ./propose.js;
// requires only ./util (dependency-free), so it loads and unit-tests with no
// node_modules.
// ─────────────────────────────────────────────────────────────────────────────

const { toolError, ok } = require('./util');

// A proposal id is a uuid. Validating the SHAPE here (rather than forwarding
// anything the model invents) keeps malformed ids from becoming webhook round
// trips, and makes "not found" mean what it says.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Human-facing gloss per status. The wording matters: a consumer chat reading
// this aloud must not upgrade "pending" into "saved".
function describe(rec) {
  const s = String(rec.status || '').toLowerCase();
  if (s === 'pending') {
    return 'STILL PENDING — queued in the inbox, not yet reviewed. It is not part of canonical memory '
      + 'and will not appear in memory_recall/memory_search unless it is promoted.';
  }
  if (s === 'promoted') {
    return 'PROMOTED — the review pass accepted it into canonical memory. It is now recallable.';
  }
  if (s === 'rejected') {
    return 'REJECTED — the review pass declined it. It was never added to canonical memory, and '
      + 'resubmitting the same content unchanged will be declined again.';
  }
  return `Status "${rec.status}" — not part of canonical memory unless that status is "promoted".`;
}

// buildProposeStatusTools({ clients }) → [descriptor].
function buildProposeStatusTools({ clients } = {}) {
  if (!clients || !clients.mnestra || typeof clients.mnestra.proposeStatus !== 'function') {
    throw new Error('buildProposeStatusTools requires clients.mnestra.proposeStatus');
  }

  return [
    {
      name: 'memory_propose_status',
      title: 'Check proposal status',
      description:
        'Look up what happened to a memory proposal previously submitted with memory_propose, by its id. '
        + 'Reports whether it is still pending review, was promoted into canonical memory, or was rejected '
        + '(with the reason). Read-only: this reports on a proposal, it does not create or change one. '
        + 'Use it before telling the user their memory was saved — a proposal is not saved until promoted.',
      inputSchema: (z) => ({
        proposal_id: z.string().describe(
          'The proposal id returned by memory_propose (a uuid).',
        ),
      }),
      // HONEST annotations: a pure read. Required explicitly by
      // policy.js::READ_ONLY_NAME_EXEMPTIONS — membership without this
      // assertion refuses to mount.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        title: 'Check proposal status',
      },
      approval: false, // classified in policy.requiresApproval via MEMORY_TOOLS
      handler: async (args) => {
        try {
          const raw = args && args.proposal_id != null ? String(args.proposal_id).trim() : '';
          if (!raw) {
            return toolError('memory_propose_status', new Error('proposal_id is required'));
          }
          if (!UUID_RE.test(raw)) {
            return toolError('memory_propose_status', new Error(
              'proposal_id must be the uuid returned by memory_propose',
            ));
          }

          const rec = await clients.mnestra.proposeStatus({ proposalId: raw });

          // UNKNOWN. The store answers 200 with found:false for an id it does
          // not have (mistyped, submitted from another connector, or aged out
          // of the inbox). This is a legitimate answer, not a failure — so it
          // is NOT an isError result. It must also never be softened into
          // "pending": nothing is queued, and saying otherwise would promise
          // the user a memory that is not coming.
          if (!rec || rec.found !== true) {
            const detail = rec && rec.detail ? ` ${rec.detail}` : '';
            return ok(
              `Proposal ${raw} is UNKNOWN to the memory inbox — there is no such proposal on record, so `
              + 'nothing is queued for it. It was not submitted from this connector, the id is wrong, or it '
              + `has aged out. Do NOT report it as pending or saved.${detail}`,
              { id: raw, found: false, status: 'unknown', detail: (rec && rec.detail) || null },
            );
          }

          const parts = [`Proposal ${rec.id}: ${describe(rec)}`];
          if (rec.rejectionReason) parts.push(`Reason: ${rec.rejectionReason}.`);
          if (rec.detail) parts.push(`Detail: ${rec.detail}`);
          if (rec.promotedMemoryId) parts.push(`Promoted memory id: ${rec.promotedMemoryId}.`);
          if (rec.proposedAt) parts.push(`Proposed at ${rec.proposedAt}.`);

          return ok(parts.join(' '), {
            id: rec.id,
            found: true,
            status: rec.status,
            rejection_reason: rec.rejectionReason,
            promoted_memory_id: rec.promotedMemoryId,
            proposed_at: rec.proposedAt,
            detail: rec.detail,
          });
        } catch (err) {
          return toolError('memory_propose_status', err);
        }
      },
    },
  ];
}

module.exports = { buildProposeStatusTools, UUID_RE };
