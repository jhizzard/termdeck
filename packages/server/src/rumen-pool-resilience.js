// Sprint 45 side-task — DNS-resilience policy for the rumen pg.Pool.
//
// Two factories, both DI-friendly so tests can stub dns + console:
//
//   createCachedLookup(dnsModule, opts)
//     Returns a (hostname, options, callback) function suitable for
//     pg.Pool's `lookup` config. Caches successful lookups for
//     `cacheTtlMs` (default 30s). On lookup failure, retries with
//     jittered exponential backoff up to `backoffCapsMs.length`
//     attempts (default [100, 500, 2000, 5000]). If every retry fails
//     and a stale cached address exists, serves stale rather than
//     failing — DNS flickers shouldn't tear the pool down.
//
//   createFailureLogger(consoleModule, opts)
//     Returns { logFailure, logRecovery } closures owning a private
//     failure-window state. First failure logs `warn`; consecutive
//     failures within `windowMs` (default 60s) downgrade to `debug`;
//     a recovery after any prior failure logs `info` once and clears
//     the window. Idempotent recovery (no failures pending) is silent.
//
// Both factories are pure — no module-scope state, no side effects on
// require — so tests can construct fresh instances per case.

'use strict';

const DEFAULT_BACKOFF_CAPS_MS = [100, 500, 2000, 5000];
const DEFAULT_DNS_CACHE_TTL_MS = 30_000;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;

function _jitter(capMs, rng) {
  return Math.floor(capMs * (0.5 + rng() * 0.5));
}

function createCachedLookup(dnsModule, opts = {}) {
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_DNS_CACHE_TTL_MS;
  const backoffCapsMs = opts.backoffCapsMs ?? DEFAULT_BACKOFF_CAPS_MS;
  const setTimeoutFn = opts.setTimeout ?? setTimeout;
  const now = opts.now ?? Date.now;
  const rng = opts.random ?? Math.random;
  const cache = new Map();

  return function cachedLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const t = now();
    const hit = cache.get(hostname);
    if (hit && hit.expiresAt > t) {
      return callback(null, hit.address, hit.family);
    }
    let attempt = 0;
    const tryOnce = () => {
      dnsModule.lookup(hostname, options, (err, address, family) => {
        if (!err) {
          cache.set(hostname, { address, family, expiresAt: now() + cacheTtlMs });
          return callback(null, address, family);
        }
        if (attempt >= backoffCapsMs.length) {
          if (hit) return callback(null, hit.address, hit.family);
          return callback(err);
        }
        const delay = _jitter(backoffCapsMs[attempt++], rng);
        setTimeoutFn(tryOnce, delay);
      });
    };
    tryOnce();
  };
}

function createFailureLogger(consoleModule, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_FAILURE_WINDOW_MS;
  const prefix = opts.prefix ?? '[rumen]';
  const now = opts.now ?? Date.now;
  let firstAt = 0;
  let lastAt = 0;
  let count = 0;

  function logFailure(message) {
    const t = now();
    if (firstAt > 0 && (t - lastAt) < windowMs) {
      count += 1;
      lastAt = t;
      const debug = consoleModule.debug || consoleModule.log;
      debug(`${prefix} (debounced ${count}) ${message}`);
      return;
    }
    firstAt = t;
    lastAt = t;
    count = 1;
    consoleModule.warn(`${prefix} ${message}`);
  }

  function logRecovery(message) {
    if (firstAt === 0) return;
    const info = consoleModule.info || consoleModule.log;
    info(`${prefix} recovered after ${count} failure(s)${message ? ` — ${message}` : ''}`);
    firstAt = 0;
    lastAt = 0;
    count = 0;
  }

  function _state() { return { firstAt, lastAt, count }; }

  return { logFailure, logRecovery, _state };
}

module.exports = {
  createCachedLookup,
  createFailureLogger,
  DEFAULT_BACKOFF_CAPS_MS,
  DEFAULT_DNS_CACHE_TTL_MS,
  DEFAULT_FAILURE_WINDOW_MS,
};
