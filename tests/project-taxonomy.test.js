// Sprint 41 T1 — pins the personal session-end hook's PROJECT_MAP taxonomy.
//
// The hook lives at ~/.claude/hooks/memory-session-end.js (out-of-repo, Joshua's
// personal harness file).  It writes one memory_items row per Claude Code
// session close, tagged with the project derived from cwd via PROJECT_MAP.
//
// Sprint 41 fixed the chopin-nashville junk-drawer bug by replacing the flat
// PROJECT_MAP with a most-specific-first ordered list.  This test pins that
// ordering: regression here means Joshua's hook stamped a session under the
// wrong tag and re-polluted the corpus.
//
// CI-safe: skips with a clear log line if the hook isn't installed.  Brad's
// machines will not have ~/.claude/hooks/memory-session-end.js — the bundled
// stack-installer hook is a different file at packages/stack-installer/assets/.
//
// Run: node --test tests/project-taxonomy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js');
const HOOK_INSTALLED = fs.existsSync(HOOK_PATH);

if (!HOOK_INSTALLED) {
  test('personal hook not installed — skipping taxonomy regression suite', () => {
    console.log(`[skip] ${HOOK_PATH} not present; this test only runs on Joshua's machine.`);
  });
} else {
  const { detectProject, PROJECT_MAP } = require(HOOK_PATH);

  test('hook exports detectProject and PROJECT_MAP', () => {
    assert.equal(typeof detectProject, 'function');
    assert.ok(Array.isArray(PROJECT_MAP), 'PROJECT_MAP must be an array');
    assert.ok(PROJECT_MAP.length > 0, 'PROJECT_MAP must have at least one entry');
    for (const entry of PROJECT_MAP) {
      assert.ok(entry.pattern instanceof RegExp, 'each entry must have a regex pattern');
      assert.equal(typeof entry.project, 'string', 'each entry must have a project string');
    }
  });

  // Canonical taxonomy assertions.  Each row pins one cwd → tag mapping that
  // Sprint 41 promised to deliver in T1-project-taxonomy.md.  Keep this list
  // in sync with docs/PROJECT-TAXONOMY.md.
  const cases = [
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck',
      expected: 'termdeck',
      reason: 'TermDeck monorepo — must NOT fall through to chopin-nashville catch-all',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server',
      expected: 'termdeck',
      reason: 'deeper paths inside termdeck still resolve to termdeck',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/engram',
      expected: 'mnestra',
      reason: 'engram folder kept its on-disk name after the Mnestra rename',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/engram/migrations',
      expected: 'mnestra',
      reason: 'subdirectories of engram resolve to mnestra',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/rumen',
      expected: 'rumen',
      reason: 'rumen async learning loop',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/rag-system',
      expected: 'rag-system',
      reason: 'private rag-system repo',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium',
      expected: 'podium',
      reason: 'Podium app for Chopin in Bohemia 2026 — must NOT fall through to chopin-in-bohemia or chopin-nashville',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia',
      expected: 'chopin-in-bohemia',
      reason: 'festival project itself, NOT podium and NOT chopin-nashville',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SchedulingApp',
      expected: 'chopin-scheduler',
      reason: 'SchedulingApp (top-level) = chopin-scheduler tag (a.k.a. Maestro)',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/SchedulingApp',
      expected: 'chopin-scheduler',
      reason: 'SchedulingApp (SideHustles location) — same tag, different on-disk path',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/PVB/pvb',
      expected: 'pvb',
      reason: 'PVB monorepo',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Unagi/gorgias-ticket-monitor',
      expected: 'claimguard',
      reason: 'ClaimGuard-AI lives in Unagi org dir',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/ClaimGuard',
      expected: 'claimguard',
      reason: 'alternate ClaimGuard location if Joshua moves the project',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/DOR',
      expected: 'dor',
      reason: 'DOR project',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/joshuaizzard-dev',
      expected: 'portfolio',
      reason: 'portfolio site',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/imessage-reader',
      expected: 'imessage-reader',
      reason: 'iMessage reader project',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/Performances',
      expected: 'chopin-nashville',
      reason: 'legitimate competition-management work — Performances dir',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/Sponsors',
      expected: 'chopin-nashville',
      reason: 'legitimate competition-management work — Sponsors dir',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/Jury',
      expected: 'chopin-nashville',
      reason: 'legitimate competition-management work — Jury dir',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2025Competition',
      expected: 'chopin-nashville',
      reason: 'year folder for the 2025 competition — legitimate work',
    },
    {
      cwd: '/Users/joshuaizzard/Documents/Random/some/path',
      expected: 'global',
      reason: 'paths that match no specific pattern fall through to global',
    },
    {
      cwd: '/tmp/scratch',
      expected: 'global',
      reason: 'ad-hoc shell sessions in random dirs → global',
    },
  ];

  for (const { cwd, expected, reason } of cases) {
    test(`${cwd} → ${expected}  (${reason})`, () => {
      assert.equal(detectProject(cwd), expected);
    });
  }

  test('detectProject returns "global" for empty cwd', () => {
    assert.equal(detectProject(''), 'global');
  });

  // Structural invariant: the chopin-nashville catch-all MUST be the last
  // ChopinNashville-matching pattern in PROJECT_MAP, otherwise a future edit
  // could re-introduce the junk-drawer bug.
  test('chopin-nashville catch-all is the LAST entry that matches /ChopinNashville/', () => {
    const matchIndices = PROJECT_MAP
      .map((entry, i) => entry.pattern.test('/x/ChopinNashville/x') ? i : -1)
      .filter((i) => i !== -1);
    assert.ok(matchIndices.length > 0, 'at least one entry must match a ChopinNashville cwd');
    const lastIndex = matchIndices[matchIndices.length - 1];
    assert.equal(
      PROJECT_MAP[lastIndex].project,
      'chopin-nashville',
      'the LAST ChopinNashville-matching entry must resolve to chopin-nashville (the catch-all)',
    );
  });
}
