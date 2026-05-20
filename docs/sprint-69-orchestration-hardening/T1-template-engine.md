# T1 — Boot-prompt Template Engine (Claude Code, worker)

You are **T1**, the Claude Code worker lane in Sprint 69 (Orchestration Hardening). You ship the foundation — the template engine + the 10 boot-prompt templates. T2 (Codex) depends on your exported engine for the `POST /api/sprints/inject` endpoint.

The shared sprint contract is in `docs/sprint-69-orchestration-hardening/PLANNING.md`. The full proposal (309 lines, source-of-truth for the feature design) is at `docs/sprint-69-orchestration-hardening/PROPOSAL.md`. **Read PLANNING.md first**; PROPOSAL.md for the deep design rationale and the exact example template body for `cc-worker`.

## Your lane (file ownership)

**Write (new):**
- `packages/server/src/templates/template-engine.js` — the engine module.
- `packages/server/share/termdeck/templates/cc-worker.txt` — Claude Code worker template (use the PROPOSAL §4.1 example as the seed body).
- `packages/server/share/termdeck/templates/cc-auditor.txt` — Claude Code auditor template (PROPOSAL §5.2 + synchronize-on-LANDED + CHECKPOINT mandate).
- `packages/server/share/termdeck/templates/cc-orchestrator.txt` — Claude Code orchestrator (PROPOSAL §5.3 + default polling discipline + 270s tick).
- `packages/server/share/termdeck/templates/codex-worker.txt`, `codex-auditor.txt`, `gemini-worker.txt`, `gemini-auditor.txt`, `grok-worker.txt`, `grok-auditor.txt` — variants. The worker shape stays similar; differences are: Mnestra MCP availability (Claude Code + Codex have it; Gemini + Grok don't), tool-use idioms, and any CLI-specific quirks you can document from Sprint 2 + Sprint 69 evidence.
- `tests/template-engine.test.js` — 10+ tests.

**May edit:**
- `packages/server/src/index.js` (or wherever the server exports public-API symbols) — register the template engine so T2 can `require('./templates/template-engine')`.
- `package.json` — add `share/termdeck/templates/**` to `files` if not already there. (Check first; if it ships under a wildcard like `share/**`, no edit needed.)

**Do NOT touch:** T2-owned sprint endpoint files; T3-owned parked-detection + parser files; T4-owned test file. If you find a bug in another lane's code, post a `FINDING` routed to that lane.

## Tasks

1. **Baseline.** Before writing code, run `cd /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck && npm test 2>&1 | tail -10` and record the pass/fail count. That's your regression baseline — don't drop below it.

2. **Template engine module.** Implement `loadTemplate(cliType, role, variables) → string`:
   - Look up the template at `~/.termdeck/templates/<cli>-<role>.txt` first; fall back to `<repo>/packages/server/share/termdeck/templates/<cli>-<role>.txt`. If neither exists, throw a `TemplateNotFoundError` naming what was looked up.
   - Read the template UTF-8.
   - Substitute every `{{variable}}` with the matching value from the `variables` object. Use a simple regex `/\{\{(\w+)\}\}/g` — no Mustache import.
   - If any `{{variable}}` is left unsubstituted, throw a `MissingVariableError` naming the missing variables. Do NOT silently leave `{{...}}` in the rendered string — that's a contract violation and will confuse downstream consumers.
   - Optional: expose a `requiredVariables(cliType, role) → string[]` helper that pre-scans the template for `{{...}}` patterns so T2's inject endpoint can validate before render.

3. **10 templates.** Each ~30-50 lines, paste-ready into a CLI panel.
   - `cc-worker.txt` — use the PROPOSAL §4.1 example as the seed; required variables: `lane_tag`, `sprint_name`, `project_name`, `project_path`, `memory_query_lane`, `memory_query_broad`, `sprint_dir`, `lane_brief`, `cross_lane_intel`, `test_command`, `baseline_suite_result`. Includes the "done-when" mandate at top of discipline section.
   - `cc-auditor.txt` — adds: synchronize-on-LANDED clause at top of tasks; 15-min CHECKPOINT mandate; tooling-failure fallback (Sprint 1 Codex precedent). Same variables + `audit_tasks` (a multiline string the orchestrator supplies).
   - `cc-orchestrator.txt` — the orchestrator's own boot. Required variables: `sprint_name`, `sprint_dir`, plus the 270s polling tick template inline.
   - `codex-worker.txt`, `codex-auditor.txt` — Codex has Mnestra MCP, so memory_recall is available. Idiom differences: Codex may use different command syntax for tools — research from prior Codex sprint logs in Mnestra if unsure.
   - `gemini-worker.txt`, `gemini-auditor.txt` — Gemini does NOT have Mnestra MCP in the default setup. Skip the `memory_recall` lines; instead say "the lane brief (`{{lane_brief}}`) is self-contained — start there." The boot still reads CLAUDE.md and the sprint docs.
   - `grok-worker.txt`, `grok-auditor.txt` — same Mnestra caveat as Gemini; skip memory_recall. Adversarial-mindset framing especially important in `grok-auditor.txt`.

4. **Tests** (`tests/template-engine.test.js`, ≥10 tests):
   - `loadTemplate` happy path (cc-worker with all variables) returns the expected substituted string. Assert specific substrings rather than full-string equality (more robust to template tweaks).
   - Override resolution: drop a file at `~/.termdeck/templates/cc-worker.txt` (or a tempdir-based equivalent via env var override) and verify it wins over the default.
   - Missing variable throws `MissingVariableError` naming the missing variable.
   - Unknown CLI type throws `TemplateNotFoundError`.
   - Unknown role throws `TemplateNotFoundError`.
   - `requiredVariables` returns the expected set for `cc-worker`.
   - All 10 template files exist (parameterize a loop over the matrix).
   - Each of the 10 templates declares at least one `{{variable}}` (no static-only templates by accident).
   - Snapshot test: `cc-worker` rendered with a fixed variable set matches a committed fixture. (This is the test T4 will read closest.)

5. **Export.** Add a `require('./templates/template-engine')` line (or `module.exports.templateEngine = require(...)`) in `packages/server/src/index.js` so T2 can import without traversing your internal path. POST a `### [T1] PROPOSE` to STATUS.md naming the exact export shape so T2 can plan against it before you LANDED.

## Discipline

- Post `### [T1] FINDING / PROPOSE / LANDED / DONE 2026-05-20 HH:MM ET — <gist>` to `docs/sprint-69-orchestration-hardening/STATUS.md` (use absolute path: `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-69-orchestration-hardening/STATUS.md`) — your panel's cwd is the Maestro repo; you must `cd` to TermDeck and stay aware of it.
- Run `npm test` before every LANDED. Don't regress the baseline you established in Task 1.
- Post a `### [T1] PROPOSE` post BEFORE you ship the export so T2 (Codex) can plan its inject endpoint against your interface. Use the format `### [T1] PROPOSE 2026-05-20 HH:MM ET — template engine exported as <shape>; T2 can require('./templates/template-engine').loadTemplate(...)`.
- Post `### [T1] DONE 2026-05-20 HH:MM ET — <verdict>` when complete, with a one-line verdict + suite counts.
- Do not bump versions, touch CHANGELOG, or `git commit`. The orchestrator handles commit at sprint close.
