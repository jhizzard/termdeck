# Sprint 68-REDUX raw-PTY fixtures

These are **real** `script(1)` captures, not hand-typed approximations. That distinction is
load-bearing: the first hand-reasoned version of these tests would have passed while the
production path silently dropped every message (see the CRLF case below).

## Files

| File | What it is |
|---|---|
| `emit-tui-lf.sh` | Generator. Emits an agent-TUI byte stream terminating lines with bare `\n` — what a normal CLI does; the tty driver supplies the `\r` via ONLCR. |
| `emit-tui-crlf.sh` | Same content, but the program writes its own `\r\n`. Under a PTY this lands on disk as `\r\r\n`. |
| `raw-pty-lf.log` | 767 B. `script -q raw-pty-lf.log ./emit-tui-lf.sh` |
| `raw-pty-crlf.log` | 778 B. `script -q raw-pty-crlf.log ./emit-tui-crlf.sh` — contains 11 `\r\r\n` sequences. |

Both streams carry the things that actually break naive parsers: truecolor SGR, box-drawing
chrome, a braille spinner overdrawn with lone `\r`, bracketed-paste and alt-screen toggles,
`\033[2K` erase-line, and `> ` input-box echoes. Both contain the canary phrase
`s68r-canary-fixture-2026-08-01` in a user turn.

## Why two line-ending variants

A PTY's ONLCR maps a program's `\n` to `\r\n` on the wire. A program that writes its *own*
`\r\n` therefore produces `\r\r\n`. `_normalizeOverdraw` in
`packages/server/src/agent-adapters/agy.js` collapses `\r\n` and then keeps only the text after
the **last** `\r` on each line — so with `\r\r\n` a stranded `\r` sits at end-of-line and every
content line collapses to the empty string. The transcript parses to **zero messages**, silently.

The pair exists so that regression is impossible to reintroduce without a red test: the fences
assert both fixtures yield the same 6 messages with the same roles.

## Regenerating

```bash
cd packages/stack-installer/tests/fixtures/s68r-shims
script -q raw-pty-lf.log   ./emit-tui-lf.sh
script -q raw-pty-crlf.log ./emit-tui-crlf.sh
```

macOS/BSD `script` signature is `script [-q] file command ...`. On GNU/Linux `script` the
argument order differs (`script -q -c 'cmd' file`); regenerate on macOS to keep the bytes
comparable, or update both the generator invocation and the committed logs together.

Prefer regenerating over hand-editing the `.log` files. They are binary-ish (raw ESC bytes) and
an editor that normalizes line endings will destroy exactly the property under test.
