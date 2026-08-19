#!/bin/bash
# ============================================================
#  Dagou-Tap frontend + backend server launcher (macOS/Linux)
#  Requires: Node.js v18+ (zero npm dependencies)
#  Usage: run "./start.sh" here.
# ============================================================
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Please install Node.js v18 or newer."
  echo "        Get it from https://nodejs.org/"
  exit 1
fi

# Port can be overridden by setting PORT before running.
if [ -z "$PORT" ]; then PORT=8000; fi

# If the requested port is busy, automatically try the next ports.
FREE_PORT=""
p=$PORT
while [ "$p" -le 8099 ]; do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    FREE_PORT=$p
    break
  fi
  p=$((p + 1))
done

if [ -z "$FREE_PORT" ]; then
  echo "[ERROR] Could not find a free port between $PORT and 8099."
  exit 1
fi

if [ "$PORT" != "$FREE_PORT" ]; then
  echo "[WARN] Port $PORT is already in use. Using port $FREE_PORT instead."
  PORT=$FREE_PORT
fi
export PORT

echo "------------------------------------------------------------"
echo " Dagou-Tap server"
echo " Local:   http://localhost:$PORT/"
echo " API:     http://localhost:$PORT/api/characters"
echo " Press Ctrl+C to stop."
echo "------------------------------------------------------------"
node scripts/server.js
EXIT_CODE=$?

echo
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "[ERROR] Server exited with code $EXIT_CODE."
else
  echo "[INFO] Server stopped."
fi
exit $EXIT_CODE
