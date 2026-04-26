// Discover the SQL migration files that ship bundled inside the TermDeck
// package. Both init wizards call this — init-mnestra for the seven Mnestra
// migrations, init-rumen for the two Rumen migrations.
//
// The wizards intentionally do NOT fall back to a sibling `../../mnestra`
// working copy. Resolution order (BUNDLED FIRST as of v0.6.8):
//
//   1. Files bundled at `packages/server/src/setup/mnestra-migrations/*.sql`
//      (this directory is covered by the root package.json `files` glob).
//      ALWAYS preferred when it has any .sql files.
//   2. Files at `node_modules/@jhizzard/mnestra/migrations/*.sql` if that
//      package is installed alongside TermDeck. Used ONLY as a fallback when
//      the bundled directory is missing (e.g. someone deleted it manually).
//
// Why bundled-first: the meta-installer (`@jhizzard/termdeck-stack`) installs
// `@jhizzard/mnestra` globally as a peer. When TermDeck releases a new
// migration ahead of a Mnestra release, or when a user upgrades TermDeck
// without also upgrading the global Mnestra package, the previous loader
// silently picked the older Mnestra migration set. This bit Brad on
// 2026-04-26 with v0.6.5: he upgraded TermDeck, ran `init --mnestra --yes`,
// the wizard reported "6 migrations applied cleanly" (because his global
// mnestra@0.2.1 had only 6), and the bundled 007 — the one we shipped to
// fix his Rumen schema-drift issue — was never seen. Bundled is the source
// of truth TermDeck developed and tested against. Fall-back to node_modules
// is preserved as a safety valve, not a preference.

const fs = require('fs');
const path = require('path');

const SETUP_DIR = __dirname;

function listBundled(subdir) {
  const dir = path.join(SETUP_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

function tryNodeModules(packageName, migrationSubdir = 'migrations') {
  try {
    // Resolve the package's main file, then look for a migrations sibling dir.
    const pkgJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [process.cwd(), SETUP_DIR]
    });
    const pkgDir = path.dirname(pkgJsonPath);
    const migrationDir = path.join(pkgDir, migrationSubdir);
    if (!fs.existsSync(migrationDir)) return [];
    return fs.readdirSync(migrationDir)
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort()
      .map((f) => path.join(migrationDir, f));
  } catch (_err) {
    return [];
  }
}

function listMnestraMigrations() {
  // Bundled FIRST (v0.6.8+). See the file header for why — this prevents
  // a stale `@jhizzard/mnestra` install in global node_modules from
  // silently shadowing migrations TermDeck ships with the latest version.
  const bundled = listBundled('mnestra-migrations');
  if (bundled.length > 0) return bundled;
  return tryNodeModules('@jhizzard/mnestra');
}

function listRumenMigrations() {
  // Bundled FIRST (v0.6.8+). Same rationale as listMnestraMigrations —
  // a stale global `@jhizzard/rumen` cannot shadow newer bundled migrations.
  const bundled = listBundled(path.join('rumen', 'migrations'));
  if (bundled.length > 0) return bundled;
  return tryNodeModules('@jhizzard/rumen');
}

function rumenFunctionDir() {
  // Same resolution order.
  try {
    const pkgJsonPath = require.resolve('@jhizzard/rumen/package.json', {
      paths: [process.cwd(), SETUP_DIR]
    });
    const candidate = path.join(path.dirname(pkgJsonPath), 'supabase', 'functions', 'rumen-tick');
    if (fs.existsSync(candidate)) return candidate;
  } catch (_err) { /* fallthrough */ }
  return path.join(SETUP_DIR, 'rumen', 'functions', 'rumen-tick');
}

function readFile(filepath) {
  return fs.readFileSync(filepath, 'utf-8');
}

module.exports = {
  listMnestraMigrations,
  listRumenMigrations,
  rumenFunctionDir,
  readFile
};
