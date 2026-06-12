'use strict';

// HTTP-level tests for STATIC OAuth client support in src/auth.js (Sprint 75 /
// T1). Static clients exist for connectors that cannot do RFC 7591 DCR — the
// Gemini Enterprise custom MCP connector takes an admin-entered client_id /
// client_secret. These boot the real express app (createBridgeServer) so the
// consentRouter intercepts AND the SDK's own /authorize + /token + /register
// handlers are all in the loop: what these tests send is exactly what the wire
// sees.
//
// Coverage map (T1 brief + ORCH's four binding conditions on the PKCE
// relaxation, STATUS.md 2026-06-12 13:12 ET):
//   • static grant e2e — correct / wrong / absent secret (wrong rejected by
//     OUR timing-safe gate, not the SDK's `!==`)
//   • refresh rotation + scope-escalation rejection
//   • DCR regression alongside static config + registration-payload injection
//     of static-only attributes is stripped structurally
//   • static record / secret never persisted to state
//   • PKCE-less matrix: off-by-default, opt-in grant, cross-redemption closed
//     both ways, DCR/public clients always hard-fail without PKCE
//   • client_secret_basic shim (Basic grants; 401 + WWW-Authenticate on
//     failure; dual-method rejected)
//   • info/healthz redaction; static /token branch rate limit

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createBridgeServer } = require('../src/server');
const { createBridgeAuth, createMemoryStore } = require('../src/auth');

const CLIENT_ID = 'gemini-enterprise';
const SECRET = 'gemini-static-secret-0123456789abcdef';
const REDIRECT = 'https://example-connector.test/oauth/callback';

function mkServer({ staticClientExtra = {}, authOptions = {} } = {}) {
  const auth = createBridgeAuth({
    issuerUrl: 'http://127.0.0.1:8912',
    store: createMemoryStore(),
    jwtSecret: 'unit-test-secret-not-for-prod',
    operatorSecret: 'unit-op',
    autoApprove: true,
    staticClients: [
      {
        client_id: CLIENT_ID,
        client_secret: SECRET,
        redirect_uris: [REDIRECT],
        ...staticClientExtra,
      },
    ],
    ...authOptions,
  });
  const server = createBridgeServer({ tools: [], policy: null, auth });
  const http = server.listen(0, '127.0.0.1');
  return {
    auth,
    http,
    ready: new Promise((r) => http.once('listening', r)),
    base: () => `http://127.0.0.1:${http.address().port}`,
  };
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function form(obj) {
  return new URLSearchParams(obj).toString();
}

async function postToken(base, bodyObj, headers = {}) {
  const r = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form(bodyObj),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json, headers: r.headers };
}

async function getAuthorize(base, params) {
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: 'manual' });
  const loc = r.headers.get('location');
  const body = r.status === 302 ? null : await r.text().catch(() => null);
  await r.body?.cancel().catch(() => {});
  return { status: r.status, location: loc ? new URL(loc) : null, body };
}

// ── 1. static grant end-to-end (PKCE path through the SDK) ───────────────────

test('static client: full PKCE grant; wrong secret rejected by OUR timing-safe gate; absent secret rejected; failures never consume the code', async () => {
  const s = mkServer();
  await s.ready;
  try {
    const { verifier, challenge } = pkcePair();
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st1',
      scope: 'mcp:read',
    });
    assert.equal(a.status, 302);
    assert.equal(a.location.searchParams.get('state'), 'st1');
    const code = a.location.searchParams.get('code');
    assert.ok(code, 'authorization code issued');

    const bad = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: 'wrong-secret',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_client');
    assert.match(
      bad.json.error_description,
      /static gate/,
      'rejection came from the bridge timing-safe gate, not the SDK `!==`',
    );

    const absent = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
    });
    assert.equal(absent.status, 400);
    assert.equal(absent.json.error, 'invalid_client');
    assert.match(absent.json.error_description, /static gate/);

    const ok = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(ok.status, 200, `grant should succeed: ${JSON.stringify(ok.json)}`);
    assert.ok(ok.json.access_token && ok.json.refresh_token);
    assert.equal(ok.json.token_type, 'Bearer');
    const info = await s.auth.provider.verifyAccessToken(ok.json.access_token);
    assert.equal(info.clientId, CLIENT_ID);
    assert.deepEqual(info.scopes, ['mcp:read']);
  } finally {
    s.http.close();
  }
});

// ── 2. refresh rotation ──────────────────────────────────────────────────────

