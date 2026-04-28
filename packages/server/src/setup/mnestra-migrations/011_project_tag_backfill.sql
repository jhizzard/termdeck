-- Sprint 39 T3 — chopin-nashville project-tag backfill.
--
-- Why this exists:
--   memory_items rows tagged project='chopin-nashville' are ~96% polluted
--   with content from other projects (termdeck, mnestra, rumen, podium, pvb,
--   dor). Root cause is the harness session-end hook
--   (~/.claude/hooks/memory-session-end.js, OUT OF THIS REPO): its
--   PROJECT_MAP iteration tests /ChopinNashville/i first and there are no
--   entries for termdeck/mnestra/rumen/podium/dor — so any session whose
--   cwd lives under ~/Documents/Graciella/ChopinNashville/... falls into
--   chopin-nashville, including the entire TermDeck checkout (which lives at
--   ChopinNashville/SideHustles/TermDeck/termdeck) and Podium (which lives at
--   ChopinNashville/2026/ChopinInBohemia/podium).
--
--   This migration heals the historical rows. The forward-fix to the harness
--   hook is Joshua's responsibility (out-of-repo file) and is NOT covered
--   here — without it, new mis-tagged rows will continue to be written until
--   he extends PROJECT_MAP with the missing project entries.
--
-- What this migration does NOT do:
--   - Does NOT touch mnestra_session_memory / mnestra_project_memory / etc.
--     (legacy rag-events tables; different write path; separate cleanup).
--   - Does NOT consolidate duplicate project tags like 'gorgias' vs
--     'gorgias-ticket-monitor', 'pvb' vs 'PVB', or 'mnestra' vs 'engram'.
--     Those are visible in `SELECT project, count(*) FROM memory_items GROUP
--     BY project` but they're a separate cleanup pass.
--   - Does NOT touch the ~898 "other/uncertain" chopin-nashville rows that
--     don't carry an unambiguous project keyword. A future sprint can run an
--     LLM-classification pass; for this migration, conservative wins.
--
-- Heuristic — content keyword bucketing:
--   The migration runs UPDATEs sequentially. Earlier buckets claim ambiguous
--   multi-project rows first; later buckets only see rows that no earlier
--   bucket has already re-tagged. Order is by bucket size (largest first):
--
--     1. termdeck / mnestra      — keywords: termdeck, mnestra, "4+1 sprint"
--     2. rumen                   — keyword:  rumen
--     3. podium                  — keyword:  podium
--     4. pvb                     — keywords: PVB, petvetbid, pet vet bid
--     5. dor / openclaw          — TIGHTENED:
--                                    word-boundary uppercase DOR  (rules out
--                                    "dormant", "vendored", "indoor", etc.),
--                                    plus path/identifier markers and
--                                    openclaw substring.
--
-- Spot-check baseline (T3 audit, 2026-04-27):
--   termdeck/mnestra: 130 rows, all 6 sampled were true positives (TermDeck
--                     server code, Mnestra wizard, sprint orchestration).
--   rumen:            92 rows, all 6 sampled were true positives.
--   podium:           58 rows, all 6 sampled were true positives.
--   pvb:               7 rows, 1 of those overlaps with mnestra ("Mnestra
--                     repo … petvetbid project") and gets claimed by bucket 1.
--   dor (tightened):   3 rows after tightening from 6 — the original
--                     `%dor%` ILIKE pattern caught false positives like
--                     "dormant", "vendored". Final 3 rows are all true
--                     DOR/OpenClaw mentions.
--   chopin-nashville total: 1,169 rows. Legitimate-signal baseline (rows
--                     matching Acceptd / NICPC / Bohemia / laureate /
--                     applicant / competition / repertoire keywords): 71.
--
-- Idempotence:
--   Every UPDATE is gated by `WHERE project = 'chopin-nashville'`. After the
--   first run, those rows have a different project tag, so re-running this
--   migration is a no-op (zero rows updated per bucket). RAISE NOTICE on a
--   re-run will print zeros, which is the expected idempotent signal.
--
-- Application:
--   THIS MIGRATION IS NOT EXECUTED BY THE LANE THAT WROTE IT. Orchestrator
--   reviews the RAISE NOTICE counts after applying. Apply via the bundled
--   migration runner at packages/server/src/setup/migration-runner.js (which
--   uses node-postgres client.query — psql metacommands like \gset are NOT
--   available, so the count probes use GET DIAGNOSTICS ROW_COUNT inside DO
--   blocks). Manual fallback: `psql "$DATABASE_URL" -f 011_project_tag_backfill.sql`.

BEGIN;

-- ============================================================
-- AUDIT BEFORE
-- ============================================================
DO $$
DECLARE
  before_chopin    int;
  before_termdeck  int;
  before_rumen     int;
  before_podium    int;
  before_pvb       int;
  before_dor       int;
BEGIN
  SELECT count(*) INTO before_chopin   FROM memory_items WHERE project = 'chopin-nashville';
  SELECT count(*) INTO before_termdeck FROM memory_items WHERE project = 'termdeck';
  SELECT count(*) INTO before_rumen    FROM memory_items WHERE project = 'rumen';
  SELECT count(*) INTO before_podium   FROM memory_items WHERE project = 'podium';
  SELECT count(*) INTO before_pvb      FROM memory_items WHERE project = 'pvb';
  SELECT count(*) INTO before_dor      FROM memory_items WHERE project = 'dor';
  RAISE NOTICE '[011-backfill] BEFORE  chopin-nashville=% termdeck=% rumen=% podium=% pvb=% dor=%',
    before_chopin, before_termdeck, before_rumen, before_podium, before_pvb, before_dor;
END $$;

-- ============================================================
-- BUCKET 1 — TermDeck / Mnestra (claims multi-project mentions first)
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'termdeck'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%termdeck%'
       OR content ILIKE '%mnestra%'
       OR content ILIKE '%4+1 sprint%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[011-backfill] bucket 1 (termdeck/mnestra): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 2 — Rumen
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'rumen'
   WHERE project = 'chopin-nashville'
     AND content ILIKE '%rumen%';
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[011-backfill] bucket 2 (rumen): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 3 — Podium
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'podium'
   WHERE project = 'chopin-nashville'
     AND content ILIKE '%podium%';
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[011-backfill] bucket 3 (podium): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 4 — PVB (case-insensitive PVB / petvetbid markers)
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'pvb'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%PVB%'
       OR content ILIKE '%petvetbid%'
       OR content ILIKE '%pet vet bid%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[011-backfill] bucket 4 (pvb): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 5 — DOR / OpenClaw (TIGHTENED — word boundary + identifiers)
--
-- Original briefing heuristic was `content ILIKE '%dor%'`, which produced a
-- ~33% false-positive rate (matched "dormant", "vendored", "indoor", etc.).
-- T3 audit tightened to:
--   • POSIX word boundary `\mDOR\M` — case-sensitive uppercase only, so
--     "dormant" / "DormHall" / "vendor" / "indoor" no longer match.
--   • path/identifier markers: /DOR/, ~/Documents/DOR, dor.config,
--     "Rust LLM gateway" (DOR's tagline).
--   • openclaw substring (OpenClaw is the slack-channel automation product
--     that lives next to DOR in Joshua's stack).
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'dor'
   WHERE project = 'chopin-nashville'
     AND (
       content ~ '\mDOR\M'
       OR content ILIKE '%/DOR/%'
       OR content ILIKE '%~/Documents/DOR%'
       OR content ILIKE '%dor.config%'
       OR content ILIKE '%Rust LLM gateway%'
       OR content ILIKE '%openclaw%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[011-backfill] bucket 5 (dor): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- AUDIT AFTER
-- ============================================================
DO $$
DECLARE
  after_chopin    int;
  after_termdeck  int;
  after_rumen     int;
  after_podium    int;
  after_pvb       int;
  after_dor       int;
BEGIN
  SELECT count(*) INTO after_chopin   FROM memory_items WHERE project = 'chopin-nashville';
  SELECT count(*) INTO after_termdeck FROM memory_items WHERE project = 'termdeck';
  SELECT count(*) INTO after_rumen    FROM memory_items WHERE project = 'rumen';
  SELECT count(*) INTO after_podium   FROM memory_items WHERE project = 'podium';
  SELECT count(*) INTO after_pvb      FROM memory_items WHERE project = 'pvb';
  SELECT count(*) INTO after_dor      FROM memory_items WHERE project = 'dor';
  RAISE NOTICE '[011-backfill] AFTER   chopin-nashville=% termdeck=% rumen=% podium=% pvb=% dor=%',
    after_chopin, after_termdeck, after_rumen, after_podium, after_pvb, after_dor;
  RAISE NOTICE '[011-backfill] If apply succeeds and chopin-nashville count is around the legitimate baseline (~71 rows match competition/laureate/applicant/Acceptd/NICPC/Bohemia/repertoire keywords as of T3 audit), the migration succeeded. The ~898 rows that remain under chopin-nashville without a clear keyword signal are deliberate — a future LLM-classification pass can address them if needed.';
END $$;

COMMIT;

-- ============================================================
-- POST-APPLY: optional verification queries (NOT part of the migration).
-- Run separately to confirm Flashback against project='termdeck' now hits
-- the re-tagged rows.
-- ============================================================
--
-- 1. Tag distribution after migration:
--    SELECT project, count(*) FROM memory_items GROUP BY project ORDER BY count(*) DESC LIMIT 20;
--
-- 2. Confirm no chopin-nashville rows match obvious termdeck/rumen keywords:
--    SELECT count(*) FROM memory_items
--     WHERE project='chopin-nashville'
--       AND (content ILIKE '%termdeck%' OR content ILIKE '%rumen%' OR content ILIKE '%podium%');
--    -- Expected: 0
--
-- 3. Confirm Flashback project-bound test corpus (>= 5 termdeck-tagged rows
--    matching the canonical probe question):
--    SELECT count(*) FROM memory_items
--     WHERE project='termdeck' AND content ILIKE '%shell error%';
