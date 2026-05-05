'use strict';

// Sprint 57 T2 (F-T2-2 + F-T2-6) — unit test for the RAG mode derivation
// helper. ORCH GREEN-LIGHT 2026-05-05 14:16 ET specified four input fixtures
// covering the truth table: (off-intent), (pending-intent-no-supabase),
// (pending-intent-supabase-but-disabled), (active). The intent is to lock
// the enum contract at /api/config + /api/rag/status + /api/status against
// regression — every consumer (dashboard, CLI, MCP wrapper, CI smoke tests,
// future Telegram bot) reads `ragMode` and the contract must not drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveRagMode } = require('../packages/server/src/rag-mode');

test('deriveRagMode returns "off" when intent is false (MCP-only)', () => {
  // off-intent: user has turned RAG off in config.yaml. Effective is also
  // false. Supabase config status doesn't matter — user opted out.
  assert.equal(
    deriveRagMode({ enabled: false }, { rag: { enabled: false } }),
    'off',
  );
  assert.equal(
    deriveRagMode({ enabled: false }, { rag: { enabled: false, supabaseUrl: 'https://x', supabaseKey: 'k' } }),
    'off',
    'Supabase configured but intent=false should still return off',
  );
});

test('deriveRagMode returns "pending" when intent=true but Supabase missing', () => {
  // pending-intent-no-supabase: user enabled RAG in config.yaml but Supabase
  // creds are absent so the runtime never connected. Effective stays false.
  assert.equal(
    deriveRagMode({ enabled: false }, { rag: { enabled: true } }),
    'pending',
  );
});

test('deriveRagMode returns "pending" when intent=true + Supabase configured but rag.enabled is still false', () => {
  // pending-intent-supabase-but-disabled: this is the in-flight transition
  // window — user toggled RAG on, Supabase creds are present, but rag has
  // not yet flipped its `enabled` state (e.g. boot ordering, slow Supabase
  // probe, or a broken connection). The dashboard surfaces "pending" so the
  // operator knows the toggle is on but the runtime isn't serving.
  assert.equal(
    deriveRagMode(
      { enabled: false },
      { rag: { enabled: true, supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' } },
    ),
    'pending',
  );
});

test('deriveRagMode returns "active" when rag.enabled is true', () => {
  // active: runtime confirms RAG is operational. Mnestra hybrid search +
  // flashback are working. Intent is necessarily true at this point (rag
  // wouldn't be effective without intent), but the helper trusts the
  // effective signal directly — defense against partial-state bugs where
  // intent could lag behind effective.
  assert.equal(
    deriveRagMode(
      { enabled: true },
      { rag: { enabled: true, supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k' } },
    ),
    'active',
  );
});

test('deriveRagMode handles null/undefined inputs gracefully', () => {
  // Defensive: server start-up may briefly have null rag/config during
  // initialization; helper must never throw, just return "off".
  assert.equal(deriveRagMode(null, null), 'off');
  assert.equal(deriveRagMode(undefined, undefined), 'off');
  assert.equal(deriveRagMode({}, {}), 'off');
  assert.equal(deriveRagMode({ enabled: undefined }, { rag: undefined }), 'off');
});

test('deriveRagMode "active" wins even when intent flag is missing (effective is the truth)', () => {
  // Edge case: somehow effective=true but config.rag.enabled is missing or
  // false (e.g. config reload race). The runtime is serving — return
  // "active" rather than fabricating a "pending" state from stale config.
  assert.equal(
    deriveRagMode({ enabled: true }, { rag: { enabled: false } }),
    'active',
  );
  assert.equal(
    deriveRagMode({ enabled: true }, {}),
    'active',
  );
});
