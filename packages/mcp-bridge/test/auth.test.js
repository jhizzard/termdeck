'use strict';

// Unit tests for src/auth.js — the OAuth 2.1 / PKCE Authorization Server (T1).
// No HTTP: exercises the provider methods, JWT signer, and audience binding
// directly. (HTTP-level OAuth + transport are covered in server.test.js.)

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  createBridgeAuth,
  createMemoryStore,
  signJwt,
  verifyJwt,
  normalizeResource,
} = require('../src/auth');

const ISSUER = 'https://bridge.example.test';

function mkAuth(extra = {}) {
  return createBridgeAuth({
    issuerUrl: ISSUER,
    store: createMemoryStore(),
    jwtSecret: 'unit-test-secret-not-for-prod',
    operatorSecret: 'unit-op',
    ...extra,
  });
}

// Minimal Express-Response stand-in capturing redirect/send.
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    location: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.location = url;
      return this;
    },
  };
}

test('signJwt/verifyJwt round-trip, tamper detection, expiry', () => {
  const secret = Buffer.from('a-secret');
  const tok = signJwt({ kind: 'access', foo: 'bar' }, secret, { ttlSec: 60 });
  assert.equal(verifyJwt(tok, secret).foo, 'bar');

  assert.throws(() => verifyJwt(tok + 'x', secret), /signature|malformed/);
  const [h, p] = tok.split('.');
  const forged = `${h}.${p}.${Buffer.from('nope').toString('base64url')}`;
  assert.throws(() => verifyJwt(forged, secret), /signature/);
  assert.throws(() => verifyJwt(tok, Buffer.from('different')), /signature/);

  const expired = signJwt({ kind: 'access' }, secret, { ttlSec: -1 });
  assert.throws(() => verifyJwt(expired, secret), /expired/);
});

test('verifyAccessToken enforces audience (RFC 8707), issuer, and token kind', async () => {
  const a = mkAuth();
  const good = a._internal.mintAccessToken('client-1', 'mcp:read');
  const info = await a.provider.verifyAccessToken(good);
  assert.equal(info.clientId, 'client-1');
  assert.deepEqual(info.scopes, ['mcp:read']);
  assert.equal(info.resource.href, a.resourceUrl.href);

  // correct issuer (use the URL-normalized href), wrong audience → audience check
  const wrongAud = signJwt(
    { kind: 'access', iss: a.issuerUrl.href, aud: 'https://evil.example/mcp', client_id: 'x' },
    a._internal.secret,
    { ttlSec: 60 },
  );
  await assert.rejects(() => a.provider.verifyAccessToken(wrongAud), /audience/);

  const wrongIss = signJwt(
    { kind: 'access', iss: 'https://other.example', aud: a.resourceUrl.href, client_id: 'x' },
    a._internal.secret,
    { ttlSec: 60 },
  );
  await assert.rejects(() => a.provider.verifyAccessToken(wrongIss), /issuer/);

  const pending = signJwt(
    { kind: 'pending_auth', iss: ISSUER, aud: a.resourceUrl.href },
    a._internal.secret,
    { ttlSec: 60 },
  );
  await assert.rejects(() => a.provider.verifyAccessToken(pending), /access token/);
});

test('static bearer dev fallback is accepted only when configured', async () => {
  const a = mkAuth({ staticBearer: 'dev-bearer-123' });
  const info = await a.provider.verifyAccessToken('dev-bearer-123');
  assert.equal(info.clientId, 'static-dev-bearer');
  assert.equal(info.resource.href, a.resourceUrl.href);
  await assert.rejects(() => a.provider.verifyAccessToken('dev-bearer-999'));

  const noStatic = mkAuth();
  await assert.rejects(() => noStatic.provider.verifyAccessToken('dev-bearer-123'));
});

test('DCR registerClient + getClient; public client has no secret', async () => {
  const a = mkAuth();
  const reg = await a.provider.clientsStore.registerClient({
    redirect_uris: ['https://client.example/cb'],
    token_endpoint_auth_method: 'none',
  });
  assert.match(reg.client_id, /^mcp_/);
  assert.ok(!reg.client_secret, 'public (PKCE) client gets no client_secret');
  const got = await a.provider.clientsStore.getClient(reg.client_id);
  assert.equal(got.client_id, reg.client_id);
  assert.equal(await a.provider.clientsStore.getClient('nope'), undefined);
});

test('auth code: challenge returned, one-time exchange, audience-bound token', async () => {
  const a = mkAuth({ autoApprove: true });
  const client = { client_id: 'c1' };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const res = fakeRes();
  await a.provider.authorize(
    client,
    { redirectUri: 'https://client.example/cb', codeChallenge: challenge, scopes: ['mcp:read'], state: 's1', resource: a.resourceUrl },
    res,
  );
  assert.equal(res.statusCode, 302);
  const u = new URL(res.location);
  assert.equal(u.searchParams.get('state'), 's1');
  const code = u.searchParams.get('code');
  assert.ok(code);

  assert.equal(await a.provider.challengeForAuthorizationCode(client, code), challenge);

  const tokens = await a.provider.exchangeAuthorizationCode(client, code, undefined, 'https://client.example/cb', a.resourceUrl);
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.token_type, 'Bearer');
  const info = await a.provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.href, a.resourceUrl.href);

  // one-time use: the code is now consumed
  await assert.rejects(
    () => a.provider.exchangeAuthorizationCode(client, code, undefined, 'https://client.example/cb', a.resourceUrl),
    /invalid or expired/,
  );
});

test('exchangeAuthorizationCode rejects a mismatched resource (RFC 8707)', async () => {
  const a = mkAuth({ autoApprove: true });
  const client = { client_id: 'c2' };
  const res = fakeRes();
  await a.provider.authorize(client, { redirectUri: 'https://client.example/cb', codeChallenge: 'x', resource: a.resourceUrl }, res);
  const code = new URL(res.location).searchParams.get('code');
  await assert.rejects(
    () => a.provider.exchangeAuthorizationCode(client, code, undefined, 'https://client.example/cb', new URL('https://evil.example/mcp')),
    /resource/,
  );
});

test('refresh-token rotation + revocation', async () => {
  const a = mkAuth({ autoApprove: true });
  const client = { client_id: 'c3' };
  const res = fakeRes();
  await a.provider.authorize(client, { redirectUri: 'https://client.example/cb', codeChallenge: 'x', scopes: ['mcp:read'], resource: a.resourceUrl }, res);
  const code = new URL(res.location).searchParams.get('code');
  const t1 = await a.provider.exchangeAuthorizationCode(client, code, undefined, 'https://client.example/cb', a.resourceUrl);

  const t2 = await a.provider.exchangeRefreshToken(client, t1.refresh_token, undefined, a.resourceUrl);
  assert.ok(t2.access_token && t2.refresh_token);
  assert.notEqual(t2.refresh_token, t1.refresh_token, 'refresh token is rotated');
  await assert.rejects(() => a.provider.exchangeRefreshToken(client, t1.refresh_token, undefined, a.resourceUrl), /invalid/);

  await a.provider.revokeToken(client, { token: t2.refresh_token });
  await assert.rejects(() => a.provider.exchangeRefreshToken(client, t2.refresh_token, undefined, a.resourceUrl), /invalid/);
});

test('normalizeResource tolerates trailing slash + case (per spec note)', () => {
  assert.equal(normalizeResource('https://Ex.COM/mcp/'), normalizeResource('https://ex.com/mcp'));
  assert.notEqual(normalizeResource('https://ex.com/mcp'), normalizeResource('https://ex.com/other'));
});
