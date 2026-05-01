// Agent adapter registry — Sprint 44 T3
//
// Single source of truth for per-agent terminal behavior. Each adapter
// implements the contract documented in ./claude.js (and the memorialization
// doc § 4) — type detection, status patterns, transcript parsing, boot prompt
// templating, cost band. session.js consults this registry when analyzing
// PTY output so adding a new agent (Codex / Gemini / Grok in Sprint 45) is a
// new file in this directory + one entry in `AGENT_ADAPTERS` below — no
// switch statements to extend.
//
// Sprint 44 lands the Claude adapter only. The other agents stay on the
// in-file shim path in session.js until Sprint 45 T1-T3 ship their adapters
// and Sprint 45 T4 wires the launcher UI through the same registry.

const claude = require('./claude');

// Keyed by adapter name (NOT session.meta.type — adapters expose their own
// `sessionType` field for that mapping). Order is iteration order for the
// detect loop in session.js, so list more-specific adapters before less.
const AGENT_ADAPTERS = {
  claude,
};

// Convenience accessor — returns the adapter whose `sessionType` matches the
// session.meta.type value, or undefined if no adapter has claimed that type.
// session.js calls this in the hot path; keep it cheap.
function getAdapterForSessionType(type) {
  if (!type) return undefined;
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    if (adapter.sessionType === type) return adapter;
  }
  return undefined;
}

// Convenience accessor — first adapter whose prompt regex matches `data` or
// whose `matches(command)` returns true. Returns undefined if no adapter
// claims the session, leaving the caller to fall back to legacy detection
// (gemini / python-server / shell). session.js calls this from `_detectType`.
function detectAdapter(data, command) {
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    const promptHit = adapter.patterns
      && adapter.patterns.prompt
      && typeof data === 'string'
      && adapter.patterns.prompt.test(data);
    const cmdHit = typeof adapter.matches === 'function' && adapter.matches(command);
    if (promptHit || cmdHit) return adapter;
  }
  return undefined;
}

module.exports = {
  AGENT_ADAPTERS,
  getAdapterForSessionType,
  detectAdapter,
};
