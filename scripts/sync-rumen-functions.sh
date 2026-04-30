#!/usr/bin/env bash
#
# scripts/sync-rumen-functions.sh — Sprint 43 T3
#
# Copy the canonical Rumen Supabase Edge Function source from the sibling
# rumen repo into TermDeck's bundled `packages/server/src/setup/rumen/functions/`
# directory. Run this BEFORE `npm publish` whenever the rumen-tick or
# graph-inference Edge Function source has changed (see docs/RELEASE.md).
#
# The bundled copy is what `init --rumen` actually deploys — TermDeck does
# NOT depend on `@jhizzard/rumen` shipping `supabase/functions/`, because that
# npm package's `files` array intentionally excludes the Edge Function source
# (the npm tarball is the runtime artifact `runRumenJob` is published from).
# Bundling-into-TermDeck is the source of truth for what `init --rumen`
# deploys.
#
# Behavior:
#   - rumen-tick/index.ts: rewrites the `npm:@jhizzard/rumen@<concrete-version>`
#     import line back to `npm:@jhizzard/rumen@__RUMEN_VERSION__` so the
#     bundled copy keeps the placeholder. `init-rumen.js::stageRumenFunctions`
#     substitutes the placeholder with the live `npm view @jhizzard/rumen
#     version` answer at deploy time.
#   - graph-inference/index.ts: copied verbatim (its `npm:postgres@3.4.4`
#     import is pinned at the function level, no placeholder).
#   - tsconfig.json files: copied verbatim.
#
# Usage:
#   bash scripts/sync-rumen-functions.sh
#   # or
#   npm run sync-rumen-functions

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUMEN_REPO="${RUMEN_REPO:-$HOME/Documents/Graciella/rumen}"
SRC_DIR="$RUMEN_REPO/supabase/functions"
DEST_DIR="$REPO_ROOT/packages/server/src/setup/rumen/functions"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: Rumen source dir not found: $SRC_DIR" >&2
  echo "       Set RUMEN_REPO=/path/to/rumen if your checkout is elsewhere." >&2
  exit 1
fi

echo "→ Syncing Rumen Edge Functions"
echo "  src:  $SRC_DIR"
echo "  dest: $DEST_DIR"

mkdir -p "$DEST_DIR"

# Iterate over every function subdirectory in the source. This auto-discovers
# new functions (e.g., a future `memory-doctor` or similar) without needing
# to edit this script.
for fn_path in "$SRC_DIR"/*/; do
  fn_name="$(basename "$fn_path")"
  echo "  • $fn_name"

  fn_dest="$DEST_DIR/$fn_name"
  mkdir -p "$fn_dest"

  # Copy every file in the function dir.
  for file_path in "$fn_path"*; do
    [[ -e "$file_path" ]] || continue
    file_name="$(basename "$file_path")"
    cp "$file_path" "$fn_dest/$file_name"
  done

  # rumen-tick: restore the `__RUMEN_VERSION__` placeholder + the TermDeck-
  # specific comment block that documents it. The sibling rumen repo carries
  # a concrete version + no comment in its checked-in source so the function
  # works when deployed via `cd ~/Documents/Graciella/rumen && supabase
  # functions deploy rumen-tick`. TermDeck's bundled copy needs both the
  # placeholder (for runtime substitution by `init-rumen.js`) and the comment
  # (so a future maintainer reading the file in this repo understands why).
  if [[ "$fn_name" == "rumen-tick" ]]; then
    index_ts="$fn_dest/index.ts"
    if [[ ! -f "$index_ts" ]]; then
      echo "    WARN: $index_ts missing after copy; skipping placeholder rewrite" >&2
      continue
    fi
    # Use a Node one-liner instead of sed — easier to keep idempotent and
    # handle both rewrites (concrete-version → placeholder, missing-comment →
    # injected-comment) atomically.
    node -e "$(cat <<'NODE'
const fs = require('fs');
const p = process.argv[1];
let src = fs.readFileSync(p, 'utf-8');

// 1. Concrete-version → placeholder.
src = src.replace(
  /npm:@jhizzard\/rumen@(?:[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*|__RUMEN_VERSION__)/g,
  'npm:@jhizzard/rumen@__RUMEN_VERSION__'
);

// 2. Inject the TermDeck-only placeholder explainer comment if missing.
// Match the import line and ensure the standard comment block precedes it.
const placeholderImport = "import { runRumenJob, createPoolFromUrl } from 'npm:@jhizzard/rumen@__RUMEN_VERSION__';";
const comment = [
  '// NOTE: `__RUMEN_VERSION__` is a placeholder. `termdeck init --rumen` reads the',
  '// current published version from the npm registry at deploy time and rewrites',
  '// this line in a staged copy of the file before running `supabase functions',
  '// deploy`. This source file on disk MUST keep the placeholder — do not commit',
  '// a real version number here. See packages/cli/src/init-rumen.js.',
].join('\n');

if (!src.includes('__RUMEN_VERSION__ is a placeholder')) {
  // Insert the comment block immediately before the placeholder import line.
  src = src.replace(placeholderImport, comment + '\n' + placeholderImport);
}

fs.writeFileSync(p, src);

if (!src.includes('__RUMEN_VERSION__')) {
  console.error('ERROR: __RUMEN_VERSION__ placeholder missing after rewrite');
  process.exit(2);
}
NODE
)" "$index_ts"
    echo "    ✓ placeholder + comment restored in $fn_name/index.ts"
  fi
done

echo "✓ Rumen Edge Functions synced. Verify with:"
echo "    git status packages/server/src/setup/rumen/functions/"
