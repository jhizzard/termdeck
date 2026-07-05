#!/usr/bin/env bash
# Test fixture: stubs `gh` for packages/cli/tests/doctrine-cli.test.js so
# tests never touch the real GitHub API. Controlled via STUB_GH_PR_STATE
# (NONE|OPEN|MERGED) and logs invocations to STUB_GH_LOG when set.
LOG="${STUB_GH_LOG:-}"
if [ -n "$LOG" ]; then echo "gh $*" >> "$LOG"; fi

if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/fake-owner/fake-termdeck/pull/9999"
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  state="${STUB_GH_PR_STATE:-NONE}"
  if [ "$state" = "NONE" ]; then
    echo "[]"
  else
    echo "[{\"url\":\"https://github.com/fake-owner/fake-termdeck/pull/9999\",\"number\":9999,\"state\":\"$state\",\"title\":\"stub\"}]"
  fi
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "close" ]; then
  exit 0
fi

if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi

echo "stub-gh: unhandled args: $*" >&2
exit 1
