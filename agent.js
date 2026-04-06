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
const MAX_TURNS = parseInt(args.find((_, i, a) => a[i-1] === '--turns') || '20');
const CAPTURE = args.includes('--capture');
const VISION_MODE = args.includes('--vision');
const VISION_ONLY = args.includes('--vision-only');

const STRATEGY_PROMPT = `You are an autonomous Minecraft agent. Analyze the current game state and decide what to do.

You have a skill library with these skills: {SKILLS}

AVAILABLE ACTIONS:
1. Use an existing skill: {"action": "skill", "name": "skillName", "params": {}}
2. Request a new skill: {"action": "learn", "goal": "natural language description of what to do"}
3. Simple movement: {"action": "move", "direction": "forward|back|left|right", "duration": 2}
4. Chat: {"action": "chat", "message": "text"}
5. Wait/observe: {"action": "wait", "duration": 3}

PRIORITIES:
1. Survive: eat if hungry (food < 15), flee if hostile mob nearby
2. ALWAYS use skills when available — prefer "skill" over "move" or "learn"
3. Crafting progression: gatherWood → craftPlanks → craftCraftingTable → craftWoodenPickaxe → mineStone
4. If stuck on movement, use "skill" with "exploreForward" or "gatherWood" (they handle navigation internally)
5. Only use "move" for fine positioning. Never spam "move" more than 2 turns in a row.
6. Use "learn" only when no existing skill covers the goal

CRAFTING CHAIN (follow this order):
- Need logs? → skill: gatherWood (params: {count: 5})
- Have logs? → skill: craftPlanks
- Have 4+ planks? → skill: craftCraftingTable
- Have crafting table + planks? → skill: craftWoodenPickaxe
- Have pickaxe? → skill: mineStone

Respond with ONLY a JSON object:
{
  "reasoning": "what you observe and why you're choosing this action",
  "action": "skill|learn|move|chat|wait",
  ... action-specific fields
}`;

