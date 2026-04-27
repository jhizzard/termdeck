# TermDeck session-end memory hook

The `@jhizzard/termdeck-stack` installer can drop `memory-session-end.js`
into `~/.claude/hooks/` and wire it into `~/.claude/settings.json` under
`hooks.Stop`. The installer prompts you before doing this; default is yes.

## What the hook does

On every Claude Code session close, Claude Code fires its `Stop` hook with
a JSON payload on stdin:

```json
{ "transcript_path": "/path/to/session-transcript.jsonl", "cwd": "/path/where/you/were/working" }
```

The hook:

1. Skips transcripts smaller than 5 KB (no signal in tiny sessions).
2. Detects the project from `cwd` against a built-in regex table; falls
   back to `"global"` when nothing matches.
3. Spawns a detached ingester (`process-session.ts` from `rag-system`),
   which reads the transcript and writes a session summary into Mnestra.
4. Logs every step to `~/.claude/hooks/memory-hook.log`.

The spawn is detached + unref'd, so Claude Code's session close is not
blocked waiting for ingestion — the 30-second `timeout` in
`settings.json` is a backstop, not a target.

## Dependency on `rag-system`

The hook delegates ingestion to a script inside the `rag-system` repo:

```
${RAG_DIR}/src/scripts/process-session.ts
```

`RAG_DIR` resolves in this order:

1. `process.env.TERMDECK_RAG_DIR` (if set)
2. `~/Documents/Graciella/rag-system` (default — Joshua's layout)

**If the resolved `RAG_DIR` does not exist on disk, the hook logs that
fact and exits cleanly.** It does not error, does not block session
close, and does not leak a spawn. Fresh users who installed the stack
but do not have `rag-system` checked out will see this skip-message in
the log and nothing else — as if no hook were installed.

A future TermDeck sprint will rewrite the hook to call Mnestra's MCP
tools directly so the `rag-system` dependency drops away. Until then,
this hook is most useful for users who already have `rag-system`
available.

## How to disable

Two options:

1. Edit `~/.claude/settings.json` and remove the entry under `hooks.Stop`
   that references `memory-session-end.js`. Leave the file in place; it
   simply won't fire.
2. Or delete `~/.claude/hooks/memory-session-end.js` and remove the
   `settings.json` entry. (Removing only the file leaves a broken
   `command` in settings — Claude Code will log a missing-file error on
   every session close.)

Re-running `npx @jhizzard/termdeck-stack` after disabling will re-prompt
to install. Decline at the prompt to stay opted out.

## Log file

`~/.claude/hooks/memory-hook.log` accumulates one line per session-close
event. The hook never rotates it. If it grows unwieldy you can truncate
it (`: > ~/.claude/hooks/memory-hook.log`) without affecting hook
behavior.
