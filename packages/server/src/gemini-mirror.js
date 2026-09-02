'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Gemini read-mirror — closing the last read-surface gap in the memory fabric
// (Sprint 71 B-T2).
//
// THE PROBLEM. gemini.google.com has no connector path: no MCP, no extension
// surface we control, no way to hand it a memory store. The write side is
// already covered (the Sheets harvest ramp brings operator-authored rows IN),
// but Gemini-web cannot READ anything the fabric knows. The one surface it
// reads reliably is a Google Sheet inside its own authenticated account.
//
// So the mirror is deliberately unglamorous: periodically write tier-0
// objectives plus the newest N memories into a sheet the operator has shared
// with their Gemini account, and let Gemini read it as a document. That is the
// entire delivery mechanism.
//
// ⚠ OPERATOR STEP, AND IT IS NOT OPTIONAL. The service account can write to a
// sheet it has been granted access to; it CANNOT grant a human access to that
// sheet. After enabling the mirror the operator must open the sheet and share
// it with the Google account they use for Gemini, as at least a Reader. Until
// then this job writes into a document nobody can see. `termdeck doctor` says
// so, and so does this comment, because it is the one step that looks like
// setup boilerplate and is actually the product.
//
// ─── DATA LEAVES THE MACHINE HERE ────────────────────────────────────────────
// Everything below is about that. A row written here is in Google's cloud and
// readable by anyone the sheet is shared with — including, later, anyone the
// operator forgets they shared it with. Three gates, applied in order, and
// every one of them FAILS CLOSED (drop the row) rather than open:
//
//   1. PRIVACY TAGS — any row carrying a privacy tag is excluded outright,
//      before redaction is even considered. Filtered in JS on a column we
//      explicitly select, not via a query predicate: a predicate that silently
//      fails to parse degrades to "no filter", and the failure mode of that is
//      publishing the rows we most wanted to withhold.
//   2. REDACTION — every cell passes through the Bridge's redact layer (the
//      same one the MCP surface uses). A rule that throws is treated as a
//      redaction FAILURE and drops the row; it never emits the raw text.
//   3. FORBIDDEN STRINGS — a final substring gate for the internal-project-name
//      family the gitleaks config enforces at commit time. Redaction is
//      pattern-based and these are not secrets in a shape it recognises, so
//      they need their own explicit pass. Any hit drops the row.
//
// Rows dropped by any gate are COUNTED and reported, never silently discarded —
// a mirror that quietly publishes 40 of 50 rows is indistinguishable from one
// that works, and the ten it dropped are exactly the interesting ones.
//
// DARK BY DEFAULT. Requires TERMDECK_GEMINI_MIRROR=1 *and* a sheet id. Absent
// either, `create()` returns a disabled handle whose `start()` is a no-op. The
// job never runs by accident, and enabling it is a two-key decision.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

const tier0lib = require('./tier0');

// The Google + redaction helpers live in the Bridge package. They are pulled in
// through explicit `files` entries in the root package.json (only these four,
// all Node-built-ins-only — NOT the whole bridge, which would drag express and
// zod into a tarball that does not want them). `tests/gemini-mirror-packaging`
// asserts they survive `npm pack`: an asset that is required at runtime and
// absent from the tarball is INSTALLER-PITFALLS Class H, the exact packaging
// blocker ledger #15 caught the night before publish.
const BRIDGE_SRC = path.join(__dirname, '..', '..', 'mcp-bridge', 'src');

