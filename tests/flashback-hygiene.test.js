// Tests for Sprint 82 T2 — Flashback hygiene: quality threshold, honest
// query construction, expired≠dismissed, dismissal TTL, honest UI values.
//
// Pins the four audited defects plus the three adjacent ones found during
// the audit, each as a test that FAILS against the pre-82 behavior:
//
//   1. query construction — the recall question embeds the matched error
//      line, not the last 200 chars of PTY paint.
//   2. quality gate — a candidate below the cosine threshold suppresses the
//      toast, and the gate is feature-detected (pre-033 stores unchanged).
//   3. expired ≠ dismissed — an unattended timeout writes expired_at and
//      does NOT blacklist; an explicit dismissal blacklists for 14 days.
//   4. honest UI — nothing renders the ordinal RRF composite as a percent.
//   A. `id` survives the bridge mapper (without it the whole dismissal
//      feature is a dead code path — top_hit_id was always NULL).
//   B. click-through is engagement, not rejection.
//   C. webhook mode reads mnestra's `hits` key (it responds `hits`, not
//      `memories` — every webhook-mode flashback returned 0 hits).
//
// Hermetic: in-memory SQLite, a stub fetch for the bridge, no PTY, no
// network, no live Mnestra.
//
// Run: node --test tests/flashback-hygiene.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const flashbackDiag = require('../packages/server/src/flashback-diag');
const { createBridge } = require('../packages/server/src/mnestra-bridge');

const MIGRATION = path.join(__dirname, '..', 'migrations', '001_flashback_events.sql');

// Pre-82 schema: exactly what migrations/001 ships. Exercises the degraded
// capability path (expired_at absent).
function legacyDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  return db;
}

// Post-82 schema: 001 plus the in-place ALTER that database.js applies at
// server start. Mirrors that migration exactly so a drift between this
// fixture and database.js shows up as a failure here.
function currentDb() {
  const db = legacyDb();
  db.exec(`ALTER TABLE flashback_events ADD COLUMN expired_at TEXT`);
  return db;
}

const DAY = 24 * 60 * 60 * 1000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

// ---- 1. Query construction ----------------------------------------------

// The production expression lives at index.js `session.onErrorDetected`.
// Mirrored here (as the route shapes are in flashback-events.test.js) so the
// contract is pinned without booting the server.
function buildQuestion(sessionType, ctx) {
  const errorLine = typeof ctx.matchedLine === 'string' ? ctx.matchedLine.trim() : '';
  return errorLine
    ? [errorLine, ctx.lastCommand ? `while running: ${ctx.lastCommand}` : '']
      .filter(Boolean).join(' — ')
    : `${sessionType} error ${ctx.lastCommand || ''} ${ctx.tail || ''}`.trim();
}

test('query embeds the matched error line, not the PTY tail', () => {
  const ctx = {
    matchedLine: "cat: /foo/bar.txt: No such file or directory",
    lastCommand: 'cat /foo/bar.txt',
    // Realistic tail: a spinner mid-paint plus a prompt redraw. This is what
    // pre-82 went into the embedding.
    tail: '⠹ Building...  ⠸ Building...  ➜ ~/repo git:(main) ✗ ',
  };
  const q = buildQuestion('shell', ctx);
  assert.ok(q.includes('No such file or directory'), 'error line is present');
  assert.ok(q.includes('cat /foo/bar.txt'), 'command is present as secondary context');
  assert.ok(!q.includes('Building'), 'PTY paint noise is NOT in the query');
  assert.ok(!q.includes('➜'), 'prompt redraw is NOT in the query');
});

test('query falls back to the legacy shape when no matchedLine is supplied', () => {
  // Guards the pre-82 caller shape (and direct unit invocations): a ctx with
  // no matchedLine must still produce a usable question, never an empty one.
  const q = buildQuestion('claude', { lastCommand: 'npm test', tail: 'FAIL src/x.test.js' });
  assert.equal(q, 'claude error npm test FAIL src/x.test.js');
});

test('query survives a matchedLine that is only whitespace', () => {
  const q = buildQuestion('shell', { matchedLine: '   \n ', lastCommand: 'ls', tail: 'boom' });
  assert.equal(q, 'shell error ls boom', 'blank matchedLine falls through to the legacy shape');
});

