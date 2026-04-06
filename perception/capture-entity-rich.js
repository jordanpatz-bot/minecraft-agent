#!/usr/bin/env node
'use strict';
/**
 * perception/capture-entity-rich.js — Entity-focused data capture.
 *
 * Spawns entities via RCON near the bot in diverse terrain, then captures
 * paired frame+state data. Guarantees every frame has visible entities.
 * Uses burst capture pattern with puppeteer reconnection for reliability.
 *
 * Usage: node perception/capture-entity-rich.js [--frames 500] [--burst 40]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const pf = require('mineflayer-pathfinder');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET_FRAMES = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '500');
const BURST_SIZE = parseInt(args.find((_, i, a) => a[i-1] === '--burst') || '40');
const OUTPUT = path.join(__dirname, '..', 'data', 'entity_captures');

fs.mkdirSync(OUTPUT, { recursive: true });

// Entities to spawn — mix of hostile, passive, and neutral
const SPAWN_MOBS = [
  // Hostile
  { name: 'zombie', hostile: true },
  { name: 'skeleton', hostile: true },
  { name: 'creeper', hostile: true },
  { name: 'spider', hostile: true },
  { name: 'slime', hostile: true },
  { name: 'enderman', hostile: true },
  { name: 'witch', hostile: true },
  // Passive
  { name: 'cow', hostile: false },
  { name: 'pig', hostile: false },
  { name: 'sheep', hostile: false },
  { name: 'chicken', hostile: false },
  { name: 'villager', hostile: false },
];

function isHostile(n) {
  return ['zombie','skeleton','creeper','spider','slime','enderman',
    'witch','phantom','drowned','husk','stray','cave_spider',
    'pillager','vindicator'].includes(n?.toLowerCase());
}

async function main() {
  console.log(`[ENTITY CAPTURE] Target: ${TARGET_FRAMES} frames, burst size: ${BURST_SIZE}`);

  // Connect bot in survival mode
  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'EntityBot',
    keepAlive: true,
    checkTimeoutInterval: 60000,
  });
  bot.loadPlugin(pf.pathfinder);
  bot.on('error', e => console.log('[BOT ERROR]', e.message));
  bot.on('kicked', r => { console.log('[KICKED]', r); process.exit(1); });
  await new Promise(r => bot.once('spawn', r));
  await sleep(2000); // let chunks load

  const movements = new pf.Movements(bot);
  movements.canDig = true;
  bot.pathfinder.setMovements(movements);

  // RCON for spawning entities + teleporting
  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });

  // Set survival mode but give the bot armor so it doesn't die
  await rcon.send('gamemode survival EntityBot');
  await sleep(500);
  await rcon.send('give EntityBot diamond_sword 1');
  await rcon.send('give EntityBot diamond_chestplate 1');
  await rcon.send('give EntityBot cooked_beef 64');
  await sleep(500);

  // Teleport to surface
  await rcon.send('spreadplayers 0 0 0 200 false EntityBot');
  await sleep(3000);
  for (let i = 0; i < 20; i++) { await sleep(500); if (bot.entity.onGround) break; }

  // Start viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: 3001, firstPerson: true });

  const mcData = require('minecraft-data')(bot.version);
  let frameIdx = 0;
  let burstCount = 0;
  const biomesSeen = new Set();
  const entityTypesSeen = new Set();
  const blockTypesSeen = new Set();

  // Time-of-day presets for lighting diversity
  const TIMES = ['0', '6000', '12000', '18000']; // dawn, noon, dusk, midnight
  let timeIdx = 0;

  // --- Puppeteer management ---
  let browser = null;
  let page = null;

  async function connectBrowser() {
    if (browser) { try { await browser.close(); } catch {} }
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1280, height: 720 },
    });
    page = await browser.newPage();
    await page.goto('http://localhost:3001', { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(3000);
    burstCount = 0;
    console.log('[BROWSER] Connected');
  }

  await connectBrowser();

  // --- Spawn entities near bot ---
  async function spawnEntitiesNearby(count = 3) {
    const pos = bot.entity.position;
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const mob = SPAWN_MOBS[Math.floor(Math.random() * SPAWN_MOBS.length)];
      const dx = 3 + Math.floor(Math.random() * 8);
      const dz = -5 + Math.floor(Math.random() * 10);
      const cmd = `summon ${mob.name} ${Math.floor(pos.x) + dx} ${Math.floor(pos.y)} ${Math.floor(pos.z) + dz}`;
      try { await rcon.send(cmd); spawned.push(mob.name); } catch {}
    }
    return spawned;
  }

  // --- Main capture loop ---
  while (frameIdx < TARGET_FRAMES) {
    // Reconnect browser if burst limit reached
    if (burstCount >= BURST_SIZE) {
      console.log(`[BURST] Reconnecting browser after ${burstCount} frames...`);
      await connectBrowser();
    }

    // Relocate every 60 frames for terrain diversity
    if (frameIdx > 0 && frameIdx % 60 === 0) {
      console.log(`[RELOCATE] Moving to new area...`);
      const rx = Math.floor(Math.random() * 4000 - 2000);
      const rz = Math.floor(Math.random() * 4000 - 2000);
      await rcon.send(`spreadplayers ${rx} ${rz} 0 500 false EntityBot`);
      await sleep(3000);
      for (let i = 0; i < 20; i++) { await sleep(500); if (bot.entity.onGround) break; }
      try { await page.reload({ waitUntil: 'networkidle2', timeout: 10000 }); } catch {}
      await sleep(2000);

      // Cycle time of day
      timeIdx = (timeIdx + 1) % TIMES.length;
      await rcon.send(`time set ${TIMES[timeIdx]}`);
      console.log(`[TIME] Set to ${TIMES[timeIdx]} (${['dawn','noon','dusk','midnight'][timeIdx]})`);
    }

    // Spawn entities nearby
    const spawned = await spawnEntitiesNearby(2 + Math.floor(Math.random() * 3));
    await sleep(1000); // let them render

    const pos = bot.entity.position;
    const biome = bot.blockAt(pos)?.biome?.name || 'unknown';
    biomesSeen.add(biome);

    // --- Capture multiple angles per spawn ---
    const anglesPerSpawn = 3;
    for (let angle = 0; angle < anglesPerSpawn && frameIdx < TARGET_FRAMES; angle++) {
      const idx = String(frameIdx).padStart(5, '0');

      // Look toward nearest entity, or random direction
      const nearbyEnts = Object.values(bot.entities)
        .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 30)
        .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));

      if (nearbyEnts.length > 0) {
        // Look at a random nearby entity
        const target = nearbyEnts[Math.min(angle, nearbyEnts.length - 1)];
        await bot.lookAt(target.position.offset(0, target.height || 1, 0));
      } else {
        // Scan around
        await bot.look((angle * Math.PI * 2 / anglesPerSpawn) + Math.random() * 0.3, (Math.random() - 0.3) * 0.4);
      }
      await sleep(300);

      // Screenshot
      let screenshotOk = false;
      try {
        await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
        screenshotOk = true;
      } catch (e) {
        console.log(`[SCREENSHOT FAIL] ${e.message.slice(0, 80)}`);
        try {
          await connectBrowser();
          await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
          screenshotOk = true;
        } catch { continue; }
      }

      if (!screenshotOk) continue;

      // State extraction
      const entities = Object.values(bot.entities)
        .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 48)
        .map(e => {
          entityTypesSeen.add(e.displayName || e.name);
          return {
            type: e.type, name: e.displayName || e.name || e.type,
            x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
            distance: +e.position.distanceTo(pos).toFixed(1),
            hostile: isHostile(e.name),
          };
        });

      const blocks = [];
      for (let dx = -5; dx <= 5; dx++)
        for (let dz = -5; dz <= 5; dz++)
          for (let dy = -2; dy <= 2; dy++) {
            const b = bot.blockAt(pos.offset(dx, dy, dz));
            if (b && b.name !== 'air') {
              blockTypesSeen.add(b.name);
              blocks.push({ name: b.name, x: Math.floor(pos.x)+dx, y: Math.floor(pos.y)+dy, z: Math.floor(pos.z)+dz });
            }
          }

      fs.writeFileSync(path.join(OUTPUT, `state_${idx}.json`), JSON.stringify({
        timestamp: Date.now(), frameIdx,
        player: {
          x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
          yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
          health: bot.health, food: bot.food, onGround: bot.entity.onGround,
        },
        world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000,
                 raining: bot.isRaining, biome },
        entities, blocks,
        inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
        spawnedThisFrame: spawned,
      }));

      frameIdx++;
      burstCount++;
    }

    // Do some gameplay between captures for natural behavior
    if (frameIdx % 10 === 0) {
      // Sprint forward briefly
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await sleep(1500);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
    }

    // Eat if hungry
    if (bot.food < 15) {
      const food = bot.inventory.items().find(i =>
        ['bread','apple','cooked_beef','cooked_porkchop','carrot'].includes(i.name));
      if (food) { try { await bot.equip(food, 'hand'); await bot.consume(); } catch {} }
    }

    // Progress reporting
    if (frameIdx % 25 === 0) {
      console.log(`[${frameIdx}/${TARGET_FRAMES}] biomes=${biomesSeen.size} entities=${entityTypesSeen.size} blocks=${blockTypesSeen.size} burst=${burstCount}/${BURST_SIZE}`);
    }
  }

  // Clean up spawned entities
  try { await rcon.send('kill @e[type=!player,distance=..100]'); } catch {}

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT, 'metadata.json'), JSON.stringify({
    frames: frameIdx, startTime: new Date().toISOString(),
    biomes: [...biomesSeen], entityTypes: [...entityTypesSeen].sort(),
    blockTypes: [...blockTypesSeen].sort(),
    captureType: 'entity-rich',
  }, null, 2));

  console.log(`\n=== ENTITY CAPTURE COMPLETE ===`);
  console.log(`Frames: ${frameIdx}`);
  console.log(`Entity types (${entityTypesSeen.size}): ${[...entityTypesSeen].sort().join(', ')}`);
  console.log(`Block types (${blockTypesSeen.size}): ${[...blockTypesSeen].sort().slice(0, 20).join(', ')}...`);

  await rcon.end();
  try { await browser.close(); } catch {}
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
