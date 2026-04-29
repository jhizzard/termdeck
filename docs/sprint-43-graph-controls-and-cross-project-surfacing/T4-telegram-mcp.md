# Sprint 43 — T4: Telegram MCP integration

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Joshua wants bidirectional orchestration over Telegram — analogous to the WhatsApp `wa.me` pattern (which is one-way: orchestrator sends, Joshua reads on his phone) but with READ access too (orchestrator can poll Joshua's incoming messages and react). This lets Joshua send "inject sprint 44" or "status" from his phone in bed, anywhere, without opening a TermDeck panel or laptop.

## Bot creation flow (one-time, Joshua tap)

```
1. Open Telegram → search @BotFather → /newbot
2. Pick a bot name (e.g. "JoshTermDeck Orchestrator")
3. Pick a username ending in "bot" (e.g. "JoshTermDeck_bot")
4. BotFather replies with the API token. Save as TELEGRAM_BOT_TOKEN.
5. Send any message to your new bot (DMs only — don't add to a group).
6. Get your chat ID:
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
   → look for `"chat":{"id":<NUMBER>` in the response.
7. Save the number as TELEGRAM_CHAT_ID.
```

## MCP server choice

Recommendation: **`chigwell/telegram-mcp`** (current community leader as of 2026-04). Lane brief should re-evaluate at inject time — npm/MCP ecosystem moves fast; a better one may have shipped.

Alternative: write a thin custom MCP that wraps Telegram Bot API directly (sendMessage, getUpdates, allowlist by chat ID). ~150 LOC. Pro: full control, no external dependency drift. Con: lane time. Recommendation: pick the community MCP if it works and the chat-ID allowlist is configurable; otherwise write the thin wrapper.

## `~/.claude.json` entry shape (lane brief refines at inject)

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "chigwell/telegram-mcp"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "<token>",
        "TELEGRAM_CHAT_ID_ALLOWLIST": "<joshua-chat-id>"
      }
    }
  }
}
```

## Files
- `~/.claude.json` (mcpServers entry — global config, NOT in repo)
- `~/.termdeck/secrets.env` (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — global secrets, NOT in repo)
- NEW `docs/TELEGRAM-ORCHESTRATION.md` — the bidirectional pattern (Joshua → bot → orchestrator → response → Joshua), bot-creation runbook, troubleshooting
- Memory entry (CONTACT — permanent): Joshua's Telegram chat ID + bot username + permanent authorization to send to that chat (analogous to the WhatsApp Brad-number entry in global memory)

## Allowlist + safety

The bot **MUST** be private — allowlist by chat ID. If `TELEGRAM_CHAT_ID_ALLOWLIST` is set, the MCP server should reject any inbound message from a chat ID not in the list. Without this, a stranger who guesses the bot username could DM commands. Orchestration channels with code-execution authority should never accept drive-by DMs.

## Acceptance criteria
1. Joshua can send "status" from his Telegram chat → receive a structured status reply (sprint state, last cron tick, edge count, current TermDeck version).
2. Joshua can send "inject sprint 44" → orchestrator fires inject script and replies with session IDs + status.
3. Bot rejects messages from any chat ID not in `TELEGRAM_CHAT_ID_ALLOWLIST`.
4. `docs/TELEGRAM-ORCHESTRATION.md` documents the full flow including the BotFather runbook.
5. Global memory entry is created with the chat ID + bot username + permanent authorization.

## Lane discipline
- Append-only STATUS.md updates with `T4: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T4 owns Telegram MCP integration. Does NOT touch graph viewer (T1), flashback (T2), or init-rumen (T3)

## Pre-sprint context

- Currently configured MCP servers: `adbliss`, `imessage`, `memory` (per `~/.claude.json` audit 2026-04-29 morning).
- WhatsApp pattern is one-way: `wa.me/<number>?text=<encoded>` opened via `open` shell command. Orchestrator sends; Joshua reads. No way for Joshua to reply through that channel back to the orchestrator.
- iMessage MCP exists but doesn't generalize (Apple-only; Brad uses WhatsApp; iMessage doesn't easily bridge to bot-style orchestration).
- Telegram offers a clean Bot API: `sendMessage` (outbound) + `getUpdates` polling (inbound). Both are HTTP endpoints. The MCP server wraps these as tools the orchestrator can call.

## Open questions for Joshua before inject

- **Bot scope:** PUBLIC or PRIVATE? Recommendation: PRIVATE (allowlist of one). See "Allowlist + safety" above.
- **Bot username:** picks at BotFather; lane brief documents whatever Joshua picks.
- **Multiple chats:** does Joshua want the bot to also reach Brad? Recommendation: NO — separate concerns. Brad-bot is a future Sprint if needed.
