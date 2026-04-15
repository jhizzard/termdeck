# Show HN launch post — TermDeck

**Target:** Hacker News Show HN
**Posting window:** Tuesday or Wednesday, 8:00am PT
**Title (≤80 chars, no emoji, no "Show HN" prefix in this file — HN adds it):**

> TermDeck — the terminal that remembers what you fixed last month

**Body (339 words):**

---

I spent a Tuesday last month re-debugging a CORS misconfiguration I had already fixed three months earlier on a different project. The fix was buried in a git commit message somewhere. I didn't remember I had the fix. That is the whole problem.

TermDeck is a browser-based terminal multiplexer with a persistent memory layer and a proactive recall feature called Flashback. When a panel's status transitions to errored, the output analyzer queries your memory for similar errors across all your projects and surfaces the top hit as a toast on the panel. You don't ask. You don't type a query. The tool notices that you're stuck and offers the memory for you.

[Flashback GIF inline — docs/screenshots/flashback-demo.gif]

The stack is three MIT packages that work together or standalone:

- **TermDeck** — browser PTY multiplexer. 7 layouts, 8 themes, per-panel metadata, onboarding tour. Real terminals in the browser via `node-pty` + `xterm.js` + WebSockets. https://github.com/jhizzard/termdeck
- **Mnestra** — persistent developer memory MCP server. pgvector + hybrid search + 3-layer progressive disclosure. Works with Claude Code, Cursor, Windsurf, Cline, and any MCP-compatible client. https://github.com/jhizzard/mnestra
- **Rumen** — async learning layer. Runs on a 15-minute cron, reads the memory store, synthesizes insights via Haiku, writes them back. https://github.com/jhizzard/rumen

Install takes one command:

```
npx @jhizzard/termdeck
```

Node 18+, any modern browser. Tier 1 (local terminals + metadata) is zero-config. Tier 2 (Flashback + Mnestra memory) needs a Supabase project and an OpenAI key — `termdeck init --mnestra` walks you through it. Tier 3 (Rumen async learning) is `termdeck init --rumen` on top.

Honest limits: Flashback fires on pattern-matched error strings. If the analyzer misses your error class, no flashback. Mnestra uses Supabase for storage and OpenAI for embeddings by default (local-only path is on the roadmap, not v0.2). Validated against 3,451 memories in one developer's store — no multi-user data yet. I built this because I was losing real hours to the same errors on different projects and wanted the tool to notice for me. Flashback has caught six real ones in the last week.

Docs: https://termdeck-docs.vercel.app
GitHub: https://github.com/jhizzard/termdeck

Happy to answer questions.

---

## Notes for Josh (not part of the post body)

- **Do not post until:** (a) `docs/screenshots/flashback-demo.gif` is captured + committed to the `main` branch so the GIF embed resolves, (b) T1 has confirmed the v0.2.2 help-button URL works on a fresh `npx` install, (c) at least one pre-launch tester has confirmed the install runs for them end-to-end. All three gates are in Josh's hands — T4 does not control them.
- **The "six real ones in the last week" number** is lifted from Josh's real Engram store activity during Sprint 2 / Sprint 3. Verify the number still holds when you post — if it drifted lower, change to "several real ones" or quote the precise count from `memory_status_aggregation()`.
- **CORS Tuesday story** — this is a generic placeholder. If Josh has a specific Tuesday and a specific CORS bug he wants to cite (with the project name + the specific error text), substitute them into the first paragraph. Concrete beats generic on HN. If the real story wasn't CORS, swap to whatever the real story was (Postgres migration FK, Stripe Connect webhook signature, anything real).
- **Timing:** post at 8:00am PT (Tuesday or Wednesday), watch the thread for the first 4 hours. Reply to every comment within 30 minutes for that window. The comment playbook (`comment-playbook.md`) has pre-drafted answers for the 10 most likely skeptic questions.
- **First-hour amplification:** post the X thread (`x-thread.md`) 5 minutes after the HN submission, then DM the 5 pre-launch testers so they reply in the first hour with their own testimonial comments.

**Word count:** 339 words in the body (under the 350 target). Under 300 would be tighter, but the stack explanation needs the three names + descriptions to carry the three-tier framing cleanly.
