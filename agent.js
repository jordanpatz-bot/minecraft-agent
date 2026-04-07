#!/usr/bin/env node
'use strict';
/**
 * agent.js — Main autonomous agent loop.
 *
 * Connects to a Minecraft server, runs a goal-oriented agent with:
 * - Reflex tier: hardcoded survival heuristics (mob flee, eat, etc.)
 * - Skill tier: LLM-written skills for composed tasks
 * - Strategy tier: periodic LLM planning for high-level goals
 *
 * Usage: node agent.js [--host HOST] [--port PORT] [--turns N] [--capture] [--vision] [--vision-only]
 */

const { createAgent } = require('./core/bot');
const { SkillWriter } = require('./skills/writer');
const { SkillLibrary } = require('./skills/library');
const { LLMProvider, extractJSON } = require('./llm/provider');
const { ReflexTier } = require('./core/reflex');

// --- Config ---
const args = process.argv.slice(2);
const HOST = args.find((_, i, a) => a[i-1] === '--host') || 'localhost';
const PORT = parseInt(args.find((_, i, a) => a[i-1] === '--port') || '25565');
const MAX_TURNS = parseInt(args.find((_, i, a) => a[i-1] === '--turns') || '50');
const BOT_USERNAME = args.find((_, i, a) => a[i-1] === '--name') || undefined;
const CAPTURE = args.includes('--capture');
const VISION_MODE = args.includes('--vision');
const VISION_ONLY = args.includes('--vision-only');

const STRATEGY_PROMPT = `You are an autonomous Minecraft agent named {BOT_NAME}. You set high-level BEHAVIORS that run continuously, not individual actions.

AVAILABLE BEHAVIORS:
1. follow — Follow a player: {"action": "behavior", "behavior": "follow", "params": {"target": "playerName", "range": 4, "onIdle": "gather"}}
2. gather — Collect resources: {"action": "behavior", "behavior": "gather", "params": {"resource": "log|stone|ore|any", "count": 10}}
3. explore — Explore terrain: {"action": "behavior", "behavior": "explore", "params": {"direction": "north|south|east|west|random"}}
4. hunt — Fight hostile mobs: {"action": "behavior", "behavior": "hunt", "params": {"targets": ["zombie","skeleton","spider"]}}
5. idle — Stand still, look around: {"action": "behavior", "behavior": "idle"}

OTHER ACTIONS (one-time, not continuous):
6. Use a skill: {"action": "skill", "name": "skillName", "params": {}}
7. Chat to players: {"action": "chat", "message": "text"}
8. Learn a new skill: {"action": "learn", "goal": "description"}

SKILLS AVAILABLE: {SKILLS}

CRAFTING PROGRESSION: gatherWood → craftPlanks → craftCraftingTable → craftWoodenPickaxe → mineStone

HOW BEHAVIORS WORK:
- Behaviors run CONTINUOUSLY at tick speed without your involvement
- You only get called when: a player chats, situation changes, behavior completes, or timer fires
- Set a behavior and it keeps running until you change it
- "follow" with "onIdle": "gather" means follow the player but gather wood when they stop moving
- Use "skill" for one-time crafting actions, then go back to a behavior

PRIORITIES:
1. If a player talks to you, ALWAYS respond with a chat action first, then set behavior
2. Survival is handled automatically (flee, eat) — don't worry about it
3. When near players, prefer "follow" behavior
4. When alone, prefer "gather" or "explore"

Respond with ONLY a JSON object:
{
  "reasoning": "brief situation assessment",
  "action": "behavior|skill|chat|learn",
  ... action-specific fields
}`;

// How often to call the LLM (ms) — behaviors run between calls
const LLM_INTERVAL = 30000; // 30 seconds
const LLM_CHAT_PRIORITY_INTERVAL = 5000; // 5s if player chatted

