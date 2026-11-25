#!/usr/bin/env bash
# Compiles the real helper against fake devices; never changes live audio/playback.
set -euo pipefail
cd "$(dirname "$0")/.."
binary=$(mktemp "${TMPDIR:-/tmp}/zdeck-system-test.XXXXXX")
trap 'rm -f "$binary"' EXIT
xcrun clang -fobjc-arc -Wall -Wextra crates/zdeck-system/tests/system_macos.m \
  -framework CoreAudio -framework Foundation -framework AppKit -framework ApplicationServices \
  -o "$binary"
"$binary"