test('static client: refresh rotates (old invalidated, new works); scope escalation rejected without burning the token', async () => {
  const s = mkServer();
  await s.ready;
  try {
    const { verifier, challenge } = pkcePair();
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp:read',
    });
    const code = a.location.searchParams.get('code');
    const t1 = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(t1.status, 200);

    const t2 = await postToken(s.base(), {
      grant_type: 'refresh_token',
      refresh_token: t1.json.refresh_token,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(t2.status, 200);
    assert.ok(t2.json.refresh_token);
    assert.notEqual(t2.json.refresh_token, t1.json.refresh_token, 'refresh token rotated');

    const replay = await postToken(s.base(), {
      grant_type: 'refresh_token',
      refresh_token: t1.json.refresh_token,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'invalid_grant');

    const escalate = await postToken(s.base(), {
      grant_type: 'refresh_token',
      refresh_token: t2.json.refresh_token,
      scope: 'mcp:read mcp:admin',
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(escalate.status, 400);
    assert.equal(escalate.json.error, 'invalid_grant');

    // escalation is rejected BEFORE rotation — the token still works
    const after = await postToken(s.base(), {
      grant_type: 'refresh_token',
      refresh_token: t2.json.refresh_token,
      scope: 'mcp:read',
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(after.status, 200);
  } finally {
    s.http.close();
  }
});

// ── 3. DCR regression + structural injection guards ─────────────────────────

test('DCR unaffected by static config: register + public PKCE grant works; registration cannot mint static ids or inject allow_no_pkce; PKCE-less authorize as DCR client hard-fails', async () => {
  const s = mkServer({ staticClientExtra: { allow_no_pkce: true } });
  await s.ready;
  try {
    const reg = await fetch(`${s.base()}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://dcr-client.test/cb'],
        token_endpoint_auth_method: 'none',
        // injection attempts (ORCH condition 1 / T4 attack target):
        allow_no_pkce: true,
        _allowNoPkce: true,
        _static: true,
      }),
    });
    assert.equal(reg.status, 201);
    const meta = await reg.json();
    assert.match(meta.client_id, /^mcp_/, 'DCR ids stay in their namespace');
    assert.notEqual(meta.client_id, CLIENT_ID);

    const stored = await s.auth.provider.clientsStore.getClient(meta.client_id);
    assert.ok(
      !stored.allow_no_pkce && !stored._allowNoPkce && !stored._static,
      'registration payload cannot inject static-only attributes',
    );

    // full PKCE grant for the DCR public client (no client_secret involved)
    const { verifier, challenge } = pkcePair();
    const a = await getAuthorize(s.base(), {
      client_id: meta.client_id,
      redirect_uri: 'https://dcr-client.test/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    assert.equal(a.status, 302);
    const code = a.location.searchParams.get('code');
    assert.ok(code);
    const tok = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'https://dcr-client.test/cb',
      client_id: meta.client_id,
    });
    assert.equal(tok.status, 200, `DCR grant should succeed: ${JSON.stringify(tok.json)}`);

    // PKCE-less authorize as the DCR/public client → hard-fail, no code
    // (the relaxation can never apply: the intercept reads only the static map)
    const noPkce = await getAuthorize(s.base(), {
      client_id: meta.client_id,
      redirect_uri: 'https://dcr-client.test/cb',
      response_type: 'code',
    });
    assert.equal(noPkce.status, 302);
    assert.equal(noPkce.location.searchParams.get('error'), 'invalid_request');
    assert.equal(noPkce.location.searchParams.get('code'), null);

    // the static record still resolves through the layered store
    const sc = await s.auth.provider.clientsStore.getClient(CLIENT_ID);
    assert.equal(sc._static, true);
  } finally {
    s.http.close();
  }
});

test('config validation: mcp_ prefix, missing secret, missing redirect_uris, duplicates, bad URI all throw at boot', () => {
  const base = {
    store: createMemoryStore(),
    issuerUrl: 'http://127.0.0.1:8912',
    jwtSecret: 'k',
    operatorSecret: 'op',
  };
  assert.throws(
    () =>
      createBridgeAuth({
        ...base,
        staticClients: [{ client_id: 'mcp_evil', client_secret: 's', redirect_uris: [REDIRECT] }],
      }),
    /must not start with "mcp_"/,
  );
  assert.throws(
    () => createBridgeAuth({ ...base, staticClients: [{ client_id: 'a', redirect_uris: [REDIRECT] }] }),
    /client_secret is required/,
  );
  assert.throws(
    () => createBridgeAuth({ ...base, staticClients: [{ client_id: 'a', client_secret: 's' }] }),
    /redirect_uri/,
  );
  assert.throws(
    () =>
      createBridgeAuth({
        ...base,
        staticClients: [
          { client_id: 'a', client_secret: 's', redirect_uris: [REDIRECT] },
          { client_id: 'a', client_secret: 's2', redirect_uris: [REDIRECT] },
        ],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      createBridgeAuth({
        ...base,
        staticClients: [{ client_id: 'a', client_secret: 's', redirect_uris: ['not a url'] }],
      }),
    /invalid redirect_uri/,
  );
});

test('env fallback seeds a single static client; explicit option (even []) beats env', async () => {
  const ENV_KEYS = [
    'TERMDECK_BRIDGE_STATIC_CLIENT_ID',
    'TERMDECK_BRIDGE_STATIC_CLIENT_SECRET',
    'TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS',
    'TERMDECK_BRIDGE_STATIC_CLIENT_ALLOW_NO_PKCE',
  ];
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  process.env.TERMDECK_BRIDGE_STATIC_CLIENT_ID = 'env-client';
  process.env.TERMDECK_BRIDGE_STATIC_CLIENT_SECRET = 'env-secret-123';
  process.env.TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS = `${REDIRECT}, https://second.test/cb`;
  process.env.TERMDECK_BRIDGE_STATIC_CLIENT_ALLOW_NO_PKCE = '1';
  try {
    const base = {
      store: createMemoryStore(),
      issuerUrl: 'http://127.0.0.1:8912',
      jwtSecret: 'k',
      operatorSecret: 'op',
    };
    const fromEnv = createBridgeAuth({ ...base });
    const c = await fromEnv.provider.clientsStore.getClient('env-client');
    assert.ok(c && c._static, 'env-seeded static client resolves');
    assert.equal(c._allowNoPkce, true);
    assert.deepEqual([...c.redirect_uris], [REDIRECT, 'https://second.test/cb']);
    assert.deepEqual(fromEnv.info.staticClientIds, ['env-client']);

    const explicit = createBridgeAuth({ ...base, store: createMemoryStore(), staticClients: [] });
    assert.equal(await explicit.provider.clientsStore.getClient('env-client'), undefined);
    assert.deepEqual(explicit.info.staticClientIds, []);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── 4. never persisted ───────────────────────────────────────────────────────

test('static client never reaches persisted state: no clients entry, no secret material anywhere in state', async () => {
  const s = mkServer();
  await s.ready;
  try {
    const { verifier, challenge } = pkcePair();
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const code = a.location.searchParams.get('code');
    const tok = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(tok.status, 200);

    const state = s.auth._internal.state;
    assert.equal(state.clients[CLIENT_ID], undefined, 'static client never written to the clients store');
    const dump = JSON.stringify(state);
    assert.ok(!dump.includes(SECRET), 'client_secret never reaches persisted state');
    // (refresh records reference the client_id by design — hashed token, no secret)
  } finally {
    s.http.close();
  }
});

test('info exposes staticClientIds but never the secret; /healthz is secret-free', async () => {
  const s = mkServer();
  await s.ready;
  try {
    assert.deepEqual(s.auth.info.staticClientIds, [CLIENT_ID]);
    assert.ok(!JSON.stringify(s.auth.info).includes(SECRET));
    const h = await (await fetch(`${s.base()}/healthz`)).json();
    assert.ok(!JSON.stringify(h).includes(SECRET));
  } finally {
    s.http.close();
  }
});

// ── 5. PKCE-less matrix (ORCH-approved relaxation, four binding conditions) ──

test('PKCE-less is OFF by default: static client without code_challenge → invalid_request from the SDK, no code minted', async () => {
  const s = mkServer(); // allow_no_pkce NOT set
  await s.ready;
  try {
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 's2',
    });
    assert.equal(a.status, 302);
    assert.equal(a.location.searchParams.get('error'), 'invalid_request');
    assert.equal(a.location.searchParams.get('code'), null);
  } finally {
    s.http.close();
  }
});

test('PKCE-less opt-in: challenge-less authorize issues a code; token WITHOUT verifier + correct secret grants; wrong secret rejected; code is one-time', async () => {
  const s = mkServer({ staticClientExtra: { allow_no_pkce: true } });
  await s.ready;
  try {
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 's3',
      scope: 'mcp:read',
    });
    assert.equal(a.status, 302);
    assert.equal(a.location.searchParams.get('state'), 's3');
    const code = a.location.searchParams.get('code');
    assert.ok(code, 'challenge-less code issued for the opted-in static client');

    const bad = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: 'nope',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_client');

    const ok = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(ok.status, 200, `PKCE-less grant should succeed: ${JSON.stringify(ok.json)}`);
    assert.ok(ok.json.access_token && ok.json.refresh_token);
    const info = await s.auth.provider.verifyAccessToken(ok.json.access_token);
    assert.equal(info.clientId, CLIENT_ID);

    const replay = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'invalid_grant');
  } finally {
    s.http.close();
  }
});

test('cross-redemption closed both ways: PKCE-issued code requires its verifier even for an allow_no_pkce client; challenge-less code fails any presented verifier', async () => {
  const s = mkServer({ staticClientExtra: { allow_no_pkce: true } });
  await s.ready;
  try {
    // (a) code issued WITH a challenge — redeeming without a verifier must fail
    const { verifier, challenge } = pkcePair();
    const a1 = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const code1 = a1.location.searchParams.get('code');
    const noVerifier = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code: code1,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(noVerifier.status, 400);
    assert.equal(noVerifier.json.error, 'invalid_request', 'SDK schema demands the verifier');

    // ...and the failed attempt did not consume it: proper redemption works
    const proper = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code: code1,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(proper.status, 200);

    // (b) challenge-less code + any verifier → invalid_grant
    const a2 = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    const code2 = a2.location.searchParams.get('code');
    assert.ok(code2);
    const forged = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code: code2,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.json.error, 'invalid_grant', 'verifyChallenge(v, undefined) must fail');
  } finally {
    s.http.close();
  }
});

test('PKCE-less + operator consent (autoApprove off): consent page renders, correct operator secret issues a working challenge-less code', async () => {
  const s = mkServer({
    staticClientExtra: { allow_no_pkce: true },
    authOptions: { autoApprove: false },
  });
  await s.ready;
  try {
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 's9',
    });
    assert.equal(a.status, 200, 'consent page rendered (not auto-approved)');
    const m = /name="pending" value="([^"]+)"/.exec(a.body);
    assert.ok(m, 'pending blob present in consent form');

    const consent = await fetch(`${s.base()}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ pending: m[1], operator_secret: 'unit-op', action: 'allow' }),
      redirect: 'manual',
    });
    assert.equal(consent.status, 302);
    const loc = new URL(consent.headers.get('location'));
    await consent.body?.cancel().catch(() => {});
    assert.equal(loc.searchParams.get('state'), 's9');
    const code = loc.searchParams.get('code');
    assert.ok(code);

    const tok = await postToken(s.base(), {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    assert.equal(tok.status, 200);
  } finally {
    s.http.close();
  }
});

// ── 6. client_secret_basic shim ──────────────────────────────────────────────

test('client_secret_basic: Basic-auth grant works for static clients; wrong Basic secret → 401 + WWW-Authenticate; dual-method → invalid_request', async () => {
  const s = mkServer({ staticClientExtra: { allow_no_pkce: true } });
  await s.ready;
  try {
    const a = await getAuthorize(s.base(), {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    const code = a.location.searchParams.get('code');

    const good = Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64');
    const ok = await postToken(
      s.base(),
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT },
      { Authorization: `Basic ${good}` },
    );
    assert.equal(ok.status, 200, `Basic-auth grant should succeed: ${JSON.stringify(ok.json)}`);

    const wrong = Buffer.from(`${CLIENT_ID}:bad-secret`).toString('base64');
    const r401 = await postToken(
      s.base(),
      { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token },
      { Authorization: `Basic ${wrong}` },
    );
    assert.equal(r401.status, 401);
    assert.match(r401.headers.get('www-authenticate') || '', /^Basic/);
    assert.equal(r401.json.error, 'invalid_client');

    const dual = await postToken(
      s.base(),
      {
        grant_type: 'refresh_token',
        refresh_token: ok.json.refresh_token,
        client_id: CLIENT_ID,
        client_secret: SECRET,
      },
      { Authorization: `Basic ${good}` },
    );
    assert.equal(dual.status, 400);
    assert.equal(dual.json.error, 'invalid_request');

    // none of the failures burned the refresh token
    const fin = await postToken(
      s.base(),
      { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token },
      { Authorization: `Basic ${good}` },
    );
    assert.equal(fin.status, 200);
  } finally {
    s.http.close();
  }
});

// ── 7. rate limit on the static /token branch ────────────────────────────────

test('static /token branch is rate-limited (mirrors the SDK 50/15min posture)', async () => {
  const s = mkServer();
  await s.ready;
  try {
    let last;
    for (let i = 0; i < 51; i++) {
      last = await postToken(s.base(), {
        grant_type: 'refresh_token',
        refresh_token: 'r',
        client_id: CLIENT_ID,
        client_secret: 'wrong',
      });
    }
    assert.equal(last.status, 429);
    assert.equal(last.json.error, 'too_many_requests');
  } finally {
    s.http.close();
  }
});
