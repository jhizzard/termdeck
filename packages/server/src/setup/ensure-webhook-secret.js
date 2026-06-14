'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent provisioning of the Mnestra webhook shared secret.
//
// mnestra ≥ 0.7.0 fail-CLOSES the :37778 webhook: every op except /healthz is
// rejected 401 unless the caller presents MNESTRA_WEBHOOK_SECRET (the server
// reads it from env, else ~/.termdeck/secrets.env). For the gate to be a no-op
// for legitimate local callers — the MCP bridge (web-chat connectors) and the
// in-app recall path — the SAME secret has to be resolvable by all three
// processes. They all source ~/.termdeck/secrets.env into their env at launch,
// so persisting one value there is sufficient.
//
// This generates ONE secret and writes it (merge-aware via dotenv-io, so every
// other key is preserved) the first time it's missing, then leaves it alone.
//
//   NEVER regenerate an existing secret. A running `mnestra serve` loaded the
//   prior value at boot; rotating it underneath would 401 every caller until
//   the webhook restarts. Rotation, if ever wanted, is a deliberate operator
//   step (edit secrets.env + restart the webhook + the callers together), not
//   an automatic side effect of starting the stack.
//
// Fail-soft: any error (unwritable dir, fs failure) logs once and returns
// { generated:false, secret:null } — provisioning must never abort a stack
// launch. The webhook's own fail-closed default still holds if the secret never
// lands; the only consequence is the gate stays dormant, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const dotenv = require('./dotenv-io');

const KEY = 'MNESTRA_WEBHOOK_SECRET';
const DEFAULT_SECRETS_PATH = path.join(os.homedir(), '.termdeck', 'secrets.env');

// Returns { generated, secret, path, error? }. `generated` is true only when a
// fresh secret was written this call. When the secret already exists (or is
// freshly written), process.env[KEY] is populated so the current process and
// any children it spawns inherit the same value without a reload.
function ensureWebhookSecret(secretsPath = DEFAULT_SECRETS_PATH, _deps = {}) {
  const _dotenv = _deps.dotenv || dotenv;
  const _crypto = _deps.crypto || crypto;
  try {
    const existing = _dotenv.readSecrets(secretsPath) || {};
    const current = existing[KEY];
    if (current && String(current).trim()) {
      if (!process.env[KEY]) process.env[KEY] = String(current);
      return { generated: false, secret: String(current), path: secretsPath };
    }
    // 32 bytes → 64 hex chars. Hex (not base64url) keeps it free of `=`/`+`/`/`
    // so it round-trips through secrets.env / shell `set -a` sourcing untouched.
    const secret = _crypto.randomBytes(32).toString('hex');
    _dotenv.writeSecrets({ [KEY]: secret }, secretsPath);
    process.env[KEY] = secret;
    return { generated: true, secret, path: secretsPath };
  } catch (err) {
    const reason = (err && err.message) || err;
    try {
      console.error(`[ensure-webhook-secret] could not provision ${KEY} in ${secretsPath}: ${reason} — the webhook gate will stay dormant (fail-closed) until set manually.`);
    } catch (_) { /* never throw out of a launch path */ }
    return { generated: false, secret: null, path: secretsPath, error: String((err && err.message) || err) };
  }
}

module.exports = { ensureWebhookSecret, MNESTRA_WEBHOOK_SECRET_KEY: KEY };
