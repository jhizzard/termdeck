'use strict';

// Sprint 47 T4 — Cross-agent STATUS.md merger.
//
// Each lane agent (Claude / Codex / Gemini / Grok) posts FINDING /
// FIX-PROPOSED / DONE differently. Claude has the canonical shape nailed:
//   `- Tn: STAGE — one-line summary — YYYY-MM-DD HH:MM ET`
// The others may emit emoji prefixes, generic bullet lists, or free-form
// prose. mergeStatusLine() takes a raw line in any of those shapes and
// returns the canonical form, so the dashboard's STATUS.md regex parser and
// human readers see one consistent shape regardless of CLI.
//
// Sprint 47 ships this as infrastructure. Sprint 48 (or whenever the mixed
// 4+1 dogfood lands) is when it actually runs over real cross-agent posts.

const STAGES = new Set(['FINDING', 'FIX-PROPOSED', 'DONE']);

// Codex idiom: emoji prefix, optionally followed by `Found:`/`Fixed:`/etc.
// 🛠️ (with VS-16) and 🛠 (without) both round to FIX-PROPOSED — terminals
// disagree about the variation selector and we don't care which one came in.
const EMOJI_STAGES = [
  ['🛠️', 'FIX-PROPOSED'],
  ['🛠', 'FIX-PROPOSED'],
  ['🔍', 'FINDING'],
  ['✅', 'DONE'],
  ['🔧', 'FIX-PROPOSED'],
];
const EMOJI_LEADIN_RE = /^(?:Found|Fixed|Proposed|Proposing|Note|Status)\s*[:—\-]?\s*/i;

// Gemini idiom: bullet-pointed list with stage keyword.
const BULLET_FINDING_RE = /^[-*]\s+(?:found(?:\s+that)?|finding|noticed|observation)\s*[:—\-]?\s*(.+)$/i;
const BULLET_FIX_RE = /^[-*]\s+(?:propos(?:ing|ed)\s+fix(?:ing)?|fix[\s-]proposed|proposed\s+fix)\s*[:—\-]?\s*(.+)$/i;
const BULLET_DONE_RE = /^[-*]\s+(?:done|completed|finished|shipped)\s*[:—\-]?\s*(.+)$/i;

// Grok idiom: free-form first-person prose.
const PROSE_DONE_RE = /^(?:Done|Completed|Finished|Shipped)\s*[:—\-]?\s*(.+)$/i;
const PROSE_FIX_RE = /^(?:I'?ll\s+fix|I\s+will\s+fix|I'?m\s+fixing|Fixing|Proposing\s+(?:a\s+)?fix|Proposed\s+fix)\b\s*(?:this\s+by\s+|by\s+|[:—\-]\s*)?(.+)$/i;
const PROSE_FINDING_RE = /^(?:I\s+noticed|I\s+observed|I\s+found|I\s+saw|Noticed|Observed)\b\s*(?:that\s+)?(.+)$/i;

// Canonical Claude — timestamped. Greedy backtracking: we anchor the
// timestamp to a YYYY-MM-DD prefix so bodies that contain stray ` — ` (very
// common in real Sprint 46 lines) split at the right boundary.
const CANONICAL_TS_RE =
  /^[-*]?\s*(T\d+):\s*(FINDING|FIX-PROPOSED|DONE)\s+[—\-]\s+(.+?)\s+[—\-]\s+(\d{4}-\d{2}-\d{2}\b.*)$/;
// Canonical Claude without a trailing timestamp — we'll add one.
const CANONICAL_NO_TS_RE =
  /^[-*]?\s*(T\d+):\s*(FINDING|FIX-PROPOSED|DONE)\s+[—\-]\s+(.+)$/;

// Markdown section header — never a status line.
const HEADER_RE = /^#{1,6}\s/;
// Bare bracket-like meta lines: `_(no entries yet)_`, `> note`, etc.
const META_RE = /^[_>(]/;

const SUMMARY_MAX = 120;

function trimSummary(s) {
  s = String(s).trim().replace(/\s+/g, ' ');
  if (s.length > SUMMARY_MAX) {
    s = s.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, '') + '…';
  }
  return s;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Matches the real STATUS.md convention `YYYY-MM-DD HH:MM ET`. The ET tag is
// decorative (Joshua's tz); we don't try to convert from UTC because the
// surrounding harness already runs in his local clock.
function formatTimestamp(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())} ET`
  );
}

function detectEmojiStage(text) {
  for (const [emoji, stage] of EMOJI_STAGES) {
    if (text.startsWith(emoji)) {
      const after = text.slice(emoji.length).replace(/^[\s️]+/, '');
      return { stage, summary: after.replace(EMOJI_LEADIN_RE, '') };
    }
  }
  return null;
}

function detectBulletStage(text) {
  let m;
  if ((m = BULLET_FINDING_RE.exec(text))) return { stage: 'FINDING', summary: m[1] };
  if ((m = BULLET_FIX_RE.exec(text))) return { stage: 'FIX-PROPOSED', summary: m[1] };
  if ((m = BULLET_DONE_RE.exec(text))) return { stage: 'DONE', summary: m[1] };
  return null;
}

function detectProseStage(text) {
  let m;
  // Order matters: PROSE_DONE before PROSE_FIX before PROSE_FINDING because
  // "Done: foo" would otherwise also match nothing later, and "I'll fix" is
  // distinct from "I noticed" so order between them is safe.
  if ((m = PROSE_DONE_RE.exec(text))) return { stage: 'DONE', summary: m[1] };
  if ((m = PROSE_FIX_RE.exec(text))) return { stage: 'FIX-PROPOSED', summary: m[1] };
  if ((m = PROSE_FINDING_RE.exec(text))) return { stage: 'FINDING', summary: m[1] };
  return null;
}

function mergeStatusLine(rawLine, opts = {}) {
  if (typeof rawLine !== 'string') return null;
  const line = rawLine.replace(/\r?\n$/, '').trim();
  if (!line) return null;
  if (HEADER_RE.test(line)) return null;
  if (META_RE.test(line)) return null;

  // 1. Canonical with timestamp — pass through unchanged, normalize only the
  // leading bullet. The body is never trimmed here: real Sprint 46 lines are
  // routinely well over 120 chars and the brief mandates "same line out".
  let m = CANONICAL_TS_RE.exec(line);
  if (m) {
    const [, tag, stage, summary, ts] = m;
    return `- ${tag}: ${stage} — ${summary.trim()} — ${ts.trim()}`;
  }
  // 2. Canonical without timestamp — synthesize one. Body still untrimmed:
  // the author wrote a canonical-shape line, we trust its length.
  m = CANONICAL_NO_TS_RE.exec(line);
  if (m) {
    const [, tag, stage, summary] = m;
    const ts = formatTimestamp(opts.now || new Date());
    return `- ${tag}: ${stage} — ${summary.trim()} — ${ts}`;
  }

  // 3. Variant idioms — emoji, bullet, prose.
  const detected =
    detectEmojiStage(line) || detectBulletStage(line) || detectProseStage(line);
  if (!detected || !STAGES.has(detected.stage)) return null;

  const tag = opts.laneTag || 'T?';
  const ts = formatTimestamp(opts.now || new Date());
  return `- ${tag}: ${detected.stage} — ${trimSummary(detected.summary)} — ${ts}`;
}

module.exports = { mergeStatusLine };
