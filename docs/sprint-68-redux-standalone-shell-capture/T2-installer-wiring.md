# T2 — Installer wiring (install / refresh / uninstall / doctor)

You are T2 in Sprint 68-REDUX. Read PLANNING.md + docs/INSTALLER-PITFALLS.md first —
every change you make must trace to a PITFALLS class in your DONE post.

## You own (edit ONLY these)

- `packages/stack-installer/src/index.js` — NEW `installShellShims()` (+ helpers), wired
  into the main install flow behind the same consent pattern as `installPreCompactHook`
- `packages/cli/src/init-mnestra.js::runHookRefresh` — refresh path re-stages shims
- `packages/stack-installer/src/uninstall.js` — shim removal + rc-block splice
- Doctor probe surface (wherever the existing doctor probes live) — add the shim probes

## Mission

1. **`installShellShims()`**: create `~/.termdeck/shims/` (700), copy the three shims from
   `assets/shims/`, `chmod 755`. Idempotent — byte-identical shims present → "nothing to
   do". Changed content → back up (`.bak-<date>`) then overwrite (that's how shim upgrades
   ship; the audit-trail bump discipline applies).
2. **PATH block**: marker-fenced prepend in the user's rc file —
   `# >>> termdeck shims >>>` / `export PATH="$HOME/.termdeck/shims:$PATH"` /
   `# <<< termdeck shims <<<`. Detect the real login shell rc (zsh on this fleet; don't
   hardcode — `$SHELL` basename → `.zshrc`/`.bashrc`). Idempotent: fence present →
   skip. Malformed/absent rc → create-or-abort LOUDLY, never silently mangle
   (PITFALLS: backup-before-write, abort-on-weird).
3. **`runHookRefresh`**: re-stage shims + verify PATH fence, same report shape as the
   existing hook refresh.
4. **`uninstall.js`**: splice the fenced block exactly (fence-to-fence, nothing else),
   remove `~/.termdeck/shims/`, leave transcripts dir (user data — report, don't delete).
5. **Doctor probes** (Class I is the enemy — installed-but-never-fires):
   - `which <name>` resolves to the shim for all three (PATH order correct)
   - each shim's real-binary resolution succeeds (dry probe env var, e.g.
     `TERMDECK_SHIM_PROBE=1 <shim>` prints the resolved path and exits 0)
   - recursion sentinel behavior sane
   - report a missing real CLI as SKIP-with-reason, not failure (grok may be absent on a
     fresh machine; that is not an install error)

## Acceptance (your DONE requires all)

- Fresh install, re-run (nothing-to-do), upgrade (backup+overwrite), uninstall
  (fence spliced, shims gone, rc otherwise byte-identical) — all proven and posted.
- Doctor catches: shims dir missing from PATH; shim shadowed by an earlier PATH entry;
  real binary missing.
- Every change traces to a PITFALLS class; flag for T3 whether "PATH-shadowing drift"
  deserves formal class status (you build the evidence, T3 rules on the doc).
- No version bumps, no CHANGELOG, no commits.

Post `### [T2] FINDING/FIX-PROPOSED/FIX-LANDED/DONE 2026-MM-DD HH:MM ET — <gist>`.
