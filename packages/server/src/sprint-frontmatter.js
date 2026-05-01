// Sprint 47 T1 — YAML-subset frontmatter parser for sprint PLANNING.md and
// per-lane briefs, plus a lane→adapter resolver.
//
// Convention this lane establishes (Sprint 48+ uses it):
//   ---
//   sprint: 48
//   lanes:
//     - tag: T1
//       agent: codex
//     - tag: T2
//       agent: gemini
//   ---
//
// Sprint 45/46/47 docs have no frontmatter — `parseFrontmatter` returns `{}`
// and `getLaneAgent` falls back to the Claude adapter. Forward-only, no
// rewriting of historical PLANNING.md files. No third-party YAML dependency:
// hand-rolled subset (top-level scalars + a sequence of string-scalar
// mappings) keeps the no-build vanilla-JS architecture intact.

const fs = require('fs');
const { AGENT_ADAPTERS } = require('./agent-adapters');

const VALID_AGENTS = Object.keys(AGENT_ADAPTERS);

function parseFrontmatter(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    throw new Error(`${filePath}: unclosed frontmatter block (no trailing '---')`);
  }
  const result = {};
  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    if (_indent(line, filePath, i) !== 0) {
      throw new Error(`${filePath}:${i + 1}: top-level key must start at column 0`);
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`${filePath}:${i + 1}: expected 'key: value' or 'key:'`);
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest !== '') {
      result[key] = _scalar(rest, filePath, i);
      i++;
    } else {
      const [items, consumed] = _sequence(lines, i + 1, end, filePath);
      result[key] = items;
      i = i + 1 + consumed;
    }
  }
  if (Array.isArray(result.lanes)) {
    for (const lane of result.lanes) {
      if (lane.agent !== undefined && !VALID_AGENTS.includes(lane.agent)) {
        throw new Error(
          `${filePath}: invalid agent '${lane.agent}' on lane ${lane.tag || '(unknown)'}. ` +
          `Valid: ${VALID_AGENTS.join(', ')}`
        );
      }
    }
  }
  return result;
}

function _sequence(lines, start, end, filePath) {
  const items = [];
  let baseIndent = null;
  let mapIndent = null;
  let current = null;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    const ind = _indent(line, filePath, i);
    if (baseIndent === null) baseIndent = ind;
    if (ind < baseIndent) break;
    const trimmed = line.slice(ind);
    if (ind === baseIndent && trimmed.startsWith('- ')) {
      if (current) items.push(current);
      current = {};
      mapIndent = ind + 2;
      const after = trimmed.slice(2);
      const c = after.indexOf(':');
      if (c === -1) {
        throw new Error(`${filePath}:${i + 1}: sequence item must start with 'key: value'`);
      }
      current[after.slice(0, c).trim()] = _scalar(after.slice(c + 1).trim(), filePath, i);
    } else if (ind === mapIndent && current) {
      const c = line.indexOf(':');
      if (c === -1) {
        throw new Error(`${filePath}:${i + 1}: mapping continuation must be 'key: value'`);
      }
      current[line.slice(0, c).trim()] = _scalar(line.slice(c + 1).trim(), filePath, i);
    } else {
      throw new Error(
        `${filePath}:${i + 1}: unexpected indentation (got ${ind} spaces; ` +
        `expected ${baseIndent} for new item or ${mapIndent} for continuation)`
      );
    }
    i++;
  }
  if (current) items.push(current);
  return [items, i - start];
}

function _scalar(s, filePath, idx) {
  if (s === '') return null;
  const q = s[0];
  if (q === '"' || q === "'") {
    if (s.length < 2 || s[s.length - 1] !== q) {
      throw new Error(`${filePath}:${idx + 1}: unclosed quote`);
    }
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function _indent(line, filePath, idx) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  if (line[n] === '\t') {
    throw new Error(`${filePath}:${idx + 1}: tab indentation not supported (use spaces)`);
  }
  return n;
}

function getLaneAgent(briefPath, laneTag) {
  const fm = parseFrontmatter(briefPath);
  if (!Array.isArray(fm.lanes)) return AGENT_ADAPTERS.claude;
  const lane = fm.lanes.find((l) => l.tag === laneTag);
  if (!lane || !lane.agent) return AGENT_ADAPTERS.claude;
  const adapter = AGENT_ADAPTERS[lane.agent];
  if (!adapter) {
    throw new Error(
      `sprint-frontmatter: unknown agent '${lane.agent}' for lane ${laneTag} ` +
      `(valid: ${VALID_AGENTS.join(', ')})`
    );
  }
  return adapter;
}

module.exports = { parseFrontmatter, getLaneAgent };
