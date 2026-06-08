'use strict';

// attach({ userDataDir, port, mode }) → handle
//
// Bring up a real, headful Chrome and attach to it, returning a session `handle` that exposes:
//   handle.page  — the Playwright Page (T3: page.locator / composer.fill() / aria snapshots)
//   handle.cdp   — a CDPSession via page.context().newCDPSession(page) (screencast + Input.*)
// plus convenience methods (screencast / sendInput / insertText / navigate / evaluate / close).
//
// mode:
//   'auto'    (default) — connectOverCDP if a Chrome is already on `port`, else spawn one then attach.
//   'connect'           — require an already-running Chrome (throws if none). Co-drive the human's
//                         own Chrome; close() only disconnects Playwright, never kills their browser.
//   'launch'            — always spawn our own real headful Chrome, then connectOverCDP to it.

const {
  chromium,
  launchChrome,
  waitForDebugger,
  probe,
} = require('./transport');
const { resolveProfileDir, DEFAULT_PORT } = require('./profile');
const screencastMod = require('./screencast');
const inputMod = require('./input');

async function attach(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const mode = opts.mode || 'auto';
  const userDataDir = resolveProfileDir(opts.userDataDir || opts.profile || 'default');

  let handleMode;
  let proc = null;

  const wantConnect = mode === 'connect' || mode === 'auto';
  const alreadyUp = wantConnect ? await probe(port) : false;

  if (wantConnect && alreadyUp) {
    handleMode = 'connect';
  } else if (mode === 'connect') {
    throw new Error(`attach mode:'connect' but no CDP endpoint at http://127.0.0.1:${port}`);
  } else {
    handleMode = 'launch';
    proc = launchChrome({
      chromePath: opts.chromePath,
      userDataDir,
      port,
      headful: opts.headful !== false, // headful only; launchChrome throws on an explicit headful:false
      startUrl: opts.startUrl || 'about:blank',
      detached: !!opts.detached,
      extraArgs: opts.args || [],
    });
    await waitForDebugger(port, { timeoutMs: opts.launchTimeoutMs || 15000 });
  }

  // Attach Playwright to the REAL Chrome over CDP (ORCH ruling). connectOverCDP fetches
  // /json/version on the localhost port to find the browser websocket — the Chrome process is
  // independent, so the human keeps co-ownership of the window.
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = firstUsablePage(context) || (await context.newPage());

  if (opts.startUrl && handleMode === 'connect') {
    // launch already opened startUrl; only navigate in connect mode if asked
    try {
      await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs || 30000 });
    } catch (_) {
      /* best-effort */
    }
  }

  // CDPSession for the render bridge + input — screencast/Input.* that Playwright doesn't wrap.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable').catch(() => {}); // needed for Page.screencastFrame on this session

  const handle = {
    mode: handleMode,
    port,
    userDataDir,
    page, // ← Playwright Page (T3 contract)
    context,
    browser,
    proc,
    cdp, // ← CDPSession (screencast + input)

    // Drive the controlled tab.
    async navigate(url, { waitUntil = 'load', timeoutMs = 30000 } = {}) {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      return handle;
    },

    // Read page state over CDP Runtime.evaluate (string expression, by-value result).
    async evaluate(expression, { returnByValue = true, awaitPromise = false } = {}) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue, awaitPromise });
      if (r && r.exceptionDetails) {
        throw new Error('evaluate: ' + (r.exceptionDetails.text || 'page exception'));
      }
      return r && r.result ? r.result.value : undefined;
    },

    // Render bridge + input — handle-method form (preferred, multi-panel safe).
    screencast(onFrame, scOpts) {
      return screencastMod.screencast(handle, onFrame, scOpts);
    },
    sendInput(evt) {
      return inputMod.sendInput(handle, evt);
    },
    insertText(text) {
      return inputMod.insertText(handle, text);
    },

    async close() {
      try {
        await cdp.detach();
      } catch (_) {
        /* ignore */
      }
      try {
        await browser.close(); // connectOverCDP: disconnects Playwright; does NOT kill the Chrome
      } catch (_) {
        /* ignore */
      }
      if (handleMode === 'launch' && proc) {
        // We spawned this Chrome, so we own its lifecycle. Await actual exit (SIGTERM, then a
        // SIGKILL backstop) so the caller can safely clean up the profile dir afterward — Chrome
        // holds locks on --user-data-dir until the process is fully gone.
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          proc.once('exit', finish);
          try {
            proc.kill('SIGTERM');
          } catch (_) {
            finish();
          }
          const t = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch (_) {
              /* ignore */
            }
            finish();
          }, 1500);
          if (typeof t.unref === 'function') t.unref();
        });
      }
      // 'connect' mode: never kill the human's Chrome — disconnecting is enough.
    },
  };

  return handle;
}

// Prefer a real (non-blank) tab — in connect mode this finds the human's grok.com tab.
function firstUsablePage(context) {
  const pages = context.pages();
  const real = pages.find((p) => {
    try {
      const u = p.url();
      return u && u !== 'about:blank' && !u.startsWith('chrome://');
    } catch (_) {
      return false;
    }
  });
  return real || pages[0] || null;
}

module.exports = { attach };
