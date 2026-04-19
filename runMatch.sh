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

IKE_ARGS=(-p1 "$1" -p2 "$2" -p1.ai 8 -p2.ai 8 -rounds 1 -s "$3"
          -log "$LOG_FILE" -nosound -nojoy -windowed "${EXTRA_ARGS[@]}")

# Every match runs under bubblewrap with a PER-MATCH engine/save directory.
# Why: engine/save/config.json is mutated by Ikemen at startup and shutdown.
# With three parallel workers sharing the host engine/save, they race each
# other's writes and eventually corrupt the JSON — which Ikemen can't then
# parse, pops a modal, and hangs. Per-match private save dirs eliminate the
# shared mutable state entirely.
#
# MATCH_SANDBOX=off bypasses bwrap (fall back to the direct launch — used
# by smokes on machines without bwrap).
: > "$LOG_FILE"

if [ "$MATCH_SANDBOX" = "off" ] || ! command -v bwrap >/dev/null 2>&1; then
  $ENGINE "${IKE_ARGS[@]}"
  exit $?
fi

WORKER_SAVE="$(mktemp -d /tmp/mb-save.XXXXXX)"
# Seed the private save dir from the host copy — Ikemen reads config.json
# at startup, so we need it to exist and be valid.
cp -rT "$ENGINE_DIR/save" "$WORKER_SAVE" 2>/dev/null || true
# If config.json was corrupt on the host, replace with pristine (or drop it
# entirely — Ikemen will regenerate defaults).
if [ -f "$WORKER_SAVE/config.json" ] && \
   ! python3 -c "import json; json.load(open('$WORKER_SAVE/config.json'))" >/dev/null 2>&1; then
  if [ -f "$ENGINE_DIR/save/config.json.pristine" ]; then
    cp "$ENGINE_DIR/save/config.json.pristine" "$WORKER_SAVE/config.json"
  else
    rm -f "$WORKER_SAVE/config.json"
  fi
fi
trap 'rm -rf "$WORKER_SAVE"' EXIT

exec bwrap \
  --unshare-net --unshare-pid --die-with-parent --new-session \
  --ro-bind /usr /usr \
  --ro-bind /etc /etc \
  --symlink usr/lib /lib \
  --symlink usr/lib /lib64 \
  --ro-bind "$ENGINE_DIR" "$ENGINE_DIR" \
  --bind "$WORKER_SAVE" "$ENGINE_DIR/save" \
  --tmpfs /tmp \
  --ro-bind /tmp/.X11-unix /tmp/.X11-unix \
  --bind "$LOG_FILE" "$LOG_FILE" \
  --dev /dev \
  --proc /proc \
  --setenv DISPLAY "${DISPLAY:-:0}" \
  --chdir "$ENGINE_DIR" \
  "$ENGINE" "${IKE_ARGS[@]}"
