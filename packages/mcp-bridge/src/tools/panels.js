'use strict';

// TermDeck live-state tools — list_panels, panel_status, read_panel, recent_activity.
// All read-only. TWO orthogonal sensitivity axes:
//   (a) CONTENT axis (what data leaves): list_panels / panel_status /
//       recent_activity → METADATA ONLY; read_panel → terminal CONTENT (bounded
//       latest slice, never full history).
//   (b) APPROVAL axis (per-call human gate): ALL terminal-state tools are
//       approval-gated — the authoritative source is policy.requiresApproval()
//       (T2), which gates every live-terminal tool because, under the inverted
//       threat model, even panel metadata (project names, cwds) is private
//       egress. Memory reads are NOT gated. The `approval` flags below mirror
//       that classification as the declared default / fail-safe fallback.
// Every tool also honors the operator allowlist via policy.visiblePanels(): a
// panel outside the allowlist is invisible to ALL of these tools (even its
// existence).

const { clampInt, toolError, ok } = require('./util');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const LOCAL = { ...READ_ONLY, openWorldHint: false };

// Allowlist of panel fields that may ever leave the process (metadata only).
function panelSummary(s) {
  const m = (s && s.meta) || {};
  return {
    id: s && s.id,
    label: m.label || '',
    project: m.project || null,
    type: m.type || null,
    role: m.role || null,
    status: m.status || null,
    statusDetail: m.statusDetail || '',
    lastActivity: m.lastActivity || null,
    parked: !!m.parked,
  };
}

