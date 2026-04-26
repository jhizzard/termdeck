# T3 — Verification probe + e2e extension

You are Terminal 3 in Sprint 34. Your lane: write the regression tests that ensure the project-tag bug can never go silent again. Two artifacts: a content-vs-tag invariant probe (skips when no live server, runs locally with DATABASE_URL set) AND an extension to flashback-e2e that asserts non-empty toast content for a project-bound session.

## Read first
1. `docs/sprint-34-project-tag-fix/PLANNING.md`
2. `docs/sprint-34-project-tag-fix/STATUS.md`
3. `docs/sprint-33-flashback-debug/POSTMORTEM.md` — the bug we're testing for
4. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
5. `tests/failure-injection.test.js` — the live-server skip pattern. Mirror it.
6. `tests/flashback-e2e.test.js` — your extension target

## You own
- NEW `tests/project-tag-invariant.test.js`
- `tests/flashback-e2e.test.js` — extension only, do NOT undo v0.7.1's instrumentation

## You DO NOT touch
- T1's source-code lane
- T2's SQL files
- T4's docs/version files
- Anything that would re-run UPDATE on the live store

## What to write

### `tests/project-tag-invariant.test.js`

Pattern: skip when no DATABASE_URL or when the connection fails. When alive, run SELECT probes and assert.

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const HAS_DB = !!process.env.DATABASE_URL || !!readSecretsEnvUrl();

test('project distribution: no single project owns >60% of the corpus unless it is the developer\'s declared dominant project', { skip: !HAS_DB }, async () => {
  const rows = await runSql("SELECT project, count(*) AS n FROM memory_items GROUP BY 1");
  const total = rows.reduce((s,r) => s + Number(r.n), 0);
  const top = rows.sort((a,b) => Number(b.n) - Number(a.n))[0];
  // After the v0.7.2 backfill, no single project should be >60% unless we explicitly mark it. chopin-nashville exceeded 60% in 2026-04-26's snapshot — that was the bug.
  if (Number(top.n) / total > 0.60 && top.project !== 'pvb') {
    assert.fail(`top project ${top.project} owns ${Math.round(100 * Number(top.n) / total)}% of corpus — possible mis-tag regression`);
  }
});

test('content-vs-tag invariant: rows containing termdeck-specific identifiers are tagged termdeck (not chopin-nashville)', { skip: !HAS_DB }, async () => {
  const rows = await runSql(
    `SELECT project, count(*) AS n FROM memory_items
     WHERE content ILIKE '%@jhizzard/termdeck%' OR content ILIKE '%packages/server/src%'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
  );
  assert.ok(rows.length > 0, 'no termdeck-content rows at all — corpus suspect');
  assert.equal(rows[0].project, 'termdeck',
    `top project for termdeck-identifier-content rows is "${rows[0].project}", expected "termdeck". Possible mis-tag regression.`);
});

// Same shape for pvb-vs-petvetbid, claimguard-vs-gorgias, mnestra-vs-engram.
```

### Extension to `tests/flashback-e2e.test.js`

Add a NEW test that:
- Spawns a session with `meta.project='termdeck'` (and `cwd=/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck` or test-equivalent)
- Triggers `cat /nonexistent/path` (now caught by v0.7.1's PATTERNS.shellError)
- Polls `rag_events` for `proactive_memory` frame
- Asserts the frame's `memories` array is non-empty
- Asserts each memory's `project` is `termdeck` or `null` (not `chopin-nashville`)

The existing test (which T1's v0.7.1 fix made pass) covers the `meta.project=null` path. This new test covers the project-bound path that v0.7.2's writer fix unblocks.

Skip gracefully when no live server. If a server is up but the corpus has zero termdeck-tagged rows (T2 hasn't run the backfill yet), the test should report a clear "needs-backfill" message rather than a generic timeout.

## Output

- `FINDING` if you discover something during writing (e.g. the live-server skip pattern fails on a particular env)
- `DONE` with test counts and skip behavior verified
- Do NOT bump versions, do NOT touch CHANGELOG.md, do NOT commit. T4 integrates.

## Reference memories
- `memory_recall("failure-injection live-server skip pattern")`
- `memory_recall("flashback-e2e pollUntil websocket race")`
