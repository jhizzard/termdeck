# T1 — Doctrine registry core (Sprint 78)

**Mission:** Build the machine-readable doctrine registry that is the SUBSTRATE every later stage (T2 advisor, Sprint 79 elevation, Sprint 80 git-hooks/inject-refusal) consumes. JSONL source-of-truth, a fail-soft CJS loader with per-surface severity validation + forbidden-strings screen + cooldown/budget throttle, ~8 seed entries, and the packaging/vendoring wiring so it ships clean.

---

## Scope — files you own

You own a NEW top-level `doctrine/` directory plus two packaging edits. termdeck = **vanilla JS / CommonJS `require()` / zero build step / fail-soft**. No TS, no new deps.

### 1. `doctrine/registry.jsonl` (NEW — one JSON object per line)
One JSON object per line (JSONL, NOT YAML — locked, AMEND §3.1 kept-core). Each entry's schema (PLANNING §4 + §4 table):

```
id, title, severity, scope(universal|operator-local), audience,
trigger, check{ type: regex|script|sql|manual, ... },
enforcement{ surface, max_severity, ref },
source{ incident, memory_recall_query },
advisory{ one_line (≤200 chars), procedure_path, cooldown_hours },
status, version
```

**Seed ~8 universal advisory entries** (all `scope:'universal'`, `audience:'all'`, `status:'active'`, advisory-tier surfaces):
publish-before-push, RLS five gates, two-stage-inject ban, STATUS grammar, CHECKPOINT cadence, tolerant idle-poll regex, DONE-with-open-YELLOW, secrets-in-commits.

