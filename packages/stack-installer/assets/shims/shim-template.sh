#!/usr/bin/env bash
# @termdeck/shim v1
# ──────────────────────────────────────────────────────────────────────────────
# TermDeck standalone-shell capture shim  —  Sprint 68-REDUX T1
#
# ONE file, installed as THREE executables named exactly like the real CLIs:
#   ~/.termdeck/shims/codex   ~/.termdeck/shims/grok   ~/.termdeck/shims/agy
# The agent is derived from the shim's OWN BASENAME, so all three installed
# copies are byte-identical and the installer's job is `cp` + `chmod +x` ×3.
# (Deliberately NOT ~/.local/bin — `agy` really lives there, and shadowing the
# real binary's own directory is a footgun. PLANNING D0.)
#
# WHY THIS EXISTS. A Codex/Grok/Antigravity session run in a plain Terminal —
# outside TermDeck — writes nothing to Mnestra. TermDeck panels are covered by
# `onPanelClose`; Claude Code is covered by its own SessionEnd hook. Standalone
# non-Claude shells are the last dark cell. This shim closes it at the process
# boundary, which is churn-proof: it depends on no third-party hook surface
# (those churned out from under the 2026-05-19 plan wholesale).
#
# WHAT IT DOES. Resolves the real binary, runs it under a PTY via `script` so
# the CLI still sees a real TTY (fully interactive), and on exit hands the
# transcript to `drain.js`, which cleans it and feeds the EXISTING bundled
# memory-session-end hook. The hook is not modified by this sprint.
#
# HARD INVARIANTS (each has a test in T3's fence + a T4 attack):
#   1. TRANSPARENT. Exit code, argv (incl. spaces/quotes), stdin, and TTY
#      semantics are the real binary's. A user must not be able to tell.
#   2. FAIL-SOFT. Every capture-side failure degrades to "ran the CLI, captured
#      nothing". Capture NEVER changes the exit code or writes to the user's
#      stdout/stderr on the success path.
#   3. NEVER DOUBLE-CAPTURE. Inside a TermDeck panel this is a transparent
#      `exec` and captures nothing — `onPanelClose` owns that session. (D1′)
#   4. NEVER FORK-BOMB. A broken resolution aborts loudly; it never execs
#      anything it hasn't proven is not itself.
# ──────────────────────────────────────────────────────────────────────────────

set -u

AGENT="$(basename "$0")"
SHIM_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || echo "")"

# ── Invariant 4: recursion sentinel ───────────────────────────────────────────
# If we are already inside a shim for THIS agent, real-binary resolution has
# failed in a way that resolved back to a shim. Abort loudly. Never exec — an
# exec here is precisely the fork bomb. Exit 70 (EX_SOFTWARE) is distinguishable
# from any real CLI's exit codes.
#
# The sentinel carries the AGENT NAME rather than a bare flag so that legitimate
# cross-agent nesting still works: a Codex session that shells out to `grok -p
# "..."` is a real workflow, and only a shim re-entering ITSELF is the fault
# condition. Wins over every other branch, including TERMDECK_SHIM_PROBE.
if [ "${TERMDECK_SHIM_ACTIVE:-}" = "$AGENT" ]; then
  printf '%s\n' \
    "termdeck-shim($AGENT): FATAL — recursion detected (TERMDECK_SHIM_ACTIVE=$AGENT already set)." \
    "  The shim resolved '$AGENT' back to a shim instead of the real binary." \
    "  Nothing was executed. Fix your PATH, or run the real binary by absolute path." \
    "  Diagnose with: termdeck doctor   (checks PATH order + real-binary resolution)" >&2
  exit 70
fi

