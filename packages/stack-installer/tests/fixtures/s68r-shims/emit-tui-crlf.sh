#!/bin/bash
# Emits a realistic agent-TUI byte stream: truecolor SGR, box-drawing chrome,
# braille spinner overdraw via lone CR, bracketed-paste toggles, alt-screen,
# and a `> ` input box echo. Run UNDER `script -q` to capture a genuine PTY log.
printf '\033[?1049h'                       # alt-screen on
printf '\033[38;2;120;200;255m╭──────────────────────────────╮\033[0m\r\n'
printf '\033[38;2;120;200;255m│  codex  v0.2.33              │\033[0m\r\n'
printf '\033[38;2;120;200;255m╰──────────────────────────────╯\033[0m\r\n'
printf '\033[?2004h'                       # bracketed paste on
printf '> \r\n'
printf 's68r-canary-fixture-2026-08-01 explain the shim\r\n'
printf '⣾ thinking\r⣷ thinking\r⣯ thinking\r'   # lone-CR spinner overdraw
printf '\033[2K\r'                          # erase line
printf '\033[1mThe shim resolves the real binary next on PATH after itself.\033[0m\r\n'
printf 'It then runs that binary under script(1) so the CLI still sees a TTY.\r\n'
printf '────────────────────────────────\r\n'   # chrome rule
printf '> \r\n'
printf 'and how does dedup work\r\n'
printf 'Inside a TermDeck panel the shim execs through without capturing.\r\n'
printf '\033[?2004l\033[?1049l'             # bracketed paste off, alt-screen off