async function main() {
  console.log(`[AGENT] Minecraft agent starting (${MAX_TURNS} turns)${VISION_MODE ? ' [VISION]' : ''}${VISION_ONLY ? ' [VISION-ONLY]' : ''}`);

  const agent = await createAgent({ host: HOST, port: PORT });
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

  // Chat history and stuck tracking
  const chatHistory = [];
  let lastPos = null;
  let stuckCount = 0;
  bot.on('chat', (username, message) => {
    if (username !== bot.username) {
      chatHistory.push({ from: username, message, time: Date.now() });
    }
  });

  // --- Main loop ---
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`[TURN ${turn}/${MAX_TURNS}]`);
    console.log('═'.repeat(50));

    const state = agent.getState();

    // --- Position recovery: if NaN, teleport to safety via RCON ---
    if (state._positionInvalid) {
      console.log('[RECOVER] Position is NaN — teleporting to safety');
      try {
        const { Rcon } = require('rcon-client');
        const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
        await rcon.send(`spreadplayers 0 0 0 200 false ${bot.username}`);
        await rcon.end();
        await sleep(3000);
        console.log('[RECOVER] Teleported, waiting for chunks...');
        await sleep(2000);
      } catch (e) {
        console.log('[RECOVER] RCON failed:', e.message);
      }
      continue; // skip this turn, let position stabilize
    }

    // --- Vision perception ---
    if (visionPerception && viewerPage) {
      try {
        const visionState = await visionPerception.perceiveLive(viewerPage);
        const visionEntities = visionState.entities || [];

        if (VISION_ONLY) {
          // Replace API entities with vision-only detections
          state.entities = visionEntities;
          state._visionOnly = true;
        } else {
          // Merge: annotate API entities with vision confirmation
          for (const apiEnt of state.entities) {
            const match = visionEntities.find(v => v.name === apiEnt.name);
            if (match) {
              apiEnt._visionConfirmed = true;
              apiEnt._visionConfidence = match.confidence;
              apiEnt._visionBbox = match.bbox;
            }
          }
          // Add vision-only detections (entities YOLO sees but API missed)
          for (const vEnt of visionEntities) {
            const alreadyInAPI = state.entities.find(a => a.name === vEnt.name);
            if (!alreadyInAPI) {
              state.entities.push({
                ...vEnt,
                _visionOnly: true,
              });
            }
          }
          state._visionActive = true;
        }

        // --- Audio-vision fusion: use sounds to confirm/boost visual detections ---
        const audioThreats = audioCapture.getThreatEvents(3000);
        if (audioThreats.length > 0) {
          // Map audio threats to expected entity names
          const audioMobMap = {
            zombie: 'Zombie', skeleton: 'Skeleton', creeper: 'Creeper',
            spider: 'Spider', enderman: 'Enderman', witch: 'Witch',
            slime: 'Slime', phantom: 'Phantom',
          };

          for (const threat of audioThreats) {
            const expectedName = audioMobMap[threat.threatInfo?.mob];
            if (!expectedName) continue;

            // Find matching visual detection
            const visualMatch = state.entities.find(e =>
              e.name === expectedName && e._visionConfidence
            );
            if (visualMatch) {
              // Boost confidence when both vision and audio agree
              visualMatch._audioConfirmed = true;
              visualMatch._audioDirection = threat.direction;
              visualMatch._boostedConfidence = Math.min(0.99, (visualMatch._visionConfidence || 0.5) + 0.2);
            } else {
              // Audio detected something vision didn't see (off-screen)
              state.entities.push({
                name: expectedName,
                distance: threat.distance,
                hostile: true,
                _audioOnly: true,
                _audioDirection: threat.direction,
                _audioUrgency: threat.threatInfo?.urgency,
              });
            }
          }
        }

        console.log(`[VISION] Detected ${visionEntities.length} entities: ${visionEntities.map(e => `${e.name}(${e.confidence})`).join(', ') || 'none'}`);
      } catch (err) {
        console.log(`[VISION] Error: ${err.message.slice(0, 80)}`);
      }
    }

    console.log(`[STATE] HP:${state.player.health}/20 Food:${state.player.food}/20 ` +
      `Pos:(${state.player.position.x},${state.player.position.y},${state.player.position.z}) ` +
      `${state.world.isDay ? 'Day' : 'NIGHT'} ${state.world.weather}`);
    console.log(`[STATE] Entities:${state.entities.length} Inv:${state.inventory.length} items`);

    // --- Reflex tier (immediate, no LLM) ---
    const reflex = checkReflexes(state, bot);
    if (reflex) {
      console.log(`[REFLEX] ${reflex.action}: ${reflex.reason}`);
      await executeReflex(reflex, bot);
      continue;
    }

    // --- Stuck detection ---
    if (!lastPos) lastPos = state.player.position;
    const moved = Math.abs(state.player.position.x - lastPos.x) + Math.abs(state.player.position.z - lastPos.z);
    if (moved < 0.5) stuckCount++;
    else stuckCount = 0;
    lastPos = { ...state.player.position };
    const stuckWarning = stuckCount >= 3 ? `\nWARNING: You have been STUCK for ${stuckCount} turns. Try a different direction or learn a movement skill.` : '';

    // --- Strategy tier (LLM decision) ---
    const skillList = library.list().map(s => `${s.name}${s.failCount > 0 ? ' (BROKEN)' : ''}: ${s.description}`).join('\n  ');
    const prompt = STRATEGY_PROMPT.replace('{SKILLS}', skillList || 'none');

    const stateStr = `GAME STATE:
Position: (${state.player.position.x}, ${state.player.position.y}, ${state.player.position.z})
Health: ${state.player.health}/20, Food: ${state.player.food}/20
Time: ${state.world.isDay ? 'Day' : 'Night'}, Weather: ${state.world.weather}
Inventory: ${state.inventory.map(i => `${i.name}x${i.count}`).join(', ') || 'empty'}
Equipment: ${JSON.stringify(state.equipment)}
Nearby entities: ${state.entities.slice(0, 8).map(e => {
  let desc = `${e.name}(${e.distance}m${e.hostile ? ',HOSTILE' : ''}`;
  if (e._visionConfirmed) desc += `,vis:${e._visionConfidence}`;
  if (e._audioConfirmed) desc += `,audio+vis:${e._boostedConfidence}`;
  if (e._visionOnly) desc += `,vision-only:${e.confidence || '?'}`;
  if (e._audioOnly) desc += `,audio-only:${e._audioDirection}`;
  return desc + ')';
}).join(', ') || 'none'}
Nearby blocks: ${summarizeBlocks(state.nearbyBlocks)}
${chatHistory.length > 0 ? 'Recent chat: ' + chatHistory.slice(-3).map(c => `${c.from}: ${c.message}`).join(' | ') : ''}${stuckWarning}
${(() => {
  const audioSummary = audioCapture.getSummary(10000);
  if (audioSummary.threatCount > 0) {
    const threatDescs = Object.entries(audioSummary.threats)
      .map(([mob, info]) => `${mob}(${info.direction},${info.closest}m,${info.urgency})`)
      .join(', ');
    return `Audio threats: ${threatDescs}`;
  }
  return audioSummary.totalSounds > 0 ? `Ambient sounds: ${audioSummary.totalSounds} in last 10s` : '';
})()}`;

    console.log('[THINK] Asking LLM...');
    try {
      const response = await llm.call(prompt, stateStr);
      const decision = extractJSON(response);

      if (!decision) {
        console.log('[THINK] Failed to parse LLM response');
        continue;
      }

      console.log(`[THINK] ${decision.reasoning?.slice(0, 100)}`);
      console.log(`[ACTION] ${decision.action}: ${JSON.stringify(decision).slice(0, 150)}`);

      await executeAction(decision, bot, agent, writer, library);
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }

    await sleep(1000);
  }

  console.log('\n[AGENT] Session complete.');
  process.exit(0);
}

