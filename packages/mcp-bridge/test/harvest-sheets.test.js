'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sheets intake ramp (Sprint 84 / T1) — the acceptance bar, in order:
//   fingerprint dedup · forwarded-row skip · crash-between-insert-and-mark
//   rerun safety · source_agent mapping · malformed-row quarantine
// plus the end-to-end proof with a FAKED TRANSPORT that asserts the REAL
// request shapes (JWT claim set, token-endpoint form body, Sheets URLs,
// batchUpdate body, and the exact { op:'propose', ... } the Mnestra webhook
// receives, secret header included).
//
// Hermetic by construction: every env bag points redact's denylist loader at a
// /nonexistent file, the ledger runs on an in-memory fs double, and no test
// touches ~/.termdeck or the network. The one real cryptographic operation is
// an ephemeral RSA keypair generated in-process for the JWT-signing proof.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  harvestOnce, classifyRow, rowFingerprint, loadHarvestConfig,
  noteIsWritable, NOTE_MARKER, REFUSAL_PREFIX, HARVESTER_ID, DEFAULT_SOURCE_AGENT,
} = require('../src/harvest/sheets');
const { createLedger, PHASES } = require('../src/harvest/ledger');
const { createSheetsApi, quoteTab } = require('../src/harvest/sheets-api');
const {
  createAccessTokenProvider, loadServiceAccount, signAssertion, normalizePrivateKey, TOKEN_URL, SHEETS_SCOPE,
} = require('../src/harvest/google-auth');
const { createMnestraClient } = require('../src/clients/mnestra');
const { createHarvester } = require('../src/harvest/run');

// ── doubles ─────────────────────────────────────────────────────────────────

function hermeticEnv(extra = {}) {
  return { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json', ...extra };
}

const CFG = Object.freeze({
  enabled: true,
  spreadsheetId: 'SHEET-1',
  tab: 'Intake',
  headerRows: 1,
  defaultProject: 'termdeck',
  defaultSourceAgent: 'gemini-web',
  maxRowsPerRun: 100,
  pollIntervalMs: 1000,
});

// In-memory fs double covering exactly the calls ledger.js makes.
function memFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const open = new Map();
  let nextFd = 3;
  return {
    files,
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    mkdirSync() { /* no-op */ },
    openSync(p) { const fd = nextFd; nextFd += 1; open.set(fd, p); if (!files.has(p)) files.set(p, ''); return fd; },
    writeSync(fd, s) { const p = open.get(fd); files.set(p, files.get(p) + s); },
    fsyncSync() { /* no-op */ },
    closeSync(fd) { open.delete(fd); },
  };
}

function fakeSheets(values) {
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    async readRange(id, range) { reads.push({ id, range }); return values; },
    async batchUpdateValues(id, data) { writes.push({ id, data }); return { updatedCells: data.length * 2 }; },
    // convenience: flatten every written range→value pair
    all() { return writes.flatMap((w) => w.data); },
  };
}

function fakeMnestra(impl) {
  const calls = [];
  return {
    calls,
    async propose(args) {
      calls.push(args);
      if (typeof impl === 'function') return impl(args, calls.length);
      return { id: `inbox-${calls.length}`, status: 'pending' };
    },
  };
}

function ledgerOn(fs, file = '/tmp/ledger.jsonl') {
  return createLedger({ fs, file });
}

