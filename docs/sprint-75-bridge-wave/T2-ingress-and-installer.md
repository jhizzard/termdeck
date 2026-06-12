# T2 — DATABASE_URL ingress classify+warn (S74-T2 CARRY-OVER-SPEC) + installer literal-`~` fix

## Mission

Two field-hardening items, both Brad-class:

1. **Execute Sprint 74 T2's blind-executable CARRY-OVER-SPEC** — the post at
   `docs/sprint-74-mnestra-provenance-and-db-integrity/STATUS.md:290`
   (`### [T2] CARRY-OVER-SPEC 2026-06-11 20:45 ET`). It specifies, with line anchors:
   **A** (wizard prompt-copy refresh), **B** (classify+warn at every DATABASE_URL ingress,
   porting engram's `src/db-endpoint.ts` classifier semantics), **C** (doctor/preflight/health
   surfacing). That post is your authoritative implementation spec — this brief routes and
   supplements it, it does not restate it. Read it in full before writing code.
2. **Installer literal-`~` absolute-path fix.** The stack writes the literal string
   `node ~/.claude/hooks/memory-session-end.js` (and the pre-compact twin) into Claude Code's
   `settings.json` hook commands. `~` is shell-expanded on macOS/Linux by luck of how the
   harness invokes the command, and is a hard break on Windows (audit item 4) — replace with
   absolute paths computed at install time.

## Mandatory pre-reads

1. The CARRY-OVER-SPEC post itself (sed/read `docs/sprint-74-mnestra-provenance-and-db-integrity/STATUS.md`
   lines 290-360 region) — plus the `### [T2] CLARIFICATION 21:29` + `### [ORCH] ACK 21:33`
   posts (same file, :414-415) confirming NOTHING from it landed in termdeck.
2. `docs/INSTALLER-PITFALLS.md` — MANDATORY; you touch the installer/bundled-settings surface.
   Your DONE post must include a traceability table mapping each change to the pitfall class
   it avoids (expect at least Class B path-mismatch, Class N lockstep-drift; argue the rest).
3. Reference implementation for part B: engram `src/db-endpoint.ts` +
   `tests/db-endpoint.test.ts` (`~/Documents/Graciella/engram/`, landed Sprint 74, read-only —
   PORT the semantics into CommonJS, do not re-derive, do not edit engram).
4. `packages/stack-installer/src/index.js:40-70` and `packages/cli/src/init-mnestra.js:710-800`
   — the literal-`~` constants and their consumers.

## Part A/B/C — current-state verification FIRST (then execute)

**ORCH pre-verified on 2026-06-12 ~12:40 ET** (re-verify yourself, anchors may have drifted):

- Part A NOT landed: `grep -n "Use IPv4 connection" packages/cli/src/init-mnestra.js` → zero
  hits (prompt at ~:287 still reads "Direct Postgres connection string").
- Part B NOT landed: `grep -n "classifyDbEndpoint\|directEndpointWarningLines"
  packages/server/src/setup/supabase-url.js` → zero hits;
  `packages/server/tests/supabase-url-endpoint.test.js` does not exist.
- Part C NOT landed (follows from B1 absence).

So: **execute A + B + C in this lane.** (The spec recommended A for the Sprint 73 close
window; that window shut without it — its own fallback clause says "fold A into 75 with B".)
Post a FINDING confirming your own verification before the first FIX-LANDED.

Execution notes on top of the spec:

- The spec's line anchors were verified against the working tree at 2026-06-11 20:30-20:44 ET.
  Sprints 73/74 merged since — **re-anchor every edit site by grep, not line number.**
- The invariant the spec repeats and T4 will attack: **warn ≠ reject.** `looksLikePostgresUrl`
  stays the blocking validator; direct URLs remain ACCEPTED (IPv6-capable hosts use them
  legitimately); warning lines print exactly once per ingress and never change exit codes.
- All four B2 call sites (interactive prompt, `--from-env`, **saved-secrets reuse** — the
  highest-value Brad case — and `init-rumen.js` parity) plus the three C surfaces
  (`doctor.js`, `preflight.js`, `health.js`) consume the SAME helper from `supabase-url.js`.
  One classifier, many printers — no copies.
- Keep warning wording byte-similar to engram's probe messages (spec's cross-reference note)
  so grep/troubleshooting stays consistent across the stack. `<project-ref>`/`<password>`
  placeholders only — never a real ref (gitleaks-enforced).
