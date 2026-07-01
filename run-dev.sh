#!/usr/bin/env bash
# Rainy dev runner — starts the python-service (Aiven-backed) + canvas-ui together.
# Run this in your OWN terminal so the servers persist:
#     ./run-dev.sh           (Ctrl+C stops both)
#
# Backend  → http://localhost:9000   (MCP + REST + WebSocket; reads DB from src/python-service/.env)
# Frontend → http://localhost:3000   (Next.js + tldraw canvas)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BREW="$(brew --prefix)"
pids=()

cleanup() { echo; echo "stopping…"; kill "${pids[@]}" 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "▶ backend  → http://localhost:9000  (python-service · Aiven)"
( cd "$ROOT/src/python-service" \
  && PATH="$PWD/.venv/bin:$BREW/bin:$PATH" exec ./.venv/bin/python server.py ) &
pids+=("$!")

echo "▶ frontend → http://localhost:3000  (canvas-ui)"
( cd "$ROOT/src/canvas-ui" && exec npm run dev ) &
pids+=("$!")

echo "(Ctrl+C to stop both)"
wait
