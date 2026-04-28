# Sprint 39 — T2: zsh/bash rcfile-noise filter audit

**Lane goal:** Test the strong hypothesis that `session.js PATTERNS.error` is matching zsh/bash rcfile noise (lines emitted at shell startup before the user's first command), burning the 30s per-session rate limit before any real error fires. If confirmed, ship a tightened regex that matches genuine errors with zero false positives across a captured rcfile-noise corpus.

**Target deliverable:**
1. Empirical evidence — for or against — the rcfile-noise hypothesis.
2. If confirmed: tightened PATTERNS.error patterns with regression-test fixtures.
3. If refuted: a documented FINDING that points T1's instrumentation at the actual culprit.

## Why this lane exists

From `memory_recall` 2026-04-27: `tests/flashback-e2e.test.js` passes (synthetic transcript triggers Flashback correctly). Joshua's daily-flow toasts haven't fired since ~Sprint 26 (~9 days). The synthetic test bypasses zsh/bash rcfile loading; real shells load `/etc/zshrc`, `~/.zshrc`, `/etc/bashrc`, `~/.bashrc`, `~/.bash_profile` etc. before the user's prompt.

Memory entry from prior debug:
> "The Flashback silence symptom in real shells is caused by session.js PATTERNS.error matching zsh/bash rcfile noise, burning the 30s per-session rate limit before any real error fires."

That's a hypothesis recorded across multiple prior sprints but never empirically tested. T2's job is to test it.

## Reproduction protocol

1. Spawn a fresh interactive zsh subprocess that loads rcfiles: `node-pty.spawn('/bin/zsh', ['-i'], { ... })`.
2. Capture every output line from spawn-time until the prompt appears (typically ~50–200 lines on a developer-config zsh).
3. Run each line through the current `PATTERNS.error` regex array (from `packages/server/src/session.js`).
4. Record matches: pattern index, matched line, position in output stream.
5. Count: how many false positives per shell startup?
6. Repeat for `/bin/bash -i` (Brad's likely shell on his Linux box).

If false positives ≥ 1 per shell startup, the hypothesis is confirmed. The 30s per-session rate limit is being burned by rcfile noise before any real error has a chance to trigger Flashback.

## Likely false-positive sources to grep for

zsh + bash rcfiles routinely emit lines like:

- `command not found: <tool>` (homebrew shellenv probes, version managers)
- `Failed to load <plugin>` (oh-my-zsh, p10k, nvm)
- `ERROR: <pyenv|rbenv|nodenv>: ...`
- `Warning: ...` (homebrew, conda)
- Color-escape sequences inside otherwise-error-looking text
- Non-zero exit code messages from prompt status integration

The current PATTERNS in `session.js` likely include patterns like `/error/i`, `/fail/i`, `/exception/i`, `/cannot/i`, `/not found/i`. ALL of these false-positive on rcfile content.

## Tightening strategy (if hypothesis confirmed)

Tighten patterns to require *contextual structure*, not just keyword presence. Examples:

- `/^.*\berror\b.*:.*$/i` — requires error followed by colon (filters out "no error", "errors and warnings", etc.)
- `/^[\d\w\-_./]+:\d+:\s*(error|fatal):/i` — compiler-style file:line:level format
- `/\bexit\s*(?:code\s*)?[1-9]\d*\b/i` — explicit non-zero exit code (more specific than naked "fail")
- `/command not found:\s*\S+\s*$/im` — match only if line ENDS with the command name (filters out commentary about "command not found" handlers loading)

Pair each tightened pattern with a comment explaining what it intends to match AND what it intends to NOT match. Future readers maintaining this regex set should be able to extend without re-introducing the false-positive class.

## Fixture corpus

NEW `tests/rcfile-noise-fixtures/` directory with captured shell startup transcripts:

- `zsh-omz-p10k.txt` — oh-my-zsh + powerlevel10k (most common dev config)
- `zsh-vanilla.txt` — minimal zsh, just /etc/zshrc + ~/.zshrc
- `bash-vanilla.txt` — bash with /etc/bashrc only
- `bash-bashrc.txt` — bash with ~/.bashrc + ~/.bash_profile
- `zsh-with-error.txt` — zsh that intentionally errors mid-rcfile (should still trigger Flashback under the tightened patterns)
- 3+ more variations covering homebrew shellenv, asdf, mise, nvm, conda init blocks

Capture by running each shell config in TermDeck and saving the raw output stream to a fixture file. Strip ANSI color codes for stable text matching.

## Test plan

- Unit: each tightened pattern matches its intended structural shape; rejects rcfile-noise corpus.
- Regression: the existing `tests/session.test.js` cases (3 currently failing — `stripAnsi CSI` + two `PATTERNS.error` cases) should be assessed. Are those failures the SAME root cause as the rcfile-noise hypothesis? If yes, T2's fix may close them automatically. If no, document the divergence in T2's FINDING.
- Integration: spawn a real zsh/bash subprocess in a test, capture the output stream, run T2's tightened PATTERNS, assert zero false positives.
- Production smoke (T1 dependency): after T1's instrumentation lands, fire a real shell, count `pattern_match` events emitted before user input. After T2's tightening: zero `pattern_match` events should fire from rcfile content alone.

## Coordination notes

- **T1 (instrumentation)** is your primary observability source. Coordinate via STATUS.md: T1's `pattern_match` event includes `pattern_index` + `matched_line` — that's exactly what T2 needs to identify which patterns are firing on rcfile noise.
- **T3 (project-tag verification)** is independent — T3's hypothesis (project-tag mismatch) is an *alternate* path to the same Flashback silence. Both could be true. Don't assume your hypothesis is the only one; document T2's findings as one of two possibly-converging causes.
- **T4 (production-flow e2e)** consumes your tightened patterns. T4's new test should still trigger Flashback after your tightening (it intentionally produces a real error like `cat /nonexistent/file/path`); if T4's test stops triggering, you over-tightened.

## Out of scope

- Don't add the diag instrumentation — T1 owns it.
- Don't audit the project-tag write path — T3 owns it.
- Don't write the production-flow e2e — T4 owns it.
- Don't add a UI for showing matched patterns to the user — sprint 40+ if useful.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-39-flashback-resurrection/STATUS.md` under `## T2`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
