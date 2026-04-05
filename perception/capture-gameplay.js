#!/usr/bin/env node
'use strict';
/**
 * perception/capture-gameplay.js — Capture frames during real gameplay.
 *
 * Spawns bot, teleports to surface via RCON, then plays autonomously
 * (gather wood, craft, explore) while capturing paired frame+state data.
 * Periodically teleports to new locations for biome diversity.
 *
 * Usage: node perception/capture-gameplay.js [--frames 1000] [--relocate 200]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const pf = require('mineflayer-pathfinder');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET_FRAMES = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '1000');
const RELOCATE_EVERY = parseInt(args.find((_, i, a) => a[i-1] === '--relocate') || '150');
const OUTPUT = path.join(__dirname, '..', 'data', 'gameplay_captures');

fs.mkdirSync(OUTPUT, { recursive: true });

function isHostile(n) {
  return ['zombie','skeleton','creeper','spider','slime','enderman',
    'witch','phantom','drowned','husk','stray','cave_spider',
    'pillager','vindicator'].includes(n?.toLowerCase());
}

async function main() {
  console.log(`[GAMEPLAY CAPTURE] Target: ${TARGET_FRAMES} frames, relocate every ${RELOCATE_EVERY}`);

  // Connect bot
  const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'GameBot' });
  bot.loadPlugin(pf.pathfinder);
  await new Promise(r => bot.once('spawn', r));

  // Setup pathfinder
  const movements = new pf.Movements(bot);
  movements.canDig = true;
  movements.allowParkour = true;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 10000;

  // RCON for teleporting
  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });

  // Teleport to surface
  await teleportToSurface(rcon, bot);

  // Start viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: 3000, firstPerson: true });

  // Headless browser
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(3000);
  console.log('[CAPTURE] Ready');

  const mcData = require('minecraft-data')(bot.version);
  let frameIdx = 0;
  const biomesSeen = new Set();
  const entityTypesSeen = new Set();
  const blockTypesSeen = new Set();

  // --- Main capture + gameplay loop ---
  while (frameIdx < TARGET_FRAMES) {
    // Relocate periodically for biome diversity
    if (frameIdx > 0 && frameIdx % RELOCATE_EVERY === 0) {
      console.log(`[RELOCATE] Teleporting to new area...`);
      const spreadDist = 200 + Math.floor(Math.random() * 800);
      await rcon.send(`spreadplayers ${Math.floor(Math.random()*2000-1000)} ${Math.floor(Math.random()*2000-1000)} 0 ${spreadDist} false GameBot`);
      await sleep(3000);
      for(let i=0;i<20;i++){await sleep(500);if(bot.entity.onGround)break;}
      // Reconnect viewer page after teleport
      try { await page.reload({ waitUntil: 'networkidle2', timeout: 10000 }); } catch {}
      await sleep(2000);
    }

    const pos = bot.entity.position;
    const biome = bot.blockAt(pos)?.biome?.name || 'unknown';
    biomesSeen.add(biome);

    // --- Capture frame + state ---
    const idx = String(frameIdx).padStart(5, '0');

    // Vary camera angle for visual diversity
    const gamePhase = Math.floor(frameIdx / 50) % 4; // cycle through behaviors
    let yaw, pitch;
    switch (gamePhase) {
      case 0: // look ahead (exploring)
        yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.5;
        pitch = 0.1 + Math.random() * 0.2;
        break;
      case 1: // look around (scanning)
        yaw = (frameIdx * 0.7) % (Math.PI * 2);
        pitch = (Math.random() - 0.3) * 0.4;
        break;
      case 2: // look down (mining/building)
        yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.3;
        pitch = 0.4 + Math.random() * 0.3;
        break;
      case 3: // look at entity if nearby
        const nearEnt = Object.values(bot.entities)
          .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 20)
          [0];
        if (nearEnt) {
          await bot.lookAt(nearEnt.position.offset(0, 1, 0));
        } else {
          yaw = (frameIdx * 0.5) % (Math.PI * 2);
          pitch = 0;
        }
        break;
    }
    if (yaw !== undefined) await bot.look(yaw, pitch);
    await sleep(200);

    // Screenshot
    try {
      await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
    } catch {
      // Reconnect on failure
      try {
        await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 10000 });
        await sleep(2000);
        await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
      } catch { continue; }
    }

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
    }));
    frameIdx++;

    // --- Gameplay actions (diverse behaviors for training data) ---
    const action = gamePhase;
    switch (action) {
      case 0: // Explore: sprint forward
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        if (Math.random() < 0.3) bot.setControlState('jump', true);
        await sleep(2000);
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', false);
        break;

      case 1: // Gather: find and mine a log or stone
        const logBlock = bot.findBlock({
          matching: b => b.name.includes('log') || b.name.includes('stone'),
          maxDistance: 16,
        });
        if (logBlock) {
          try {
            await Promise.race([
              bot.pathfinder.goto(new pf.goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 1)),
              sleep(8000),
            ]);
            await bot.dig(logBlock);
            await sleep(500);
          } catch {}
        } else {
          // Sprint to find resources
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
          await sleep(3000);
          bot.setControlState('forward', false);
          bot.setControlState('sprint', false);
        }
        break;

      case 2: // Craft: try crafting if we have materials
        const logs = bot.inventory.items().filter(i => i.name.includes('log'));
        if (logs.length > 0) {
          try {
            // Craft planks
            const log = logs[0];
            const plankName = log.name.replace('_log', '_planks');
            const planksItem = mcData.itemsByName[plankName];
            if (planksItem) {
              const recipe = bot.recipesFor(planksItem.id)[0];
              if (recipe) await bot.craft(recipe, 1, null);
            }
          } catch {}
        }
        // Also sprint for diversity
        bot.setControlState('forward', true);
        await sleep(1500);
        bot.setControlState('forward', false);
        break;

      case 3: // Fight/interact with nearby entities
        const hostile = Object.values(bot.entities)
          .filter(e => e !== bot.entity && isHostile(e.name) && e.position.distanceTo(pos) < 10)
          [0];
        if (hostile) {
          try {
            await bot.pathfinder.goto(new pf.goals.GoalNear(hostile.position.x, hostile.position.y, hostile.position.z, 2));
            bot.attack(hostile);
          } catch {}
        }
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await sleep(2000);
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        break;
    }

    // Eat if hungry
    if (bot.food < 15) {
      const food = bot.inventory.items().find(i =>
        ['bread','apple','cooked_beef','cooked_porkchop','carrot','potato','melon_slice'].includes(i.name));
      if (food) { try { await bot.equip(food, 'hand'); await bot.consume(); } catch {} }
    }

    // Progress reporting
    if (frameIdx % 50 === 0) {
      console.log(`[${frameIdx}/${TARGET_FRAMES}] biomes=${biomesSeen.size} entities=${entityTypesSeen.size} blocks=${blockTypesSeen.size} pos=(${pos.x.toFixed(0)},${pos.z.toFixed(0)}) inv=${bot.inventory.items().length}`);
    }
  }

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT, 'metadata.json'), JSON.stringify({
    frames: frameIdx, startTime: new Date().toISOString(),
    biomes: [...biomesSeen], entityTypes: [...entityTypesSeen],
    blockTypes: [...blockTypesSeen].sort(),
  }, null, 2));

  console.log(`\n=== CAPTURE COMPLETE ===`);
  console.log(`Frames: ${frameIdx}`);
  console.log(`Biomes (${biomesSeen.size}): ${[...biomesSeen].join(', ')}`);
  console.log(`Entity types (${entityTypesSeen.size}): ${[...entityTypesSeen].sort().join(', ')}`);
  console.log(`Block types (${blockTypesSeen.size}): ${[...blockTypesSeen].sort().slice(0, 20).join(', ')}...`);

  await rcon.end();
  await browser.close();
  process.exit(0);
}

async function teleportToSurface(rcon, bot) {
  // Use spreadplayers to find safe surface position
  await rcon.send('spreadplayers 0 0 0 200 false ' + bot.username);
  await sleep(3000);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (bot.entity.onGround) break;
  }
  console.log(`[SURFACE] ${bot.username} at ${bot.entity.position.toString()} ground=${bot.entity.onGround}`);
}

main().catch(e => { console.error(e); process.exit(1); });
