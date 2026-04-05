#!/usr/bin/env node
'use strict';
/**
 * perception/capture-biomes.js — Diverse biome data capture.
 *
 * Explores in 4 cardinal directions from spawn, covering maximum terrain.
 * Captures paired frames while sprinting through the world.
 * Designed to hit forests, plains, deserts, mountains, oceans, caves.
 *
 * Usage: node perception/capture-biomes.js [--frames 500]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const pf = require('mineflayer-pathfinder');
const { GoalNear } = pf.goals;

const args = process.argv.slice(2);
const TOTAL_FRAMES = parseInt(args.find((_, i, a) => a[i - 1] === '--frames') || '500');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'captures');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`[BIOME CAPTURE] Target: ${TOTAL_FRAMES} frames`);

  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'BiomeBot',
    viewDistance: 'far',
  });
  bot.loadPlugin(pf.pathfinder);

  await new Promise(r => bot.once('spawn', r));
  const spawnPos = bot.entity.position.clone();
  console.log(`Spawned at ${spawnPos.toString()}`);

  // Setup pathfinder
  const movements = new pf.Movements(bot);
  movements.canDig = false; // don't modify terrain
  movements.allowParkour = true;
  movements.maxDropDown = 4;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 10000;

  // Start viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: 3000, firstPerson: true });
  console.log('Viewer at http://localhost:3000');

  // Headless browser for screenshots
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
  const biomesSeen = new Set();
  const mcData = require('minecraft-data')(bot.version);

  // Capture function
  async function capture() {
    const idx = String(frameIdx).padStart(5, '0');
    const pos = bot.entity.position;

    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 48)
      .map(e => ({
        type: e.type, name: e.displayName || e.name || e.type,
        x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
        distance: +e.position.distanceTo(pos).toFixed(1),
        hostile: isHostile(e.name),
      }))
      .sort((a, b) => a.distance - b.distance);

    const blocks = [];
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -5; dz <= 5; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air')
            blocks.push({ name: b.name, x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) + dz });
        }

    const biome = bot.blockAt(pos)?.biome?.name || 'unknown';
    biomesSeen.add(biome);

    const state = {
      timestamp: Date.now(),
      player: {
        x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
        yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
        health: bot.health, food: bot.food, onGround: bot.entity.onGround,
      },
      world: {
        time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000,
        raining: bot.isRaining, biome,
      },
      entities, blocks,
      inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot })),
    };

    fs.writeFileSync(path.join(OUTPUT_DIR, `state_${idx}.json`), JSON.stringify(state));
    await page.screenshot({ path: path.join(OUTPUT_DIR, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
    frameIdx++;
    return { entities: entities.length, biome, hostile: entities.filter(e => e.hostile).length };
  }

  // Exploration strategy: sprint in 4 directions, each for a stretch
  const directions = [
    { yaw: 0, label: 'South' },
    { yaw: Math.PI / 2, label: 'West' },
    { yaw: Math.PI, label: 'North' },
    { yaw: -Math.PI / 2, label: 'East' },
  ];

  let dirIdx = 0;
  let framesPerDirection = Math.ceil(TOTAL_FRAMES / directions.length);
  let totalHostile = 0;
  let totalEntities = 0;

  console.log(`\nCapturing ${TOTAL_FRAMES} frames across ${directions.length} directions...`);

  while (frameIdx < TOTAL_FRAMES) {
    const dir = directions[dirIdx % directions.length];
    console.log(`\n--- Direction: ${dir.label} (frames ${frameIdx}-${Math.min(frameIdx + framesPerDirection, TOTAL_FRAMES)}) ---`);

    for (let i = 0; i < framesPerDirection && frameIdx < TOTAL_FRAMES; i++) {
      // Capture
      const info = await capture();
      totalEntities += info.entities;
      totalHostile += info.hostile;

      // Sprint forward in the current direction
      await bot.look(dir.yaw, 0);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true); // jump over obstacles
      await sleep(1500);
      bot.setControlState('jump', false);
      await sleep(1500);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);

      // Occasional random look for visual diversity
      if (Math.random() < 0.3) {
        const lookYaw = dir.yaw + (Math.random() - 0.5) * Math.PI * 0.8;
        const lookPitch = (Math.random() - 0.3) * Math.PI * 0.4;
        await bot.look(lookYaw, lookPitch);
        await sleep(500);
        const r = await capture(); // extra frame with different angle
        totalEntities += r.entities;
        totalHostile += r.hostile;
      }

      // Health check — eat if low
      if (bot.health < 10) {
        const food = bot.inventory.items().find(i =>
          ['bread', 'apple', 'cooked_beef', 'cooked_porkchop'].includes(i.name));
        if (food) {
          try { await bot.equip(food, 'hand'); await bot.consume(); } catch {}
        }
      }

      if (frameIdx % 25 === 0) {
        const pos = bot.entity.position;
        console.log(`  [${frameIdx}/${TOTAL_FRAMES}] pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}) ` +
          `biomes=${biomesSeen.size} entities=${totalEntities} hostile=${totalHostile}`);
      }
    }

    dirIdx++;
  }

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT_DIR, 'metadata.json'), JSON.stringify({
    startTime: new Date().toISOString(),
    frames: frameIdx,
    type: 'biome_exploration',
    seed: 12345,
    biomesSeen: [...biomesSeen],
    totalEntities,
    totalHostile,
    directions: directions.map(d => d.label),
  }, null, 2));

  console.log(`\n=== CAPTURE COMPLETE ===`);
  console.log(`Frames: ${frameIdx}`);
  console.log(`Biomes seen: ${[...biomesSeen].join(', ')}`);
  console.log(`Total entities: ${totalEntities} (${totalHostile} hostile)`);

  await browser.close();
  process.exit(0);
}

function isHostile(name) {
  return ['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
    'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray',
    'cave_spider', 'pillager', 'vindicator'].includes(name?.toLowerCase());
}

main().catch(e => { console.error(e); process.exit(1); });
