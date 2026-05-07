// Sprint 60 v1.0.14 — Item 2: body-parser control-character hardening.
// Verifies the verify-callback pre-screen rejects bodies with unescaped
// control chars in JSON string contexts, returns a structured 400 with a
// CONTROL_CHAR_IN_STRING code, and silences the verbose SyntaxError stack
// trace that Brad's r730 logs surfaced 9x per 13h uptime.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// Recreate the relevant middleware in isolation. Importing the full
// createServer would require the entire Mnestra/Rumen stack; instead we
// mount just the JSON parser + error handler the way index.js does.
function makeApp() {
  const app = express();
  app.use(express.json({
    verify: (req, res, buf) => {
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
      return res.status(400).json({
        error: 'Malformed JSON body',
        detail: err.message,
        code: err.code,
      });
    }
    return next(err);
  });
  app.post('/echo', (req, res) => res.json({ received: req.body }));
  return app;
}

function postRaw(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        { method: 'POST', host: '127.0.0.1', port, path: '/echo', headers: { 'Content-Type': 'application/json' } },
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

test('valid JSON body passes through', async () => {
  const r = await postRaw(makeApp(), JSON.stringify({ ok: true, msg: 'hello world' }));
  assert.strictEqual(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.deepStrictEqual(parsed.received, { ok: true, msg: 'hello world' });
});

test('JSON with properly-escaped control chars passes', async () => {
  // \n, \t, \r are valid JSON escapes — should NOT be rejected.
  const body = JSON.stringify({ msg: 'line1\nline2\tcol\rretry' });
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 200);
});

test('JSON with raw \\x07 (BEL) in string is rejected with structured 400', async () => {
  // Brad's r730 most likely shape: agent-to-agent inject of PTY output
  // containing BEL or other terminal control codes.
  const body = '{"msg":"hello\x07world"}';
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 400);
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.code, 'CONTROL_CHAR_IN_STRING');
  assert.match(parsed.detail, /control character 0x07/);
});

test('JSON with raw \\x01 in string rejected', async () => {
  const body = '{"data":"\x01"}';
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).code, 'CONTROL_CHAR_IN_STRING');
});

test('JSON with control char OUTSIDE strings (structural) is fine', async () => {
  // Whitespace control chars (\n, \t) between structural tokens are valid JSON.
  const body = '{\n\t"key": "value"\n}';
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body).received, { key: 'value' });
});

test('escaped backslash before control char does NOT bypass check', async () => {
  // \\\x07 = literal backslash + BEL — backslash is escaped, so the BEL is
  // unprotected and should still be rejected. The verify callback must not
  // mistake \\ (escaped backslash) for an open escape sequence.
  const body = '{"msg":"\\\\\x07"}';
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 400);
});

test('malformed JSON (not control-char) still returns structured 400', async () => {
  // Pre-existing Sprint 56 behavior must continue: a plain malformed body
  // returns 400 with a structured error (just no CONTROL_CHAR_IN_STRING code).
  const body = '{not valid json';
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 400);
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.error, 'Malformed JSON body');
  assert.notStrictEqual(parsed.code, 'CONTROL_CHAR_IN_STRING');
});

test('control char in JSON KEY is also rejected', async () => {
  const body = '{"hello\x05world": 1}';
  const r = await postRaw(makeApp(), body);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).code, 'CONTROL_CHAR_IN_STRING');
});