# ── Real-binary resolution ────────────────────────────────────────────────────
# Hand-rolled PATH walk rather than `which -a`: `which` is not POSIX, can report
# shell aliases/functions, and on this machine returns DUPLICATE hits because
# PATH itself contains duplicate directories.
#
# ⚠ THE LOAD-BEARING TEST IS THE CONTENT SCAN, NOT THE PATH COMPARISONS.
# (Sprint 68-REDUX remediation item 1; T3 FINDING 16:02 ET, T4 AUDIT-FAIL 15:40.)
# The original resolver skipped only our own directory and our own realpath. That
# proves a candidate is not *this* shim — which is NOT the same as proving it is
# not *a* shim, and the gap was fatal: with a second shim copy earlier on PATH,
# copy A skipped its own dir and exec'd copy B, copy B skipped ITS own dir and
# exec'd copy A, forever. Measured as an unbounded `exec` loop in a single
# process — pegged CPU, terminal hung, never self-terminating. A symlink to a
# shim defeated the realpath check too, because that check canonicalises the
# candidate's DIRECTORY and re-appends the name, so it never dereferences a
# symlinked file.
#
# Identifying shims by CONTENT closes all three cases at once, because it
# inspects the file instead of reasoning about paths. The marker `# @termdeck/shim`
# is the one T2 already relies on for uninstall attribution — no new convention.
_real=""
_self_real=""
if command -v python3 >/dev/null 2>&1; then
  _self_real="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$0" 2>/dev/null || echo "")"
fi
[ -z "$_self_real" ] && _self_real="$0"

# Is this file one of ours? Reads the first 4 KB only — cheap, and bounded so a
# huge real binary is never slurped. Works on symlinks (reads through them) and
# is safe on binaries (`grep -q` on binary data just doesn't match).
_is_termdeck_shim() {
  head -c 4096 "$1" 2>/dev/null | grep -q '# @termdeck/shim' 2>/dev/null
}

_oldifs="$IFS"
IFS=':'
for _dir in $PATH; do
  [ -z "$_dir" ] && continue
  # Cheap fast path: skip our own shim directory outright.
  if [ -n "$SHIM_DIR" ]; then
    _dir_real="$(cd "$_dir" 2>/dev/null && pwd -P || echo "$_dir")"
    [ "$_dir_real" = "$SHIM_DIR" ] && continue
  fi
  _cand="$_dir/$AGENT"
  [ -x "$_cand" ] || continue
  [ -d "$_cand" ] && continue
  # Never select ourselves even if SHIM_DIR resolution failed (exotic $0).
  _cand_real="$(cd "$(dirname "$_cand")" 2>/dev/null && pwd -P || echo "")/$AGENT"
  [ "$_cand_real" = "$_self_real" ] && continue
  # THE decisive test: never select ANY termdeck shim, wherever it lives and
  # whatever path shape points at it.
  _is_termdeck_shim "$_cand" && continue
  _real="$_cand"
  break
done
IFS="$_oldifs"

if [ -z "$_real" ]; then
  printf '%s\n' \
    "termdeck-shim($AGENT): FATAL — no real '$AGENT' binary found on PATH." \
    "  Searched every PATH entry except the shim directory (${SHIM_DIR:-unknown})." \
    "  Either '$AGENT' is not installed, or the shim is the ONLY '$AGENT' on PATH." \
    "  Diagnose with: termdeck doctor" >&2
  exit 127
fi

# ── Dry-probe mode (T2 doctor contract, STATUS 2026-08-01 15:33 ET) ───────────
# `TERMDECK_SHIM_PROBE=1 <shim>` prints the resolved real-binary absolute path on
# stdout and exits 0, without executing the CLI, creating a transcript, or
# draining. This is what stands between us and INSTALLER-PITFALLS Class I
# (installed-but-never-fires): the doctor can assert resolution works without
# launching an interactive agent. Failure paths above already exited 127/70, so
# reaching here means resolution succeeded.
if [ -n "${TERMDECK_SHIM_PROBE:-}" ]; then
  printf '%s\n' "$_real"
  exit 0
fi

