// TermDeck input guard — extracted Sprint 73 T3 (termdeck#12, second half)
//
// Pure state-machine: given a stream of xterm `onData` chunks for one panel,
// decide per chunk whether it is plausible human/protocol input (`pass`) or a
// runaway re-emission of the input buffer (`suppress`). Lives in its own file
// so the same code runs in the browser (via <script src="input-guard.js">)
// AND under `node --test` (via `require('.../input-guard')`) — the
// launcher-resolver.js pattern.
//
// Why this exists (termdeck#12, the "input box accumulates buffer-so-far per
// keystroke" half): on composition-style keyboards — Android/iOS soft
// keyboards, IMEs, dictation, remote-access keyboard bridges — every keydown
// reaches xterm as keyCode 229 and xterm@5.5.0 reconstructs the typed data
// from its hidden helper <textarea>:
//
//   1. The textarea is cleared ONLY on a non-composition Enter/Ctrl+C keydown
//      (xterm src/browser/Terminal.ts:1066-1068). Composition keydowns return
//      early, so mid-message the textarea accumulates the entire buffer-so-far.
//   2. CompositionHelper._handleAnyTextareaChanges computes the keystroke as
//      `newValue.replace(oldValue, '')` (CompositionHelper.ts:191). When the
//      keyboard REWRITES text (autocorrect / auto-space / predictive commit —
//      routine at word boundaries) `oldValue` is no longer a substring, the
//      replace matches nothing, and the ENTIRE accumulated buffer is emitted
//      as one data event.
//   3. CompositionHelper._finalizeComposition emits
//      `textarea.value.substring(start[, end])` spans with offsets captured at
//      composition boundaries (CompositionHelper.ts:134,163,168) — stale
//      offsets re-emit accumulated tails per word commit.
//
// Net effect observed in #12: a ~110-char message became a 3,042-char PTY
// stream of cumulative prefixes ("i think" / "i think there" / "i think there
// is" …). Each individual chunk was small (~5-110 chars) — so a single-chunk
// size cap can NOT catch the primary shape. Detection keys on the structure:
// consecutive multi-char chunks where each strictly extends the previous one
// as a prefix. Legit input never looks like that: typed keys arrive as 1-char
// deltas, IME commits arrive as sibling words (not superstrings), pastes
// arrive as one chunk (and are exempted via the DOM `paste` event and/or
// bracketed-paste markers), and terminal protocol replies are ESC-prefixed.
//
// xterm itself is loaded from CDN, version-pinned (index.html) and not
// patchable in a zero-build client — but every byte of human browser input
// reaches the PTY through exactly one chokepoint TermDeck owns: the
// `terminal.onData` handler in app.js. This module is that chokepoint's
// brain. See tests/input-guard contract: packages/server/tests/input-guard.test.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InputGuard = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULTS = {
    // A single non-paste, non-protocol chunk this large is not human typing.
    // Largest legit non-paste chunks are IME phrase commits (CJK conversion,
    // dictation segments) — realistically well under this. Suppressed chunks
    // are held for an explicit "send anyway" so a false positive costs one
    // click, while a true positive saves the session.
    oversizeChunkChars: 512,

    // Chunks shorter than this never participate in chain detection: 1-2
    // chars is normal typing, 3 covers short escape sequences. Chain
    // candidates start at 4 chars.
    chainMinChunkChars: 4,

    // Consecutive strictly-growing prefix-chained chunks before tripping.
    // 3 means: chunk B extending chunk A passes (a single predictive-commit
    // rewrite can legitimately look like that once), but a third consecutive
    // extension is the #12 runaway. Brad's payload chains 20+ deep.
    prefixChainTripCount: 3,

    // Consecutive IDENTICAL multi-char chunks before tripping. Belt-and-
    // suspenders for the stacked-handler / stuck-repeat shape. High threshold
    // because short identical runs are legit ("ha ha ha ha" via IME commits).
    repeatChainTripCount: 8,

    // Chain links must arrive within this window of each other. Runaway
    // emissions arrive at typing cadence; a long pause breaks the chain.
    chainWindowMs: 5000,

    // Grace period after a DOM `paste` event during which any chunk passes.
    // Pastes are deliberate; they also reset chain state.
    pasteGraceMs: 1500,
  };

  function createGuard(opts) {
    return {
      cfg: Object.assign({}, DEFAULTS, opts || {}),
      lastPasteAt: 0,
      prevChunk: '',
      prevChunkAt: 0,
      prefixChainLen: 0,
      repeatChainLen: 0,
      suppressedCount: 0,
      suppressedChars: 0,
    };
  }

  // Record a DOM `paste` event on the panel's textarea (timestamp from the
  // caller so the module stays clock-free and testable).
  function notePaste(guard, now) {
    guard.lastPasteAt = now;
  }

  function resetChains(guard) {
    guard.prevChunk = '';
    guard.prevChunkAt = 0;
    guard.prefixChainLen = 0;
    guard.repeatChainLen = 0;
  }

  // Classify one onData chunk. Returns { verdict: 'pass' } or
  // { verdict: 'suppress', reason: 'prefix-chain'|'repeat-chain'|'oversize',
  //   chainLength, suppressedCount, suppressedChars }.
  function check(guard, data, now) {
    const cfg = guard.cfg;

    // Bracketed paste (xterm wraps pastes in \x1b[200~ … \x1b[201~ when the
    // app enabled DECSET 2004): deliberate bulk input — pass and reset
    // chains. Checked before the generic ESC pass-through so the reset fires.
    if (data.startsWith('\x1b[200~')) {
      resetChains(guard);
      return { verdict: 'pass' };
    }

    // Terminal protocol traffic (cursor/function keys, mouse tracking
    // reports, DA/DSR query replies) is ESC-prefixed and must NEVER be
    // suppressed or held — dropping a query reply can hang a TUI. The #12
    // runaway is plain text reconstructed from the textarea, which cannot
    // contain ESC. Protocol chunks don't touch chain state either (mouse
    // wheel bursts emit many near-identical chunks legitimately).
    if (data.charCodeAt(0) === 0x1b) {
      return { verdict: 'pass' };
    }

    // DOM-paste grace: a `paste` event just fired on this panel's textarea
    // (un-bracketed paste path). Deliberate bulk input — pass and reset
    // chains. lastPasteAt === 0 means "never pasted", not "pasted at epoch".
    if (guard.lastPasteAt > 0 && (now - guard.lastPasteAt) <= cfg.pasteGraceMs) {
      resetChains(guard);
      return { verdict: 'pass' };
    }

    // Small chunks are normal typing / control chars: always pass, and leave
    // chain state alone (runaway prefix emissions can interleave with real
    // keystroke deltas; a 1-char delta must not amnesty the chain).
    if (data.length < cfg.chainMinChunkChars) {
      return { verdict: 'pass' };
    }

    // Multi-char plain-text chunk: update chain state.
    const withinWindow = guard.prevChunk && (now - guard.prevChunkAt) <= cfg.chainWindowMs;
    if (withinWindow && data.length > guard.prevChunk.length && data.startsWith(guard.prevChunk)) {
      guard.prefixChainLen += 1;
      guard.repeatChainLen = 1;
    } else if (withinWindow && data === guard.prevChunk) {
      guard.repeatChainLen += 1;
      // An identical re-emission keeps a prefix chain alive but doesn't grow it.
    } else {
      guard.prefixChainLen = 1;
      guard.repeatChainLen = 1;
    }
    guard.prevChunk = data;
    guard.prevChunkAt = now;

    let reason = null;
    if (guard.prefixChainLen >= cfg.prefixChainTripCount) {
      reason = 'prefix-chain';
    } else if (guard.repeatChainLen >= cfg.repeatChainTripCount) {
      reason = 'repeat-chain';
    } else if (data.length >= cfg.oversizeChunkChars) {
      reason = 'oversize';
    }

    if (reason) {
      guard.suppressedCount += 1;
      guard.suppressedChars += data.length;
      return {
        verdict: 'suppress',
        reason,
        chainLength: reason === 'repeat-chain' ? guard.repeatChainLen : guard.prefixChainLen,
        suppressedCount: guard.suppressedCount,
        suppressedChars: guard.suppressedChars,
      };
    }

    return { verdict: 'pass' };
  }

  return { DEFAULTS, createGuard, notePaste, check };
});
