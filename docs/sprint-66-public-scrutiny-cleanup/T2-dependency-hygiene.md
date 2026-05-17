# T2 — Dependency hygiene

**Mission:** Triage the 4 open Dependabot major-version PRs. Bump the genuinely-safe ones in-tree; document a clear merge/hold/close verdict for each. A repo with 4 idle dependency PRs reads as unmaintained — but a careless major bump that breaks the CommonJS server is worse.

You are T2 in Sprint 66 (3+1+1). Follow the boot sequence in `PLANNING.md`, then work this brief. Stay in your lane. Post `### [T2] ...` to `STATUS.md`. No version bumps of `@jhizzard/*` packages, no CHANGELOG, no commits.

> Verify file paths and current dependency versions against the live `package.json` / `package-lock.json` at boot.

---

## The 4 PRs

| PR | Bump | Kind |
|----|------|------|
| #4  | `express` 4.22.1 → 5.2.1 | dependency (server) |
| #7  | `open` 10.2.0 → 11.0.0 | dependency (CLI browser-launch) |
| #9  | `@anthropic-ai/sdk` 0.39.0 → 0.93.0 | **dev** dependency |
| #10 | `uuid` 9.0.1 → 14.0.0 | dependency |

## TermDeck's hard constraints (the lens for every verdict)

- **CommonJS `require()` in the server** — node-pty does not play with ESM. A dependency that has gone ESM-only **cannot** be `require()`d and is therefore unsafe unless its usage can move to dynamic `import()`.
- **Zero build step** — no bundler, no transpile. A dependency that requires a build step is out.
- **Node 20 and 22** — CI tests both; the field in `package.json` `engines` is the contract. Josh's machine is on Node 23, Brad's on 22 — a dep must work across 20/22/23.
- **No TypeScript.**

## Per-PR method (do this for each)

1. **Find actual usage.** `grep -rn "require('express')" packages/`, same for `uuid`, `open`, `@anthropic-ai/sdk`. Note every call site and which APIs are used.
2. **Read the breaking-change notes** for the version range (the package's CHANGELOG / migration guide). Do not rely on memory — these are major bumps.
3. **Evaluate against the constraints above.** Specifically:
   - **`express` 5:** real breaking changes — path-to-regexp v8 route syntax (wildcards, optional params), removed `app.del`/`req.param()`/`res.send(status)`, changed error-handling and body semantics. TermDeck's server routes are in `packages/server/src/index.js`. Walk every route pattern, every error handler, every `req.*`/`res.*` call. Express 5 migration has been a deferred item since Sprint 21. If the migration is genuinely contained (TermDeck's routes are simple REST), do it in-tree and prove it with `npm test`; if it is not, **hold** with a written migration plan.
   - **`uuid` 14:** a 5-major jump. Confirm whether `require('uuid')` still resolves under Node 20/22 at v14, or whether v14 is ESM-only. If ESM-only → it breaks the CJS server → **hold/close** (or find the highest CJS-compatible version). Check the call sites (likely `v4()` for session IDs).
   - **`@anthropic-ai/sdk` 0.39→0.93:** massive API churn. It is a dev dependency — find where it is used (test fixtures? bundled hooks? something shipped?). If it is only in dev/test and the usage is trivial, the bump may be safe; if it touches a shipped bundled hook, a breaking change matters. Verdict accordingly.
   - **`open` 11:** `open` went ESM-only at v9 — TermDeck on v10 already handles that (dynamic `import()`). Check the v11 changelog for further breaking changes; this is likely the lowest-risk of the four.
4. **Verdict:** `MERGE` (bump in-tree), `HOLD` (with a written reason + what would unblock it), or `CLOSE` (incompatible — bump will never be safe as-is).

## In-tree bump model

You **cannot** merge the Dependabot PRs (GitHub writes are classifier-gated, and merging a branch is messy mid-sprint). Instead: for any dependency you verdict `MERGE`, edit `package.json` + `package-lock.json` directly to that version, run `npm install` to reconcile, and run `npm test` — **375/375 must hold**. The sprint commit then carries the bump and the orchestrator closes the corresponding Dependabot PR as superseded at close-out. For `HOLD`/`CLOSE` verdicts, the orchestrator closes/labels the PR with your rationale.

## Acceptance (what DONE means)

- A verdict table in STATUS.md: one row per PR — `MERGE`/`HOLD`/`CLOSE`, the breaking-change findings, the call-site evidence, and the rationale.
- Any in-tree bumps: `package.json` + `package-lock.json` updated, `npm test` 375/375, no CommonJS `require()` breakage, no build step introduced, Node 20/22 still satisfied.
- Post `### [T2] DONE ...` with the verdict table and `npm test` output.

## Lane discipline

Post `### [T2] FINDING/FIX-PROPOSED/FIX-LANDED/DONE 2026-05-17 HH:MM ET — <gist>` to STATUS.md (the `### ` prefix is required). T4 (Codex) will independently re-verify your CJS-compatibility and Node-compat claims — especially for `express` 5 and `uuid` 14 — so make your evidence concrete (call sites, version-resolution checks, `npm test` runs).