function ledgerRecords(fs, file = '/tmp/ledger.jsonl') {
  return String(fs.files.get(file) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const FIXED_NOW = () => Date.parse('2026-07-31T22:00:00.000Z');

function run(rows, opts = {}) {
  const fs = opts.fs || memFs(opts.seedFiles);
  const sheets = opts.sheets || fakeSheets(rows);
  const mnestra = opts.mnestra || fakeMnestra(opts.proposeImpl);
  const ledger = opts.ledger || ledgerOn(fs);
  return harvestOnce({
    sheets, mnestra, ledger,
    env: hermeticEnv(opts.env),
    config: { ...CFG, ...(opts.config || {}) },
    now: opts.now || FIXED_NOW,
    logger: () => {},
  }).then((report) => ({ report, sheets, mnestra, ledger, fs }));
}

// ── 1. fingerprint dedup ────────────────────────────────────────────────────

test('fingerprint is deterministic and varies with EVERY operator-authored component', () => {
  const base = { spreadsheetId: 'S', tab: 'Intake', row: 7, cells: ['ts', 'grok-web', 'termdeck', 'hello', '', ''] };
  const fp = rowFingerprint(base);
  assert.equal(fp, rowFingerprint({ ...base }), 'same inputs → same fingerprint');
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.notEqual(fp, rowFingerprint({ ...base, row: 8 }));
  assert.notEqual(fp, rowFingerprint({ ...base, tab: 'Other' }));
  assert.notEqual(fp, rowFingerprint({ ...base, spreadsheetId: 'S2' }));
  // All four operator columns are payload-affecting, so all four move it.
  assert.notEqual(fp, rowFingerprint({ ...base, cells: ['ts2', 'grok-web', 'termdeck', 'hello', '', ''] }), 'ts (captured_at)');
  assert.notEqual(fp, rowFingerprint({ ...base, cells: ['ts', 'claude-web', 'termdeck', 'hello', '', ''] }), 'source');
  assert.notEqual(fp, rowFingerprint({ ...base, cells: ['ts', 'grok-web', 'rumen', 'hello', '', ''] }), 'project');
  assert.notEqual(fp, rowFingerprint({ ...base, cells: ['ts', 'grok-web', 'termdeck', 'hello!', '', ''] }), 'text');
  // Whitespace-only edits do NOT create a new proposal.
  assert.equal(fp, rowFingerprint({ ...base, cells: ['  ts ', 'grok-web', 'termdeck', '  hello  ', '', ''] }));
  // Harvester-owned columns (E/F) are excluded — otherwise our own stamp would
  // invalidate the fingerprint and every row would re-propose forever.
  assert.equal(fp, rowFingerprint({ ...base, cells: ['ts', 'grok-web', 'termdeck', 'hello', 'STAMPED', '[harvest] note'] }));
});

test('the NUL field separator prevents run-together collisions', () => {
  // Without a separator, ('S','Intake',7) and ('S','Intake7',...) could collide.
  const a = rowFingerprint({ spreadsheetId: 'S', tab: 'ab', row: 1, cells: ['', '', '', 'x'] });
  const b = rowFingerprint({ spreadsheetId: 'S', tab: 'a', row: 'b1', cells: ['', '', '', 'x'] });
  assert.notEqual(a, b);
  // ...and across the cell fields too.
  const c = rowFingerprint({ spreadsheetId: 'S', tab: 'T', row: 1, cells: ['a', 'b', '', ''] });
  const d = rowFingerprint({ spreadsheetId: 'S', tab: 'T', row: 1, cells: ['', 'a', 'b', ''] });
  assert.notEqual(c, d);
});

test('ONE fingerprint definition serves both the ledger key and the pre-stamp guard', () => {
  // The regression this collapses: a narrow dedup key plus a wider state guard
  // disagreed about what "the same row" means, so a project-only edit was
  // invisible to the ledger and got stamped over. Any payload-affecting edit
  // must move the single fingerprint.
  const cells = ['ts', 'grok-web', 'old-project', 'same text', '', ''];
  const before = rowFingerprint({ spreadsheetId: 'S', tab: 'T', row: 2, cells });
  const after = rowFingerprint({ spreadsheetId: 'S', tab: 'T', row: 2, cells: ['ts', 'grok-web', 'new-project-before-stamp', 'same text', '', ''] });
  assert.notEqual(before, after, 'a project-only edit MUST change the fingerprint');
});

test('a fingerprint already in the ledger is never proposed twice', async () => {
  const rows = [['2026-07-31', '', '', 'remember this', '', '']];
  const first = await run(rows);
  assert.equal(first.report.proposed, 1);
  assert.equal(first.mnestra.calls.length, 1);

  // Same sheet, same row, unstamped (simulating the stamp never landing), same
  // ledger → the second pass must NOT re-propose.
  const second = await run(rows, { fs: first.fs });
  assert.equal(second.report.proposed, 0);
  assert.equal(second.mnestra.calls.length, 0);
  assert.equal(second.report.restamped, 1);
});

// ── 2. forwarded-row skip ───────────────────────────────────────────────────

test('a row with forwarded_at set is skipped forever and never rewritten', async () => {
  const rows = [
    ['2026-07-31', '', '', 'already sent', '2026-07-30T10:00:00.000Z', ''],
    ['2026-07-31', '', '', 'fresh one', '', ''],
  ];
  const { report, mnestra, sheets } = await run(rows);
  assert.equal(report.alreadyForwarded, 1);
  assert.equal(report.proposed, 1);
  assert.equal(mnestra.calls.length, 1);
  assert.equal(mnestra.calls[0].text, 'fresh one');
  // Only row 3 (header=1, so data starts at row 2; the fresh row is the 2nd) is written.
  const written = sheets.all();
  assert.equal(written.length, 1);
  assert.match(written[0].range, /!E3:F3$/);
});

test('classifyRow treats a blank row as blank, not as an error', () => {
  assert.equal(classifyRow([], CFG).kind, 'blank');
  assert.equal(classifyRow(['', '', '', '', '', ''], CFG).kind, 'blank');
  assert.equal(classifyRow(['x', '', '', 'text'], CFG).kind, 'ready');
});

// ── 3. crash-between-insert-and-mark rerun safety ───────────────────────────

test('crash AFTER the insert, BEFORE the stamp: re-stamped from the ledger, never re-proposed', async () => {
  const fp = rowFingerprint({ spreadsheetId: CFG.spreadsheetId, tab: CFG.tab, row: 2, cells: ['2026-07-31', '', '', 'survivor', '', ''] });
  const seed = {
    '/tmp/ledger.jsonl':
      `${JSON.stringify({ fingerprint: fp, phase: PHASES.FORWARDED, ts: '2026-07-31T21:00:00.000Z', forwarded_at: '2026-07-31T21:00:00.000Z', row: 2, inbox_id: 'inbox-abc' })}\n`,
  };
  const { report, mnestra, sheets } = await run([['2026-07-31', '', '', 'survivor', '', '']], { seedFiles: seed });

  assert.equal(mnestra.calls.length, 0, 'must NOT re-propose');
  assert.equal(report.restamped, 1);
  const written = sheets.all();
  assert.equal(written.length, 1);
  assert.equal(written[0].values[0][0], '2026-07-31T21:00:00.000Z', 'stamp comes from the ledger, not from now()');
});

test('crash DURING the insert (inflight only): stamped with a visible note, never re-proposed', async () => {
  const fp = rowFingerprint({ spreadsheetId: CFG.spreadsheetId, tab: CFG.tab, row: 2, cells: ['2026-07-31', '', '', 'maybe sent', '', ''] });
  const seed = {
    '/tmp/ledger.jsonl': `${JSON.stringify({ fingerprint: fp, phase: PHASES.INFLIGHT, ts: '2026-07-31T21:30:00.000Z', row: 2 })}\n`,
  };
  const { report, mnestra, sheets } = await run([['2026-07-31', '', '', 'maybe sent', '', '']], { seedFiles: seed });

  assert.equal(mnestra.calls.length, 0, 'indeterminate must never be retried');
  assert.equal(report.uncertain, 1);
  const [w] = sheets.all();
  assert.equal(w.values[0][0], '2026-07-31T21:30:00.000Z');
  assert.match(w.values[0][1], /in-flight/i);
  assert.ok(w.values[0][1].startsWith(NOTE_MARKER));
});

test('write-ahead ordering: the inflight record is durable BEFORE propose() is called', async () => {
  const fs = memFs();
  const ledger = ledgerOn(fs);
  let ledgerAtCallTime = null;
  const mnestra = fakeMnestra(() => {
    ledgerAtCallTime = ledgerRecords(fs);
    return { id: 'inbox-1', status: 'pending' };
  });
  await run([['', '', '', 'ordered', '', '']], { fs, ledger, mnestra });

  assert.equal(ledgerAtCallTime.length, 1, 'exactly one record existed when propose() ran');
  assert.equal(ledgerAtCallTime[0].phase, PHASES.INFLIGHT);
  const final = ledgerRecords(fs);
  assert.equal(final.length, 2);
  assert.equal(final[1].phase, PHASES.FORWARDED);
  assert.equal(final[1].inbox_id, 'inbox-1');
});

test('an indeterminate propose failure leaves the row inflight and does not fail the batch', async () => {
  const rows = [
    ['', '', '', 'row one', '', ''],
    ['', '', '', 'row two', '', ''],
  ];
  const { report, mnestra, fs } = await run(rows, {
    proposeImpl: (args) => {
      if (args.text === 'row one') throw new Error('request timed out after 8000ms: http://localhost:37778/mnestra');
      return { id: 'inbox-2', status: 'pending' };
    },
  });
  assert.equal(report.uncertain, 1);
  assert.equal(report.proposed, 1, 'the second row still went through');
  assert.equal(mnestra.calls.length, 2);
  const recs = ledgerRecords(fs);
  const one = recs.filter((r) => r.row === 2);
  assert.equal(one.length, 1);
  assert.equal(one[0].phase, PHASES.INFLIGHT, 'stays inflight → never retried');
});

test('a DEFINITIVE refusal (webhook 400) is recorded as rejected and surfaced in the sheet', async () => {
  const { report, sheets, fs } = await run([['', '', '', 'bad proposal', '', '']], {
    proposeImpl: () => { throw new Error(`${REFUSAL_PREFIX} HTTP 400 — text is required`); },
  });
  assert.equal(report.refused, 1);
  assert.equal(report.proposed, 0);
  const recs = ledgerRecords(fs);
  assert.equal(recs[recs.length - 1].phase, PHASES.REJECTED);
  const [w] = sheets.all();
  assert.match(w.range, /!F2$/, 'note only — forwarded_at stays empty');
  assert.match(w.values[0][0], /refused by the memory inbox/);
});

test('ledger load: an inflight line never un-resolves an earlier forwarded line, and a torn line is survivable', () => {
  const fp = 'a'.repeat(64);
  const fs = memFs({
    '/tmp/ledger.jsonl':
      `${JSON.stringify({ fingerprint: fp, phase: PHASES.INFLIGHT, ts: '1' })}\n`
      + `${JSON.stringify({ fingerprint: fp, phase: PHASES.FORWARDED, ts: '2', inbox_id: 'x' })}\n`
      + `${JSON.stringify({ fingerprint: fp, phase: PHASES.INFLIGHT, ts: '3' })}\n`
      + '{"fingerprint":"bb","phase":"forw', // torn by a power loss mid-write
  });
  const map = ledgerOn(fs).load();
  assert.equal(map.get(fp).phase, PHASES.FORWARDED, 'resolved phase wins');
  assert.equal(map.size, 1, 'the torn line is skipped, not fatal');
});

test('a missing ledger file is a first run, not an error', () => {
  assert.equal(ledgerOn(memFs()).load().size, 0);
});

// ── 4. source_agent mapping ─────────────────────────────────────────────────

test('source_agent: blank column → gemini-web default (PLANNING contract 3)', async () => {
  const { mnestra } = await run([['', '', '', 'no source given', '', '']]);
  assert.equal(mnestra.calls[0].sourceAgent, 'gemini-web');
  assert.equal(DEFAULT_SOURCE_AGENT, 'gemini-web');
});

test('source_agent: an explicit canonical value is honoured, case/space insensitively', async () => {
  const rows = [
    ['', 'chatgpt-web', '', 'from chatgpt', '', ''],
    ['', '  GROK-WEB ', '', 'from grok', '', ''],
    ['', 'claude-web', '', 'from claude', '', ''],
  ];
  const { mnestra } = await run(rows);
  assert.deepEqual(mnestra.calls.map((c) => c.sourceAgent), ['chatgpt-web', 'grok-web', 'claude-web']);
});

test('source_agent: a CLI identity can never be minted from a sheet', async () => {
  const { report, mnestra } = await run([['', 'claude', '', 'trying to be a CLI', '', '']]);
  assert.equal(mnestra.calls.length, 0);
  assert.equal(report.quarantined, 1);
  assert.match(report.problems[0].reason, /unknown source/);
});

test('source_agent: an invalid value is quarantined, NEVER silently coerced to the default', async () => {
  const { report, mnestra, sheets } = await run([['', 'gemni-web', '', 'typo in source', '', '']]);
  assert.equal(mnestra.calls.length, 0, 'a typo must not become a proposal under the default identity');
  assert.equal(report.quarantined, 1);
  assert.match(sheets.all()[0].values[0][0], /unknown source "gemni-web"/);
});

// ── 5. malformed-row quarantine ─────────────────────────────────────────────

test('malformed rows are noted in the sheet, never dropped, never fatal to the batch', async () => {
  const rows = [
    ['2026-07-31', '', '', '', '', ''], // empty text (but a ts → not blank)
    ['2026-07-31', 'nonsense', '', 'bad source', '', ''],
    ['2026-07-31', '', 'x'.repeat(200), 'project too long', '', ''],
    ['2026-07-31', '', '', 'y'.repeat(4001), '', ''], // over the text cap
    ['2026-07-31', '', '', 'the good one', '', ''],
  ];
  const { report, mnestra, sheets } = await run(rows);

  assert.equal(report.quarantined, 4);
  assert.equal(report.proposed, 1, 'one bad row does not stop the batch');
  assert.equal(mnestra.calls[0].text, 'the good one');
  assert.equal(report.problems.length, 4);
  const reasons = report.problems.map((p) => p.reason).join(' | ');
  assert.match(reasons, /empty text/);
  assert.match(reasons, /unknown source/);
  assert.match(reasons, /project is 200 chars/);
  assert.match(reasons, /text is 4001 chars/);
  // every quarantined row got a note, and only column F
  const notes = sheets.all().filter((w) => /!F\d+$/.test(w.range));
  assert.equal(notes.length, 4);
  for (const n of notes) assert.ok(n.values[0][0].startsWith(NOTE_MARKER));
});

test('quarantine is re-derived each run, so fixing ANY cell un-sticks the row', async () => {
  const first = await run([['', 'bogus', '', 'fix me', '', '']]);
  assert.equal(first.report.quarantined, 1);
  // Operator fixes ONLY column B (text unchanged → same fingerprint). Because
  // quarantine is never ledgered, the row is reconsidered from scratch.
  const second = await run([['', 'grok-web', '', 'fix me', '', `${NOTE_MARKER} not forwarded: unknown source`]], { fs: first.fs });
  assert.equal(second.report.proposed, 1);
  assert.equal(second.mnestra.calls[0].sourceAgent, 'grok-web');
});

test('note writes are idempotent — an unchanged quarantine note is not rewritten', async () => {
  const first = await run([['', 'bogus', '', 'still bad', '', '']]);
  const note = first.sheets.all()[0].values[0][0];
  const second = await run([['', 'bogus', '', 'still bad', '', note]], { fs: first.fs });
  assert.equal(second.report.quarantined, 1);
  assert.equal(second.sheets.all().length, 0, 'nothing rewritten on the second pass');
});

test("an operator's own note in column F is never clobbered", async () => {
  const rows = [['', '', '', 'keep my note', '', 'my own annotation']];
  const { sheets } = await run(rows);
  const [w] = sheets.all();
  assert.match(w.range, /!E2$/, 'only forwarded_at is written when F is operator-authored');
  assert.equal(w.values[0].length, 1);
  assert.equal(noteIsWritable('my own annotation'), false);
  assert.equal(noteIsWritable(''), true);
  assert.equal(noteIsWritable(`${NOTE_MARKER} whatever`), true);
});

// ── verify-before-stamp (T4 AUDIT-FAIL 2026-07-31 18:31 ET) ─────────────────

test("T4 fixture: a row edited between read and stamp is NOT marked forwarded", async () => {
  // T4's reproduction verbatim: the fake returns row 2 with `old text`, then the
  // in-memory row becomes `new text typed before stamp` before the write-back.
  // The mutation is applied during propose() — the window a human actually
  // types in. Previously the row was stamped forwarded anyway and the edit was
  // lost forever; the pre-stamp gate must now withhold the stamp.
  const values = [['', '', '', 'old text', '', '']];
  const sheets = fakeSheets(values);
  const mnestra = fakeMnestra((args) => {
    values[0][3] = 'new text typed before stamp';
    return { id: 'inbox-old', status: 'pending' };
  });
  const fs = memFs();
  const report = await harvestOnce({
    sheets, mnestra, ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });

  assert.equal(report.proposed, 1, 'the text as read was proposed');
  assert.equal(mnestra.calls[0].text, 'old text');
  assert.equal(report.mutatedSkipped, 1, 'the mutation was detected');
  assert.equal(sheets.all().length, 0, 'NOTHING was stamped — the row stays unforwarded');
  assert.equal(values[0][4], '', 'forwarded_at is still empty in the sheet');
  const mutated = report.problems.find((p) => p.kind === 'mutated');
  assert.equal(mutated.row, 2);
  assert.match(mutated.reason, /re-proposed next pass/);
});

test('T4 fixture, pass 2: the CURRENT text is re-proposed as a NEW fingerprint, not a duplicate', async () => {
  const values = [['', '', '', 'old text', '', '']];
  const fs = memFs();
  const sheets = fakeSheets(values);
  const mnestra = fakeMnestra(() => {
    values[0][3] = 'new text typed before stamp';
    return { id: 'inbox-old', status: 'pending' };
  });
  await harvestOnce({
    sheets, mnestra, ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });

  // Next pass against the SAME ledger and the now-edited sheet.
  const second = await harvestOnce({
    sheets: fakeSheets(values), mnestra, ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });

  assert.equal(second.proposed, 1, 'the edited text is picked up');
  assert.equal(second.restamped, 0);
  assert.equal(mnestra.calls.length, 2);
  assert.equal(mnestra.calls[1].text, 'new text typed before stamp');

  // Distinct fingerprints — this is a genuinely new proposal, not a re-send of
  // the same one, which is exactly what a CONTENT hash buys.
  const fpOld = rowFingerprint({ spreadsheetId: 'SHEET-1', tab: 'Intake', row: 2, cells: ['', '', '', 'old text'] });
  const fpNew = rowFingerprint({ spreadsheetId: 'SHEET-1', tab: 'Intake', row: 2, cells: ['', '', '', 'new text typed before stamp'] });
  assert.notEqual(fpOld, fpNew);
  assert.equal(mnestra.calls[0].metadata.sheets.fingerprint, fpOld);
  assert.equal(mnestra.calls[1].metadata.sheets.fingerprint, fpNew);

  const phases = ledgerRecords(fs).map((r) => `${r.fingerprint.slice(0, 8)}:${r.phase}`);
  assert.equal(phases.filter((p) => p.endsWith('forwarded')).length, 2, 'two distinct rows forwarded, no duplicate of either');
});

test('a mid-pass edit to source or project also withholds the stamp', async () => {
  // The guard is wider than the dedup fingerprint on purpose: changing WHO the
  // capture came from makes it a different proposal just as much as changing
  // the text does.
  for (const col of [1, 2]) {
    const values = [['', 'grok-web', 'termdeck', 'stable text', '', '']];
    const sheets = fakeSheets(values);
    const mnestra = fakeMnestra(() => {
      values[0][col] = col === 1 ? 'claude-web' : 'rumen';
      return { id: 'inbox-x', status: 'pending' };
    });
    const report = await harvestOnce({
      sheets, mnestra, ledger: ledgerOn(memFs()), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
    });
    assert.equal(report.mutatedSkipped, 1, `column ${col} change must withhold the stamp`);
    assert.equal(sheets.all().length, 0);
  }
});

test('T4 fixture: SAME TEXT with an edited project must re-propose on pass 2, not stamp over the edit', async () => {
  // The half-fix regression: the pre-stamp guard caught the mutation (pass 1
  // withheld the stamp), but the narrower dedup key did not, so pass 2 saw an
  // "unchanged" fingerprint, made ZERO Mnestra calls, reported restamped=1 and
  // stamped over the edited row. One fingerprint definition closes it.
  const values = [['', 'grok-web', 'old-project', 'same text', '', '']];
  const fs = memFs();
  const mnestra = fakeMnestra(() => {
    values[0][2] = 'new-project-before-stamp'; // text is deliberately untouched
    return { id: 'inbox-1', status: 'pending' };
  });

  const first = await harvestOnce({
    sheets: fakeSheets(values), mnestra, ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });
  assert.equal(first.proposed, 1);
  assert.equal(mnestra.calls[0].projectHint, 'old-project');
  assert.equal(first.mutatedSkipped, 1, 'pass 1 withholds the stamp');

  const sheets2 = fakeSheets(values);
  const second = await harvestOnce({
    sheets: sheets2, mnestra, ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });

  assert.equal(second.restamped, 0, 'the edited row is NOT treated as already-forwarded');
  assert.equal(second.proposed, 1, 'pass 2 re-proposes the edited row');
  assert.equal(mnestra.calls.length, 2);
  assert.equal(mnestra.calls[1].projectHint, 'new-project-before-stamp');
  assert.equal(mnestra.calls[1].text, 'same text', 'same text, new project — a genuinely different proposal');
  assert.equal(sheets2.all()[0].range, "'Intake'!E2:F2", 'now stable, so pass 2 stamps it');
});

test('a harvester-owned cell (E/F) changing does NOT withhold the stamp', async () => {
  // The guard covers A–D only. If it covered E/F, our own write would
  // invalidate every stamp and nothing would ever be marked forwarded.
  const fp = (cells) => rowFingerprint({ spreadsheetId: 'S', tab: 'T', row: 2, cells });
  const base = fp(['ts', 'grok-web', 'termdeck', 'text', '', '']);
  assert.equal(fp(['ts', 'grok-web', 'termdeck', 'text', 'STAMPED', '[harvest] note']), base);
  assert.notEqual(fp(['ts', 'grok-web', 'termdeck', 'edited', '', '']), base);
  assert.notEqual(fp(['ts', 'claude-web', 'termdeck', 'text', '', '']), base);
});

test('one mutated row does not withhold the stamps of its unmutated neighbours', async () => {
  const values = [
    ['', '', '', 'row A', '', ''],
    ['', '', '', 'row B', '', ''],
    ['', '', '', 'row C', '', ''],
  ];
  const sheets = fakeSheets(values);
  const mnestra = fakeMnestra((args) => {
    if (args.text === 'row B') values[1][3] = 'row B edited mid-pass';
    return { id: 'inbox-x', status: 'pending' };
  });
  const report = await harvestOnce({
    sheets, mnestra, ledger: ledgerOn(memFs()), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });
  assert.equal(report.proposed, 3);
  assert.equal(report.mutatedSkipped, 1);
  const stamped = sheets.all().map((w) => w.range);
  assert.deepEqual(stamped, ["'Intake'!E2:F2", "'Intake'!E4:F4"], 'A and C stamped; B withheld');
});

test('a mutated row also withholds its QUARANTINE note, so the note can never describe stale content', async () => {
  const values = [['', 'bogus-source', '', 'text', '', '']];
  const sheets = fakeSheets(values);
  // No propose happens for a quarantined row, so mutate via the verify read.
  const originalRead = sheets.readRange.bind(sheets);
  let reads = 0;
  sheets.readRange = async (id, range) => {
    reads += 1;
    if (reads === 2) values[0][1] = 'grok-web'; // operator fixed it mid-pass
    return originalRead(id, range);
  };
  const report = await harvestOnce({
    sheets, mnestra: fakeMnestra(), ledger: ledgerOn(memFs()), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });
  assert.equal(report.quarantined, 1);
  assert.equal(report.mutatedSkipped, 1);
  assert.equal(sheets.all().length, 0, 'no stale "unknown source" note written over a row the operator just fixed');
});

test('a failed pre-stamp re-read fails CLOSED: nothing is stamped', async () => {
  const sheets = fakeSheets([['', '', '', 'will not be stamped', '', '']]);
  let reads = 0;
  const originalRead = sheets.readRange.bind(sheets);
  sheets.readRange = async (id, range) => {
    reads += 1;
    if (reads === 2) throw new Error('HTTP 503 — backend error');
    return originalRead(id, range);
  };
  let batchCalled = false;
  sheets.batchUpdateValues = async () => { batchCalled = true; return { updatedCells: 0 }; };

  const fs = memFs();
  const report = await harvestOnce({
    sheets, mnestra: fakeMnestra(), ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });
  assert.equal(report.proposed, 1);
  assert.equal(report.verifyFailed, true);
  assert.equal(batchCalled, false, 'an unverified stamp is never written');
  // Self-healing: the ledger is authoritative, so the next pass re-stamps.
  const second = await run([['', '', '', 'will not be stamped', '', '']], { fs });
  assert.equal(second.report.proposed, 0);
  assert.equal(second.report.restamped, 1);
});

// ── ingress secret scan ─────────────────────────────────────────────────────

test('a row carrying a secret is refused, not scrubbed, and the note names only the rule class', async () => {
  const rows = [['', '', '', 'my key is AKIAIOSFODNN7EXAMPLE ok', '', '']];
  const { report, mnestra, sheets } = await run(rows);
  assert.equal(mnestra.calls.length, 0, 'never forwarded');
  assert.equal(report.quarantined, 1);
  const note = sheets.all()[0].values[0][0];
  assert.match(note, /aws-akid/, 'names the rule class');
  assert.ok(!note.includes('AKIAIOSFODNN7EXAMPLE'), 'never echoes the matched secret back into the sheet');
});

test('the generated fingerprint does not false-positive under entropy scanning', async () => {
  // The metadata stamp carries a 64-char hex digest. If ENTROPY mode ever
  // started flagging it, EVERY row would quarantine — a total intake outage
  // from a config flag. Pin it.
  const { report, mnestra } = await run([['', '', '', 'ordinary capture text', '', '']], {
    env: { TERMDECK_BRIDGE_REDACT_ENTROPY: '1' },
  });
  assert.equal(report.quarantined, 0);
  assert.equal(mnestra.calls.length, 1);
});

// ── the propose payload ─────────────────────────────────────────────────────

test('the proposal carries the row fingerprint and full sheet provenance in metadata', async () => {
  const { mnestra } = await run([['2026-07-31T09:00:00Z', '', 'rumen', 'a durable fact', '', '']]);
  const [call] = mnestra.calls;
  assert.equal(call.text, 'a durable fact');
  assert.equal(call.projectHint, 'rumen', 'the row project overrides the configured default');
  assert.deepEqual(call.metadata.sheets, {
    fingerprint: rowFingerprint({ spreadsheetId: 'SHEET-1', tab: 'Intake', row: 2, cells: ['2026-07-31T09:00:00Z', '', 'rumen', 'a durable fact', '', ''] }),
    spreadsheet_id: 'SHEET-1',
    tab: 'Intake',
    row: 2,
    captured_at: '2026-07-31T09:00:00Z',
    harvester: HARVESTER_ID,
  });
});

test('the configured default project applies when the row leaves column C blank', async () => {
  const { mnestra } = await run([['', '', '', 'no project column', '', '']]);
  assert.equal(mnestra.calls[0].projectHint, 'termdeck');
});

// ── caps / bounded work ─────────────────────────────────────────────────────

test('the per-run cap defers rows rather than dropping them, and says so', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ['', '', '', `row ${i}`, '', '']);
  const logs = [];
  const fs = memFs();
  const sheets = fakeSheets(rows);
  const mnestra = fakeMnestra();
  const { proposed, deferred } = await harvestOnce({
    sheets, mnestra, ledger: ledgerOn(fs), env: hermeticEnv(),
    config: { ...CFG, maxRowsPerRun: 2 }, now: FIXED_NOW, logger: (m) => logs.push(m),
  });
  assert.equal(proposed, 2);
  assert.equal(deferred, 3);
  assert.match(logs.join('\n'), /3 row\(s\) deferred/);

  // The deferred rows are picked up on the next pass — nothing is lost.
  const next = await harvestOnce({
    sheets: fakeSheets(rows), mnestra, ledger: ledgerOn(fs), env: hermeticEnv(),
    config: { ...CFG, maxRowsPerRun: 2 }, now: FIXED_NOW, logger: () => {},
  });
  assert.equal(next.proposed, 2);
  assert.equal(next.restamped, 2, 'the first pass\'s two rows are re-stamped, not re-proposed');
});

