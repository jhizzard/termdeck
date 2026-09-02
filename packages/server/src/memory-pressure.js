// memory-pressure.js — Sprint 87 T2.
//
// A deck of 8 panels, each spawning ~10 MCP child servers, plus Chrome, will
// take this host into swap. Measured 2026-09-02 10:16 ET: load 117, and BOTH
// TermDeck servers failed to answer GET /api/sessions/:id/buffer inside a 20 s
// curl timeout while the panels were demonstrably still working. Through all of
// that, TermDeck kept doing OPTIONAL work — the periodic transcript capture
// forks a Node process per panel that parses a transcript, embeds it and POSTs
// it — which is exactly the work you want to stop doing when the box is
// thrashing, and exactly the work that has no deadline.
//
// This module samples host memory on a slow timer and exposes one boolean the
// optional paths consult. It is deliberately NOT consulted by anything on the
// critical path: PTY reads and writes, POST /input, GET /buffer, GET /sessions
// and the WebSocket broadcast all run unconditionally, under every pressure
// state. Dropping terminal I/O to save memory would be a worse bug than the one
// being fixed.
//
// SIGNALS. `vm.page_free_count × 4096` is the honest free-pages figure on
// macOS; `os.freemem()` is not a substitute (measured on this host at the same
// instant: os.freemem 1126 MB vs page_free_count 291 MB — os.freemem counts
// pages the VM will happily evict under load, so it reads healthy right up to
// the point the machine starts swapping). Swap headroom comes from
// `vm.swapusage`. Both are read with ONE `sysctl` spawn per sample tick, off
// the request path; the result is cached, so a caller asking "are we under
// pressure?" is a property read and never a syscall.
//
// Non-macOS hosts have neither sysctl key. `readSampleSync` returns nulls
// there, the monitor reports `supported: false`, and `shouldSkipOptionalWork()`
// is permanently false — i.e. the guard fails OPEN, preserving today's
// behaviour everywhere it cannot measure.
//
// Env knobs:
//   TERMDECK_MEMORY_PRESSURE=0                  disable the guard entirely
//   NODE_TEST_CONTEXT (set by `node --test`)    guard is inert — see below
//   TERMDECK_MEMORY_PRESSURE_MIN_FREE_MB        default 300
//   TERMDECK_MEMORY_PRESSURE_MIN_SWAP_FREE_MB   default 300
//   TERMDECK_MEMORY_PRESSURE_INTERVAL_MS        default 15000

'use strict';

const { execFile } = require('child_process');

const DEFAULT_MIN_FREE_MB = 300;
const DEFAULT_MIN_SWAP_FREE_MB = 300;
const DEFAULT_INTERVAL_MS = 15_000;
const MB = 1024 * 1024;

function _num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Parse `sysctl -n vm.page_free_count vm.swapusage` output. Two lines:
//   74553
//   total = 6144.00M  used = 4412.25M  free = 1731.75M  (encrypted)
// Returns { freeBytes, swapFreeBytes } with null for anything unparseable so a
// partial read degrades one signal instead of poisoning both.
function parseSysctlSample(stdout) {
  const out = { freeBytes: null, swapFreeBytes: null };
  if (typeof stdout !== 'string') return out;
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) {
      out.freeBytes = Number(trimmed) * 4096;
      continue;
    }
    const m = /free\s*=\s*([\d.]+)([KMG])/i.exec(trimmed);
    if (m) {
      const mult = { K: 1024, M: MB, G: 1024 * MB }[m[2].toUpperCase()] || 1;
      out.swapFreeBytes = Math.round(Number(m[1]) * mult);
    }
  }
  return out;
}

// Async by construction: the sampler must never block the event loop it is
// trying to protect.
function readSample(cb) {
  execFile(
    '/usr/sbin/sysctl',
    ['-n', 'vm.page_free_count', 'vm.swapusage'],
    { timeout: 4000, encoding: 'utf8' },
    (err, stdout) => {
      if (err) return cb({ freeBytes: null, swapFreeBytes: null });
      cb(parseSysctlSample(stdout));
    }
  );
}

