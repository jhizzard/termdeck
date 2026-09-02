// memory-pressure.test.js — Sprint 87 T2.
//
// RED PROOF. Each assertion here was run against the pre-fix tree:
//
//   • Every test in this file FAILED with
//     `Cannot find module '../src/memory-pressure'` before the module existed —
//     the guard genuinely did not exist, which is the defect.
//   • "skips optional work under pressure" — with the `if (underPressure)`
//     branch in shouldSkipOptionalWork() forced to `return false` (i.e. a guard
//     that samples and logs but never actually gates anything, the easy way to
//     ship a decorative guard), this FAILED `false !== true`.
//   • "resumes optional work when pressure clears" — with the transition
//     handling reduced to a latch that never clears, FAILED `true !== false`.
//   • "logs exactly one line per state change" — with the `next === underPressure`
//     early-return removed so every tick logs, FAILED `4 !== 2`.
//   • "fails OPEN when the host cannot be measured" — with the null checks in
//     evaluate() dropped (so `null < threshold` coerces to `0 < threshold` and
//     reads as pressure on every non-macOS host), FAILED `true !== false`.
//
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseSysctlSample,
  createMemoryPressureMonitor,
} = require('../src/memory-pressure');

const MB = 1024 * 1024;

function collectingLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(m), log: (m) => lines.push(m), error: (m) => lines.push(m) };
}

// Builds a monitor whose sampler replays a scripted queue of readings.
function scripted(samples, env = {}) {
  const queue = samples.slice();
  const logger = collectingLogger();
  const monitor = createMemoryPressureMonitor({
    env,
    logger,
    readSample: (cb) => cb(queue.length > 1 ? queue.shift() : queue[0]),
  });
  return { monitor, logger, tick: () => monitor._applySample(queue.length > 1 ? queue.shift() : queue[0]) };
}

test('parseSysctlSample reads page_free_count and swap free', () => {
  const s = parseSysctlSample('74553\ntotal = 6144.00M  used = 4412.25M  free = 1731.75M  (encrypted)\n');
  assert.equal(s.freeBytes, 74553 * 4096);
  assert.equal(s.swapFreeBytes, Math.round(1731.75 * MB));
});

test('parseSysctlSample degrades one signal rather than poisoning both', () => {
  assert.deepEqual(parseSysctlSample('74553\n'), { freeBytes: 74553 * 4096, swapFreeBytes: null });
  assert.deepEqual(parseSysctlSample(''), { freeBytes: null, swapFreeBytes: null });
  assert.deepEqual(parseSysctlSample(undefined), { freeBytes: null, swapFreeBytes: null });
});

test('parseSysctlSample handles G and K suffixes on swap free', () => {
  assert.equal(parseSysctlSample('1\ntotal = 8.00G used = 1.00G free = 2.50G').swapFreeBytes, 2.5 * 1024 * MB);
  assert.equal(parseSysctlSample('1\ntotal = 8.00G used = 1.00G free = 512.00K').swapFreeBytes, 512 * 1024);
});

test('SKIP PATH: optional work is skipped when free memory is below threshold', () => {
  const { monitor } = scripted([{ freeBytes: 100 * MB, swapFreeBytes: 4000 * MB }]);
  assert.equal(monitor.shouldSkipOptionalWork(), false, 'no reading yet → fail open');
  monitor._applySample({ freeBytes: 100 * MB, swapFreeBytes: 4000 * MB });
  assert.equal(monitor.shouldSkipOptionalWork(), true);
  assert.equal(monitor.state().underPressure, true);
});

test('SKIP PATH: swap exhaustion alone is enough to declare pressure', () => {
  const { monitor } = scripted([{ freeBytes: 8000 * MB, swapFreeBytes: 10 * MB }]);
  monitor._applySample({ freeBytes: 8000 * MB, swapFreeBytes: 10 * MB });
  assert.equal(monitor.shouldSkipOptionalWork(), true);
});

test('RESUME PATH: optional work resumes once headroom returns', () => {
  const { monitor } = scripted([{ freeBytes: 8000 * MB, swapFreeBytes: 8000 * MB }]);
  monitor._applySample({ freeBytes: 50 * MB, swapFreeBytes: 8000 * MB });
  assert.equal(monitor.shouldSkipOptionalWork(), true, 'entered pressure');
  monitor._applySample({ freeBytes: 8000 * MB, swapFreeBytes: 8000 * MB });
  assert.equal(monitor.shouldSkipOptionalWork(), false, 'must RESUME, not latch');
  assert.equal(monitor.state().underPressure, false);
});