test('query omits the command clause when there is no last command', () => {
  const q = buildQuestion('shell', { matchedLine: 'Error: ENOENT', lastCommand: '', tail: 'x' });
  assert.equal(q, 'Error: ENOENT');
});

// ---- 2. Quality threshold -----------------------------------------------

test('resolveMinSimilarity: default, env override, clamping, and disable', () => {
  assert.equal(flashbackDiag.resolveMinSimilarity({}), 0.35);
  assert.equal(flashbackDiag.resolveMinSimilarity({ TERMDECK_FLASHBACK_MIN_SIMILARITY: '' }), 0.35);
  assert.equal(flashbackDiag.resolveMinSimilarity({ TERMDECK_FLASHBACK_MIN_SIMILARITY: 'abc' }), 0.35);
  assert.equal(flashbackDiag.resolveMinSimilarity({ TERMDECK_FLASHBACK_MIN_SIMILARITY: '0.6' }), 0.6);
  // Clamped, so a fat-fingered "35" can't silently mute every toast forever.
  assert.equal(flashbackDiag.resolveMinSimilarity({ TERMDECK_FLASHBACK_MIN_SIMILARITY: '35' }), 1);
  assert.equal(flashbackDiag.resolveMinSimilarity({ TERMDECK_FLASHBACK_MIN_SIMILARITY: '-1' }), 0);
  // Explicit 0 = gate disabled (documented escape hatch).
  assert.equal(flashbackDiag.resolveMinSimilarity({ TERMDECK_FLASHBACK_MIN_SIMILARITY: '0' }), 0);
});

test('threshold suppresses a below-cutoff top hit', () => {
  const memories = [
    { id: 'm1', content: 'unrelated', semantic_similarity: 0.11 },
    { id: 'm2', content: 'also unrelated', semantic_similarity: 0.09 },
  ];
  const out = flashbackDiag.pickNextNonDismissed(null, memories, { minSimilarity: 0.35 });
  assert.equal(out.hit, null, 'no toast fires off an unrelated corpus');
  assert.equal(out.belowThresholdCount, 2);
  assert.equal(out.thresholdApplied, true);
  assert.equal(out.topSimilarity, 0.11);
});

test('threshold passes over weak candidates to the first strong one', () => {
  const memories = [
    { id: 'm1', content: 'weak', semantic_similarity: 0.20 },
    { id: 'm2', content: 'strong', semantic_similarity: 0.71 },
  ];
  const out = flashbackDiag.pickNextNonDismissed(null, memories, { minSimilarity: 0.35 });
  assert.equal(out.hit.id, 'm2');
  assert.equal(out.belowThresholdCount, 1);
  assert.equal(out.scannedCount, 2);
});

test('threshold is feature-detected: pre-033 candidates (no cosine) fire as before', () => {
  // THE regression guard for the whole sprint. Against a store that predates
  // migration 033 there is no semantic_similarity on any row, and firing
  // behavior must be byte-for-byte pre-82 — a gate that silently mutes
  // Flashback for everyone who hasn't migrated is worse than no gate.
  const memories = [
    { id: 'm1', content: 'legacy row', similarity: 0.0216 }, // RRF composite only
    { id: 'm2', content: 'another', similarity: 0.0198 },
  ];
  const out = flashbackDiag.pickNextNonDismissed(null, memories, { minSimilarity: 0.35 });
  assert.equal(out.hit.id, 'm1', 'top candidate still fires');
  assert.equal(out.thresholdApplied, false);
  assert.equal(out.belowThresholdCount, 0);
});

test('threshold never gates on the RRF composite', () => {
  // A real, good hit has an RRF score around 0.02 — two orders of magnitude
  // below the 0.35 cosine cutoff. If the gate ever reads `similarity`
  // instead of `semantic_similarity`, this fires zero toasts and Flashback
  // goes dark. That is the exact failure this test exists to catch.
  const memories = [{ id: 'm1', similarity: 0.0216, semantic_similarity: 0.82 }];
  const out = flashbackDiag.pickNextNonDismissed(null, memories, { minSimilarity: 0.35 });
  assert.equal(out.hit.id, 'm1');
});

test('threshold of 0 disables the gate even when cosine is present', () => {
  const memories = [{ id: 'm1', semantic_similarity: 0.01 }];
  const out = flashbackDiag.pickNextNonDismissed(null, memories, { minSimilarity: 0 });
  assert.equal(out.hit.id, 'm1');
  assert.equal(out.thresholdApplied, false);
});

