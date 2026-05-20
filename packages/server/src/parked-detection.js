/**
 * Parked-lane detection for TermDeck.
 *
 * Algorithm:
 * - If session status is not "active", it's not parked (it might be thinking, editing, or exited).
 * - If lastActivity was within the last 5 minutes, it's genuinely active.
 * - Otherwise, parse the trailing output buffer for Claude Code's completion banners.
 * - If matched, it's parked.
 *
 * Completion banners (Claude Code):
 * - "Cogitated for 1m 2s"
 * - "Churned for 5m 10s"
 * - Verbs: Cogitated, Churned, Brewed, Cooked, Mused, Pondered, Wandered, Crafted.
 */

const { stripAnsi } = require('./transcripts');

function detectParked(session) {
  if (!session || !session.meta) return false;

  // Only "active" (PTY-wise) sessions can be "parked" (semantic-wise).
  // "thinking" or "editing" statuses are already semantic indicators
  // of work-in-progress.
  if (session.meta.status !== 'active') return false;

  const now = Date.now();
  const lastActivity = new Date(session.meta.lastActivity).getTime();
  const ageMs = now - lastActivity;

  // Threshold: 5 minutes.
  const FIVE_MIN_MS = 5 * 60 * 1000;
  if (ageMs < FIVE_MIN_MS) return false;

  // Read the session's output buffer (last ~4KB preserved in Session.analyzeOutput).
  const buffer = session._outputBuffer || '';
  if (!buffer) return false;

  // Strip ANSI to match the plain-text banner
  const cleanBuffer = stripAnsi(buffer);

  // Regex per BRIEF + PLANNING:
  // (Cogitated|Churned|Brewed|Cooked|Mused|Pondered|Wandered|Crafted) for \d+m \d+s
  const PARKED_BANNER_RE = /(?:Cogitated|Churned|Brewed|Cooked|Mused|Pondered|Wandered|Crafted) for \d+m \d+s/i;

  // Look in the last ~1000 chars of the cleaned buffer.
  const tail = cleanBuffer.slice(-1000);
  return PARKED_BANNER_RE.test(tail);
}

module.exports = { detectParked };
