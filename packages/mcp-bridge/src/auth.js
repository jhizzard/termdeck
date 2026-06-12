'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MCP Bridge — OAuth 2.1 Authorization Server  (Sprint 71 / A1, lane T1)
//
// The Bridge is a remote MCP server whose tool RESULTS egress to a provider
// cloud (Anthropic / OpenAI / xAI). The MCP spec itself ships NO auth — auth and
// scoping are the server's job (README invariant #4). This module is that job:
// a self-contained OAuth 2.1 / PKCE Authorization Server so a consumer chat can
// connect *by URL* (Dynamic Client Registration), and every request to /mcp is
// gated by an audience-bound bearer token.
//
//   • OAuth 2.1 + PKCE (S256) — the SDK's token handler verifies the verifier
//     against the challenge we store here; we never relax that (no
//     skipLocalPkceValidation).
//   • RFC 7591 Dynamic Client Registration — implementing clientsStore.registerClient
//     auto-enables the /register endpoint in mcpAuthRouter.
//   • Static client registration (Sprint 75 / T1) — pre-seeded confidential
//     clients for connectors that cannot DCR (the Gemini Enterprise custom MCP
//     connector takes an admin-entered client_id/client_secret): config/env-
//     sourced, in-memory only (never persisted), timing-safe secret gate ahead
//     of the SDK's token handler, optional operator-set per-client PKCE
//     relaxation (allow_no_pkce — ORCH-approved 2026-06-12, see consentRouter).
//   • RFC 8707 audience binding — access tokens carry aud=<canonical resource URI>;
//     verifyAccessToken rejects any token whose aud isn't this exact resource.
//   • Short-lived access tokens (default 1h) + rotating refresh tokens (OAuth 2.1
//     public-client rule).
//   • Resource-owner authentication — /authorize renders a consent page gated by
//     an operator secret, so merely discovering the URL is not enough to connect.
//   • Static-bearer dev fallback — documented dev-only path for ChatGPT/Grok.
//
// No external JWT dependency: jose v6 is ESM-only and this package is CommonJS,
// so HS256 sign/verify is hand-rolled on node:crypto (small, audited, tested).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const {
  InvalidGrantError,
  InvalidTokenError,
  InvalidTargetError,
  InvalidClientError,
  InvalidRequestError,
  OAuthError,
  ServerError,
} = require('@modelcontextprotocol/sdk/server/auth/errors.js');
// The SDK's redirect-URI matcher (exact match + RFC 8252 loopback-port
// relaxation) — reused so static clients get identical semantics.
const { redirectUriMatches } = require('@modelcontextprotocol/sdk/server/auth/handlers/authorize.js');

// ── encoding / crypto helpers ───────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(s) {
  return Buffer.from(String(s), 'base64url');
}
function randToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
// Constant-time string compare that does not leak length (hash both first).
function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
// Canonicalize an RFC 8707 resource id for comparison: lowercase origin, drop a
// single trailing slash from the path (per the spec's interoperability note).
function normalizeResource(href) {
  try {
    const u = new URL(href);
    return u.origin.toLowerCase() + u.pathname.replace(/\/$/, '');
  } catch {
    return String(href);
  }
}

