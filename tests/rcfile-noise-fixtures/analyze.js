// Sprint 39 T2 — analyze captured rcfile fixtures against current PATTERNS.
//
// For each *.clean.txt fixture, simulate the production analyzer behavior:
//   - The session's _detectErrors() short-circuits to PATTERNS.shellError if
//     the primary pattern misses, so the trigger condition is
//     `PATTERNS.error.test(clean) || PATTERNS.shellError.test(clean)`
//     (claude-code sessions use errorLineStart instead of error; we check
//     all three separately so the report shows where each matches).
//   - The data is fed into analyzeOutput as a single chunk in the test.
//     In production, output arrives in many small chunks, but the buffer
//     keeps the last 4KB and re-runs the regex on each chunk. The single-
//     chunk simulation is sufficient for a "does any line match" probe.
//
// Output: a table of (fixture, total_lines, error_matches, errorLineStart_matches,
// shellError_matches, would_trigger) plus the offending lines for each match.

const fs = require('fs');
const path = require('path');
const { PATTERNS } = require('../../packages/server/src/session.js');

const fixtures = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.clean.txt'))
  .sort();

let totalFP = 0;
const verdict = [];

for (const f of fixtures) {
  const content = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const errorMatch = PATTERNS.error.test(content);
  const errorLineStartMatch = PATTERNS.errorLineStart.test(content);
  const shellErrorMatch = PATTERNS.shellError.test(content);

  // Find the actual lines that triggered each pattern. Reset lastIndex
  // (regex with /g flag would, but our patterns don't have /g — re-run
  // on each line for clarity).
  const lines = content.split('\n');
  const triggers = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PATTERNS.error.test(line)) triggers.push({ line: i + 1, pattern: 'error', text: line });
    if (PATTERNS.errorLineStart.test(line)) triggers.push({ line: i + 1, pattern: 'errorLineStart', text: line });
    if (PATTERNS.shellError.test(line)) triggers.push({ line: i + 1, pattern: 'shellError', text: line });
  }

  const wouldTrigger = errorMatch || shellErrorMatch; // shell session path
  const wouldTriggerCC = errorLineStartMatch || shellErrorMatch; // claude-code path

  verdict.push({
    fixture: f,
    lines: lines.length,
    errorMatch,
    errorLineStartMatch,
    shellErrorMatch,
    wouldTriggerShell: wouldTrigger,
    wouldTriggerClaudeCode: wouldTriggerCC,
    triggers,
  });

  if (wouldTrigger || wouldTriggerCC) totalFP++;
}

// Pretty report
console.log('# rcfile-noise PATTERNS analysis\n');
console.log(`Tested ${fixtures.length} fixtures. Triggering fixtures: ${totalFP}.\n`);

console.log('| Fixture | Lines | error | errorLineStart | shellError | Shell trigger | claude-code trigger |');
console.log('|---|---:|---|---|---|---|---|');
for (const v of verdict) {
  console.log(`| ${v.fixture} | ${v.lines} | ${v.errorMatch ? 'YES' : '—'} | ${v.errorLineStartMatch ? 'YES' : '—'} | ${v.shellErrorMatch ? 'YES' : '—'} | ${v.wouldTriggerShell ? '🔴 FIRES' : 'silent'} | ${v.wouldTriggerClaudeCode ? '🔴 FIRES' : 'silent'} |`);
}

console.log('\n## Triggering lines\n');
for (const v of verdict) {
  if (v.triggers.length === 0) continue;
  console.log(`### ${v.fixture}`);
  for (const t of v.triggers) {
    console.log(`  L${t.line} via PATTERNS.${t.pattern}: ${JSON.stringify(t.text)}`);
  }
  console.log();
}
