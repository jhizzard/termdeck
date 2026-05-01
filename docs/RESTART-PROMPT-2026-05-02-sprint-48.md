# Restart prompt — Sprint 48 orchestrator (paste into a fresh Claude Code session)

You are the orchestrator for TermDeck Sprint 48 — Per-agent MCP auto-wire + first real mixed-agent dogfood. Sprint 47 closed clean at 2026-05-01 17:00 ET shipping mixed-4+1 INFRASTRUCTURE (frontmatter parser + boot-prompt resolver + inject script extension with `acceptsPaste` contract + cross-agent STATUS merger). The Grok smoke test confirmed bracketed-paste lands cleanly against Bun+OpenTUI but ALSO surfaced the v1.0.0 gate: `memory_recall` is unavailable to non-Claude agents because their config files ship without `mcpServers` blocks. Sprint 48 closes that gap AND dogfoods mixed 4+1 end-to-end.

## Boot sequence (do these in order, no skipping)

1. Run `date` to time-stamp.
2. `memory_recall(project="termdeck", query="Sprint 48 per-agent MCP auto-wire mixed-agent dogfood Codex Gemini Grok user-settings.json mcpServers v1.0.0 inflection 16 sub-agents")`
3. `memory_recall(query="recent decisions and bugs across projects")`
4. Read `/Users/joshuaizzard/.claude/CLAUDE.md` — global rules. **MANDATORY** sections: time check, session-end email, memory-first, 4+1 inject mandate (two-stage submit), never-copy-paste-messages.
5. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md` — project router (no-TypeScript, vanilla JS, CommonJS, RELEASE.md before publishing).
6. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/RELEASE.md` — strict publish protocol (Passkey, NEVER `--otp`).
7. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/multi-agent-substrate/DESIGN-MEMORIALIZATION-2026-04-29.md` — multi-agent design rationale (Sprint 48 closes the trilogy + dogfood gate).
8. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/AGENT-RUNTIMES.md` — adapter contract spec (8 fields as of Sprint 47; T1 of Sprint 48 should update this to 9 with `mcpConfig`).
9. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-47-mixed-4plus1/STATUS.md` § Side-task progress → Smoke test (Grok) — Grok's PART 2/3 self-analysis is your single best Sprint 48 design input. Specifically PART 3: *"TermDeck should ship automatic population of mcpServers in ~/.grok/user-settings.json (with Mnestra endpoint) as part of Grok panel initialization in Sprint 48."* That's the v1.0.0 gate.
10. Read `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-48-mcp-autowire-and-dogfood/PLANNING.md` — Sprint 48 plan stub (lanes sketched, not yet finalized; orchestrator authors lane briefs after substrate probe).

## Then begin

### (a) Pre-sprint substrate probe

Same 7 checks as Sprint 47 PLANNING.md § "Pre-sprint substrate findings" (npm baselines, server alive, agent adapters, CLI binaries, crons, prior inject script, sprint-inject helper) PLUS the 8th check (per-agent MCP-config file existence). Expected baseline state:
- `npm view @jhizzard/termdeck version` → 0.16.0
- `npm view @jhizzard/termdeck-stack version` → 0.4.11
- `~/.grok/user-settings.json` exists (currently `{"defaultModel": "grok-4.20-0309-reasoning"}`, no `mcpServers`)
- `~/.codex/config.toml` — verify; T1 creates if absent
- `~/.gemini/settings.json` — verify; T2 creates if absent

If any fail, flag to Joshua before authoring lane briefs.

### (b) Author the four lane briefs

Sprint 48's lane briefs do NOT yet exist. Orchestrator authors `docs/sprint-48-mcp-autowire-and-dogfood/T{1,2,3,4}-*.md` based on the PLANNING.md sketch + substrate probe findings. The briefs follow the same shape as Sprint 47's: scope summary, files, API contract, acceptance criteria, boot sequence, lane-discipline reminder. Per-agent MCP-config schema research (TOML for Codex, JSON for Gemini + Grok) goes in T1/T2/T3 briefs respectively as **lane-time investigation tasks** — orchestrator does NOT need to fully resolve the schemas before authoring; the lane itself probes and decides.

### (c) Author the Sprint 48 PLANNING.md frontmatter

If the dogfood lane is the goal (T4), declare frontmatter at the top of PLANNING.md following Sprint 47 T1's spec:

```yaml
---
sprint: 48
lanes:
  - tag: T1
    agent: claude
    project: termdeck
  - tag: T2
    agent: claude
    project: termdeck
  - tag: T3
    agent: claude
    project: termdeck
  - tag: T4
    agent: <PICK ONE NON-CLAUDE — codex / gemini / grok>
    project: termdeck