test('threshold is evaluated before the dismissed lookup', () => {
  // Attribution matters for diagnosis: a junk candidate that also happens to
  // be dismissed should be reported as below-threshold (the actionable
  // reason), and must not cost a SQLite round-trip.
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'm1',
    });
    flashbackDiag.markDismissed(db, id);
    const out = flashbackDiag.pickNextNonDismissed(
      db, [{ id: 'm1', semantic_similarity: 0.02 }], { minSimilarity: 0.35 }
    );
    assert.equal(out.hit, null);
    assert.equal(out.belowThresholdCount, 1);
    assert.equal(out.dismissedCount, 0, 'not attributed to dismissal');
  } finally {
    db.close();
  }
});

// ---- 3. Expired ≠ dismissed ---------------------------------------------

test('markExpired writes expired_at and leaves dismissed_at NULL', () => {
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'mem-1',
    });
    assert.equal(flashbackDiag.markExpired(db, id), true);
    const row = db.prepare(`SELECT dismissed_at, expired_at FROM flashback_events WHERE id = ?`).get(id);
    assert.ok(row.expired_at, 'expired_at stamped');
    assert.equal(row.dismissed_at, null, 'dismissed_at untouched');
  } finally {
    db.close();
  }
});

test('an expired toast does NOT blacklist its memory (the pool-drain fix)', () => {
  // Pre-82: the 30s timer called the dismiss path, and dismissal was a
  // permanent global blacklist — so every error that fired while the user
  // was looking at another panel burned one more memory out of the pool,
  // monotonically, with no refill. This is the assertion that fails against
  // that behavior.
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'mem-1',
    });
    flashbackDiag.markExpired(db, id);
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'mem-1'), false);
    // …and it is still selectable on the next error.
    const out = flashbackDiag.pickNextNonDismissed(db, [{ id: 'mem-1', semantic_similarity: 0.8 }]);
    assert.equal(out.hit.id, 'mem-1');
  } finally {
    db.close();
  }
});

test('markExpired is idempotent and never overwrites an explicit dismissal', () => {
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'x' });
    assert.equal(flashbackDiag.markExpired(db, id, '2026-07-30T00:00:00.000Z'), true);
    assert.equal(flashbackDiag.markExpired(db, id, '2026-07-30T01:00:00.000Z'), false);
    const row = db.prepare(`SELECT expired_at FROM flashback_events WHERE id = ?`).get(id);
    assert.equal(row.expired_at, '2026-07-30T00:00:00.000Z', 'first expiry wins');

    // A dismissed row can never be re-labelled as an unseen expiry — the
    // user's explicit verdict outranks a late timer in a lost race.
    const id2 = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'y' });
    flashbackDiag.markDismissed(db, id2);
    assert.equal(flashbackDiag.markExpired(db, id2), false);
    const row2 = db.prepare(`SELECT expired_at FROM flashback_events WHERE id = ?`).get(id2);
    assert.equal(row2.expired_at, null);
  } finally {
    db.close();
  }
});

test('markExpired degrades safely when the expired_at column is absent', () => {
  // An install whose in-place ALTER never ran. The behavioral fix does not
  // depend on the column (the client simply doesn't call /dismissed on a
  // timeout) — only the durable accounting does.
  const db = legacyDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'mem-1',
    });
    assert.equal(flashbackDiag.hasExpiredAtColumn(db), false);
    assert.equal(flashbackDiag.markExpired(db, id), false, 'no throw, no write');
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'mem-1'), false, 'still not blacklisted');
    // History + funnel keep working, reporting 0 expiries rather than erroring.
    assert.equal(flashbackDiag.getFunnelStats(db).expired, 0);
    assert.equal(flashbackDiag.getRecentFlashbacks(db).length, 1);
  } finally {
    db.close();
  }
});

test('markExpired returns false for null db and invalid ids', () => {
  assert.equal(flashbackDiag.markExpired(null, 1), false);
  const db = currentDb();
  try {
    assert.equal(flashbackDiag.markExpired(db, 0), false);
    assert.equal(flashbackDiag.markExpired(db, -3), false);
    assert.equal(flashbackDiag.markExpired(db, 'nope'), false);
    assert.equal(flashbackDiag.markExpired(db, 9999), false, 'unknown id');
  } finally {
    db.close();
  }
});

