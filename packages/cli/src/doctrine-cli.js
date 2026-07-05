// `termdeck doctrine list|ratify|reject|promote <id>` — Sprint 79 T3.
//
// The ratify side of the elevation pipeline: rumen's doctrine-scan detects +
// drafts (DB-only); packages/server/src/doctrine-sync.js materializes a
// drafted row into a PR (default-OFF background timer); THIS file is the
// human-driven half — list what's pending, ratify a merged PR (which
// direct-INSERTs the flow-back memory_items row), or reject/promote.
//
// Operator-local by design (mirrors doctrine-sync.js): every subcommand here
// needs TERMDECK_DOCTRINE_REPO (or --repo) to resolve the git checkout for
// `gh pr` lookups + the live doctrine/registry.jsonl update, and DATABASE_URL
// (env or ~/.termdeck/secrets.env) for the rumen doctrine_registry table.
// None of this runs on an external user's install.
//
// Module contract: module.exports = async function doctrineCli(argv): Promise<exitCode>
//   0 = success, 1 = usage/validation error or refused action, 2 = infra
//   failure (no DATABASE_URL, can't resolve repo, pg/gh unavailable).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const docSync = require(path.join(__dirname, '..', '..', 'server', 'src', 'doctrine-sync.js'));

const HELP = `
termdeck doctrine <subcommand>

  list [--status=<status>]      List rumen doctrine_registry rows (default: all)
  ratify <id>                   Flip a merged-PR 'proposed' row to 'active' +
                                 direct-INSERT the flow-back memory_items row
  reject <id> [--reason=<text>] Mark a row 'rejected' (closes an open PR, best-effort)
  promote <id>                  Mark an already-'active' doctrine ready for a
                                 future advise->gate PreToolUse-deny surface
                                 (Sprint 80 builds the actual gate mechanism;
                                 this only stages the registry metadata)

Requires TERMDECK_DOCTRINE_REPO (or --repo <path>) + DATABASE_URL
(env or ~/.termdeck/secrets.env). Operator-local — not part of a normal
external-user install.
`;

// ---------------------------------------------------------------------------
// stripPrivate — small faithful CJS port of engram/src/privacy.ts.
// termdeck (vanilla JS/CJS) cannot cross-repo-require engram's TS module, so
// this is a deliberate small duplication, not a shared import. Semantics
// MUST stay identical: closed <private>...</private> -> [redacted]
// (case-insensitive, spans newlines, nested-tolerant); an UNCLOSED tag is
// left as literal text (never silently swallows the remainder).
// ---------------------------------------------------------------------------

const PRIVATE_OPEN_TAG = /<private\b[^>]*>/gi;
const PRIVATE_CLOSE_TAG = /<\/private\s*>/gi;

