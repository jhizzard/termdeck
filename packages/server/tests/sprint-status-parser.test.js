const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseStatusMd } = require('../src/sprints/status-parser');

test('parseStatusMd returns empty structure if file missing', () => {
  const result = parseStatusMd('/non/existent/file.md');
  assert.deepEqual(result, {
    lanes: {},
    open_red_count: 0,
    last_orchestrator_post: null,
    last_final_verdict: null
  });
});

test('parseStatusMd parses realistic STATUS.md fixture', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-test-'));
  const statusPath = path.join(tmpDir, 'STATUS.md');
  const content = `
# Sprint 2 — STATUS

### [ORCH] STATUS 2026-05-19 18:00 ET — Sprint started.

### [T1] FINDING 2026-05-19 18:10 ET — found some stuff
### [T1] LANDED 2026-05-19 18:20 ET — first landing

### [T4-CODEX] AUDIT-RED 2026-05-19 18:30 ET — T1 has a bug in intake_service.py
### [T4-CODEX] AUDIT-RED 2026-05-19 18:30 ET — T2 is missing something

### [T1] LANDED 2026-05-19 18:40 ET — fix for T4 RED

### [T4-CODEX] FINAL-VERDICT 2026-05-19 19:00 ET — Pending T2 fix
`;
  fs.writeFileSync(statusPath, content);

  const result = parseStatusMd(statusPath);

  assert.equal(result.open_red_count, 1);
  assert.equal(result.lanes['T1'].landed_since_last_red, true);
  assert.equal(result.lanes['T2'].landed_since_last_red, false);
  assert.equal(result.lanes['T1'].open_reds_against_me.length, 0);
  assert.equal(result.lanes['T2'].open_reds_against_me.length, 1);
  assert.equal(result.last_orchestrator_post, 'Sprint started.');
  assert.equal(result.last_final_verdict.verb, 'FINAL-VERDICT');
  assert.deepEqual(result.last_final_verdict.lanes_with_open_defects, ['T2']);

  fs.rmSync(tmpDir, { recursive: true });
});

test('parseStatusMd handles complex lane tags like T4-CODEX-AUDITOR', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-test-'));
  const statusPath = path.join(tmpDir, 'STATUS.md');
  const content = `
### [T4-CODEX-AUDITOR] CHECKPOINT 2026-05-20 10:00 ET — working hard
`;
  fs.writeFileSync(statusPath, content);

  const result = parseStatusMd(statusPath);
  assert.ok(result.lanes['T4-CODEX-AUDITOR']);
  assert.equal(result.lanes['T4-CODEX-AUDITOR'].last_post.verb, 'CHECKPOINT');

  fs.rmSync(tmpDir, { recursive: true });
});

test('parseStatusMd with real Maestro Sprint 2 fixture', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sprint2-status.md');
  if (!fs.existsSync(fixturePath)) {
    // Skip if fixture failed to copy
    return;
  }

  const result = parseStatusMd(fixturePath);
  
  // T1, T2, T3 should be present
  assert.ok(result.lanes['T1']);
  assert.ok(result.lanes['T2']);
  assert.ok(result.lanes['T3']);
  
  // T4-CODEX should be present as it has posts
  assert.ok(result.lanes['T4-CODEX']);
  
  // In Maestro Sprint 2, T4-CODEX had a FINAL-VERDICT
  assert.ok(result.last_final_verdict);
  
  // Verify counts/logic
  // T1 had an AUDIT-RED at 18:41 and LANDED at 19:48
  // T3 had an AUDIT-RED at 18:55 and LANDED at 20:01
  assert.equal(result.lanes['T1'].landed_since_last_red, true);
  assert.equal(result.lanes['T3'].landed_since_last_red, true);
});
