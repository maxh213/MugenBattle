#!/bin/bash
# Usage: ./runMatch.sh <fighter1> <fighter2> <stage>
# Launches an Ikemen GO match with AI-controlled players and outputs the results.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$SCRIPT_DIR/engine"
LOG_FILE="$SCRIPT_DIR/matchData.log"

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
  -windowed