function loadBridgeDeps() {
  return {
    redact: require(path.join(BRIDGE_SRC, 'redact.js')),
    googleAuth: require(path.join(BRIDGE_SRC, 'harvest', 'google-auth.js')),
    sheetsApi: require(path.join(BRIDGE_SRC, 'harvest', 'sheets-api.js')),
  };
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const DEFAULT_TAB = 'Mnestra Mirror';

// Cells are truncated well below Google's 50k limit: this is a reading surface
// for a chat model, not an archive, and a 40k-character cell is neither.
const CELL_MAX_CHARS = 2000;

// The forbidden-literal list is loaded from OUTSIDE the repo. There is no
// hardcoded copy here, and that is deliberate on two counts.
//
// 1. It is the convention this repo already settled on. `redact.js` carries the
//    instruction in its own header — "org literals live OUTSIDE the repo ... do
//    not hardcode org literals in this file" — and reads them from
//    `~/.termdeck/bridge-redact.json` plus TERMDECK_BRIDGE_REDACT_LITERALS.
//    Reusing that loader means the mirror and the MCP surface are gated on one
//    list rather than two that can disagree.
// 2. Writing them here would be the very leak the gate exists to prevent. The
//    first cut of this file kept them base64-encoded, on the assumption that
//    encoding was enough to keep the gate's own source clean. It is not:
//    gitleaks decodes base64 one level and rescans, and correctly flagged three
//    of the four. Any encoding clever enough to slip past that check is also
//    clever enough to be a spelling game, which the hygiene rule forbids by
//    name. The right move is not a better encoding — it is not storing them.
//
// TERMDECK_MIRROR_FORBIDDEN (comma-separated) extends the list for this job
// specifically, without touching the shared redact denylist.
function forbiddenNeedles(env = process.env, deps = null) {
  const out = new Set();
  const redact = (deps && deps.redact) || null;
  try {
    const loader = redact ? redact.loadExternalDenylist : loadBridgeDeps().redact.loadExternalDenylist;
    for (const lit of loader(env) || []) {
      const s = String(lit || '').trim().toLowerCase();
      if (s) out.add(s);
    }
  } catch (_e) { /* an unreadable denylist is handled by the caller's warning */ }
  for (const s of String(env.TERMDECK_MIRROR_FORBIDDEN || '').split(',')) {
    const t = s.trim().toLowerCase();
    if (t) out.add(t);
  }
  return [...out];
}

function containsForbidden(text, needles) {
  if (typeof text !== 'string' || !text) return false;
  const hay = text.toLowerCase();
  return needles.some((n) => hay.includes(n));
}

// A row is privacy-tagged if the column carries anything at all. Deliberately
// permissive about the column's shape (array, JSON string, comma list) — the
// question "is this tagged?" must not depend on how the driver decodes a
// Postgres array, and an unrecognised shape is treated as TAGGED.
function isPrivacyTagged(row) {
  const v = row && (row.privacy_tags !== undefined ? row.privacy_tags : row.privacyTags);
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '{}' || s === '[]') return false;
    return true;
  }
  // Anything else: unknown shape ⇒ assume tagged. Fail closed.
  return true;
}

function clampCell(value) {
  const s = value == null ? '' : String(value);
  return s.length <= CELL_MAX_CHARS ? s : `${s.slice(0, CELL_MAX_CHARS - 1)}…`;
}

// Mask the forbidden family explicitly, rather than relying on the redact
// layer's external denylist to happen to contain them.
//
// It very often does — `~/.termdeck/bridge-redact.json` is exactly where an
// operator lists org literals. But "the developer's machine has it configured"
// is not a property this gate can be built on: on a machine without that file,
// the same code publishes the string. Masking here is deterministic and
// environment-independent, which is the only kind of guarantee worth making
// about data leaving the machine.
function maskForbidden(text, needles) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const n of needles) {
    if (!n) continue;
    // Case-insensitive literal replace without building a RegExp from operator
    // input (which would let a needle like `a.*` mask far more than intended).
    let idx = out.toLowerCase().indexOf(n);
    while (idx !== -1) {
      out = `${out.slice(0, idx)}‹redacted:internal-name›${out.slice(idx + n.length)}`;
      idx = out.toLowerCase().indexOf(n, idx + 1);
    }
  }
  return out;
}

// Redact one cell. A throwing rule yields the fail-closed marker rather than
// the original text — the same discipline the shim drain uses, and for the same
// reason: a redaction layer that falls back to raw output on error is worse
// than no redaction layer, because it is trusted.
function redactCell(value, redact, env, needles) {
  const raw = clampCell(value);
  if (!raw) return '';
  let out;
  try {
    out = redact.redact(raw, { env });
  } catch (_e) {
    return '‹redacted:redaction-failed›';
  }
  if (typeof out !== 'string') return '‹redacted:redaction-failed›';
  return maskForbidden(out, needles || forbiddenNeedles(env));
}