test('a write-back failure is non-fatal: the ledger is authoritative and the next pass re-stamps', async () => {
  const fs = memFs();
  const sheets = fakeSheets([['', '', '', 'stamp will fail', '', '']]);
  sheets.batchUpdateValues = async () => { throw new Error('HTTP 503 — backend error'); };
  const mnestra = fakeMnestra();
  const report = await harvestOnce({
    sheets, mnestra, ledger: ledgerOn(fs), env: hermeticEnv(), config: CFG, now: FIXED_NOW, logger: () => {},
  });
  assert.equal(report.proposed, 1);
  assert.equal(report.writeBackFailed, true);

  const second = await run([['', '', '', 'stamp will fail', '', '']], { fs, mnestra });
  assert.equal(second.report.proposed, 0);
  assert.equal(second.report.restamped, 1);
  assert.equal(mnestra.calls.length, 1, 'still exactly one proposal in total');
});

test('harvestOnce refuses to run without a spreadsheet id', async () => {
  await assert.rejects(
    () => harvestOnce({
      sheets: fakeSheets([]), mnestra: fakeMnestra(), ledger: ledgerOn(memFs()),
      env: hermeticEnv(), config: { ...CFG, spreadsheetId: '' },
    }),
    /TERMDECK_SHEETS_SPREADSHEET_ID is not set/,
  );
});