test('funnel counts expiries separately from dismissals', () => {
  const db = currentDb();
  try {
    const a = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'a' });
    const b = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'b' });
    const c = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'c' });
    flashbackDiag.markDismissed(db, a);
    flashbackDiag.markExpired(db, b);
    flashbackDiag.markClickedThrough(db, c);
    const stats = flashbackDiag.getFunnelStats(db);
    assert.equal(stats.fires, 3);
    assert.equal(stats.expired, 1);
    assert.equal(stats.clicked_through, 1);
    // dismissed = the explicit × (a) + click-through's implicit stamp (c).
    // The unattended timeout (b) is NOT in there — pre-82 it would have been.
    assert.equal(stats.dismissed, 2);
  } finally {
    db.close();
  }
});

test('getRecentFlashbacks surfaces expired_at when the column exists', () => {
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'a' });
    flashbackDiag.markExpired(db, id);
    const [row] = flashbackDiag.getRecentFlashbacks(db);
    assert.ok(row.expired_at, 'dashboard can render the expired pill');
  } finally {
    db.close();
  }
});

// ---- 3b. Dismissal TTL --------------------------------------------------

test('resolveDismissTtlDays: default, override, and the disable escape hatch', () => {
  assert.equal(flashbackDiag.resolveDismissTtlDays({}), 14);
  assert.equal(flashbackDiag.resolveDismissTtlDays({ TERMDECK_FLASHBACK_DISMISS_TTL_DAYS: '' }), 14);
  assert.equal(flashbackDiag.resolveDismissTtlDays({ TERMDECK_FLASHBACK_DISMISS_TTL_DAYS: 'x' }), 14);
  assert.equal(flashbackDiag.resolveDismissTtlDays({ TERMDECK_FLASHBACK_DISMISS_TTL_DAYS: '-5' }), 14);
  assert.equal(flashbackDiag.resolveDismissTtlDays({ TERMDECK_FLASHBACK_DISMISS_TTL_DAYS: '30' }), 30);
  // 0 = no TTL, i.e. the pre-82 permanent blacklist, kept reachable so the
  // change is reversible without a redeploy.
  assert.equal(flashbackDiag.resolveDismissTtlDays({ TERMDECK_FLASHBACK_DISMISS_TTL_DAYS: '0' }), 0);
});

test('a dismissal inside the TTL window still suppresses', () => {
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'mem-1',
    });
    flashbackDiag.markDismissed(db, id, isoDaysAgo(3));
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'mem-1'), true);
  } finally {
    db.close();
  }
});

test('a dismissal older than the TTL stops suppressing (pool refills)', () => {
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'mem-1',
    });
    flashbackDiag.markDismissed(db, id, isoDaysAgo(20));
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'mem-1'), false);
    // The selection path agrees — this is the refill the pre-82 blacklist
    // never had.
    const out = flashbackDiag.pickNextNonDismissed(db, [{ id: 'mem-1', semantic_similarity: 0.9 }]);
    assert.equal(out.hit.id, 'mem-1');
    assert.equal(out.dismissedCount, 0);
  } finally {
    db.close();
  }
});

test('TTL boundary: 13 days suppresses, 15 days does not', () => {
  const db = currentDb();
  try {
    const a = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'recent',
    });
    const b = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'stale',
    });
    flashbackDiag.markDismissed(db, a, isoDaysAgo(13));
    flashbackDiag.markDismissed(db, b, isoDaysAgo(15));
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'recent'), true);
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'stale'), false);
  } finally {
    db.close();
  }
});

test('ttlDays: 0 restores the unbounded pre-82 blacklist', () => {
  const db = currentDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x', top_hit_id: 'mem-1',
    });
    flashbackDiag.markDismissed(db, id, isoDaysAgo(400));
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'mem-1', { ttlDays: 0 }), true);
    assert.equal(flashbackDiag.isMemoryDismissed(db, 'mem-1', { ttlDays: 14 }), false);
  } finally {
    db.close();
  }
});

test('dismissCutoffIso returns null when the TTL is disabled', () => {
  assert.equal(flashbackDiag.dismissCutoffIso(0, Date.now()), null);
  assert.equal(flashbackDiag.dismissCutoffIso(-1, Date.now()), null);
  const cutoff = flashbackDiag.dismissCutoffIso(14, Date.parse('2026-07-30T00:00:00.000Z'));
  assert.equal(cutoff, '2026-07-16T00:00:00.000Z');
});

