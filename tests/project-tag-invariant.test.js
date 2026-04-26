'use strict';

// Project-tag invariant probes — Sprint 34 T3.
//
// Guards against the v0.7.1 regression where TermDeck content was being
// written to memory_items with project='chopin-nashville' instead of
// project='termdeck'. The 2026-04-26 snapshot showed 1,126 chopin-nashville
// rows of TermDeck content vs 68 correctly-tagged termdeck rows; the
// bridge's strict `WHERE project=filter_project` walled TermDeck panels off
// from their own memories. Sprint 34 T1 fixed the writer; T2 backfilled the
// corpus; this test pins the invariant so the regression cannot go silent.
//
// Skip pattern mirrors failure-injection.test.js: when there is no
// DATABASE_URL (in process.env or ~/.termdeck/secrets.env) or the connection
// fails, the suite skips gracefully so CI without a live store stays green.
//
// Run: node --test tests/project-tag-invariant.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// Optional deps. If `pg` or the dotenv-io helper is missing for some reason,
// degrade to skip rather than throw at module load.
let Client = null;
try { ({ Client } = require('pg')); } catch { /* skip when pg absent */ }

let readSecrets = null;
try {
  ({ readSecrets } = require('../packages/server/src/setup/dotenv-io'));
} catch { /* skip when helper missing */ }

const SECRETS_PATH = path.join(os.homedir(), '.termdeck', 'secrets.env');
const CONNECT_TIMEOUT_MS = 4000;
const QUERY_TIMEOUT_MS = 8000;

// Projects whose own dominance is expected and therefore exempt from the
// "no project owns >60%" rule. `pvb` is Josh's largest active codebase by
// memory volume; chopin-nashville was historically dominant but only because
// of the bug we're testing for, so it is NOT on this allowlist.
const EXEMPT_DOMINANT_PROJECTS = new Set(['pvb']);

// Content-vs-tag invariant table. Each entry says: rows whose `content`
// matches ANY of `identifiers` should be tagged `expected` more than any
// other project. Identifiers are case-insensitive ILIKE patterns and are
// chosen to be project-discriminating (they should not appear in unrelated
// projects' memory content).
const INVARIANTS = [
  {
    label: 'termdeck',
    expected: 'termdeck',
    identifiers: [
      '%@jhizzard/termdeck%',
      '%packages/server/src%',
      '%packages/cli/src%',
      '%packages/client/public%',
    ],
  },
  {
    label: 'pvb (petvetbid)',
    expected: 'pvb',
    identifiers: [
      '%petvetbid%',
      '%petvetbridge%',
    ],
  },
  {
    label: 'claimguard (gorgias-ticket-monitor)',
    expected: 'claimguard',
    identifiers: [
      '%gorgias-ticket-monitor%',
      '%Unagi/%',
    ],
    // v0.7.2 Sprint 34 backfill scoped to project='chopin-nashville' only.
    // Claimguard content is mis-tagged as 'gorgias' (368 rows) and
    // 'gorgias-ticket-monitor' (117 rows) on rows that were never tagged
    // chopin-nashville. The harness-hook fix in Sprint 35 (PERMANENT TODO
    // memory) addresses the upstream source; a follow-on backfill SQL
    // covers these tags. Skipped here until Sprint 35 ships.
    deferredToSprint35: 'gorgias→claimguard tag drift outside chopin-nashville scope',
  },
  {
    label: 'mnestra (engram dir)',
    expected: 'mnestra',
    identifiers: [
      '%@jhizzard/mnestra%',
      '%Graciella/engram%',
    ],
    // Same deferral: ~379 'global'-tagged rows contain mnestra content but
    // were never tagged chopin-nashville. Sprint 35 broader backfill
    // catches these. The chopin-nashville→mnestra path was healed by v0.7.2
    // (5 rows reclassified).
    deferredToSprint35: 'global→mnestra tag drift outside chopin-nashville scope',
  },
];

function readSecretsEnvUrl() {
  if (!readSecrets) return null;
  try {
    const secrets = readSecrets(SECRETS_PATH);
    return secrets?.DATABASE_URL || null;
  } catch {
    return null;
  }
}

function resolveDatabaseUrl() {
  return process.env.DATABASE_URL || readSecretsEnvUrl();
}

let client = null;
let skipReason = '';

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runSql(sql, params = []) {
  if (!client) throw new Error('no client (test should have skipped)');
  const result = await withTimeout(client.query(sql, params), QUERY_TIMEOUT_MS, sql.slice(0, 60));
  return result.rows;
}

