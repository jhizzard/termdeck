# Sprint 75 — Bridge Wave (static OAuth + ingress hardening + cloud-origin prep)

**Staged:** 2026-06-12 ~12:46 ET by ORCH. **Repo:** termdeck (this repo; T3 touches docs/infra only).
**Pattern:** 3+1+1 (T1–T3 Claude workers, T4 Codex auditor, ORCH in the long-running session).
**Authoritative scope source:** `docs/RESTART-PROMPT-2026-06-12-publish-pending-and-sprint-75-76.md` § 4.

## Goal

Make the MCP bridge connectable from Gemini Enterprise (static OAuth client registration),
field-harden every DATABASE_URL ingress against the IPv6-only direct-endpoint trap (Sprint 74
T2's CARRY-OVER-SPEC, parts A+B+C), fix the installer's literal-`~` settings.json bug, and
fully prep — without provisioning — the cloud third bridge origin for the Cloudflare LB
fail-safe chain.

## Why now

1. **Gemini Enterprise unblock.** The custom MCP connector (preview) requires STATIC
   client_id/client_secret + auth/token URLs — our bridge only speaks DCR today. Josh is
   pairing this with one Gemini Enterprise Standard seat ($35 m2m); T1 is the gating work.
   Streamable-HTTP is already native on both sides.
2. **Bridge fail-safe.** `bridge.joshuaizzard.dev` is fronted by a Cloudflare LB
   (BRIDGE HIGH-AVAILABILITY DESIGN, adopted 2026-06-11), but AIR-SETUP Part 3 is unexecuted
   and the cloud third origin exists only as design canon. T3 turns it into a blind-executable
   operator procedure + the memory-only bridge mode a panel-less host needs.
3. **Brad field-hardening.** The direct-endpoint (`db.<project-ref>.supabase.co`) hang on
   IPv4-only hosts is a live Brad-class failure with a fully-written spec sitting in Sprint 74
   STATUS.md; the literal-`~` settings.json command is a latent all-platform bug (Windows
   audit item 4). T2 closes both.

## Lanes

| Lane | Scope | Brief |
|---|---|---|
| T1 | Static OAuth client registration in `packages/mcp-bridge` (alongside DCR) + Gemini Enterprise connector doc | `T1-static-oauth.md` |
| T2 | DATABASE_URL ingress classify+warn (S74-T2 CARRY-OVER-SPEC A+B+C) + installer literal-`~` absolute-path fix | `T2-ingress-and-installer.md` |
| T3 | Cloud third-origin PREP: memory-tools-only bridge flag + provision runbook + Cloudflare LB setup doc (incl. unexecuted AIR-SETUP Part 3) | `T3-cloud-origin-prep.md` |
| T4 | Codex adversarial auditor across T1–T3 | `T4-codex-auditor.md` |

## Dependencies

- **T1 is independent.** Owns `packages/mcp-bridge/src/auth.js` + its tests + one new docs page.
- **T2 is independent.** Owns CLI/server setup + stack-installer surfaces; zero overlap with the bridge package.
- **T3 reads T1's auth surface** (shared `bridge-auth.json` semantics, issuer/resource URLs, the
  static-client config T1 invents) **but has NO file overlap with T1**: T3 owns
  `packages/mcp-bridge/src/server.js` + `src/tools/` + new docs; T1 owns `src/auth.js`. If
  either lane finds it must touch the other's file, post a HANDOFF-REQUEST in STATUS.md and
  wait for an ACK — do not edit across the boundary.
- T4 audits all three in flight.

## Hard constraints

- T2 touches the installer surface → **`docs/INSTALLER-PITFALLS.md` is a mandatory read**;
  every change must trace to a pitfall class it avoids (traceability table in the DONE post).
- No version bumps, no CHANGELOG edits, no commits, no publishes, **no live provisioning**
  (no VPS purchase, no Cloudflare API mutations, no tunnel creation) inside any lane.
- Zero-build-step, vanilla JS, CommonJS in server/bridge code. No new dependencies without a
  FINDING post justifying it.
- **Every test lands inside the canonical `npm test` glob** (root `package.json:36`):
  `packages/server/tests/**/*.test.js packages/cli/tests/**/*.test.js packages/stack-installer/tests/**/*.test.js packages/mcp-bridge/test/*.test.js packages/web-chat-driver/tests/*.test.js`.
  Note `packages/mcp-bridge/test/` is FLAT (`*.test.js`, no subdirectories). A test outside
  this glob does not exist as far as the close-out gate is concerned — this is a standing gate
  and T4 verifies it per claim.
- The internal Supabase project name and project ref NEVER appear in any artifact (docs,
  runbooks, tests, fixtures). Use `<project-ref>` placeholders. Gitleaks-enforced (hooks
  carry the exact denylist).

## Acceptance (ORCH judges at close)

**Acceptance = `### [T4-CODEX] FINAL-VERDICT ... GREEN`.** Per-lane gates feeding it:

1. T1: a pre-seeded static client completes the full token grant (auth-code → token with
   client_secret verification) and refresh rotation; DCR path provably unaffected (existing
   auth tests green, plus an explicit DCR regression test run); Gemini Enterprise connector
   doc shipped; secret never logged or persisted in plaintext beyond its config source.
2. T2: part A verified-then-landed, parts B+C landed per the CARRY-OVER-SPEC's anchors
   (warn-never-blocks invariant intact); literal-`~` eliminated from every settings.json
   command write path INCLUDING the refresh/migration path for existing installs;
   INSTALLER-PITFALLS traceability table posted.
3. T3: memory-tools-only flag implemented + tested (panel tools provably absent, memory tools
   provably present); provision runbook + LB setup doc are blind-executable single operator
   procedures with zero live mutations performed.
4. T4: AUDIT-PASS/AUDIT-FAIL per lane with file:line evidence + FINAL-VERDICT.

## Out of scope (→ named owners)

- **Live VPS provisioning / Cloudflare LB execution** — operator (Josh) runs T3's runbook
  post-sprint; pre-authorized up to ~$20/mo.
- **Gemini Enterprise seat purchase** — Josh, standing item.
- **Memory-inbox work** (`memory_inbox` table, `memory_propose` tool, Rumen promotion pass)
  — Sprint 76, fully spec'd elsewhere.
- Version bumps / CHANGELOG / commits / publishes — ORCH at close.
- Dependabot PRs, repo debris cleanup — separate passes.

## Lane discipline (all lanes — the three hardening rules + periphery watch)

- **Post shape, ALL posts:** `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>`
  (FINDING / FIX-PROPOSED / FIX-LANDED / BLOCKED / HANDOFF-REQUEST / DONE). The `### ` prefix
  is mandatory — cross-lane greps depend on it.
- **Idle-polls use the tolerant regex** `^(### )?\[T<n>\] DONE\b` (or the analogous
  verb-anchored form `^(### )?\[T<n>\] <VERB>\b`) — never a brittle prefix-only match.
- **Auditor additionally posts** `### [T4-CODEX] CHECKPOINT ...` at every phase boundary and
  at least every 15 minutes (see T4 brief).
- **PERIPHERY WATCH (workers, mandatory):** after posting DONE, do NOT park silently. Re-read
  STATUS.md every few minutes until FINAL-VERDICT posts; answer any AUDIT-CONCERN or
  HANDOFF-REQUEST touching your lane; BEFORE posting DONE, check for unacknowledged
  HANDOFF-REQUESTs targeting you and resolve or explicitly route them.
- **ORCH decisions posted to STATUS.md are binding even if posted after your DONE** —
  periphery watch is how you catch them.