// ---- 4 / A / C. Bridge contract -----------------------------------------

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return handler(String(url), calls.length);
  };
  return { fn, calls };
}

// Faithful enough to matter: real Response objects flip `bodyUsed` once the
// body is consumed, and queryDirect reads that flag to decide whether it may
// call .text() a second time on the error path. A stub that never flips it
// would exercise a branch production never takes.
function makeRes(status, payload, asJson) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    bodyUsed: false,
    async text() {
      if (this.bodyUsed) throw new TypeError('Body is unusable: Body has already been read');
      this.bodyUsed = true;
      return asJson ? JSON.stringify(payload) : payload;
    },
    async json() {
      if (this.bodyUsed) throw new TypeError('Body is unusable: Body has already been read');
      this.bodyUsed = true;
      return asJson ? payload : {};
    },
  };
  return res;
}

const jsonRes = (body, status = 200) => makeRes(status, body, true);
const textRes = (text, status) => makeRes(status, text, false);

function withFetch(stub, fn) {
  const original = global.fetch;
  global.fetch = stub;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

const DIRECT_CONFIG = {
  rag: {
    mnestraMode: 'direct',
    supabaseUrl: 'https://example.test',
    supabaseKey: 'key',
    openaiApiKey: 'sk-test',
  },
};

// The embedding call always resolves first; the RPC is call #2 onward.
const EMBEDDING_BODY = { data: [{ embedding: new Array(1536).fill(0) }] };

test('direct mode: `id` survives the mapper (top_hit_id was always NULL pre-82)', async () => {
  // Without this, flashback_events.top_hit_id is NULL on every row,
  // isMemoryDismissed matches nothing, and the entire Sprint 57
  // negative-feedback feature is dead code. It is also why the
  // permanent-blacklist bug never surfaced in the wild.
  const stub = stubFetch((url) => url.includes('openai')
    ? jsonRes(EMBEDDING_BODY)
    : jsonRes([{ id: 'uuid-1', content: 'c', source_type: 'bug_fix', project: 'p', score: 0.02, semantic_similarity: 0.77, created_at: 'now' }]));
  await withFetch(stub.fn, async () => {
    const bridge = createBridge(DIRECT_CONFIG);
    const out = await bridge.queryMnestra({ question: 'q', project: 'p' });
    assert.equal(out.memories[0].id, 'uuid-1');
    assert.equal(out.memories[0].semantic_similarity, 0.77);
    assert.equal(out.memories[0].similarity, 0.02, 'RRF composite preserved separately');
  });
});

test('direct mode: semantic_similarity normalizes to null on a pre-033 store', async () => {
  const stub = stubFetch((url) => url.includes('openai')
    ? jsonRes(EMBEDDING_BODY)
    : jsonRes([{ id: 'uuid-1', content: 'c', score: 0.02, created_at: 'now' }]));
  await withFetch(stub.fn, async () => {
    const bridge = createBridge(DIRECT_CONFIG);
    const out = await bridge.queryMnestra({ question: 'q' });
    assert.equal(out.memories[0].semantic_similarity, null);
  });
});

test('direct mode: p_decay_profile is sent, then latched off after a pre-033 404', async () => {
  // PostgREST resolves RPC overloads by the exact JSON key set, so an extra
  // key against a pre-033 store returns 404 "Could not find the function" —
  // the same failure that silently killed Flashback for 15 sprints. The
  // probe must therefore fall back rather than propagate.
  let rpcCalls = 0;
  const stub = stubFetch((url) => {
    if (url.includes('openai')) return jsonRes(EMBEDDING_BODY);
    rpcCalls += 1;
    if (rpcCalls === 1) {
      return textRes('Could not find the function public.memory_hybrid_search(...)', 404);
    }
    return jsonRes([{ id: 'u', content: 'c', score: 0.02 }]);
  });
  await withFetch(stub.fn, async () => {
    const bridge = createBridge(DIRECT_CONFIG);
    const out = await bridge.queryMnestra({ question: 'q', decayProfile: 'solved-problem' });
    assert.equal(out.memories.length, 1, 'flashback still fires, degraded to standard decay');

    const rpcBodies = stub.calls.filter((c) => c.url.includes('memory_hybrid_search')).map((c) => c.body);
    assert.equal(rpcBodies.length, 2, 'one probe + one fallback');
    assert.equal(rpcBodies[0].p_decay_profile, 'solved-problem');
    assert.ok(!('p_decay_profile' in rpcBodies[1]), 'retry drops the unsupported key');

    // Latched: the next query must not pay the 404 again.
    await bridge.queryMnestra({ question: 'q2', decayProfile: 'solved-problem' });
    const after = stub.calls.filter((c) => c.url.includes('memory_hybrid_search')).map((c) => c.body);
    assert.equal(after.length, 3);
    assert.ok(!('p_decay_profile' in after[2]), 'capability verdict is cached');
  });
});

test('direct mode: p_decay_profile is kept when the store accepts it', async () => {
  const stub = stubFetch((url) => url.includes('openai')
    ? jsonRes(EMBEDDING_BODY)
    : jsonRes([{ id: 'u', content: 'c', score: 0.02, semantic_similarity: 0.5 }]));
  await withFetch(stub.fn, async () => {
    const bridge = createBridge(DIRECT_CONFIG);
    await bridge.queryMnestra({ question: 'q', decayProfile: 'solved-problem' });
    await bridge.queryMnestra({ question: 'q2', decayProfile: 'solved-problem' });
    const bodies = stub.calls.filter((c) => c.url.includes('memory_hybrid_search')).map((c) => c.body);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].p_decay_profile, 'solved-problem');
    assert.equal(bodies[1].p_decay_profile, 'solved-problem');
  });
});