function formatRoster(panels) {
  if (!panels.length) return 'No visible panels.';
  const lines = panels.map((p) => (
    `• ${p.label || p.id} — ${p.project || 'no project'} · ${p.status || '?'}`
    + `${p.statusDetail ? ` (${p.statusDetail})` : ''}`
    + `${p.role ? ` · role=${p.role}` : ''} · last ${p.lastActivity || '?'}`
  ));
  return `${panels.length} visible panel${panels.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function chunkTime(chunk) {
  if (!chunk || typeof chunk !== 'object') return null;
  return chunk.created_at || chunk.ts || chunk.timestamp || null;
}

function buildPanelTools({ clients, policy }) {
  // Resolve the allowlisted set of live sessions. Every tool routes through this
  // so the allowlist is applied in exactly one place.
  async function visibleSessions() {
    const sessions = await clients.termdeck.listSessions();
    return policy.visiblePanels(sessions) || [];
  }

  return [
    {
      name: 'list_panels',
      title: 'List terminal panels',
      description:
        'List the currently visible TermDeck terminal panels (respecting the operator '
        + 'allowlist). Read-only; metadata only (id, label, project, role, status, last '
        + 'activity) — no terminal content.',
      inputSchema: () => ({}),
      annotations: { ...LOCAL, title: 'List terminal panels' },
      approval: true,
      handler: async () => {
        try {
          const panels = (await visibleSessions()).map(panelSummary);
          return ok(formatRoster(panels), { panels, count: panels.length });
        } catch (err) {
          return toolError('list_panels', err);
        }
      },
    },
    {
      name: 'panel_status',
      title: 'Panel status',
      description:
        'Status + timing for one visible panel (status, statusDetail, last activity, '
        + 'role, project, cwd). Read-only; metadata only, no terminal content.',
      inputSchema: (z) => ({ id: z.string().describe('The panel/session id (from list_panels).') }),
      annotations: { ...LOCAL, title: 'Panel status' },
      approval: true,
      handler: async (args) => {
        const { id } = args || {};
        try {
          const s = (await visibleSessions()).find((x) => x && x.id === id);
          if (!s) return toolError('panel_status', new Error(`panel not found or not visible: ${id}`));
          const m = s.meta || {};
          const structured = {
            id: s.id,
            pid: s.pid != null ? s.pid : null,
            label: m.label || '',
            project: m.project || null,
            type: m.type || null,
            role: m.role || null,
            status: m.status || null,
            statusDetail: m.statusDetail || '',
            parked: !!m.parked,
            lastActivity: m.lastActivity || null,
            createdAt: m.createdAt || null,
            cwd: m.cwd || null,
            detectedPort: m.detectedPort != null ? m.detectedPort : null,
          };
          const text = `Panel ${structured.label || structured.id}\n`
            + `  project: ${structured.project || '—'}   role: ${structured.role || '—'}   type: ${structured.type || '—'}\n`
            + `  status: ${structured.status || '?'}${structured.statusDetail ? ` (${structured.statusDetail})` : ''}${structured.parked ? ' [parked]' : ''}\n`
            + `  last activity: ${structured.lastActivity || '?'}\n`
            + `  cwd: ${structured.cwd || '—'}`
            + `${structured.detectedPort ? `\n  serving on: :${structured.detectedPort}` : ''}`;
          return ok(text, structured);
        } catch (err) {
          return toolError('panel_status', err);
        }
      },
    },
    {
      name: 'read_panel',
      title: 'Read panel output',
      description:
        "Return the LATEST slice of a visible panel's terminal output (bounded; default "
        + 'last ~4000 chars, never full history). Read-only but APPROVAL-GATED because it '
        + 'can surface live work content.',
      inputSchema: (z) => ({
        id: z.string().describe('The panel/session id (from list_panels).'),
        maxChars: z.number().optional()
          .describe('Max characters of the latest output slice to return (default 4000, capped 12000).'),
      }),
      annotations: { ...LOCAL, title: 'Read panel output' },
      approval: true,
      handler: async (args) => {
        const { id, maxChars } = args || {};
        try {
          const s = (await visibleSessions()).find((x) => x && x.id === id);
          if (!s) return toolError('read_panel', new Error(`panel not found or not visible: ${id}`));
          const cap = clampInt(maxChars, 4000, 200, 12000);
          const t = await clients.termdeck.getTranscript(id, { limit: 200 });
          const full = t && typeof t.content === 'string' ? t.content : '';
          const sliceText = full.length > cap ? full.slice(-cap) : full;
          const m = s.meta || {};
          const structured = {
            id: s.id,
            label: m.label || '',
            project: m.project || null,
            status: m.status || null,
            lastActivity: m.lastActivity || null,
            bytes: sliceText.length,
            truncated: full.length > cap,
            content: sliceText,
          };
          const header = `Panel ${structured.label || id} (${structured.project || 'no project'}) — `
            + `${structured.status || '?'}, last activity ${structured.lastActivity || '?'}`;
          const note = structured.truncated ? `\n…[showing last ${cap} of ${full.length} chars]` : '';
          const text = `${header}${note}\n\n${sliceText || '(no transcript output captured for this panel)'}`;
          return ok(text, structured);
        } catch (err) {
          return toolError('read_panel', err);
        }
      },
    },
    {
      name: 'recent_activity',
      title: 'Recent panel activity',
      description:
        'Which visible panels have been active in the last N minutes (default 60). '
        + 'Read-only; metadata only — per-panel update count + last activity time, NO '
        + 'terminal content (use read_panel for content).',
      inputSchema: (z) => ({
        sinceMinutes: z.number().optional().describe('Look-back window in minutes (default 60, capped 1440).'),
      }),
      annotations: { ...LOCAL, title: 'Recent panel activity' },
      approval: true,
      handler: async (args) => {
        const { sinceMinutes } = args || {};
        try {
          const minutes = clampInt(sinceMinutes, 60, 1, 1440);
          const [sessions, recent] = await Promise.all([
            clients.termdeck.listSessions(),
            clients.termdeck.getRecentTranscripts({ minutes }),
          ]);
          const byId = new Map((policy.visiblePanels(sessions) || []).map((s) => [s && s.id, s]));
          const activity = (recent || [])
            .filter((r) => r && byId.has(r.session_id))
            .map((r) => {
              const chunks = Array.isArray(r.chunks) ? r.chunks : [];
              const m = (byId.get(r.session_id).meta) || {};
              const last = chunks.length ? chunks[chunks.length - 1] : null;
              return {
                id: r.session_id,
                label: m.label || '',
                project: m.project || null,
                role: m.role || null,
                chunk_count: chunks.length,
                last_activity: chunkTime(last) || m.lastActivity || null,
              };
            })
            .sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')));
          const text = activity.length
            ? `${activity.length} panel${activity.length === 1 ? '' : 's'} active in the last ${minutes}m:\n`
              + activity.map((a) => (
                `• ${a.label || a.id} — ${a.project || 'no project'} · `
                + `${a.chunk_count} update${a.chunk_count === 1 ? '' : 's'} · last ${a.last_activity || '?'}`
              )).join('\n')
            : `No visible panel activity in the last ${minutes}m.`;
          return ok(text, { sinceMinutes: minutes, panels: activity, count: activity.length });
        } catch (err) {
          return toolError('recent_activity', err);
        }
      },
    },
  ];
}

module.exports = { buildPanelTools, _panelSummary: panelSummary };
