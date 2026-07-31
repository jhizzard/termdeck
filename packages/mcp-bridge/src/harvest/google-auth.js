'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Google service-account auth — dependency-free (Sprint 84 / T1).
//
// WHY NOT `googleapis`. The Sheets intake ramp needs exactly two API calls
// (values.get, values.batchUpdate). The official client would add a large
// transitive tree to a process whose entire security story is "supply-chain-
// inert, Node built-ins only" (cf. policy.js / redact.js / clients/http.js).
// The two-legged service-account flow is small enough to own outright:
//
//   RS256-sign a JWT asserting {iss: <sa email>, scope, aud: token endpoint}
//     → POST it to oauth2.googleapis.com/token as a jwt-bearer grant
//     → get a ~1h access token
//
// `crypto.createSign('RSA-SHA256')` is the whole crypto dependency.
//
// SECRET HYGIENE. The private key and the signed assertion never appear in a
// thrown message, a log line, or a returned value. Errors name the ENV VAR that
// is missing/mis-shaped, never its content — same discipline as the propose
// channel's "name the rule class, never the matched text".
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');
const fs = require('node:fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Read AND write: the harvester stamps forwarded_at back into the sheet, so the
// read-only `spreadsheets.readonly` scope is insufficient by design.
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const JWT_LIFETIME_SEC = 3600; // Google's maximum for a jwt-bearer assertion
const TOKEN_SKEW_MS = 60_000; // refresh a minute early rather than race expiry

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// A PEM that has travelled through an env var (or a .env file) arrives with
// literal backslash-n instead of newlines. Repair that, but leave a real
// multi-line PEM untouched.
function normalizePrivateKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return s.includes('\\n') ? s.replace(/\\n/g, '\n') : s;
}

// loadServiceAccount(env, { readFileSync? }) → { clientEmail, privateKey }.
// Sources, file first then env (env wins on conflict — the same "file is the
// config, env is the override" convention as policy.js::loadProposeMap):
//   - JSON at TERMDECK_SHEETS_SA_KEY_FILE, else GOOGLE_APPLICATION_CREDENTIALS
//       (the standard { client_email, private_key, ... } service-account file)
//   - TERMDECK_SHEETS_SA_EMAIL + TERMDECK_SHEETS_SA_PRIVATE_KEY
// Throws a friendly, credential-free error when unconfigured.
function loadServiceAccount(env = process.env, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  let clientEmail = '';
  let privateKey = '';

  const file = env.TERMDECK_SHEETS_SA_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (file) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // Name the path and the failure class only — a partially-parsed key file
      // must never have its content folded into an error string.
      const why = err && err.code ? err.code : 'not valid JSON';
      throw new Error(`service-account key file could not be read (${file}): ${why}`);
    }
    clientEmail = String(parsed.client_email || '').trim();
    privateKey = normalizePrivateKey(parsed.private_key);
  }
  if (env.TERMDECK_SHEETS_SA_EMAIL) clientEmail = String(env.TERMDECK_SHEETS_SA_EMAIL).trim();
  if (env.TERMDECK_SHEETS_SA_PRIVATE_KEY) privateKey = normalizePrivateKey(env.TERMDECK_SHEETS_SA_PRIVATE_KEY);

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Google service-account credentials are not configured. Set TERMDECK_SHEETS_SA_KEY_FILE '
      + '(path to the service-account JSON) — or TERMDECK_SHEETS_SA_EMAIL together with '
      + 'TERMDECK_SHEETS_SA_PRIVATE_KEY. See docs/SHEETS-INTAKE.md § Activation.',
    );
  }
  if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(privateKey)) {
    throw new Error(
      'the configured service-account private key is not a PEM block (expected a '
      + '"-----BEGIN PRIVATE KEY-----" header). Check TERMDECK_SHEETS_SA_PRIVATE_KEY '
      + 'escaping — literal \\n sequences are unescaped for you, but the header must survive.',
    );
  }
  return { clientEmail, privateKey };
}

// signAssertion(...) → { assertion, claims }. Exported so the tests can pin the
// exact claim set Google will see without ever performing a network call.
function signAssertion({
  clientEmail, privateKey, scope = SHEETS_SCOPE, audience = TOKEN_URL,
  nowMs = Date.now(), lifetimeSec = JWT_LIFETIME_SEC,
} = {}) {
  const iat = Math.floor(nowMs / 1000);
  const claims = { iss: clientEmail, scope, aud: audience, iat, exp: iat + lifetimeSec };
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return { assertion: `${signingInput}.${b64url(signer.sign(privateKey))}`, claims };
}

// createAccessTokenProvider({ env?, fetchImpl?, now?, timeoutMs?, credentials? })
//   → { getToken({ force? }) → Promise<string> }
// Caches the token until TOKEN_SKEW_MS before its expiry. Credentials are
// loaded lazily on first use, so constructing the provider on an unconfigured
// box is harmless — the friendly error surfaces at the first real call.
function createAccessTokenProvider(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const timeoutMs = opts.timeoutMs || 8000;
  const tokenUrl = opts.tokenUrl || TOKEN_URL;
  const scope = opts.scope || SHEETS_SCOPE;

  let creds = opts.credentials || null;
  let cached = null; // { token, expiresAtMs }

  async function exchange(assertion) {
    const f = opts.fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('global fetch unavailable — Node >= 20 required (or pass fetchImpl)');
    }
    // Hand-rolled rather than via clients/http.js::requestJson: the token
    // endpoint takes form-encoding, and requestJson JSON-encodes every body.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await f(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal: ac.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error(`Google token exchange timed out after ${timeoutMs}ms`);
      throw new Error(`Google token exchange failed: ${err && err.message ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!res.ok) {
      // Google's error body is { error, error_description } and never contains
      // the assertion; relay it verbatim so a clock-skew or not-shared-with-the-
      // service-account failure is diagnosable without a debugger.
      const reason = json && (json.error_description || json.error)
        ? `${json.error || 'error'}: ${json.error_description || ''}`.trim()
        : (text ? text.slice(0, 200) : '');
      const e = new Error(`Google token exchange rejected (HTTP ${res.status})${reason ? ` — ${reason}` : ''}`);
      e.status = res.status;
      throw e;
    }
    if (!json || !json.access_token) throw new Error('Google token endpoint returned no access_token');
    return {
      token: String(json.access_token),
      expiresInSec: Number.isFinite(Number(json.expires_in)) ? Number(json.expires_in) : JWT_LIFETIME_SEC,
    };
  }

  async function getToken({ force = false } = {}) {
    const t = now();
    if (!force && cached && cached.expiresAtMs - TOKEN_SKEW_MS > t) return cached.token;
    if (!creds) creds = loadServiceAccount(env, opts);
    const { assertion } = signAssertion({ ...creds, scope, audience: tokenUrl, nowMs: t });
    const { token, expiresInSec } = await exchange(assertion);
    cached = { token, expiresAtMs: t + expiresInSec * 1000 };
    return token;
  }

  return { getToken, _peek: () => cached };
}

module.exports = {
  createAccessTokenProvider,
  loadServiceAccount,
  signAssertion,
  normalizePrivateKey,
  b64url,
  TOKEN_URL,
  SHEETS_SCOPE,
  TOKEN_SKEW_MS,
  JWT_LIFETIME_SEC,
};
