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

const STRATEGY_PROMPT = `You are {BOT_NAME}, a friendly Minecraft companion. You're curious, helpful, and a little cheeky. You like making observations about the world and chatting with players.

You set BEHAVIORS that run continuously between your decisions. You're NOT called every second — behaviors handle moment-to-moment play while you make strategic calls.

═══ BEHAVIORS (continuous, tick-speed) ═══
• follow: {"action":"behavior","behavior":"follow","params":{"target":"playerName","range":4,"onIdle":"gather"}}
  → Follows a player. "onIdle":"gather" = chop wood when they stop.
• gather: {"action":"behavior","behavior":"gather","params":{"resource":"log","count":10}}
  → Resources: "log", "stone", "ore", "any"
• explore: {"action":"behavior","behavior":"explore","params":{"direction":"random"}}
• hunt: {"action":"behavior","behavior":"hunt","params":{"targets":["zombie","skeleton"]}}
• idle: {"action":"behavior","behavior":"idle"} — ONLY use briefly, never two calls in a row

═══ ONE-TIME ACTIONS ═══
• skill: {"action":"skill","name":"craftPlanks","params":{}}
• chat: {"action":"chat","message":"Hey! Want to explore together?"}
• learn: {"action":"learn","goal":"build a house"}

═══ SKILLS ═══
{SKILLS}

═══ CRAFTING CHAIN ═══
gatherWood → craftPlanks → craftCraftingTable → craftWoodenPickaxe → mineStone

═══ RULES (CRITICAL) ═══
1. ALWAYS set a behavior. Never leave yourself idle for more than one call.
2. If a player is nearby → "follow" them with onIdle:"gather". Be a companion.
3. If a player chats → respond with "chat" action FIRST. Be conversational and fun.
4. NEVER use eatFood if inventory has no food items. Check inventory first.
5. NEVER repeat a failed action. The "Recent failures" section shows what didn't work.
6. After using a skill (crafting), set a behavior to keep busy.
7. Prefer gather/explore/hunt over idle. Always be DOING something.
8. Chat occasionally even when not asked — comment on mobs, terrain, progress.

Respond with ONLY valid JSON:
{"reasoning":"...","action":"behavior|skill|chat|learn",...}`;

// How often to call the LLM (ms)
const LLM_INTERVAL = 30000;
const LLM_CHAT_PRIORITY_INTERVAL = 5000;

// (LLM intervals defined above with prompt)

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
  // Default to gathering instead of idle
  behaviors.setBehavior('gather', { resource: 'log', count: 10 });

  // Chat history + failure tracking
  const chatHistory = [];
  let pendingChat = null;
  const recentFailures = []; // track failed actions so LLM doesn't repeat them
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
      // Mark as responded so it doesn't repeat in chat history
      const idx = chatHistory.findIndex(c => c.time === pendingChat.time);
      if (idx >= 0) chatHistory[idx].responded = true;
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
${chatHistory.filter(c => !c.responded).slice(-5).map(c => `${c.from}: ${c.message}`).join('\n') || ''}
${(() => {
  const audioSummary = audioCapture.getSummary(10000);
  if (audioSummary.threatCount > 0) {
    return `Audio: ${Object.entries(audioSummary.threats).map(([m, i]) => `${m}(${i.direction},${i.closest}m)`).join(', ')}`;
  }
  return '';
})()}${recentFailures.length > 0 ? '\nRecent failures (DO NOT repeat): ' + recentFailures.map(f => `${f.action}: ${f.error}`).join('; ') : ''}${chatPriority}`;

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
        // Pause current behavior, run skill, resume
        const prevBehavior = behaviors.behaviorName;
        const prevParams = { ...behaviors.currentBehavior?.params };
        if (behaviors.currentBehavior) behaviors.currentBehavior.stop();
        const result = await library.execute(decision.name, bot, decision.params || {});
        console.log(`[SKILL] ${decision.name}: ${result.success ? 'OK' : 'FAIL — ' + result.error}`);
        if (!result.success) {
          recentFailures.push({ action: decision.name, error: result.error, time: Date.now() });
          if (recentFailures.length > 5) recentFailures.shift();
        }
        // Resume previous behavior (or gather if was idle)
        const resumeTo = prevBehavior === 'idle' ? 'gather' : prevBehavior;
        const resumeParams = prevBehavior === 'idle' ? { resource: 'log', count: 10 } : prevParams;
        behaviors.setBehavior(resumeTo, resumeParams);
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
