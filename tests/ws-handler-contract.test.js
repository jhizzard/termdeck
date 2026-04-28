// Sprint 40 T1 — WS handler contract smoke test.
//
// Background (Sprint 39 forensics):
//   For ~9 days (~Sprint 26 close 2026-04-18 → 2026-04-27 Sprint 39 close)
//   Joshua's Flashback toast was silent in his daily flow because
//   packages/client/public/app.js had no `case 'proactive_memory':` branch
//   in either of its two `ws.onmessage` switches. The server-side WS push
//   was working correctly end-to-end; every emitted frame went into the
//   void. The fallback path (status_broadcast polling for
//   meta.status === 'errored') only catches the ~10–50 ms errored window
//   inside a 2000 ms broadcast cycle (~2.5 % hit rate), so the client
//   transitioned active → idle without ever invoking
//   triggerProactiveMemoryQuery. Sprint 39 T4's diagnostic surfaced the
//   gap; the orchestrator-applied 3-line fix (× 2 sites) closed the
//   loop. THIS test exists so the next instance of "server emits a new
//   message type but the client switch hasn't been updated" surfaces as a
//   test failure on next CI run, not 9 days of user-visible silence.
//
// Method:
//   - Recursively scan packages/server/src/ for every emitted WS message
//     type. We look for `JSON.stringify({ type: 'X', ... })` (both inline
//     and multi-line forms) inside server JS source.
//   - Scan packages/client/public/app.js for every `ws.onmessage` switch
//     block and extract the `case 'X':` literals from each one.
//   - Assert: every emitted type has a `case` entry in EVERY ws.onmessage
//     switch. If a switch deliberately omits a type, document it via the
//     ALLOWED_OMISSIONS map below — better than a silent drop.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'packages', 'server', 'src');
const CLIENT_APP = path.join(REPO_ROOT, 'packages', 'client', 'public', 'app.js');

// Switches may legitimately omit a type when the handler context has no
// reason to react. Record the omission here with a justification, so the
// silence is intentional rather than accidental. Keys are switch-identifier
// strings of the form `<filename>:<approx-line-of-onmessage-handler>`,
// values are the set of types the switch is ALLOWED to ignore.
const ALLOWED_OMISSIONS = Object.freeze({
  // Today every switch handles every type. Future entries belong here when
  // a deliberate omission is documented.
});

function findAllJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findAllJsFiles(p));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function extractEmittedTypes(src) {
  const types = new Set();
  // Inline shape: JSON.stringify({ type: 'X', ... })
  const inlineRe = /JSON\.stringify\s*\(\s*\{\s*type:\s*['"]([a-z_][a-z_0-9]*)['"]/g;
  // Multi-line shape: JSON.stringify({\n  type: 'X',
  const multilineRe = /JSON\.stringify\s*\(\s*\{\s*\n\s*type:\s*['"]([a-z_][a-z_0-9]*)['"]/g;
  let m;
  while ((m = inlineRe.exec(src)) !== null) types.add(m[1]);
  while ((m = multilineRe.exec(src)) !== null) types.add(m[1]);
  return types;
}

function extractHandlerSwitches(src, filename) {
  const switches = [];
  // Find each ws.onmessage = (event) => { ... } handler. For each, extract
  // the `case '<X>':` literals via balanced-brace scan from the handler
  // opening brace to its matching close.
  const handlerRe = /ws\.onmessage\s*=\s*\(\s*event\s*\)\s*=>\s*\{/g;
  let m;
  while ((m = handlerRe.exec(src)) !== null) {
    const handlerStart = m.index + m[0].length - 1; // index of opening `{`
    let depth = 0;
    let i = handlerStart;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const handlerBody = src.slice(handlerStart, i + 1);
    const lineNumber = src.slice(0, m.index).split('\n').length;
    const cases = new Set(
      [...handlerBody.matchAll(/case\s+['"]([a-z_][a-z_0-9]*)['"]\s*:/g)].map((c) => c[1])
    );
    switches.push({
      id: `${filename}:${lineNumber}`,
      lineNumber,
      cases,
    });
  }
  return switches;
}

test('every server-emitted WS message type has a registered handler in every client ws.onmessage switch', () => {
  const serverFiles = findAllJsFiles(SERVER_DIR);
  assert.ok(serverFiles.length > 0, 'expected at least one .js file under packages/server/src');

  const allEmittedTypes = new Set();
  for (const file of serverFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const type of extractEmittedTypes(src)) allEmittedTypes.add(type);
  }
  // Sanity: we know there are at least these 6 today (output, meta, exit,
  // proactive_memory, status_broadcast, config_changed). If the count drops,
  // the scanner has regressed.
  assert.ok(
    allEmittedTypes.size >= 4,
    `expected at least 4 emitted WS message types, found ${allEmittedTypes.size}: [${[...allEmittedTypes].join(', ')}]`
  );

  const clientSrc = fs.readFileSync(CLIENT_APP, 'utf8');
  const switches = extractHandlerSwitches(clientSrc, path.basename(CLIENT_APP));
  assert.ok(
    switches.length >= 2,
    `expected at least 2 ws.onmessage switches in ${path.basename(CLIENT_APP)} (main panel + reconnect), found ${switches.length}`
  );

  const failures = [];
  for (const sw of switches) {
    const allowed = ALLOWED_OMISSIONS[sw.id] || new Set();
    for (const type of allEmittedTypes) {
      if (sw.cases.has(type)) continue;
      if (allowed.has && allowed.has(type)) continue;
      if (Array.isArray(allowed) && allowed.includes(type)) continue;
      failures.push(`  • switch at app.js:${sw.lineNumber} is missing case '${type}': (server emits this type but the client switch ignores it)`);
    }
  }

  if (failures.length > 0) {
    const msg = [
      `WS handler contract violation: ${failures.length} unhandled type(s) across ${switches.length} switch(es).`,
      `Server-emitted types: [${[...allEmittedTypes].sort().join(', ')}]`,
      `Switch case sets:`,
      ...switches.map((s) => `  • app.js:${s.lineNumber}: [${[...s.cases].sort().join(', ')}]`),
      ``,
      `Failures:`,
      ...failures,
      ``,
      `Either add the missing case or record a deliberate omission in ALLOWED_OMISSIONS.`,
      `This is the Sprint 39 bug class — server-side WS push working correctly`,
      `but the client switch silently drops the frame. Don't repeat 9 days of`,
      `user-visible silence.`,
    ].join('\n');
    assert.fail(msg);
  }
});

test('the scanner finds the 6 known WS message types emitted by Sprint 38 + 39', () => {
  // Lock the scanner against silent regression. If a future refactor drops
  // one of these emit sites by accident, this test catches it BEFORE the
  // contract test would (which would only catch the symptom — switch
  // missing handler — not the cause — emit site removed).
  const serverFiles = findAllJsFiles(SERVER_DIR);
  const allEmittedTypes = new Set();
  for (const file of serverFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const type of extractEmittedTypes(src)) allEmittedTypes.add(type);
  }
  const required = ['output', 'meta', 'exit', 'proactive_memory', 'status_broadcast', 'config_changed'];
  for (const type of required) {
    assert.ok(
      allEmittedTypes.has(type),
      `expected WS emit for type '${type}' to exist somewhere under packages/server/src/. Removing the emit site without removing the handler is also a regression.`
    );
  }
});

test('every ws.onmessage switch in app.js has the same case set (parity guard)', () => {
  // Switches that drift apart silently are how Sprint 39's bug compounded:
  // even after the main panel WS handler was patched, the reconnect WS
  // handler kept missing config_changed. This test enforces parity so a
  // future fix to one switch propagates to the other.
  const clientSrc = fs.readFileSync(CLIENT_APP, 'utf8');
  const switches = extractHandlerSwitches(clientSrc, path.basename(CLIENT_APP));
  if (switches.length < 2) return; // contract test above covers this

  const reference = [...switches[0].cases].sort();
  for (let i = 1; i < switches.length; i++) {
    const cur = [...switches[i].cases].sort();
    assert.deepEqual(
      cur, reference,
      `app.js ws.onmessage switches at lines ${switches[0].lineNumber} and ${switches[i].lineNumber} have different case sets:\n` +
      `  ${switches[0].lineNumber}: [${reference.join(', ')}]\n` +
      `  ${switches[i].lineNumber}: [${cur.join(', ')}]\n` +
      `Switches must stay in sync — new types added to one MUST be added to the other.`
    );
  }
});
