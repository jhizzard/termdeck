# Restart prompt — 2026-05-06 (Supabase security + Mnestra 0.4.4→0.4.6 + Sprint 58 GREEN)

**Session ended:** 2026-05-06 14:14 EDT (Wednesday)
**Wall-clock:** ~3.5 hours
**Trigger:** Brad's RLS-flag email landed mid-morning, expected to be a 30-minute fix; cascaded into a full Supabase security audit across 4 projects + paradigm rollout + a Mnestra release wave.
**Resume command for THIS session (preserves accumulated mental model):**
```
claude --resume a85cc9d2-0246-47f2-9f58-1e4e4514f369
```

## What shipped

### npm releases — `@jhizzard/mnestra`
| Version | Status | What |
|---|---|---|
| 0.4.3 | superseded | last clean release before today |
| 0.4.4 | **deprecated → 0.4.6** | migration 019 — drops 4 PUBLIC INSERT policies, revokes anon/auth EXECUTE on 11 functions, pins search_path, recreates SECURITY DEFINER view safely |
| 0.4.5 | **deprecated → 0.4.6** | docs hygiene scrub — removed internal project name + external operator project names from shipped artifacts (CHANGELOG, migration comments, doc) |
| 0.4.6 | **current latest** | two corrections to 0.4.4/0.4.5: (a) `search_path` now includes `extensions` schema (the bug that broke `<=>` operator on the reference project), (b) signature-agnostic DO blocks make 019 idempotent across both schema generations (memory_items-only AND layered-memory) |

### Supabase data lockdown — 4 projects
| Project | Scope | Migration applied |
|---|---|---|
| `podium-prod` (Chopin Festival applicant portal) | 17 tables RLS-off, RefreshToken + WixSyncConfig API key sensitive cols | `lockdown_2026_05_06_enable_rls_all_tables` — all 17 tables RLS-on |
| `claimguard-ai` | 9 tables RLS-off + 1 mutable search_path on `organization_id()` | same shape, locked + pinned |
| reference Mnestra project | 3 rumen_* tables RLS-off (post-019 hardening already done earlier) | `lockdown_2026_05_06_enable_rls_rumen_tables` |
| `termdeck-dogfood-2026-05-04` | 6 tables RLS-off + missing 019 + Mnestra holes | retroactive 019 + `lockdown_2026_05_06_enable_rls_mnestra_tables` |
| `bhht-video-extractor` | clean — INFO level only | no action |

Verified: zero `rls_disabled_in_public` tables across all 4 affected projects.

### `~/.claude/CLAUDE.md` standing rules added
1. **MANDATORY: Supabase RLS + privilege hygiene — 5 gates** (was 4; gate 5 added after the podium incident: every public-schema table must have RLS enabled).
2. **MANDATORY: The forbidden internal project name never appears in external-facing artifacts.** Promoted from project-scoped memory to global standing rule after I leaked it 3× in the same publish wave.
3. **MANDATORY: Secret-leak prevention — gitleaks pre-commit + pre-push hooks + nightly mirror backups.** Both parts wired today; verified blocking on a fake JWT test.

### Tooling installed
- `gitleaks 8.30.1` via Homebrew, wired globally via `core.hooksPath = ~/.githooks`. Custom forbidden-string rules in `~/.gitleaks.toml` (internal project name, project refs, external operator names). Allowlist for engram migration 012's legitimate content classifier (the load-bearing literal is the rule itself — allowlisted in `~/.gitleaks.toml`).
- `init.templateDir = ~/.git-template` global config so every new `git init` inherits the hooks.
- Backup script `~/.local/bin/git-mirror-active-repos.sh` — first run completed in 8 sec, snapshotting 8 repos to `~/git-backups/`.
- LaunchAgent staged at `~/git-backups/com.jhizzard.gitmirror.plist` — operator install pending (sandbox blocked direct install).

### TermDeck Sprint 58 — re-engaged from YELLOW to GREEN
- T4-CODEX RED verdict from 2026-05-05 16:47 ET adopted in full and repaired today.
- 6 fixture-level RED blockers fixed via `codex:codex-rescue` dispatch in ~10 min wall-clock (vs 90-min budget): Brad #1 (nohup secrets via `/proc/<pid>/environ`), #2 (literal-quoted DATABASE_URL via direct `env:` injection), #5×2 (PTY-spawn before init wizards; alpine kept distinct), #6 (no hardcoded `--omit=optional`), #7/#8 (working-tree install + `envsubst` for URL substitution + post-startup PATH check via `systemd-run --scope`).
- Orchestrator-scope meta/hygiene: fixture-status-meta set-completeness assertion, shared `concurrency: shared-test-supabase-project` lock across both workflows, `packages/stack-installer/supabase/.gitignore` noise suppression.
- Pushed as commit `d1fc11d` on TermDeck main.
- Sprint 59 dependency now unblocked.

