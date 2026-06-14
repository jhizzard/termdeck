'use strict';

// In-app recall path (config mnestraMode:'webhook') must present the webhook
// shared secret too, so a daily-driver that opts into webhook mode keeps
// working once the :37778 webhook is fail-closed (mnestra ≥ 0.7.0). Default
// mode is 'direct' (Supabase REST, bypasses :37778) — this only covers the
// webhook branch. Mirrors the connector-side coverage in
// packages/mcp-bridge/test/clients.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createBridge } = require('../src/mnestra-bridge');

function makeBridge() {
  return createBridge({
    rag: { mnestraMode: 'webhook', mnestraWebhookUrl: 'http://127.0.0.1:37778/mnestra' },
  });
}

// Drive queryMnestra with a stubbed global.fetch and return the recorded init.
async function captureFetch(envSecret, fn) {
  const priorFetch = global.fetch;
  const priorSecret = process.env.MNESTRA_WEBHOOK_SECRET;
  if (envSecret === undefined) delete process.env.MNESTRA_WEBHOOK_SECRET;
  else process.env.MNESTRA_WEBHOOK_SECRET = envSecret;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ memories: [] }), text: async () => '{"memories":[]}' };
  };
  try { await fn(); }
  finally {
    global.fetch = priorFetch;
    if (priorSecret === undefined) delete process.env.MNESTRA_WEBHOOK_SECRET;
    else process.env.MNESTRA_WEBHOOK_SECRET = priorSecret;
  }
  return calls;
}

function headerOf(init, name) {
  const h = (init && init.headers) || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) return h[k];
  return undefined;
}

test('in-app webhook mode attaches x-mnestra-secret when MNESTRA_WEBHOOK_SECRET is set', async () => {
  const bridge = makeBridge();
  const calls = await captureFetch('inapp-sek', () =>
    bridge.queryMnestra({ question: 'hi', project: 'termdeck' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(headerOf(calls[0].init, 'x-mnestra-secret'), 'inapp-sek');
  // secret stays out of the body
  assert.ok(!String(calls[0].init.body || '').includes('inapp-sek'));
});

test('in-app webhook mode sends NO secret header when unset (backward-compat)', async () => {
  const bridge = makeBridge();
  const calls = await captureFetch(undefined, () =>
    bridge.queryMnestra({ question: 'hi', project: 'termdeck' }));
  assert.equal(calls.length, 1);
  assert.equal(headerOf(calls[0].init, 'x-mnestra-secret'), undefined);
  assert.equal(headerOf(calls[0].init, 'Content-Type'), 'application/json');
});