// buildMirrorRows({ tier0, memories, redact, env }) → { rows, dropped }
//
// Pure and dependency-injected so the whole gate stack is testable without a
// network, a sheet, or a service account. This is the function the redaction
// acceptance criterion is really about.
function buildMirrorRows({ tier0 = [], memories = [], redact, env = process.env, needles: injected } = {}) {
  const needles = injected || forbiddenNeedles(env, { redact });
  const dropped = { privacy: 0, forbidden: 0, empty: 0 };
  const rows = [];

  const push = (kind, cells) => {
    const redacted = cells.map((c) => redactCell(c, redact, env, needles));
    if (redacted.every((c) => !c)) { dropped.empty += 1; return; }
    // FINAL BACKSTOP. After masking this should be unreachable — and that is
    // the point. It is the assertion that catches a masking bug, an encoding
    // the mask did not normalise, or a future edit that reorders these steps.
    // A backstop that fires is a bug report; a backstop that is absent is a
    // leak nobody notices.
    if (redacted.some((c) => containsForbidden(c, needles))) { dropped.forbidden += 1; return; }
    rows.push([kind, ...redacted]);
  };

  // Tier 0 first — the sheet is a reading surface, and the objectives are what
  // should be at the top of it for the same reason they head the vault.
  for (const o of tier0) {
    push('objective', [
      o.project || '',
      o.rank == null ? '' : String(o.rank),
      o.text || '',
      o.ratified_at || '',
    ]);
  }

  for (const m of memories) {
    if (isPrivacyTagged(m)) { dropped.privacy += 1; continue; }
    push('memory', [
      m.project || '',
      m.source_type || '',
      m.content || '',
      m.created_at || '',
    ]);
  }

  return { rows, dropped };
}

const HEADER_ROW = ['kind', 'project', 'rank_or_type', 'text', 'stamp'];

