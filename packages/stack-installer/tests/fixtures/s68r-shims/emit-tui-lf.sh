#!/bin/bash
# Same TUI shape but emitting bare \n (the tty driver supplies the \r) — this is
# what a normal CLI does. Compare against emit-tui.sh which emits explicit \r\n.
printf '\033[?1049h'
printf '\033[38;2;120;200;255m╭──────────────────────────────╮\033[0m\n'
printf '\033[38;2;120;200;255m│  codex  v0.2.33              │\033[0m\n'
printf '\033[38;2;120;200;255m╰──────────────────────────────╯\033[0m\n'
printf '\033[?2004h'
printf '> \n'
printf 's68r-canary-fixture-2026-08-01 explain the shim\n'
printf '⣾ thinking\r⣷ thinking\r⣯ thinking\r'
printf '\033[2K\r'
printf '\033[1mThe shim resolves the real binary next on PATH after itself.\033[0m\n'
printf 'It then runs that binary under script(1) so the CLI still sees a TTY.\n'
printf '────────────────────────────────\n'
printf '> \n'
printf 'and how does dedup work\n'
printf 'Inside a TermDeck panel the shim execs through without capturing.\n'
printf '\033[?2004l\033[?1049l'