// --- Reflex tier ---
function checkReflexes(state, bot) {
  // Hostile mob within 5 blocks
  const nearHostile = state.entities.find(e => e.hostile && e.distance < 5);
  if (nearHostile) {
    return { action: 'flee', reason: `${nearHostile.name} at ${nearHostile.distance}m`, entity: nearHostile };
  }

  // Low food
  if (state.player.food < 10) {
    const food = state.inventory.find(i =>
      ['bread', 'cooked_beef', 'cooked_porkchop', 'apple', 'cooked_chicken',
       'baked_potato', 'cooked_mutton', 'cooked_salmon', 'cooked_cod'].includes(i.name)
    );
    if (food) {
      return { action: 'eat', reason: `Food: ${state.player.food}/20`, food };
    }
  }

  return null;
}

async function executeReflex(reflex, bot) {
  switch (reflex.action) {
    case 'flee': {
      // Sprint away from hostile
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      await sleep(3000);
      bot.setControlState('sprint', false);
      bot.setControlState('forward', false);
      break;
    }
    case 'eat': {
      const item = bot.inventory.items().find(i => i.name === reflex.food.name);
      if (item) {
        await bot.equip(item, 'hand');
        await bot.consume();
      }
      break;
    }
  }
}

// --- Action execution ---
async function executeAction(decision, bot, agent, writer, library) {
  switch (decision.action) {
    case 'skill': {
      const result = await library.execute(decision.name, bot, decision.params || {});
      console.log(`[SKILL] ${decision.name}: ${result.success ? 'OK' : 'FAIL — ' + result.error}`);
      break;
    }
    case 'learn': {
      const state = agent.getState();
      const result = await writer.writeAndVerify(decision.goal, bot, {
        inventory: state.inventory,
        position: state.player.position,
        nearbyBlocks: state.nearbyBlocks,
      });
      console.log(`[LEARN] ${result.success ? 'Stored: ' + result.skill?.name : 'Failed: ' + result.error}`);
      break;
    }
    case 'move': {
      const dir = decision.direction || 'forward';
      // If LLM says a cardinal direction, convert to yaw + forward
      const yawMap = { north: Math.PI, south: 0, east: -Math.PI/2, west: Math.PI/2 };
      if (yawMap[dir] !== undefined) {
        await bot.look(yawMap[dir], 0);
        bot.setControlState('forward', true);
      } else {
        bot.setControlState(dir, true);
      }
      if (decision.jump) bot.setControlState('jump', true);
      bot.setControlState('sprint', true);
      await sleep((decision.duration || 3) * 1000);
      // Clear all controls
      for (const c of ['forward','back','left','right','jump','sprint','sneak']) {
        bot.setControlState(c, false);
      }
      break;
    }
    case 'chat': {
      bot.chat(decision.message || 'Hello!');
      break;
    }
    case 'wait': {
      await sleep((decision.duration || 3) * 1000);
      break;
    }
    default:
      console.log(`[ACTION] Unknown action: ${decision.action}`);
  }
}

function summarizeBlocks(blocks) {
  const types = {};
  for (const b of blocks || []) types[b.name] = (types[b.name] || 0) + 1;
  return Object.entries(types).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
