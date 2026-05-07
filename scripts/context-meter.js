#!/usr/bin/env node
// Claude Code context-usage meter — at-a-glance display of % used and tokens
// remaining for the most recently active Claude Code session on this machine.
//
// Usage:
//   node scripts/context-meter.js                # 1M context (Opus 4.7 default)
//   CONTEXT_MAX=200000 node scripts/context-meter.js   # 200K (Sonnet/Haiku)
//   REFRESH_MS=1000 node scripts/context-meter.js      # faster polling
//
// Designed to run in its own small terminal window, positioned in a corner of
// the screen for at-a-glance awareness regardless of where Claude Code's own
// status indicator is. Polls the newest jsonl under ~/.claude/projects/ every
// REFRESH_MS milliseconds and parses the most recent assistant turn's
// usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens}.
//
// Color-codes by zone:
//   green  <50%   plenty of room
//   yellow 50-80% mid-context, plan accordingly
//   red    >80%   compaction imminent / context squeeze

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const REFRESH_MS = parseInt(process.env.REFRESH_MS || '3000', 10);
const MODEL_MAX = parseInt(process.env.CONTEXT_MAX || '1000000', 10);

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  clearAndHome: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

function findNewestJsonl() {
  let newest = null;
  let newestMtime = 0;
  let projectDir = null;
  try {
    for (const projDirName of fs.readdirSync(PROJECTS_DIR)) {
      const projDirPath = path.join(PROJECTS_DIR, projDirName);
      let stat;
      try { stat = fs.statSync(projDirPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let entries;
      try { entries = fs.readdirSync(projDirPath); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(projDirPath, f);
        let fst;
        try { fst = fs.statSync(fp); } catch { continue; }
        if (fst.mtimeMs > newestMtime) {
          newestMtime = fst.mtimeMs;
          newest = fp;
          projectDir = projDirName;
        }
      }
    }
  } catch {
    return null;
  }
  return newest ? { path: newest, projectDir, mtime: newestMtime } : null;
}

function readLastUsage(jsonlPath) {
  let content;
  try { content = fs.readFileSync(jsonlPath, 'utf8'); } catch { return null; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const usage = obj && obj.message && obj.message.usage;
      if (usage) {
        const total =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0);
        return { total, output: usage.output_tokens || 0 };
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function colorFor(pct) {
  if (pct < 50) return ANSI.green;
  if (pct < 80) return ANSI.yellow;
  return ANSI.red;
}

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

function decodeProjectDir(encoded) {
  if (!encoded) return '(unknown)';
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function bar(pct, width) {
  const filled = Math.round(Math.max(0, Math.min(1, pct / 100)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function render() {
  const out = [];
  out.push(ANSI.clearAndHome);

  const session = findNewestJsonl();
  if (!session) {
    out.push(`${ANSI.dim}[ctx-meter] No Claude session jsonl found under ${PROJECTS_DIR}${ANSI.reset}\n`);
    process.stdout.write(out.join(''));
    return;
  }

  const usage = readLastUsage(session.path);
  const decodedProject = decodeProjectDir(session.projectDir);
  const sessionShortId = path.basename(session.path, '.jsonl').slice(0, 8);
  const ageSec = ((Date.now() - session.mtime) / 1000).toFixed(0);

  out.push(`${ANSI.bold}Claude Code Context Meter${ANSI.reset}\n`);
  out.push(`${ANSI.dim}${decodedProject}${ANSI.reset}\n`);
  out.push(`${ANSI.dim}session ${sessionShortId} · last activity ${ageSec}s ago${ANSI.reset}\n`);
  out.push('\n');

  if (!usage) {
    out.push(`${ANSI.dim}(no assistant turn yet — usage will appear after first response)${ANSI.reset}\n`);
    process.stdout.write(out.join(''));
    return;
  }

  const pct = (usage.total / MODEL_MAX) * 100;
  const remaining = MODEL_MAX - usage.total;
  const c = colorFor(pct);

  out.push(`${c}${ANSI.bold}${pct.toFixed(1)}%${ANSI.reset} ${ANSI.dim}used${ANSI.reset}\n`);
  out.push(`${c}${bar(pct, 30)}${ANSI.reset}\n`);
  out.push('\n');
  out.push(`${c}${fmtNum(usage.total)}${ANSI.reset} / ${fmtNum(MODEL_MAX)} tokens\n`);
  out.push(`${ANSI.dim}${fmtNum(remaining)} remaining${ANSI.reset}\n`);
  out.push(`${ANSI.dim}last reply: ${fmtNum(usage.output)} output tokens${ANSI.reset}\n`);
  out.push('\n');
  out.push(`${ANSI.dim}refresh every ${(REFRESH_MS / 1000).toFixed(0)}s · ctrl-c to exit${ANSI.reset}\n`);

  process.stdout.write(out.join(''));
}

process.stdout.write(ANSI.hideCursor);
process.on('SIGINT', () => {
  process.stdout.write(ANSI.showCursor + '\n');
  process.exit(0);
});
process.on('SIGTERM', () => {
  process.stdout.write(ANSI.showCursor + '\n');
  process.exit(0);
});

render();
setInterval(render, REFRESH_MS);
