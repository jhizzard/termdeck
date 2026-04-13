# Followup — items deferred out of the 2026-04-13 review

Everything here is **not a blocker for this session's commits**. Land the commits first, then work this list.

## Security

- [ ] **Rotate leaked API keys.** Your `~/.termdeck/config.yaml` contained a live Supabase service role key and OpenAI key which were echoed into a Claude Code context window during the 2026-04-13 Phase D review. Rotate both:
  - OpenAI: platform.openai.com → API keys → Revoke the leaked one → create new → update `~/.termdeck/config.yaml`
  - Supabase: Project Settings → API → Reset service_role secret → update `~/.termdeck/config.yaml`
- [ ] **Confirm no repo has a copy of `~/.termdeck/config.yaml`.** Run `grep -r 'sk-proj-\|sb_secret_' ~/Documents/Graciella 2>/dev/null`. If any hit, purge from git history with `git filter-repo` or BFG.
- [ ] **Consider moving secrets out of `config.yaml`.** Have TermDeck read from `~/.termdeck/secrets.env` or the macOS Keychain instead, so the config file can be committed to dotfiles without leaking.

## T1 — client UI bugs surfaced in review

- [ ] **macOS Alt key bug — switcher doesn't fire on Mac.** Browser keybind handler uses `e.key` which on macOS produces `¡` for Alt+1, not `1`. Fix: use `e.code === 'Digit1'` instead.
  - File: `packages/client/public/index.html`
  - Find: `grep -n altKey packages/client/public/index.html`
  - One-line swap from `e.key` to `e.code`, parse digit from `e.code.slice(5)`.
- [ ] **Switcher overlay covers PTY text.** T1 mounted the switcher inside a panel container instead of the top toolbar. Fix: re-parent to `document.body` or the top `.toolbar` element with `position: fixed; top: 8px; right: 12px; z-index: 1000;`.
- [ ] **Reply target dropdown has no unique names.** Current label is `${typeLabel} · ${project}` (see `refreshReplyTargets` at ~line 1569). Two "Claude Code · termdeck" panels get identical labels and are indistinguishable. Fix options:
  1. Append a stable per-panel index: `Claude Code · termdeck #2` where `#N` is the insertion order.
  2. Let the user double-click the panel header to rename it, store `meta.label` on the session, persist via `PATCH /api/sessions/:id`.
  3. Both — index as fallback, custom name takes precedence.
  Recommended: start with option 1 (5-line change, no server work). Add option 2 later if users ask.
- [ ] **T1.7 screenshots (deferred).** Capture three PNGs with a live server and Playwright, drop in `docs/screenshots/`: dashboard 4-panel, info tabs drawer open, switcher overlay with 8 panels.

## T2 — server deferred items

- [ ] **T2.6 Docker prebuild verification.** Run on a machine with Docker:
  ```
  docker run --rm -v $(pwd):/app -w /app node:24-alpine sh -lc "rm -rf node_modules && npm install --no-save"
  ```
  Must succeed with no C++ compiler present. If it fails, the `prebuild-install` wiring is incomplete for alpine and you'll need a different base image or a `prebuildify` step.
- [ ] **T2.5 session log directory didn't appear during review.** Possible causes: (a) server wasn't started with `--session-logs` or `sessionLogs.enabled: true`, (b) the panel wasn't actually closed (the summarizer only runs on real exit), (c) `ANTHROPIC_API_KEY` not set so the summarizer silently no-op'd. Investigate: `grep -n 'session-logs\|sessionLogs\|SessionLogger' packages/server/src/**/*.js` then run server with the flag, open a shell panel, type `exit`, and check `ls ~/.termdeck/sessions/`.

## T3 — Engram deferred items

- [ ] **Webhook has no CLI entry.** `startWebhookServer()` is exported but nothing in the package calls it at top level. The plan said `engram serve` should start it. Fix: add a CLI subcommand to `mcp-server/index.ts` (or a separate `dist/src/webhook-cli.js` binary) so users can run `engram serve` instead of the `node -e` one-liner.

- [ ] **`GET /observation/:id` returns 500 against existing production Supabase.** Error: `column memory_items.archived does not exist`. Root cause: Engram v0.2 schema assumes columns (`archived`, `superseded_by`, `updated_at`) that the rag-system production store predates. See "Supabase schema drift" section below.

