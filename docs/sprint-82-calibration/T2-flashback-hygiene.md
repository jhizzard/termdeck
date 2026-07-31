# T2 — Flashback hygiene: threshold, query, expired≠dismissed, honest UI

**Working dir:** this termdeck repo (`packages/server` + `packages/client`). You do NOT write SQL migrations — if you need schema, post a SCHEMA-REQUEST to T1 (interface I2, first 30 min).

## The four defects (audited 2026-07-30, file:line verified)

1. **Query is PTY noise.** `packages/server/src/index.js:2740` builds the recall question as `"<type> error <lastCommand> <tail>"` where tail = last 200 chars of ANSI-stripped buffer (`session.js:547`). But `_detectErrors` already isolates the actual matched error line (`session.js:487-490`, `matchedLine`). Embed THAT (matchedLine first, lastCommand as secondary context, drop the raw tail).
2. **No quality gate.** Candidate selection (`index.js:2771-2799` + `flashback-diag.js:215-234 pickNextNonDismissed`) walks score order with NO threshold — every surviving error fires a toast off whatever the top hit is. Add a threshold on **`semantic_similarity`** (arriving via T1's migration 033 — watch STATUS.md for `^(### )?\[T1\] SCHEMA-READY`). Feature-detect: if the field is absent from the RPC/webhook response (pre-033 store), keep current behavior unchanged. Threshold default ~0.35 cosine, env-tunable (`TERMDECK_FLASHBACK_MIN_SIMILARITY`), below-threshold = no toast + a diag event (`flashback-diag` already has the event plumbing).
3. **Timeout ≡ dismissal (the pool-drain bug).** `packages/client/public/app.js:1822`: the 30 s auto-timeout calls the same dismiss path as an explicit user dismissal; `isMemoryDismissed` (`flashback-diag.js:177-190`) is global + permanent. Split the semantics: (a) client sends a distinct signal for timeout (`expired`) vs user-click dismissal; (b) server records them distinctly (the events store already has separate clicked/dismissed timestamps — extend minimally; if a column is needed, SCHEMA-REQUEST to T1); (c) blacklist logic: `expired` entries do NOT blacklist (a toast nobody saw is not a rejection); explicit `dismissed` entries blacklist with a **14-day TTL** (env-tunable), not forever.
4. **Lying UI.** `app.js:1785` renders `(hit.similarity * 100).toFixed(0)%` — but `hit.similarity` is the RRF composite (`mnestra-bridge/index.js:92` maps `m.similarity ?? m.score`), so good hits display "2%". Fix: when `semantic_similarity` is present, show it as `match NN%`; when absent, show NO percentage (a neutral "related memory" label). Never render the RRF composite as a percentage anywhere.

## Also in scope

- **Solved-problem decay:** once T1's `p_decay_profile` exists, error-triggered recalls pass `'solved-problem'` (direct mode: RPC args at `mnestra-bridge/index.js:58-67`; webhook mode: include it in the POST body — the webhook passes through unknown args today, verify). Feature-detect like the threshold.
- Keep all three bridge modes (`direct`/`webhook`/`mcp`) behaviorally consistent for what you touch; `mcp` mode is known-least-proven (BACKLOG V5-5) — don't fix it wholesale, just don't regress it.
- Tests: server-side unit tests for threshold + expired-vs-dismissed + TTL (the flashback tests live in the packages/server test tree — follow the existing patterns); a client-side test only if the harness supports it, otherwise document manual verification steps in your DONE post.

## Boot + discipline

Boot: `memory_recall(project="termdeck", query="flashback pipeline threshold dismissed")`, `memory_recall(query="flashback dismissed forever timeout pool drain")`, read `~/.claude/CLAUDE.md`, `./CLAUDE.md`, sprint `PLANNING.md` + `STATUS.md`, then this brief. Stay in lane (no SQL, no engram repo, no rumen repo). Post `### [T2] <VERB> 2026-MM-DD HH:MM ET — <gist>`: FINDING / SCHEMA-REQUEST (early!) / FIX-PROPOSED / FIX-LANDED / DONE. No version bumps, no CHANGELOG, no commits.
