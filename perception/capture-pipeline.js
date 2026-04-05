#!/usr/bin/env node
'use strict';
/**
 * perception/capture-pipeline.js — Phase 1 paired data capture.
 *
 * Runs a bot with prismarine-viewer (renders 3D view in browser),
 * captures screenshots paired with Mineflayer ground truth state.
 *
 * Usage:
 *   node perception/capture-pipeline.js [--turns 100] [--interval 2]
 *
 * Output: data/captures/frame_XXXXX.jpg + state_XXXXX.json
 */

const fs = require('fs');
const path = require('path');
const { createAgent } = require('../core/bot');
const { SkillLibrary } = require('../skills/library');
const { LLMProvider, extractJSON } = require('../llm/provider');
const { ReflexTier } = require('../core/reflex');

const args = process.argv.slice(2);
const MAX_TURNS = parseInt(args.find((_, i, a) => a[i - 1] === '--turns') || '100');
const INTERVAL = parseFloat(args.find((_, i, a) => a[i - 1] === '--interval') || '3');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'captures');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`[CAPTURE] Phase 1: Paired data capture`);
  console.log(`[CAPTURE] Output: ${OUTPUT_DIR}`);
  console.log(`[CAPTURE] Turns: ${MAX_TURNS}, Interval: ${INTERVAL}s`);

  // Connect bot
  const agent = await createAgent({
    host: 'localhost',
    port: 25565,
    username: 'CaptureBot',
  });
  const bot = agent.bot;

  // Start prismarine-viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: 3000, firstPerson: true });
  console.log('[CAPTURE] Viewer at http://localhost:3000');

  // Wait for chunks + viewer to load
  await sleep(5000);

  // Start reflex tier
  const reflex = new ReflexTier(bot);
  reflex.start();

  // Set up LLM for autonomous play
  const llm = new LLMProvider({ provider: 'claude', model: 'haiku' });
  const library = new SkillLibrary();

  // Capture loop
  let frameIndex = 0;
  const metadata = {
    startTime: new Date().toISOString(),
    version: '1.20.1',
    interval: INTERVAL,
    viewerPort: 3000,
    frames: 0,
  };

  // Background capture timer
  const captureTimer = setInterval(async () => {
    try {
      const state = extractFullState(bot);
      const idx = String(frameIndex).padStart(5, '0');

      // Save state
      fs.writeFileSync(
        path.join(OUTPUT_DIR, `state_${idx}.json`),
        JSON.stringify(state, null, 2)
      );

      // Screenshot via puppeteer or screencapture
      await captureScreenshot(path.join(OUTPUT_DIR, `frame_${idx}.jpg`));

      frameIndex++;
      if (frameIndex % 10 === 0) {
        console.log(`[CAPTURE] ${frameIndex} frames captured`);
      }
    } catch (e) {
      // Don't crash on capture errors
    }
  }, INTERVAL * 1000);

  // Main agent loop (drives gameplay to generate diverse data)
  const STRATEGY_PROMPT = `You are a Minecraft bot exploring and gathering resources. Decide what to do next.
Available skills: ${library.list().map(s => s.name).join(', ')}
Actions: {"action":"skill","name":"skillName","params":{}} or {"action":"move","direction":"forward","duration":3}
Respond with ONLY JSON.`;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const state = agent.getState();
    console.log(`[TURN ${turn}/${MAX_TURNS}] HP:${state.player.health} Food:${state.player.food} ` +
      `Inv:${state.inventory.length} Entities:${state.entities.length}`);

    // Simple autonomous behavior for data diversity
    try {
      const stateStr = `Position: ${JSON.stringify(state.player.position)}
Inventory: ${state.inventory.map(i => i.name + 'x' + i.count).join(', ') || 'empty'}
Entities: ${state.entities.slice(0, 5).map(e => e.name + '(' + e.distance + 'm)').join(', ') || 'none'}
Time: ${state.world.isDay ? 'Day' : 'Night'}`;

      const response = await llm.call(STRATEGY_PROMPT, stateStr);
      const decision = extractJSON(response);

      if (decision?.action === 'skill' && decision.name) {
        const r = await library.execute(decision.name, bot, decision.params || {});
        console.log(`  [SKILL] ${decision.name}: ${r.success ? 'OK' : r.error}`);
      } else {
        // Default: explore
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await sleep(3000);
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        // Turn randomly for diversity
        const yaw = bot.entity.yaw + (Math.random() - 0.5) * Math.PI;
        await bot.look(yaw, 0);
      }
    } catch (e) {
      // Explore on error
      bot.setControlState('forward', true);
      await sleep(2000);
      bot.setControlState('forward', false);
      await bot.look(bot.entity.yaw + Math.PI / 4, 0);
    }

    await sleep(1000);
  }

  clearInterval(captureTimer);

  // Save metadata
  metadata.frames = frameIndex;
  metadata.endTime = new Date().toISOString();
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log(`\n[CAPTURE] Done. ${frameIndex} paired frames saved to ${OUTPUT_DIR}`);
  process.exit(0);
}

