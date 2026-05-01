# TermDeck session-end memory hook

The `@jhizzard/termdeck-stack` installer can drop `memory-session-end.js`
into `~/.claude/hooks/` and wire it into `~/.claude/settings.json` under
`hooks.Stop`. The installer prompts you before doing this; default is
yes.

## What the hook does

On every Claude Code session close, Claude Code fires its `Stop` hook
with a JSON payload on stdin:

```json
{ "transcript_path": "/path/to/session.jsonl", "cwd": "/path/where/you/were/working", "session_id": "..." }
```

The hook:

1. Skips transcripts smaller than 5 KB (no signal in tiny sessions —
   override via `TERMDECK_HOOK_MIN_BYTES`).
2. Validates env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENAI_API_KEY`); if any are missing, logs the missing list and
   exits cleanly without blocking the session close.
3. Detects the project from `cwd` against a built-in regex table; falls
   back to `"global"` when nothing matches. **The default table is
   intentionally empty** — see "Customizing the project map" below to
   add your own entries.
4. Builds a coarse session summary from the last ~30 messages of the
   transcript (~7 KB cap to stay inside OpenAI's embedding-input
   budget).
5. Embeds the summary via OpenAI `text-embedding-3-small` (1,536-dim).
6. POSTs **one row** to Supabase `/rest/v1/memory_items` with
   `source_type='session_summary'`.
7. Logs every step to `~/.claude/hooks/memory-hook.log`.

The hook is **fail-soft**: any error (network, parse, env-var-missing,
malformed transcript) is logged and the hook exits 0. Claude Code's
session close is never blocked.

## Required environment

The hook needs three env vars at run time:

| Var | What | How to set |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL (e.g. `https://abc.supabase.co`) | `~/.termdeck/secrets.env` (Tier 2) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key with INSERT on `memory_items`. **Not the anon key.** | `~/.termdeck/secrets.env` |
| `OPENAI_API_KEY` | OpenAI key for embedding inference | `~/.termdeck/secrets.env` or your shell |

Claude Code propagates the parent shell's environment into hook
processes, so anything in your shell init or
`~/.termdeck/secrets.env` (sourced by `scripts/start.sh` /
`npx @jhizzard/termdeck`) is visible to the hook.

If any of the three is missing the log line will name them:

```
[2026-04-27T21:30:00.000Z] env-var-missing: OPENAI_API_KEY — set these in ~/.termdeck/secrets.env or your shell to enable Mnestra ingestion. Skipping.
```

## Customizing the project map

The hook ships with an **empty `PROJECT_MAP`** by default — every
session lands under `project: 'global'` until you add entries. To add
your own:

1. Open `~/.claude/hooks/memory-session-end.js` after the installer
   has dropped it.
2. Find the `PROJECT_MAP` array near the top of the file.
3. Add one entry per project; each entry is `{ pattern, project }`
   where `pattern` is a regex matched against `cwd`.

### Order matters: most-specific-first

`detectProject(cwd)` returns the **first** matching entry. If a deep
project lives under a broader parent dir, the deep pattern must come
first or the parent will swallow it. This bug bit the TermDeck team in
Sprint 41 — every cwd under a `ChopinNashville/` parent was getting
tagged `chopin-nashville` because the parent-dir pattern came before
each sub-project's specific pattern.

Example showing the right ordering:

```js
const PROJECT_MAP = [
  // Specific code projects under a common parent — these MUST appear
  // before the parent-dir catch-all below.
  { pattern: /\/MyOrg\/SideProjects\/widget-app/i,  project: 'widget-app' },
  { pattern: /\/MyOrg\/SideProjects\/scheduler/i,   project: 'scheduler' },
  { pattern: /\/MyOrg\/2026\/festival\/podium/i,    project: 'podium' },
  { pattern: /\/MyOrg\/2026\/festival/i,            project: 'festival' },

  // Other top-level projects.
  { pattern: /\/PVB\//i,                            project: 'pvb' },

  // Catch-all for the parent dir — only matches when no specific
  // project above matched first.
  { pattern: /\/MyOrg(\/|$)/i,                      project: 'myorg-ops' },
];
```

For a worked example of a real production taxonomy (with explicit
priority ordering, alias documentation, and a structural-invariant
test), see [`docs/PROJECT-TAXONOMY.md`](https://github.com/jhizzard/termdeck/blob/main/docs/PROJECT-TAXONOMY.md)
in the TermDeck repo.

### Other rules

- The map is local-only — it's never sent to any service. Editing it
  takes effect on the next Claude Code session close (no restart
  needed).
- Anything that doesn't match falls through to `'global'`.
- Adopt the module-export contract (`module.exports = { detectProject, PROJECT_MAP }`)
  if you want to write a unit test that exercises your taxonomy. The
  bundled hook already does this; if you copy-paste a custom hook,
  preserve the `if (require.main === module)` guard around the stdin
  reader so `require()` doesn't hang.

## Coexistence with Joshua's `rag-system` hook

If you have Joshua's private `rag-system` repo and his rag-system-based
session hook installed, this bundled hook and that one can coexist:

- The bundled hook writes `source_type='session_summary'` — one row
  per session, summary-only.
- The `rag-system` hook writes `source_type='fact'` — multiple rows
  per session via Claude Haiku fact extraction + dedup.

Different `source_type` values mean the two paths don't dedup against
each other. If both are installed at the same path
(`~/.claude/hooks/memory-session-end.js`) the installer will prompt
before overwriting; choose accordingly.

## How to disable

Two options:

1. Edit `~/.claude/settings.json` and remove the entry under
   `hooks.Stop` that references `memory-session-end.js`. Leave the
   file in place; it simply won't fire.
2. Or delete `~/.claude/hooks/memory-session-end.js` AND remove the
   `settings.json` entry. (Removing only the file leaves a broken
   `command` in settings — Claude Code will log a missing-file error
   on every session close.)

Re-running `npx @jhizzard/termdeck-stack` after disabling will
re-prompt to install. Decline at the prompt to stay opted out.

## Optional flags

| Env var | Effect |
|---|---|
| `TERMDECK_HOOK_DEBUG=1` | Verbose `[debug]` lines in the log |
| `TERMDECK_HOOK_MIN_BYTES=10000` | Override the 5 KB skip threshold |

## Log file

`~/.claude/hooks/memory-hook.log` accumulates one line per session
event (skips, errors, ingests). The hook never rotates it. If it
grows unwieldy you can truncate it
(`: > ~/.claude/hooks/memory-hook.log`) without affecting hook
behavior.
