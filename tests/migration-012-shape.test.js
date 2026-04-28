// Sprint 41 (T2) — structural fixtures for migration 012_project_tag_re_taxonomy.sql.
//
// We don't run a live Postgres in CI, so this test pins the migration's
// shape so a regression at file level (accidental delete, accidental edit
// dropping a DO block, accidental rename, accidental widening to legitimate
// chopin-nashville keywords) fails loudly before the migration ever ships.
//
// What this test guarantees, in order of importance:
//   1. The file exists at the bundled mirror path.
//   2. The file is byte-identical to the Mnestra-repo primary copy. The
//      release process depends on this — `@jhizzard/mnestra` ships from the
//      Mnestra repo and `@jhizzard/termdeck` ships the bundled mirror.
//      They MUST match or fresh installs diverge.
//   3. Transaction wrapping (BEGIN / COMMIT) is in place.
//   4. The migration is idempotent — every UPDATE filters
//      `WHERE project = 'chopin-nashville'` so a second run is a no-op.
//   5. All 8 expected destination buckets are present, each emitting a
//      RAISE NOTICE with the `[012-retaxonomy]` prefix and a
//      `GET DIAGNOSTICS rows_updated = ROW_COUNT` probe.
//   6. The legitimate chopin-nashville vocabulary (competition / performance /
//      jury / sponsor / applicant / repertoire / Acceptd / NICPC / laureate)
//      is NEVER used as a re-tag trigger — those are the rows the
//      chopin-nashville tag should keep.
//   7. The dor bucket reuses 011's tightened POSIX word-boundary pattern
//      (`\mDOR\M`) — accidental loosening to `%dor%` would re-introduce
//      the 33% false-positive rate Sprint 39 caught.
//   8. The chopin-scheduler bucket includes the Maestro alias as a
//      case-sensitive word-boundary token — orchestrator's mid-inject
//      clarification 2026-04-28 confirmed Maestro = chopin-scheduler.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');

const BUNDLED_PATH = path.join(
  repoRoot,
  'packages',
  'server',
  'src',
  'setup',
  'mnestra-migrations',
  '012_project_tag_re_taxonomy.sql'
);

const MNESTRA_REPO_PATH = path.join(
  process.env.HOME || os.homedir(),
  'Documents',
  'Graciella',
  'engram',
  'migrations',
  '012_project_tag_re_taxonomy.sql'
);

test('migration 012 exists in the bundled mnestra-migrations directory', () => {
  assert.ok(fs.existsSync(BUNDLED_PATH), `missing: ${BUNDLED_PATH}`);
});

test('bundled migration 012 is byte-identical to the Mnestra-repo primary copy', { skip: !fs.existsSync(MNESTRA_REPO_PATH) ? 'Mnestra repo not present on this machine' : false }, () => {
  const a = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const b = fs.readFileSync(MNESTRA_REPO_PATH, 'utf8');
  assert.equal(a, b, 'TermDeck bundled mirror has drifted from Mnestra repo primary');
});

test('migration 012 wraps the body in BEGIN ... COMMIT', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(sql, /^\s*BEGIN;/m, 'expected leading BEGIN;');
  assert.match(sql, /^\s*COMMIT;/m, 'expected trailing COMMIT;');
});

test('migration 012 emits RAISE NOTICE probes with the [012-retaxonomy] prefix', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // BEFORE + 8 buckets + AFTER + 1 trailing acceptance-target message = 11
  // RAISE NOTICE statements minimum.
  const matches = sql.match(/RAISE NOTICE\s+'\[012-retaxonomy\]/gi) || [];
  assert.ok(
    matches.length >= 10,
    `expected >= 10 [012-retaxonomy] RAISE NOTICE probes (BEFORE + 8 buckets + AFTER), got ${matches.length}`
  );
});