// `opts.readSample` is the injection seam the unit suite drives — it hands the
// monitor synthetic readings so both the skip path and the resume path can be
// proved without a thrashing host.
function createMemoryPressureMonitor(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  const sampler = opts.readSample || readSample;
  // The guard is inert inside a `node --test` worker. Found the hard way while
  // landing it: the periodic-capture suites boot a REAL server, and this
  // machine genuinely sat at 291 MB free / load 130 during the sprint that
  // produced this module — so the guard correctly declared pressure and
  // correctly suppressed the very capture the suite was asserting on. A test
  // whose verdict depends on how loaded the developer's laptop is at that
  // second is not a test. Suites that want to exercise the guard construct a
  // monitor directly and drive `_applySample` (memory-pressure.test.js), which
  // is both deterministic and a truer test of the logic than a real reading.
  const underTestRunner = !!env.NODE_TEST_CONTEXT;
  const enabled = opts.enabled !== undefined
    ? !!opts.enabled
    : (env.TERMDECK_MEMORY_PRESSURE !== '0' && !underTestRunner);

  const minFreeBytes = _num(env.TERMDECK_MEMORY_PRESSURE_MIN_FREE_MB, DEFAULT_MIN_FREE_MB) * MB;
  const minSwapFreeBytes = _num(env.TERMDECK_MEMORY_PRESSURE_MIN_SWAP_FREE_MB, DEFAULT_MIN_SWAP_FREE_MB) * MB;
  const intervalMs = _num(env.TERMDECK_MEMORY_PRESSURE_INTERVAL_MS, DEFAULT_INTERVAL_MS);

  let underPressure = false;
  let lastSample = { freeBytes: null, swapFreeBytes: null };
  let sampledAt = null;
  let transitions = 0;
  let skipped = 0;
  let timer = null;

  function evaluate(sample) {
    // Fail OPEN: a host we cannot measure is never declared under pressure.
    const freeLow = sample.freeBytes !== null && sample.freeBytes < minFreeBytes;
    const swapLow = sample.swapFreeBytes !== null && sample.swapFreeBytes < minSwapFreeBytes;
    return freeLow || swapLow;
  }

  function applySample(sample) {
    lastSample = sample;
    sampledAt = new Date().toISOString();
    const next = enabled ? evaluate(sample) : false;
    if (next === underPressure) return;
    underPressure = next;
    transitions++;
    // One line per STATE CHANGE, never per tick — a log that prints every 15 s
    // is a log nobody reads, and this one has to be greppable after the fact.
    const fmt = (b) => (b === null ? 'n/a' : `${(b / MB).toFixed(0)}MB`);
    logger.warn(
      `[memory-pressure] ${next ? 'ENTERED' : 'CLEARED'} · free=${fmt(sample.freeBytes)} ` +
      `swapFree=${fmt(sample.swapFreeBytes)} · thresholds free<${(minFreeBytes / MB).toFixed(0)}MB ` +
      `swapFree<${(minSwapFreeBytes / MB).toFixed(0)}MB · optional background work ` +
      `${next ? 'PAUSED' : 'RESUMED'} (${new Date().toISOString()})`
    );
  }

  function sampleNow() {
    try { sampler(applySample); } catch (_e) { /* fail-soft, stay open */ }
  }

  return {
    start() {
      if (!enabled || timer) return this;
      sampleNow();
      timer = setInterval(sampleNow, intervalMs);
      if (timer.unref) timer.unref();
      return this;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      return this;
    },
    // The one question the optional paths ask. A property read — no syscall,
    // no spawn, safe to call from a hot loop.
    shouldSkipOptionalWork() {
      if (!enabled) return false;
      if (underPressure) skipped++;
      return underPressure;
    },
    // Surfaced on GET /api/health so an operator (or a sprint monitor) can see
    // the guard's state without reading the server log.
    state() {
      return {
        enabled,
        supported: lastSample.freeBytes !== null || lastSample.swapFreeBytes !== null,
        underPressure,
        freeBytes: lastSample.freeBytes,
        swapFreeBytes: lastSample.swapFreeBytes,
        thresholdFreeBytes: minFreeBytes,
        thresholdSwapFreeBytes: minSwapFreeBytes,
        sampledAt,
        transitions,
        optionalWorkSkipped: skipped,
      };
    },
    // Test seam: drive a reading straight in without waiting for a tick.
    _applySample: applySample,
  };
}

module.exports = {
  DEFAULT_MIN_FREE_MB,
  DEFAULT_MIN_SWAP_FREE_MB,
  DEFAULT_INTERVAL_MS,
  parseSysctlSample,
  readSample,
  createMemoryPressureMonitor,
};
