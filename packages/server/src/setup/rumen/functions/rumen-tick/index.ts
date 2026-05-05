// Rumen v0.1 Supabase Edge Function entry point.
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not
// compile under the root tsconfig.json — it is intentionally excluded.
// A sibling tsconfig.json in this directory keeps the types sane for
// editors, but the canonical build target is Deno's own type checker
// (`deno check`) and Supabase's `supabase functions deploy`.
//
// Dependencies are pulled via `npm:` specifiers, which Supabase Edge
// Functions support natively.
//
// Deployment:
//   supabase functions deploy rumen-tick
//   supabase secrets set DATABASE_URL="$DATABASE_URL"
//
// Triggered on a schedule by pg_cron — see migrations/002_pg_cron_schedule.sql.
//
// This function runs one Rumen job per invocation and returns a JSON summary.

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime.
// NOTE: `__RUMEN_VERSION__` is a placeholder. `termdeck init --rumen` reads the
// current published version from the npm registry at deploy time and rewrites
// this line in a staged copy of the file before running `supabase functions
// deploy`. This source file on disk MUST keep the placeholder — do not commit
// a real version number here. See packages/cli/src/init-rumen.js.
import { runRumenJob, createPoolFromUrl } from 'npm:@jhizzard/rumen@__RUMEN_VERSION__';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Supabase Edge Runtime auto-injects SUPABASE_DB_URL as a built-in env var.
  // Falling back to it removes one whole category of "where do I get the DB
  // connection string" from the install wizard. Brad surfaced this 2026-05-03
  // after hand-patching all four of his deployed copies.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'DATABASE_URL not set',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const pool = createPoolFromUrl(url);

  // Sprint 56 (T3 Cell #1 backlog catch-up) — env-var overrides for one-off
  // historic processing. Set via `supabase secrets set`:
  //   RUMEN_LOOKBACK_HOURS_OVERRIDE=2880   (120 days; bypasses default 72h)
  //   RUMEN_MAX_SESSIONS_OVERRIDE=300      (processes whole 289-session
  //                                         backlog in one tick rather than
  //                                         28 ticks at default 10 each)
  // After the catch-up settles, unset both with
  //   `supabase secrets unset RUMEN_LOOKBACK_HOURS_OVERRIDE
  //                           RUMEN_MAX_SESSIONS_OVERRIDE`
  // and the function reverts to the rumen-package defaults (72h / 10 sessions).
  // Both gates fail closed: invalid integer string → ignored, default used.
  const lookbackOverrideRaw = Deno.env.get('RUMEN_LOOKBACK_HOURS_OVERRIDE');
  const maxSessionsOverrideRaw = Deno.env.get('RUMEN_MAX_SESSIONS_OVERRIDE');
  const lookbackOverride = lookbackOverrideRaw && /^\d+$/.test(lookbackOverrideRaw)
    ? parseInt(lookbackOverrideRaw, 10)
    : undefined;
  const maxSessionsOverride = maxSessionsOverrideRaw && /^\d+$/.test(maxSessionsOverrideRaw)
    ? parseInt(maxSessionsOverrideRaw, 10)
    : undefined;
  if (lookbackOverride !== undefined || maxSessionsOverride !== undefined) {
    console.log(
      '[rumen] override active: lookbackHours=' +
        (lookbackOverride ?? 'default') +
        ' maxSessions=' +
        (maxSessionsOverride ?? 'default'),
    );
  }

  try {
    console.log('[rumen] edge function tick starting');
    const summary = await runRumenJob(pool, {
      triggeredBy: 'schedule',
      ...(lookbackOverride !== undefined ? { lookbackHours: lookbackOverride } : {}),
      ...(maxSessionsOverride !== undefined ? { maxSessions: maxSessionsOverride } : {}),
    });
    console.log(
      '[rumen] edge function tick complete job_id=' +
        summary.job_id +
        ' status=' +
        summary.status,
    );

    return new Response(
      JSON.stringify({
        ok: summary.status === 'done',
        summary,
      }),
      {
        status: summary.status === 'done' ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen] edge function tick threw:', err);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } finally {
    try {
      await pool.end();
    } catch (err) {
      console.error('[rumen] pool.end() failed:', err);
    }
  }
});