# ── Invariant 4, part 2: arm the sentinel BEFORE ANY exec ─────────────────────
# (Sprint 68-REDUX remediation item 2; T3 fix-shape §2.) The sentinel used to be
# armed only on the capture path, so both hops of the shim-shadow loop took a
# transparent `exec` and never touched it — the guard that exists to stop a
# runaway was unreachable in the exact scenario it was written for. Arming it
# here covers EVERY downstream exit: transparent panel exec, non-interactive
# exec, opt-out exec, mkdir-failure exec, and capture. With content-based
# resolution above, a loop is now impossible by construction; this is the
# backstop that makes the NEXT resolution bug die at exit 70 instead of spinning
# a terminal forever. Correctness is item 1; survivability is this.
#
# Trade-off, deliberately accepted and reported to ORCH: because the sentinel is
# exported into the real CLI's environment, a same-agent nested invocation
# (a `codex` session shelling out to `codex`) now aborts at 70. Cross-agent
# nesting is unaffected — the sentinel carries the agent NAME, so codex→grok is
# fine. See my FINDING for the depth-counter alternative if ORCH would rather
# keep same-agent nesting working.
export TERMDECK_SHIM_ACTIVE="$AGENT"

# ── Invariant 3 (D1′): in-TermDeck guard ──────────────────────────────────────
# TERMDECK_PANEL_SESSION is the named, single-purpose dedup marker (added to
# spawnTerminalSession this sprint). TERMDECK_SESSION is the FALLBACK: a
# long-lived TermDeck server process started before the upgrade sets the latter
# but not the former, and without this second test those hosts would silently
# double-write (shim drain + onPanelClose). Both are tested NON-EMPTY, because
# "set but empty" is a real state in that env block (TERMDECK_PROJECT is
# deliberately '' when absent).
if [ -n "${TERMDECK_PANEL_SESSION:-}" ] || [ -n "${TERMDECK_SESSION:-}" ]; then
  exec "$_real" "$@"
fi

# ── Non-interactive guard ─────────────────────────────────────────────────────
# When stdin is a pipe/file (CI, `echo prompt | codex`, editor integrations)
# there is no interactive session to capture and `script` would only add EOT
# noise, so we stay fully transparent. Invariant 1 outranks capture.
#
# Gated on STDIN ONLY, deliberately. An earlier revision also required stdout to
# be a TTY, which silently disabled capture for `codex exec "..." | tee out.txt`
# — a perfectly real session that we DO want. `script` is happy to relay its
# child's output into a pipe, so stdout's shape is irrelevant to whether capture
# works; only stdin tells us whether a human is driving.
if [ ! -t 0 ]; then
  exec "$_real" "$@"
fi

# Explicit opt-out for users who want the shim inert without uninstalling it.
if [ -n "${TERMDECK_SHIM_DISABLE:-}" ]; then
  exec "$_real" "$@"
fi

# ── Transcript path + rotation ────────────────────────────────────────────────
TD_HOME="${TERMDECK_HOME:-$HOME/.termdeck}"
TRANSCRIPT_DIR="$TD_HOME/standalone-transcripts"
if ! mkdir -p "$TRANSCRIPT_DIR" 2>/dev/null; then
  # Can't stage a transcript — degrade to transparent passthrough (Invariant 2).
  exec "$_real" "$@"
fi
chmod 700 "$TRANSCRIPT_DIR" 2>/dev/null || true

# Prune transcripts older than 14 days. Guarded three ways: the directory must
# be non-empty as a string, must exist, and `find` is scoped to that exact path
# with name patterns — so a mis-expanded variable can never delete anything
# outside standalone-transcripts/.
#
# Both artifacts rotate together: the raw `<agent>-<ts>-<pid>.log` capture and
# the `<...>.log.envelope.json` parsed form the drain now leaves beside it
# (remediation item 4 — the envelope is durable because it is what the hook
# records as `transcript_path`, so deleting it would re-create the dangling
# pointer the item exists to fix). `*.log` already matches the raw file; the
# second pattern covers the envelope.
if [ -n "$TRANSCRIPT_DIR" ] && [ -d "$TRANSCRIPT_DIR" ]; then
  find "$TRANSCRIPT_DIR" -maxdepth 1 -type f \( -name '*.log' -o -name '*.envelope.json' \) \
    -mtime +14 -delete 2>/dev/null || true
