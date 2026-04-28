#!/usr/bin/env node
/* eslint-disable no-console */
//
// scripts/reclassify-chopin-nashville.js
// Sprint 41 — T4 — LLM-classification of residual uncertain chopin-nashville
// rows in the Mnestra `memory_items` table.
//
// One-shot runner. Orchestrator invokes this AT SPRINT CLOSE, after
// T2's deterministic re-tag migration (012_project_tag_re_taxonomy.sql) and
// T4's audit-column migration (engram/migrations/013_reclassify_uncertain.sql)
// have both been applied to the live petvetbid Postgres.
//
// Mechanism:
//   1. Pull a batch of up to BATCH_SIZE chopin-nashville rows that this
//      script hasn't already touched (filtered via reclassified_by).
//   2. Send them to Haiku 4.5 with the canonical Sprint 41 taxonomy and a
//      strict per-row JSON schema in the prompt.
//   3. Parse the response, reject any project tag not in the whitelist,
//      UPDATE memory_items.project + reclassified_by + reclassified_at.
//   4. Repeat until empty or `--max-batches` cap reached.
//
// Idempotency:
//   reclassified_by = 'sprint-41-llm-residual' stamps every row the script
//   touches — including rows the LLM voted to KEEP as chopin-nashville. The
//   query filter excludes anything already stamped, so re-runs never re-ask
//   Haiku about the same row.
//
// Usage:
//   node scripts/reclassify-chopin-nashville.js               # apply mode
//   node scripts/reclassify-chopin-nashville.js --dry-run     # log only
//   node scripts/reclassify-chopin-nashville.js --max-batches=5
//   node scripts/reclassify-chopin-nashville.js --batch-size=10
//
// Env-var prereqs (script preflights and exits early if missing):
//   DATABASE_URL       — Postgres conn string for the petvetbid Mnestra DB.
//   ANTHROPIC_API_KEY  — Anthropic API key (Joshua keeps this in
//                        ~/.termdeck/secrets.env per Sprint 34 conventions).
//
// Cost ceiling (per briefing): ~$0.004/batch × 48 batches for full 947-row
// pass ≈ $0.20 total. Default --max-batches=50 covers the upper bound.

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk').default;

// ── Canonical Sprint 41 project taxonomy ────────────────────────────────────
// MUST stay in lockstep with T1's docs/PROJECT-TAXONOMY.md. If T1 adds or
// removes a project, update this array AND the prompt block below.
const TAXONOMY = [
  'termdeck',
  'mnestra',
  'rumen',
  'rag-system',
  'podium',
  'chopin-in-bohemia',
  'chopin-scheduler', // Maestro is an alias — same project, working name.
  'pvb',
  'claimguard',
  'dor',
  'portfolio',
  'imessage-reader',
  'chopin-nashville', // legitimate competition-management work only
  'global',           // genuinely no project signal
];

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const RECLASSIFIED_BY = 'sprint-41-llm-residual';
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_BATCHES = 50;
const MAX_CONTENT_CHARS = 800; // truncate per-row to keep batch under 5k input tokens
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

// Per-batch input/output token estimates × Haiku 4.5 unit prices, used only
// for human-readable progress logging. Numbers from the briefing — not load-
// bearing for correctness.
const COST_PER_BATCH_USD = 0.004;

