#!/usr/bin/env node
'use strict';
/**
 * Capture paired data while bot explores randomly.
 * No LLM — just pathfinder + random exploration for speed and diversity.
 */
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const pf = require('mineflayer-pathfinder');
const { GoalNear } = pf.goals;

const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'captures');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'Explorer' });
  bot.loadPlugin(pf.pathfinder);

  await new Promise(r => bot.once('spawn', r));
  console.log('Spawned at', bot.entity.position.toString());

  const movements = new pf.Movements(bot);
  movements.canDig = true;
  movements.allowParkour = true;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 15000;

  // Start viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: 3000, firstPerson: true });
  console.log('Viewer at http://localhost:3000');

  // Start headless browser for screenshots
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(3000);
  console.log('Browser connected');

  let frameIdx = 0;
  const mcData = require('minecraft-data')(bot.version);

  // Capture function
  async function capture() {
    const idx = String(frameIdx).padStart(5, '0');
    const pos = bot.entity.position;

    // State
    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 48)
      .map(e => ({
        type: e.type, name: e.displayName || e.name || e.type,
        x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
        distance: +e.position.distanceTo(pos).toFixed(1),
        hostile: ['zombie','skeleton','creeper','spider'].includes(e.name?.toLowerCase()),
      }));

    const blocks = [];
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -5; dz <= 5; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air') blocks.push({ name: b.name, x: Math.floor(pos.x)+dx, y: Math.floor(pos.y)+dy, z: Math.floor(pos.z)+dz });
        }

    const state = {
      timestamp: Date.now(),
      player: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
                yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
                health: bot.health, food: bot.food, onGround: bot.entity.onGround },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000, raining: bot.isRaining,
               biome: bot.blockAt(pos)?.biome?.name || 'unknown' },
      entities, blocks,
      inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot })),
    };

    fs.writeFileSync(path.join(OUTPUT_DIR, `state_${idx}.json`), JSON.stringify(state));
    await page.screenshot({ path: path.join(OUTPUT_DIR, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
    frameIdx++;
  }

  // Explore + capture loop
  const TOTAL_FRAMES = 200;
  console.log(`Capturing ${TOTAL_FRAMES} frames while exploring...`);

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Capture current view
    await capture();

    // Random exploration: pick a random nearby point and navigate
    const pos = bot.entity.position;
    const dx = (Math.random() - 0.5) * 30;
    const dz = (Math.random() - 0.5) * 30;
    const targetX = pos.x + dx;
    const targetZ = pos.z + dz;

    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(targetX, pos.y, targetZ, 2)),
        sleep(8000),
      ]);
    } catch {
      // On pathfinder fail, just sprint forward + random turn
      const yaw = Math.random() * Math.PI * 2;
      await bot.look(yaw, 0);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      await sleep(2000);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
    }

    // Random look direction for visual diversity
    if (Math.random() < 0.3) {
      await bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI * 0.6);
    }

    if (frameIdx % 20 === 0) {
      console.log(`  ${frameIdx}/${TOTAL_FRAMES} frames (pos: ${pos.x.toFixed(0)},${pos.z.toFixed(0)})`);
    }
  }

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT_DIR, 'metadata.json'), JSON.stringify({
    startTime: new Date().toISOString(), frames: frameIdx, type: 'random_exploration',
  }, null, 2));

  console.log(`Done! ${frameIdx} frames captured.`);
  await browser.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