// ── hand-rolled HS256 JWT ────────────────────────────────────────────────────
function signJwt(payload, secret, { ttlSec, typ } = {}) {
  const header = { alg: 'HS256', typ: typ || 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, ...payload };
  if (ttlSec != null) body.exp = now + ttlSec;
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(body)));
  const data = `${h}.${p}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}
// Verifies signature + exp/nbf. Throws InvalidTokenError on any failure so the
// SDK's requireBearerAuth maps it to a 401 (not a 500).
function verifyJwt(token, secret) {
  if (typeof token !== 'string') throw new InvalidTokenError('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidTokenError('malformed token');
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest();
  const got = fromB64url(parts[2]);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    throw new InvalidTokenError('bad signature');
  }
  let body;
  try {
    body = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    throw new InvalidTokenError('bad payload');
  }
  const now = Math.floor(Date.now() / 1000);
  if (body.exp != null && now >= body.exp) throw new InvalidTokenError('token expired');
  if (body.nbf != null && now < body.nbf) throw new InvalidTokenError('token not yet valid');
  return body;
}

// ── persistence (DCR clients + refresh-token hashes + signing secret) ────────
// Access tokens are stateless JWTs (never stored). Auth codes live in-memory
// only (short TTL). Refresh tokens are stored HASHED (sha256) so the file never
// contains a usable bearer credential. File mode 0600.
function freshState() {
  return { jwtSecret: null, clients: {}, refresh: {} };
}
function createMemoryStore() {
  const state = freshState();
  return { state, save() {} };
}
function createFileStore(file) {
  let state = freshState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = {
      jwtSecret: parsed.jwtSecret || null,
      clients: parsed.clients || {},
      refresh: parsed.refresh || {},
    };
  } catch {
    /* fail-soft: start fresh (first run, or unreadable file) */
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch {
      /* fail-soft: persistence is best-effort; in-memory state still works */
    }
  }
  return { state, save };
}

// ── static (pre-seeded) OAuth clients ────────────────────────────────────────
// Connectors that cannot do RFC 7591 DCR (the Gemini Enterprise custom MCP
// connector takes an admin-entered client_id/client_secret) authenticate
// against records resolved here. Static clients are confidential-ONLY (a
// secret is required), live in memory layered above the persisted DCR store,
// and are NEVER written to bridge-auth.json — the config is the secret's
// single source of truth. `allow_no_pkce` is operator-config-only by
// construction: nothing a registration endpoint accepts can create or mutate
// a static record.
function resolveStaticClients(options = {}) {
  let entries = options.staticClients;
  if (entries == null) {
    const envId = process.env.TERMDECK_BRIDGE_STATIC_CLIENT_ID;
    entries = envId
      ? [
          {
            client_id: envId,
            client_secret: process.env.TERMDECK_BRIDGE_STATIC_CLIENT_SECRET,
            redirect_uris: String(process.env.TERMDECK_BRIDGE_STATIC_CLIENT_REDIRECT_URIS || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            allow_no_pkce: process.env.TERMDECK_BRIDGE_STATIC_CLIENT_ALLOW_NO_PKCE === '1',
          },
        ]
      : [];
  }
  const map = new Map();
  for (const entry of entries) {
    const id = entry && entry.client_id;
    if (!id || typeof id !== 'string') {
      throw new Error('static client: client_id is required');
    }
    if (id.startsWith('mcp_')) {
      throw new Error(`static client "${id}": ids must not start with "mcp_" (reserved for DCR)`);
    }
    if (map.has(id)) {
      throw new Error(`static client "${id}": duplicate client_id`);
    }
    if (!entry.client_secret || typeof entry.client_secret !== 'string') {
      throw new Error(
        `static client "${id}": client_secret is required (static clients are confidential-only)`,
      );
    }
    const uris = Array.isArray(entry.redirect_uris)
      ? entry.redirect_uris.filter((u) => typeof u === 'string' && u)
      : [];
    if (!uris.length) {
      throw new Error(`static client "${id}": at least one redirect_uri is required`);
    }
    for (const u of uris) {
      if (!URL.canParse(u)) throw new Error(`static client "${id}": invalid redirect_uri "${u}"`);
    }
    map.set(
      id,
      Object.freeze({
        client_id: id,
        client_secret: entry.client_secret,
        client_name: entry.client_name || id,
        redirect_uris: Object.freeze(uris.slice()),
        grant_types: Object.freeze(['authorization_code', 'refresh_token']),
        response_types: Object.freeze(['code']),
        token_endpoint_auth_method: 'client_secret_post', // + Basic via the /token shim
        client_secret_expires_at: 0, // non-expiring
        ...(entry.scope ? { scope: entry.scope } : {}),
        _static: true,
        _allowNoPkce: !!entry.allow_no_pkce,
      }),
    );
  }
  return map;
}

// RFC 6749 §2.3.1 client_secret_basic: client_id and client_secret are
// form-urlencoded inside the base64 Basic credentials. Null for anything
// malformed — the caller falls back to the SDK's body-only path.
function parseBasicAuth(header) {
  if (typeof header !== 'string') return null;
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  try {
    return {
      client_id: decodeURIComponent(decoded.slice(0, i)),
      client_secret: decodeURIComponent(decoded.slice(i + 1)),
    };
  } catch {
    return null;
  }
}

// ── the factory ──────────────────────────────────────────────────────────────
function createBridgeAuth(options = {}) {
  const issuerUrl = new URL(
    options.issuerUrl ||
      process.env.TERMDECK_BRIDGE_PUBLIC_URL ||
      `http://localhost:${options.port || process.env.PORT || 8870}`,
  );
  // Canonical RFC 8707 resource identifier = the MCP endpoint URI.
  const resourceUrl = new URL(options.resourceUrl || new URL('/mcp', issuerUrl).href);
  const accessTtlSec =
    Number(options.accessTtlSec || process.env.TERMDECK_BRIDGE_ACCESS_TTL_SEC) || 3600;
  const refreshTtlSec =
    Number(options.refreshTtlSec || process.env.TERMDECK_BRIDGE_REFRESH_TTL_SEC) ||
    60 * 60 * 24 * 30;
  const scopesSupported = options.scopesSupported || ['mcp:read'];

  const store =
    options.store ||
    createFileStore(
      options.statePath || path.join(os.homedir(), '.termdeck', 'bridge-auth.json'),
    );
  const state = store.state;

  // Signing secret: explicit option > env > persisted > generate-and-persist.
  let secret;
  if (options.jwtSecret) secret = Buffer.from(options.jwtSecret);
  else if (process.env.TERMDECK_BRIDGE_JWT_SECRET)
    secret = Buffer.from(process.env.TERMDECK_BRIDGE_JWT_SECRET);
  else if (state.jwtSecret) secret = fromB64url(state.jwtSecret);
  else {
    secret = crypto.randomBytes(32);
    state.jwtSecret = b64url(secret);
    store.save();
  }

  // Consent gate. Explicit > env > ephemeral (printed at boot by server.js).
  let operatorSecret =
    options.operatorSecret || process.env.TERMDECK_BRIDGE_OPERATOR_SECRET || null;
  const ephemeralOperator = !operatorSecret;
  if (ephemeralOperator) operatorSecret = randToken(9);

  const autoApprove =
    options.autoApprove != null
      ? options.autoApprove
      : process.env.TERMDECK_BRIDGE_AUTO_APPROVE === '1';
  const staticBearer =
    options.staticBearer || process.env.TERMDECK_BRIDGE_STATIC_BEARER || null;
  // Pre-seeded confidential clients (e.g. Gemini Enterprise). In-memory only —
  // never written to the state file; the config is the secret's only home.
  const staticClients = resolveStaticClients(options);

  const codes = new Map(); // code -> { client_id, redirect_uri, code_challenge, scope, resource, exp }
  const accessDenylist = new Set(); // jti of best-effort-revoked access tokens

  function pruneCodes() {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
  }
  function lookupRefresh(rawToken) {
    const hash = sha256hex(rawToken);
    const rec = state.refresh[hash];
    if (!rec) return null;
    if (rec.exp <= Math.floor(Date.now() / 1000)) {
      delete state.refresh[hash];
      store.save();
      return null;
    }
    return { hash, rec };
  }
  function assertResource(resource) {
    if (!resource) return; // client omitted it — bind to our resource by default
    const href = resource instanceof URL ? resource.href : String(resource);
    if (normalizeResource(href) !== normalizeResource(resourceUrl.href)) {
      throw new InvalidTargetError(`token resource must be ${resourceUrl.href}`);
    }
  }
  function mintAccessToken(clientId, scope) {
    return signJwt(
      {
        kind: 'access',
        iss: issuerUrl.href,
        aud: resourceUrl.href,
        sub: clientId,
        client_id: clientId,
        scope: scope || '',
        jti: randToken(8),
      },
      secret,
      { ttlSec: accessTtlSec, typ: 'at+jwt' },
    );
  }
  function mintRefreshToken(clientId, scope) {
    const raw = randToken(32);
    state.refresh[sha256hex(raw)] = {
      client_id: clientId,
      scope: scope || '',
      resource: resourceUrl.href,
      exp: Math.floor(Date.now() / 1000) + refreshTtlSec,
    };
    store.save();
    return raw;
  }
  function issueCode({ clientId, redirectUri, codeChallenge, scope, resource }) {
    const code = randToken(32);
    codes.set(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      scope,
      resource: resource || resourceUrl.href,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    return code;
  }
  function redirectWithCode(res, redirectUri, code, stateParam) {
    const u = new URL(redirectUri);
    u.searchParams.set('code', code);
    if (stateParam) u.searchParams.set('state', stateParam);
    res.redirect(302, u.href);
  }

  // ── consent UI ──
  function renderConsent({ clientLabel, scope, pending, error }) {
    const consentPath = new URL('/oauth/consent', issuerUrl).pathname;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TermDeck MCP Bridge — Authorize</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:28px 32px;max-width:440px;width:90%}
 h1{font-size:18px;margin:0 0 4px}.sub{color:#8b949e;font-size:13px;margin:0 0 18px}
 .row{margin:14px 0}label{display:block;font-size:13px;color:#8b949e;margin-bottom:6px}
 input[type=password]{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:9px 11px;font-size:14px}
 .scope{font-family:ui-monospace,monospace;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 11px;font-size:12px;color:#58a6ff}
 .btns{display:flex;gap:10px;margin-top:20px}
 button{flex:1;border:0;border-radius:6px;padding:10px;font-size:14px;font-weight:600;cursor:pointer}
 .allow{background:#238636;color:#fff}.deny{background:#21262d;color:#c9d1d9;border:1px solid #30363d}
 .err{background:#3d1418;border:1px solid #f85149;color:#ff7b72;border-radius:6px;padding:8px 11px;font-size:13px;margin-bottom:14px}
 .warn{color:#8b949e;font-size:11px;margin-top:16px}
</style></head><body>
<div class="card">
 <h1>Authorize MCP connection</h1>
 <p class="sub">A chat client wants to connect to your <strong>TermDeck&nbsp;MCP&nbsp;Bridge</strong> (read-only memory + terminal state).</p>
 ${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}
 <div class="row"><label>Client</label><div class="scope">${htmlEscape(clientLabel)}</div></div>
 <div class="row"><label>Scope</label><div class="scope">${htmlEscape(scope || '(default)')}</div></div>
 <form method="post" action="${htmlEscape(consentPath)}">
   <input type="hidden" name="pending" value="${htmlEscape(pending)}">
   <div class="row"><label for="op">Operator secret</label>
     <input id="op" type="password" name="operator_secret" autocomplete="off" autofocus></div>
   <div class="btns">
     <button class="deny" type="submit" name="action" value="deny">Deny</button>
     <button class="allow" type="submit" name="action" value="allow">Authorize</button>
   </div>
 </form>
 <p class="warn">Results returned to the chat are egress-redacted and read-only. Only panels/projects you've allowlisted are visible.</p>
</div></body></html>`;
  }
  function renderError(msg) {
    return `<!doctype html><meta charset="utf-8"><title>Authorization error</title>
<body style="font:15px -apple-system,sans-serif;background:#0d1117;color:#c9d1d9;padding:40px">
<h2 style="color:#f85149">Authorization error</h2><p>${htmlEscape(msg)}</p></body>`;
  }

  // ── clients store (in-memory static layer over the persisted DCR store) ──
  const clientsStore = {
    async getClient(clientId) {
      // Static records win and never touch the persisted store.
      return staticClients.get(clientId) || state.clients[clientId];
    },
    async registerClient(client) {
      // DCR ids are server-minted in their own `mcp_` namespace; static ids
      // may not use the prefix (boot validation) and the loop covers the
      // residual collision odds.
      let clientId;
      do {
        clientId = 'mcp_' + randToken(18);
      } while (staticClients.has(clientId) || state.clients[clientId]);
      const isPublic = (client.token_endpoint_auth_method || 'none') === 'none';
      const full = {
        ...client,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      // Static-only attributes can never enter via a registration payload
      // (ORCH condition: allow_no_pkce is operator-config-only, structurally).
      delete full.allow_no_pkce;
      delete full._allowNoPkce;
      delete full._static;
      if (!isPublic) {
        full.client_secret = randToken(24);
        full.client_secret_expires_at = 0; // non-expiring
      }
      state.clients[clientId] = full;
      store.save();
      return full;
    },
  };

  // ── OAuthServerProvider ──
  const provider = {
    get clientsStore() {
      return clientsStore;
    },

    async authorize(client, params, res) {
      assertResource(params.resource);
      const scope = (params.scopes && params.scopes.length ? params.scopes : scopesSupported).join(' ');
      if (autoApprove) {
        const code = issueCode({
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          scope,
          resource: params.resource ? params.resource.href : resourceUrl.href,
        });
        return redirectWithCode(res, params.redirectUri, code, params.state);
      }
      const pending = signJwt(
        {
          kind: 'pending_auth',
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          code_challenge: params.codeChallenge,
          scope,
          resource: params.resource ? params.resource.href : resourceUrl.href,
          state: params.state || '',
        },
        secret,
        { ttlSec: 600 },
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(
        renderConsent({
          clientLabel: client.client_name || client.client_id,
          scope,
          pending,
        }),
      );
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      pruneCodes();
      const rec = codes.get(authorizationCode);
      if (!rec || rec.client_id !== client.client_id) {
        throw new InvalidGrantError('invalid or expired authorization code');
      }
      return rec.code_challenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      // PKCE already verified by the SDK token handler against the challenge we
      // returned from challengeForAuthorizationCode.
      pruneCodes();
      const rec = codes.get(authorizationCode);
      if (!rec || rec.client_id !== client.client_id) {
        throw new InvalidGrantError('invalid or expired authorization code');
      }
      if (redirectUri && redirectUri !== rec.redirect_uri) {
        throw new InvalidGrantError('redirect_uri mismatch');
      }
      assertResource(resource);
      codes.delete(authorizationCode); // one-time use
      return {
        access_token: mintAccessToken(client.client_id, rec.scope),
        token_type: 'Bearer',
        expires_in: accessTtlSec,
        refresh_token: mintRefreshToken(client.client_id, rec.scope),
        scope: rec.scope,
      };
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      assertResource(resource);
      const found = lookupRefresh(refreshToken);
      if (!found || found.rec.client_id !== client.client_id) {
        throw new InvalidGrantError('invalid or expired refresh token');
      }
      let scope = found.rec.scope;
      if (scopes && scopes.length) {
        const granted = new Set(found.rec.scope.split(' ').filter(Boolean));
        for (const s of scopes) {
          if (!granted.has(s)) throw new InvalidGrantError('requested scope exceeds original grant');
        }
        scope = scopes.join(' ');
      }
      // OAuth 2.1: rotate refresh tokens for public clients.
      delete state.refresh[found.hash];
      const refresh_token = mintRefreshToken(client.client_id, scope);
      return {
        access_token: mintAccessToken(client.client_id, scope),
        token_type: 'Bearer',
        expires_in: accessTtlSec,
        refresh_token,
        scope,
      };
    },

    async verifyAccessToken(token) {
      // Documented dev-only fallback: a fixed bearer (e.g. for a ChatGPT manual
      // connector during development). Disabled unless explicitly configured.
      if (staticBearer && timingSafeEqualStr(token, staticBearer)) {
        return {
          token,
          clientId: 'static-dev-bearer',
          scopes: scopesSupported.slice(),
          expiresAt: Math.floor(Date.now() / 1000) + accessTtlSec,
          resource: new URL(resourceUrl.href),
        };
      }
      const body = verifyJwt(token, secret); // throws InvalidTokenError on bad sig/exp
      if (body.kind !== 'access') throw new InvalidTokenError('not an access token');
      if (body.iss !== issuerUrl.href) throw new InvalidTokenError('issuer mismatch');
      // RFC 8707 audience binding: token MUST be for this exact resource.
      if (normalizeResource(body.aud || '') !== normalizeResource(resourceUrl.href)) {
        throw new InvalidTokenError('token audience does not match this resource');
      }
      if (body.jti && accessDenylist.has(body.jti)) throw new InvalidTokenError('token revoked');
      return {
        token,
        clientId: body.client_id || body.sub,
        scopes: (body.scope || '').split(' ').filter(Boolean),
        expiresAt: body.exp,
        resource: new URL(resourceUrl.href),
      };
    },

    async revokeToken(client, request) {
      const raw = request && request.token;
      if (!raw) return;
      // Refresh token: drop the stored hash.
      const hash = sha256hex(raw);
      if (state.refresh[hash]) {
        delete state.refresh[hash];
        store.save();
        return;
      }
      // Access token (stateless JWT): best-effort jti denylist for its lifetime.
      try {
        const body = verifyJwt(raw, secret);
        if (body && body.jti) accessDenylist.add(body.jti);
      } catch {
        /* invalid/expired token — nothing to revoke */
      }
    },
  };

  // ── consent route + static-client gates (mounted at app root by server.js) ──
  // consentRouter mounts BEFORE mcpAuthRouter (server.js), so the two static-
  // client intercepts below see /authorize and /token traffic first and
  // next() everything that is not theirs — the SDK path for DCR clients is
  // byte-for-byte untouched.
  const consentRouter = express.Router();

  function sendOAuthError(res, err, status) {
    res.setHeader('Cache-Control', 'no-store');
    return res
      .status(status || (err instanceof ServerError ? 500 : 400))
      .json(err.toResponseObject());
  }

  // Fixed-window limiter for the static /token branch only — requests this
  // middleware terminates never reach the SDK's own express-rate-limit, so
  // the branch mirrors the SDK token endpoint's posture (50 / 15 min / IP).
  const staticTokenHits = new Map(); // ip -> { count, reset }
  function staticTokenRateLimited(req) {
    const now = Date.now();
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'global';
    let rec = staticTokenHits.get(key);
    if (!rec || now >= rec.reset) {
      rec = { count: 0, reset: now + 15 * 60_000 };
      staticTokenHits.set(key, rec);
    }
    rec.count++;
    if (staticTokenHits.size > 5000) {
      for (const [k, v] of staticTokenHits) if (now >= v.reset) staticTokenHits.delete(k);
    }
    return rec.count > 50;
  }

  // ── static-client gate at /token ──
  // Three jobs, static clients only:
  //   1. client_secret_basic → client_secret_post normalization (the SDK's
  //      clientAuth reads the POST body only; RFC 6749 §2.3.1 requires Basic
  //      support for confidential clients, and the Gemini Enterprise
  //      connector may send either).
  //   2. Timing-safe client_secret verification (crypto.timingSafeEqual via
  //      timingSafeEqualStr). The SDK compares with a plain `!==`
  //      (clientAuth.js:49, SDK v1.29.0) — THIS gate is the load-bearing
  //      check; the SDK's compare only ever runs on already-verified secrets.
  //   3. The opt-in PKCE-less authorization_code grant: honored ONLY after
  //      (2) passed on this very request, ONLY for `allow_no_pkce` static
  //      clients, ONLY for codes that were ISSUED challenge-less. Same
  //      provider.exchangeAuthorizationCode as the SDK path (one-time use,
  //      redirect_uri + RFC 8707 resource checks identical).
  consentRouter.use('/token', express.urlencoded({ extended: false }));
  consentRouter.post('/token', async (req, res, next) => {
    try {
      const body = req.body || {};

      let viaBasic = false;
      const basic = parseBasicAuth(req.headers && req.headers.authorization);
      if (basic && staticClients.has(basic.client_id)) {
        if ((body.client_id && String(body.client_id) !== basic.client_id) || body.client_secret) {
          // RFC 6749 §2.3: a request MUST NOT use more than one auth method.
          return sendOAuthError(res, new InvalidRequestError('multiple client authentication methods'));
        }
        body.client_id = basic.client_id;
        body.client_secret = basic.client_secret;
        req.body = body; // the SDK's body-only clientAuth sees the credentials too
        viaBasic = true;
      }

      const sc = typeof body.client_id === 'string' ? staticClients.get(body.client_id) : undefined;
      if (!sc) return next(); // not a static client — SDK path, untouched

      if (staticTokenRateLimited(req)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(429).json({
          error: 'too_many_requests',
          error_description: 'rate limit exceeded for token requests',
        });
      }

      // Load-bearing, timing-safe secret gate. The message is deliberately
      // distinguishable from the SDK's "Invalid client_secret" so tests can
      // pin WHICH layer rejected.
      if (
        typeof body.client_secret !== 'string' ||
        !timingSafeEqualStr(body.client_secret, sc.client_secret)
      ) {
        if (viaBasic) {
          // RFC 6749 §5.2: header-authenticated failures answer 401 + scheme.
          res.setHeader('WWW-Authenticate', 'Basic realm="termdeck-mcp-bridge"');
          return sendOAuthError(res, new InvalidClientError('invalid client credentials (static gate)'), 401);
        }
        return sendOAuthError(
          res,
          new InvalidClientError(
            body.client_secret
              ? 'invalid client_secret (static gate)'
              : 'client_secret is required (static gate)',
          ),
        );
      }

      if (sc._allowNoPkce && body.grant_type === 'authorization_code' && body.code_verifier == null) {
        if (typeof body.code !== 'string' || !body.code) {
          return sendOAuthError(res, new InvalidRequestError('code is required'));
        }
        if (body.redirect_uri != null && typeof body.redirect_uri !== 'string') {
          return sendOAuthError(res, new InvalidRequestError('redirect_uri must be a string'));
        }
        let resource;
        if (body.resource != null) {
          if (typeof body.resource !== 'string' || !URL.canParse(body.resource)) {
            return sendOAuthError(res, new InvalidRequestError('resource must be a valid URL'));
          }
          resource = new URL(body.resource);
        }
        pruneCodes();
        const rec = codes.get(body.code);
        if (rec && rec.code_challenge) {
          // The code was issued WITH PKCE — its verifier is genuinely
          // required; the SDK is the single rejection authority for that.
          return next();
        }
        // Unknown/expired codes surface invalid_grant from the provider —
        // clearer to a PKCE-less client than the SDK schema's invalid_request.
        const tokens = await provider.exchangeAuthorizationCode(
          sc,
          body.code,
          undefined,
          body.redirect_uri || undefined,
          resource,
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(tokens);
      }

      return next(); // verified static client, standard grant shape → SDK
    } catch (e) {
      if (e instanceof OAuthError) return sendOAuthError(res, e);
      return sendOAuthError(res, new ServerError('Internal Server Error'));
    }
  });

  // ── opt-in PKCE-less /authorize for static clients ──
  // ⚠️ DELIBERATE OAuth 2.1 PKCE RELAXATION — ORCH-approved 2026-06-12 with
  // four binding conditions (Sprint 75 STATUS.md):
  //   (1) allow_no_pkce is operator-config-only; registration payloads are
  //       structurally stripped of it (registerClient) and this intercept
  //       reads ONLY the in-memory static map — a DCR record can never reach it.
  //   (2) honored only for a CONFIDENTIAL client: the code minted here is
  //       worthless without the client_secret, which /token verifies
  //       timing-safely on the same request that redeems the code.
  //   (3) our comparison is crypto.timingSafeEqual (timingSafeEqualStr) — the
  //       SDK's `!==` never gates a static secret.
  //   (4) cross-redemption is closed both ways: a code issued WITH a
  //       challenge defers to the SDK (verifier required), and a
  //       challenge-less code fails any verifier presented against it
  //       (verifyChallenge(v, undefined) === false → invalid_grant).
  // Static clients WITH a code_challenge, and every non-static client, fall
  // through to the SDK's authorize handler (PKCE enforced exactly as before).
  consentRouter.use('/authorize', express.urlencoded({ extended: false }));
  consentRouter.all('/authorize', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') return next();
    const params = (req.method === 'POST' ? req.body : req.query) || {};
    const sc = typeof params.client_id === 'string' ? staticClients.get(params.client_id) : undefined;
    if (!sc || !sc._allowNoPkce || params.code_challenge != null) return next();

    res.setHeader('Cache-Control', 'no-store');

    // Phase 1 (mirrors the SDK): validate redirect_uri BEFORE anything may
    // redirect — errors here are direct responses, never sent to the URI.
    let redirectUri = typeof params.redirect_uri === 'string' ? params.redirect_uri : undefined;
    if (params.redirect_uri != null && redirectUri === undefined) {
      return sendOAuthError(res, new InvalidRequestError('redirect_uri must be a string'));
    }
    if (redirectUri !== undefined) {
      const requested = redirectUri;
      if (!sc.redirect_uris.some((registered) => redirectUriMatches(requested, registered))) {
        return sendOAuthError(res, new InvalidRequestError('Unregistered redirect_uri'));
      }
    } else if (sc.redirect_uris.length === 1) {
      redirectUri = sc.redirect_uris[0];
    } else {
      return sendOAuthError(
        res,
        new InvalidRequestError('redirect_uri must be specified when client has multiple registered URIs'),
      );
    }

    // Phase 2 (mirrors the SDK): remaining errors redirect to the validated URI.
    const stateParam = typeof params.state === 'string' ? params.state : undefined;
    const redirectError = (err) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', err.errorCode);
      u.searchParams.set('error_description', err.message);
      if (stateParam) u.searchParams.set('state', stateParam);
      return res.redirect(302, u.href);
    };
    if (params.state != null && stateParam === undefined) {
      return redirectError(new InvalidRequestError('state must be a string'));
    }
    if (params.response_type !== 'code') {
      return redirectError(new InvalidRequestError('response_type must be "code"'));
    }
    if (params.scope != null && typeof params.scope !== 'string') {
      return redirectError(new InvalidRequestError('scope must be a string'));
    }
    let resource;
    if (params.resource != null) {
      if (typeof params.resource !== 'string' || !URL.canParse(params.resource)) {
        return redirectError(new InvalidRequestError('resource must be a valid URL'));
      }
      resource = new URL(params.resource);
    }
    const scopes = typeof params.scope === 'string' ? params.scope.split(' ').filter(Boolean) : [];
    try {
      await provider.authorize(
        sc,
        { state: stateParam, scopes, redirectUri, codeChallenge: undefined, resource },
        res,
      );
    } catch (e) {
      return redirectError(e instanceof OAuthError ? e : new ServerError('Internal Server Error'));
    }
  });

  consentRouter.use('/oauth/consent', express.urlencoded({ extended: false }));
  consentRouter.post('/oauth/consent', (req, res) => {
    const body = req.body || {};
    let blob;
    try {
      blob = verifyJwt(body.pending, secret);
    } catch {
      return res
        .status(400)
        .send(renderError('Authorization request expired or invalid. Restart the connection from your chat client.'));
    }
    if (blob.kind !== 'pending_auth') {
      return res.status(400).send(renderError('Invalid authorization request.'));
    }
    if (body.action === 'deny') {
      const u = new URL(blob.redirect_uri);
      u.searchParams.set('error', 'access_denied');
      if (blob.state) u.searchParams.set('state', blob.state);
      return res.redirect(302, u.href);
    }
    if (!timingSafeEqualStr(body.operator_secret || '', operatorSecret)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(401).send(
        renderConsent({
          clientLabel: blob.client_id,
          scope: blob.scope,
          pending: body.pending,
          error: 'Incorrect operator secret.',
        }),
      );
    }
    const code = issueCode({
      clientId: blob.client_id,
      redirectUri: blob.redirect_uri,
      codeChallenge: blob.code_challenge,
      scope: blob.scope,
      resource: blob.resource,
    });
    redirectWithCode(res, blob.redirect_uri, code, blob.state);
  });

  return {
    provider,
    consentRouter,
    issuerUrl,
    resourceUrl,
    scopesSupported,
    info: {
      issuer: issuerUrl.href,
      resource: resourceUrl.href,
      scopesSupported,
      accessTtlSec,
      refreshTtlSec,
      autoApprove,
      staticBearerEnabled: !!staticBearer,
      staticClientIds: Array.from(staticClients.keys()), // ids only — never secrets
      ephemeralOperator,
      // server.js prints this once at boot ONLY when ephemeral, so the operator
      // can complete consent. Never logged when operator-set via env/option.
      ephemeralOperatorSecret: ephemeralOperator ? operatorSecret : undefined,
    },
    // exposed for tests / advanced wiring
    _internal: { codes, state, mintAccessToken, signJwt, verifyJwt, secret },
  };
}

module.exports = {
  createBridgeAuth,
  createMemoryStore,
  createFileStore,
  // pure helpers exported for unit tests
  signJwt,
  verifyJwt,
  b64url,
  fromB64url,
  sha256hex,
  normalizeResource,
};
