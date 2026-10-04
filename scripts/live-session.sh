#!/usr/bin/env bash
# Run the live-bridge verification against a headless browser.
#
# The game page is opened by the browser itself rather than through
# Target.createTarget: a freshly created tab under headless Chromium sometimes
# never commits its navigation, and every CDP command to it then times out.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CDP_PORT="${CDP_PORT:-9333}"
GAME_PORT="${GAME_PORT:-8080}"
BROWSER="${EDGE_BIN:-/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
PROFILE="${PROFILE_DIR:-$HERE/.rpgmaker-mcp/edge-profile-live}"
# Which suite drives the session: the bridge verifier or a full playthrough.
VERIFY="${VERIFY_SCRIPT:-scripts/verify-live.mjs}"
LOG="$HERE/samples/$(basename "$VERIFY" .mjs).log"

stop_port() {
  local pid
  pid=$(powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique" 2>/dev/null | tr -d '\r')
  if [ -n "$pid" ]; then
    echo "stopping whatever holds port $1 (pid $pid)"
    powershell -NoProfile -Command "Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue"
  fi
}

stop_port "$CDP_PORT"
stop_port "$GAME_PORT"
sleep 2

rm -f "$LOG"
( cd "$HERE" && RMMZ_SKIP_BOOT=1 node "$VERIFY" > "$LOG" 2>&1; echo "EXIT=$?" >> "$LOG" ) &
VERIFIER=$!
sleep 5

"$BROWSER" --headless=new --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" --no-first-run --window-size=900,700 \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:$GAME_PORT/index.html" >/dev/null 2>&1 &
sleep 25

( cd "$HERE" && node scripts/drive-game.mjs "$CDP_PORT" )
wait "$VERIFIER"
cat "$LOG"