- Tests per the spec's B3: new `packages/server/tests/supabase-url-endpoint.test.js`
  (classify matrix ported from engram's test file + warning-line content assertions) + the
  wizard-level `--from-env` drive (warn prints once, exit code unchanged) + extend
  `packages/cli/tests/init-mnestra-content-drift.test.js` for the part-A copy pins
  (asserts `Use IPv4 connection` present, `Project Settings → Database` absent).

## Part D — installer literal-`~` fix

**The bug (both copies — fixing only one is exactly Class N lockstep drift):**

- `packages/stack-installer/src/index.js:54` — `const HOOK_COMMAND = 'node ~/.claude/hooks/memory-session-end.js';`
  and `:65` — `const PRECOMPACT_HOOK_COMMAND = 'node ~/.claude/hooks/memory-pre-compact.js';`
  consumed at `:464` / `:520` (written into `~/.claude/settings.json` hook entries), exported
  at `:1039` / `:1048`.
- `packages/cli/src/init-mnestra.js:716` / `:722` — duplicate constants, consumed at `:737` /
  `:791`, exported at `:1234` — the hook-REFRESH path writes the same literal strings.

**The fix:**

- Compute the command at write time from the real home dir:
  `'node ' + path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js')` (mind
  paths containing spaces — decide on quoting and test it; a macOS user dir like
  `/Users/First Last/` must produce a command Claude Code can execute).
- **Migration for existing installs:** the settings.json wiring check/refresh must treat an
  existing literal-`~` command as STALE and rewrite it to the absolute form, idempotently
  (run twice → no further change). Find every place the code COMPARES the configured command
  against the constant (the "is the hook already wired?" predicates around `:464`/`:520` and
  `:737`/`:791`) — a naive equality check against the new absolute string would mis-detect
  old installs as unwired or, worse, leave the literal `~` in place forever. Both
  directions must be covered by tests.
- Keep the two packages' logic in lockstep (Class N): identical semantics in stack-installer
  and init-mnestra. If you can de-duplicate into one shared helper without breaking the
  package boundary, propose it in a FIX-PROPOSED; if not, mirrored code with mirrored tests.
- Check `~/.claude/settings.json` is never written with `~` ANYWHERE after your change:
  add a test that scans the full settings object the installer would write for the substring
  `'~/'` in any hook command.

**Tests (all in-glob):** `packages/stack-installer/tests/` + `packages/cli/tests/` — fresh
install writes absolute path; literal-`~` existing install gets migrated on refresh;
already-absolute install is a no-op; spaces-in-home-dir case.

## NOT in scope

- engram repo edits (the classifier reference is read-only).
- `packages/mcp-bridge/**` (T1/T3 territory).
- The actual Windows installer support pass (this closes one audit item, not the audit).
- Refreshing the LIVE installed hooks/settings at `~/.claude/` on this machine (ORCH
  post-release; your changes must not execute against the developer machine's real
  settings.json from tests — use temp dirs/fixtures, standing installer-test rule).
- Version bumps, CHANGELOG, commits, publishes.

## Acceptance

1. FINDING posted verifying A/B/C pre-state (per above) before first FIX-LANDED.
2. A+B+C landed per spec; warn-never-blocks pinned by tests; all ingresses + surfaces wired
   to the single classifier.
3. Literal `~` eliminated from every settings.json command write AND migrated on refresh for
   existing installs, idempotently; spaces-in-path handled; both package copies in lockstep.
4. Full `npm test` from root green; every new test demonstrably inside the canonical glob
   (state the matched pattern per test file in your DONE post — T4 verifies).
5. INSTALLER-PITFALLS traceability table in the DONE post.

## Lane discipline

Post shape: `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / HANDOFF-REQUEST / DONE), `### ` prefix mandatory, in
`docs/sprint-75-bridge-wave/STATUS.md`. Tolerant read regex: `^(### )?\[T<n>\] <VERB>\b`.
Stay in lane. No commits, no version bumps, no CHANGELOG. **Before posting DONE:** check for
unacknowledged HANDOFF-REQUESTs targeting T2. **After DONE: PERIPHERY WATCH** — re-read
STATUS.md every few minutes until FINAL-VERDICT; answer AUDIT-CONCERNs touching your lane.
ORCH decisions posted after your DONE still bind you.
