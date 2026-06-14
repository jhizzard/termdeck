'use strict';

// Sprint 78 T2 — shared server-sequenced PTY submit. The SINGLE source of truth
// for the v1.10.1 `{submit:true}` mechanism (Sprint 76.1, Bug B): write the
// body, await a server-held settle, then write a LONE `\r` as its own PTY write.
// Because the server owns the ordering — two distinct writes separated by a real
// awaited gap — the OS chunk-boundary race that the BANNED single-stage
// `<text>\x1b[201~\r` suffers is impossible.
//
// Extracted from the POST /api/sessions/:id/input route so that route AND the
// Sprint 78 advisor delivery path call ONE code path and can never drift (T4
// audit 19:11 — "factor the production helper so /input and the advisor share
// it"). The route maps the structured result to HTTP; the advisor maps it to
// advisory_events telemetry.
//
// NEVER throws — returns a structured result. The caller passes already-
// CRLF-normalized text (the route normalizes `\r\n?`/`\n` → `\r` before calling,
// for zsh/readline Enter semantics); this helper only strips the trailing CR so
// the body never self-submits.

function resolveSettleMs(explicit) {
  if (explicit !== undefined && explicit !== null) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const raw = process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS;
  const parsed = Number(raw);
  return (raw !== undefined && raw !== '' && Number.isFinite(parsed) && parsed >= 0) ? parsed : 400;
}

// submitToPty(session, text, options?) →
//   { ok, submitted, bytes, settleMs?, reason?, error? }
// reasons: 'no_pty' | 'exited_mid_settle' | 'write_error'
async function submitToPty(session, text, options = {}) {
  const settleMs = resolveSettleMs(options.settleMs);
  const sleep = (typeof options.sleep === 'function')
    ? options.sleep
    : (ms) => new Promise((r) => setTimeout(r, ms));

  // Strip any trailing CR so the body never self-submits; the lone `\r` below is
  // the one and only submit keystroke.
  const body = String(text == null ? '' : text).replace(/\r+$/, '');

  if (!session || !session.pty) return { ok: false, submitted: false, reason: 'no_pty', bytes: 0 };

  try {
    if (body) {
      session.pty.write(body);
      if (typeof session.trackInput === 'function') session.trackInput(body);
    }
    await sleep(settleMs);
    // The PTY can be torn down DURING the server-held settle (panel closed
    // mid-submit). Re-validate before the submit keystroke so the caller can
    // tell "panel closed mid-submit" from a real write error.
    if (!session.pty || (session.meta && session.meta.status === 'exited')) {
      return { ok: false, submitted: false, reason: 'exited_mid_settle', bytes: body.length };
    }
    session.pty.write('\r');
    if (typeof session.trackInput === 'function') session.trackInput('\r');
    return { ok: true, submitted: true, bytes: body.length + 1, settleMs };
  } catch (err) {
    return {
      ok: false, submitted: false, reason: 'write_error',
      error: err && err.message ? err.message : String(err), bytes: 0,
    };
  }
}

module.exports = { submitToPty, resolveSettleMs };
