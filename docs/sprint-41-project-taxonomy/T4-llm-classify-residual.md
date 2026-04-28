# Sprint 41 — T4: LLM-classification of residual uncertain rows

**Lane goal:** After T2's deterministic re-tag, the leftover chopin-nashville rows are the "uncertain" ones — content with no clear keyword signal. T4 ships a one-shot script that calls Haiku 4.5 in batched groups, asks for a project classification per row, and updates `memory_items.project` based on response. Bounded cost (~$0.05–0.10 for ~700 rows × Haiku per-call cost). Re-runnable with idempotent guards.

**Target deliverable:**
1. NEW `scripts/reclassify-chopin-nashville.js` — a Node.js one-shot script that orchestrator runs at sprint close.
2. The script: queries chopin-nashville rows with no clear keyword signal (per T2's heuristic), batches into groups of 20, sends each batch to Haiku 4.5 with the canonical taxonomy from T1, parses the response, applies the new project tag via UPDATE.
3. Per-batch progress logging (rows seen, classifications applied, errors, cumulative cost).
4. Cost cap (`MAX_HAIKU_CALLS=50` default → 1,000 rows max per run; orchestrator can override).
5. Dry-run mode (`--dry-run`) that prints classifications without applying them.

## Why a script (not a migration)

T2's re-tag is deterministic SQL — runs in the database, atomic transaction. T4's LLM classification needs network calls + JSON parsing + per-row decisions, which doesn't fit Postgres natively. A Node script with `pg` client + Anthropic API client is the right shape. Orchestrator runs it at sprint close after T2's migration applies.

The script is idempotent: re-running it picks up where it left off (already-re-tagged rows are filtered out by the WHERE clause).

## Script shape

```js
#!/usr/bin/env node
// scripts/reclassify-chopin-nashville.js
// Sprint 41 T4 — LLM-classification of residual uncertain chopin-nashville rows.
//
// Usage:
//   node scripts/reclassify-chopin-nashville.js                  # apply mode
//   node scripts/reclassify-chopin-nashville.js --dry-run        # print only
//   node scripts/reclassify-chopin-nashville.js --max-batches 10 # cap

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk').default;

const TAXONOMY = [
  'termdeck', 'mnestra', 'rumen', 'rag-system',
  'podium', 'chopin-in-bohemia', 'chopin-scheduler',
  'pvb', 'claimguard', 'dor', 'portfolio', 'imessage-reader',
  'chopin-nashville',  // legitimate competition-management work
  'global',            // genuinely no project signal
];

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 20;
const MAX_BATCHES_DEFAULT = 50;

const PROMPT = `You are classifying memory snippets from a developer's working memory database. Each snippet is a fact, decision, bug fix, or other note from a Claude Code session. Classify each by the SPECIFIC code project or context it's about.

Available projects (the canonical taxonomy):
- termdeck — browser terminal multiplexer, the @jhizzard/termdeck repo
- mnestra — Postgres-backed persistent memory store, MCP server
- rumen — async learning loop, Supabase Edge Function
- rag-system — Joshua's private RAG ingestion system
- podium — app for the Chopin in Bohemia 2026 festival
- chopin-in-bohemia — the festival itself (NOT podium app — festival logistics, sponsors, schedule)
- chopin-scheduler — scheduling tool
- pvb — PetVetBid app
- claimguard — ClaimGuard-AI ticket monitor
- dor — DOR project
- portfolio — joshuaizzard.dev portfolio site
- imessage-reader — iMessage reader project
- chopin-nashville — Chopin Nashville Piano Competition (operational logistics, NOT code)
- global — genuinely no project signal (general programming notes, etc.)

For each numbered snippet below, return ONLY a JSON array of { "index": <number>, "project": "<tag>" } objects, in the same order. Pick the SINGLE most-specific tag. Default to "global" if the content has no clear project signal.

Snippets:
{batch_text}

Return ONLY the JSON array, no other text.`;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const maxBatchesArg = process.argv.find(a => a.startsWith('--max-batches='));
  const maxBatches = maxBatchesArg ? parseInt(maxBatchesArg.split('=')[1], 10) : MAX_BATCHES_DEFAULT;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let batches = 0;
  let total_classified = 0;
  let total_errors = 0;

  while (batches < maxBatches) {
    const { rows } = await pool.query(
      `SELECT id, content FROM memory_items
       WHERE project = 'chopin-nashville'
         AND id NOT IN (SELECT id FROM memory_items WHERE inferred_by = 'sprint-41-llm-residual')
       ORDER BY created_at DESC LIMIT $1`,
      [BATCH_SIZE]
    );
    if (rows.length === 0) break;

    const batchText = rows.map((r, i) => `${i + 1}. ${r.content.slice(0, 800)}`).join('\n\n');
    const prompt = PROMPT.replace('{batch_text}', batchText);

    try {
      const response = await anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content[0].text;
      const classifications = JSON.parse(text);

      for (const c of classifications) {
        if (!TAXONOMY.includes(c.project)) {
          console.warn(`[batch ${batches}] invalid project="${c.project}" — skipping`);
          continue;
        }
        const row = rows[c.index - 1];
        if (!row) continue;
        if (dryRun) {
          console.log(`[dry-run] ${row.id} → ${c.project}`);
        } else {
          await pool.query(
            `UPDATE memory_items SET project = $1 WHERE id = $2`,
            [c.project, row.id]
          );
        }
        total_classified++;
      }
    } catch (err) {
      console.error(`[batch ${batches}] failed:`, err.message);
      total_errors++;
    }
    batches++;
    console.log(`[progress] batches=${batches}, classified=${total_classified}, errors=${total_errors}`);
  }

  console.log(`\nDone. batches=${batches}, classified=${total_classified}, errors=${total_errors}, dry-run=${dryRun}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
```

## Cost estimation

- Haiku 4.5 input: ~$1/M tokens. Each batch ~3,000 input tokens (20 rows × ~150 tokens content + prompt overhead) = ~$0.003/batch.
- Haiku 4.5 output: ~$5/M tokens. Each batch ~150 output tokens (JSON array) = ~$0.00075/batch.
- Total per batch: ~$0.004.
- For 947 chopin-nashville rows ÷ 20 = 48 batches × $0.004 = **~$0.20 total** for full classification.
- Default cap of 50 batches matches this; orchestrator can re-run with higher cap if more rows are added.

## NEW Mnestra column for audit trail (optional, recommended)

If `inferred_by` doesn't already exist on `memory_items` (it's on `memory_relationships` from Sprint 38 migration 009 but NOT yet on `memory_items`), T4 ships a small migration that adds it:

```sql
-- Optional helper — only if memory_items doesn't have inferred_by yet.
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS reclassified_by text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS reclassified_at timestamptz;
```

Then the script's UPDATE becomes:
```sql
UPDATE memory_items
   SET project = $1, reclassified_by = 'sprint-41-llm-residual', reclassified_at = now()
 WHERE id = $2
```

This makes re-runs idempotent and gives Joshua an audit trail (`SELECT count(*) FROM memory_items WHERE reclassified_by = 'sprint-41-llm-residual'`).

## Coordination notes

- **T1's taxonomy** is the canonical project list. The script's `TAXONOMY` array MUST match T1's PROJECT-TAXONOMY.md exactly. If T1 adds/removes a project, T4 updates the array + prompt.
- **T2** writes the deterministic re-tag SQL. T4 only classifies rows T2 left under chopin-nashville. The WHERE clause filters those.
- **T3 is independent** — T4's script doesn't touch the UI.

## Test plan

- Smoke test in dry-run mode against the live `petvetbid` substrate. Print classifications to log; spot-check 10–20 random outputs for sanity. If the LLM is consistently wrong on a class, refine the prompt.
- Verify cost stays under estimate by capping `--max-batches` to 5 on the smoke test (~100 rows, ~$0.02 spend).
- Apply mode: orchestrator runs the full script at sprint close, monitors logs, verifies post-run counts.

## Out of scope

- Don't classify rows OUTSIDE chopin-nashville — the WHERE clause restricts to that tag.
- Don't auto-re-tag if the LLM returns a project not in the canonical list — log + skip.
- Don't run in CI — this is a one-shot data migration script, runs manually at sprint close.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-41-project-taxonomy/STATUS.md` under `## T4`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