test('the read range starts below the header rows and spans A:F', async () => {
  const { sheets } = await run([], { config: { headerRows: 3 } });
  assert.equal(sheets.reads[0].range, "'Intake'!A4:F");
});

test("A1 tab quoting doubles an apostrophe rather than addressing the wrong range", () => {
  assert.equal(quoteTab('Intake'), "'Intake'");
  assert.equal(quoteTab("Josh's Inbox"), "'Josh''s Inbox'");
});

// ── config loading ──────────────────────────────────────────────────────────

test('loadHarvestConfig defaults are off-by-default and canonical', () => {
  const cfg = loadHarvestConfig({});
  assert.equal(cfg.enabled, false, 'intake is opt-in');
  assert.equal(cfg.tab, 'Intake');
  assert.equal(cfg.headerRows, 1);
  assert.equal(cfg.defaultSourceAgent, 'gemini-web');
  assert.equal(cfg.maxRowsPerRun, 100);
  assert.equal(cfg.pollIntervalMs, 300000);
});

test('an invalid TERMDECK_SHEETS_DEFAULT_SOURCE_AGENT falls back to gemini-web, never to a CLI value', () => {
  assert.equal(loadHarvestConfig({ TERMDECK_SHEETS_DEFAULT_SOURCE_AGENT: 'codex' }).defaultSourceAgent, 'gemini-web');
  assert.equal(loadHarvestConfig({ TERMDECK_SHEETS_DEFAULT_SOURCE_AGENT: 'grok-web' }).defaultSourceAgent, 'grok-web');
});

