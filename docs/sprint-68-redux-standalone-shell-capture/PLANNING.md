# Sprint 68-REDUX — Standalone-shell memory capture: PATH-shim stdout wrappers

**Authored:** 2026-08-01 by the post-S84 orchestrator session, per the S83/S84 restart docs' §4
re-scope mandate. **SUPERSEDES** `docs/sprint-68-standalone-shell-capture/PLANNING.md`
(2026-05-19, staged, never injected) — kept in place as the historical record of the
native-hook approach and why it died.
**Status:** RE-SCOPED, awaiting Josh's two go-calls: (1) the Antigravity in/out decision
(§ Scope options), (2) inject port + go. Lane briefs are cut from this file at go-time.
**Pattern:** 3+1+1 — T1/T2/T3 Claude workers + T4 Codex auditor + orchestrator.
**Wave target:** `@jhizzard/termdeck` 1.17.0 → 1.18.0 + `@jhizzard/termdeck-stack`
1.15.0 → 1.16.0 (minor — new installer capability). `@jhizzard/mnestra` + `@jhizzard/rumen`
unchanged — the shims reuse the existing `memory_items` write path and hook scripts.

---

## Why the 2026-05-19 plan is obsolete

The staged plan bet everything on **native CLI hook surfaces** (Gemini `SessionEnd`/`PreCompress`,
grok-dev `user-settings.json` hooks, Codex throttled `Stop`). The Sprint-70 CLI churn
(2026-06-05/07, verified live) invalidated that inventory wholesale:

1. **Gemini CLI is legacy** — OAuth serving ended 2026-06-18; the binary survives API-key-only
   and its daily-driver role passed to **Antigravity `agy`** (v1.0.0, OAuth), which the old plan
   doesn't know exists and whose hook surface is unverified/absent.
2. **grok-dev is gone** — auto-updated to **Grok Build** (0.2.33+); the old plan's
   `~/.grok/user-settings.json` hook block and `grok.db` SQLite extraction both target a
   dead binary.
3. **Codex was already the weak leg** — no `SessionEnd`, no compaction hook; the `Stop`-throttle
   design was an accepted degraded mode even then.

The general lesson (already proven in-panel by Sprint 70): **third-party hook/session-file
surfaces are churn we don't control; owned capture at the process boundary is churn-proof.**
Sprint 70's answer for Antigravity panels was in-flight stdout capture in
`spawnTerminalSession` (the stdout-tee). This sprint ports that pattern to standalone shells.