test('logs exactly one line per STATE CHANGE, not per sample', () => {
  const { monitor, logger } = scripted([{ freeBytes: 8000 * MB, swapFreeBytes: 8000 * MB }]);
  const low = { freeBytes: 50 * MB, swapFreeBytes: 8000 * MB };
  const high = { freeBytes: 8000 * MB, swapFreeBytes: 8000 * MB };
  monitor._applySample(low);    // ENTERED  → 1 line
  monitor._applySample(low);    // still low → silent
  monitor._applySample(low);    // still low → silent
  monitor._applySample(high);   // CLEARED  → 1 line
  monitor._applySample(high);   // still ok  → silent
  assert.equal(logger.lines.length, 2, `expected 2 transition lines, got ${logger.lines.length}`);
  assert.match(logger.lines[0], /ENTERED/);
  assert.match(logger.lines[0], /PAUSED/);
  assert.match(logger.lines[1], /CLEARED/);
  assert.match(logger.lines[1], /RESUMED/);
  assert.equal(monitor.state().transitions, 2);
});

test('FAILS OPEN when the host cannot be measured (non-macOS)', () => {
  const { monitor } = scripted([{ freeBytes: null, swapFreeBytes: null }]);
  monitor._applySample({ freeBytes: null, swapFreeBytes: null });
  assert.equal(monitor.shouldSkipOptionalWork(), false, 'unmeasurable host must never be gated');
  assert.equal(monitor.state().supported, false);
});

test('TERMDECK_MEMORY_PRESSURE=0 disables the guard entirely', () => {
  const { monitor } = scripted([{ freeBytes: 1 * MB, swapFreeBytes: 1 * MB }], { TERMDECK_MEMORY_PRESSURE: '0' });
  monitor._applySample({ freeBytes: 1 * MB, swapFreeBytes: 1 * MB });
  assert.equal(monitor.shouldSkipOptionalWork(), false);
  assert.equal(monitor.state().enabled, false);
});

test('thresholds are env-tunable', () => {
  const { monitor } = scripted(
    [{ freeBytes: 500 * MB, swapFreeBytes: 8000 * MB }],
    { TERMDECK_MEMORY_PRESSURE_MIN_FREE_MB: '1024', TERMDECK_MEMORY_PRESSURE_MIN_SWAP_FREE_MB: '64' }
  );
  const st0 = monitor.state();
  assert.equal(st0.thresholdFreeBytes, 1024 * MB);
  assert.equal(st0.thresholdSwapFreeBytes, 64 * MB);
  monitor._applySample({ freeBytes: 500 * MB, swapFreeBytes: 8000 * MB });
  assert.equal(monitor.shouldSkipOptionalWork(), true, '500MB free is under the raised 1024MB bar');
});

test('state() is the shape /api/health publishes', () => {
  const { monitor } = scripted([{ freeBytes: 8000 * MB, swapFreeBytes: 8000 * MB }]);
  monitor._applySample({ freeBytes: 8000 * MB, swapFreeBytes: 4000 * MB });
  const s = monitor.state();
  for (const k of ['enabled', 'supported', 'underPressure', 'freeBytes', 'swapFreeBytes',
    'thresholdFreeBytes', 'thresholdSwapFreeBytes', 'sampledAt', 'transitions', 'optionalWorkSkipped']) {
    assert.ok(k in s, `state() must publish ${k}`);
  }
  assert.equal(s.supported, true);
  assert.match(s.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('the guard is inert inside a node --test worker (NODE_TEST_CONTEXT)', () => {
  // Regression lock. The first cut of this guard read process.env directly, and
  // because the machine really was at 291 MB free while the suite ran, the
  // periodic-capture seams suite went RED: the server booted, the guard
  // correctly declared pressure, and the capture under test was correctly
  // suppressed. Deterministic suites must not depend on host load.
  const m = createMemoryPressureMonitor({
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    logger: collectingLogger(),
    readSample: (cb) => cb({ freeBytes: 1 * MB, swapFreeBytes: 1 * MB }),
  });
  m._applySample({ freeBytes: 1 * MB, swapFreeBytes: 1 * MB });
  assert.equal(m.shouldSkipOptionalWork(), false);
  assert.equal(m.state().enabled, false);
});

test('an explicit enabled:true overrides the test-runner inertness', () => {
  const m = createMemoryPressureMonitor({
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    enabled: true,
    logger: collectingLogger(),
    readSample: (cb) => cb({ freeBytes: 1 * MB, swapFreeBytes: 1 * MB }),
  });
  m._applySample({ freeBytes: 1 * MB, swapFreeBytes: 1 * MB });
  assert.equal(m.shouldSkipOptionalWork(), true);
});

test('start()/stop() are safe to call repeatedly and never leave a live timer', () => {
  const { monitor } = scripted([{ freeBytes: 8000 * MB, swapFreeBytes: 8000 * MB }]);
  monitor.start(); monitor.start();
  monitor.stop(); monitor.stop();
  assert.equal(monitor.state().underPressure, false);
});
