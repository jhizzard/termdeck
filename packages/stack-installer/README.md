# @jhizzard/termdeck-stack

One-command installer for the TermDeck developer memory stack.

```
npx @jhizzard/termdeck-stack
```

## What gets installed

| Layer | Package | What it does |
|-------|---------|--------------|
| 1 | `@jhizzard/termdeck` | Browser terminal multiplexer with metadata overlays and Flashback recall toasts |
| 2 | `@jhizzard/mnestra` | pgvector memory store + MCP server. Lights up Flashback. Provides `memory_*` tools to Claude Code, Cursor, Windsurf |
| 3 | `@jhizzard/rumen` | Async learning loop on a Supabase Edge Function cron. Synthesizes cross-project insights |
| 4 | `@supabase/mcp-server-supabase` | MCP that lets the TermDeck setup wizard provision your Supabase project automatically |

The wizard:

1. Prints the four-layer overview so you see what you're agreeing to.
2. Detects which pieces are already on your machine.
3. Asks which tier you want (default: 4 — full stack).
4. Runs `npm install -g` for the missing pieces.
5. Merges Mnestra and Supabase MCP entries into `~/.claude/mcp.json` — preserving any existing MCP servers.
6. Prints the next steps (Supabase PAT, credentials, `termdeck` to start).

## Modes

```
npx @jhizzard/termdeck-stack             # interactive
npx @jhizzard/termdeck-stack --tier 4    # unattended
npx @jhizzard/termdeck-stack --dry-run   # print plan, don't install
npx @jhizzard/termdeck-stack --yes       # accept defaults (combine with --tier)
```

## Why this exists

The TermDeck stack used to be a 15-step install: provision Supabase, run six SQL migrations, mint API keys, paste them into `secrets.env`, edit `config.yaml`, install Mnestra globally, deploy Rumen, install the Supabase MCP, wire `~/.claude/mcp.json`. Most testers bounced before step 5.

This installer collapses every step that's a `npm install -g` into one command, then drops the user at the doorstep of the in-browser setup wizard (which handles credentials).

## License

MIT
