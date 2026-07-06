'use strict';

// Sprint 79 T3 — doctrine-sync: materializes rumen's `doctrine_registry`
// 'drafted' rows into termdeck's `doctrine/registry.jsonl` via a PR, and
// exposes the shared render/embed helpers `termdeck doctrine ratify`
// (packages/cli/src/doctrine-cli.js) also needs for flow-back.
//
// DEFAULT-OFF (AMEND-3): the background timer registers ONLY when
// TERMDECK_DOCTRINE_REPO is set AND a boot preflight passes (git repo +
// expected remote + `gh auth status` + gitleaks present). Preflight failure
// is ONE info log; the timer never registers. Brad's install never runs this.
//
// Never touches the live checkout (AMEND-4): all file/git work happens in a
// throwaway `git worktree` under ~/.termdeck/doctrine-work/, always cleaned
// up (worktree + local branch ref) whether the row succeeds or fails. All
// git/gh failures swallow-and-log; the row stays 'drafted' for retry.
//
// CJS, zero-build, fail-soft everywhere — this rides an unref'd background
// timer; nothing here may throw uncaught or leave dangling git state.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Pure rendering + deterministic naming were extracted to the shared, zero-dep
// doctrine/render.js (Sprint 81 T4) so the CLI can consume them without reaching
// through this file's git/pg/timer surface. Required + re-exported here (see
// module.exports) so every existing `docSync.<fn>` caller keeps resolving
// unchanged. `truncate` is deliberately not imported — only the two moved
// render functions used it, and they now live in render.js.
const {
  slugify,
  shortId,
  branchNameFor,
  docRelPathFor,
  registryEntryIdFor,
  renderDoctrineMarkdown,
  buildRegistryEntry,
} = require('../../../doctrine/render');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_BATCH_SIZE = 5; // bound worktree churn per cycle
const GITLEAKS_BIN_DEFAULT = '/usr/local/bin/gitleaks';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1536;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[doctrine-sync]', ...args);
}
function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[doctrine-sync]', ...args);
}

// ---------------------------------------------------------------------------
// doctrine registry module resolution — fail-soft, mirrors advisor/index.js's
// resolveDoctrine() pattern exactly (NULL-object fallback, warn-once).
// ---------------------------------------------------------------------------

const NULL_DOCTRINE = {
  screenEntries(entries) { return entries; },
  validateEntry() { return { valid: true, errors: [] }; },
};

let _doctrineCache; // undefined = unresolved; else module-or-stub
let _doctrineWarned = false;

function resolveDoctrine() {
  if (_doctrineCache !== undefined) return _doctrineCache;
  try {
    // eslint-disable-next-line global-require
    _doctrineCache = require('../../../doctrine');
    if (!_doctrineCache || typeof _doctrineCache.screenEntries !== 'function') {
      throw new Error('doctrine module missing screenEntries');
    }
  } catch (err) {
    if (!_doctrineWarned) {
      warn('doctrine registry module not available — scrub disabled, entries pass unscreened (fail-soft):', err.message);
      _doctrineWarned = true;
    }
    _doctrineCache = NULL_DOCTRINE;
  }
  return _doctrineCache;
}

function _setDoctrineForTest(mod) { _doctrineCache = mod; _doctrineWarned = false; }
function _resetDoctrineForTest() { _doctrineCache = undefined; _doctrineWarned = false; }

// ---------------------------------------------------------------------------
// Small helpers  (slugify/truncate/shortId + branch/doc/entry-id naming were
// moved to the shared zero-dep doctrine/render.js — imported above.)
// ---------------------------------------------------------------------------

function worktreeRoot() {
  return path.join(os.homedir(), '.termdeck', 'doctrine-work');
}

// ---------------------------------------------------------------------------
// Preflight (AMEND-3). Runs ONCE at maybeStart(); never re-checked per tick.
// ---------------------------------------------------------------------------

function runGit(cwd, args, opts = {}) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: opts.timeout || 20000 });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error,
  };
}

