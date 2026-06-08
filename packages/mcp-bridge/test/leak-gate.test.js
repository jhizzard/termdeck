'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THE LEAK-GATE (Sprint 71 / T2) — a RELEASE GATE, not just a unit test.
//
// It takes representative SAMPLE OUTPUT for every registered Bridge tool, runs
// it through the exact egress path the server uses (redactDeep), and asserts
// scanDeep() finds nothing secret left. If any planted secret survives, the
// gate FAILS and the release is blocked. This is the executable form of
// PLANNING.md cross-cutting guardrail #2 ("egress redaction on 100% of tool
// output").
//
// Every planted secret is BUILT AT RUNTIME from inert fragments (see the
// `mk*` helpers) so this file is gitleaks-clean while still exercising real
// secret SHAPES. Org-specific literals are supplied the way the operator
// supplies them in production — via the external denylist (here: env-injected
// FIXTURE literals, never a real one).
//
// EXTENSION POINT FOR T3: when the real tools land, append their representative
// `{ tool, sample }` outputs to TOOL_SAMPLES (or have each tool module export a
// `__leakSample` and wire it here). The adversarial fixtures below already
// cover every redaction CLASS, so the gate is meaningful before T3 lands.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert');
const redactMod = require('../src/redact');
const { redactDeep, scanDeep } = redactMod;
const { assertReadOnly, requiresApproval } = require('../src/policy');
// T3's representative PRE-redaction tool outputs (the handoff fixture). Running
// these through the gate makes it cover the REAL output shapes, not just T2's
// adversarial canaries below.
const { samples: T3_SAMPLES } = require('./fixtures/tool-output-samples');

// Hermetic env: never read a real ~/.termdeck/bridge-redact.json, and inject
// FIXTURE org literals exactly as an operator's denylist would provide them.
const FIXTURE_LITERAL = 'ACME-INTERNAL-XYZ';
const FIXTURE_BARE_REF = 'fakeref0123456789demo';
const ENV = {
  TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
  TERMDECK_BRIDGE_REDACT_LITERALS: `${FIXTURE_LITERAL},${FIXTURE_BARE_REF}`,
};

function withEnv(extra, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, extra);
  redactMod._resetCacheForTests();
  try { return fn(); } finally {
    for (const k of Object.keys(extra)) delete process.env[k];
    Object.assign(process.env, saved);
    redactMod._resetCacheForTests();
  }
}

// ── Runtime-built secret canaries (gitleaks-inert source, real shapes) ───────
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mkJwt = () => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ role: 'service_role' })}.${'s'.repeat(24)}`;
const mkAnthropic = () => 'sk-ant-' + 'A1b2C3d4'.repeat(6);
const mkConn = () => `postgres://svc:${'Pw' + '0rdXyz9'}@db.internal:5432/app`;
const mkBearer = () => 'Bearer ' + 'Tk0n' + 'Zx9q'.repeat(8);
const mkKv = () => 'WEBHOOK_SECRET=' + ('Zx9aQ' + '7kP2mNvT4wL');

// Representative output for each registered tool, each seeded with secrets of
// the classes that tool could plausibly surface, plus benign content that MUST
// survive (so we also catch over-redaction).
const TOOL_SAMPLES = [
  {
    tool: 'memory_recall',
    sample: {
      memories: [
        { category: 'decision', text: `use ${mkConn()} for prod` },
        { category: 'reference', text: `service token jwt=${mkJwt()}` },
        { category: 'note', text: 'benign: ship v1.7.0 on Monday' },
      ],
    },
  },
  {
    tool: 'memory_search',
    sample: { hits: [{ score: 0.82, snippet: `rotated service key ${mkAnthropic()}` }] },
  },
  {
    tool: 'list_panels',
    sample: {
      panels: [
        { id: 'worker-1', project: 'termdeck', title: 'codex • sprint-71' },
        { id: 'worker-2', project: 'termdeck', title: `see ${FIXTURE_LITERAL} runbook` },
      ],
    },
  },
  {
    tool: 'read_panel',
    sample: {
      panelId: 'worker-1',
      title: 'codex • sprint-71',
      lines: [
        '$ printenv | grep -i key',
        'ANTHROPIC_API_KEY=' + mkAnthropic(),
        '$ cat ~/.config/db.url',
        mkConn(),
        `curl -H "Authorization: ${mkBearer()}" https://api.internal/v1`,
        `token rotated, see ${FIXTURE_LITERAL} runbook`,
        `project ref ${FIXTURE_BARE_REF}`,
        '$ git log --oneline -1',
        'edf08b3 v1.7.0 Sprint 70', // benign git SHA — MUST survive
      ],
    },
  },
  {
    tool: 'panel_status',
    sample: { id: 'worker-1', status: 'thinking', lastLine: `export ${mkKv()}` },
  },
  {
    tool: 'recent_activity',
    sample: { events: [{ panel: 'worker-2', at: 't0', text: `authorization: ${mkBearer()}` }] },
  },
];