test('migration 012 every UPDATE is gated by WHERE project = \'chopin-nashville\' (idempotence)', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Find every `UPDATE memory_items SET project = '<tag>'` and require the
  // immediately following body (until the closing `;`) to contain
  // `project = 'chopin-nashville'`. If any UPDATE skips the gate, the
  // migration loses idempotence — re-running would touch already-correct
  // rows.
  const re = /update\s+memory_items\s+set\s+project\s*=\s*'([^']+)'([\s\S]*?);/gi;
  let m;
  let updateCount = 0;
  while ((m = re.exec(sql)) !== null) {
    updateCount += 1;
    const targetTag = m[1];
    const body = m[2];
    assert.match(
      body,
      /project\s*=\s*'chopin-nashville'/i,
      `UPDATE -> '${targetTag}' is missing the chopin-nashville idempotence gate`
    );
  }
  assert.equal(updateCount, 8, `expected exactly 8 UPDATE statements (one per bucket), got ${updateCount}`);
});

test('migration 012 covers all 8 expected destination buckets', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const expectedTargets = [
    'termdeck',
    'rumen',
    'podium',
    'chopin-in-bohemia',
    'chopin-scheduler',
    'pvb',
    'claimguard',
    'dor',
  ];
  for (const tag of expectedTargets) {
    assert.match(
      sql,
      new RegExp(`update\\s+memory_items\\s+set\\s+project\\s*=\\s*'${tag.replace(/-/g, '\\-')}'`, 'i'),
      `missing UPDATE -> '${tag}' bucket`
    );
  }
});

test('migration 012 termdeck bucket includes the widened keyword set from the briefing', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Sprint 41 widens 011's [termdeck | mnestra | "4+1 sprint"] with five
  // additional TermDeck-internal markers. Pin them so a future edit can't
  // accidentally narrow the bucket back.
  const widenedMarkers = [
    '%termdeck%',
    '%mnestra%',
    '%4+1 sprint%',
    '%xterm%',
    '%node-pty%',
    '%flashback%',
    '%memory_items%',
    '%memory_relationships%',
  ];
  for (const marker of widenedMarkers) {
    assert.ok(
      sql.includes(marker),
      `termdeck bucket missing widened keyword: ${marker}`
    );
  }
});

test('migration 012 chopin-scheduler bucket includes path markers AND the Maestro alias', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Per orchestrator clarification 2026-04-28 12:51 ET: Maestro is the
  // working name for the chopin-scheduler project. Pin both surfaces.
  assert.ok(
    sql.includes('%scheduling%'),
    'chopin-scheduler bucket missing %scheduling% keyword'
  );
  assert.ok(
    sql.includes('%schedulingapp%'),
    'chopin-scheduler bucket missing %schedulingapp% keyword'
  );
  // Case-sensitive word-boundary Maestro — POSIX `\m` and `\M` operators.
  // Lowercase `~ '\\mmaestro\\M'` would NOT count.
  assert.match(
    sql,
    /content\s+~\s+'\\mMaestro\\M'/i,
    'chopin-scheduler bucket missing case-sensitive \\mMaestro\\M word-boundary token'
  );
});

test('migration 012 dor bucket reuses 011\'s tightened POSIX word-boundary pattern', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Sprint 39 audit found `%dor%` produced 33% false positives ("dormant",
  // "vendored", "indoor"). The fix was POSIX word boundary `\mDOR\M` plus
  // path/identifier markers + openclaw. 012 reuses this verbatim.
  assert.match(
    sql,
    /content\s+~\s+'\\mDOR\\M'/i,
    'dor bucket missing the POSIX word-boundary `\\mDOR\\M` pattern'
  );
  assert.ok(sql.includes('openclaw'), 'dor bucket missing the openclaw substring');
  assert.ok(sql.includes('Rust LLM gateway'), 'dor bucket missing the "Rust LLM gateway" tagline marker');
  // Naked `%dor%` ILIKE would re-introduce the false-positive bleed. The
  // tightened pattern uses `\mDOR\M` (case-sensitive) instead.
  assert.equal(
    /content\s+ilike\s+'%dor%'/i.test(sql),
    false,
    'naked %dor% ILIKE re-introduces 33% false-positive rate; must use \\mDOR\\M instead'
  );
});

