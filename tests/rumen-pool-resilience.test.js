// Sprint 45 side-task — hermetic tests for the rumen pool DNS-resilience
// helpers in packages/server/src/rumen-pool-resilience.js.
//
// Coverage map:
//   1. cachedLookup: cache miss → calls dns.lookup, stores result, returns address
//   2. cachedLookup: cache hit within TTL → no dns.lookup call, serves cached
//   3. cachedLookup: TTL expiry → re-queries dns.lookup
//   4. cachedLookup: failure with no cache → retries up to 4× with jittered backoff,
//      then surfaces the error
//   5. cachedLookup: failure WITH stale cache → serves stale rather than failing
//   6. failureLogger: first failure → console.warn; consecutive within 60s window
//      → console.debug; recovery → console.info-once; idempotent recovery silent
//   7. failureLogger: recovery clears the window so the NEXT failure logs warn again

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HELPERS = path.resolve(
  __dirname, '..', 'packages', 'server', 'src', 'rumen-pool-resilience.js'
);

function loadHelpers() {
  delete require.cache[HELPERS];
  return require(HELPERS);
}

function makeFakeDns(plan) {
  // plan: array of 'ok' | 'fail' (one entry per expected lookup attempt)
  let calls = 0;
  return {
    calls: () => calls,
    lookup(hostname, options, callback) {
      const verdict = plan[calls++] ?? 'ok';
      // Mimic Node's lookup signature variants
      if (typeof options === 'function') { callback = options; options = {}; }
      // Always invoke async to keep semantics realistic
      setImmediate(() => {
        if (verdict === 'fail') {
          const err = new Error('ENOTFOUND ' + hostname);
          err.code = 'ENOTFOUND';
          callback(err);
        } else {
          callback(null, '203.0.113.1', 4);
        }
      });
    },
  };
}

function makeFakeConsole() {
  const calls = { warn: [], info: [], debug: [], log: [] };
  return {
    calls,
    warn: (...args) => calls.warn.push(args.join(' ')),
    info: (...args) => calls.info.push(args.join(' ')),
    debug: (...args) => calls.debug.push(args.join(' ')),
    log: (...args) => calls.log.push(args.join(' ')),
  };
}

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

// Inline setTimeout that runs immediately (zero delay for hermetic speed).
const fastSetTimeout = (fn) => { setImmediate(fn); return 0; };

test('cachedLookup: cache miss → calls dns.lookup once and returns address', async () => {
  const { createCachedLookup } = loadHelpers();
  const fdns = makeFakeDns(['ok']);
  const lookup = createCachedLookup(fdns, { setTimeout: fastSetTimeout });
  const addr = await new Promise((resolve, reject) => {
    lookup('db.example.com', {}, (err, address, family) => {
      if (err) reject(err); else resolve({ address, family });
    });
  });
  assert.equal(fdns.calls(), 1);
  assert.equal(addr.address, '203.0.113.1');
  assert.equal(addr.family, 4);
});

test('cachedLookup: cache hit within TTL → no dns.lookup call', async () => {
  const { createCachedLookup } = loadHelpers();
  const fdns = makeFakeDns(['ok']);
  const clock = makeClock();
  const lookup = createCachedLookup(fdns, { setTimeout: fastSetTimeout, now: clock.now, cacheTtlMs: 30_000 });
  await new Promise((r) => lookup('db.example.com', {}, () => r()));
  clock.advance(15_000); // mid-TTL
  await new Promise((r) => lookup('db.example.com', {}, () => r()));
  assert.equal(fdns.calls(), 1, 'second call should hit cache');
});

test('cachedLookup: TTL expiry → re-queries dns.lookup', async () => {
  const { createCachedLookup } = loadHelpers();
  const fdns = makeFakeDns(['ok', 'ok']);
  const clock = makeClock();
  const lookup = createCachedLookup(fdns, { setTimeout: fastSetTimeout, now: clock.now, cacheTtlMs: 30_000 });
  await new Promise((r) => lookup('db.example.com', {}, () => r()));
  clock.advance(31_000); // past TTL
  await new Promise((r) => lookup('db.example.com', {}, () => r()));
  assert.equal(fdns.calls(), 2);
});

test('cachedLookup: failure with no cache → retries 4× then surfaces error', async () => {
  const { createCachedLookup } = loadHelpers();
  const fdns = makeFakeDns(['fail', 'fail', 'fail', 'fail', 'fail']); // initial + 4 retries
  const lookup = createCachedLookup(fdns, { setTimeout: fastSetTimeout, random: () => 0 });
  const err = await new Promise((resolve) => {
    lookup('db.example.com', {}, (e) => resolve(e));
  });
  assert.ok(err, 'expected error after exhausted retries');
  assert.equal(err.code, 'ENOTFOUND');
  assert.equal(fdns.calls(), 5, 'one initial + four backoff retries');
});

test('cachedLookup: failure WITH stale cache → serves stale, no error', async () => {
  const { createCachedLookup } = loadHelpers();
  const fdns = makeFakeDns(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
  const clock = makeClock();
  const lookup = createCachedLookup(fdns, {
    setTimeout: fastSetTimeout, random: () => 0, now: clock.now, cacheTtlMs: 1_000,
  });
  // Prime the cache.
  const first = await new Promise((r) => lookup('db.example.com', {}, (_e, a) => r(a)));
  assert.equal(first, '203.0.113.1');
  // Expire the cache, then fail every retry — should serve stale.
  clock.advance(2_000);
  const second = await new Promise((resolve) => {
    lookup('db.example.com', {}, (err, address) => resolve({ err, address }));
  });
  assert.ok(!second.err, 'no error — served stale');
  assert.equal(second.address, '203.0.113.1');
});

test('failureLogger: first warn → consecutive debug → recovery info → window resets', () => {
  const { createFailureLogger } = loadHelpers();
  const fc = makeFakeConsole();
  const clock = makeClock();
  const { logFailure, logRecovery } = createFailureLogger(fc, { now: clock.now, windowMs: 60_000 });

  // First failure → warn
  logFailure('lookup A failed');
  assert.equal(fc.calls.warn.length, 1);
  assert.match(fc.calls.warn[0], /lookup A failed/);

  // 5s later, second failure within window → debug
  clock.advance(5_000);
  logFailure('lookup B failed');
  assert.equal(fc.calls.warn.length, 1, 'still one warn');
  assert.equal(fc.calls.debug.length, 1, 'second is debounced');

  // 30s later, still in window → debug
  clock.advance(30_000);
  logFailure('lookup C failed');
  assert.equal(fc.calls.debug.length, 2);

  // Recovery → info, exactly once
  logRecovery();
  assert.equal(fc.calls.info.length, 1);
  assert.match(fc.calls.info[0], /recovered after 3 failure\(s\)/);

  // Idempotent recovery → silent
  logRecovery();
  assert.equal(fc.calls.info.length, 1);

  // Next failure (post-recovery) → warn again, not debug
  clock.advance(1_000);
  logFailure('lookup D failed');
  assert.equal(fc.calls.warn.length, 2, 'window reset → warn again');
});

test('failureLogger: failures spaced beyond window each warn fresh', () => {
  const { createFailureLogger } = loadHelpers();
  const fc = makeFakeConsole();
  const clock = makeClock();
  const { logFailure } = createFailureLogger(fc, { now: clock.now, windowMs: 60_000 });

  logFailure('first');
  clock.advance(120_000); // past the window
  logFailure('second');
  assert.equal(fc.calls.warn.length, 2);
  assert.equal(fc.calls.debug.length, 0);
});