function runPreflight(repoPath, opts = {}) {
  if (!repoPath) return { ok: false, reason: 'TERMDECK_DOCTRINE_REPO not set' };
  if (!path.isAbsolute(repoPath)) {
    return { ok: false, reason: `TERMDECK_DOCTRINE_REPO must be an absolute path (got "${repoPath}")` };
  }
  if (!fs.existsSync(repoPath)) {
    return { ok: false, reason: `TERMDECK_DOCTRINE_REPO does not exist: ${repoPath}` };
  }

  const isRepo = runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok || isRepo.stdout !== 'true') {
    return { ok: false, reason: `${repoPath} is not a git working tree` };
  }

  const remote = runGit(repoPath, ['remote', 'get-url', 'origin']);
  const expectedRemoteFragment = opts.expectedRemoteFragment || 'termdeck';
  if (!remote.ok || !remote.stdout.toLowerCase().includes(expectedRemoteFragment)) {
    return { ok: false, reason: `origin remote does not look like the termdeck repo (got "${remote.stdout || remote.stderr || '<none>'}")` };
  }

  const ghBin = opts.ghBin || 'gh';
  const ghAuth = spawnSync(ghBin, ['auth', 'status'], { encoding: 'utf8', timeout: 10000 });
  if (ghAuth.error || ghAuth.status !== 0) {
    return { ok: false, reason: `gh auth status failed (gh CLI not authenticated${ghAuth.error ? `: ${ghAuth.error.message}` : ''})` };
  }

  const gitleaksBin = opts.gitleaksBin || GITLEAKS_BIN_DEFAULT;
  if (!fs.existsSync(gitleaksBin)) {
    return { ok: false, reason: `gitleaks not found at ${gitleaksBin}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rendering + registry-entry construction (renderDoctrineMarkdown /
// buildRegistryEntry) moved to the shared, zero-dep doctrine/render.js
// (Sprint 81 T4) — imported + re-exported above. screenableFromRow stays here:
// it prepares an entry for the SCRUB pipeline (screenEntries), not rendering.
// ---------------------------------------------------------------------------

// Shim so the FULL rendered doc (not just the short registry fields) passes
// through doctrine/index.js::screenEntries — REUSE, never a new scrub
// mechanism (AMEND-2). The whole markdown body rides in `source.incident`,
// one of the five fields _screenableText() concatenates before the gitleaks
// shell-out; this is the only field long/free-form enough to carry it.
function screenableFromRow(entry, fullMarkdown) {
  return {
    id: entry.id,
    title: entry.title,
    advisory: { one_line: entry.advisory.one_line, procedure_path: entry.advisory.procedure_path },
    enforcement: { ref: entry.enforcement.ref },
    source: { incident: fullMarkdown, memory_recall_query: entry.source.memory_recall_query },
  };
}

// ---------------------------------------------------------------------------
// Embedding generation (mirrors engram/src/embeddings.ts exactly — same
// model/dimensions, since memory_hybrid_search's candidates CTE filters
// `embedding is not null`; a flow-back row without one would never be a
// recall candidate at all, silently defeating the whole elevation pipeline).
// termdeck is vanilla JS/CJS with no engram TS dependency, so this is a
// deliberate small duplication of embeddings.ts's fetch call, not a shared
// import (no cross-repo require is possible here) — kept in lockstep by
// comment cross-reference only.
// ---------------------------------------------------------------------------

async function generateEmbedding(text, opts = {}) {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to embed a flow-back doctrine row');
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embedding error: HTTP ${res.status}`);
  }
  const data = await res.json();
  const embedding = data && data.data && data.data[0] && data.data[0].embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('OpenAI returned no embedding');
  }
  return embedding;
}