// ── service-account auth ────────────────────────────────────────────────────

const KEYPAIR = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

test('loadServiceAccount reads the standard key file, and env overrides it', () => {
  const file = JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: KEYPAIR.privateKey });
  const deps = { readFileSync: () => file };
  const fromFile = loadServiceAccount({ TERMDECK_SHEETS_SA_KEY_FILE: '/k.json' }, deps);
  assert.equal(fromFile.clientEmail, 'sa@proj.iam.gserviceaccount.com');

  const overridden = loadServiceAccount(
    { TERMDECK_SHEETS_SA_KEY_FILE: '/k.json', TERMDECK_SHEETS_SA_EMAIL: 'other@proj.iam.gserviceaccount.com' },
    deps,
  );
  assert.equal(overridden.clientEmail, 'other@proj.iam.gserviceaccount.com');
});

test('loadServiceAccount fails with a credential-free message when unconfigured', () => {
  assert.throws(() => loadServiceAccount({}), (err) => {
    assert.match(err.message, /TERMDECK_SHEETS_SA_KEY_FILE/);
    assert.match(err.message, /docs\/SHEETS-INTAKE\.md/);
    return true;
  });
});

test('a PEM that travelled through an env var (literal \\n) is repaired', () => {
  const escaped = KEYPAIR.privateKey.replace(/\n/g, '\\n');
  assert.equal(normalizePrivateKey(escaped), KEYPAIR.privateKey);
  const creds = loadServiceAccount({
    TERMDECK_SHEETS_SA_EMAIL: 'sa@x.iam.gserviceaccount.com',
    TERMDECK_SHEETS_SA_PRIVATE_KEY: escaped,
  });
  assert.equal(creds.privateKey, KEYPAIR.privateKey);
});

