'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets v4 — the two calls the intake ramp needs (Sprint 84 / T1).
//
//   readRange()         GET  /v4/spreadsheets/{id}/values/{A1}
//   batchUpdateValues() POST /v4/spreadsheets/{id}/values:batchUpdate
//
// Transport is the Bridge's own clients/http.js::requestJson — same timeout
// discipline, same {error}-folding on non-2xx — with a bearer token from
// google-auth.js attached per request.
//
// TWO SHAPES THAT BITE, both handled here rather than in the harvester:
//   1. Sheets OMITS trailing empty cells and trailing empty rows. A row the
//      operator only filled through column D comes back length 4, not 6. The
//      `cell()` helper (harvest/sheets.js) treats a missing index as ''.
//   2. A1 tab titles need single-quoting, and an apostrophe inside a title is
//      escaped by DOUBLING it. `Josh's Inbox` → `'Josh''s Inbox'`. Getting this
//      wrong silently addresses the WRONG RANGE rather than erroring.
// ─────────────────────────────────────────────────────────────────────────────

const { requestJson } = require('../clients/http');

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// A1 tab reference per the Sheets grammar: always single-quoted (so spaces,
// digits-leading, and reserved words are all safe), inner ' doubled.
function quoteTab(tab) {
  return `'${String(tab == null ? '' : tab).replace(/'/g, "''")}'`;
}

// createSheetsApi({ getToken, fetchImpl?, timeoutMs?, baseUrl? })
function createSheetsApi(opts = {}) {
  const getToken = opts.getToken;
  if (typeof getToken !== 'function') {
    throw new Error('createSheetsApi requires a getToken() provider');
  }
  const base = opts.baseUrl || SHEETS_BASE;
  const reqOpts = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 15000 };

  async function authed(url, init) {
    const token = await getToken();
    return requestJson(url, {
      ...init,
      ...reqOpts,
      headers: { authorization: `Bearer ${token}`, ...((init && init.headers) || {}) },
    });
  }

  return {
    baseUrl: base,

    // → string[][] (never null; trailing empties omitted by the API, see above)
    async readRange(spreadsheetId, a1Range) {
      const url = `${base}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range)}`
        + '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE';
      const body = await authed(url, { method: 'GET' });
      return Array.isArray(body && body.values) ? body.values : [];
    },

    // data: [{ range: "'Tab'!E7:F7", values: [[...]] }, ...] → { updatedCells }
    // RAW so an ISO timestamp lands as the literal string the harvester wrote
    // (USER_ENTERED would let Sheets re-interpret it as a locale-formatted date
    // and hand back something the next run cannot round-trip).
    async batchUpdateValues(spreadsheetId, data) {
      const rows = Array.isArray(data) ? data.filter(Boolean) : [];
      if (!rows.length) return { updatedCells: 0 };
      const url = `${base}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;
      const body = await authed(url, {
        method: 'POST',
        body: {
          valueInputOption: 'RAW',
          data: rows.map((d) => ({ range: d.range, majorDimension: 'ROWS', values: d.values })),
        },
      });
      return { updatedCells: body && body.totalUpdatedCells != null ? Number(body.totalUpdatedCells) : 0 };
    },
  };
}

module.exports = { createSheetsApi, quoteTab, SHEETS_BASE };