**What survives from the old plan** (reuse, don't reinvent):
- The **source_agent resolution order** design (stdin payload → env → inference, validated
  against `ALLOWED_SOURCE_AGENTS`) — S70 T3 already landed `agy`/`antigravity` write-side.
- The **dedup invariant** (D1): exactly one capture per session, whether standalone or
  in-TermDeck. Mechanism changes (see D1′ below); the invariant is unchanged.
- The INSTALLER-PITFALLS discipline and the three hardening rules.

---

## Design (load-bearing)

**D0 — The shim.** One wrapper script per CLI, installed at `~/.termdeck/shims/<name>`
(`codex`, `grok`, `agy`; NOT `~/.local/bin` — `agy` really lives there and shadowing the
real binary's own directory is a footgun). Installer prepends `~/.termdeck/shims` to PATH
via marker-fenced rc-file block. Each shim:

1. Resolves the **real** binary "next on PATH after myself" (`which -a` skip-self; a
   recursion sentinel env var — `TERMDECK_SHIM_ACTIVE=<name>` — hard-aborts a second
   entry, so a broken resolution can never fork-bomb).
2. Runs it under a PTY via BSD `script -q <transcript> <real-bin> "$@"` — dependency-free,
   fully interactive (the CLI sees a TTY), and the transcript tee is the OS's, not ours.
   Transcripts land in `~/.termdeck/standalone-transcripts/<agent>-<ts>-<pid>.log`
   (rotation: shim prunes >14d files at spawn).
3. On child exit: synthesizes the Claude-Code-shaped stdin JSON (`session_id` (minted UUID),
   `transcript_path`, `cwd`, `hook_event_name`) and pipes it to the **existing** bundled
   `memory-session-end.js` with `TERMDECK_NATIVE_CLI_HOOK=<agent>` — the hook's parser
   chain + redact.js (S84 NUL fix) + `ALLOWED_SOURCE_AGENTS` validation all reused as-is.
   Exit code of the real CLI is preserved; the drain is fail-soft (never blocks or
   pollutes the user's shell on error).
4. **Periodic checkpoint (stretch, T1 judgment):** background watcher loop — every 10 min,
   if the transcript grew ≥1 KB, fire `memory-pre-compact.js` in `periodic_checkpoint` mode.
   Mirrors `onPanelPeriodicCapture` semantics for compaction-mid-session coverage.

**D1′ — Dedup: the shim self-disables inside TermDeck.** If TermDeck's server resolves
CLIs via PATH, a panel spawn would enter the shim and double-capture (shim drain +
`onPanelClose`). Guard: the shim checks `TERMDECK_PANEL_SESSION` — set → `exec` the real
binary directly (transparent, zero capture, `onPanelClose` owns the session). T1 **verifies
first** whether `spawnTerminalSession` sets that marker today (the old plan flagged it may
not exist) and adds it if absent. T4 hammers all invocation paths: standalone-with-shim,
panel-with-shim-on-PATH, panel-without-shim, shim-with-missing-real-binary.

**D2′ — ANSI/PTY noise is the parsers' problem, already solved.** `script` transcripts carry
raw escape sequences — the same shape as TermDeck's rolling PTY buffers that the bundled
hook already ingests for non-Claude panels. T1 confirms parser fit per CLI; no new parser
tier unless a CLI proves pathological (that evidence gates it out per D3′, not a rewrite).

**D3′ — Fail-loud gating, per CLI.** Each shim ships only with a live acceptance proof
(canary phrase in a real standalone session → recalled from Mnestra). A CLI that misbehaves
under `script` (agy is the candidate risk) is **gated out with an explicit doctor message**,
and ships as a follow-up — the other shims still ship. INSTALLER-PITFALLS Class I.

---

## Scope options (Josh's call at go)

**Option A — all three (codex + grok + agy). RECOMMENDED.** The shim core is one shared
template parameterized per CLI (~100 lines + ~20/CLI); the per-CLI cost is validation, not
construction. Antigravity is arguably the **largest** dark cell — ClaimGuard/Maestro/iMessage
work runs in standalone agy at `~/.gemini/antigravity/scratch/`, none of it captured today.
The agy panel adapter (S70 T1) already proved its output parses. Risk is contained by D3′:
if agy misbehaves under `script`, it gates out loudly and Codex+Grok still ship.

**Option B — codex + grok first, agy fast-follow.** Tighter first sprint, defers the one
genuinely unproven PTY citizen. Costs a second sprint ceremony for ~20 lines + validation,
and leaves the biggest dark cell dark meanwhile.

Gemini stays out either way (legacy, API-key-only, panel-covered; standalone use ~nil).

---

## Lane map (Option A shape; Option B drops the agy validation into T3-lite)

| Lane | Owns | Mission |
|---|---|---|
| **T1** (Claude) | `packages/stack-installer/assets/shims/` (NEW: template + 3 shims) · the `TERMDECK_PANEL_SESSION` marker region of `packages/server/src/index.js::spawnTerminalSession` | Shim core: skip-self resolution, recursion sentinel, `script` PTY tee, exit-drain, rotation, checkpoint watcher; D1′ marker verify/add |
| **T2** (Claude) | `packages/stack-installer/src/index.js` (`installShellShims`) · rc-file PATH block (marker-fenced, idempotent) · `packages/cli/src/init-mnestra.js::runHookRefresh` · `uninstall.js` splice · doctor probes (PATH order, shim-first, recursion sentinel, real-binary resolution) | Installer wiring, refresh/uninstall, doctor |
| **T3** (Claude) | fence tests (shim resolution, dedup both env states, drain payload shape, rotation, rc idempotency, malformed-abort) · docs (stale "no capture for standalone shells" claims in both CLAUDE.mds + `CRITICAL-READ-FIRST` §Resolution addendum) · INSTALLER-PITFALLS trace + the "PATH-shadowing drift" new-class evaluation · per-CLI live canary acceptance | Tests + docs + acceptance |
| **T4** (Codex) | nothing — auditor | Independent reproduction: canary per CLI standalone; no-double-write in-panel; adversarial PATH-order and recursion attacks; CHECKPOINT discipline |

Shared file `packages/server/src/index.js`: T1 only, single surgical Edit (marker). No
engram/rumen repo changes. **Monitors run BADGE-FREE per standing doctrine** — liveness =
subtree-CPU delta + transcript mtime only; parked-worker shepherding per the 3-monitor stack.

---

## Acceptance

- Per shipped CLI: standalone shell session with canary phrase → correctly-labeled
  `session_summary` row recalled from Mnestra; same CLI as a TermDeck panel → **exactly one**
  row (D1′ holds); shim transparently preserves exit codes, args with spaces, stdin.
- Installer: idempotent re-run reports nothing-to-do; uninstall restores PATH block + removes
  shims; doctor detects wrong PATH order and missing real binary loudly.
- `npm test` green; every installer change traces to an INSTALLER-PITFALLS class;
  T4-CODEX FINAL-VERDICT GREEN with file:line evidence.
- Orchestrator close-out: 1.18.0/1.16.0 wave per RELEASE.md, Resolution section here,
  BACKLOG §5 horizon item closed, kitchen harvest from STATUS.md.

## Out of scope

- Any native CLI hook config writes (the superseded approach — delete none, install none).
- `onPanelClose` / panel capture changes (marker env add only).
- Gemini shim; Claude Code shim (covered by its own hooks); read-side recall-filter enum work.

## Boot sequence (each lane, at inject)

1. `memory_recall(project="termdeck", query="<lane topic>")` *(T4-Codex: skip, read docs)*
2. `memory_recall(query="Sprint 68 redux standalone shell capture stdout wrapper shim")`
3. Read `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `docs/INSTALLER-PITFALLS.md`
4. Read this PLANNING.md, then STATUS.md, then your `T<n>-*.md` brief
5. Begin. Post `### [Tn] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`. No version bumps, no
   CHANGELOG, no commits from lanes.

---

## Resolution

**SHIPPED — FINAL-VERDICT GREEN 2026-08-01 16:51 ET** (inject 15:29 ET, ~82 min). Wave:
`@jhizzard/termdeck@1.18.0` + `@jhizzard/termdeck-stack@1.16.0`. Gate 1311/1306/0 (5
pre-existing skips). All three shims shipped (Option A); live acceptance row-verified per CLI
via read-only psql (T1 produced, T4 independently reproduced): grok `85e86311`, codex
`74cf2626`, agy `e36b15fb` — final-artifact evidence, post-R-A envelopes.

**What the audit loop caught after both workers' first DONE posts** (the pattern to remember):
T4's redaction leak (fallback passed a conn string; canonical redactor now vendored +
byte-pinned), T3's measured infinite exec loop on two-shims-on-PATH (resolver moved from
location-reasoning to content-marker identification), durable-vs-raw `transcript_path`
semantics (settled by explicit ORCH narrowing R-A: envelope + `raw_transcript_path`),
util-linux quoting, CRLF parity, rc trailing-newline, stale supervise re-vendor, and two
pre-existing ORCH-surface red gates (BACKLOG Engram line; CHANGELOG literal NUL byte).

**Rulings that shaped the design**: T1's D1′ OR-guard (version-skew fail-open closed);
R-A (durable-envelope semantics accepted, narrowed); R-B (cross-lane 2-line mirror executed
by T3 under explicit authorization); R-C (ORCH-owned gate fixes).

**Residuals (BACKLOG'd, deliberate)**: read-side `memory_recall` does not yet surface the
fresh canary rows (pre-existing ranking behaviour); 5 uncharacterized pre-existing test
skips; Gemini standalone remains uncovered by design; T4's real-SaaS self-canary stays
policy-blocked (sandbox correctly refused external transmission without approval — T1
produces, T4 verifies by query is the accepted pattern).
