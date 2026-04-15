// Readline-based interactive prompts for the `termdeck init` wizards.
//
// No external deps. All prompts in a single wizard run share ONE readline
// interface (via the module-scoped `rl` below). We consume lines via the
// `line` event and an internal FIFO of pending resolvers instead of
// `rl.question()` — the latter has broken behavior when stdin is a piped
// stream in non-terminal mode, where the second `.question()` call silently
// hangs. The event-driven path works for both TTY and piped input, which lets
// us drive the wizard non-interactively in tests:
//
//   printf 'a\nb\nc\n' | termdeck init --mnestra --dry-run
//
// Secret prompts still mute stdout echo when TTY is attached; on non-TTY
// stdin they fall back to visible input so piped test runs work.

const readline = require('readline');

let rl = null;
const waiting = [];   // pending resolver functions
const buffered = [];  // lines that arrived before anyone was waiting
let sawEnd = false;

function getRl() {
  if (rl) return rl;
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  rl.on('line', (line) => {
    if (waiting.length > 0) {
      const resolver = waiting.shift();
      resolver(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    sawEnd = true;
    while (waiting.length > 0) {
      const resolver = waiting.shift();
      resolver('');
    }
  });
  return rl;
}

function readLine() {
  return new Promise((resolve) => {
    getRl();
    if (buffered.length > 0) {
      resolve(buffered.shift());
      return;
    }
    if (sawEnd) { resolve(''); return; }
    waiting.push(resolve);
  });
}

// Basic non-secret prompt. Returns empty string if the user just hits enter.
async function ask(question, { defaultValue } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  if (question) process.stdout.write(`${question}${suffix}: `);
  const line = await readLine();
  const trimmed = (line || '').trim();
  return trimmed || defaultValue || '';
}

// Required prompt — re-asks up to `maxAttempts` times if the answer is empty
// or fails `validate(value) → null | string`. A validator returning a string
// message means "invalid, re-ask with this error". Throws if all attempts fail.
async function askRequired(question, { validate, maxAttempts = 3 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const answer = await ask(question);
    if (!answer) {
      process.stdout.write('  (required)\n');
      continue;
    }
    if (validate) {
      const err = validate(answer);
      if (err) {
        process.stdout.write(`  ${err}\n`);
        continue;
      }
    }
    return answer;
  }
  throw new Error(`No valid answer after ${maxAttempts} attempts: ${question}`);
}

// Optional prompt. Empty → null. Still validates non-empty answers.
async function askOptional(question, { validate } = {}) {
  const answer = await ask(question);
  if (!answer) return null;
  if (validate) {
    const err = validate(answer);
    if (err) {
      process.stdout.write(`  ${err} — ignoring.\n`);
      return null;
    }
  }
  return answer;
}

// Secret prompt. On TTY we mute echo; on non-TTY we fall back to a visible
// line read. Callers typically pass an empty string for `question` and write
// their own label first.
async function askSecret(question) {
  if (!process.stdin.isTTY) {
    return ask(question);
  }
  if (question) process.stdout.write(`${question}: `);
  // Raw-mode reader. Detach the shared readline for the duration so both
  // consumers aren't racing on stdin 'data' events.
  return new Promise((resolve) => {
    if (rl) rl.pause();
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    let buffer = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          if (rl) rl.resume();
          resolve(buffer);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.kill(process.pid, 'SIGINT');
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        buffer += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// Yes/no confirm. Returns boolean.
async function confirm(question, { defaultYes = true } = {}) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

module.exports = {
  ask,
  askRequired,
  askOptional,
  askSecret,
  confirm,
  closeRl
};