before(async () => {
  if (!Client) {
    skipReason = 'pg module not installed — cannot probe Postgres';
    return;
  }
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    skipReason = 'no DATABASE_URL in process.env or ~/.termdeck/secrets.env';
    return;
  }
  const candidate = new Client({
    connectionString: databaseUrl,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  try {
    await withTimeout(candidate.connect(), CONNECT_TIMEOUT_MS, 'pg connect');
    // Verify the schema we expect actually exists. If memory_items isn't
    // there, we're pointed at a non-Mnestra Postgres and shouldn't run.
    await withTimeout(
      candidate.query("SELECT 1 FROM memory_items LIMIT 1"),
      QUERY_TIMEOUT_MS,
      'memory_items probe',
    );
    client = candidate;
  } catch (err) {
    skipReason = `pg connect/probe failed: ${err.message}`;
    try { await candidate.end(); } catch { /* best effort */ }
  }
});

after(async () => {
  if (client) {
    try { await client.end(); } catch { /* best effort */ }
  }
});

test('project distribution: no single project owns >60% of the corpus (except known-dominant)', async (t) => {
  if (!client) return t.skip(skipReason);

  const rows = await runSql(
    'SELECT project, count(*)::int AS n FROM memory_items GROUP BY 1'
  );
  assert.ok(rows.length > 0, 'memory_items appears empty — corpus not populated');

  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  const top = rows.slice().sort((a, b) => Number(b.n) - Number(a.n))[0];
  const share = total > 0 ? Number(top.n) / total : 0;
  const pct = Math.round(share * 100);

  t.diagnostic(`top project: ${top.project} owns ${top.n}/${total} (${pct}%)`);

  if (share > 0.60 && !EXEMPT_DOMINANT_PROJECTS.has(top.project)) {
    // Surface the full distribution so a reviewer can tell at a glance
    // whether this is the chopin-nashville regression coming back or a
    // legitimate corpus-shape change that warrants updating the allowlist.
    const dist = rows
      .slice()
      .sort((a, b) => Number(b.n) - Number(a.n))
      .map((r) => `  ${r.project}: ${r.n}`)
      .join('\n');
    t.diagnostic(`full distribution:\n${dist}`);
    assert.fail(
      `top project "${top.project}" owns ${pct}% of corpus (${top.n}/${total}) ` +
      `— possible mis-tag regression. Allowlist exempt-dominants in EXEMPT_DOMINANT_PROJECTS ` +
      `if this share is legitimate.`
    );
  }
});

for (const inv of INVARIANTS) {
  test(`content-vs-tag invariant: rows containing ${inv.label} identifiers are tagged "${inv.expected}"`, async (t) => {
    if (!client) return t.skip(skipReason);
    if (inv.deferredToSprint35) {
      return t.skip(`Sprint 35 deferred: ${inv.deferredToSprint35}`);
    }

    // Build `content ILIKE $1 OR content ILIKE $2 OR ...` from identifiers.
    const orClause = inv.identifiers.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ');
    const sql =
      `SELECT project, count(*)::int AS n FROM memory_items
       WHERE ${orClause}
       GROUP BY 1
       ORDER BY 2 DESC
       LIMIT 5`;
    const rows = await runSql(sql, inv.identifiers);

    if (rows.length === 0) {
      // No content matches at all — corpus may not yet contain rows for
      // this project. Skip rather than fail, because a brand-new install
      // legitimately has no pvb/claimguard/mnestra content yet.
      return t.skip(`no rows match ${inv.label} identifiers — corpus may be too small`);
    }

    const top = rows[0];
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    t.diagnostic(
      `${inv.label}: ${rows.map((r) => `${r.project}=${r.n}`).join(', ')} (top ${top.project}=${top.n}/${total})`
    );

    assert.equal(
      top.project, inv.expected,
      `${inv.label} content rows are top-tagged "${top.project}" (${top.n}/${total}) — expected "${inv.expected}". ` +
      `This is the project-tag mis-classification regression Sprint 34 fixed; if it has come back, the writer chain ` +
      `(rag.js resolveProjectName / mnestra-bridge tag-emission / Rumen synthesis) is bypassing canonical resolution.`
    );
  });
}

// Extra guard: ensure chopin-nashville did NOT win the termdeck-content
// query even as a runner-up that might mask a partial regression. The
// post-backfill expectation is termdeck-content rows tagged chopin-nashville
// drop to a small residual; if chopin-nashville is still >25% of termdeck-
// identifier rows, the writer is still mis-tagging new sessions.
test('residual guard: chopin-nashville is not the runner-up for termdeck-content rows', async (t) => {
  if (!client) return t.skip(skipReason);

  const identifiers = [
    '%@jhizzard/termdeck%',
    '%packages/server/src%',
    '%packages/cli/src%',
  ];
  const orClause = identifiers.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ');
  const rows = await runSql(
    `SELECT project, count(*)::int AS n FROM memory_items
     WHERE ${orClause}
     GROUP BY 1`,
    identifiers,
  );

  if (rows.length === 0) {
    return t.skip('no termdeck-content rows in corpus');
  }

  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const cn = rows.find((r) => r.project === 'chopin-nashville');
  if (!cn) {
    t.diagnostic(`no chopin-nashville rows in termdeck-content set — clean.`);
    return;
  }

  const share = Number(cn.n) / total;
  const pct = Math.round(share * 100);
  t.diagnostic(`chopin-nashville share of termdeck-content rows: ${cn.n}/${total} (${pct}%)`);

  assert.ok(
    share < 0.25,
    `${pct}% of termdeck-identifier rows are still tagged chopin-nashville (${cn.n}/${total}) — ` +
    `writer-side fix may have regressed or backfill missed a heuristic branch.`
  );
});