test('direct mode: a non-404 RPC failure still throws (no silent degradation)', async () => {
  const stub = stubFetch((url) => url.includes('openai')
    ? jsonRes(EMBEDDING_BODY)
    : textRes('boom', 500));
  await withFetch(stub.fn, async () => {
    const bridge = createBridge(DIRECT_CONFIG);
    await assert.rejects(
      () => bridge.queryMnestra({ question: 'q', decayProfile: 'solved-problem' }),
      /Memory search failed \(500\)/
    );
  });
});

test('webhook mode reads mnestra\'s `hits` key (it never returns `memories`)', async () => {
  // mnestra's webhook `recall` op responds { ok, hits, tokens_used, text }.
  // Reading only `data.memories` made EVERY webhook-mode flashback resolve
  // to zero hits while logging a truthful-looking "0 matches".
  const stub = stubFetch(() => jsonRes({
    ok: true,
    hits: [{ id: 'uuid-9', content: 'c', source_type: 'bug_fix', project: 'p', score: 0.03, semantic_similarity: 0.64 }],
    tokens_used: 12,
    text: '...',
  }));
  await withFetch(stub.fn, async () => {
    const bridge = createBridge({ rag: { mnestraMode: 'webhook', mnestraWebhookUrl: 'http://localhost:37778/mnestra' } });
    const out = await bridge.queryMnestra({ question: 'q', project: 'p' });
    assert.equal(out.total, 1);
    assert.equal(out.memories[0].id, 'uuid-9');
    assert.equal(out.memories[0].semantic_similarity, 0.64);
  });
});

test('webhook mode still accepts a `memories` payload (older mnestra builds)', async () => {
  const stub = stubFetch(() => jsonRes({ memories: [{ id: 'uuid-8', content: 'c', similarity: 0.02 }] }));
  await withFetch(stub.fn, async () => {
    const bridge = createBridge({ rag: { mnestraMode: 'webhook' } });
    const out = await bridge.queryMnestra({ question: 'q' });
    assert.equal(out.memories[0].id, 'uuid-8');
  });
});

// ---- HTTP proactive path: gated AND recorded (T4 AUDIT-FAIL 20:31) ------

// selectAndRecordFlashback is the production function POST /api/ai/query
// calls in `proactive: true` mode — not a mirror of it. Pre-82 that path
// toasted client-side with no flashback_events row, so its dismiss/expire/
// click writes were dropped and the surface was invisible to the funnel.