---
```

Pick the non-Claude agent whose MCP-config path is most-validated at substrate-probe time. **Recommended: Grok** (its config schema was probed during Sprint 47 and `acceptsPaste:true` was empirically confirmed). If Grok's MCP wiring is more uncertain than Codex/Gemini's, pick whichever is most stable.

### (d) Author the inject script

Clone `docs/sprint-47-mixed-4plus1/scripts/inject-sprint47.js` to `docs/sprint-48-mcp-autowire-and-dogfood/scripts/inject-sprint48.js`. The Sprint 47 script is already adapter-driven (declares `agent: 'claude'` per lane and dispatches via `buildPayload()`); Sprint 48 just changes the LANES array to declare the dogfood lane's agent.

### (e) Wait for Joshua to signal "go, inject" (via Telegram or keyboard)

When signaled, fire the inject. The new T3 path handles per-lane agent dispatch; the dogfood lane goes through whichever path the agent's `acceptsPaste` declares (paste for Claude/Codex/Gemini, paste for Grok confirmed Sprint 47, chunked-fallback if a future agent declares `acceptsPaste:false`).

### (f) During sprint execution, run THREE side-tasks in parallel (orchestrator-only, NOT in any lane)

1. **Pick up Sprint 46 deferrals opportunistically.** 14 items still queued. Recommended starting set if budget allows: cosmetic `btn-status`/`btn-config` title attrs, `escapeHtml` dedup at `app.js:2693`/`:4296`, `stripAnsi` extension for Claude TUI spinner glyphs in `transcripts.js`, regex-escape defensive helper in `launcher-resolver.js`. Each ≤30 LOC.
2. **Mixed-agent smoke test (real)** — if T4 lane runs successfully, the dogfood IS the smoke. If T4 hits a TUI-paste / MCP-config issue, fire a synthetic side-panel test on a different agent (per Sprint 47 T3's chunkedFallback contingency).
3. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh** at sprint close. Pin to v0.17.0 (or v1.0.0). Update if user-visible UX shifts.

### (g) Stay in orchestrator mode until all four lanes report DONE

Then run close-out:

1. **v1.0.0 decision.** Evaluate: did per-agent MCP auto-wire ship AND the dogfood lane complete real work? If yes → v1.0.0. If only auto-wire shipped (no dogfood) → v0.17.0. If something failed → v0.16.1 patch.
2. **Bump versions** (root package.json: 0.16.0 → 0.17.0 or 1.0.0 or 0.16.1; stack-installer: 0.4.11 → 0.4.12 audit-trail).
3. **Update CHANGELOG.md** with the chosen version. The [Unreleased] section already lists Sprint 48 candidates; rewrite as [N.M.K] - YYYY-MM-DD.
4. **Update STATUS.md sprint-close summary** at `docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md`.
5. **Run `npm run sync-rumen-functions`** (RELEASE.md step 1).
6. **Run full test suite.** Expect 882+ baseline + ~30-50 new from T1-T4. Target ~920-930 / 0 fail / 3 skipped.
7. **`npm pack --dry-run`** to verify both tarballs. The `files` glob in root `package.json` does NOT currently include `packages/server/src/setup/rumen/functions/**` — verify that's still there in the published tarball or update the glob.
8. **Commit** with HEREDOC commit message following Sprint 45 / 46 / 47 patterns.
9. **Push** to origin/main.
10. **DO NOT publish to npm.** Hand publish commands to Joshua per RELEASE.md (Passkey via `--auth-type=web`).
11. **Draft session-end email** to `admin@nashvillechopin.org` with htmlBody per the global mandate. Subject: `TermDeck Wrap — Sprint 48 MCP auto-wire + mixed-agent dogfood + v1.0.0 → YYYY-MM-DD HH:MM ET` (use actual local time from `date`).

### (h) If Joshua chooses v1.0.0 at close, also do this

- Update `package.json` keywords / description to reflect production status.
- Add a `## [1.0.0] - 2026-XX-XX` heading in CHANGELOG with a migration-and-readiness note.
- Update `docs/INSTALL-FOR-COLLABORATORS.md` audience line from "experienced engineers" to "anyone running the stack."
- Consider a fresh blog post at `docs-site/src/content/docs/blog/v1.0-RELEASE.mdx` (RELEASE.md says optional; for v1.0 it's worth doing).
- Bump portfolio at `~/Documents/Graciella/joshuaizzard-dev` (version badge).

## Reference: where things live

- **Lane briefs** (orchestrator authors): `docs/sprint-48-mcp-autowire-and-dogfood/T{1,2,3,4}-*.md`.
- **Inject script** (orchestrator authors via clone): `docs/sprint-48-mcp-autowire-and-dogfood/scripts/inject-sprint48.js`.
- **STATUS.md** (lanes write append-only): `docs/sprint-48-mcp-autowire-and-dogfood/STATUS.md`.
- **Sprint 47 STATUS.md** (the closed sprint — read for context, ESPECIALLY the Grok smoke-test self-analysis): `docs/sprint-47-mixed-4plus1/STATUS.md`.
- **Sprint 47 PLANNING.md** (the closed sprint plan): `docs/sprint-47-mixed-4plus1/PLANNING.md`.
- **Two-stage submit reference:** `~/.claude/CLAUDE.md` § "MANDATORY: 4+1 sprint orchestration — always inject, never copy-paste".

## Final note from the Sprint 47 orchestrator

Sprint 47 closed clean — three of four lanes shipped in <14 min wall-clock each; T4 hit a 16-min hung full-suite run that was killed and replaced with a focused subset (status-merger.js is purely additive, zero regression risk; trade-off was reasonable). The Grok type-detection bug Joshua surfaced live (panel showing "Shell" while Grok was clearly running) was fixed inline as a side-task — Sprint 45 T3 anchored on `Message Grok…` placeholder which the TUI rotates; the fix uses the model-mode footer line which renders on every frame.

The cross-session orchestrator pickup (Sprint 46 close-out's hook env-var fix) was bundled into Sprint 47's commit, so Joshua's `npx @jhizzard/termdeck-stack@latest` re-bundle after publish picks up BOTH Sprint 47's lane work AND the env-var fix in one re-install. Mnestra session-summary ingestion that's been silently broken for 4+ days will start landing memories again immediately on first Stop hook fire post-reinstall.

The single biggest signal for Sprint 48 is Grok's own self-analysis posted to STATUS.md at 2026-05-01 16:52 ET (panel `518adedc`). It's better strategic input than anything I could have authored independently — Grok knows what Grok needs better than Claude does. Read it carefully. PART 3's single-sentence Sprint 48 recommendation is the v1.0.0 gate.

If at substrate-probe time Joshua isn't actually ready for v1.0.0 (e.g. wants to defer mixed-agent dogfood and ship just the auto-wire), accept that and target v0.17.0. Don't push v1.0.0 if the dogfood doesn't happen — outside-user readiness is the framing, and untested mixed-agent infra isn't outside-user-ready even if the auto-wire is in place.

Good luck. — Sprint 47 orchestrator (close 2026-05-01 17:00 ET).
