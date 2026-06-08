'use strict';

// Transport: spawn a REAL, independent headful Chrome on a dedicated profile + localhost debug
// port, then attach Playwright via connectOverCDP (ORCH ruling, Sprint 72). Because Chrome is its
// own process (launched with only our flags — no Playwright-managed --enable-automation infobar),
// the human genuinely co-owns the window and we just attach over CDP. Page-level work goes through
// the Playwright Page; screencast + Input.dispatch* go through a CDPSession off page.context().

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  throw new Error(
    "web-chat-driver needs 'playwright-core'. Run `npm install` inside packages/web-chat-driver " +
      '(local install only — never the repo root, to avoid lockfile churn with the parallel deck).'
  );
}

// Candidate paths for the *real* Google Chrome binary (never bundled Chromium — posture).
const CHROME_CANDIDATES = [
  process.env.TERMDECK_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

function resolveChromePath() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      /* keep scanning */
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
  });
}

// Is a Chrome DevTools endpoint already listening on this localhost port?
async function probe(port) {
  try {
    await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1000);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForDebugger(port, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Chrome remote-debugging port ${port} did not come up within ${timeoutMs}ms`);
}

// Posture guard (T4 audit 2026-06-08): the driver is HARD-LOCKED to headful + localhost-only debug
// + dedicated profile + no stealth — not merely defaulted. Callers may pass extra Chrome flags, but
// never ones that would breach those guarantees. Default-safe is not enough; the contract is
// posture-hard so a future caller (or a copy-paste) cannot silently downgrade it.
const FORBIDDEN_ARG_PATTERNS = [
  /^--headless\b/i, // never headless
  /^--remote-debugging-address\b/i, // localhost-only bind — we never widen it
  /^--remote-allow-origins\b/i, // no origin loosening
  /^--remote-debugging-port\b/i, // the debug port is owned by the driver
  /^--user-data-dir\b/i, // the dedicated profile is owned by the driver
  /^--profile-directory\b/i, // ditto
  /^--disable-blink-features\b/i, // common stealth vector
  /AutomationControlled/i, // stealth tell
];

function assertArgsAllowed(extraArgs) {
  for (const a of extraArgs || []) {
    const s = String(a);
    for (const re of FORBIDDEN_ARG_PATTERNS) {
      if (re.test(s)) {
        throw new Error(
          `web-chat-driver posture: forbidden Chrome flag "${s}" — the driver is hard-locked to ` +
            'headful, localhost-only debug, dedicated profile, and no stealth.'
        );
      }
    }
  }
}

// Spawn a real, headful Chrome bound to a dedicated profile + localhost debug port.
// NOTE: we never pass --remote-debugging-address, so Chrome binds the DevTools endpoint to
// 127.0.0.1 and rejects non-localhost connections (posture: localhost-only). connectOverCDP from a
// Node client sends no Origin header, so no --remote-allow-origins loosening is required.
function launchChrome({
  chromePath,
  userDataDir,
  port,
  headful = true,
  startUrl = 'about:blank',
  detached = false,
  extraArgs = [],
}) {
  // Hard posture gates — reject headless and any posture-breaching caller flag BEFORE spawning.
  if (headful === false) {
    throw new Error(
      'web-chat-driver posture: headless is not permitted — the driver only runs headful real ' +
        'Chrome. For a display-less CI box, skip browser tests with WEB_CHAT_DRIVER_NO_BROWSER=1.'
    );
  }
  assertArgsAllowed(extraArgs);

  const bin = chromePath || resolveChromePath();
  if (!bin) {
    throw new Error('Could not locate Google Chrome. Set TERMDECK_CHROME_PATH to the real binary.');
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    // Keep the renderer + screencast alive while the Chrome window is NOT focused — the human looks
    // at the TermDeck canvas, so the source window is usually backgrounded. Without these, Chrome
    // throttles the renderer and screencast frames stop flowing.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  // No headless branch exists — the driver never emits --headless (gated above). Caller extras are
  // already posture-validated by assertArgsAllowed.
  for (const a of extraArgs) args.push(a);
  args.push(startUrl);

  const proc = spawn(bin, args, { stdio: 'ignore', detached });
  if (detached) proc.unref();
  return proc;
}

module.exports = {
  chromium,
  resolveChromePath,
  httpGetJson,
  probe,
  waitForDebugger,
  launchChrome,
  sleep,
};
