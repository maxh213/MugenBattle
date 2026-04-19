#!/bin/bash
# Usage: ./runMatch.sh <fighter1> <fighter2> <stage> [p1_life] [p2_life]
# Launches an Ikemen GO match with AI-controlled players and outputs the results.
# p1_life / p2_life are optional starting-life overrides (integer, typically 400-1000).
# When omitted, Ikemen uses each char's default.
#
# Per-worker isolation (for M6 multi-stream):
#   MATCH_LOG_FILE  — where Ikemen writes the match log. Defaults to
#                     matchData.log in the repo root (historical behaviour).
#                     Two parallel workers MUST set different paths.
#   DISPLAY         — X display to render into. Inherited from the env;
#                     each Xvfb-backed worker sets its own (e.g. :100, :101).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$SCRIPT_DIR/engine"
LOG_FILE="${MATCH_LOG_FILE:-$SCRIPT_DIR/matchData.log}"

# Clear previous log
> "$LOG_FILE"

cd "$ENGINE_DIR" || { echo "Engine directory not found: $ENGINE_DIR"; exit 1; }

# Detect the Ikemen GO binary name
if [ -x "./Ikemen_GO_Linux" ]; then
  ENGINE="./Ikemen_GO_Linux"
elif [ -x "./Ikemen_GO_LinuxARM" ]; then
  ENGINE="./Ikemen_GO_LinuxARM"
elif [ -x "./Ikemen_GO" ]; then
  ENGINE="./Ikemen_GO"
else
  echo "Ikemen GO binary not found in $ENGINE_DIR"
  exit 1
fi

EXTRA_ARGS=()
if [ -n "$4" ]; then EXTRA_ARGS+=(-p1.life "$4"); fi
if [ -n "$5" ]; then EXTRA_ARGS+=(-p2.life "$5"); fi

# Smoke-test acceleration. MATCH_SPEED=200 caps at Ikemen's -speed limit;
# MATCH_SPEED=speedtest switches to -speedtest (~100x). Unset = normal.
if [ -n "$MATCH_SPEED" ]; then
  if [ "$MATCH_SPEED" = "speedtest" ]; then
    EXTRA_ARGS+=(-speedtest)
  else
    EXTRA_ARGS+=(-speed "$MATCH_SPEED")
  fi
fi

$ENGINE \
  -p1 "$1" \
  -p2 "$2" \
  -p1.ai 8 \
  -p2.ai 8 \
  -rounds 1 \
  -s "$3" \
  -log "$LOG_FILE" \
  -nosound \
  -nojoy \
  -windowed \
  "${EXTRA_ARGS[@]}"
