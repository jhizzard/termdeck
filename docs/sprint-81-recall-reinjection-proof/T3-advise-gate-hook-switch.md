# T3 — advise→gate enforcement + pre-compact hook switch · Sprint 81
**Deck :3001 · cwd `…/TermDeck/termdeck` · Model Opus 4.8**

## Boot
1. `memory_recall(project="termdeck", query="TermDeck PreToolUse advise gate bundled hook installer memory-pre-compact ingest_capture INSTALLER-PITFALLS")` then `memory_recall(query="recent decisions and bugs")`
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`, and **`docs/INSTALLER-PITFALLS.md` (MANDATORY — this is the high-risk hook/installer surface)**
3. Read `docs/sprint-81-recall-reinjection-proof/PLANNING.md` — **your charter is § T3**
4. Read the sibling `STATUS.md`

## Your work
**(A) 2 PreToolUse deny gates** — net-new bundled hooks under `packages/stack-installer/assets/hooks/`: `gate-publish-before-push.js`, `gate-migration-without-rls.js`. Each a small **fail-soft** node script (any error → exit 0 / ALLOW). Registry-driven via `doctrine/index.js` (`BLOCK_ALLOWED_SURFACES` already permits `preToolUse-deny`; `doctrine-cli.js cmdPromote:405` already stages the metadata). Mirror the PreCompact installer trio: add `installPreToolUseHook`/`_mergePreToolUseHookEntry`/`_isPreToolUseHookEntry` to `packages/stack-installer/src/index.js` (template `:573`/`:847`), wire into main install (`~:1149`) **and** `init-mnestra.js:571 refreshBundledHookIfNewer`. `settings.hooks.PreToolUse` matcher = `Bash` for the git gates. **Exactly these two rules — do not generalize.**

**(B) pre-compact hook → `ingest_capture`** (030 step 2): switch `packages/stack-installer/assets/hooks/memory-pre-compact.js` (`:138-181`) from raw `POST /rest/v1/memory_items` to `POST /rest/v1/rpc/ingest_capture` (`{content, source_type:'pre_compact_snapshot', source_session_id, ...}`). **Verify the hook sends a stable non-null `source_session_id`** or the rolling ON-CONFLICT never engages. Add the changed hook to the `init-mnestra` refresh set.

## Order / deps (LOAD-BEARING)
T1's dup-collapse (030 step 1) can land anytime. **Your hook switch must be ready before the precompact unique index exists.** ORCH creates that index LAST at close-out, after confirming your switch. If the index existed before your switch, the current append-per-compaction hook's next insert violates it (fail-soft → silent capture loss). Coordinate with T1 via STATUS.md. (A) is fully independent — do it first.

## Discipline
- Post `### [T3] VERB 2026-07-05 HH:MM ET — gist`. No version bumps / CHANGELOG / commits / publish. termdeck→1.14.0 / stack→1.12.0 (ORCH bumps).
- Every hook fail-soft — a too-aggressive gate that blocks a legit commit/push is a P0. Trace every change to an INSTALLER-PITFALLS class.
