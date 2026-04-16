# Sprint 7 — Docs Hygiene Pass

Append-only coordination log. Started: 2026-04-16 ~21:10 UTC

## Mission

Eliminate trust-breaking drift between code, docs, and launch assets before Show HN. Source: `docs/DOCS-HYGIENE-ROADMAP-TO-10.md` punch list from Codex audit.

## Terminals

| ID | Spec | Primary file ownership |
|----|------|------------------------|
| T1 | [T1-versions-naming.md](T1-versions-naming.md) | CHANGELOG.md (new), docs/launch/NAMING-DECISIONS.md, docs-site blog posts |
| T2 | [T2-architecture-examples.md](T2-architecture-examples.md) | docs/launch/blog-post-4plus1-orchestration.md, docs-site/src/content/docs/architecture.md |
| T3 | [T3-claude-readme.md](T3-claude-readme.md) | CLAUDE.md, README.md |
| T4 | [T4-freshness-ci.md](T4-freshness-ci.md) | docs/CONTRADICTIONS.md (new), scripts/lint-docs.sh (new), .github/workflows/ |

## File ownership

| File | Owner |
|------|-------|
| CHANGELOG.md (new) | T1 |
| docs/launch/NAMING-DECISIONS.md | T1 |
| docs-site/src/content/docs/blog/*.mdx | T1 |
| docs/launch/blog-post-4plus1-orchestration.md | T2 |
| docs-site/src/content/docs/architecture.md (if exists) | T2 |
| CLAUDE.md | T3 |
| README.md | T3 |
| docs/CONTRADICTIONS.md (new) | T4 |
| scripts/lint-docs.sh (new) | T4 |
| .github/workflows/ci.yml | T4 |
| docs/sprint-7-docs-hygiene/STATUS.md | All (append-only) |

## Rules

1. Append only to STATUS.md.
2. Never edit another terminal's files.
3. Flag blockers with `[Tn] BLOCKED`.
4. Sign off with `[Tn] DONE`.

---

(append below)

## [T2] 2026-04-16 — Architecture + stale CLI examples

- Item 4: Updated `docs/launch/blog-post-4plus1-orchestration.md` line 34 — `termdeck init --engram` → `termdeck init --mnestra`. Other Engram/Mnemos references in the post are intentional historical narrative (screenshot caption, name-dispute story, rename timeline) and were left untouched.
- Item 5: `docs-site/src/content/docs/architecture.md` exists. Reconciled the write-path section: previous text claimed "the event is dropped — there is no retry queue in the hot path", which contradicts `packages/server/src/rag.js` (`_startSync` polls `getUnsyncedRagEvents` from a SQLite outbox every 10s by default). Updated step 4 to describe the SQLite outbox + immediate fire-and-forget push, and rewrote step 5 to characterize the system as "non-blocking hot path with an eventual-consistency sync queue".
- Verified rag.js behavior at lines 5, 14, 30, 38–55, 188–214 before rewriting.
- No other files touched.

[T2] DONE

---

## [T3] 2026-04-16 — CLAUDE.md refreshed, README hierarchy added

**Item 6 (CLAUDE.md):**
- Retitled from "Build Specification" to "Project Notes" — the build is done.
- Removed all "Status: Fully written, needs testing" language from the file-inventory section.
- Replaced the 8-milestone build sequence with a "Completed milestones" historical reference, including Sprint 4 (onboarding tour), Sprint 5 (CSS/JS extraction), and Sprint 6 (preflight + transcripts).
- Updated version reference to v0.3.2 at the top of the file.
- Expanded the file map to include: `style.css`, `app.js`, `preflight.js`, `transcripts.js`, `config.js`, `session-logger.js`, `mnestra-bridge/`, `setup/`, `init-mnestra.js`, `init-rumen.js`, `secrets.env.example`, `transcript-migration.sql`.
- Added the WS message type `proactive_memory` and the log tags `[preflight]`, `[mnestra]`.
- Noted Mnestra replaced the v0.1 Supabase schema for RAG; `termdeck init --mnestra` is the canonical path.
- Kept Architecture decisions and Coding conventions sections intact (still accurate).

**Item 7 (README.md):**
- Added a "Documentation hierarchy" section (6 lines) after the "One command to try it" block and before "How Flashback works", declaring README / GETTING-STARTED / termdeck-docs.vercel.app / docs/launch/ / docs/sprint-N-*/ as the canonical layers.

No other files touched.

[T3] DONE

---

## [T1] 2026-04-16 — Version alignment + legacy name cleanup

**Item 1 (CHANGELOG.md):**
- Extended existing `CHANGELOG.md` (previously only covered 0.1.0 / 0.1.1) with full entries for 0.2.0, 0.2.1, 0.2.2, 0.2.3, 0.2.4, 0.2.5, 0.3.0, 0.3.1, 0.3.2 in Keep a Changelog format.
- Sources: `git log` dates and Sprint 2–7 commit messages. Each version has dated header, Added/Changed/Fixed sections, and a compare link at the bottom.
- Notable coverage: npm publish flatten (0.2.0), Engram→Mnestra rename (0.2.2), init-mnestra dispatch fix (0.2.3), Rumen insights API + client split (0.3.0), preflight + transcripts (0.3.1), RAG outbox data-loss fix + transcript contract + health-badge fix (0.3.2).
- Updated the "Unreleased → Planned" block to reflect current roadmap (local SQLite+embeddings path, multi-user validation, control panel).

**Item 2 (NAMING-DECISIONS.md):**
- Version table bumped to current published versions: `@jhizzard/termdeck@0.3.2` (was 0.2.2) and `@jhizzard/rumen@0.4.1` (was 0.2.2). Mnestra stays at `0.2.0`. No other lines touched.

**Item 3 (docs-site blog posts):**
- `engram-deep-dive.mdx`: title "Mnemos" → "Mnestra"; install line `@jhizzard/mnemos` → `@jhizzard/mnestra`. Filename left as-is (no rename instruction in spec).
- `rumen-deep-dive.mdx`: "write back into Mnemos" → "Mnestra"; "TermDeck captures, Mnemos remembers, Rumen learns" → Mnestra.
- `termdeck-launch.mdx`: "TermDeck → Mnemos → Rumen" → Mnestra; `termdeck init --mnemos` → `--mnestra`.
- No "Engram" references existed in any blog post (all were "Mnemos"). No historical-context occurrences present, so nothing preserved verbatim.

No other files touched. CHANGELOG existed but was extended, not overwritten from scratch.

[T1] DONE
