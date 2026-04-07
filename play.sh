#!/bin/bash
# play.sh — Start agent + dual capture for a live multiplayer session.
#
# Runs:
# 1. The autonomous agent with vision + audio
# 2. Client screenshot capture (your Minecraft window)
# 3. Prismarine-viewer capture (agent's rendered view)
#
# Usage:
#   ./play.sh                          # default: AgentBot, 100 turns
#   ./play.sh --name Buddy --turns 200
#   ./play.sh --follow YourMCUsername   # capture follows your view
#
# Prerequisites:
#   - MC server running (./start.sh or manual)
#   - Your Minecraft client connected to localhost:25565
#   - Skills seeded (auto-checked)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"

# Parse args
BOT_NAME="AgentBot"
TURNS=100
FOLLOW=""
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) BOT_NAME="$2"; shift 2;;
    --turns) TURNS="$2"; shift 2;;
    --follow) FOLLOW="$2"; shift 2;;
    *) EXTRA_ARGS="$EXTRA_ARGS $1"; shift;;
  esac
done

echo "╔══════════════════════════════════════════╗"
echo "║  Minecraft Agent — Live Play Session     ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Bot: $BOT_NAME"
echo "║  Turns: $TURNS"
echo "║  Vision: ON"
echo "║  Audio: ON"
if [ -n "$FOLLOW" ]; then
echo "║  Following: $FOLLOW"
fi
echo "╚══════════════════════════════════════════╝"

# Ensure skills are seeded
if [ ! -f skills/learned/index.json ]; then
  echo "[SETUP] Seeding skills..."
  node skills/seeds.js
fi

# Kill any existing agents/viewers
pkill -f "AgentBot\|ClientCapBot" 2>/dev/null
for p in 3003 3005; do lsof -ti:$p | xargs kill -9 2>/dev/null; done
sleep 1

# Start agent with vision
echo "[START] Launching agent..."
node agent.js --vision --name "$BOT_NAME" --turns "$TURNS" $EXTRA_ARGS 2>&1 | tee /tmp/mc-agent.log &
AGENT_PID=$!
sleep 10  # let agent + viewer start

# Start client capture (your Minecraft window)
echo "[START] Launching client screenshot capture..."
FOLLOW_FLAG=""
if [ -n "$FOLLOW" ]; then
  FOLLOW_FLAG="--follow $FOLLOW"
fi
node perception/capture-client.js --frames 500 --interval 3 $FOLLOW_FLAG 2>&1 | tee /tmp/mc-client-capture.log &
CLIENT_PID=$!

echo ""
echo "═══════════════════════════════════════════"
echo "  READY — Play Minecraft and chat with $BOT_NAME!"
echo "  Agent PID: $AGENT_PID"
echo "  Client capture PID: $CLIENT_PID"
echo "  Press Ctrl+C to stop everything"
echo "═══════════════════════════════════════════"

# Wait for agent to finish or Ctrl+C
trap "echo 'Stopping...'; kill $AGENT_PID $CLIENT_PID 2>/dev/null; exit 0" INT TERM
wait $AGENT_PID
kill $CLIENT_PID 2>/dev/null

echo ""
echo "[DONE] Session complete."
echo "  Agent log: /tmp/mc-agent.log"
echo "  Client captures: data/client_captures/"