test('a non-PEM private key is rejected before any network call', () => {
  assert.throws(
    () => loadServiceAccount({ TERMDECK_SHEETS_SA_EMAIL: 'sa@x.com', TERMDECK_SHEETS_SA_PRIVATE_KEY: 'not-a-key' }),
    /not a PEM block/,
  );
});

test('the signed assertion carries the exact claim set Google requires, and verifies', () => {
  const nowMs = Date.parse('2026-07-31T22:00:00Z');
  const { assertion, claims } = signAssertion({
    clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKey: KEYPAIR.privateKey, nowMs,
  });
  assert.deepEqual(claims, {
    iss: 'sa@proj.iam.gserviceaccount.com',
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: nowMs / 1000,
    exp: nowMs / 1000 + 3600,
  });
  assert.equal(SHEETS_SCOPE, 'https://www.googleapis.com/auth/spreadsheets', 'read+write: the harvester stamps rows back');

  const [h, p, s] = assertion.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), claims);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  verifier.end();
  assert.ok(verifier.verify(KEYPAIR.publicKey, Buffer.from(s, 'base64url')), 'signature verifies against the public key');
});

test('access tokens are cached until the skew window and then refreshed', async () => {
  let clock = Date.parse('2026-07-31T22:00:00Z');
  let exchanges = 0;
  const provider = createAccessTokenProvider({
    credentials: { clientEmail: 'sa@x.iam.gserviceaccount.com', privateKey: KEYPAIR.privateKey },
    now: () => clock,
    fetchImpl: async () => {
      exchanges += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: `tok-${exchanges}`, expires_in: 3600 }) };
    },
  });
  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(await provider.getToken(), 'tok-1', 'cached');
  assert.equal(exchanges, 1);
  clock += 3600 * 1000; // past expiry
  assert.equal(await provider.getToken(), 'tok-2');
  assert.equal(exchanges, 2);
});

