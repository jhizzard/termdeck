'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sample PRE-redaction tool outputs for T2's leak-gate (test/leak-gate.test.js).
//
// Each `sample` is what a tool handler returns BEFORE withEgressRedaction runs.
// The planted secrets are FAKE but match real formats so redact.js's built-in
// rules fire on them.
//
// gitleaks-safe: every fake secret is ASSEMBLED FROM FRAGMENTS at module load
// (see `frag`), so no complete secret literal sits in the source text — the
// gitleaks pre-commit/pre-push scanner has nothing to match, while the assembled
// VALUE still trips redact.js. (Same technique the T4 auditor used for its
// `"sk-ant-" + "a".repeat(40)` probe; it fixes the JWT-fixture finding T4 raised
// against the redaction suite.)
//
// The org-literal case uses a clearly-FAKE placeholder — NEVER a real internal
// literal. T2 proves the external-denylist path by injecting the placeholder via
// env, exactly as test/redact.test.js already does for its fake literal.
//
// Leak-gate contract (suggested for T2): for each sample, redactDeep(sample),
// then scan() every string in the result and assert clean === true. The benign
// sample additionally asserts the output is UNCHANGED (no over-redaction).
// ─────────────────────────────────────────────────────────────────────────────

const frag = (...parts) => parts.join('');

const FAKE = {
  // Assembled at runtime; no whole-secret literal appears in source.
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', frag('FAKEsig', 'FAKEsig', 'FAKEsig')].join('.'),
  anthropic: ['sk', 'ant', 'api03', 'F'.repeat(40)].join('-'),
  xai: ['xai', 'F'.repeat(30)].join('-'),
  openai: ['sk', 'F'.repeat(30)].join('-'),
  supabaseUrl: frag('https://', 'abcdefghijklmnopqrst', '.supabase.co'),
  bearer: frag('Bearer ', 'abcdef', 'ABCDEF', '0123456789', 'abcdefABCDEF'),
  // Placeholder for an operator's internal org literal (real literal lives ONLY
  // in the external denylist). Fragmented for symmetry; not a secret pattern.
  orgLiteralPlaceholder: frag('FAKE-ORG', '-LITERAL', '-DO-NOT-SHIP'),
};

const samples = [
  {
    name: 'memory_recall-with-embedded-secrets',
    note: 'A recalled memory whose content embedded a JWT + an Anthropic key + a Supabase URL.',
    expectClean: true,
    sample: {
      content: [{ type: 'text', text:
        '2 memories for "deploy keys":\n'
        + `1. [decision · termdeck · sim 0.91 · 2026-05-01] We rotated the service token ${FAKE.jwt} and the Anthropic key ${FAKE.anthropic}.\n`
        + `2. [reference · termdeck] Supabase project at ${FAKE.supabaseUrl}; call with ${FAKE.bearer}.` }],
      structuredContent: {
        total: 2,
        memories: [
          { content: `We rotated the service token ${FAKE.jwt} and the Anthropic key ${FAKE.anthropic}.`, source_type: 'decision', project: 'termdeck', similarity: 0.91, created_at: '2026-05-01' },
          { content: `Supabase project at ${FAKE.supabaseUrl}; call with ${FAKE.bearer}.`, source_type: 'reference', project: 'termdeck', similarity: 0.7, created_at: '2026-04-20' },
        ],
      },
    },
  },
  {
    name: 'read_panel-with-keys-in-terminal-output',
    note: 'A terminal output slice that printed an xAI key, a bearer header, and an OpenAI key.',
    expectClean: true,
    sample: {
      content: [{ type: 'text', text:
        'Panel T4-codex (termdeck) — active, last activity 2026-06-08T16:50:00Z\n\n'
        + `$ export XAI_API_KEY=${FAKE.xai}\n`
        + `$ curl -H "authorization: ${FAKE.bearer}" https://api.example.com\n`
        + `$ echo $OPENAI_API_KEY -> ${FAKE.openai}` }],
      structuredContent: {
        id: 'sess-123', label: 'T4-codex', project: 'termdeck', status: 'active', bytes: 180, truncated: false,
        content: `$ export XAI_API_KEY=${FAKE.xai}\n$ curl -H "authorization: ${FAKE.bearer}" ...\n$ echo $OPENAI_API_KEY -> ${FAKE.openai}`,
      },
    },
  },
  {
    name: 'org-literal-denylist-case',
    note: 'External-denylist path: set TERMDECK_BRIDGE_REDACT_LITERALS to the placeholder and assert it is scrubbed. NEVER hardcode a real internal literal here.',
    expectClean: true,
    requiresDenylistLiteral: FAKE.orgLiteralPlaceholder,
    sample: {
      content: [{ type: 'text', text: `Recalled: the daily-driver project (${FAKE.orgLiteralPlaceholder}) holds the vectors.` }],
      structuredContent: { memories: [{ content: `the daily-driver project (${FAKE.orgLiteralPlaceholder}) holds the vectors.`, source_type: 'reference', project: 'termdeck' }] },
    },
  },
  {
    name: 'recent_activity-benign-metadata',
    note: 'Metadata-only output — nothing to redact; proves benign passthrough is preserved (no over-redaction).',
    expectClean: true,
    expectUnchanged: true,
    sample: {
      content: [{ type: 'text', text:
        '2 panels active in the last 60m:\n'
        + '• T1-transport — termdeck · 14 updates · last 2026-06-08T16:51:00Z\n'
        + '• T3-tools — termdeck · 9 updates · last 2026-06-08T16:49:00Z' }],
      structuredContent: {
        sinceMinutes: 60, count: 2,
        panels: [
          { id: 'sess-a', label: 'T1-transport', project: 'termdeck', role: 'worker', chunk_count: 14, last_activity: '2026-06-08T16:51:00Z' },
          { id: 'sess-b', label: 'T3-tools', project: 'termdeck', role: 'worker', chunk_count: 9, last_activity: '2026-06-08T16:49:00Z' },
        ],
      },
    },
  },
];

module.exports = { samples, FAKE_SECRETS: FAKE };