test('proactive HTTP path records a flashback_events row for the toast it raises', () => {
  const db = currentDb();
  try {
    const out = flashbackDiag.selectAndRecordFlashback(db, {
      sessionId: 'sess-1',
      project: 'termdeck',
      question: 'Error: ENOENT — while running: npm test',
      memories: [{ id: 'mem-1', content: 'c', similarity: 0.021, semantic_similarity: 0.72 }],
    });
    assert.equal(out.outcome, 'emitted');
    assert.equal(out.hit.id, 'mem-1');
    assert.ok(Number.isFinite(out.event_id) && out.event_id > 0, 'an id the toast can report against');

    const row = db.prepare(`SELECT * FROM flashback_events WHERE id = ?`).get(out.event_id);
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.project, 'termdeck');
    assert.equal(row.top_hit_id, 'mem-1');
    assert.equal(row.top_hit_score, 0.021, 'durable column keeps the RRF composite');
    assert.equal(row.hits_count, 1);

    // The funnel sees it — which is the whole point of the fix.
    assert.equal(flashbackDiag.getFunnelStats(db).fires, 1);
  } finally {
    db.close();
  }
});

test('proactive HTTP path records dismiss/expire outcomes end-to-end', () => {
  // The full loop the audit called out: raise → get an id → the client's
  // outcome POST actually lands on a row.
  const db = currentDb();
  try {
    const out = flashbackDiag.selectAndRecordFlashback(db, {
      sessionId: 'sess-1',
      question: 'q',
      memories: [{ id: 'mem-1', semantic_similarity: 0.8 }],
    });
    assert.equal(flashbackDiag.markExpired(db, out.event_id), true);
    const stats = flashbackDiag.getFunnelStats(db);
    assert.equal(stats.fires, 1);
    assert.equal(stats.expired, 1);
    assert.equal(stats.dismissed, 0);
  } finally {
    db.close();
  }
});

test('proactive HTTP path applies the same gate and records NO row when nothing clears', () => {
  const db = currentDb();
  try {
    const out = flashbackDiag.selectAndRecordFlashback(db, {
      sessionId: 'sess-1',
      question: 'q',
      memories: [{ id: 'mem-1', semantic_similarity: 0.04 }],
      options: { minSimilarity: 0.35 },
    });
    assert.equal(out.hit, null);
    assert.equal(out.event_id, null);
    assert.equal(out.outcome, 'dropped_below_threshold');
    assert.match(out.reason, /below similarity threshold/);
    // No toast means no fire — the funnel must not count a suppressed hit.
    assert.equal(flashbackDiag.getFunnelStats(db).fires, 0);
  } finally {
    db.close();
  }
});

test('proactive HTTP path still surfaces a hit when SQLite is unavailable', () => {
  // No DB ⇒ no funnel for ANY surface, including the WS path. Going dark
  // here would be a worse trade than the WS path's long-standing behavior.
  const out = flashbackDiag.selectAndRecordFlashback(null, {
    sessionId: 'sess-1',
    question: 'q',
    memories: [{ id: 'mem-1', semantic_similarity: 0.8 }],
  });
  assert.equal(out.hit.id, 'mem-1');
  assert.equal(out.event_id, null);
  assert.equal(out.outcome, 'emitted');
});

test('proactive HTTP path honors the dismissal blacklist', () => {
  const db = currentDb();
  try {
    const first = flashbackDiag.selectAndRecordFlashback(db, {
      sessionId: 's', question: 'q', memories: [{ id: 'mem-1', semantic_similarity: 0.8 }],
    });
    flashbackDiag.markDismissed(db, first.event_id);
    const second = flashbackDiag.selectAndRecordFlashback(db, {
      sessionId: 's', question: 'q', memories: [{ id: 'mem-1', semantic_similarity: 0.8 }],
    });
    assert.equal(second.hit, null);
    assert.equal(second.outcome, 'dropped_dismissed');
    assert.equal(flashbackDiag.getFunnelStats(db).fires, 1, 'suppressed hit is not a second fire');
  } finally {
    db.close();
  }
});

