# Minecraft Agent — Detailed Implementation Plan

**Thesis:** Mineflayer is training wheels. Every phase builds toward not needing it. The end state is a vision-first agent that can walk into a new game without an API bridge.

---

## Phase 0: Foundation (Week 1-2)

### 0.1 Fork & Strip Co-Voyager
- Fork [Co-Voyager](https://github.com/PalmyTech/Co-Voyager) (multi-agent Voyager variant)
- **Strip to skeleton:** Keep Mineflayer integration, skill storage, LLM interface. Discard their specific skill verification loop (40% first-attempt success rate, brittle across MC versions)
- Rebuild the verification loop: skill execution → postcondition check → retry with error context → store on success
- Directory structure: `core/` (bot lifecycle), `skills/` (library + executor), `llm/` (provider routing), `perception/` (state extraction), `vision/` (Phase 1+)

### 0.2 Local Server Setup
- Minecraft server: Paper 1.20.4 (lightweight, plugin-friendly)
- Mineflayer bot connects, verifies:
  - Block data reads (surrounding blocks, specific coordinates)
  - Entity tracking (mobs, players, items on ground)
  - Inventory reads (slots, equipped, crafting)
  - Chat send/receive
  - Movement + pathfinding (mineflayer-pathfinder)
  - **Known gap:** UI state (crafting tables, furnaces, enchanting) — Mineflayer can interact but not read arbitrary GUI state. Plan around this.
- Write integration tests for each API surface

### 0.3 LLM Routing
- Provider abstraction (same pattern as Qud's llm-provider.js):
  - Claude (Sonnet for skills, Haiku for fast decisions)
  - Ollama fallback for local/offline
- Structured output: all LLM calls return JSON with `reasoning` + `action`
- Token budget tracking per session

### 0.4 Skill Library Validation
- Acceptance test: give the agent a goal → it writes a Mineflayer JS function → executes it → verifies postcondition → stores to library
- Test goals: "mine 5 oak logs", "craft a wooden pickaxe", "navigate to coordinates (100, 64, 200)"
- Skill format:
  ```js
  {
    name: "mineOakLogs",
    description: "Mine N oak log blocks using equipped axe or bare hands",
    params: { count: "number" },
    dependencies: [],  // skills that must exist first
    code: "async function(bot, params) { ... }",
    postcondition: "bot.inventory.count('oak_log') >= params.count"
  }
  ```

### Phase 0 Exit Criteria
- [ ] Bot connects to local server, reads state, executes movement
- [ ] LLM writes a skill, bot executes it, postcondition passes, skill stored
- [ ] 5+ skills in library covering: mine, craft, navigate, place block, eat food
- [ ] All tests green

---

## Phase 1: Self-Labeling Vision Pipeline (Week 3-5)

### 1.1 Paired Data Capture
- Same architecture as Qud: capture screen frames paired with Mineflayer ground truth
- Capture module runs alongside the bot:
  ```
  Bot plays via API → every N ticks, snapshot:
    - Screenshot (client window, 1920x1080 or configured)
    - Mineflayer state dump: {
        position, yaw, pitch,
        nearbyBlocks (16-block radius, block types + positions),
        entities (type, position, health, distance),
        inventory (all slots),
        health, hunger, xp,
        timeOfDay, weather, biome
      }
  ```
- Target: 10,000+ paired frames from diverse gameplay (mining, building, combat, exploration)
- Storage: frames as JPEG (compressed), state as JSON, indexed by timestamp

### 1.2 VLM Ceiling Test (before training anything)
- Take 100 representative frames from the capture corpus
- Send each to Claude Vision with ground truth as reference
- Prompt: "Describe what you see. List all entities, estimate player inventory, identify biome and time of day."
- Score against ground truth: entity recall, block identification accuracy, inventory accuracy
- **This establishes the ceiling.** If Claude Vision gets 60% entity recall, a 0.5B model will get less. Know the limits before investing in training.

### 1.3 Perception Model (lightweight)
- **Start simple:** Don't train a full VLM. Start with task-specific classifiers:
  - Entity detector: YOLOv8-nano fine-tuned on Minecraft entities (mobs, players, items)
  - Block classifier: CNN on center-screen cross-hair region (what block am I looking at?)
  - HUD reader: OCR/template matching for health, hunger, XP bars (fixed screen positions)
  - Inventory reader: template matching on inventory slots (fixed grid, known item textures)
- Each is a small, fast model solving one perception problem
- Combined output = structured state matching Mineflayer format
- **Only after these work:** consider a unified model (FastVLM or custom)

### 1.4 Validation Loop
- Run both pipelines simultaneously: Mineflayer ground truth + vision predictions
- Per-field accuracy dashboard:
  - Entity positions: IoU threshold matching
  - Block IDs: exact match in 5x5 grid around player
  - Inventory: slot-by-slot comparison
  - Health/hunger/XP: within ±5%
- Target: 80%+ accuracy on entities, 90%+ on HUD elements before moving to Phase 2

### Phase 1 Exit Criteria
- [ ] 10,000+ paired frames captured
- [ ] VLM ceiling test completed with documented accuracy
- [ ] Entity detector running at >70% recall, <20% false positive rate
- [ ] HUD reader accurate to ±1 heart/hunger
- [ ] Validation dashboard operational

---

## Phase 2: Three-Tier Action Layer (Week 5-8)

### 2.1 Reflex Tier (sub-100ms)
- **NOT an LLM.** Hardcoded heuristics + tiny policy net:
  - Mob avoidance: if hostile entity within 5 blocks and approaching → sprint away from threat vector
  - Fall recovery: if falling → deploy water bucket or aim for water (requires inventory awareness)
  - Lava detection: if lava within 3 blocks → reverse movement
  - Low health: if health < 4 hearts → eat food from hotbar
  - Drowning: if underwater > 5s → pathfind to surface
- Implementation: event-driven hooks on Mineflayer state changes, bypasses LLM entirely
- Reflex actions override all other tiers (interrupt skill execution if danger detected)

### 2.2 Skill Tier (1-5s execution)
- Co-Voyager pattern refined:
  - Skill library: named, parameterized JS functions with dependencies and postconditions
  - Skill composer: LLM decomposes a goal into skill calls
  - Skill executor: runs skill, checks postcondition, retries with error context
  - Skill writer: LLM writes NEW skills when no existing skill matches the goal
- Key improvement over Voyager: **skill versioning and deprecation.** When a skill fails 3+ times, flag it for rewrite rather than accumulating broken variants.
- Skill categories: mining, crafting, building, combat, navigation, farming, trading

### 2.3 Strategy Tier (30s+ planning cycle)
- Runs on a slow loop: every 30-60 seconds, samples full game state
- LLM (Sonnet-class) evaluates:
  - Current objectives (explicit goals from user or self-generated)
  - Resource state (inventory, nearby resources, base state)
  - Threats (hostile mobs, low health, night approaching)
  - Progress toward objectives
- Outputs: prioritized list of sub-goals for the skill tier
- **Interface contract:** strategy emits goals like `{goal: "obtain_iron", priority: 1, params: {count: 10}}`. The skill tier maps this to skill sequences: find_iron_ore → mine_iron_ore → smelt_iron_ingots.
- Goal decomposition is explicit, not implicit: strategy layer includes a `decompose(goal) → [sub-goals]` step that maps abstract goals to known skill-level tasks

### 2.4 Tier Integration
- Priority: reflex > active skill execution > strategy planning
- Interrupt protocol: reflexes can abort running skills. Strategy waits for skill completion before issuing new goals.
- State machine: IDLE → PLANNING → EXECUTING_SKILL → REFLEX_OVERRIDE → back to appropriate state
- Logging: every tier transition logged with context for debugging

### Phase 2 Exit Criteria
- [ ] Reflex tier: survives first night without player intervention (mob avoidance + eating)
- [ ] Skill tier: can mine, craft, and build a basic shelter from scratch
- [ ] Strategy tier: given "survive and build a house," agent autonomously gathers materials, crafts tools, builds shelter
- [ ] All three tiers operate concurrently without conflicts
- [ ] Agent can play for 3 in-game days autonomously

---

## Phase 3: Social & Spectator (Week 8-12)

### 3.1 Server Setup
- Private server: Paper + whitelist, no anti-cheat plugins
- 3-5 human players (friends/testers) playing normally
- Agent joins in spectator mode first (invisible, read-only)

### 3.2 Spectator Data Collection
- Log everything in structured format:
  ```json
  {
    "timestamp": "...",
    "event": "player_chat|player_move|block_place|block_break|entity_interact",
    "actor": "player_name",
    "target": "block_type|entity|player",
    "position": [x, y, z],
    "context": "nearby_players, recent_chat, current_activity"
  }
  ```
- Chat log with speaker attribution
- Player movement patterns (where do they go, how long do they stay)
- Cooperation detection: two players working on the same structure, trading, fighting together

### 3.3 Social Graph
- Nodes: players. Edges: interaction frequency + type (chat, proximity, cooperation, conflict)
- Derived metrics: who leads, who follows, who's a loner, who's building what
- Update in real-time as events stream in

### 3.4 Social Play Graduation
- **Level 1 — Responsive:** answer when spoken to in chat. "Hey bot, got any iron?" → checks inventory, responds.
- **Level 2 — Helpful:** notice a player mining and offer to help. Bring resources to a build site.
- **Level 3 — Cooperative:** join group activities. Follow the social norms (don't steal, don't grief, share resources).
- **Level 4 — Initiative:** propose activities. "Want to raid the stronghold together?"

### Success criteria (define before building):
- A player says "help me build a house" → agent shows up with materials within 2 minutes
- Agent notices two players mining together → joins without being asked
- Agent responds appropriately to 80%+ of chat messages directed at it
- No player reports the agent as disruptive after a 1-hour session

### Phase 3 Exit Criteria
- [ ] Spectator logging captures 100+ hours of player activity
- [ ] Social graph correctly identifies player relationships from observed behavior
- [ ] Agent achieves Level 2 social play (helpful, unprompted assistance)
- [ ] 3+ human players rate the agent as "useful teammate" in post-session survey

---

## Phase 4: Vision Graduation (Week 12-16)

### 4.1 Progressive API Reduction
Specific sequence — drop the easiest-to-replace reads first:

| Step | API Read Dropped | Vision Replacement | Difficulty |
|------|------------------|--------------------|------------|
| 4.1a | Entity positions | Entity detector (YOLO) | Medium |
| 4.1b | Health/hunger/XP | HUD reader (template match) | Easy |
| 4.1c | Time of day / weather | Sky color classifier | Easy |
| 4.1d | Biome identification | Terrain color + block texture | Medium |
| 4.1e | Nearby block types | Block classifier + depth estimation | Hard |
| 4.1f | Inventory contents | Inventory slot reader (template match) | Medium |
| 4.1g | Crafting/smelting state | UI state reader | Hard |

Each step: run in parallel with API for validation, measure accuracy, only drop API when vision accuracy exceeds threshold (defined per field).

### 4.2 Vision-Only Test
- Milestone test: agent plays for 1 in-game day with ZERO Mineflayer state reads
- Actions still go through Mineflayer (keyboard/mouse simulation would be Phase 5+)
- Measure: survival time, tasks completed, error rate vs API-assisted play

### 4.3 Cross-Pollination with Qud
What transfers from Qud vision work:
- **Pipeline architecture**: capture → structured extraction → state comparison → confidence scoring
- **Calibration methodology**: phase correlation for pixel mapping, paired data for validation
- **Hybrid state merge**: vision provides what it can, API fills gaps, annotated with confidence
- **Session logging**: what worked/failed, documented for future agents

What does NOT transfer:
- Model weights (tile grid ≠ 3D perspective)
- Grid extraction (Qud has a fixed tile grid; Minecraft has perspective projection)
- Template matching (Qud entities are fixed sprites; Minecraft entities are 3D models at varying angles/distances)

### 4.4 Shared Perception Abstraction
- Define a game-agnostic perception interface:
  ```
  Perception {
    entities: [{type, position, distance, health, hostile}]
    terrain: [{type, position, traversable}]
    inventory: [{item, count, slot}]
    player: {health, hunger, position, effects}
    messages: [string]
  }
  ```
- Both Qud and Minecraft vision pipelines output this format
- Agent decision-making code works against the interface, not the game-specific implementation
- Future games: implement the perception interface, reuse the agent

### Phase 4 Exit Criteria
- [ ] Agent drops 4+ API reads and replaces with vision, maintaining >80% task completion rate
- [ ] Vision-only test: survives 1 in-game day, completes at least 1 goal
- [ ] Shared perception interface defined and implemented for both Qud and Minecraft

---

## Evaluation Framework (Continuous)

### Benchmark Tasks (scored every phase)
1. **Survival:** Survive N in-game days (1, 3, 7). Score: days survived.
2. **Resource gathering:** Mine 10 iron ore. Score: time to complete, success rate.
3. **Crafting chain:** Start with nothing, craft an iron pickaxe. Score: time, success rate.
4. **Building:** Build a 5x5x3 enclosed shelter with door. Score: completion %, structural validity.
5. **Combat:** Kill 5 zombies in a night. Score: kills, damage taken, deaths.
6. **Social:** Respond appropriately to 10 scripted chat messages. Score: human rating 1-5.
7. **Navigation:** Travel 500 blocks to a specified coordinate. Score: time, path efficiency.

### Metrics per phase
- Task completion rate (% of benchmark tasks passed)
- API dependency ratio (% of state reads from API vs vision)
- LLM token cost per in-game hour
- Mean time between deaths

---

## Infrastructure & Compute

### Development Machine
- Minecraft server + client: 8GB RAM allocated
- Mineflayer bot: Node.js, lightweight
- Vision capture + inference: Python, GPU for training (Apple Silicon MPS or cloud GPU for training phases)
- LLM: API calls (Claude/Ollama local)

### Training (Phase 1/4)
- Entity detector training: 2-4 GPU-hours on consumer hardware (YOLOv8-nano, small dataset)
- Full vision model (if attempted): cloud GPU, budget TBD based on ceiling test results
- Defer large training investments until ceiling test (Phase 1.2) justifies them

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Skill library becomes brittle across MC updates | High | Medium | Version skills, auto-deprecate on failure |
| Vision model can't match API accuracy | High | High | Keep hybrid mode as permanent option, not just transition |
| Social play perceived as botting/griefing | Medium | High | Spectator phase first, conservative social rules, human oversight |
| Mineflayer anti-cheat detection on populated servers | Medium | Medium | Own server, protocol-level client as backup |
| Scope creep in vision training | High | High | Timebox Phase 1.3 to 2 weeks, ship classifiers not a full VLM |
| LLM costs at scale | Medium | Low | Haiku for fast tier, Ollama local for development |
