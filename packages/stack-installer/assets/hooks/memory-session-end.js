/**
 * TermDeck session-end memory hook.
 *
 * Vendored from Joshua's ~/.claude/hooks/memory-session-end.js (2026-03-11).
 * Installed by `@jhizzard/termdeck-stack` into ~/.claude/hooks/ and wired
 * into ~/.claude/settings.json under hooks.Stop. Fires on every Claude Code
 * session close.
 *
 * Behavior:
 *   1. Reads {transcript_path, cwd} from stdin (Claude Code's Stop payload).
 *   2. Skips small transcripts (<5KB).
 *   3. Detects project from cwd against PROJECT_MAP (else "global").
 *   4. Spawns the rag-system ingester detached, returns immediately.
 *   5. Logs to ~/.claude/hooks/memory-hook.log.
 *
 * Path resolution (parameterized for portability — was hardcoded in source):
 *   RAG_DIR := process.env.TERMDECK_RAG_DIR
 *           || path.join(os.homedir(), 'Documents/Graciella/rag-system')
 *
 * If the resolved RAG_DIR doesn't exist on disk, the hook logs and exits
 * cleanly. Fresh users who haven't installed rag-system get a no-op hook
 * rather than a spawn error. See assets/hooks/README.md for the full story.
 */

const { spawn } = require('child_process');
const { existsSync, statSync, appendFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

const RAG_DIR = process.env.TERMDECK_RAG_DIR
  || join(os.homedir(), 'Documents', 'Graciella', 'rag-system');
const PROCESS_SCRIPT = join(RAG_DIR, 'src', 'scripts', 'process-session.ts');
const LOG_FILE = join(os.homedir(), '.claude', 'hooks', 'memory-hook.log');

const PROJECT_MAP = [
  { pattern: /\/PVB\//i, project: 'pvb' },
  { pattern: /chopin-scheduler|chopin_scheduler/i, project: 'chopin-scheduler' },
  { pattern: /ChopinNashville|ChopinInBohemia/i, project: 'chopin-nashville' },
  { pattern: /rag-system/i, project: 'rag-system' },
  { pattern: /PianoCameraAI/i, project: 'piano-camera' },
  { pattern: /Practice Piano Network/i, project: 'ppn' },
  { pattern: /StanczakJosh/i, project: 'stanczak' },
  { pattern: /JoshIzPiano/i, project: 'joshizpiano' },
  { pattern: /AutumnArtist/i, project: 'autumn-artist' },
  { pattern: /Crosswords/i, project: 'crosswords' },
  { pattern: /gorgias/i, project: 'gorgias' },
  { pattern: /imessage-reader/i, project: 'imessage-reader' },
  { pattern: /antigravity/i, project: 'antigravity' },
];

function detectProject(cwd) {
  for (const { pattern, project } of PROJECT_MAP) {
    if (pattern.test(cwd)) return project;
  }
  return 'global';
}

function log(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const transcriptPath = data.transcript_path;
    const cwd = data.cwd || '';

    if (!transcriptPath) {
      log('No transcript_path in input, skipping');
      return;
    }

    try {
      const stat = statSync(transcriptPath);
      if (stat.size < 5000) {
        log(`Skipping small transcript (${stat.size} bytes): ${transcriptPath}`);
        return;
      }
    } catch (e) {
      log(`Cannot stat transcript: ${transcriptPath} — ${e.message}`);
      return;
    }

    if (!existsSync(PROCESS_SCRIPT)) {
      log(`RAG_DIR not present (${RAG_DIR}); skipping ingestion. Set TERMDECK_RAG_DIR or install rag-system to enable.`);
      return;
    }

    const project = detectProject(cwd);
    log(`Processing session for project "${project}" from ${transcriptPath}`);

    const child = spawn(
      'npx',
      ['tsx', PROCESS_SCRIPT, transcriptPath, '--project', project],
      {
        cwd: RAG_DIR,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DOTENV_CONFIG_PATH: join(RAG_DIR, '.env') },
      }
    );
    child.unref();

    log(`Spawned process-session (pid ${child.pid}) for project "${project}"`);
  } catch (e) {
    log(`Error: ${e.message}`);
  }
});
