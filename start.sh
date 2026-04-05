#!/bin/bash
# start.sh — Start everything needed for the Minecraft agent
# Usage: ./start.sh [--agent] [--capture]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"

# Start Paper server if not running
if ! pgrep -f "paper-1.20.1.jar" > /dev/null; then
    echo "[START] Starting Minecraft server..."
    cd "$SERVER_DIR"
    java -Xmx2G -jar paper-1.20.1.jar --nogui > server.log 2>&1 &
    for i in $(seq 1 20); do
        sleep 2
        if grep -q "Done" server.log 2>/dev/null; then
            echo "[START] Server ready"
            break
        fi
    done
else
    echo "[START] Server already running"
fi

cd "$SCRIPT_DIR"

# Seed skill library if empty
if [ ! -f skills/learned/index.json ] || [ "$(cat skills/learned/index.json)" = "{}" ]; then
    echo "[START] Seeding skill library..."
    node skills/seeds.js
fi

# Start agent if --agent flag
if [[ "$*" == *"--agent"* ]]; then
    TURNS="${TURNS:-30}"
    echo "[START] Starting agent (${TURNS} turns)..."
    CAPTURE_FLAG=""
    [[ "$*" == *"--capture"* ]] && CAPTURE_FLAG="--capture"
    node agent.js --turns "$TURNS" $CAPTURE_FLAG 2>&1 | tee /tmp/minecraft-agent.log
fi

echo "[START] Done"
