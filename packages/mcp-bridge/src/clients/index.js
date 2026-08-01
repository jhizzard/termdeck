'use strict';

// Convenience factory: build both read-only data clients from one config bag.
// T1's server bootstrap calls this once and injects the result into buildTools().
//
// Accepts a FLAT config (T1's requested shape) plus shared/per-client overrides:
//   createClients({
//     mnestraWebhookUrl,            // → Mnestra webhook (default env MNESTRA_WEBHOOK_URL
//                                   //   → http://localhost:37778/mnestra)
//     termdeckApiBase,             // (alias: termdeckBaseUrl) → TermDeck HTTP API
//                                   //   (default: env TERMDECK_API_BASE / TERMDECK_BASE_URL,
//                                   //    else AUTO-RESOLVED — ~/.termdeck/ports.json state
//                                   //    file, then port probe; see clients/termdeck-base.js)
//     env, fetchImpl,              // shared (testing / custom transport)
//     mnestra: {...}, termdeck: {...}, // optional per-client opt overrides
//   })
// Called with no args, both clients fall back to env, then (termdeck) live
// auto-resolution / (mnestra) the hardcoded localhost default — so
// `createClients()` is a valid zero-config call.

const { createTermdeckClient, DEFAULT_TERMDECK_BASE } = require('./termdeck');
const { createMnestraClient, DEFAULT_MNESTRA_WEBHOOK } = require('./mnestra');

function createClients(config = {}) {
  const { env, fetchImpl } = config;
  const termdeckBaseUrl = config.termdeckBaseUrl || config.termdeckApiBase;
  const { mnestraWebhookUrl } = config;
  return {
    termdeck: createTermdeckClient({ env, fetchImpl, baseUrl: termdeckBaseUrl, ...(config.termdeck || {}) }),
    mnestra: createMnestraClient({ env, fetchImpl, webhookUrl: mnestraWebhookUrl, ...(config.mnestra || {}) }),
  };
}

module.exports = {
  createClients,
  createTermdeckClient,
  createMnestraClient,
  DEFAULT_TERMDECK_BASE,
  DEFAULT_MNESTRA_WEBHOOK,
};