**Plus** (so coverage stats can't lie — AMEND §3.1):
- **inventory entries** for rules ALREADY mechanized (git hooks, gitleaks) — so the registry is an honest census, not a wishlist.
- **`check.type:'manual'` honesty entries** for prose residue that is not yet machine-checkable. A manual entry is a real row, just flagged as un-mechanized.

**Forbidden:** the operator-local scrub rule does NOT carry pattern text here. The repo registry carries only a **stub** for the scrub rule (`scope:'operator-local'`, no pattern, advisory text references the local overlay) — the real pattern lives in the never-shipped `~/.claude/doctrine/registry.local.jsonl` (AMEND-1). Do NOT widen `~/.gitleaks.toml` allowlist.

### 2. `doctrine/SCHEMA.md` (NEW — human-readable field contract)
Document every field, allowed enum values (esp. `enforcement.surface` ∈ git-hook | preToolUse-deny | inject-refusal | server-monitor | inject-advisory | status-append, and `check.type` ∈ regex | script | sql | manual), and the **max_severity-per-surface table** (below) so future authors don't write a rejected entry.

### 3. `doctrine/index.js` (NEW — CJS, zero-dep loader)
Exports (at minimum):

- **`loadDoctrine({event, cwd, audience})`** — merges, in precedence order:
  1. repo `doctrine/registry.jsonl` (shipped)
  2. `~/.claude/doctrine/registry.local.jsonl` overlay (AMEND-1 — Joshua-only operator-local rules; **never in repo, never in tarball**)
  3. `~/.termdeck/doctrine-local/` overlay (origin='local' rows)

  **Both overlays absent ⇒ returns the repo entries, never throws** (acceptance gate). Per-entry **try/catch trigger compilation** (A9): a malformed regex/trigger on one entry logs a warning and skips that entry; it never poisons the whole load. Filter by `event`/`audience` when provided.

- **`validateEntry(entry)` / max_severity-per-surface validation (AMEND-3 — REJECTS):** the validator REJECTS any entry whose `enforcement.surface` is `server-monitor` or `inject-advisory` but claims `max_severity:'block'` — those surfaces are **capped at `warn`**. `status-append` rules are **structurally advisory forever** (lanes write STATUS.md via direct tool calls; there is no interception point) — reject any `block` claim there too. `block` is permitted ONLY on `git-hook`, `preToolUse-deny`, `inject-refusal`. A rejected entry is dropped from the loaded set with a logged reason (fail-soft) — loadDoctrine still returns the valid remainder.

- **Forbidden-strings screen (A11 / AMEND-2):** at load, screen **every advisory `one_line` and every path field** through a **gitleaks shell-out** (`/usr/local/bin/gitleaks` present; user's `~/.gitleaks.toml`). NEVER hardcode the forbidden patterns in this file (the patterns ARE the leak). **Fail-soft if gitleaks is absent** — log one warning and continue (Brad may not have it). An entry whose advisory text trips the screen is dropped + logged; it never reaches agent context or public STATUS.md.

- **`recordGateEvent(...)` (AMEND-11):** wrapped in try/catch, **NEVER throws** into a hook/commit/inject/PTY path — errors log and the function returns. Backed by a `doctrine_events` SQLite store (sibling of `flashback_events` in `packages/server/src/database.js` — see Anchors; reuse the existing better-sqlite3 handle pattern, do not open a second DB file).

- **`shouldNotify(rule_id, dedupe_key)` (AMEND-5):** cooldown/budget throttle backed by `doctrine_events`. Defaults (PLANNING §2 row 2 + AMEND-5): **per-rule 30-min cooldown**, **hard 3-advisories/lane/hour budget**, overflow routes to ORCH (return a sentinel/reason, do not inject). Returns a decision object `{ notify: bool, reason }` so T2 can log the suppression reason. This is the function T2 consumes — keep its signature stable and documented.

### 4. `package.json` files whitelist (EDIT)
Add `"doctrine/**"` to the `files` array (currently the whitelist has no doctrine entry — verified). Place it so `npm pack --dry-run` cites `doctrine/registry.jsonl`, `doctrine/SCHEMA.md`, `doctrine/index.js` AND emphatically does NOT include any `registry.local.jsonl` or `~/.claude`/`~/.termdeck` overlay file.

### 5. stack-installer vendoring + full-file version stamp (EDIT — AMEND-10)
Vendor `doctrine/` into the stack-installer's asset/refresh path so Brad gets a **read-only** copy (active `audience:'all'` entries only, baked at publish). Extend the paired-version check to cover doctrine. **CRITICAL: use a full-file version stamp, NEVER the 4KB-head stamp.** The existing hook-update path in `packages/stack-installer/src/index.js` reads `slice(0, 4096)` (lines ~646, ~667, ~684) and matches `HOOK_SIGNATURE_REGEX` against only the head — that is the exact stamp that already failed (file gets defaulted-as-hand-edited, bundled fixes never land). Stamp/compare doctrine over the **whole file** (e.g. content hash or a version field read from the JSONL/loader, full read — not a 4KB head slice). `loadDoctrine` version-checks at every load. No CLAUDE.md render machinery on Brad's path.

---

## Applied amendments (ULTRAPLAN §3.1)

- **AMEND-1 (registry split, blocker):** operator-local rules → `~/.claude/doctrine/registry.local.jsonl`, never repo/tarball. Repo carries a pattern-less stub for the scrub rule. gitleaks allowlist NOT widened. ⇒ your loader MUST read the overlay if present and the repo MUST NOT contain pattern text.
- **AMEND-2 / A11 (forbidden-strings screen, blocker):** gitleaks shell-out over every advisory line + path at load; fail-soft if gitleaks absent; zero hardcoded forbidden patterns in `index.js`. Also: **do NOT write a new frontmatter parser** — AMEND-2's other half is "extend the shipped `sprint-frontmatter.js`," and that retrofit is **Sprint 80, not you**.
- **AMEND-3 (max_severity per surface — VALIDATOR REJECTS):** server-monitor & inject-advisory capped at `warn`; status-append structurally advisory forever; `block` only on git-hook / preToolUse-deny / inject-refusal. A registry never implies enforcement that is architecturally impossible.
- **AMEND-5 (rate-limiting lives in the registry stage):** `shouldNotify` + `doctrine_events`; per-rule 30-min cooldown, 3/lane/hr hard budget, overflow→ORCH; default routing for all advisories is ORCH.
- **AMEND-10 (Brad hardening):** doctrine vendored read-only into stack-installer, paired-version check extended, **full-file** stamp (never 4KB-head), audience:'all' only, version-check at every load, no render machinery on Brad's path.
- **AMEND-11 (fail-soft everywhere):** `recordGateEvent` never throws into hook/commit/inject paths; loader no-ops with a logged warning on unreadable inputs.
- **A9 (per-entry try/catch + optional overlays):** every entry carries `scope: universal|operator-local`; per-entry try/catch regex compilation; missing overlays = empty, not error.

---

## Acceptance (PLANNING §4 — behavior, not file-existence; INSTALLER-PITFALLS ledger #16)

Expanded into a checklist the worker must satisfy:

- [ ] **Behavior tests in the canonical test glob** exercise load / merge / validate / throttle / screen. The glob is `packages/server/tests/**/*.test.js` (+ cli/stack-installer/mcp-bridge/web-chat-driver dirs) — see Anchors; **the root `tests/` dir is NOT in the glob**, so a test placed there is silently never run. Put the suite in `packages/server/tests/doctrine-*.test.js`.
- [ ] A registry entry claiming `block` on a **`server-monitor`** surface **FAILS validation** (dropped + logged; loadDoctrine returns the valid remainder).
- [ ] `npm pack --dry-run` cites `doctrine/` lines (registry.jsonl, SCHEMA.md, index.js) **AND shows NO local-overlay file** (no `registry.local.jsonl`, no `~/.claude`/`~/.termdeck` content).
- [ ] **gitleaks clean on every shipped file** (registry.jsonl included — no forbidden string, no pattern text leaked via the scrub-rule stub).
- [ ] **`loadDoctrine` succeeds with BOTH overlays absent** — returns repo entries, never throws.
- [ ] `recordGateEvent` and the forbidden-strings screen are demonstrably fail-soft: gitleaks-absent ⇒ one warning + continue; bad DB write ⇒ logged + exit 0, never throws.
- [ ] `shouldNotify` enforces per-rule 30-min cooldown and 3/lane/hr budget; a 4th in-hour call for one lane returns `notify:false` with an overflow reason.

---

## Anchors (briefs-are-hypotheses — re-verify at boot, post divergence as FINDING)

Verified by ORCH 2026-06-13 against the live tree; re-confirm and FINDING any drift:

- **`doctrine/` does NOT exist yet** — you create it at repo root (`~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/doctrine/`).
- **`package.json` `files` array** has NO doctrine entry (confirmed). Test script: `node --test packages/server/tests/**/*.test.js packages/cli/tests/**/*.test.js packages/stack-installer/tests/**/*.test.js packages/mcp-bridge/test/*.test.js packages/web-chat-driver/tests/*.test.js`.
- **Canonical test glob = the five `packages/*/tests` (and `packages/*/test`) dirs ONLY.** Root `tests/` holds engram migration fixtures and is **not** in the glob — DO NOT land T1 tests there.
- **`packages/stack-installer/src/index.js`** 4KB-head stamp: `slice(0, 4096)` at lines ~646, ~667, ~684; `HOOK_SIGNATURE_REGEX` + `TERMDECK_MANAGED_MARKERS`; `installPreCompactHook` at ~834, exported ~1123. This is the stamp to NOT replicate — full-file stamp for doctrine.
- **`packages/server/src/database.js`** — `flashback_events` CREATE TABLE at ~line 27; better-sqlite3 `new Database(dbPath)` at ~51. Add `doctrine_events` here as a sibling, reuse the handle.
- **`/usr/local/bin/gitleaks`** present; **`~/.gitleaks.toml`** present (3806 bytes). Shell out to these; never hardcode patterns.
- **`packages/server/src/sprint-frontmatter.js`** (4997 bytes, Sprint 47) exists — do NOT write a new parser; doctrine frontmatter is additive keys (Sprint 80, not you).
- **MIGRATION-NUMBER CAVEAT (engram lane note, FYI):** engram migrations **025 + 026 already exist on disk**; that caveat governs T3 (it lands at the next free number). You touch NO migrations — flagged only so you don't accidentally reference a stale number in seed `enforcement.ref` fields.

If any anchor diverges from the live tree at boot, post `### [T1] FINDING <ts> — <anchor> drifted: <detail>` before proceeding.

---

## Lane discipline

- **Post shape (uniform, all lanes):** `### [T1] VERB 2026-MM-DD HH:MM ET — <gist>` where VERB ∈ FINDING / FIX-PROPOSED / FIX-LANDED / DONE (HANDOFF-REQUEST/ACK if a seam arises). Post to STATUS.md only — append-only, never mutate prior posts.
- **Tolerant idle-poll regex** (if you ever wait on another lane): `^(### )?\[T<n>\] DONE\b`.
- **HANDOFF seam:** T1 has **no mandatory cross-lane seam** — but T2 CONSUMES your `shouldNotify(rule_id, dedupe_key)` and the registry schema. Lock that signature early and post `### [T1] FIX-LANDED <ts> — shouldNotify + registry schema stable for T2` so T2 can build against it. If T2 needs a schema change, expect a HANDOFF-REQUEST from them; ACK or counter.
- **PERIPHERY WATCH:** if you touch any file another lane owns (you should NOT — your only shared-surface edits are `package.json` and `packages/stack-installer/src/index.js`, both T1-owned this sprint), post a FINDING. `packages/server/src/index.js` `onErrorDetected` is **T2's** edit — do not touch it; you only provide the loader T2 calls.
- **In-lane:** no version bumps, no CHANGELOG edits, no commits. ORCH owns all close-out (RELEASE.md order, package vendoring audit-trail bump, publish).

---

## Out of scope / do NOT touch

- **`packages/server/src/index.js` `onErrorDetected` (2134–2198) and `packages/server/src/advisor/*`** — T2 owns the advisor MVP and the handler wiring. You supply `loadDoctrine` / `shouldNotify` / `recordGateEvent`; you do NOT call them from the error path.
- **Anything in engram** (migrations, webhook-server.ts, recall-log) — T3.
- **No new frontmatter parser** — extending `sprint-frontmatter.js` with doctrine keys is **Sprint 80** (AMEND-2). Do not start it.
- **`doctrine/render.js`, the `checks/*` suite (status-lint, anchor-check, rls-audit, etc.), sprint-inject refusal gate, derived CLAUDE.md blocks** — all **Sprint 80**. You build only the registry + loader + seed + packaging.
- **Rumen `doctrine_registry` DB table, doctrine-scan, materialize/ratify CLI** — **Sprint 79**. The repo JSONL is the source of truth; the DB table is only Sprint 79's staging state.
- **Operator-local pattern text** — never in the repo registry; stub only. Real patterns live in `~/.claude/doctrine/registry.local.jsonl` (never shipped).
- **Widening `~/.gitleaks.toml`** — do not.
- **Supabase / advisory_events sync** — out of scope this sprint (T2's telemetry is SQLite-only; offline-complete).
