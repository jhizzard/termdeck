# Sprint 25 — Supabase MCP in the Setup Wizard

Append-only coordination log.

## Mission

Drive the credential-paste step of the Tier 2 setup wizard down to zero by letting the wizard talk to Supabase directly through `@supabase/mcp-server-supabase`. After Sprint 23 the wizard already validates pasted credentials and runs all 7 migrations. After this sprint, a user with a Supabase Personal Access Token (PAT) clicks one button and the wizard:

1. Asks Supabase to list their projects (or create a new one)
2. Reads the project URL, anon key, service role key, and database URL via the MCP
3. Hands those credentials to the existing `POST /api/setup/configure` endpoint
4. Triggers the existing `POST /api/setup/migrate` flow

The current 4-credential paste step collapses to "select a project from a dropdown."

## Why this sprint

The IDEAS-AND-STATUS overview names this as item #11 — the single biggest simplification we haven't shipped. Brad's onboarding hit it: even after we walked him through SSH tunneling, he still has to make a Supabase project, find the service role key (3 clicks deep), find the database URL (a different 3 clicks), and paste both. Anyone less patient than Brad bounces at this step. Supabase MCP is the lever that moves "create + connect Supabase" from a 15-minute Tier 2 install down to ~30 seconds.

Sprint 23's wizard infrastructure (`POST /api/setup/configure`, `POST /api/setup/migrate`, the credential form) is the foundation. This sprint just feeds it from a different source.

## Out of scope

- Auto-creating Supabase projects via the MCP. v1 just lists existing projects and connects to one. Project creation can come in v2 once we know the PAT-scopes story.
- Replacing the manual paste flow. Both paths must coexist — some users won't want to share a PAT.
- Migrating away from `@supabase/supabase-js` for runtime work. The MCP is wizard-time only; runtime stays on the existing webhook + direct paths.

## Approach

Two viable architectures:

### A. MCP as a server-side helper (recommended)
- TermDeck server spawns `@supabase/mcp-server-supabase` as a subprocess on demand (when the wizard calls `POST /api/setup/supabase/projects`).
- Server passes user-provided PAT via env var.
- Server reads project list, returns shaped JSON to the wizard.
- On project selection, server reads the credentials via MCP, then plumbs them into the existing `/api/setup/configure` validator + writer.

Pros: User never holds the MCP. Single PAT lives in the wizard request body, never persisted. Reuses every Sprint 23 validator and writer.

Cons: New dependency. We need to detect whether the MCP binary is installed (or bundle it).

### B. MCP as a Claude Code MCP integration
- User adds `@supabase/mcp-server-supabase` to `~/.claude/mcp.json` themselves.
- TermDeck wizard tells the user to ask Claude Code "set up my TermDeck stack."
- Claude Code (the agent, not TermDeck) drives the MCP, the migrations, and the writes.

Pros: Zero new TermDeck code. Just docs.

Cons: Hard fail when the user doesn't have Claude Code, and the experience now depends on the agent's reliability instead of TermDeck's. Brad's case (testing TermDeck in isolation) breaks here.

**Recommend (A).** Option B is fine for the Claude Code crowd but isn't the simplification we're after.

## Terminals

| ID | Spec | Primary file ownership |
|----|------|------------------------|
| T1 | T1-mcp-bridge.md | `packages/server/src/setup/supabase-mcp.js` (new) — spawn + JSON-RPC envelope |
| T2 | T2-wizard-endpoints.md | `packages/server/src/index.js` — `POST /api/setup/supabase/connect`, `/projects`, `/select` |
| T3 | T3-wizard-ui.md | `packages/client/public/app.js` — PAT field + project picker + "back to manual paste" escape |
| T4 | T4-mcp-detection.md | `packages/cli/src/index.js` — preflight check that warns if `@supabase/mcp-server-supabase` isn't on PATH (non-blocking) |
| T5 | T5-flashback-regression.md | `packages/server/src/mnestra-bridge/index.js`, `packages/server/src/rag.js`, `tests/flashback-e2e.test.js` — diagnose why Flashback is silent again post-Sprint-21 fix |

## Acceptance criteria

- [ ] User pastes Supabase PAT in the wizard → projects load within 5s.
- [ ] User selects a project → existing migrations + config write fire automatically.
- [ ] On any MCP failure, wizard falls back to the manual paste form with a clear error.
- [ ] PAT is never persisted — held only in the request lifetime.
- [ ] No regression for users who skip the PAT path and paste credentials manually.
- [ ] Tests cover: MCP-not-installed, PAT invalid, PAT valid + zero projects, PAT valid + multiple projects, project selection success, project selection failure mid-migration.
- [ ] CHANGELOG entry under v0.5.x with explicit "no breaking changes for manual-paste users."

## Open questions

- **MCP binary distribution.** Do we add `@supabase/mcp-server-supabase` to TermDeck's deps, or detect-and-prompt-install? Probably detect — it's a heavy dep for users who never use it.
- **PAT scope.** Does Supabase let you mint a read-only-projects PAT, or is it all-or-nothing? If all-or-nothing, the wizard should warn loudly.
- **Project creation.** Defer to v2 unless the MCP makes it trivial.

## Rules

1. Append only to STATUS.md. 2. Never edit another terminal's files.
3. Flag blockers with `[Tn] BLOCKED`. 4. Sign off with `[Tn] DONE`.

---
(append below)