fi

TRANSCRIPT="$TRANSCRIPT_DIR/$AGENT-$(date +%s)-$$.log"

# ── Run under a PTY ───────────────────────────────────────────────────────────
# BSD (macOS):     script -q <file> <cmd> [args...]   — argv passed through
#                  directly (NO shell re-parse, so args with spaces/quotes are
#                  safe verbatim), and the child's exit status IS propagated.
# util-linux:      script -q -e -c "<cmd string>" <file>  — takes a COMMAND
#                  STRING, so args must be shell-quoted; and WITHOUT `-e` it
#                  returns 0 regardless of the child's status (Invariant 1
#                  violation), hence -e is mandatory there.
_status=0
if script --version 2>/dev/null | grep -qi 'util-linux'; then
  # POSIX single-quote quoting, NOT bash's `printf %q` (Sprint 68-REDUX
  # remediation item 5). util-linux runs the `-c` string through `sh -c`, and
  # `%q` emits BASH-specific forms for control characters — an argument
  # containing a newline or tab becomes `$'\n'`, which POSIX sh treats as a
  # literal dollar-quote rather than an escape. The argument silently arrives
  # mangled on exactly the platform this branch exists for.
  #
  # Single-quote wrapping with `'` → `'\''` is universally safe in any POSIX
  # shell and handles newlines, tabs, globs, `$`, and backticks literally. Built
  # with bash parameter expansion rather than `sed` inside `$(...)`, because
  # command substitution strips trailing newlines and would corrupt an argument
  # that ends in one.
  #
  # The quote and its escape are held in VARIABLES rather than written inline.
  # An inline `${_a//\'/\'\\\'\'}` is nearly impossible to get right — my first
  # attempt silently produced malformed output that let `$HOME`, a glob, and a
  # backtick command substitution all EXPAND inside the reconstructed string.
  # That is a command-injection shape, strictly worse than the mangling it was
  # meant to fix. Bash does not re-parse the contents of a replacement variable,
  # so this form has no such trap. Verified round-tripping apostrophes, `$VAR`,
  # globs, backticks, embedded newlines/tabs and trailing newlines through both
  # `dash` and `sh`.
  _SQ="'"
  _ESC="'\\''"
  _cmd=""
  for _a in "$_real" "$@"; do
    _cmd="$_cmd$_SQ${_a//$_SQ/$_ESC}$_SQ "
  done
  script -q -e -c "$_cmd" "$TRANSCRIPT" || _status=$?
else
  script -q "$TRANSCRIPT" "$_real" "$@" || _status=$?
fi

# ── Exit drain (Invariant 2: fail-soft, non-blocking) ─────────────────────────
# Detached + nohup so the user's prompt returns instantly — the drain does
# network I/O (embedding + Supabase) that can take seconds, and blocking a
# shell on it would be a worse regression than the gap we're closing. All
# drain output goes to a log, never the user's terminal.
_drain="${TERMDECK_SHIM_DRAIN:-$SHIM_DIR/drain.js}"
if [ -s "$TRANSCRIPT" ] && [ -f "$_drain" ] && command -v node >/dev/null 2>&1; then
  _logdir="$TD_HOME/logs"
  mkdir -p "$_logdir" 2>/dev/null || true
  TERMDECK_SHIM_AGENT="$AGENT" \
  TERMDECK_SHIM_TRANSCRIPT="$TRANSCRIPT" \
  TERMDECK_SHIM_CWD="$PWD" \
    nohup node "$_drain" >>"$_logdir/shim-drain.log" 2>&1 </dev/null &
fi

exit $_status