function stripPrivate(text) {
  if (!text || text.indexOf('<') === -1) return { text, hadPrivate: false };

  let hadPrivate = false;
  let out = '';
  let i = 0;

  while (i < text.length) {
    PRIVATE_OPEN_TAG.lastIndex = i;
    const open = PRIVATE_OPEN_TAG.exec(text);
    if (!open) { out += text.slice(i); break; }

    out += text.slice(i, open.index);

    let depth = 1;
    let cursor = open.index + open[0].length;
    while (depth > 0 && cursor < text.length) {
      PRIVATE_OPEN_TAG.lastIndex = cursor;
      PRIVATE_CLOSE_TAG.lastIndex = cursor;
      const nextOpen = PRIVATE_OPEN_TAG.exec(text);
      const nextClose = PRIVATE_CLOSE_TAG.exec(text);

      if (!nextClose) {
        out += text.slice(open.index);
        return { text: out, hadPrivate };
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose.index + nextClose[0].length;
      }
    }
    out += '[redacted]';
    hadPrivate = true;
    i = cursor;
  }
  return { text: out, hadPrivate };
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
    else positional.push(arg);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// repo / db resolution
// ---------------------------------------------------------------------------

function runGitQuiet(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 });
  return { ok: !res.error && res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function resolveRepoPath(flags) {
  if (flags.repo) return path.resolve(String(flags.repo));
  if (process.env.TERMDECK_DOCTRINE_REPO) return process.env.TERMDECK_DOCTRINE_REPO;
  const top = runGitQuiet(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (top.ok && top.stdout) return top.stdout;
  return null;
}

function resolveSecrets() {
  let dotenv;
  try { dotenv = require(path.join(__dirname, '..', '..', 'server', 'src', 'setup', 'dotenv-io')); }
  catch (_e) { dotenv = null; }
  const secretsPath = path.join(os.homedir(), '.termdeck', 'secrets.env');
  const fromFile = (dotenv && fs.existsSync(secretsPath)) ? dotenv.readSecrets(secretsPath) : {};
  return {
    DATABASE_URL: process.env.DATABASE_URL || fromFile.DATABASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || fromFile.OPENAI_API_KEY,
  };
}

async function connectPg(databaseUrl) {
  const pg = docSync.requirePg();
  if (!pg) throw new Error('the "pg" module is not installed');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function fetchRowById(client, id) {
  const res = await client.query(
    `select id, status, title, doctrine_text, cluster_member_ids, member_content_hashes,
            occurrence_count, reinforced_after_ratification, projects, origin, evidence,
            trigger_hints, rejection_reason, synthesized_at, created_at, updated_at
       from doctrine_registry where id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

// ---------------------------------------------------------------------------
// registry.jsonl helpers (LIVE checkout — safe here: ratify/reject/promote
// are synchronous, human/ORCH-triggered one-shot actions, not the background
// timer, which is the one thing AMEND-4 forbids from touching the live tree)
// ---------------------------------------------------------------------------

function readRegistryLines(repoPath) {
  const registryPath = path.join(repoPath, 'doctrine', 'registry.jsonl');
  if (!fs.existsSync(registryPath)) return { registryPath, lines: [] };
  const raw = fs.readFileSync(registryPath, 'utf8');
  return { registryPath, lines: raw.split(/\r?\n/) };
}

function writeRegistryLines(registryPath, lines) {
  const body = lines.filter((l, i) => l.trim() !== '' || i < lines.length - 1).join('\n');
  fs.writeFileSync(registryPath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

// Find the line for `entryId`, mutate its parsed JSON via `mutator`, validate,
// write back. Returns { ok, reason? }.
function updateRegistryEntry(repoPath, entryId, doctrine, mutator) {
  const { registryPath, lines } = readRegistryLines(repoPath);
  if (!lines.length) return { ok: false, reason: `doctrine/registry.jsonl not found or empty under ${repoPath}` };

  let found = false;
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return line;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (_e) { return line; }
    if (obj.id !== entryId) return line;
    found = true;
    const mutated = mutator(obj);
    const v = doctrine.validateEntry(mutated);
    if (!v.valid) throw new Error(`mutated entry '${entryId}' would be invalid: ${v.errors.join('; ')}`);
    return JSON.stringify(mutated);
  });

  if (!found) return { ok: false, reason: `no doctrine/registry.jsonl entry with id '${entryId}' on the live checkout — has its PR merged to main yet?` };

  writeRegistryLines(registryPath, nextLines);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// gh pr lookup — same branch-name convention doctrine-sync.js used to open it.
// ---------------------------------------------------------------------------

function findPrForRow(repoPath, row, opts = {}) {
  const branch = docSync.branchNameFor(row);
  const ghBin = opts.ghBin || 'gh';
  const res = spawnSync(ghBin, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,number,state,title', '--limit', '1'],
    { cwd: repoPath, encoding: 'utf8', timeout: 15000 });
  if (res.error || res.status !== 0) {
    return { ok: false, reason: (res.stderr || (res.error && res.error.message) || 'gh pr list failed').trim() };
  }
  let parsed;
  try { parsed = JSON.parse(res.stdout || '[]'); } catch (_e) { return { ok: false, reason: 'could not parse gh pr list output' }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: true, pr: null, branch };
  return { ok: true, pr: parsed[0], branch };
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function fmtRow(row) {
  const id8 = docSync.shortId(row.id);
  const status = String(row.status || '').padEnd(9);
  const occ = String(row.occurrence_count != null ? row.occurrence_count : '').padStart(3);
  const projects = (Array.isArray(row.projects) ? row.projects.join(',') : '').slice(0, 24);
  const title = truncateForTable(row.title || '(untitled)', 44);
  return `${id8}  ${status}  occ:${occ}  ${projects.padEnd(24)}  ${title}`;
}
function truncateForTable(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

async function cmdList(client, flags) {
  const statusFilter = flags.status ? String(flags.status) : null;
  const res = await client.query(
    statusFilter
      ? `select id, status, title, occurrence_count, projects, updated_at from doctrine_registry where status = $1 order by updated_at desc`
      : `select id, status, title, occurrence_count, projects, updated_at from doctrine_registry order by updated_at desc`,
    statusFilter ? [statusFilter] : []
  );
  if (res.rows.length === 0) {
    console.log(statusFilter ? `No doctrine_registry rows with status='${statusFilter}'.` : 'doctrine_registry is empty.');
    return 0;
  }
  console.log('id        status     occurrence  projects                  title');
  for (const row of res.rows) console.log(fmtRow(row));
  return 0;
}

async function cmdRatify(client, repoPath, doctrine, id, opts = {}) {
  const row = await fetchRowById(client, id);
  if (!row) { console.error(`[doctrine] No doctrine_registry row with id '${id}'.`); return 1; }

  if (row.status === 'ratified') { console.error(`[doctrine] Row ${id} is already ratified.`); return 1; }
  if (row.status !== 'proposed') {
    console.error(`[doctrine] Row ${id} has status '${row.status}' — ratify requires 'proposed' (has doctrine-sync materialized it yet?).`);
    return 1;
  }

  const lookup = findPrForRow(repoPath, row, opts);
  if (!lookup.ok) { console.error(`[doctrine] Could not look up the PR: ${lookup.reason}`); return 2; }
  if (!lookup.pr) {
    console.error(`[doctrine] No PR found for branch '${lookup.branch}' — has doctrine-sync materialized + pushed it?`);
    return 1;
  }
  if (lookup.pr.state !== 'MERGED') {
    console.error(`[doctrine] PR #${lookup.pr.number} (${lookup.pr.url}) is ${lookup.pr.state}, not MERGED — refusing to ratify until it merges.`);
    return 1;
  }

  // 1. Generate the embedding FIRST, before ANY state mutation (registry.jsonl
  //    or Postgres). T4-CODEX 12:46 ET AUDIT-FAIL / ORCH ruling: memory_hybrid_search's
  //    candidate CTE filters `embedding is not null`, so a memory_items row
  //    inserted WITHOUT one is never a recall candidate — silently defeating
  //    AMEND-1's whole purpose while `ratify` reports success. An embedding
  //    failure must ABORT the entire ratify with nothing mutated (row stays
  //    'proposed', registry.jsonl stays 'proposed', no memory_items row), so
  //    a retry is clean once the embedding failure (missing key / OpenAI
  //    outage / rate limit) is resolved — never a silent partial success.
  const rawContent = row.doctrine_text || row.title || '(no content)';
  const { text: content } = stripPrivate(rawContent);

  const secrets = opts.secrets || resolveSecrets();
  let embedding;
  try {
    embedding = await docSync.generateEmbedding(content, { apiKey: secrets.OPENAI_API_KEY });
  } catch (err) {
    console.error(`[doctrine] Ratify ABORTED: could not generate an embedding (${err.message}). Nothing was mutated — row ${id} stays 'proposed'. Fix OPENAI_API_KEY / connectivity and re-run \`termdeck doctrine ratify ${id}\`.`);
    return 2;
  }

  // 2. INSERT the flow-back memory_items row + flip rumen's own status in
  //    ONE transaction, so a failure between the two can never strand a
  //    memory_items row whose doctrine_registry row still reads 'proposed'
  //    (which would otherwise let a retried ratify insert a SECOND row for
  //    the same doctrine). NEVER through memoryRemember (its >=0.95 path
  //    returns 'skipped'; its 0.88-0.95 path would corrupt a cluster member
  //    in place without changing source_type — AMEND-1). stripPrivate
  //    defensively even though doctrine_text is Haiku-synthesized prose from
  //    paraphrased evidence gists, never verbatim quotes.
  const metadata = {
    rumen_doctrine_registry_id: row.id,
    occurrence_count: row.occurrence_count,
    projects: row.projects,
    cluster_member_ids: row.cluster_member_ids,
    pr_url: lookup.pr.url,
    ratified_at: new Date().toISOString(),
  };

  let newMemoryId;
  try {
    await client.query('BEGIN');
    const insertRes = await client.query(
      `insert into memory_items (content, source_type, project, metadata, embedding, is_active, archived)
       values ($1, 'doctrine', 'global', $2, $3, true, false) returning id`,
      [content, JSON.stringify(metadata), docSync.formatEmbedding(embedding)]
    );
    newMemoryId = insertRes.rows[0] && insertRes.rows[0].id;
    await client.query(`update doctrine_registry set status = 'ratified', updated_at = now() where id = $1`, [row.id]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* best-effort */ }
    console.error(`[doctrine] Ratify ABORTED: memory_items insert / status flip failed (${err.message}) — rolled back, nothing mutated. Row ${id} stays 'proposed'.`);
    return 2;
  }

  // 3. Flip the repo registry entry proposed -> active (status-enum-bridge
  //    decision, docs/sprint-79-elevation-capture/STATUS.md 12:07 ET FINDING).
  //    Runs AFTER the DB commit, not before: Postgres is the source of truth
  //    for "has this been ratified" (cmdRatify's own guard at the top reads
  //    it), so if this file write fails, a re-run correctly refuses with
  //    "already ratified" instead of risking a second memory_items insert —
  //    the file can be repaired by hand without any data-integrity risk.
  const entryId = docSync.registryEntryIdFor(row);
  let regResult;
  try {
    regResult = updateRegistryEntry(repoPath, entryId, doctrine, (entry) => ({ ...entry, status: 'active' }));
  } catch (err) {
    console.warn(`Warning: registry.jsonl update failed (${err.message}) — memory_items row ${newMemoryId} IS ratified and recallable; fix the registry entry '${entryId}' by hand.`);
    regResult = { ok: false };
  }
  if (regResult.ok === false && regResult.reason) console.warn(`Warning: ${regResult.reason}`);

  // 4. memory_link 'elevated_to' edges from each cluster member -> the new
  //    row. Best-effort, non-transactional, AFTER commit: an edge failure
  //    does not affect the row's own recallability (only its graph
  //    neighborhood), so it must never roll back the ratify itself.
  const memberIds = Array.isArray(row.cluster_member_ids) ? row.cluster_member_ids : [];
  let linked = 0;
  for (const memberId of memberIds) {
    try {
      await client.query(
        `insert into memory_relationships (source_id, target_id, relationship_type, weight, inferred_at, inferred_by)
         values ($1, $2, 'elevated_to', 1.0, now(), 'termdeck:doctrine-ratify')
         on conflict (source_id, target_id, relationship_type) do nothing`,
        [memberId, newMemoryId]
      );
      linked++;
    } catch (err) {
      console.warn(`Warning: elevated_to edge ${memberId} -> ${newMemoryId} failed (best-effort, not fatal): ${err.message}`);
    }
  }

  const registryNote = regResult.ok
    ? `Registry entry '${entryId}' is now status='active'.`
    : `Registry entry '${entryId}' could NOT be updated (see warning above) — it may still read 'proposed' on disk; fix it by hand. This does NOT affect recallability (Postgres is ratified and the memory_items row exists).`;
  console.log(`Ratified ${id}: memory_items row ${newMemoryId} inserted (source_type='doctrine', project='global', embedding present), ${linked}/${memberIds.length} elevated_to edge(s) linked. ${registryNote}`);
  return 0;
}

async function cmdReject(client, repoPath, id, flags, opts = {}) {
  const row = await fetchRowById(client, id);
  if (!row) { console.error(`[doctrine] No doctrine_registry row with id '${id}'.`); return 1; }
  if (row.status === 'ratified') { console.error(`[doctrine] Row ${id} is already ratified — reject does not apply (use a future 'deprecate' path instead).`); return 1; }
  if (row.status === 'rejected') { console.error(`[doctrine] Row ${id} is already rejected.`); return 1; }

  const reason = flags.reason ? String(flags.reason) : 'rejected via termdeck doctrine reject';

  if (row.status === 'proposed') {
    const lookup = findPrForRow(repoPath, row, opts);
    if (lookup.ok && lookup.pr && lookup.pr.state === 'OPEN') {
      const ghBin = opts.ghBin || 'gh';
      const close = spawnSync(ghBin, ['pr', 'close', String(lookup.pr.number), '--comment', `Closed via termdeck doctrine reject: ${reason}`],
        { cwd: repoPath, encoding: 'utf8', timeout: 15000 });
      if (close.error || close.status !== 0) {
        console.warn(`Warning: could not close PR #${lookup.pr.number} (best-effort, continuing): ${(close.stderr || '').trim()}`);
      } else {
        console.log(`Closed PR #${lookup.pr.number}.`);
      }
    }
  }

  await client.query(`update doctrine_registry set status = 'rejected', rejection_reason = $2, updated_at = now() where id = $1`, [row.id, reason]);
  console.log(`Rejected ${id}: ${reason}`);
  return 0;
}

async function cmdPromote(client, repoPath, doctrine, id) {
  const row = await fetchRowById(client, id);
  if (!row) { console.error(`[doctrine] No doctrine_registry row with id '${id}'.`); return 1; }
  if (row.status !== 'ratified') {
    console.error(`[doctrine] Row ${id} has status '${row.status}' — promote requires 'ratified' (run ratify first).`);
    return 1;
  }

  const entryId = docSync.registryEntryIdFor(row);
  let regResult;
  try {
    // AMEND-5: advise->gate promotion is a forward-declaration this sprint —
    // the PreToolUse-deny mechanism itself ships Sprint 80. This just stages
    // the registry entry's declared enforcement intent (SCHEMA.md's own
    // framing: "the enforcement block declares the intended surface so later
    // sprints have a target"). validateEntry() already permits block on
    // preToolUse-deny (BLOCK_ALLOWED_SURFACES).
    regResult = updateRegistryEntry(repoPath, entryId, doctrine, (entry) => ({
      ...entry,
      enforcement: { ...entry.enforcement, surface: 'preToolUse-deny', max_severity: 'block' },
      promoted_at: new Date().toISOString(),
    }));
  } catch (err) {
    console.error(`[doctrine] Registry update failed: ${err.message}`);
    return 2;
  }
  if (!regResult.ok) { console.error(`[doctrine] `); return 2; }

  console.log(`Promoted ${id}: registry entry '${entryId}' now declares enforcement.surface='preToolUse-deny', max_severity='block' (staged for the Sprint 80 gate mechanism — nothing enforces this yet).`);
  return 0;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

module.exports = async function doctrineCli(argv) {
  const { positional, flags } = parseFlags(argv || []);
  const sub = positional[0];

  if (!sub || flags.help || sub === 'help') {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  if (!['list', 'ratify', 'reject', 'promote'].includes(sub)) {
    console.error(`[doctrine] Unknown subcommand '${sub}'.`);
    process.stdout.write(HELP);
    return 1;
  }

  const repoPath = resolveRepoPath(flags);
  if (!repoPath) {
    console.error('[doctrine] Could not resolve the termdeck repo path — set TERMDECK_DOCTRINE_REPO, pass --repo <path>, or run from inside the repo.');
    return 2;
  }

  const secrets = resolveSecrets();
  if (!secrets.DATABASE_URL) {
    console.error('[doctrine] DATABASE_URL not set (checked process.env and ~/.termdeck/secrets.env).');
    return 2;
  }

  let doctrine;
  try {
    doctrine = require(path.join(repoPath, 'doctrine', 'index.js'));
  } catch (err) {
    console.error(`[doctrine] Could not load doctrine/index.js from ${repoPath}: ${err.message}`);
    return 2;
  }

  let client;
  try {
    client = await connectPg(secrets.DATABASE_URL);
  } catch (err) {
    console.error(`[doctrine] Could not connect to DATABASE_URL: ${err.message}`);
    return 2;
  }

  try {
    if (sub === 'list') return await cmdList(client, flags);
    const id = positional[1];
    if (!id) { console.error(`[doctrine] Usage: termdeck doctrine ${sub} <id>`); return 1; }
    if (sub === 'ratify') return await cmdRatify(client, repoPath, doctrine, id, { secrets });
    if (sub === 'reject') return await cmdReject(client, repoPath, id, flags, { secrets });
    if (sub === 'promote') return await cmdPromote(client, repoPath, doctrine, id);
    return 1;
  } finally {
    try { await client.end(); } catch (_e) { /* best-effort */ }
  }
};

module.exports.stripPrivate = stripPrivate;
module.exports.resolveRepoPath = resolveRepoPath;
module.exports.resolveSecrets = resolveSecrets;
module.exports.findPrForRow = findPrForRow;
module.exports.updateRegistryEntry = updateRegistryEntry;
module.exports.fetchRowById = fetchRowById;

// Test-only seam (packages/cli/tests/doctrine-cli.test.js) — direct access
// to the per-subcommand handlers so tests can inject a fake pg client + a
// stub `gh` (via opts.ghBin) without going through argv parsing, repo-path
// resolution, or a real DATABASE_URL/pg connection.
module.exports.__test = { cmdList, cmdRatify, cmdReject, cmdPromote };
