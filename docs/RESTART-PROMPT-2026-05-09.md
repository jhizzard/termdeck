# RESTART-PROMPT — 2026-05-09

**Authored:** 2026-05-09 12:47 ET (Saturday) at session-end of orchestrator UUID `b7bc0aba-2737-4016-ab64-afb2be18a98c`.

**Why this file exists:** Sprint 62 closed GREEN at 21:54 ET on 2026-05-08. Close-out is fully staged in working trees. **The npm publishes did not happen** — Joshua's machine hit `kern.tty.ptmx_max=511` overnight (TermDeck server holding 516 PTY fds for only 4 logical sessions; same fd-leak class as Brad's 2026-05-07 r730 crash forensic — exactly Brad's §4.2 territory). zsh/bash couldn't fork; `npm publish` was unreachable. Joshua exported the four panel transcripts and is rebooting. **Next session resumes the publish wave + ships Sprint 63 = Wave 2.**

---

## Boot sequence (in order)

1. **`mcp__mnestra__memory_recall(project="termdeck", query="Sprint 62 close-out 2026-05-09 PTY leak Wave 2")`** — surfaces the four memories written at this session's close (Sprint 62 outcome, PTY leak, Sprint 63 = Wave 2, staged file list).
2. **`mcp__mnestra__memory_recall(query="recent decisions and bugs 2026-05-08 2026-05-09")`** — broader sweep.
3. Read `~/.claude/CLAUDE.md` (global rules).
4. Read `./CLAUDE.md` (TermDeck project read-order; the P0 banner now points at Investigation 2 only — Investigation 1 was closed by Sprint 62).
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` — Resolution section for Investigation 1 added at sprint close; Investigation 2 still open.
6. Read this file (`docs/RESTART-PROMPT-2026-05-09.md`).
7. Read `docs/sprint-62-mnestra-session-end-coverage/STATUS.md` — full lane posts + final ORCHESTRATOR STAGED block at the bottom.

---

## Step 1 — Publish wave (Joshua, Passkey)

Verify shells now work post-reboot: `ls /dev/ttys* | wc -l` should be well under 511.

Then in this exact order (per `docs/RELEASE.md`):

```bash
# 1. Mnestra
cd ~/Documents/Graciella/engram && npm publish --auth-type=web

# 2. TermDeck (root)
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm publish --auth-type=web

# 3. Stack-installer
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/stack-installer && npm publish --auth-type=web
```

**`--auth-type=web` opens a browser; tap Passkey. NEVER `--otp`** (Sprint 35 lesson — the @jhizzard scope has `auth-and-writes` 2FA; bare `npm publish` will fail with EOTP).

If any publish fails — DO NOT push. Fix and retry, or `npm unpublish` within 24h. Same lesson Sprint 35 close-out cost ~10 min of npm-vs-origin/main skew.

**After all three publishes succeed, verify:**
```bash
npm view @jhizzard/mnestra version          # expect 0.4.9
npm view @jhizzard/termdeck version          # expect 1.1.1
npm view @jhizzard/termdeck-stack version    # expect 1.1.1
```

## Step 2 — Git commit + push (orchestrator)

After publishes succeed, the orchestrator commits + pushes. **Engram first**, then **termdeck**.

### Engram (`~/Documents/Graciella/engram`)

```bash
cd ~/Documents/Graciella/engram
git add package.json CHANGELOG.md src/db.ts src/recall.ts src/types.ts \
        mcp-server/index.ts tests/recall-source-agent.test.ts \
        migrations/021_project_tag_canonicalize_claimguard.sql \
        migrations/022_source_agent_backfill.sql
git commit -m "$(cat <<'EOF'
v0.4.9: ws-polyfill (Brad Node-20) + Sprint 62 (021/022/include_null_source)

Closes Investigation 1 of TermDeck CRITICAL-READ-FIRST-2026-05-07
(cross-agent Mnestra capture on close — empirically confirmed at 27%
coverage during ClaimGuard Sprint 8.0 audit).

Combined ws-polyfill (was queued as 0.4.8 — never published) with
Sprint 62 work into a single 0.4.9 publish. See CHANGELOG for full
detail; tests 70/70 green; package 114KB / 104 files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

### TermDeck (`~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck`)

