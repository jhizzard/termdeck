'use strict';

// TermDeck web-chat driver — Sprint 72 (Workstream B).
//
// Aggregates the two lane namespaces consumed by T2's `web-chat-grok` adapter:
//   cdp   (T1) — CDP transport + render bridge. attach() a real headful Chrome via Playwright
//                connectOverCDP; the handle exposes a Playwright `page` (for selectors) AND a
//                `cdp` CDPSession (Page.startScreencast → canvas, Input.dispatch* forwarding).
//   grok  (T3) — Grok selectors + layered completion detection: inject / onComplete / extract.
//
//   const { cdp, grok } = require('@jhizzard/termdeck-web-chat-driver');
//   const handle = await cdp.attach({ userDataDir: 'grok', port: 9333, startUrl: 'https://grok.com' });
//   const final  = await grok.inject(handle, 'a prompt');   // handle.page drives the composer
//   handle.screencast(onFrame);                             // handle.cdp streams the tab
//
// `grok` is required defensively: while the T3 lane is mid-edit a transient require error must not
// take down `cdp` consumers. T2 also keeps a direct `require('./grok')` fallback. See README.md.

const cdp = require('./cdp');

let grok = null;
try {
  grok = require('./grok');
} catch (_) {
  // T3 lane may be mid-edit; cdp stays usable, and grok wires in once ./grok loads cleanly.
  grok = null;
}

module.exports = { cdp, grok };