function formatEmbedding(embedding) {
  return `[${embedding.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Materialize one drafted row: scrub -> worktree -> render -> registry ->
// commit -> push -> gh pr create. ALWAYS cleans up the worktree + local
// branch ref, success or failure (AMEND-4 — never leaves git state behind).
// ---------------------------------------------------------------------------

async function processRow(repoPath, row, doctrine, opts = {}) {
  const docRelPath = docRelPathFor(row);
  const branch = branchNameFor(row);
  const entry = buildRegistryEntry(row, docRelPath);

  const v = doctrine.validateEntry(entry);
  if (!v.valid) {
    warn(`row ${row.id} produced an invalid registry entry — staying 'drafted': ${v.errors.join('; ')}`);
    return { ok: false, reason: 'invalid-entry', errors: v.errors };
  }

  const markdown = renderDoctrineMarkdown(row);
  // gitleaksBin/gitleaksConfig pass through ONLY as a test seam (screenEntries
  // defaults to the operator's real /usr/local/bin/gitleaks + ~/.gitleaks.toml
  // when omitted, which is what every production call must use — the scrub
  // is only meaningful against the operator's actual forbidden-string list).
  const screenOpts = {};
  if (opts.gitleaksBin) screenOpts.gitleaksBin = opts.gitleaksBin;
  if (opts.gitleaksConfig) screenOpts.gitleaksConfig = opts.gitleaksConfig;
  const screened = doctrine.screenEntries([screenableFromRow(entry, markdown)], screenOpts);
  if (screened.length === 0) {
    warn(`row ${row.id} BLOCKED by the forbidden-string scrub — staying 'drafted' (needs a manual content fix; not auto-retried).`);
    return { ok: false, reason: 'scrub-blocked' };
  }

  const root = worktreeRoot();
  fs.mkdirSync(root, { recursive: true });
  const worktreeDir = path.join(root, `${shortId(row.id)}-${slugify(row.title)}-${process.pid}`);

  let worktreeAdded = false;
  try {
    const fetchRes = runGit(repoPath, ['fetch', 'origin', 'main']);
    if (!fetchRes.ok) {
      warn(`row ${row.id}: git fetch origin main failed — staying 'drafted': ${fetchRes.stderr}`);
      return { ok: false, reason: 'fetch-failed', detail: fetchRes.stderr };
    }

    const add = runGit(repoPath, ['worktree', 'add', '-b', branch, worktreeDir, 'origin/main']);
    if (!add.ok) {
      warn(`row ${row.id}: git worktree add failed — staying 'drafted': ${add.stderr}`);
      return { ok: false, reason: 'worktree-add-failed', detail: add.stderr };
    }
    worktreeAdded = true;

    const docAbsPath = path.join(worktreeDir, docRelPath);
    fs.mkdirSync(path.dirname(docAbsPath), { recursive: true });
    fs.writeFileSync(docAbsPath, markdown, 'utf8');

    const registryAbsPath = path.join(worktreeDir, 'doctrine', 'registry.jsonl');
    fs.appendFileSync(registryAbsPath, `${JSON.stringify(entry)}\n`, 'utf8');

    const addFiles = runGit(worktreeDir, ['add', '--', docRelPath, 'doctrine/registry.jsonl']);
    if (!addFiles.ok) {
      warn(`row ${row.id}: git add failed — staying 'drafted': ${addFiles.stderr}`);
      return { ok: false, reason: 'git-add-failed', detail: addFiles.stderr };
    }

    const commitMsg = `doctrine: propose "${row.title || 'untitled'}"\n\nAuto-materialized from rumen doctrine_registry ${row.id} by doctrine-sync.\nOccurrence count: ${Number(row.occurrence_count) || 0}. Projects: ${(Array.isArray(row.projects) ? row.projects : []).join(', ') || '(none)'}.`;
    const commit = runGit(worktreeDir, ['commit', '-m', commitMsg]);
    if (!commit.ok) {
      warn(`row ${row.id}: git commit failed — staying 'drafted': ${commit.stderr}`);
      return { ok: false, reason: 'commit-failed', detail: commit.stderr };
    }

    const push = runGit(worktreeDir, ['push', '-u', 'origin', branch]);
    if (!push.ok) {
      warn(`row ${row.id}: git push failed — staying 'drafted': ${push.stderr}`);
      return { ok: false, reason: 'push-failed', detail: push.stderr };
    }

    const prBody = [
      `**Auto-materialized doctrine proposal** (Sprint 79 elevation pipeline)`,
      '',
      `Source: rumen \`doctrine_registry\` row \`${row.id}\` (origin: ${row.origin || 'doctrine-scan'}).`,
      `Occurrence count: ${Number(row.occurrence_count) || 0}. Projects: ${(Array.isArray(row.projects) ? row.projects : []).join(', ') || '(none recorded)'}.`,
      '',
      '**Reviewer checklist:**',
      '- Is this genuinely ONE principle, not several fused together?',
      '- Does the evidence ledger (paraphrased gists, never verbatim quotes) actually support the claim?',
      '- Trigger hints ship shadow-mode only this sprint — logged as `doctrine_hits`, never injected pre-ratification.',
      '',
      `Merge to advance this to \`termdeck doctrine ratify ${row.id}\`.`,
    ].join('\n');

    const ghBin = opts.ghBin || 'gh';
    const pr = spawnSync(ghBin, [
      'pr', 'create',
      '--title', `doctrine: ${row.title || 'untitled'}`,
      '--body', prBody,
      '--head', branch,
      '--base', 'main',
    ], { cwd: worktreeDir, encoding: 'utf8', timeout: 20000 });

    if (pr.error || pr.status !== 0) {
      warn(`row ${row.id}: gh pr create failed — staying 'drafted': ${(pr.stderr || (pr.error && pr.error.message) || '').trim()}`);
      return { ok: false, reason: 'gh-pr-create-failed', detail: (pr.stderr || '').trim() };
    }

    const prUrl = (pr.stdout || '').trim().split('\n').pop();
    log(`row ${row.id} materialized — PR: ${prUrl}`);
    return { ok: true, branch, docRelPath, prUrl };
  } catch (err) {
    warn(`row ${row.id}: processing threw (fail-soft, staying 'drafted'):`, err && err.message);
    return { ok: false, reason: 'exception', error: err && err.message };
  } finally {
    // Always clean up — never leave the live repo's `git worktree list` or
    // local branches carrying scratch state (AMEND-4).
    if (worktreeAdded) {
      const rm = runGit(repoPath, ['worktree', 'remove', worktreeDir, '--force']);
      if (!rm.ok) warn(`row ${row.id}: worktree remove failed (best-effort, continuing): ${rm.stderr}`);
    } else {
      try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
    }
    const delBranch = runGit(repoPath, ['branch', '-D', branch]);
    if (!delBranch.ok && !/not found|not a valid ref/i.test(delBranch.stderr)) {
      warn(`row ${row.id}: local branch cleanup failed (best-effort): ${delBranch.stderr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// pg client helper — fresh short-lived connection per cycle (this is an
// hourly background job, not a hot path; avoids holding an idle pooled
// connection open for a server's entire uptime).
// ---------------------------------------------------------------------------

function requirePg() {
  try { return require('pg'); } catch (_e) { return null; }
}

async function fetchDraftedRows(pgClient, limit) {
  const res = await pgClient.query(
    `select id, status, title, doctrine_text, cluster_member_ids, member_content_hashes,
            occurrence_count, reinforced_after_ratification, projects, origin, evidence,
            trigger_hints, synthesized_at, created_at, updated_at
       from doctrine_registry
      where status = 'drafted'
      order by created_at asc
      limit $1`,
    [limit]
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

async function runCycle(options = {}) {
  const repoPath = options.repoPath || process.env.TERMDECK_DOCTRINE_REPO;
  if (!repoPath) return { ok: false, reason: 'no-repo-path' };

  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    warn('no DATABASE_URL — cannot read rumen doctrine_registry this cycle (fail-soft, retrying next tick)');
    return { ok: false, reason: 'no-database-url' };
  }

  const pg = options._pg || requirePg();
  if (!pg) {
    warn('pg module not installed — doctrine-sync cannot run this cycle (fail-soft)');
    return { ok: false, reason: 'no-pg-module' };
  }

  const doctrine = options.doctrine || resolveDoctrine();
  const client = new pg.Client({ connectionString: databaseUrl });
  let rows;
  try {
    await client.connect();
    rows = await fetchDraftedRows(client, options.batchSize || DEFAULT_BATCH_SIZE);
  } catch (err) {
    warn('failed to read doctrine_registry (fail-soft):', err && err.message);
    try { await client.end(); } catch (_e) { /* best-effort */ }
    return { ok: false, reason: 'db-read-failed', error: err && err.message };
  }

  const results = [];
  for (const row of rows) {
    try {
      const outcome = await processRow(repoPath, row, doctrine, options);
      results.push({ id: row.id, ...outcome });
      if (outcome.ok) {
        await client.query(`update doctrine_registry set status = 'proposed', updated_at = now() where id = $1`, [row.id]);
      }
    } catch (err) {
      warn(`row ${row.id}: unexpected top-level error (fail-soft, staying 'drafted'):`, err && err.message);
      results.push({ id: row.id, ok: false, reason: 'exception', error: err && err.message });
    }
  }

  try { await client.end(); } catch (_e) { /* best-effort */ }
  return { ok: true, processed: results.length, results };
}

// ---------------------------------------------------------------------------
// Start/stop — default-OFF timer registration (AMEND-3).
// ---------------------------------------------------------------------------

let _activeTimer = null;

function resolveIntervalMs(explicit) {
  if (explicit != null) return explicit;
  const raw = process.env.TERMDECK_DOCTRINE_SYNC_INTERVAL_MS;
  const n = Number(raw);
  return (raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0) ? n : DEFAULT_INTERVAL_MS;
}

function maybeStart(options = {}) {
  const repoPath = options.repoPath || process.env.TERMDECK_DOCTRINE_REPO || null;
  if (!repoPath) {
    log("TERMDECK_DOCTRINE_REPO not set — doctrine-sync stays OFF (this is the default; an external user's install never runs it).");
    return { started: false, reason: 'env-not-set' };
  }

  const preflight = runPreflight(repoPath, options);
  if (!preflight.ok) {
    log(`preflight failed — doctrine-sync stays OFF: ${preflight.reason}`);
    return { started: false, reason: preflight.reason };
  }

  const intervalMs = resolveIntervalMs(options.intervalMs);
  const fire = () => {
    runCycle({ ...options, repoPath }).catch((err) => {
      warn('cycle failed (fail-soft, will retry next tick):', err && err.message);
    });
  };

  const timer = setInterval(fire, intervalMs);
  if (timer.unref) timer.unref();
  _activeTimer = timer;
  log(`started — worktree poller against ${repoPath} (interval ${intervalMs}ms).`);

  if (options.fireImmediately) fire();

  return { started: true, timer, intervalMs };
}

function stop() {
  if (_activeTimer) {
    clearInterval(_activeTimer);
    _activeTimer = null;
  }
}

module.exports = {
  // lifecycle
  maybeStart,
  stop,
  runCycle,
  runPreflight,
  // naming (shared with the CLI so ratify can recompute without a stored URL)
  shortId,
  branchNameFor,
  docRelPathFor,
  registryEntryIdFor,
  slugify,
  worktreeRoot,
  // rendering (shared with the CLI's list output, if useful later)
  renderDoctrineMarkdown,
  buildRegistryEntry,
  screenableFromRow,
  // embeddings (shared with the CLI's ratify flow-back INSERT)
  generateEmbedding,
  formatEmbedding,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  // db
  fetchDraftedRows,
  requirePg,
  // git helper (exported for tests)
  runGit,
  // test seams
  _setDoctrineForTest,
  _resetDoctrineForTest,
  // Sprint 79 acceptance dry-run seam: processRow is the per-row worktree->
  // PR pipeline runCycle() drives internally. Exported ONLY so an end-to-end
  // test/dry-run can exercise it directly against a throwaway git repo
  // without needing a live rumen doctrine_registry connection.
  __test_processRow: processRow,
  resolveDoctrine,
  DEFAULT_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
};
