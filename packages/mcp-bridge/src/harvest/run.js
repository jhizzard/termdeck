'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sheets intake runner (Sprint 84 / T1).
//
// CADENCE: a LOCAL timer, not pg_cron. This is not a style preference — the
// dependency runs the wrong way for cron. The forward path terminates at
// http://localhost:37778 (the Mnestra webhook, on the operator's machine), and
// both the service-account key and the dedup ledger are local files. A
// Supabase pg_cron job can reach none of the three. PLANNING contract 2 (T3
// owns all pg_cron additions) is therefore satisfied vacuously for this lane:
// T1 requests no cron slot.
//
// Default interval 5 min, `TERMDECK_SHEETS_POLL_INTERVAL_MS`. Opt-in behind
// `TERMDECK_SHEETS_INTAKE_ENABLED=1` (default OFF) so an unconfigured install
// never reaches for credentials it does not have.
//
//   node src/harvest/run.js --once     one pass, exit (use this to smoke it)
//   node src/harvest/run.js            poll forever
// ─────────────────────────────────────────────────────────────────────────────

const { createAccessTokenProvider } = require('./google-auth');
const { createSheetsApi } = require('./sheets-api');
const { createLedger } = require('./ledger');
const { harvestOnce, loadHarvestConfig } = require('./sheets');
const { createMnestraClient } = require('../clients/mnestra');

// createHarvester({ env?, fetchImpl?, logger?, sheets?, mnestra?, ledger? })
// Every collaborator is injectable so the whole thing is unit-testable with no
// network and no credentials — the seams the tests drive.
function createHarvester(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || ((msg) => console.log(msg));
  const config = opts.config || loadHarvestConfig(env);

  const sheets = opts.sheets || createSheetsApi({
    getToken: createAccessTokenProvider({ env, fetchImpl: opts.fetchImpl }).getToken,
    fetchImpl: opts.fetchImpl,
  });
  const mnestra = opts.mnestra || createMnestraClient({ env, fetchImpl: opts.fetchImpl });
  const ledger = opts.ledger || createLedger({ env });

  return {
    config,
    ledgerFile: ledger.file,
    run: () => harvestOnce({ sheets, mnestra, ledger, env, config, logger, now: opts.now }),
  };
}

function summarize(r) {
  const bits = [
    `scanned=${r.scanned}`, `proposed=${r.proposed}`, `already=${r.alreadyForwarded}`,
    `quarantined=${r.quarantined}`, `refused=${r.refused}`, `uncertain=${r.uncertain}`,
    `restamped=${r.restamped}`, `deferred=${r.deferred}`,
  ];
  if (r.writeBackFailed) bits.push('write-back=FAILED');
  return `sheets-harvest: ${bits.join(' ')}`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const once = argv.includes('--once');
  const cfg = loadHarvestConfig(env);

  if (!cfg.enabled && !argv.includes('--force')) {
    console.log('sheets-harvest: disabled (set TERMDECK_SHEETS_INTAKE_ENABLED=1 to run; --force overrides for a one-shot).');
    return 0;
  }

  const harvester = createHarvester({ env });
  console.log(
    `sheets-harvest: tab '${cfg.tab}' rows from ${cfg.headerRows + 1}, `
    + `default source_agent ${cfg.defaultSourceAgent}, ledger ${harvester.ledgerFile}`,
  );

  let stopping = false;
  const onSignal = () => { stopping = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (;;) {
    try {
      const report = await harvester.run();
      console.log(summarize(report));
      for (const p of report.problems) console.log(`  row ${p.row}: ${p.kind} — ${p.reason}`);
    } catch (err) {
      // A failed pass must never kill the loop: a transient Sheets 5xx or an
      // expired token is retried on the next tick.
      console.error(`sheets-harvest: pass failed — ${err && err.message ? err.message : String(err)}`);
      if (once) return 1;
    }
    if (once || stopping) return 0;
    await new Promise((res) => {
      const t = setTimeout(res, cfg.pollIntervalMs);
      if (typeof t.unref === 'function') t.unref();
    });
    if (stopping) return 0;
  }
}

module.exports = { createHarvester, main, summarize };

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((err) => {
    console.error(`sheets-harvest: fatal — ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
}