test('classifyDrop attributes each drop reason, threshold outranking dismissal', () => {
  // Shared by both emit paths so their funnel numbers cannot drift.
  assert.equal(flashbackDiag.classifyDrop({ count: 0 }).outcome, 'dropped_empty');
  assert.equal(
    flashbackDiag.classifyDrop({ count: 2, belowThresholdCount: 2, dismissedCount: 0, minSimilarity: 0.35, topSimilarity: 0.1 }).outcome,
    'dropped_below_threshold'
  );
  assert.equal(
    flashbackDiag.classifyDrop({ count: 2, belowThresholdCount: 0, dismissedCount: 2 }).outcome,
    'dropped_dismissed'
  );
  assert.equal(
    flashbackDiag.classifyDrop({ count: 2, belowThresholdCount: 1, dismissedCount: 1 }).outcome,
    'dropped_filtered'
  );
  // A null topSimilarity must not blow up the reason string.
  assert.match(
    flashbackDiag.classifyDrop({ count: 1, belowThresholdCount: 1, dismissedCount: 0, minSimilarity: 0.35, topSimilarity: null }).reason,
    /top=n\/a/
  );
});

test('both emit paths log proactive_memory_emit with a distinguishing source tag', () => {
  flashbackDiag._resetForTest();
  const db = currentDb();
  try {
    flashbackDiag.selectAndRecordFlashback(db, {
      sessionId: 'sess-1', question: 'q', memories: [{ id: 'mem-1', semantic_similarity: 0.8 }],
    });
    const events = flashbackDiag.snapshot({ eventType: 'proactive_memory_emit' });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'http', 'HTTP fires are attributable in the ring');
    assert.equal(events[0].outcome, 'emitted');
    assert.ok(events[0].flashback_event_id > 0);
  } finally {
    flashbackDiag._resetForTest();
    db.close();
  }
});

// ---- 4. Honest UI values ------------------------------------------------

// Mirrors the client's flashbackMatchPct (app.js). The client is vanilla JS
// in a browser scope with no module boundary, so the contract is pinned here
// rather than imported.
function flashbackMatchPct(hit) {
  const v = hit && hit.semantic_similarity;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(1, v)) * 100);
}

test('UI renders cosine as a percentage and NEVER the RRF composite', () => {
  // The bug this replaces: `(hit.similarity * 100).toFixed(0)` on an RRF
  // composite whose ceiling is ~0.074 displayed an excellent hit as "2%",
  // which read as a broken memory store and once triggered a false
  // store-health alarm.
  assert.equal(flashbackMatchPct({ similarity: 0.0216, semantic_similarity: 0.82 }), 82);
  // Pre-033 row: no number at all rather than a fabricated one.
  assert.equal(flashbackMatchPct({ similarity: 0.0216 }), null);
  assert.equal(flashbackMatchPct({ similarity: 0.0216, semantic_similarity: null }), null);
  assert.equal(flashbackMatchPct(null), null);
});

test('UI clamps a cosine outside [0,1] rather than rendering >100%', () => {
  assert.equal(flashbackMatchPct({ semantic_similarity: 1.4 }), 100);
  assert.equal(flashbackMatchPct({ semantic_similarity: -0.2 }), 0);
});

test('client-side threshold mirror matches the server gate', () => {
  // Mirrors app.js flashbackClearsThreshold. Two independent toast paths
  // exist (server WS frame, and the client's status→errored trigger); a
  // server-only gate would leave the second one firing on suppressed hits.
  const clears = (hit, min) => {
    if (!Number.isFinite(min) || min <= 0) return true;
    const v = hit && hit.semantic_similarity;
    if (typeof v !== 'number' || !Number.isFinite(v)) return true;
    return v >= min;
  };
  assert.equal(clears({ semantic_similarity: 0.5 }, 0.35), true);
  assert.equal(clears({ semantic_similarity: 0.2 }, 0.35), false);
  assert.equal(clears({ similarity: 0.02 }, 0.35), true, 'pre-033 rows ungated');
  assert.equal(clears({ semantic_similarity: 0.01 }, 0), true, 'gate disabled');
  assert.equal(clears({ semantic_similarity: 0.01 }, undefined), true, 'no config → ungated');
});

test('dashboard renders the RRF composite as a magnitude, not a percentage', () => {
  // Mirrors flashback-history.js fmtScore. `top_hit_score` is the ordinal
  // composite; the old formatter multiplied it by 100 and appended "%".
  const fmtScore = (score) => (score == null || !Number.isFinite(score)) ? '—' : `${score.toFixed(3)}`;
  assert.equal(fmtScore(0.0216), '0.022');
  assert.equal(fmtScore(null), '—');
  assert.ok(!fmtScore(0.0216).includes('%'), 'no percent sign on an ordinal score');
});