/**
 * Extract comprehensive game state for training data.
 * More detailed than the agent's getState() — includes everything
 * a vision model would need to predict.
 */
function extractFullState(bot) {
  const pos = bot.entity.position;

  // Detailed block grid (11x11x5 around player)
  const blocks = [];
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (block) {
          blocks.push({
            name: block.name,
            x: Math.floor(pos.x) + dx,
            y: Math.floor(pos.y) + dy,
            z: Math.floor(pos.z) + dz,
          });
        }
      }
    }
  }

  // All entities within 48 blocks
  const entities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 48)
    .map(e => ({
      type: e.type,
      name: e.displayName || e.name || e.type,
      x: +e.position.x.toFixed(1),
      y: +e.position.y.toFixed(1),
      z: +e.position.z.toFixed(1),
      distance: +e.position.distanceTo(pos).toFixed(1),
      health: e.health || null,
      hostile: isHostileMob(e.name),
    }))
    .sort((a, b) => a.distance - b.distance);

  return {
    timestamp: Date.now(),
    player: {
      x: +pos.x.toFixed(2),
      y: +pos.y.toFixed(2),
      z: +pos.z.toFixed(2),
      yaw: +bot.entity.yaw.toFixed(3),
      pitch: +bot.entity.pitch.toFixed(3),
      health: bot.health,
      food: bot.food,
      xp: bot.experience?.level || 0,
      onGround: bot.entity.onGround,
    },
    world: {
      time: bot.time.timeOfDay,
      isDay: bot.time.timeOfDay < 13000,
      raining: bot.isRaining,
      biome: bot.blockAt(pos)?.biome?.name || 'unknown',
    },
    entities,
    blocks,
    inventory: bot.inventory.items().map(i => ({
      name: i.name,
      displayName: i.displayName,
      count: i.count,
      slot: i.slot,
    })),
    equipment: {
      hand: bot.heldItem?.name || null,
      head: bot.inventory.slots[5]?.name || null,
      chest: bot.inventory.slots[6]?.name || null,
      legs: bot.inventory.slots[7]?.name || null,
      feet: bot.inventory.slots[8]?.name || null,
    },
  };
}

function isHostileMob(name) {
  const hostiles = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
    'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray',
  ]);
  return hostiles.has(name?.toLowerCase());
}

/**
 * Capture a screenshot of the prismarine-viewer via headless browser.
 */
let _browser = null;
let _page = null;

async function captureScreenshot(outputPath) {
  if (!_browser) {
    const puppeteer = require('puppeteer');
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 720 },
    });
    _page = await _browser.newPage();
    await _page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 15000 });
    // Wait for WebGL to render
    await new Promise(r => setTimeout(r, 3000));
    console.log('[CAPTURE] Headless browser connected to viewer');
  }

  await _page.screenshot({ path: outputPath, type: 'jpeg', quality: 85 });
}

main().catch(e => { console.error(e); process.exit(1); });
