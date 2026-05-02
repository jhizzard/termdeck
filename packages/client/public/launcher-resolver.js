// TermDeck launcher resolver — extracted Sprint 46 T4
//
// Pure function: given (command, project, agentAdapters, projects),
// returns the resolved spawn parameters the launcher POSTs to /api/sessions.
// Lives in its own file so the same code runs in the browser (via
// <script src="launcher-resolver.js">) AND under `node --test` (via
// `require('.../launcher-resolver')`). Sprint 46 T4 added this extraction
// to close a zero-coverage gap on the client-side routing logic — see
// tests/launcher-resolver.test.js for the contract pin.
//
// Sprint 45 T4 refactor lives here too: registry-driven shorthand
// resolution. Pre-Sprint-45 had hardcoded claude/cc/gemini/python branches;
// now the type detection consults `agentAdapters` (loaded from
// /api/agent-adapters at init), and only the Claude `cc` alias and the
// python-server detection (no adapter exists) stay as special-cases.
// Adapter matching uses an anchored prefix on the adapter's binary name
// (`^binary\b`, case-insensitive) which fits all four Sprint-45 adapters
// (claude / codex / gemini / grok) since each binary is uniquely named.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LauncherResolver = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function resolve(command, project, agentAdapters, projects) {
    let resolvedCommand = command;
    let resolvedType = 'shell';
    let resolvedCwd;
    let resolvedProject = project || undefined;

    let canonical = command;
    if (/^cc\b/i.test(canonical)) {
      canonical = canonical.replace(/^cc\b/i, 'claude');
    }

    const adapter = (agentAdapters || []).find((a) =>
      a && a.binary && new RegExp(`^${escapeRegex(a.binary)}\\b`, 'i').test(canonical)
    );

    if (adapter) {
      resolvedType = adapter.sessionType;
      if (adapter.name === 'claude') {
        const argMatch = canonical.match(/^claude\s+(?:code\s+)?(.+)/i);
        if (argMatch) {
          const arg = argMatch[1].trim();
          if (projects && projects[arg]) {
            resolvedProject = arg;
          } else {
            resolvedCwd = arg;
          }
        }
        resolvedCommand = adapter.binary;
      }
    } else if (/^python3?\b.*(?:runserver|uvicorn|flask|gunicorn|http\.server)/i.test(canonical)) {
      // Sprint 46 T4: extended `http\.server` so the python topbar
      // quick-launch button is preemptively typed correctly. Without
      // this, the badge flickers through `shell` for ~1s before
      // session.js's runtime detection (`/Serving HTTP on/`) catches up.
      resolvedType = 'python-server';
    }

    return { resolvedCommand, resolvedType, resolvedCwd, resolvedProject };
  }

  return { resolve };
});
