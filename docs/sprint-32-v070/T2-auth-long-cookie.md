# T2 — Auth long-cookie (30-day persistence)

You are Terminal 2 in Sprint 32 / v0.7.0 of TermDeck. Your lane: bump the auth cookie's max-age to 30 days so testers don't have to re-enter the auth token every time they open a new browser, incognito tab, or different browser entirely. Brad reported this 2026-04-26: *"is there a way not to have to enter the token at each termdeck session?"* Approved by Josh: low risk, local app.

## Read first
1. `docs/sprint-32-v070/PLANNING.md` — sprint overview, especially "Auth long-cookie (T2)" under "Architectural decisions"
2. `docs/sprint-32-v070/STATUS.md` — protocol for posting CLAIM / DONE / REQUEST / BLOCKED
3. `packages/server/src/auth.js` — the existing token-auth module (Sprint 9, v0.3.4)

## You own these files
- `packages/server/src/auth.js`
- `tests/auth-cookie.test.js` — NEW file

## You DO NOT touch
- Anything else. This is a single-file change with a single-file test.

## What "done" looks like

1. The cookie writer (look for `Set-Cookie` or `res.cookie` calls in auth.js) sets:
   - `Max-Age=2592000` (30 days, in seconds)
   - `HttpOnly` (already set, keep it)
   - `SameSite=Lax` (already set, keep it)
   - `Secure` ONLY when the request came over HTTPS. Detect via `req.protocol === 'https'` OR `req.headers['x-forwarded-proto'] === 'https'` (the latter for users behind a reverse proxy as documented in `docs/DEPLOYMENT.md`). Brad's local SSH-forwarded setup is HTTP, so `Secure` would break his cookie if always-on.
2. Update the head-of-file comment block in `auth.js` to document the trade-off: 30 days picked because TermDeck is intended as a local dev tool; cookie compromise risk is bounded by the local-only attack surface; the friction of re-entering on every browser materially hurts adoption (Brad's 2026-04-26 feedback).
3. Backwards compat: pre-v0.7.0 cookies that were session-scoped (no Max-Age) still work for the lifetime of the browser session. New cookies issued by v0.7.0+ get the 30-day Max-Age. No migration needed; no flag.

## Tests (`tests/auth-cookie.test.js`)

Use a fake Express response object (capture `res.cookie` calls or `res.setHeader('Set-Cookie', ...)` depending on the implementation pattern in auth.js).

1. **Default HTTP request → Max-Age=2592000, no Secure flag**: simulate `req.protocol === 'http'`, no `x-forwarded-proto`. Assert the Set-Cookie header has `Max-Age=2592000` AND does NOT contain `Secure`.
2. **HTTPS direct → Max-Age=2592000, Secure set**: simulate `req.protocol === 'https'`. Assert both `Max-Age=2592000` and `Secure` are present.
3. **Reverse-proxy HTTPS → Max-Age=2592000, Secure set**: simulate `req.protocol === 'http'` AND `x-forwarded-proto: https` (Brad's nginx setup pattern). Assert `Secure` is set.
4. **HttpOnly + SameSite=Lax retained**: assert both attributes still present in every above case.
5. **Cookie name unchanged**: the existing tests / docs reference `termdeck_token` — assert that name is still used.

## Protocol

- Before writing auth.js, post `[T2] CLAIM packages/server/src/auth.js` to STATUS.md
- When done, post `[T2] DONE — auth cookie 30-day persistence, tests <pass>/<total>`
- Do NOT bump versions, do NOT update CHANGELOG.md, do NOT commit. T4 handles those.

## Reference memories
- `memory_recall("auth cookie termdeck_token")` — Sprint 9 design notes
- `memory_recall("Brad cookie token re-entry")` — the 2026-04-26 report