### Communication
- Two Brad WhatsApp messages delivered via wa.me deep-link autosend pattern. First: 0.4.4 fix summary with risk framing (per-anon-key blast radius, not cross-tenant). Second: 0.4.6 corrections + corrected framing (memory_items IS canonical, no migrate-up needed for his installs).

## What's planned next

| Priority | Item | Effort |
|---|---|---|
| P3 | LaunchAgent install for nightly backups: `cp ~/git-backups/com.jhizzard.gitmirror.plist ~/Library/LaunchAgents/ && launchctl load -w ~/Library/LaunchAgents/com.jhizzard.gitmirror.plist` | 30 sec |
| P3 | **Phase B for Sprint 58**: shared test Supabase project provisioning + 10 GitHub Actions secrets + canary row + reset-script live verification. Deferred from Sprint 58 close decision; ~15 min operator action. Until then, install-smoke and systemd-nightly workflows fail at secrets-load (expected pre-Phase-B state). | 15 min |
| P2 | **Sprint 59** — Brad bug fixes against the now-GREEN catch-net. 5 P0 source-code root-fixes (per Codex's spotted-but-not-changed list): config.js DATABASE_URL quote-normalization, server/src/index.js:938 PTY shell fallback, --service launcher flag, default --include=optional on Linux x64, loadSecrets injecting into process.env at preflight. | 2-3 hours |
| P3 | Mnestra schema bug for next release: fresh installs ship without RLS-on on `memory_*` / `rumen_*` / `mnestra_*` tables. Add migration 020 to a future Mnestra release. | 30 min |
| P4 | Vestigial `mnestra_*` tables on the reference project: not canonical Mnestra; harmless under RLS-on + service-role-only. Cleanup TBD. | TBD |
| P4 | TermDeck repo's own historical forbidden-literal references (`BACKLOG.md`, Sprint 51.5 docs, RESTART-PROMPT-2026-05-03). Pre-date today's gitleaks rule, grandfathered. Mirror backups make destructive history-rewrite safe whenever you want to do it. | 1-2 hours destructive |

## Where the restart-prompt docs live

| Doc | Path |
|---|---|
| **This session's restart prompt** | `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-05-06.md` |
| Prior session's restart prompt | `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-05-03-sprint-51.5.md` |
| Global rules | `~/.claude/CLAUDE.md` |
| TermDeck project rules | `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` |
| Mnestra (engram) project rules | `~/Documents/Graciella/engram/CLAUDE.md` (if present) |
| Mnestra security flag (today's source-of-truth) | `~/Documents/Graciella/engram/docs/SECURITY-HARDENING-2026-05-06.md` |
| Sprint 58 STATUS (now GREEN) | `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-58-environment-coverage/STATUS.md` |
| Sprint 59 PLANNING (stub) | `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-59-brad-bug-fixes-against-catch-net/PLANNING.md` |

## Restart prompt for the next session — paste-ready

```
1. memory_recall(project="termdeck", query="Supabase RLS hygiene + Mnestra 0.4.6 + Sprint 58 GREEN + gitleaks paradigm")
2. memory_recall(query="recent decisions and bugs")
3. Read ~/.claude/CLAUDE.md
4. Read ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RESTART-PROMPT-2026-05-06.md
6. memory_recall(query="<topic Josh signals at session start>")

Then begin. Standing context for the next session:
- @jhizzard/mnestra@0.4.6 is the current latest. 0.4.4 + 0.4.5 deprecated.
- 4 Supabase projects locked down (RLS-on across the board).
- gitleaks pre-commit + pre-push active globally; 5-gate Supabase hygiene rule in stone.
- Sprint 58 is GREEN; Sprint 59 unblocked, ready when Josh wants to run it.
- LaunchAgent for nightly mirror backups: install pending (one-line cp + launchctl load).
- Phase B for catch-net (test Supabase project + 10 secrets): pending operator action.
- The reference Mnestra project carries vestigial `mnestra_*` tables that are NOT canonical; canonical Mnestra is `memory_items / memory_relationships / memory_sessions + 6 memory_*` RPCs.
- pgvector lives in `extensions` schema on Supabase >= 2024 — search_path on Mnestra functions MUST include it.
```

## Resume command for THIS specific session (alternative to fresh-start above)

If accumulated mental model matters more than a clean re-read of memory + docs:

<pre>claude --resume a85cc9d2-0246-47f2-9f58-1e4e4514f369</pre>

Re-attaches to this orchestrator session. Different shape from the fresh restart-prompt path: section "Restart prompt for the next session" boots a NEW session with cold context (re-reading memory + CLAUDE.md + this doc); the resume command continues THIS session. Use the resume when picking up the same incident/sprint within hours; use the fresh-start when there's been a context switch (different project, new day, etc.).

---

## Addendum — resume-session work, 14:14 → 17:56 ET

After the original wrap at 14:14 ET, Joshua resumed this session via `claude --resume a85cc9d2-0246-47f2-9f58-1e4e4514f369` for follow-up Brad communications. Work landed:

### Brad-facing artifacts (3 desktop files + ~6 WhatsApp messages)

1. **`~/Desktop/claude-md-template-v2-2026-05-06.md`** (148 lines, 12.8KB) — fuller-scrubbed global CLAUDE.md template. Adds three sections that v1 lacked: 3+1+1 inject mechanics with two-stage submit pattern, never-copy-paste-messages rule with channel inject patterns + wa.me autosend ceiling, memory-vs-plans-vs-tasks distinction. Shared with Brad via WhatsApp file-attach.
2. **`~/Desktop/claude-md-supporting-files-2026-05-06.md`** (368 lines, 11.8KB) — gitleaks pre-commit + pre-push scripts, gitleaks.toml with example rules, mirror-backup bash script with placeholder REPO_PATHS, launchd plist with placeholder USERNAME/LABEL, install one-liner, verification scratch-repo test, systemd-timer Linux appendix. Shared with Brad via WhatsApp file-attach.
3. **`~/Desktop/claude-md-template-2026-05-06.md`** (v1, superseded by v2 — kept for reference).

### Operational findings persisted to memory

- **wa.me autosend URL-length ceiling**: between 5230 and 8435 URL chars. Practical rule: keep under ~5000 URL-encoded chars (~3500 source chars) for reliable autosend; above that, switch to file-share-via-WhatsApp + short-message-via-wa.me split pattern.
- **External-install-readiness calibration**: TermDeck+Mnestra+Rumen stack is currently early-adopter peer-shareable, NOT external-mass-ready. ~2-3 sprints out from external-mass-ready (Sprint 59 + proposed Sprint 60+ install-polish + Phase B catch-net wiring).
- **Sprint 60+ install-polish proposal**: queued conceptually. Goal: interactive setup wizard for the stack-installer that handles all operator-side customizations automatically + clean OS-detection branching (macOS vs Linux) + schema-generation auto-detection. Prerequisites: Sprint 59 + Phase B ship first.

### Refined sprint queue (priority-ordered, post-resume-session)

| # | Sprint | Effort | Status |
|---|---|---|---|
| 1 | **Phase B for Sprint 58** — shared test Supabase project + 10 GitHub Actions secrets + canary row | ~15 min operator action | unblocked |
| 2 | **Sprint 59** — Brad's 5 P0 source-code root-fixes (`config.js` quote-normalize, `server/src/index.js:938` PTY fallback, `--service` flag, default `--include=optional` on Linux x64, `loadSecrets`→`process.env` at preflight) | 2-3 hours | unblocked |
| 3 | **Mnestra 0.4.7+ schema bug** — RLS-on baseline migration for fresh installs | 30 min | queued |
| 4 | **Sprint 60+ install-polish** (proposed, not yet authored) — interactive setup wizard, OS detection, schema-generation auto-detection. Closes the gap to external-mass-ready. | 1-2 days | proposed |
| 5 | Cost-monitoring panel (Sprint 51 vision) | TBD | deferred indefinitely |
| 6 | Audit-upgrade schema-generation probe | 30 min | deferred |
| 7 | Vestigial mnestra_* tables on reference project + TermDeck historical forbidden-literal scrub via filter-repo | 1-2 hours each | maintenance |

### Brad's response signal — Linux/R730-specific customization

Brad mentioned having Claude help with "final steps specific to the r730 and Ubuntu" — confirms the Linux-environment friction tax is real. Sprint 59's `--include=optional` Linux fix + Sprint 60+'s OS-detection wizard are the path to flattening that.

