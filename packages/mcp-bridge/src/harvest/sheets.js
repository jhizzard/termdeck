'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets → memory_inbox harvester (Sprint 84 / T1, arc step 4.2).
//
// The quick-capture path: Josh (or Gemini-web, or a phone shortcut) appends a
// row to a sheet; this forwards it into the SAME quarantined inbox the Bridge's
// memory_propose tool writes to, and stamps the row as forwarded.
//
// REUSE, NOT FORK. The forward is `clients/mnestra.js::propose()` — the exact
// module tools/propose.js:255 calls, hitting the webhook's `propose` op with
// the `x-mnestra-secret` header. No new RPC, no new column, no new wire shape:
// the row fingerprint rides inside the free-form `metadata` JSONB, so
// memory_inbox is untouched (PLANNING contract 1 needs no SCHEMA-READY).
//
// WHY source_agent IS RESOLVED HERE AND NOT THE WAY propose.js DOES IT.
// tools/propose.js derives identity from the per-request OAuth client because a
// WEB CHAT must not be able to claim another surface. A local supervised
// harvester has no OAuth request to derive from. So identity comes from the
// row's own `source` column, validated against the same canonical vocabulary
// (policy.js::normalizeWebSourceAgent — imported read-only), defaulting to
// `gemini-web` per PLANNING contract 3 when the cell is blank. A cell that is
// non-blank but INVALID is quarantined, never coerced: silently turning a typo
// into `gemini-web` would launder a wrong provenance into canonical memory.
//
// THE INGRESS SCAN APPLIES HERE TOO. A sheet row is ingress that, once
// promoted, egresses into every CLI recall — the same inverted threat model
// redact.js exists for. So the payload is scanned with the identical rule set
// and the identical policy: REJECT, never scrub-and-forward. The note written
// back into the sheet names the RULE CLASS only, never the matched text.
//
// APPEND-ONLY, MARK-FORWARDED-NEVER-DELETE. Nothing here deletes, reorders, or
// rewrites an operator cell. The only cells written are E (forwarded_at) and
// F (note) — and F is only overwritten when it is empty or carries this
// harvester's own marker, so an operator's own note is never clobbered.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');

const { scanDeep } = require('../redact');
const { normalizeWebSourceAgent, WEB_SOURCE_AGENTS } = require('../policy');
const { TEXT_MAX_CHARS, PROJECT_HINT_MAX_CHARS, METADATA_MAX_BYTES } = require('../tools/propose');
const { quoteTab } = require('./sheets-api');
const { PHASES } = require('./ledger');

// Column layout — see docs/SHEETS-INTAKE.md § Sheet schema.
//   A ts | B source | C project | D text | E forwarded_at | F note
const COL = Object.freeze({ ts: 0, source: 1, project: 2, text: 3, forwardedAt: 4, note: 5 });
const FIRST_COL = 'A';
const LAST_COL = 'F';

const DEFAULT_TAB = 'Intake';
const DEFAULT_SOURCE_AGENT = 'gemini-web'; // PLANNING contract 3
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_POLL_MS = 300_000; // 5 min
const HARVESTER_ID = 'termdeck-sheets-intake/1';

// Every note this harvester writes starts with this marker. Cells that do NOT
// start with it are treated as operator-authored and are never overwritten.
const NOTE_MARKER = '[harvest]';

// clients/mnestra.js:138 reframes a webhook 400 with exactly this prefix. A 400
// is the ONLY definitive "your proposal was not stored" signal — anything else
// (timeout, 5xx, socket error) is indeterminate and must NOT be retried.
const REFUSAL_PREFIX = 'proposal refused by the memory inbox:';

// Fingerprint field separator. NUL cannot occur in any sheet cell, so no
// combination of (sheet, tab, row, text) values can collide by running two
// fields together. Written as an ESCAPE, never a literal byte: a raw NUL in a
// source file makes grep/diff treat the whole file as binary and silently skip
// it — which is exactly how a line hides from an audit.
const FIELD_SEP = '\u0000';

