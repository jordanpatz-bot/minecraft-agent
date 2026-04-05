# Minecraft Agent

Vision-first Minecraft agent. Mineflayer is training wheels — every phase builds toward not needing it.

See [PLAN.md](PLAN.md) for the detailed 4-phase implementation plan.

## Quick Start

### Prerequisites
```bash
# Java 17+ (required for Paper server)
brew install openjdk@17

# Node.js 18+
node --version  # verify

# Project dependencies
cd minecraft-agent
npm install
```

### Download Paper Server
```bash
mkdir -p server && cd server
# Download Paper 1.20.1 from https://papermc.io/downloads/paper
# Place the jar in the server/ directory
# First run:
java -jar paper-1.20.1.jar --nogui
# Accept EULA: edit eula.txt, set eula=true
# Configure server.properties: online-mode=false, gamemode=creative
# Restart server
```

### Test Connection
```bash
# With server running:
node core/test-connection.js localhost 25565
```

## Architecture

```
core/       — Bot lifecycle, state extraction, Mineflayer wrapper
skills/     — Skill library: storage, retrieval, execution, LLM-written skills
llm/        — LLM provider abstraction (Claude API, Ollama)
perception/ — State extraction from Mineflayer API (Phase 0-2)
vision/     — Computer vision pipeline (Phase 1+)
data/       — Captured frames + ground truth pairs
server/     — Local Paper server (gitignored)
```

## Phase Status
- [x] Phase 0.1: Project scaffolded, Mineflayer installed
- [ ] Phase 0.2: Paper server running, bot connects
- [ ] Phase 0.3: LLM routing
- [ ] Phase 0.4: Skill library validation
