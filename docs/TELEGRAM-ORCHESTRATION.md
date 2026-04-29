# Telegram orchestration — bidirectional inject + status from your phone

**Status:** Bot-creation runbook is ready. MCP server wiring is **Sprint 43 T4** (lane brief: `docs/sprint-43-graph-controls-and-cross-project-surfacing/T4-telegram-mcp.md`).

This document is the prerequisite Joshua should run **before** Sprint 43 inject so T4 has a working bot to point the MCP at. T4 picks the actual MCP server (community choice or thin custom wrapper) at inject time.

## Why Telegram (vs WhatsApp)

The existing WhatsApp pattern is one-way: `wa.me/<number>?text=<encoded>` opened via `open` shell command. Orchestrator sends; Joshua reads. There is **no way for Joshua to reply through that channel back to the orchestrator** — replies go to the human Brad/Joshua/etc on the other end, never to a process on Joshua's machine.

Telegram offers a clean Bot API: `sendMessage` (outbound) + `getUpdates` polling (inbound). Both are HTTP endpoints. A bot is a process that the orchestrator can talk to from anywhere; Joshua's chat with the bot becomes a bidirectional control channel.

Use cases this unlocks:

- **"inject sprint 44"** from phone in bed → orchestrator polls bot for new messages → matches the inject command → fires inject script → replies with session IDs.
- **"status"** from phone anywhere → orchestrator replies with sprint state, last cron tick, edge count, current TermDeck version.
- **"edges?"** → orchestrator queries `memory_relationships`, replies with last 24h delta.
- **Push notifications** from background events (cron tick, sprint close, build failure) reach Joshua via the same bot.

## Bot creation runbook (one-time, ~3 minutes)

```
1. Open Telegram (mobile or desktop) → search @BotFather → start chat.
2. Send: /newbot
3. BotFather: "Alright, a new bot. How are we going to call it?"
   Send a display name (e.g. "Joshua TermDeck Orchestrator")
4. BotFather: "Good. Now let's choose a username for your bot. It must end in 'bot'."
   Send a unique username (e.g. "JoshTermDeck_bot" or "jhi_orchestrator_bot").
   If the name is taken, BotFather will ask for another.
5. BotFather replies with:
   "Done! Congratulations on your new bot. ... Use this token to access the HTTP API:
     <BOT_TOKEN>"
   COPY THE TOKEN. It's a string like 1234567890:ABC...XYZ.
6. Send any message ("hi") to your new bot. This is required so it has a
   chat to read updates from.
7. Get your chat ID by hitting:
     curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates"
   Look for `"chat":{"id":<NUMBER>` in the response. The number is your chat ID.
   It's an integer like 123456789 (or negative if you're using a group, but
   we recommend DMs only).
8. Save both values into ~/.termdeck/secrets.env:
     TELEGRAM_BOT_TOKEN=1234567890:ABC...XYZ
     TELEGRAM_CHAT_ID=123456789
9. Tell BotFather to optionally hide the bot from search:
   /setprivacy → select your bot → Enable
   This isn't strictly necessary but reduces drive-by DMs.
```

## Allowlist + safety (CRITICAL)

The bot **MUST** be private — allowlist by chat ID. The MCP server should reject any inbound message from a chat ID not in the allowlist. Without this, a stranger who guesses the bot username could DM commands.

Orchestration channels with code-execution authority should never accept drive-by DMs. The Sprint 43 T4 lane brief enforces this in the MCP wrapper.

If the bot is ever compromised (token leaked), revoke immediately:

```
1. Open Telegram → @BotFather → /revoke
2. Pick the affected bot. BotFather issues a new token; the old one is dead.
3. Update ~/.termdeck/secrets.env with the new token.
4. Restart any orchestrator processes that hold the old token in memory.
```

## Round-trip test (after Sprint 43 T4 lane lands)

```bash
# 1. Confirm bot can read your messages
source ~/.termdeck/secrets.env
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | python3 -m json.tool

# 2. Confirm bot can send to you
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": $TELEGRAM_CHAT_ID, \"text\": \"Hello from your TermDeck orchestrator.\"}"
# → check Telegram on your phone for the message
```

## Pattern: inject from Telegram

Once Sprint 43 T4 wires the MCP, the typical flow is:

```
[Joshua's phone, anywhere]
   "inject sprint 45"
       ↓ (Telegram → bot → MCP polls every 10s)
[Orchestrator session on Joshua's iMac]
   1. memory_recall for sprint-45 plan
   2. read docs/sprint-45-*/PLANNING.md
   3. GET /api/sessions, sort by createdAt
   4. Fire two-stage paste-then-submit on T1-T4
   5. Verify all four panels are 'thinking'
       ↓ (sendMessage)
[Joshua's phone]
   "Sprint 45 injected. T1=486a..., T2=bf7d..., T3=150a..., T4=237e...
    All four panels reasoning. Will notify on lane DONE / blocker."
```

This is the bedroom-orchestration pattern made first-class. No need to be at the iMac for inject; no need to remember terminal commands; Telegram becomes the operator console.

## Threat model

| Risk | Mitigation |
|---|---|
| Token leak (e.g. accidental commit) | Token is in `~/.termdeck/secrets.env` (gitignored repo-wide); revoke + reissue takes 30 seconds via BotFather |
| Strangers DM the bot | Allowlist enforces chat-ID match; out-of-allowlist messages are dropped silently |
| Replay attacks | Orchestrator should only act on messages with `update_id` greater than last-seen `update_id` (standard Telegram pattern); keep last-seen in `~/.termdeck/telegram-state.json` |
| Bot being added to a group | Allowlist by chat ID — group chat IDs are negative integers, won't match Joshua's positive personal ID |

## Sprint 43 T4 will deliver

- `~/.claude.json` MCP server entry pointing at the chosen Telegram MCP.
- Documented round-trip test.
- Memory entry recording bot username + chat ID + permanent authorization (analogous to the WhatsApp Brad-number entry).
- Allowlist-by-chat-ID enforcement (either via the chosen MCP's config option, or a thin wrapper that rejects out-of-allowlist messages before they reach the orchestrator).

Until then: this doc is the prerequisite. Run the bot-creation runbook **before** firing Sprint 43 so T4 has a token to wire up.
