// Sprint 59 T2 — PTY shell fallback chain helper (Brad #5).
//
// Pre-Sprint-59 the call site at packages/server/src/index.js:958 was:
//   const spawnShell = isPlainShell ? cmdTrim : (config.shell || '/bin/zsh');
// Three failure modes converged on minimal Linux: (a) config.shell empty/unread
// because the YAML key was wiped or never set, (b) $SHELL ignored entirely,
// (c) /bin/zsh absent on the host. Result was a silent
// `execvp(3) failed: No such file or directory` from pty.spawn. The user's
// login shell was bypassed.
//
// /bin/sh is universally present on POSIX; /bin/zsh is not. The chain is:
// explicit cmdTrim → user's config.shell → $SHELL → /bin/sh universal floor.
// Caller (index.js) still owns the isPlainShell vs. -c branching; this helper
// only resolves the FALLBACK chain for the !isPlainShell branch (and for any
// future caller that wants a single-source-of-truth shell pick).
//
// The function intentionally treats "" and undefined identically — both
// participate in the falsy-OR chain. That matches how config.shell ends up
// empty when the user has `shell:` (no value) in ~/.termdeck/config.yaml,
// and how process.env.SHELL is undefined on container-like environments
// that strip the inherited shell var.

function resolveSpawnShell(cmdTrim, configShell, envShell) {
  return cmdTrim || configShell || envShell || '/bin/sh';
}

module.exports = { resolveSpawnShell };