```bash
cd ~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck
git add package.json CHANGELOG.md \
        packages/client/public/app.js \
        packages/server/src/setup/migrations.js \
        packages/server/src/setup/mnestra-migrations/021_project_tag_canonicalize_claimguard.sql \
        packages/server/src/setup/mnestra-migrations/022_source_agent_backfill.sql \
        packages/server/tests/adapter-session-end-writer.test.js \
        packages/stack-installer/package.json packages/stack-installer/CHANGELOG.md \
        tests/migration-loader-precedence.test.js \
        tests/migration-tracker.test.js \
        tests/project-tag-invariant.test.js \
        docs/sprint-62-mnestra-session-end-coverage/ \
        docs/CRITICAL-READ-FIRST-2026-05-07.md \
        docs/RESTART-PROMPT-2026-05-06.md \
        docs/RESTART-PROMPT-2026-05-09.md
# DO NOT git-add CLAUDE.md unless Joshua confirms — its modification predates this session.
git commit -m "$(cat <<'EOF'
v1.1.1: Sprint 62 — Mnestra session-end coverage + paste-image fix

Closes Investigation 1 of docs/CRITICAL-READ-FIRST-2026-05-07.md.

3+1+1 with Codex auditor; ~80 min wall-clock from inject (2026-05-08
20:34 ET) to T4-CODEX FINAL-VERDICT GREEN (21:54 ET). T4 caught 9
audit concerns (8 in flight, 1 RED block on T1 cleared in re-engage
cycle).

Adds: production-wiring fence tests in npm-test glob (8 tests at
packages/server/tests/adapter-session-end-writer.test.js — boots real
Express app with fake PTY via require.cache, fences term.onExit +
DELETE /api/sessions/:id paths; closes T4-CODEX 21:03 RED). Bundled
mirrors of Mnestra migrations 021 + 022 (sha256-verified byte-identical
with engram source). MIGRATION_PROBES entries for 021 + 022 enabling
Sprint 61 tracker backfill on existing installs. Document-level
capture-phase image-paste handler at app.js:299-331 (xterm-helper-textarea
was consuming paste events before our bubble-phase listener saw image
data). 

Wave: @jhizzard/termdeck@1.1.0→1.1.1, @jhizzard/termdeck-stack@1.1.0→1.1.1
(audit-trail-only), @jhizzard/mnestra@0.4.7→0.4.9 (skipped 0.4.8 — staged
but never published; combined into 0.4.9 with Sprint 62 work).

Tests: root npm test 48/48 green (40 baseline + 5 helper-level + 3
production-wiring fence). Pack 422KB / 118 files clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

After both pushes succeed:

```bash
# Dogfood verify
npm install -g @jhizzard/termdeck@latest && termdeck --version  # expect 1.1.1
```

If anything regresses — file an immediate hotfix as 1.1.2.

---

## Step 3 — Sprint 63 = Wave 2 (Brad's bug-bundle, including the §4.2 PTY-leak fix)

Joshua confirmed at session-end on 2026-05-09: **next sprint is Wave 2.** The PTY exhaustion this morning is exactly §4.2 territory — Brad's patch sets `session.pty = null` on exit + adds `try/catch` belts on ioctl race, which lets GC release the PTY fd refs that are accumulating in the long-running TermDeck server process.

Scope (3+1+1, ~90–120 min wall-clock estimate):

- **§4.1** body-parser SyntaxError flood — Brad has 5-hunk patch verified vs v1.0.12; needs re-verify vs v1.1.1.
- **§4.2** WS ioctl(EBADF/ENOTTY) flood + `session.pty = null` on exit. **THE PTY-LEAK FIX** — top priority.
- **§4.4** v1.1.0 launcher Step 3 `column created_at does not exist` warning — code audit in `stack.js`.
- **§4.5** v1.1.0 dashboard ↔ launcher probe drift — structural fix; converge to one source of truth (launcher's working probes; dashboard reads cached snapshot).
- **§4.6** PTY shell health-check 3s timeout — verify whether 5-5 sprint T3 client-hardcoded-zsh patch landed in v1.1.0/v1.1.1 first; if not, regression not new bug.
- **5-5 carryover** — T1 (env-propagation `getDatabaseUrl` helper), T2 (doctor probe rename + stackCompat ranges rewritten for 1.1.x post-jump), T4 (`stack.js` parent-await for systemd Type=simple).
- **`bin/termdeck-supervised`** wrapper — replaces Brad's `~/start-termdeck.sh` hack with separate stderr capture + daily rotate + boot-banner-with-timestamp for crash fingerprinting.
- **stackCompat range rewrites** post-1.1.0 jump — T2 ranges were authored pre-jump.

Lane shape: T1/T2/T3 Claude workers + T4 Codex auditor + Orchestrator (Claude Opus, separate session). Output: termdeck 1.2.0 (minor — endpoint structural change) + termdeck-stack 1.2.0 audit-trail-aligned.

Reference: Brad's consolidated bug report (~30 KB embedded in the 2026-05-08 emails his Claude sent — see WhatsApp triage exchange). Plus the new PTY-leak diagnosis memory written 2026-05-09 12:47 ET.

---

## Resume command for THIS specific orchestrator session

If for any reason the prior session's accumulated mental model matters more than a clean re-boot from the steps above, re-attach to this exact orchestrator session with:

```
claude --resume b7bc0aba-2737-4016-ab64-afb2be18a98c
```

Verify the exact flag against the current Claude Code 2.x CLI; may be `-r` or `--resume`. Session UUID was discovered from `~/.claude/projects/-Users-joshuaizzard-Documents-Graciella-ChopinNashville-SideHustles-TermDeck-termdeck/b7bc0aba-2737-4016-ab64-afb2be18a98c.jsonl`.

The fresh-session boot above is the canonical path; this resume command is the alternative for cases where in-context state matters more than a clean re-read.

---

## Sprint 62 panel exports (4 panels + 1 orchestrator)

Joshua exported all 5 sessions before shutdown. Locations under `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/`:

- `2026-05-09-122140-Sprint62.txt` (137 KB) — orchestrator (this session)
- `2026-05-09-123518-local-Sprint62T1.txt` (98 KB) — T1 Claude (adapter session-end writer fence tests)
- `2026-05-09-123542-local-Sprint62T2.txt` (53 KB) — T2 Claude (migration 021 project-tag canonicalize)
- `2026-05-09-123622-local-Sprint62T3.txt` (83 KB) — T3 Claude (migration 022 source_agent backfill + include_null_source flag)
- `rollout-2026-05-08T20-39-58-019e0a2d-3f75-7e22-88c5-12e71386796b-recap.md` — T4-CODEX (Codex's own filename pattern)

Reference these only if you need the per-panel detail beyond what STATUS.md captured — STATUS.md is the canonical sprint substrate.
