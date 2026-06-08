'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal JSON-over-HTTP helper for the Bridge's read-only data clients.
//
// Dependency-free (global `fetch`, Node >= 20). A per-request AbortController
// timeout guarantees a hung backend (TermDeck server / Mnestra webhook) can
// never hang the egress-sensitive Bridge process.
//
// NOTE on POST: the Mnestra webhook is addressed with HTTP POST + an `op` field,
// but the only ops the Bridge ever sends are READS ('recall' / 'search' /
// 'status'). Read-only is about side effects, not the HTTP verb — see
// clients/mnestra.js, which exposes no write op.
// ─────────────────────────────────────────────────────────────────────────────

async function requestJson(url, opts = {}) {
  const {
    method = 'GET',
    body,
    headers,
    fetchImpl,
    timeoutMs = 5000,
    signal,
  } = opts;

  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') {
    throw new Error('global fetch unavailable — Node >= 20 required (or pass fetchImpl)');
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await f(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body != null ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new Error(`request failed (${url}): ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }

  if (!res.ok) {
    const detail = json && (json.error || json.message)
      ? (json.error || json.message)
      : (text ? text.slice(0, 200) : '');
    const e = new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

module.exports = { requestJson };