function buildPrompt(rows) {
  const numbered = rows
    .map((r, i) => `${i + 1}. ${(r.content || '').slice(0, MAX_CONTENT_CHARS)}`)
    .join('\n\n');

  return `You are classifying memory snippets from a developer's working memory database. Each snippet is a fact, decision, bug fix, or other note from a Claude Code session. Classify each by the SPECIFIC code project or context it's about.

Available projects (the canonical taxonomy):
- termdeck — browser terminal multiplexer, the @jhizzard/termdeck repo
- mnestra — Postgres-backed persistent memory store, MCP server (@jhizzard/mnestra; on-disk dir is ~/Documents/Graciella/engram)
- rumen — async learning loop, Supabase Edge Function (@jhizzard/rumen)
- rag-system — Joshua's private RAG ingestion system
- podium — app for the Chopin in Bohemia 2026 festival
- chopin-in-bohemia — the festival itself (NOT the podium app — festival logistics, sponsors, schedule)
- chopin-scheduler — scheduling tool. ALSO KNOWN AS "Maestro" — same project, two names. If content references "Maestro" as a project name, use chopin-scheduler.
- pvb — PetVetBid app
- claimguard — ClaimGuard-AI ticket monitor (formerly "gorgias-ticket-monitor")
- dor — DOR Rust LLM gateway
- portfolio — joshuaizzard.dev portfolio site
- imessage-reader — iMessage reader project
- chopin-nashville — Chopin Nashville Piano Competition (operational logistics, NOT code — performances, sponsors, jury, year folders, programs, advertising)
- global — genuinely no project signal (general programming notes, etc.)

For each numbered snippet below, return ONLY a JSON array of objects of the shape { "index": <number>, "project": "<tag>" }, in the same order as the snippets. Pick the SINGLE most-specific tag. Default to "global" only when the content has no clear project signal at all. If the snippet is clearly about the Chopin Nashville competition (performers, sponsors, jury, programs, year folders), keep it as "chopin-nashville".

Snippets:
${numbered}

Return ONLY the JSON array, no other text, no commentary, no markdown code fences.`;
}

// Haiku occasionally wraps responses in ```json ... ``` despite the explicit
// instruction. Strip fences before JSON.parse.
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

