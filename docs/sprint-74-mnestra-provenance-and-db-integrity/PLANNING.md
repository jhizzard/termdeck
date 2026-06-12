# Sprint 74 — Mnestra Provenance + Field-Deployment DB Integrity (Deck B of the 73/74 double sprint)

**Staged:** 2026-06-10 ~15:45 ET by ORCH (session 4b85a761).
**Repo:** engram/mnestra — `~/Documents/Graciella/engram` (panels for this deck MUST be
opened with that cwd). Sprint docs live here in the termdeck repo; briefs use absolute paths.
**Companion deck:** Sprint 73 (termdeck repo) — `docs/sprint-73-provenance-and-installer/`.
**Pattern:** 3+1+1 (T1–T3 Claude workers, T4 Grok auditor).

## Objective

(1) Add `grok-web` to mnestra's source-agent taxonomy — the ATOMIC partner of Sprint 73 T1's
provenance flip. (2) Close Brad's two "audit our code" items from the 2026-06-09 R730 gap
map, which gate his bridge bring-up: the IPv4-only-host DB endpoint assumption and
flush-before-recall read-after-write staleness on the webhook path.

## Lanes

| Lane | Scope | Brief |
|---|---|---|
| T1 | `grok-web` in source_agents enum + recall filters (migration 024) | `T1-grok-web-enum.md` |
| T2 | IPv4-pooler endpoint audit (webhook + docs + anything resolving the direct DB host) | `T2-ipv4-pooler-audit.md` |
| T3 | Flush-before-recall staleness audit on the webhook recall path | `T3-flush-before-recall.md` |
| T4 | Grok adversarial auditor across T1–T3 | `T4-grok-auditor.md` |

## Cross-deck atomicity (READ THIS, T1 + T4)

Sprint 74 T1 and Sprint 73 T1 must land in the same release window — a hooks build that
emits `grok-web` against a store/recall layer that rejects or can't filter it is silent
breakage. ORCH sequences the release; T1's DONE post states exactly what Sprint 73 T1
needs from this side.

## Hard constraints

- **Supabase hygiene gates apply to migration 024** (global CLAUDE.md § RLS hygiene): any
  new/replaced function gets `REVOKE EXECUTE ... FROM PUBLIC` + `SET search_path = public,
  pg_catalog`; no `WITH CHECK (true)` on PUBLIC; RLS stays enabled.
- Migrations are written + tested locally; **nobody applies anything to the daily-driver
  project from a lane** — ORCH applies at close.
- The internal Supabase project name/ref NEVER appears in any artifact (use `<project-ref>`).
- No version bumps, no CHANGELOG, no commits, no publishes inside lanes.

## Acceptance (ORCH judges at close)

1. T1: migration 024 + MCP tool-schema + writer-path changes; recall filter round-trips `grok-web`.
2. T2: exhaustive inventory (file:line) of every DB-endpoint resolution; verdict per site
   (pooler-safe / IPv4-unsafe / N-A); fixes for unsafe sites; doc note for R730-class hosts.
3. T3: a definitive answer to Brad's question — is there read-after-write staleness between
   auto-captured memory and a subsequent bridge recall? — with a traced code path, a test
   proving the answer, and (if stale) a FIX-PROPOSED design.
4. T4: AUDIT verdicts per lane with file:line evidence + FINAL-VERDICT.

## Lane discipline (all lanes)

- Post shape, ALL posts: `### [T<n>] STATUS-VERB 2026-MM-DD HH:MM ET — <gist>` in
  `docs/sprint-74-mnestra-provenance-and-db-integrity/STATUS.md` **in the termdeck repo**
  (absolute path:
  `/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-74-mnestra-provenance-and-db-integrity/STATUS.md`).
- Idle-polls use the tolerant regex `^(### )?\[T<n>\] DONE\b`.
- Auditor posts `### [T4-GROK] CHECKPOINT ...` every phase boundary / 15 min.
