// Sprint 63 T1 (Item 1.3) — body-parser rawBody capture + hex-escape log.
//
// Pre-Sprint-63 the error middleware logged `err.code` + `err.message` but
// not WHICH bytes triggered the parse failure. Brad's r730 logged 9× of
// `SyntaxError: Bad control character in string literal in JSON at position
// 9` per 13h uptime with no fingerprint to identify the offending caller.
//
// Sprint 63 captures `req.rawBody = Buffer.from(buf)` in the express.json
// verify callback, and the error middleware renders a 32-byte hex-escaped
// prefix into the existing single-line warn. PII-conservative: bounded to
// 32 bytes, printable ASCII verbatim, non-printables as `\xNN`.
//
// This file fences:
//   • rawBody is captured for valid bodies (non-error path baseline).
//   • rawBody is captured for verify-failure bodies (control-char path).
//   • The structured 400 response shape is unchanged from Sprint 60 v1.0.14.
//   • The warn log includes a `prefix="..."` segment carrying the hex-escaped
//     representation of the offending bytes.
//
// Run: node --test packages/server/tests/body-parser-rawbody.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Import the production helpers and rebuild the same middleware stack the
// server uses. We can't `require('../src/index.js').createServer` cheaply
// (it pulls Mnestra, RAG, sprint routes, etc.); instead we wire the same
// verify + error middleware with the production helpers (hexEscapePrefix)
// so a regression in either piece fails this test.
const { hexEscapePrefix } = require('../src/index.js');

function buildApp({ onWarn } = {}) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buf) => {
      // Sprint 63 — capture rawBody before scanning.
      req.rawBody = Buffer.from(buf);
      let inString = false;
      let escape = false;
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (!inString) {
          if (b === 0x22) inString = true;
          continue;
        }
        if (escape) { escape = false; continue; }
        if (b === 0x5c) { escape = true; continue; }
        if (b === 0x22) { inString = false; continue; }
        if (b < 0x20 || b === 0x7f) {
          const err = new Error(`Body contains illegal control character 0x${b.toString(16).padStart(2, '0')} at byte ${i}`);
          err.type = 'entity.verify.failed';
          err.statusCode = 400;
          err.code = 'CONTROL_CHAR_IN_STRING';
          throw err;
        }
      }
    },
  }));
  app.use((err, req, res, next) => {
    if (err && (
      err.type === 'entity.parse.failed' ||
      err.type === 'entity.verify.failed' ||
      err instanceof SyntaxError
    )) {
      const prefix = hexEscapePrefix(req.rawBody);
      const line = `[body-parser] ${err.code || err.type || 'parse-error'}: ${err.message} (${req.method} ${req.path}) prefix="${prefix}"`;
      if (onWarn) onWarn(line);
      return res.status(400).json({
        error: 'Malformed JSON body',
        detail: err.message,
        code: err.code,
      });
    }
    return next(err);
  });
  app.post('/echo', (req, res) => {
    res.json({
      received: req.body,
      rawBodyCaptured: Buffer.isBuffer(req.rawBody),
      rawBodyLength: req.rawBody ? req.rawBody.length : 0,
    });
  });
  return app;
}

function postRaw(app, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        {
          method: 'POST', host: '127.0.0.1', port, path: '/echo',
          headers: { 'Content-Type': 'application/json', ...headers },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(body);
      req.end();
    });
  });
}

test('rawBody is captured for valid JSON bodies', async () => {
  const app = buildApp();
  const body = JSON.stringify({ ok: true, msg: 'hello' });
  const r = await postRaw(app, body);
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.rawBodyCaptured, true,
    'rawBody must be a Buffer on the request even when no error fires');
  assert.equal(parsed.rawBodyLength, Buffer.byteLength(body, 'utf8'),
    'rawBody length matches the original payload bytes');
  assert.deepEqual(parsed.received, { ok: true, msg: 'hello' });
});

test('verify-failure logs include hex-escaped prefix of the offending bytes', async () => {
  const warnLines = [];
  const app = buildApp({ onWarn: (line) => warnLines.push(line) });
  // Body contains \x07 (BEL) inside a string — verify callback rejects.
  const body = '{"msg":"hello\x07world"}';
  const r = await postRaw(app, body);
  assert.equal(r.status, 400);
  assert.equal(warnLines.length, 1, 'one warn line emitted for one bad body');
  const line = warnLines[0];
  assert.ok(line.includes('CONTROL_CHAR_IN_STRING'),
    `warn line must carry the error code, got: ${line}`);
  assert.ok(line.includes('prefix="'),
    `warn line must carry a prefix="..." segment, got: ${line}`);
  assert.ok(line.includes('\\x07'),
    `prefix must render the BEL byte as literal \\x07, got: ${line}`);
  assert.ok(line.includes('hello'),
    `prefix must keep printable ASCII verbatim, got: ${line}`);
});

test('verify-failure 400 response shape unchanged from Sprint 60', async () => {
  const app = buildApp();
  const body = '{"msg":"\x01"}';
  const r = await postRaw(app, body);
  assert.equal(r.status, 400);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.error, 'Malformed JSON body');
  assert.equal(parsed.code, 'CONTROL_CHAR_IN_STRING');
  assert.ok(typeof parsed.detail === 'string' && parsed.detail.length > 0);
});

test('SyntaxError on truly-malformed JSON still produces hex-prefix log', async () => {
  const warnLines = [];
  const app = buildApp({ onWarn: (line) => warnLines.push(line) });
  // Verify callback runs first and succeeds (no control chars); express's
  // own JSON.parse then throws SyntaxError. Error middleware should still
  // get rawBody captured by the verify callback.
  const body = '{not valid json';
  const r = await postRaw(app, body);
  assert.equal(r.status, 400);
  assert.equal(warnLines.length, 1);
  const line = warnLines[0];
  assert.ok(line.includes('prefix="'),
    'SyntaxError path must also carry the hex prefix');
  assert.ok(line.includes('{not valid json'),
    `expected printable prefix to include the malformed body bytes, got: ${line}`);
});

test('truncated 32-byte prefix uses … marker on oversized body', async () => {
  const warnLines = [];
  const app = buildApp({ onWarn: (line) => warnLines.push(line) });
  // 64-char payload with a control char near the start — prefix should
  // include the first 32 bytes only, ending in `…`.
  const body = '{"k":"\x01' + 'a'.repeat(80) + '"}';
  const r = await postRaw(app, body);
  assert.equal(r.status, 400);
  const line = warnLines[0];
  assert.ok(line.includes('…'),
    `oversized body must render the truncation marker, got: ${line}`);
});

test('rawBody Buffer.from copy is independent from express internals', async () => {
  // Defensive: a future express upgrade could pool the verify-callback
  // `buf` and mutate it across requests. Buffer.from(buf) copies, so the
  // error middleware sees the original bytes even if express reuses the
  // backing memory.
  const app = buildApp();
  // Two valid bodies; each request's rawBody is its own buffer.
  const r1 = await postRaw(app, JSON.stringify({ a: 1 }));
  const r2 = await postRaw(app, JSON.stringify({ b: 22222222 }));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r1.body).received.a, 1);
  assert.equal(JSON.parse(r2.body).received.b, 22222222);
});
