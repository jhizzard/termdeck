// Cookie-attribute tests for the v0.7.0 long-lived auth cookie.
//
// Sprint 32 / T2. The auth.js login handler must:
//   - Set Max-Age=2592000 (30 days) so testers don't re-enter the token on
//     every browser session (Brad's 2026-04-26 feedback).
//   - Always set HttpOnly and SameSite=Lax.
//   - Set Secure ONLY when the request was over HTTPS — directly via
//     req.protocol or behind a reverse proxy via X-Forwarded-Proto.
//   - Keep the cookie name termdeck_token (read by extractToken / readCookieToken).
//
// Run: node --test tests/auth-cookie.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../packages/server/src/auth');

function fakeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  Object.defineProperty(res, 'headers', { get: () => headers });
  return res;
}

function setCookieFor(req, token = 'shhh') {
  const res = fakeRes();
  auth.writeAuthCookie(req, res, token);
  const value = res.getHeader('Set-Cookie');
  assert.equal(typeof value, 'string', 'Set-Cookie header must be a string');
  return value;
}

test('default HTTP request → Max-Age=2592000 and no Secure flag', () => {
  const req = { protocol: 'http', headers: {} };
  const cookie = setCookieFor(req);
  assert.match(cookie, /Max-Age=2592000/, 'must include 30-day Max-Age');
  assert.ok(!/;\s*Secure(\b|;|$)/i.test(cookie),
    `Secure must NOT be present on plain HTTP, got: ${cookie}`);
});

test('HTTPS direct → Max-Age=2592000 and Secure set', () => {
  const req = { protocol: 'https', headers: {} };
  const cookie = setCookieFor(req);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /;\s*Secure(\b|;|$)/i,
    'Secure must be set when req.protocol is https');
});

test('reverse-proxy HTTPS (X-Forwarded-Proto) → Secure set', () => {
  const req = {
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'https' },
  };
  const cookie = setCookieFor(req);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /;\s*Secure(\b|;|$)/i,
    'Secure must be set when X-Forwarded-Proto is https');
});

test('reverse-proxy XFP list (https,http) → Secure set on first hop', () => {
  // Behind chained proxies, X-Forwarded-Proto can be comma-joined.
  const req = {
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'https, http' },
  };
  const cookie = setCookieFor(req);
  assert.match(cookie, /;\s*Secure(\b|;|$)/i);
});

test('HttpOnly + SameSite=Lax retained on every variant', () => {
  const variants = [
    { protocol: 'http', headers: {} },
    { protocol: 'https', headers: {} },
    { protocol: 'http', headers: { 'x-forwarded-proto': 'https' } },
  ];
  for (const req of variants) {
    const cookie = setCookieFor(req);
    assert.match(cookie, /;\s*HttpOnly(\b|;|$)/,
      `HttpOnly missing in: ${cookie}`);
    assert.match(cookie, /;\s*SameSite=Lax(\b|;|$)/,
      `SameSite=Lax missing in: ${cookie}`);
  }
});

test('cookie name is termdeck_token and value is URL-encoded', () => {
  const req = { protocol: 'http', headers: {} };
  const cookie = setCookieFor(req, 'sk live/with spaces');
  assert.ok(cookie.startsWith('termdeck_token='),
    `cookie must start with termdeck_token=, got: ${cookie}`);
  assert.match(cookie, /^termdeck_token=sk%20live%2Fwith%20spaces;/);
});

test('Path=/ is set so cookie is sent on every request', () => {
  const cookie = setCookieFor({ protocol: 'http', headers: {} });
  assert.match(cookie, /;\s*Path=\/(\b|;|$)/);
});

test('handleLogin issues the cookie when token matches', () => {
  const req = {
    protocol: 'http',
    headers: {},
    method: 'POST',
    path: '/api/auth/login',
    body: { token: 'correct-horse' },
  };
  const res = fakeRes();
  auth.handleLogin(req, res, 'correct-horse');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  const cookie = res.getHeader('Set-Cookie');
  assert.ok(cookie && cookie.startsWith('termdeck_token=correct-horse;'));
  assert.match(cookie, /Max-Age=2592000/);
});

test('handleLogin rejects mismatched token without setting a cookie', () => {
  const req = {
    protocol: 'http',
    headers: {},
    method: 'POST',
    path: '/api/auth/login',
    body: { token: 'wrong' },
  };
  const res = fakeRes();
  auth.handleLogin(req, res, 'correct-horse');
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'unauthorized' });
  assert.equal(res.getHeader('Set-Cookie'), undefined,
    'no cookie should be issued on a failed login');
});

test('COOKIE_MAX_AGE_SECONDS exports as 30 days', () => {
  assert.equal(auth.COOKIE_MAX_AGE_SECONDS, 2592000,
    '30 days = 30 * 24 * 60 * 60 = 2592000 seconds');
});

test('isSecureRequest is case-insensitive on X-Forwarded-Proto', () => {
  assert.equal(auth.isSecureRequest({
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'HTTPS' },
  }), true);
  assert.equal(auth.isSecureRequest({
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'http' },
  }), false);
  assert.equal(auth.isSecureRequest({
    protocol: 'http',
    headers: {},
  }), false);
});