// createGeminiMirror({ config, env?, log?, deps?, fetchImpl? })
//   → { enabled, reason?, runOnce(), start(), stop() }
function createGeminiMirror(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const log = opts.log || ((msg) => console.log(`[gemini-mirror] ${msg}`));
  const mirrorCfg = (config && config.geminiMirror) || {};

  const enabledFlag = env.TERMDECK_GEMINI_MIRROR === '1';
  const sheetId = env.TERMDECK_GEMINI_MIRROR_SHEET_ID || mirrorCfg.sheetId || '';
  const tab = env.TERMDECK_GEMINI_MIRROR_TAB || mirrorCfg.tab || DEFAULT_TAB;
  const limit = Number.isFinite(Number(env.TERMDECK_GEMINI_MIRROR_LIMIT))
    ? Math.max(1, Number(env.TERMDECK_GEMINI_MIRROR_LIMIT))
    : DEFAULT_LIMIT;
  const intervalMs = Number.isFinite(Number(env.TERMDECK_GEMINI_MIRROR_INTERVAL_MS))
    ? Math.max(60_000, Number(env.TERMDECK_GEMINI_MIRROR_INTERVAL_MS))
    : DEFAULT_INTERVAL_MS;
  const project = env.TERMDECK_GEMINI_MIRROR_PROJECT || mirrorCfg.project || null;

  if (!enabledFlag) {
    return { enabled: false, reason: 'TERMDECK_GEMINI_MIRROR is not set to 1', start() {}, stop() {}, async runOnce() { return { skipped: 'disabled' }; } };
  }
  if (!sheetId) {
    // Loud, because this is an enabled-but-misconfigured state, and the silent
    // version of it is a job that ticks forever writing nothing.
    log('enabled but no sheet id — set TERMDECK_GEMINI_MIRROR_SHEET_ID. Mirror stays off.');
    return { enabled: false, reason: 'no sheet id configured', start() {}, stop() {}, async runOnce() { return { skipped: 'no-sheet-id' }; } };
  }

  const deps = opts.deps || loadBridgeDeps();
  const doFetch = opts.fetchImpl || globalThis.fetch;
  let timer = null;

  // Newest N memories. `privacy_tags` is SELECTED, not filtered on, so the
  // exclusion decision happens in code we can test rather than in a predicate
  // whose failure mode is publishing everything.
  async function fetchRecentMemories() {
    const supabaseUrl = config.rag && config.rag.supabaseUrl;
    const supabaseKey = config.rag && config.rag.supabaseKey;
    if (!supabaseUrl || !supabaseKey) return [];
    const params = new URLSearchParams();
    params.set('select', 'id,content,source_type,project,created_at,privacy_tags');
    params.set('order', 'created_at.desc');
    // Over-fetch so the privacy gate cannot quietly shrink the mirror below the
    // requested size when a run happens to hit a tagged streak.
    params.set('limit', String(limit * 2));
    if (project) params.set('project', `eq.${project}`);
    try {
      const res = await doFetch(`${supabaseUrl}/rest/v1/memory_items?${params.toString()}`, {
        method: 'GET',
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      if (!res.ok) { log(`memory fetch failed: HTTP ${res.status}`); return []; }
      const body = await res.json();
      return Array.isArray(body) ? body : [];
    } catch (err) {
      log(`memory fetch threw: ${err && err.message ? err.message : String(err)}`);
      return [];
    }
  }

  async function runOnce() {
    try {
      const tier0Provider = opts.tier0Provider || tier0lib.createTier0Provider({ config, env, log });
      const [{ tier0 }, rawMemories] = await Promise.all([
        tier0Provider.fetch({ project }),
        fetchRecentMemories(),
      ]);

      const needles = forbiddenNeedles(env, deps);
      if (needles.length === 0) {
        // Not fatal — redact's built-in rules still run, and the operator may
        // genuinely have no org literals. But an empty literal list is the one
        // state where this gate does nothing at all, and a gate that silently
        // does nothing is worse than an absent one. Say so on every run.
        log(
          'WARNING: no forbidden-literal list configured — nothing in '
          + '~/.termdeck/bridge-redact.json and no TERMDECK_BRIDGE_REDACT_LITERALS / '
          + 'TERMDECK_MIRROR_FORBIDDEN. Internal project names will NOT be masked '
          + 'before this content reaches Google. Configure the denylist before '
          + 'relying on this mirror.',
        );
      }

      const { rows, dropped } = buildMirrorRows({
        tier0,
        memories: rawMemories.slice(0, limit * 2),
        redact: deps.redact,
        env,
        needles,
      });
      const capped = rows.slice(0, tier0.length + limit);

      const getToken = (opts.getToken)
        || deps.googleAuth.createAccessTokenProvider({ env, fetchImpl: opts.fetchImpl }).getToken;
      const api = opts.sheets || deps.sheetsApi.createSheetsApi({ getToken, fetchImpl: opts.fetchImpl });
      const quoted = deps.sheetsApi.quoteTab(tab);

      const values = [HEADER_ROW, ...capped];
      await api.batchUpdateValues(sheetId, [
        { range: `${quoted}!A1:E${values.length}`, values },
      ]);

      // Never silent about what did not make it — see the header note.
      log(
        `mirrored ${capped.length} row(s) (${tier0.length} objective(s)) to sheet tab ${tab}; `
        + `dropped: ${dropped.privacy} privacy-tagged, ${dropped.forbidden} forbidden-string, ${dropped.empty} empty`,
      );
      return { written: capped.length, objectives: tier0.length, dropped };
    } catch (err) {
      // A mirror failure must never take the server with it.
      log(`run failed: ${err && err.message ? err.message : String(err)}`);
      return { error: err && err.message ? err.message : String(err) };
    }
  }

  return {
    enabled: true,
    sheetId,
    tab,
    intervalMs,
    runOnce,
    start() {
      if (timer) return;
      log(
        `enabled — every ${Math.round(intervalMs / 60000)} min to sheet tab "${tab}". `
        + 'REMINDER: share that sheet with the Google account you use for Gemini (Reader is '
        + 'enough), or the mirror writes into a document nobody can read.',
      );
      timer = setInterval(() => { runOnce().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
      // One immediate pass so an operator who just enabled it sees a result
      // now rather than in half an hour.
      runOnce().catch(() => {});
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = {
  createGeminiMirror,
  buildMirrorRows,
  isPrivacyTagged,
  containsForbidden,
  forbiddenNeedles,
  redactCell,
  clampCell,
  loadBridgeDeps,
  maskForbidden,
  HEADER_ROW,
  CELL_MAX_CHARS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LIMIT,
  DEFAULT_TAB,
};