// ── The gate ─────────────────────────────────────────────────────────────────

test('leak-gate: every registered tool sample is clean after egress redaction', () => {
  withEnv(ENV, () => {
    for (const { tool, sample } of TOOL_SAMPLES) {
      const cleaned = redactDeep(sample);
      const result = scanDeep(cleaned);
      assert.ok(
        result.clean,
        `LEAK in "${tool}" output after redaction — surviving: ${JSON.stringify(result.hits)}`,
      );
      // No org literal may survive either.
      const flat = JSON.stringify(cleaned);
      assert.ok(!flat.includes(FIXTURE_LITERAL), `org literal leaked from "${tool}"`);
      assert.ok(!flat.includes(FIXTURE_BARE_REF), `bare project-ref leaked from "${tool}"`);
    }
  });
});

test('leak-gate is non-vacuous: pre-redaction samples DO contain secrets', () => {
  withEnv(ENV, () => {
    // If the redactor became a no-op, these would still be dirty — proving the
    // gate above actually exercises redaction rather than passing trivially.
    for (const tool of ['read_panel', 'memory_search', 'panel_status']) {
      const { sample } = TOOL_SAMPLES.find((t) => t.tool === tool);
      assert.equal(scanDeep(sample).clean, false, `${tool} fixture should be dirty pre-redact`);
    }
  });
});

test('leak-gate: benign content survives redaction (no over-redaction)', () => {
  withEnv(ENV, () => {
    const readPanel = TOOL_SAMPLES.find((t) => t.tool === 'read_panel');
    const cleaned = redactDeep(readPanel.sample);
    const flat = JSON.stringify(cleaned);
    assert.ok(flat.includes('worker-1'), 'panel id preserved');
    assert.ok(flat.includes('edf08b3'), 'benign git SHA preserved');
    assert.ok(flat.includes('codex'), 'benign title preserved');
  });
});

test('leak-gate: every sampled tool is read-only and has a defined approval policy', () => {
  for (const { tool } of TOOL_SAMPLES) {
    assert.equal(assertReadOnly({ name: tool }), true, `${tool} must pass assertReadOnly`);
    assert.equal(typeof requiresApproval(tool), 'boolean', `${tool} must have an approval verdict`);
  }
});

// ── T3 handoff fixtures (the real tool-output shapes) ────────────────────────

// Org literals required by individual fixtures are supplied the way an operator
// supplies them in production — via the external denylist — collected here.
const T3_DENYLIST = T3_SAMPLES.map((s) => s.requiresDenylistLiteral).filter(Boolean);
const T3_ENV = {
  TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
  TERMDECK_BRIDGE_REDACT_LITERALS: T3_DENYLIST.join(','),
};

test('leak-gate: T3 tool-output fixtures are clean after egress redaction', () => {
  withEnv(T3_ENV, () => {
    for (const fx of T3_SAMPLES) {
      const cleaned = redactDeep(fx.sample);
      if (fx.expectClean !== false) {
        const result = scanDeep(cleaned);
        assert.ok(result.clean, `LEAK in T3 fixture "${fx.name}" — surviving: ${JSON.stringify(result.hits)}`);
      }
      if (fx.requiresDenylistLiteral) {
        assert.ok(
          !JSON.stringify(cleaned).includes(fx.requiresDenylistLiteral),
          `org literal leaked from T3 fixture "${fx.name}"`,
        );
      }
      if (fx.expectUnchanged) {
        assert.equal(
          JSON.stringify(cleaned), JSON.stringify(fx.sample),
          `T3 fixture "${fx.name}" must pass through unchanged (no over-redaction)`,
        );
      }
    }
  });
});

test('leak-gate: T3 secret-bearing fixtures are dirty pre-redaction (non-vacuous)', () => {
  // These two carry built-in-shape secrets, so they are dirty even WITHOUT the
  // denylist env — proving the fixture gate exercises real redaction.
  const base = { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json' };
  withEnv(base, () => {
    for (const name of [
      'memory_recall-with-embedded-secrets',
      'read_panel-with-keys-in-terminal-output',
    ]) {
      const fx = T3_SAMPLES.find((s) => s.name === name);
      assert.ok(fx, `expected T3 fixture "${name}" to exist`);
      assert.equal(scanDeep(fx.sample).clean, false, `${name} should be dirty pre-redact`);
    }
  });
});
