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

// Resolve the parent directory containing the bundled Rumen Edge Function
// source. Sprint 43 T3: bundled-FIRST (matches listMnestraMigrations and
// listRumenMigrations since v0.6.8). The npm `@jhizzard/rumen` package's
// `files` array is `["dist", "migrations", "README.md", "LICENSE",
// "CHANGELOG.md"]` — it does NOT ship `supabase/functions/`. So the npm
// fallback only ever matters for someone who has installed `@jhizzard/rumen`
// from a local checkout (not the published tarball). Bundled-first prevents
// a stale local rumen install from shadowing the source TermDeck developed
// and tested against.
//
// Returns the directory whose immediate children are the function-name
// subdirectories (e.g., `rumen-tick/`, `graph-inference/`).
function rumenFunctionsRoot() {
  const bundledRoot = path.join(SETUP_DIR, 'rumen', 'functions');
  if (fs.existsSync(bundledRoot) && fs.readdirSync(bundledRoot).length > 0) {
    return bundledRoot;
  }
  try {
    const pkgJsonPath = require.resolve('@jhizzard/rumen/package.json', {
      paths: [process.cwd(), SETUP_DIR]
    });
    const candidate = path.join(path.dirname(pkgJsonPath), 'supabase', 'functions');
    if (fs.existsSync(candidate)) return candidate;
  } catch (_err) { /* fallthrough */ }
  return bundledRoot;
}

// Enumerate the function-name subdirectories under the resolved Rumen
// functions root. Each entry must contain at least an `index.ts`. Sprint 43
// T3 bundled both `rumen-tick` and `graph-inference`.
function listRumenFunctions() {
  const root = rumenFunctionsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => {
      const dir = path.join(root, name);
      return fs.statSync(dir).isDirectory()
        && fs.existsSync(path.join(dir, 'index.ts'));
    })
    .sort();
}

// Back-compat: pre-Sprint-43 callers expected a single path resolving to the
// `rumen-tick/` directory specifically. Delegates to rumenFunctionsRoot()
// + 'rumen-tick'. Prefer rumenFunctionsRoot() / listRumenFunctions() for new
// code that needs to operate over multiple functions.
function rumenFunctionDir() {
  return path.join(rumenFunctionsRoot(), 'rumen-tick');
}

function readFile(filepath) {
  return fs.readFileSync(filepath, 'utf-8');
}

module.exports = {
  listMnestraMigrations,
  listRumenMigrations,
  rumenFunctionsRoot,
  listRumenFunctions,
  rumenFunctionDir,
  readFile
};
