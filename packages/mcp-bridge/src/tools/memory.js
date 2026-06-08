'use strict';

// Mnestra memory tools — memory_recall + memory_search. Read-only.
// Each tool is a plain descriptor; `inputSchema` is a (z) => rawShape factory so
// this module stays zero-dependency and unit-testable with no node_modules
// (T1 injects its zod at mount: registerTool(name, { inputSchema: z.object(t.inputSchema(z)) }, handler)).

const { truncate, toolError, ok } = require('./util');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

function formatMemories(rows, { query, project, total }) {
  const scope = project ? ` (project: ${project})` : '';
  if (!rows.length) return `No memories for "${query}"${scope}.`;
  const lines = rows.map((m, i) => {
    const tags = [
      m.source_type,
      m.project,
      m.similarity != null ? `sim ${Number(m.similarity).toFixed(2)}` : null,
      m.created_at ? String(m.created_at).slice(0, 10) : null,
    ].filter(Boolean).join(' · ');
    const body = truncate(String(m.content || '').replace(/\s+/g, ' ').trim(), 500);
    return `${i + 1}. ${tags ? `[${tags}] ` : ''}${body}`;
  });
  return `${total} memor${total === 1 ? 'y' : 'ies'} for "${query}"${scope}:\n${lines.join('\n')}`;
}

function buildMemoryTools({ clients }) {
  return [
    {
      name: 'memory_recall',
      title: 'Recall memory',
      description:
        "Hybrid (semantic + keyword) recall over the developer's long-term Mnestra memory. "
        + 'Read-only. Returns the most relevant memories for a natural-language query, '
        + 'optionally scoped to a single project.',
      inputSchema: (z) => ({
        query: z.string().describe('Natural-language description of what to recall.'),
        project: z.string().optional()
          .describe('Optional project slug to scope the search (omit to search across all projects).'),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true, title: 'Recall memory' },
      approval: false,
      handler: async (args) => {
        const { query, project } = args || {};
        try {
          const { memories, total } = await clients.mnestra.recall({ query, project });
          return ok(formatMemories(memories, { query, project, total }), { memories, total });
        } catch (err) {
          return toolError('memory_recall', err);
        }
      },
    },
    {
      name: 'memory_search',
      title: 'Search memory',
      description:
        'Filtered search over Mnestra memory by query plus optional facets '
        + '(project, source_type, category). Read-only. Use when you need to narrow '
        + 'recall to a specific kind of memory.',
      inputSchema: (z) => ({
        query: z.string().describe('Search text.'),
        project: z.string().optional().describe('Optional project slug filter.'),
        source_type: z.string().optional()
          .describe('Optional source_type filter (e.g. decision, bug_fix, preference, reference).'),
        category: z.string().optional().describe('Optional category filter.'),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true, title: 'Search memory' },
      approval: false,
      handler: async (args) => {
        const { query, project, source_type: sourceType, category } = args || {};
        try {
          const { hits, total } = await clients.mnestra.search({ query, project, sourceType, category });
          return ok(formatMemories(hits, { query, project, total }), { hits, total });
        } catch (err) {
          return toolError('memory_search', err);
        }
      },
    },
  ];
}

module.exports = { buildMemoryTools, _formatMemories: formatMemories };