- [ ] **`POST /engram` with malformed JSON returns 500 instead of 400.** In `webhook-server.ts` `readJsonBody` throws on `JSON.parse`, caught by the outer handler which sends 500. Wrap the parse in a try/catch and send 400 on parse error.

- [ ] **`handleHealth` / `memoryStatus` `is_active` filter excluding real rows.** The `op: index` call returned 5 real memories from today, but `op: status` reports `total_active: 0`. Either the `is_active` column defaults to false and writers aren't setting it, or the status aggregator has a filter mismatch. Investigate `src/remember.ts` — does it set `is_active: true` explicitly?

## Supabase schema drift — architectural followup

- [ ] **Decide on migration path for production RAG store.** The production Supabase (same one TermDeck, PVB, and the global MCP server all point at) predates Engram v0.2's schema additions (`archived`, `superseded_by`, `updated_at`). Three options:
  1. **Migrate in place** (recommended). Snapshot via T3.5 `memory_export`, diff schema with `pg_dump --schema-only`, apply additive `alter table` statements via Supabase SQL editor, re-run Phase D healthz + citation.
  2. **Provision a new clean v0.2 Supabase**, export from old via T3.5, import to new via T3.5, point TermDeck's config at new. Costs more, keeps old frozen.
  3. **Make the webhook schema-tolerant** with feature-detection queries. Fastest but accrues debt.
- [ ] **Before any migration, verify `migrations/001_engram_tables.sql` is idempotent.** If it uses bare `create table memory_items (...)` it will error on the existing table. Extract the additive delta into a new `004_v0_2_additions.sql` if needed.

## T4 — Rumen + docs site deferred items

- [ ] **T4.1/T4.2 Rumen CI green.** Push the Rumen branch, verify GitHub Actions runs the integration test against ephemeral Postgres 16 and it passes.
- [ ] **T4 docs site — sitemap warning.** `astro build` emits: `[WARN] [@astrojs/sitemap] The Sitemap integration requires the site astro.config option. Skipping.` Fix: add `site: 'https://termdeck.dev'` (or whichever domain you'll deploy at) to `docs-site/astro.config.mjs` as the top-level option. One-line fix, 30 seconds.
- [ ] **Unexpected file `scripts/test-rest.ts` in rumen.** Not in the plan. Decide: keep it (integration aid for the Engram webhook) or drop it (scope creep).

## Reply feature — product question from Josh

> "I need to understand the use case of being able to send a message from one terminal to another, and whether a Claude Code or Codex or Gemini session can be spoken to / speak to other terminals using a similar ID."

**What it does today:** `POST /api/sessions/:id/input` writes raw text into the target session's PTY. That text is indistinguishable from the user typing. If the target is an idle zsh, it runs the line. If the target is a running Claude Code REPL, it submits the line as a prompt.

**One-way, not conversational.** You can prompt another agent from a different terminal, but you cannot *receive* a structured response back — the only return channel is PTY stdout, which the output analyzer parses heuristically. If you want true agent-to-agent collaboration, use **Engram as the shared bus:** agent A writes a decision via `memory_remember`, agent B reads it via `memory_recall`. Both sessions get the benefit without either having to listen to the other's stream.

**Three realistic use cases:**
1. **Hand-off.** You're deep in panel A debugging a build, and panel B is running Claude Code on the same repo. Highlight an error line, hit reply → send to B → "fix this: &lt;paste&gt;". Claude Code takes it from there.
2. **Broadcast.** Send `git pull` or `source ~/.zshrc` to all panels at once. (Needs a small UI addition to multi-select targets — currently single-target only.)
3. **Watchdog.** A long-running test in panel A finishes and the output analyzer catches it; fire an automatic reply to panel B with `ls -la artifacts/` so the next step is staged.

**Naming.** See T1 bug above — the dropdown label problem is real and has a clean fix. Pick option 1 or 2 from the T1 "Reply target dropdown" item depending on how much UX investment you want.

## Cross-project

- [ ] **Publish decisions.** Engram v0.2, Rumen v0.2, TermDeck rename are staged but NOT versioned or `npm publish`-ed. Decide per-package when to tag.
- [ ] **Tag commits.** After landing, tag each repo: `git tag v0.2.0` in engram and rumen, `git tag v0.2.0` in termdeck.
- [ ] **Update STATUS.md epilogue** with what actually shipped vs. what ended up in FOLLOWUP.