function normalizeText(v) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
}

// Sheets omits trailing empty cells, so a short row is normal, not malformed.
function cell(row, idx) {
  return normalizeText(Array.isArray(row) ? row[idx] : undefined);
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function posInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── fingerprint — ONE definition, two jobs ───────────────────────────────────

// Deterministic per (sheet, tab, row, and every operator-authored cell).
//
// It answers BOTH questions the harvester has to ask, and it must be a single
// function to do so:
//   1. dedup    — "have I already proposed this row?" (the ledger key)
//   2. the gate — "is the row I am about to mark forwarded still the row I
//                  acted on?" (the pre-stamp guard)
//
// This started as two hashes — a narrow (sheet,tab,row,text) dedup key and a
// wider A–D state guard — and the gap between them was a bug: editing only the
// project column produced an UNCHANGED dedup key, so the second pass found the
// row already 'forwarded' in the ledger, made no proposal, and stamped over the
// edit. Two definitions of "same row" is exactly how content gets silently
// dropped. There is now one.
//
// Covers A–D (ts, source, project, text) — every cell that feeds the proposal
// payload, including `ts`, which becomes `captured_at`. E (forwarded_at) and F
// (note) are excluded because those are ours to write; including them would
// make every stamp invalidate itself.
//
// Row index is part of it BECAUSE the sheet is append-only and never reordered
// — that invariant is what the whole dedup scheme rests on, and why the
// harvester refuses to delete or reorder rows itself.
//
// Values are normalized (trimmed) before hashing, so re-typing the same text
// with different surrounding whitespace is not a new proposal.
function rowFingerprint({ spreadsheetId, tab, row, cells }) {
  const h = crypto.createHash('sha256');
  h.update(String(spreadsheetId));
  h.update(FIELD_SEP);
  h.update(String(tab));
  h.update(FIELD_SEP);
  h.update(String(row));
  h.update(FIELD_SEP);
  for (const idx of [COL.ts, COL.source, COL.project, COL.text]) {
    h.update(cell(cells, idx));
    h.update(FIELD_SEP);
  }
  return h.digest('hex');
}

// ── config ───────────────────────────────────────────────────────────────────

function loadHarvestConfig(env = process.env) {
  const spreadsheetId = String(env.TERMDECK_SHEETS_SPREADSHEET_ID || '').trim();
  const tab = String(env.TERMDECK_SHEETS_TAB || DEFAULT_TAB).trim() || DEFAULT_TAB;
  const defaultSourceAgent = normalizeWebSourceAgent(env.TERMDECK_SHEETS_DEFAULT_SOURCE_AGENT)
    || DEFAULT_SOURCE_AGENT;
  return {
    enabled: String(env.TERMDECK_SHEETS_INTAKE_ENABLED || '') === '1',
    spreadsheetId,
    tab,
    headerRows: posInt(env.TERMDECK_SHEETS_HEADER_ROWS, 1),
    defaultProject: String(env.TERMDECK_SHEETS_DEFAULT_PROJECT || '').trim() || undefined,
    defaultSourceAgent,
    maxRowsPerRun: posInt(env.TERMDECK_SHEETS_MAX_ROWS_PER_RUN, DEFAULT_MAX_ROWS),
    pollIntervalMs: posInt(env.TERMDECK_SHEETS_POLL_INTERVAL_MS, DEFAULT_POLL_MS),
  };
}

// ── row classification ───────────────────────────────────────────────────────

// classifyRow(cells, cfg) → { kind: 'blank' | 'forwarded' | 'quarantine' | 'ready', ... }
// Pure and deterministic: quarantine state is RE-DERIVED every run rather than
// recorded in the ledger, so fixing any offending cell (not just the text)
// un-sticks the row on the next pass.
function classifyRow(cells, cfg = {}) {
  const anyContent = (Array.isArray(cells) ? cells : []).some((c) => normalizeText(c) !== '');
  if (!anyContent) return { kind: 'blank' };

  if (cell(cells, COL.forwardedAt)) return { kind: 'forwarded' };

  const text = cell(cells, COL.text);
  if (!text) {
    return { kind: 'quarantine', reason: 'empty text — column D is required' };
  }
  if (text.length > TEXT_MAX_CHARS) {
    return { kind: 'quarantine', reason: `text is ${text.length} chars, over the ${TEXT_MAX_CHARS} cap — shorten it` };
  }

  let sourceAgent = cfg.defaultSourceAgent || DEFAULT_SOURCE_AGENT;
  const rawSource = cell(cells, COL.source);
  if (rawSource) {
    const mapped = normalizeWebSourceAgent(rawSource);
    if (!mapped) {
      return {
        kind: 'quarantine',
        reason: `unknown source "${truncate(rawSource, 40)}" — use one of ${WEB_SOURCE_AGENTS.join(' | ')}, or leave column B blank`,
      };
    }
    sourceAgent = mapped;
  }

  const project = cell(cells, COL.project) || cfg.defaultProject || '';
  if (project.length > PROJECT_HINT_MAX_CHARS) {
    return { kind: 'quarantine', reason: `project is ${project.length} chars, over the ${PROJECT_HINT_MAX_CHARS} cap` };
  }

  return {
    kind: 'ready',
    text,
    sourceAgent,
    project: project || undefined,
    capturedAt: cell(cells, COL.ts) || null,
  };
}

// ── the harvest pass ─────────────────────────────────────────────────────────

function noteFor(kind, detail) {
  if (kind === 'quarantine') return `${NOTE_MARKER} not forwarded: ${truncate(detail, 220)}`;
  if (kind === 'uncertain') return `${NOTE_MARKER} in-flight when the harvester stopped — NOT re-proposed; check the inbox before re-entering this row`;
  if (kind === 'refused') return `${NOTE_MARKER} refused by the memory inbox: ${truncate(detail, 200)} — edit the text to retry`;
  return '';
}

// A note cell is ours to write iff it is empty or already one of ours.
function noteIsWritable(existing) {
  const s = normalizeText(existing);
  return !s || s.startsWith(NOTE_MARKER);
}

// harvestOnce({ sheets, mnestra, ledger, env?, now?, logger? }) → report
//
// One full pass. Never throws for a single bad row — a row failure is recorded
// and the batch continues (acceptance bar: "never silently dropped, never fatal
// to the batch"). Only an unreachable Sheets API aborts the pass.
async function harvestOnce(deps = {}) {
  const { sheets, mnestra, ledger } = deps;
  if (!sheets || typeof sheets.readRange !== 'function' || typeof sheets.batchUpdateValues !== 'function') {
    throw new Error('harvestOnce requires a sheets API ({ readRange, batchUpdateValues })');
  }
  if (!mnestra || typeof mnestra.propose !== 'function') {
    throw new Error('harvestOnce requires the mnestra client ({ propose })');
  }
  if (!ledger || typeof ledger.load !== 'function' || typeof ledger.append !== 'function') {
    throw new Error('harvestOnce requires a ledger ({ load, append })');
  }
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const log = deps.logger || (() => {});
  const cfg = deps.config || loadHarvestConfig(env);

  if (!cfg.spreadsheetId) {
    throw new Error(
      'TERMDECK_SHEETS_SPREADSHEET_ID is not set — nothing to harvest. See docs/SHEETS-INTAKE.md § Activation.',
    );
  }

  const report = {
    scanned: 0,
    blank: 0,
    alreadyForwarded: 0,
    proposed: 0,
    restamped: 0,
    quarantined: 0,
    refused: 0,
    uncertain: 0,
    deferred: 0, // hit the per-run cap — NOT dropped, picked up next pass
    mutatedSkipped: 0, // row changed between read and stamp — deliberately NOT stamped
    proposals: [], // { row, fingerprint, id, sourceAgent }
    problems: [], // { row, kind, reason }
  };

  const firstDataRow = cfg.headerRows + 1;
  const range = `${quoteTab(cfg.tab)}!${FIRST_COL}${firstDataRow}:${LAST_COL}`;
  const rows = await sheets.readRange(cfg.spreadsheetId, range);
  const seen = ledger.load();
  const writes = [];

  // Every queued write carries the row's fingerprint AS READ, so the pre-stamp
  // verification below can drop it if the operator edited the row mid-pass.
  // Same value as the ledger key — one definition, deliberately.
  const stamp = (rowNumber, forwardedAt, note, cells, guard) => {
    if (!noteIsWritable(cell(cells, COL.note))) {
      // Preserve an operator-authored note: stamp E only.
      writes.push({ range: `${quoteTab(cfg.tab)}!E${rowNumber}`, values: [[forwardedAt]], row: rowNumber, guard });
      return;
    }
    writes.push({
      range: `${quoteTab(cfg.tab)}!E${rowNumber}:F${rowNumber}`, values: [[forwardedAt, note]], row: rowNumber, guard,
    });
  };

  // Note-only write (column F). Idempotent: skips when the note would not
  // change, and never touches an operator-authored note.
  const noteOnly = (rowNumber, note, cells, guard) => {
    const existingNote = cell(cells, COL.note);
    if (!noteIsWritable(existingNote) || existingNote === note) return;
    writes.push({
      range: `${quoteTab(cfg.tab)}!F${rowNumber}`, values: [[note]], row: rowNumber, guard,
    });
  };

  for (let i = 0; i < rows.length; i += 1) {
    // SNAPSHOT the row (shallow copy of immutable strings). Everything below —
    // including the state hash the pre-stamp gate compares against — must
    // reflect the row AS READ. Holding a live reference would let a mid-pass
    // mutation quietly update the guard too, and the gate would compare the new
    // state against itself and always pass, defeating the check.
    const cells = (rows[i] || []).slice();
    const rowNumber = firstDataRow + i;
    report.scanned += 1;

    // Computed ONCE, from the snapshot, before anything can await. Serves as
    // both the ledger dedup key and the pre-stamp guard.
    const fingerprint = rowFingerprint({
      spreadsheetId: cfg.spreadsheetId, tab: cfg.tab, row: rowNumber, cells,
    });

    const cls = classifyRow(cells, cfg);
    if (cls.kind === 'blank') {
      report.blank += 1;
      continue;
    }
    if (cls.kind === 'forwarded') {
      report.alreadyForwarded += 1;
      continue;
    }
    if (cls.kind === 'quarantine') {
      report.quarantined += 1;
      report.problems.push({ row: rowNumber, kind: 'quarantine', reason: cls.reason });
      noteOnly(rowNumber, noteFor('quarantine', cls.reason), cells, fingerprint);
      continue;
    }

    // ── already known to the ledger: never propose twice ──────────────────
    const prior = seen.get(fingerprint);
    if (prior) {
      if (prior.phase === PHASES.FORWARDED) {
        // Crash landed between the insert and the sheet stamp. Repair the sheet
        // from the ledger instead of re-proposing.
        report.restamped += 1;
        stamp(rowNumber, String(prior.forwarded_at || new Date(now()).toISOString()), '', cells, fingerprint);
      } else if (prior.phase === PHASES.REJECTED) {
        report.refused += 1;
        report.problems.push({ row: rowNumber, kind: 'refused', reason: prior.reason || 'refused' });
        noteOnly(rowNumber, noteFor('refused', prior.reason || 'refused'), cells, fingerprint);
      } else {
        // inflight — indeterminate. Stamp it so it leaves the working set, and
        // say so plainly. One visible maybe-duplicate beats a silent one.
        report.uncertain += 1;
        report.problems.push({ row: rowNumber, kind: 'uncertain', reason: 'in-flight at crash; not re-proposed' });
        stamp(rowNumber, String(prior.ts || new Date(now()).toISOString()), noteFor('uncertain'), cells, fingerprint);
      }
      continue;
    }

    if (report.proposed >= cfg.maxRowsPerRun) {
      report.deferred += 1;
      continue; // picked up on the next pass — bounded work, nothing dropped
    }

    // ── ingress secret scan: REJECT, never scrub-and-forward ──────────────
    const metadata = {
      sheets: {
        fingerprint,
        spreadsheet_id: cfg.spreadsheetId,
        tab: cfg.tab,
        row: rowNumber,
        captured_at: cls.capturedAt,
        harvester: HARVESTER_ID,
      },
    };
    const payload = { text: cls.text, project_hint: cls.project, metadata };
    const scanRes = scanDeep(payload, { env });
    if (!scanRes.clean) {
      const classes = scanRes.hits.map((h) => h.name).join(', ');
      report.quarantined += 1;
      report.problems.push({ row: rowNumber, kind: 'quarantine', reason: `secret/denylist rule class(es): ${classes}` });
      noteOnly(
        rowNumber,
        noteFor('quarantine', `contains material matching secret/denylist rule class(es): ${classes}. Remove it and rephrase`),
        cells,
        fingerprint,
      );
      continue;
    }

    const metaBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
    if (metaBytes > METADATA_MAX_BYTES) {
      report.quarantined += 1;
      report.problems.push({ row: rowNumber, kind: 'quarantine', reason: `metadata ${metaBytes}B over cap` });
      noteOnly(rowNumber, noteFor('quarantine', `metadata is ${metaBytes} bytes, over the ${METADATA_MAX_BYTES} cap`), cells, fingerprint);
      continue;
    }

    // ── write-ahead, then propose, then resolve ───────────────────────────
    const startedAt = new Date(now()).toISOString();
    ledger.append({ fingerprint, phase: PHASES.INFLIGHT, ts: startedAt, row: rowNumber, tab: cfg.tab });

    let result = null;
    try {
      result = await mnestra.propose({
        sourceAgent: cls.sourceAgent,
        text: cls.text,
        projectHint: cls.project,
        metadata,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.startsWith(REFUSAL_PREFIX)) {
        // Definitive: the inbox validated and refused. Safe to record as
        // resolved — nothing was stored — and safe to surface to the operator.
        const reason = msg.slice(REFUSAL_PREFIX.length).trim() || 'refused';
        ledger.append({ fingerprint, phase: PHASES.REJECTED, ts: new Date(now()).toISOString(), row: rowNumber, reason });
        report.refused += 1;
        report.problems.push({ row: rowNumber, kind: 'refused', reason });
        noteOnly(rowNumber, noteFor('refused', reason), cells, fingerprint);
      } else {
        // Indeterminate (timeout / 5xx / socket). The inflight record stands,
        // so this row is never re-proposed. Mark it visibly and move on — one
        // more row must not fail the batch.
        report.uncertain += 1;
        report.problems.push({ row: rowNumber, kind: 'uncertain', reason: truncate(msg, 200) });
        stamp(rowNumber, startedAt, noteFor('uncertain'), cells, fingerprint);
        log(`sheets-harvest: row ${rowNumber} indeterminate — ${truncate(msg, 160)}`);
      }
      continue;
    }

    ledger.append({
      fingerprint,
      phase: PHASES.FORWARDED,
      ts: startedAt,
      forwarded_at: startedAt,
      row: rowNumber,
      inbox_id: result && result.id ? String(result.id) : null,
      source_agent: cls.sourceAgent,
    });
    report.proposed += 1;
    report.proposals.push({
      row: rowNumber, fingerprint, id: result && result.id ? String(result.id) : null, sourceAgent: cls.sourceAgent,
    });
    stamp(rowNumber, startedAt, '', cells, fingerprint);
  }

  // ── VERIFY BEFORE STAMP ────────────────────────────────────────────────────
  // The sheet was read once at the top of the pass, and everything above acted
  // on that snapshot. But the operator may have edited a row while we were
  // proposing — this is a live document, and a phone capture takes seconds.
  // Stamping forwarded_at by ROW NUMBER against a stale snapshot would mark the
  // row's CURRENT text as forwarded even though only the OLD text was ever
  // proposed, and since a stamped row is skipped forever, the edit would be
  // silently lost. That is data loss, not a race we can shrug at.
  //
  // So: re-read immediately before writing, and drop any write whose row no
  // longer hashes to the state we acted on. Dropping is self-healing — the row
  // stays unforwarded, and the next pass either re-stamps it from the ledger
  // (text unchanged, same fingerprint) or proposes the CURRENT text as a
  // genuinely new fingerprint (text changed). Neither outcome is a duplicate,
  // which is exactly what the content-hash fingerprint buys us.
  //
  // This narrows the window to the re-read→write gap; it does not close it
  // (Sheets values.batchUpdate has no compare-and-swap). Closing it entirely
  // would need a per-row revision check the API does not offer. The residual
  // window is milliseconds instead of the whole propose pass.
  if (writes.length) {
    let pending = [];
    try {
      const fresh = await sheets.readRange(cfg.spreadsheetId, range);
      pending = writes.filter((w) => {
        const current = fresh[w.row - firstDataRow] || [];
        const currentFp = rowFingerprint({
          spreadsheetId: cfg.spreadsheetId, tab: cfg.tab, row: w.row, cells: current,
        });
        if (currentFp === w.guard) return true;
        report.mutatedSkipped += 1;
        report.problems.push({
          row: w.row,
          kind: 'mutated',
          reason: 'row changed between read and stamp — deliberately NOT marked forwarded; the current content is re-proposed next pass',
        });
        log(`sheets-harvest: row ${w.row} changed mid-pass; stamp withheld so the edit is not lost`);
        return false;
      });
    } catch (err) {
      // Fail CLOSED: an unverified stamp is precisely the failure this gate
      // exists to prevent. Stamp nothing; the ledger is authoritative and the
      // next pass re-stamps every forwarded row.
      report.verifyFailed = true;
      report.verifyError = truncate(err && err.message ? err.message : String(err), 200);
      log(`sheets-harvest: pre-stamp re-read failed (${report.verifyError}); stamping nothing this pass — ledger is authoritative`);
      pending = [];
    }

    if (pending.length) {
      try {
        const res = await sheets.batchUpdateValues(cfg.spreadsheetId, pending);
        report.updatedCells = res && res.updatedCells != null ? res.updatedCells : 0;
      } catch (err) {
        report.writeBackFailed = true;
        report.writeBackError = truncate(err && err.message ? err.message : String(err), 200);
        log(`sheets-harvest: write-back failed (${report.writeBackError}); ledger is authoritative, next pass re-stamps`);
      }
    }
  }

  if (report.deferred) {
    // No silent caps — say what was left for the next pass.
    log(`sheets-harvest: per-run cap ${cfg.maxRowsPerRun} reached; ${report.deferred} row(s) deferred to the next pass`);
  }
  return report;
}

module.exports = {
  harvestOnce,
  classifyRow,
  rowFingerprint,
  loadHarvestConfig,
  normalizeText,
  cell,
  noteFor,
  noteIsWritable,
  COL,
  NOTE_MARKER,
  REFUSAL_PREFIX,
  HARVESTER_ID,
  DEFAULT_TAB,
  DEFAULT_SOURCE_AGENT,
  DEFAULT_POLL_MS,
};