test('a rejected token exchange surfaces Google\'s reason without echoing the assertion', async () => {
  const provider = createAccessTokenProvider({
    credentials: { clientEmail: 'sa@x.iam.gserviceaccount.com', privateKey: KEYPAIR.privateKey },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
    }),
  });
  await assert.rejects(() => provider.getToken(), (err) => {
    assert.match(err.message, /invalid_grant/);
    assert.match(err.message, /Invalid JWT Signature/);
    assert.ok(!err.message.includes('eyJ'), 'the assertion never appears in the error');
    return true;
  });
});

// ── END-TO-END with a faked transport, real request shapes asserted ─────────

test('E2E: sheet row → memory_inbox pending → forwarded_at stamped (real wire shapes)', async () => {
  const requests = [];
  const sheetValues = [['2026-07-31 09:00', '', 'termdeck', 'Josh captured this on his phone', '', '']];

  // One fetch double standing in for THREE real endpoints: Google's token
  // endpoint, the Sheets v4 API, and the local Mnestra webhook. Every assertion
  // below is on the exact bytes each would receive.
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const u = String(url);
    if (u === TOKEN_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.FAKE', expires_in: 3599 }) };
    }
    if (u.startsWith('https://sheets.googleapis.com/v4/spreadsheets/') && (init.method || 'GET') === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ range: 'x', majorDimension: 'ROWS', values: sheetValues }) };
    }
    if (u.endsWith('/values:batchUpdate')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ totalUpdatedCells: 2 }) };
    }
    if (u === 'http://localhost:37778/mnestra') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: 'inbox-uuid-e2e', status: 'pending' }) };
    }
    throw new Error(`unexpected request: ${u}`);
  };

  const fs = memFs();
  const env = hermeticEnv({
    TERMDECK_SHEETS_INTAKE_ENABLED: '1',
    TERMDECK_SHEETS_SPREADSHEET_ID: '1AbC_dEf-Ghi',
    TERMDECK_SHEETS_TAB: 'Intake',
    TERMDECK_SHEETS_DEFAULT_PROJECT: 'termdeck',
    TERMDECK_SHEETS_SA_EMAIL: 'harvester@proj.iam.gserviceaccount.com',
    TERMDECK_SHEETS_SA_PRIVATE_KEY: KEYPAIR.privateKey,
    MNESTRA_WEBHOOK_SECRET: 'shhh',
  });

  const harvester = createHarvester({ env, fetchImpl, ledger: ledgerOn(fs), logger: () => {}, now: FIXED_NOW });
  const report = await harvester.run();

  assert.equal(report.proposed, 1);
  assert.equal(report.proposals[0].id, 'inbox-uuid-e2e');
  assert.equal(report.proposals[0].sourceAgent, 'gemini-web');

  // 1. token exchange — form-encoded jwt-bearer grant with a verifiable JWT
  const token = requests.find((r) => r.url === TOKEN_URL);
  assert.equal(token.init.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(token.init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = JSON.parse(Buffer.from(form.get('assertion').split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, 'harvester@proj.iam.gserviceaccount.com');
  assert.equal(claims.scope, SHEETS_SCOPE);
  assert.equal(claims.aud, TOKEN_URL);

  // 2. the read — correct spreadsheet, A1 range, bearer token
  const read = requests.find((r) => r.init.method === 'GET' && r.url.includes('/values/'));
  assert.ok(read.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/1AbC_dEf-Ghi/values/'));
  assert.ok(read.url.includes(encodeURIComponent("'Intake'!A2:F")));
  assert.match(read.url, /majorDimension=ROWS/);
  assert.equal(read.init.headers.authorization, 'Bearer ya29.FAKE');

  // 3. the propose — the EXACT webhook contract, secret in a header only
  const propose = requests.find((r) => r.url === 'http://localhost:37778/mnestra');
  assert.equal(propose.init.headers['x-mnestra-secret'], 'shhh');
  const body = JSON.parse(propose.init.body);
  assert.equal(body.op, 'propose');
  assert.equal(body.source_agent, 'gemini-web');
  assert.equal(body.text, 'Josh captured this on his phone');
  assert.equal(body.project_hint, 'termdeck');
  assert.equal(body.metadata.sheets.spreadsheet_id, '1AbC_dEf-Ghi');
  assert.equal(body.metadata.sheets.row, 2);
  assert.match(body.metadata.sheets.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(propose.init.body).includes('BEGIN PRIVATE KEY'), 'no credential material on the wire');

  // 4. the stamp — RAW write of forwarded_at into E2:F2 only
  const stampReq = requests.find((r) => r.url.endsWith('/values:batchUpdate'));
  const stamp = JSON.parse(stampReq.init.body);
  assert.equal(stamp.valueInputOption, 'RAW');
  assert.equal(stamp.data.length, 1);
  assert.equal(stamp.data[0].range, "'Intake'!E2:F2");
  assert.equal(stamp.data[0].values[0][0], new Date(FIXED_NOW()).toISOString());

  // 5. durable ledger record closes the loop
  const recs = ledgerRecords(fs);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.phase), [PHASES.INFLIGHT, PHASES.FORWARDED]);
  assert.equal(recs[1].inbox_id, 'inbox-uuid-e2e');

  // 6. rerun against the SAME sheet state (stamp lost) proposes nothing new
  const rerun = await createHarvester({ env, fetchImpl, ledger: ledgerOn(fs), logger: () => {}, now: FIXED_NOW }).run();
  assert.equal(rerun.proposed, 0);
  assert.equal(rerun.restamped, 1);
  assert.equal(requests.filter((r) => r.url === 'http://localhost:37778/mnestra').length, 1, 'exactly one proposal, ever');
});

test('createSheetsApi refuses to construct without a token provider', () => {
  assert.throws(() => createSheetsApi({}), /requires a getToken/);
});

test('the mnestra client the harvester uses is the SAME one the propose tool uses', () => {
  // Guard against a future fork: this client must expose propose() and no other
  // write op (no remember/forget), so the harvester cannot reach memory_items.
  const client = createMnestraClient({ env: { MNESTRA_WEBHOOK_URL: 'http://localhost:37778/mnestra' } });
  assert.equal(typeof client.propose, 'function');
  assert.equal(client.remember, undefined);
  assert.equal(client.forget, undefined);
  assert.equal(client.post, undefined);
});