async function main() {
  console.log(`[AGENT] Minecraft agent starting (${MAX_TURNS} turns)${VISION_MODE ? ' [VISION]' : ''}${VISION_ONLY ? ' [VISION-ONLY]' : ''}`);

  const agent = await createAgent({ host: HOST, port: PORT, ...(BOT_USERNAME ? { username: BOT_USERNAME } : {}) });
  const bot = agent.bot;
  const llm = new LLMProvider({ provider: 'claude', model: 'haiku' });
  const library = new SkillLibrary();
  const writer = new SkillWriter({ llm, library, maxRetries: 2 });

  // Optional: start capture
  if (CAPTURE) {
    const { StateCapture } = require('./perception/state-capture');
    const capture = new StateCapture(agent);
    capture.start(3.0);
    process.on('exit', () => capture.stop());
  }

  // --- Vision setup ---
  let visionPerception = null;
  let viewerPage = null;
  let viewerBrowser = null;

  if (VISION_MODE || VISION_ONLY) {
    const { VisionPerception } = require('./perception/vision-perception');
    visionPerception = new VisionPerception();

    // Start prismarine-viewer
    const { mineflayer: viewer } = require('prismarine-viewer');
    viewer(bot, { port: 3003, firstPerson: true });
    await sleep(2000);

    // Launch headless browser (Playwright for WebGL support)
    const { chromium } = require('playwright');
    viewerBrowser = await chromium.launch({
      headless: true,
      args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    });
    const viewerContext = await viewerBrowser.newContext({ viewport: { width: 1280, height: 720 } });
    viewerPage = await viewerContext.newPage();
    await viewerPage.goto('http://localhost:3003', { waitUntil: 'networkidle', timeout: 15000 });
    await sleep(5000);
    console.log('[VISION] Viewer + Playwright ready');

    process.on('exit', async () => {
      try { await viewerBrowser.close(); } catch {}
    });
  }

  // --- Audio capture ---
  const { AudioCapture } = require('./perception/audio-capture');
  const audioCapture = new AudioCapture(bot);
  audioCapture.start();

  // Wait for chunks
  await sleep(3000);

  // Start reflex tier (tick-level survival heuristics, with audio)
  const reflex = new ReflexTier(bot, { audioCapture });
  reflex.start();

  // Start behavior engine
  const { BehaviorEngine } = require('./core/behaviors');
  const behaviors = new BehaviorEngine(bot);
  behaviors.start();

  // Chat history
  const chatHistory = [];
  let pendingChat = null;
  bot.on('chat', (username, message) => {
    if (username !== bot.username) {
      chatHistory.push({ from: username, message, time: Date.now() });
      pendingChat = { from: username, message, time: Date.now() };
      console.log(`[CHAT] ${username}: ${message}`);
    }
  });

  // --- Event-driven main loop ---
  // LLM gets called on: chat, behavior change needed, timer
  let llmCallCount = 0;
  let lastLLMCall = 0;
  const maxCalls = MAX_TURNS;
  const sessionStart = Date.now();
  const maxSessionMs = maxCalls * LLM_INTERVAL * 2; // rough session limit

  async function callLLM(reason) {
    if (llmCallCount >= maxCalls) return;
    llmCallCount++;
    lastLLMCall = Date.now();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`[STRATEGY ${llmCallCount}/${maxCalls}] Reason: ${reason}`);
    console.log('═'.repeat(50));

    const state = agent.getState();

    // Position recovery
    if (state._positionInvalid) {
      console.log('[RECOVER] Position is NaN — teleporting');
      try {
        const { Rcon } = require('rcon-client');
        const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
        await rcon.send(`spreadplayers 0 0 0 200 false ${bot.username}`);
        await rcon.end();
      } catch {}
      await sleep(3000);
      return;
    }

    const behaviorStatus = behaviors.getStatus();
    console.log(`[STATE] HP:${state.player.health}/20 Food:${state.player.food}/20 ` +
      `${state.world.isDay ? 'Day' : 'NIGHT'} | Behavior: ${behaviorStatus.description}`);
    console.log(`[STATE] Entities:${state.entities.length} Inv:${state.inventory.length} items`);

    // Build chat priority
    let chatPriority = '';
    if (pendingChat && Date.now() - pendingChat.time < 30000) {
      chatPriority = `\nIMPORTANT — ${pendingChat.from} just said: "${pendingChat.message}"\nRespond via chat action FIRST, then set a behavior. Be friendly and conversational.`;
      pendingChat = null;
    }

    const skillList = library.list().map(s => `${s.name}: ${s.description}`).join('\n  ');
    const prompt = STRATEGY_PROMPT
      .replace('{SKILLS}', skillList || 'none')
      .replace('{BOT_NAME}', bot.username);

    const stateStr = `GAME STATE:
Position: (${state.player.position.x}, ${state.player.position.y}, ${state.player.position.z})
Health: ${state.player.health}/20, Food: ${state.player.food}/20
Time: ${state.world.isDay ? 'Day' : 'Night'}, Weather: ${state.world.weather}
Current behavior: ${behaviorStatus.description} (running ${behaviorStatus.runningFor}s)
Inventory: ${state.inventory.map(i => `${i.name}x${i.count}`).join(', ') || 'empty'}
Equipment: ${JSON.stringify(state.equipment)}
Nearby players: ${state.entities.filter(e => e.type === 'player').map(e => `${e.username || e.name}(${e.distance}m)`).join(', ') || 'none'}
Nearby mobs: ${state.entities.filter(e => e.type !== 'player').slice(0, 6).map(e => `${e.name}(${e.distance}m${e.hostile ? ',HOSTILE' : ''})`).join(', ') || 'none'}
Nearby blocks: ${summarizeBlocks(state.nearbyBlocks)}
${chatHistory.slice(-5).map(c => `${c.from}: ${c.message}`).join('\n') || ''}
${(() => {
  const audioSummary = audioCapture.getSummary(10000);
  if (audioSummary.threatCount > 0) {
    return `Audio: ${Object.entries(audioSummary.threats).map(([m, i]) => `${m}(${i.direction},${i.closest}m)`).join(', ')}`;
  }
  return '';
})()}${chatPriority}`;

    console.log('[THINK] Asking LLM...');
    try {
      const response = await llm.call(prompt, stateStr);
      const decision = extractJSON(response);
      if (!decision) { console.log('[THINK] Failed to parse'); return; }

      console.log(`[THINK] ${decision.reasoning?.slice(0, 120)}`);

      // Execute the decision
      if (decision.action === 'behavior') {
        behaviors.setBehavior(decision.behavior, decision.params || {});
      } else if (decision.action === 'chat') {
        bot.chat(decision.message || 'Hello!');
        console.log(`[CHAT OUT] ${decision.message}`);
      } else if (decision.action === 'skill') {
        // Pause behavior, run skill, resume
        const prevBehavior = behaviors.behaviorName;
        const prevParams = behaviors.currentBehavior?.params || {};
        behaviors.setBehavior('idle');
        const result = await library.execute(decision.name, bot, decision.params || {});
        console.log(`[SKILL] ${decision.name}: ${result.success ? 'OK' : 'FAIL — ' + result.error}`);
        // Resume previous behavior
        behaviors.setBehavior(prevBehavior, prevParams);
      } else if (decision.action === 'learn') {
        behaviors.setBehavior('idle');
        const state = agent.getState();
        const result = await writer.writeAndVerify(decision.goal, bot, {
          inventory: state.inventory, position: state.player.position, nearbyBlocks: state.nearbyBlocks,
        });
        console.log(`[LEARN] ${result.success ? 'Stored: ' + result.skill?.name : 'Failed: ' + result.error}`);
      }
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }
  }

  // --- Main event loop ---
  console.log('[AGENT] Behavior engine running. LLM called on events.');

  // Initial LLM call to set first behavior
  await callLLM('session_start');

  // Event loop: check periodically if LLM needs to be called
  const eventLoop = setInterval(async () => {
    const now = Date.now();

    // Stop condition
    if (llmCallCount >= maxCalls || now - sessionStart > maxSessionMs) {
      clearInterval(eventLoop);
      behaviors.stop();
      reflex.stop();
      console.log(`\n[AGENT] Session complete. ${llmCallCount} LLM calls.`);
      process.exit(0);
    }

    // Call LLM if: player chatted
    if (pendingChat && now - lastLLMCall > LLM_CHAT_PRIORITY_INTERVAL) {
      await callLLM('player_chat');
      return;
    }

    // Call LLM if: behavior completed/failed
    if (behaviors.needsReplan() && now - lastLLMCall > 5000) {
      await callLLM('behavior_completed');
      return;
    }

    // Call LLM on timer
    if (now - lastLLMCall > LLM_INTERVAL) {
      await callLLM('timer');
    }
  }, 2000); // check every 2 seconds

  // Keep process alive
  await new Promise(() => {});
}

// (Old checkReflexes, executeReflex, executeAction removed —
//  handled by ReflexTier class and BehaviorEngine)

function summarizeBlocks(blocks) {
  const types = {};
  for (const b of blocks || []) types[b.name] = (types[b.name] || 0) + 1;
  return Object.entries(types).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
