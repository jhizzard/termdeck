'use strict';

// CDP / render-bridge round-trip, proven against a LOCAL fixture (test/fixtures/echo.html) — no
// external site. Launches a real headful Chrome on a dedicated throwaway profile, then asserts:
//   1. screencast streams >=2 distinct frames in the documented frame-channel shape;
//   2. programmatic insertText lands in the focused composer;
//   3. a forwarded human mouse click hit-tests onto the input;
//   4. forwarded human key events type characters into the input.
//
// Posture: headful real Chrome, dedicated profile, localhost-only debug port. Browser launch was
// approved by Joshua for Sprint 72. This package is NOT in the root test glob, so it only runs via
// `cd packages/web-chat-driver && npm test` — it never pops a window during the repo's `npm test`.
//
// On a display-less box set WEB_CHAT_DRIVER_NO_BROWSER=1 to skip (so we never mask a real failure
// behind an auto-skip).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cdp } = require('../src');

const SKIP = process.env.WEB_CHAT_DRIVER_NO_BROWSER === '1';
const FIXTURE = 'file://' + path.join(__dirname, 'fixtures', 'echo.html');
const PORT = 9000 + (process.pid % 1500); // avoid colliding with a real Chrome on the default port
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'web-chat-driver-test-'));

let handle;

before(
  async () => {
    if (SKIP) return;
    handle = await cdp.attach({ mode: 'launch', port: PORT, userDataDir: PROFILE });
    await handle.navigate(FIXTURE);
    await waitFor(async () => (await handle.evaluate("!!document.getElementById('in')")) === true, 8000);
  },
  { timeout: 45000 }
);

after(async () => {
  try {
    if (handle) await handle.close();
  } catch (_) {
    /* ignore */
  }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

test('handle exposes a Playwright Page + CDPSession (T3 + render-bridge contract)', { timeout: 10000, skip: SKIP }, async () => {
  assert.ok(handle.page, 'handle.page present');
  assert.equal(typeof handle.page.locator, 'function', 'handle.page is a Playwright Page (locator)');
  assert.equal(typeof handle.page.goto, 'function', 'handle.page is a Playwright Page (goto)');
  assert.ok(handle.cdp, 'handle.cdp present');
  assert.equal(typeof handle.cdp.send, 'function', 'handle.cdp is a CDPSession (send)');
  assert.equal(typeof handle.sendInput, 'function', 'handle.sendInput present');
  assert.equal(typeof handle.insertText, 'function', 'handle.insertText present');
});

test('screencast streams >=2 distinct frames in the documented shape', { timeout: 20000, skip: SKIP }, async () => {
  const frames = [];
  const sc = handle.screencast((f) => frames.push(f), { quality: 50, maxWidth: 800, maxHeight: 600 });
  await sc.started;
  await waitFor(() => frames.length >= 2 && new Set(frames.map((f) => f.data)).size >= 2, 10000);
  await sc.stop();

  assert.ok(frames.length >= 2, `expected >=2 frames, got ${frames.length}`);
  assert.ok(new Set(frames.map((f) => f.data)).size >= 2, 'expected >=2 distinct frame payloads (live capture)');
  const f0 = frames[0];
  assert.match(f0.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(f0.format, 'jpeg');
  assert.ok(typeof f0.data === 'string' && f0.data.length > 0, 'frame.data is non-empty base64');
  assert.ok(f0.deviceWidth > 0 && f0.deviceHeight > 0, 'frame carries device dimensions');
  assert.equal(typeof f0.frame, 'number', 'frame number present (acked sessionId)');
});

test('programmatic insertText lands in the focused composer', { timeout: 15000, skip: SKIP }, async () => {
  await handle.evaluate("(function(){var i=document.getElementById('in');i.focus();i.value='';i.dispatchEvent(new Event('input'));})()");
  await handle.insertText('hello fixture');
  await waitFor(
    async () => (await handle.evaluate("document.getElementById('out').getAttribute('data-echo')")) === 'hello fixture',
    5000
  );
  const echoed = await handle.evaluate("document.getElementById('out').getAttribute('data-echo')");
  assert.equal(echoed, 'hello fixture');
});

test('human mouse event forwards — click hit-tests onto the input', { timeout: 15000, skip: SKIP }, async () => {
  const box = await handle.evaluate(
    "(function(){var r=document.getElementById('in').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
  );
  const before = Number(await handle.evaluate("document.getElementById('clicks').getAttribute('data-count')"));
  await handle.sendInput({ type: 'mouseMoved', x: box.x, y: box.y });
  await handle.sendInput({ type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await handle.sendInput({ type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await waitFor(
    async () => Number(await handle.evaluate("document.getElementById('clicks').getAttribute('data-count')")) > before,
    5000
  );
  const after = Number(await handle.evaluate("document.getElementById('clicks').getAttribute('data-count')"));
  assert.ok(after > before, `mouse click did not land (before=${before}, after=${after})`);
});

test('human key events forward — typed characters land in the input', { timeout: 15000, skip: SKIP }, async () => {
  await handle.evaluate("(function(){var i=document.getElementById('in');i.focus();i.value='';i.dispatchEvent(new Event('input'));})()");
  await cdp.typeKey(handle, { key: 'h', code: 'KeyH', text: 'h', keyCode: 72 });
  await cdp.typeKey(handle, { key: 'i', code: 'KeyI', text: 'i', keyCode: 73 });
  await waitFor(async () => (await handle.evaluate("document.getElementById('in').value")) === 'hi', 5000);
  const val = await handle.evaluate("document.getElementById('in').value");
  assert.equal(val, 'hi');
});

// Posture is hard-locked in the driver, not just defaulted (T4 audit 2026-06-08). These reject
// BEFORE any Chrome spawn, so they run even on a display-less box (not gated by SKIP).
test('posture: driver rejects headless + posture-breaching flags (no browser launched)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-chat-driver-posture-'));
  try {
    await assert.rejects(() => cdp.attach({ mode: 'launch', port: 9099, userDataDir: tmp, headful: false }), /headless is not permitted|posture/i);
    for (const bad of [
      '--headless=new',
      '--remote-debugging-address=0.0.0.0',
      '--remote-allow-origins=*',
      '--user-data-dir=/tmp/evil',
      '--profile-directory=Default',
      '--disable-blink-features=AutomationControlled',
    ]) {
      await assert.rejects(
        () => cdp.attach({ mode: 'launch', port: 9099, userDataDir: tmp, args: [bad] }),
        /forbidden Chrome flag|posture/i,
        `expected attach to reject forbidden flag ${bad}`
      );
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
});

// Poll `cond` until truthy or timeout. Throws on timeout so failures stay real (no silent pass).
async function waitFor(cond, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try {
      ok = await cond();
    } catch (_) {
      ok = false;
    }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within ' + timeoutMs + 'ms');
}
