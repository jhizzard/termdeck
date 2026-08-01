# T1 — Shim core (PATH wrappers + PTY tee + exit drain)

You are T1 in Sprint 68-REDUX. Read PLANNING.md first — D0/D1′/D2′/D3′ are your contract.

## You own (edit ONLY these)

- `packages/stack-installer/assets/shims/` (NEW) — `shim-template.sh` + generated
  `codex` / `grok` / `agy` (or a single template + tiny per-CLI stanza; your call, but the
  installed artifacts are three executables named exactly like the real CLIs)
- The `TERMDECK_PANEL_SESSION` marker region of
  `packages/server/src/index.js::spawnTerminalSession` — ONE surgical Edit, post to STATUS
  before touching (shared file; T4 watches this seam)

## Mission

1. **Verify-then-add the D1′ marker.** Grep `spawnTerminalSession` for
   `TERMDECK_PANEL_SESSION`. If absent, add `TERMDECK_PANEL_SESSION=<session.id>` to the
   PTY child env. Post the FINDING either way — the dedup contract hangs on this.
2. **Shim skeleton** (bash, dependency-free, macOS-first):
   - Recursion sentinel: `TERMDECK_SHIM_ACTIVE=<name>` already set → `echo` loud error to
     stderr and `exit 70` (NEVER exec anything — a broken resolution must not fork-bomb).
   - Real-binary resolution: `which -a <name>` filtered to drop `~/.termdeck/shims/*` and
     any path equal to `$0`; take the first survivor. None → loud stderr + exit 127.
   - In-TermDeck guard: `TERMDECK_PANEL_SESSION` set → `exec` the real binary with `"$@"`
     (transparent; zero capture; `onPanelClose` owns the session).
   - Capture path: `script -q <transcript> <real-bin> "$@"` (BSD `script`; the CLI sees a
     real TTY). Transcript: `~/.termdeck/standalone-transcripts/<agent>-<epoch>-<pid>.log`
     (dir created 700). Preserve the child's exit code.
   - Exit drain (fail-soft — errors NEVER pollute the user's shell or change exit code):
     synthesize the Claude-Code-shaped stdin JSON (`session_id` = `uuidgen` lowercased,
     `transcript_path`, `cwd`, `hook_event_name: "SessionEnd"`) and pipe to the bundled
     `memory-session-end.js` with `TERMDECK_NATIVE_CLI_HOOK=<agent>` env. Resolve the hook
     at `~/.claude/hooks/memory-session-end.js` with the bundled asset as fallback.
   - Rotation: at spawn, prune transcripts >14 days old (guarded `find -delete`, only ever
     inside `standalone-transcripts/`).
3. **source_agent path check:** S70 T3 already landed `agy`/`antigravity` in the hook
   allowlist + resolution order (stdin → `TERMDECK_NATIVE_CLI_HOOK` → inference). Verify
   `codex`/`grok`/`agy` all resolve through that chain from the env var; fix the hook ONLY
   if a gap is proven, and mirror any edit to BOTH copies (`~/.claude/hooks/` is runtime,
   `packages/stack-installer/assets/hooks/` is canonical — bundled-mirror rule).
4. **Parser fit per CLI (D2′):** run each shim standalone for a short real session; confirm
   the hook's parser chain ingests the `script` transcript (raw PTY escapes are the same
   shape as panel rolling buffers). A pathological CLI gets a FINDING + D3′ gate-out
   proposal, not a new parser tier.
5. **Stretch (your judgment, post-core):** background checkpoint watcher — every 10 min,
   transcript grew ≥1 KB → fire `memory-pre-compact.js` in `periodic_checkpoint` mode;
   watcher dies with the child (no orphan loops — `kill -0` guard).

## Acceptance (your DONE requires all)

- All three shims: standalone canary session → correctly-labeled `session_summary` row
  (post the recall evidence); exit codes/args-with-spaces/stdin passthrough proven.
- Panel path: with shims on PATH, a TermDeck panel session produces EXACTLY one row.
- Recursion sentinel + missing-binary paths fail loud, exit codes 70/127.
- No edits outside your ownership list. No version bumps, no CHANGELOG, no commits.

Post `### [T1] FINDING/FIX-PROPOSED/FIX-LANDED/DONE 2026-MM-DD HH:MM ET — <gist>`.