async function callHaikuWithRetry(anthropic, prompt) {
  let attempt = 0;
  let lastErr;
  while (attempt <= MAX_RETRIES) {
    try {
      return await anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      lastErr = err;
      const status = err && (err.status || err.statusCode);
      if (!RETRY_STATUSES.has(status) || attempt === MAX_RETRIES) throw err;
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
      console.warn(`  [retry] ${status} from Anthropic; sleeping ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((res) => setTimeout(res, backoffMs));
      attempt += 1;
    }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const args = { dryRun: false, maxBatches: DEFAULT_MAX_BATCHES, batchSize: DEFAULT_BATCH_SIZE };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--max-batches=')) args.maxBatches = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--batch-size=')) args.batchSize = parseInt(a.split('=')[1], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/reclassify-chopin-nashville.js [--dry-run] [--max-batches=N] [--batch-size=N]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.maxBatches) || args.maxBatches < 1) {
    throw new Error(`--max-batches must be a positive integer (got ${args.maxBatches})`);
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > 100) {
    throw new Error(`--batch-size must be between 1 and 100 (got ${args.batchSize})`);
  }
  return args;
}

function preflightEnv() {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    console.error('Missing required env vars:');
    for (const v of missing) console.error(`  - ${v}`);
    console.error('\nFor Joshua: source ~/.termdeck/secrets.env (or your own equivalent) before running.');
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  preflightEnv();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Sanity: count residual rows up front so logs show progress against a known total.
  const { rows: totalRows } = await pool.query(
    `select count(*)::int as n
       from memory_items
      where project = 'chopin-nashville'
        and coalesce(reclassified_by, '') <> $1`,
    [RECLASSIFIED_BY]
  );
  const initialResidual = totalRows[0].n;

  console.log(`Sprint 41 T4 — LLM-classification of residual chopin-nashville rows`);
  console.log(`  mode:           ${args.dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`  batch size:     ${args.batchSize}`);
  console.log(`  max batches:    ${args.maxBatches}`);
  console.log(`  model:          ${HAIKU_MODEL}`);
  console.log(`  residual rows:  ${initialResidual}`);
  console.log(`  estimated cost: ~$${(Math.min(args.maxBatches, Math.ceil(initialResidual / args.batchSize)) * COST_PER_BATCH_USD).toFixed(3)}`);
  console.log('');

  if (initialResidual === 0) {
    console.log('Nothing to do — no residual rows match the filter. Done.');
    await pool.end();
    return;
  }

  const tagDelta = Object.create(null); // { tag: count }
  let batches = 0;
  let classified = 0;
  let invalid = 0;
  let errors = 0;

  while (batches < args.maxBatches) {
    // Pull next batch. Excludes anything we've already stamped.
    const { rows } = await pool.query(
      `select id, content
         from memory_items
        where project = 'chopin-nashville'
          and coalesce(reclassified_by, '') <> $1
        order by created_at desc
        limit $2`,
      [RECLASSIFIED_BY, args.batchSize]
    );
    if (rows.length === 0) break;

    const prompt = buildPrompt(rows);
    let response;
    try {
      response = await callHaikuWithRetry(anthropic, prompt);
    } catch (err) {
      console.error(`[batch ${batches + 1}] Anthropic call failed: ${err.message}`);
      errors += 1;
      batches += 1;
      // Stop on persistent failure — the rows stay un-stamped, so a re-run resumes here.
      if (errors >= 3) {
        console.error(`[abort] ${errors} consecutive batch failures — stopping. Re-run after diagnosing.`);
        break;
      }
      continue;
    }

    const textBlock = response.content.find((c) => c.type === 'text');
    if (!textBlock) {
      console.error(`[batch ${batches + 1}] response had no text block — skipping`);
      errors += 1;
      batches += 1;
      continue;
    }

    let classifications;
    try {
      classifications = JSON.parse(stripCodeFences(textBlock.text));
      if (!Array.isArray(classifications)) throw new Error('response was not an array');
    } catch (err) {
      console.error(`[batch ${batches + 1}] JSON parse failed: ${err.message}`);
      console.error(`  raw text: ${textBlock.text.slice(0, 300)}…`);
      errors += 1;
      batches += 1;
      continue;
    }

    // Apply classifications inside a per-batch transaction (apply mode only).
    const client = args.dryRun ? null : await pool.connect();
    try {
      if (client) await client.query('begin');

      for (const c of classifications) {
        const idx = Number(c.index);
        if (!Number.isInteger(idx) || idx < 1 || idx > rows.length) {
          console.warn(`  [batch ${batches + 1}] bad index=${c.index} — skipping`);
          invalid += 1;
          continue;
        }
        if (typeof c.project !== 'string' || !TAXONOMY.includes(c.project)) {
          console.warn(`  [batch ${batches + 1}] invalid project="${c.project}" for row ${idx} — skipping`);
          invalid += 1;
          continue;
        }
        const row = rows[idx - 1];
        if (args.dryRun) {
          console.log(`  [dry-run] ${row.id} → ${c.project}`);
        } else {
          await client.query(
            `update memory_items
                set project = $1,
                    reclassified_by = $2,
                    reclassified_at = now()
              where id = $3`,
            [c.project, RECLASSIFIED_BY, row.id]
          );
        }
        tagDelta[c.project] = (tagDelta[c.project] || 0) + 1;
        classified += 1;
      }

      if (client) await client.query('commit');
    } catch (err) {
      if (client) {
        try { await client.query('rollback'); } catch (_) { /* ignore */ }
      }
      console.error(`[batch ${batches + 1}] update transaction failed: ${err.message}`);
      errors += 1;
    } finally {
      if (client) client.release();
    }

    batches += 1;
    const seen = batches * args.batchSize;
    const pct = Math.min(100, Math.round((seen / initialResidual) * 100));
    console.log(`[progress] batch=${batches}/${args.maxBatches}  classified=${classified}  invalid=${invalid}  errors=${errors}  ~${pct}% of residual`);
  }

  console.log('');
  console.log('Per-tag delta:');
  for (const tag of Object.keys(tagDelta).sort((a, b) => tagDelta[b] - tagDelta[a])) {
    console.log(`  ${tag.padEnd(20)} ${tagDelta[tag]}`);
  }
  console.log('');
  console.log(`Done. batches=${batches}  classified=${classified}  invalid=${invalid}  errors=${errors}  mode=${args.dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`Estimated spend: ~$${(batches * COST_PER_BATCH_USD).toFixed(3)}`);

  // Final residual count (apply mode only — dry-run's count is unchanged).
  if (!args.dryRun) {
    const { rows: postRows } = await pool.query(
      `select count(*)::int as n
         from memory_items
        where project = 'chopin-nashville'`
    );
    console.log(`Live chopin-nashville count post-run: ${postRows[0].n}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
