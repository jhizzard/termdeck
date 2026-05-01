// Sprint 47 T1 — Tests for the YAML-subset frontmatter parser.
//
// Pins the convention that mixed-agent 4+1 sprints declare per-lane agent in
// a `---`-delimited frontmatter block, while historical sprints (45/46/47)
// without frontmatter still resolve to the Claude adapter. Snapshot tests
// against a real Sprint 45 PLANNING.md AND synthetic mixed-agent fixtures
// keep both directions of the contract honest.
//
// Run: node --test tests/sprint-frontmatter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseFrontmatter, getLaneAgent } = require('../packages/server/src/sprint-frontmatter');
const { AGENT_ADAPTERS } = require('../packages/server/src/agent-adapters');

const REPO_ROOT = path.resolve(__dirname, '..');
const SPRINT_45_PLANNING = path.join(
  REPO_ROOT,
  'docs/sprint-45-multi-agent-adapters/PLANNING.md',
);

function tmpFile(content) {
  const p = path.join(
    os.tmpdir(),
    `sprint-frontmatter-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(p, content);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot 1 — Sprint 45 PLANNING.md (no frontmatter, real on-disk file).
// ─────────────────────────────────────────────────────────────────────────

test('parseFrontmatter — Sprint 45 PLANNING.md returns {} (no frontmatter)', () => {
  assert.deepEqual(parseFrontmatter(SPRINT_45_PLANNING), {});
});

test('getLaneAgent — Sprint 45 PLANNING.md defaults every lane to claude', () => {
  for (const tag of ['T1', 'T2', 'T3', 'T4']) {
    assert.equal(
      getLaneAgent(SPRINT_45_PLANNING, tag),
      AGENT_ADAPTERS.claude,
      `lane ${tag} should default to claude when no frontmatter is present`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Snapshot 2 — synthetic mixed-agent PLANNING.md.
// ─────────────────────────────────────────────────────────────────────────

const MIXED_FRONTMATTER = `---
sprint: 48
lanes:
  - tag: T1
    agent: codex
    project: termdeck
  - tag: T2
    agent: gemini
    project: termdeck
  - tag: T3
    agent: grok
    project: termdeck
  - tag: T4
    agent: claude
    project: termdeck
---

# Sprint 48 — fake mixed dogfood
`;

test('parseFrontmatter — synthetic mixed-agent frontmatter parses correctly', () => {
  const p = tmpFile(MIXED_FRONTMATTER);
  try {
    const result = parseFrontmatter(p);
    assert.equal(result.sprint, 48);
    assert.equal(result.lanes.length, 4);
    assert.deepEqual(result.lanes[0], { tag: 'T1', agent: 'codex', project: 'termdeck' });
    assert.deepEqual(result.lanes[1], { tag: 'T2', agent: 'gemini', project: 'termdeck' });
    assert.deepEqual(result.lanes[2], { tag: 'T3', agent: 'grok', project: 'termdeck' });
    assert.deepEqual(result.lanes[3], { tag: 'T4', agent: 'claude', project: 'termdeck' });
  } finally {
    fs.unlinkSync(p);
  }
});

test('getLaneAgent — synthetic mixed PLANNING.md returns right adapter per lane', () => {
  const p = tmpFile(MIXED_FRONTMATTER);
  try {
    assert.equal(getLaneAgent(p, 'T1'), AGENT_ADAPTERS.codex);
    assert.equal(getLaneAgent(p, 'T2'), AGENT_ADAPTERS.gemini);
    assert.equal(getLaneAgent(p, 'T3'), AGENT_ADAPTERS.grok);
    assert.equal(getLaneAgent(p, 'T4'), AGENT_ADAPTERS.claude);
  } finally {
    fs.unlinkSync(p);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Validation — invalid agent values throw with the valid set named.
// ─────────────────────────────────────────────────────────────────────────

test('parseFrontmatter — invalid agent throws naming valid options', () => {
  const p = tmpFile(`---
sprint: 48
lanes:
  - tag: T1
    agent: gpt5
---
`);
  try {
    assert.throws(
      () => parseFrontmatter(p),
      /invalid agent 'gpt5'.*claude.*codex.*gemini.*grok/,
    );
  } finally {
    fs.unlinkSync(p);
  }
});

test('getLaneAgent — lane without agent field defaults to claude', () => {
  const p = tmpFile(`---
sprint: 48
lanes:
  - tag: T1
    project: termdeck
  - tag: T2
    agent: codex
    project: termdeck
---
`);
  try {
    assert.equal(getLaneAgent(p, 'T1'), AGENT_ADAPTERS.claude);
    assert.equal(getLaneAgent(p, 'T2'), AGENT_ADAPTERS.codex);
  } finally {
    fs.unlinkSync(p);
  }
});

test('getLaneAgent — unknown lane tag defaults to claude', () => {
  const p = tmpFile(`---
sprint: 48
lanes:
  - tag: T1
    agent: codex
---
`);
  try {
    assert.equal(getLaneAgent(p, 'T99'), AGENT_ADAPTERS.claude);
  } finally {
    fs.unlinkSync(p);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Error reporting — unclosed block, unclosed quote, tab indent.
// ─────────────────────────────────────────────────────────────────────────

test('parseFrontmatter — unclosed frontmatter block throws', () => {
  const p = tmpFile(`---
sprint: 48
`);
  try {
    assert.throws(() => parseFrontmatter(p), /unclosed frontmatter/);
  } finally {
    fs.unlinkSync(p);
  }
});

test('parseFrontmatter — unclosed quoted scalar throws with line number', () => {
  const p = tmpFile(`---
sprint: 48
lanes:
  - tag: "T1
    agent: codex
---
`);
  try {
    assert.throws(() => parseFrontmatter(p), /unclosed quote/);
  } finally {
    fs.unlinkSync(p);
  }
});

test('parseFrontmatter — tab indentation throws', () => {
  const p = tmpFile('---\nsprint: 48\nlanes:\n\t- tag: T1\n---\n');
  try {
    assert.throws(() => parseFrontmatter(p), /tab indentation/);
  } finally {
    fs.unlinkSync(p);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Misc — empty frontmatter, scalar coercion, comments, exports.
// ─────────────────────────────────────────────────────────────────────────

test('parseFrontmatter — empty frontmatter block returns {}', () => {
  const p = tmpFile(`---
---
# rest of doc
`);
  try {
    assert.deepEqual(parseFrontmatter(p), {});
  } finally {
    fs.unlinkSync(p);
  }
});

test('parseFrontmatter — quoted string scalars are unwrapped', () => {
  const p = tmpFile(`---
title: "Mixed 4+1: experimental"
lanes:
  - tag: T1
    agent: codex
---
`);
  try {
    const r = parseFrontmatter(p);
    assert.equal(r.title, 'Mixed 4+1: experimental');
  } finally {
    fs.unlinkSync(p);
  }
});

test('parseFrontmatter — integer scalar parses to number type', () => {
  const p = tmpFile(`---
sprint: 48
---
`);
  try {
    const r = parseFrontmatter(p);
    assert.strictEqual(r.sprint, 48);
    assert.strictEqual(typeof r.sprint, 'number');
  } finally {
    fs.unlinkSync(p);
  }
});

test('parseFrontmatter — comments and blank lines are skipped inside frontmatter', () => {
  const p = tmpFile(`---
# top-level comment
sprint: 48

lanes:
  - tag: T1
    agent: codex

  - tag: T2
    agent: gemini
---
`);
  try {
    const r = parseFrontmatter(p);
    assert.equal(r.lanes.length, 2);
    assert.equal(r.lanes[0].agent, 'codex');
    assert.equal(r.lanes[1].agent, 'gemini');
  } finally {
    fs.unlinkSync(p);
  }
});

test('parseFrontmatter and getLaneAgent are both exported as functions', () => {
  assert.equal(typeof parseFrontmatter, 'function');
  assert.equal(typeof getLaneAgent, 'function');
});
