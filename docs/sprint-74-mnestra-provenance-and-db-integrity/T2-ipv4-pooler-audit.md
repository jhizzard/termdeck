# T2 — IPv4-pooler DB-endpoint audit (Brad R730 gap-map item 2)

**Work repo:** `~/Documents/Graciella/engram` (plus read-only greps of the termdeck repo's
bridge/webhook client code). STATUS.md lives in the termdeck repo (see PLANNING).

## Mission

Brad (field deployment, Dell R730, IPv4-only network) hit PoolTimeout because the direct
Supabase endpoint `db.<project-ref>.supabase.co` is IPv6-only; the fix on his box was the
IPv4 shared pooler (`aws-1-<region>.pooler.supabase.com`, user `postgres.<project-ref>`).
His explicit warning: **the v1.8.x bridge/webhook will PoolTimeout on ANY IPv4-only host if
our code or docs make the same direct-endpoint assumption.** Audit everything; fix what's unsafe.

Note the prior art: TermDeck `docs/GETTING-STARTED.md` Tier 3 gotcha #1 already warns about
the IPv6-only Dedicated Pooler default in the Supabase Connect modal — your job is the
code-and-docs sweep on the mnestra side of the stack.

## Scope

1. **Inventory (post as FINDING):** every site that constructs, defaults, validates, or
   documents a Postgres connection string or Supabase DB host, across: the mnestra CLI +
   webhook (`mnestra serve`), migration runner, doctor/audit probes, wizard prompts
   (`termdeck init --mnestra` reads/validates DATABASE_URL — read-only grep of
   `packages/cli/src/init-mnestra.js` in the termdeck repo), `.env.example` files, READMEs,
   GETTING-STARTED Tier 2. Grep starters: `db\.`, `supabase\.co`, `DATABASE_URL`, `pooler`,
   `5432`, `6543`.
2. **Verdict per site:** pooler-safe (works as-is on IPv4-only) / IPv4-unsafe (assumes or
   constructs the direct endpoint) / not-applicable. Evidence = file:line + the string shape
   it produces.
3. **Fix unsafe sites:** prefer accept-any-valid-URL + validate-and-warn over auto-rewrite.
   If any code *constructs* a `db.<ref>.supabase.co` hostname, make the pooler form the
   documented default and add an explicit IPv4-only-host warning. Keep `<project-ref>`
   placeholders — never a real ref.
4. **Connectivity preflight (small, if it fits):** a doctor-style check that detects
   "direct endpoint + no IPv6 route" and names the pooler fix in its message.
5. **Doc note:** a short "IPv4-only hosts" subsection wherever the connection string is
   first asked for.

## NOT in scope

- Brad's machine (he has his own fleet). Schema changes. Bridge OAuth/tunnel code.
- Touching the daily-driver project's actual connection config.

## Acceptance

1. Exhaustive inventory with per-site verdicts (the auditor will re-run your greps).
2. Unsafe sites fixed + tested (URL-shape unit tests, no live DB needed).
3. Doc note landed. DONE post includes the one-paragraph summary ORCH forwards to Brad.

## Lane discipline

Post shape: `### [T2] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` (FINDING / FIX-PROPOSED /
FIX-LANDED / BLOCKED / DONE), `### ` prefix mandatory, in the termdeck-repo STATUS.md
(absolute path in PLANNING.md). Stay in lane. No commits.
