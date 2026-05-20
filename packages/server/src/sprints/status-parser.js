/**
 * STATUS.md parser for TermDeck.
 *
 * Scans the whole file to extract the latest state for each lane.
 */

const fs = require('fs');

function parseStatusMd(filePath) {
  const result = {
    lanes: {},
    open_red_count: 0,
    last_orchestrator_post: null,
    last_final_verdict: null
  };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Regex per BRIEF (loosened for multiple suffixes):
  // ^### \[(T\d+(?:-[A-Z0-9-]+)?|ORCH)\] (FINDING|PROPOSE|LANDED|DONE|AUDIT-RED|AUDIT-CONCERN|CHECKPOINT|FINAL-VERDICT|STATUS|RULING) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ET — (.*?)$
  const POST_RE = /^### \[(T\d+(?:-[A-Z0-9-]+)?|ORCH)\] (FINDING|PROPOSE|LANDED|DONE|AUDIT-RED|AUDIT-CONCERN|CHECKPOINT|FINAL-VERDICT|STATUS|RULING) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ET — (.*?)$/;

  const laneLandeds = {}; // laneTag -> latest LANDED timestamp
  const openReds = []; // List of {tag, timestamp, gist}

  lines.forEach((line, index) => {
    const match = line.match(POST_RE);
    if (!match) return;

    const [full, tag, verb, date, time, gist] = match;
    const timestamp = `${date}T${time}:00`; 
    const lineNum = index + 1;

    if (tag === 'ORCH') {
      result.last_orchestrator_post = gist;
      return;
    }

    // Ensure lane entry
    if (!result.lanes[tag]) {
      result.lanes[tag] = {
        last_post: null,
        open_reds_against_me: [],
        landed_since_last_red: false
      };
    }

    result.lanes[tag].last_post = {
      verb,
      timestamp: `${date}T${time}:00-04:00`,
      line: lineNum,
      gist
    };

    if (verb === 'LANDED') {
      laneLandeds[tag] = timestamp;
    }

    if (verb === 'AUDIT-RED') {
      const mentionedLanes = gist.match(/T\d+(?:-[A-Z0-9-]+)?/g) || [];
      mentionedLanes.forEach(targetLane => {
        // Ensure the mentioned lane also exists in result.lanes
        if (!result.lanes[targetLane]) {
          result.lanes[targetLane] = {
            last_post: null,
            open_reds_against_me: [],
            landed_since_last_red: false
          };
        }
        openReds.push({ tag: targetLane, timestamp, gist });
      });
    }

    if (verb === 'FINAL-VERDICT') {
      result.last_final_verdict = {
        verb,
        timestamp: `${date}T${time}:00-04:00`,
        gist
      };
    }
  });

  // Calculate landed_since_last_red and open_reds_against_me
  Object.keys(result.lanes).forEach(tag => {
    const lastLanded = laneLandeds[tag];
    
    result.lanes[tag].open_reds_against_me = openReds
      .filter(red => red.tag === tag && (!lastLanded || lastLanded <= red.timestamp))
      .map(red => ({ timestamp: red.timestamp, gist: red.gist }));

    const allRedsForLane = openReds.filter(red => red.tag === tag);
    if (allRedsForLane.length === 0) {
      result.lanes[tag].landed_since_last_red = !!lastLanded;
    } else {
      const latestRedTs = allRedsForLane.reduce((max, r) => r.timestamp > max ? r.timestamp : max, "");
      result.lanes[tag].landed_since_last_red = !!(lastLanded && lastLanded > latestRedTs);
    }
  });

  // Count open reds
  const uniqueOpenReds = new Set();
  openReds.forEach(red => {
    const lastLanded = laneLandeds[red.tag];
    if (!lastLanded || lastLanded <= red.timestamp) {
      uniqueOpenReds.add(`${red.tag}:${red.timestamp}`);
    }
  });
  result.open_red_count = uniqueOpenReds.size;

  // Final Verdict lanes_with_open_defects
  if (result.last_final_verdict) {
    const openDefects = [];
    Object.keys(result.lanes).forEach(tag => {
      if (result.lanes[tag].open_reds_against_me.length > 0) {
        openDefects.push(tag);
      }
    });
    result.last_final_verdict.lanes_with_open_defects = openDefects;
  }

  return result;
}

module.exports = { parseStatusMd };