test('migration 012 NEVER uses legitimate chopin-nashville keywords as re-tag triggers', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // These are the words a row would use to LEGITIMATELY belong under
  // chopin-nashville (competition management work). If any of them ever
  // shows up as a re-tag trigger in a bucket UPDATE, T2's conservative
  // contract is broken — those rows would land in the wrong tag.
  //
  // Allow these words to appear in comments / RAISE NOTICE strings (the
  // post-apply verification queries enumerate them as "things that should
  // STAY chopin-nashville"). The check filters on what's actually inside
  // an `UPDATE ... SET project = '...' WHERE ... ;` block.
  const updateBlocks = [];
  const re = /update\s+memory_items\s+set\s+project\s*=\s*'[^']+'([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    updateBlocks.push(m[1]);
  }
  assert.ok(updateBlocks.length > 0, 'no UPDATE blocks detected; test cannot run');

  const legitimateTriggers = [
    'competition',
    'performance',
    'jury',
    'sponsor',
    'applicant',
    'repertoire',
    'Acceptd',
    'NICPC',
    'laureate',
  ];
  for (const word of legitimateTriggers) {
    for (const block of updateBlocks) {
      const re2 = new RegExp(`ilike\\s+'%${word}%'`, 'i');
      assert.equal(
        re2.test(block),
        false,
        `legitimate chopin-nashville keyword "${word}" used as a re-tag trigger inside an UPDATE block — this would mis-classify legitimate competition rows`
      );
    }
  }
});

test('migration 012 has GET DIAGNOSTICS rows_updated = ROW_COUNT in every bucket DO block', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // The bundled migration runner uses node-postgres client.query, which
  // doesn't support psql's \gset. The only way per-bucket counts surface
  // in the orchestrator's apply log is via GET DIAGNOSTICS inside a DO
  // block. Pin that every UPDATE bucket has one.
  const matches = sql.match(/get\s+diagnostics\s+rows_updated\s*=\s*row_count/gi) || [];
  assert.equal(
    matches.length,
    8,
    `expected 8 GET DIAGNOSTICS ROW_COUNT probes (one per bucket), got ${matches.length}`
  );
});

test('migration 012 audit blocks (BEFORE + AFTER) probe every destination tag', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // BEFORE and AFTER blocks each SELECT count(*) for every project tag the
  // migration touches. Find every DO $$ ... END $$; block, then identify
  // which one contains the BEFORE / AFTER RAISE NOTICE marker.
  const doBlocks = sql.match(/do\s+\$\$[\s\S]*?\$\$;/gi) || [];
  const beforeBlock = doBlocks.find((b) => /\[012-retaxonomy\]\s+BEFORE\b/.test(b)) || '';
  const afterBlock = doBlocks.find((b) => /\[012-retaxonomy\]\s+AFTER\b/.test(b)) || '';

  assert.ok(beforeBlock.length > 0, 'no BEFORE audit DO block found');
  assert.ok(afterBlock.length > 0, 'no AFTER audit DO block found');

  const expectedTags = [
    'chopin-nashville',
    'termdeck',
    'rumen',
    'podium',
    'chopin-in-bohemia',
    'chopin-scheduler',
    'pvb',
    'claimguard',
    'dor',
  ];
  for (const tag of expectedTags) {
    assert.ok(
      beforeBlock.includes(`'${tag}'`),
      `BEFORE audit block missing count probe for project = '${tag}'`
    );
    assert.ok(
      afterBlock.includes(`'${tag}'`),
      `AFTER audit block missing count probe for project = '${tag}'`
    );
  }
});
