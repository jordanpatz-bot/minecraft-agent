#!/usr/bin/env node
'use strict';
/**
 * Parallel multi-bot capture across different regions.
 * Each bot heads in a different direction for biome diversity.
 * No pathfinder — pure sprint + jump for reliability.
 */
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOTAL_PER_BOT = parseInt(process.argv[2] || '100');
const NUM_BOTS = parseInt(process.argv[3] || '4');
const BASE_PORT = 3001;
const OUTPUT_BASE = path.join(__dirname, '..', 'data', 'captures');

const DIRECTIONS = [
  { yaw: 0, label: 'south', dx: 0, dz: 1 },
  { yaw: Math.PI, label: 'north', dx: 0, dz: -1 },
  { yaw: -Math.PI/2, label: 'east', dx: 1, dz: 0 },
  { yaw: Math.PI/2, label: 'west', dx: -1, dz: 0 },
];

async function runBot(botIdx) {
  const dir = DIRECTIONS[botIdx % DIRECTIONS.length];
  const outDir = path.join(OUTPUT_BASE, dir.label);
  fs.mkdirSync(outDir, { recursive: true });

  const username = `Cap_${dir.label}`;
  const viewerPort = BASE_PORT + botIdx;

  console.log(`[${username}] Starting → ${dir.label} (viewer :${viewerPort})`);

  const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username });
  await new Promise(r => bot.once('spawn', r));
  console.log(`[${username}] Spawned at ${bot.entity.position.toString()}`);

  // Start viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  try {
    viewer(bot, { port: viewerPort, firstPerson: true });
  } catch(e) {
    console.log(`[${username}] Viewer failed: ${e.message}`);
  }

  // Headless browser
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${viewerPort}`, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(3000);
  } catch(e) {
    console.log(`[${username}] Browser connect failed:`, e.message);
  }

  let frameIdx = 0;
  let hostileTotal = 0;

  for (let i = 0; i < TOTAL_PER_BOT; i++) {
    const pos = bot.entity.position;
    const idx = String(frameIdx).padStart(5, '0');

    // Capture state
    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 48)
      .map(e => ({
        type: e.type, name: e.displayName || e.name || e.type,
        x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
        distance: +e.position.distanceTo(pos).toFixed(1),
        hostile: isHostile(e.name),
      }));

    const blocks = [];
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air')
            blocks.push({ name: b.name, x: Math.floor(pos.x)+dx, y: Math.floor(pos.y)+dy, z: Math.floor(pos.z)+dz });
        }

    const state = {
      timestamp: Date.now(),
      direction: dir.label,
      player: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
                yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
                health: bot.health, food: bot.food, onGround: bot.entity.onGround },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000,
               raining: bot.isRaining, biome: bot.blockAt(pos)?.biome?.name || 'unknown' },
      entities, blocks,
      inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    };

    hostileTotal += entities.filter(e => e.hostile).length;

    fs.writeFileSync(path.join(outDir, `state_${idx}.json`), JSON.stringify(state));
    try {
      await page.screenshot({ path: path.join(outDir, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
    } catch {}

    frameIdx++;

    // Sprint in our direction (no pathfinder, just raw movement)
    await bot.look(dir.yaw + (Math.random() - 0.5) * 0.3, (Math.random() - 0.3) * 0.3);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    await sleep(2000);
    bot.setControlState('jump', false);
    await sleep(1000);
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);

    // Random look for visual diversity (30% of frames)
    if (Math.random() < 0.3) {
      await bot.look(dir.yaw + (Math.random() - 0.5) * Math.PI, (Math.random() - 0.5) * 0.6);
      await sleep(300);
      // Bonus capture with different angle
      const bidx = String(frameIdx).padStart(5, '0');
      fs.writeFileSync(path.join(outDir, `state_${bidx}.json`), JSON.stringify({...state, timestamp: Date.now()}));
      try { await page.screenshot({ path: path.join(outDir, `frame_${bidx}.jpg`), type: 'jpeg', quality: 85 }); } catch {}
      frameIdx++;
    }

    if (frameIdx % 25 === 0) {
      console.log(`[${username}] ${frameIdx} frames, pos=(${pos.x.toFixed(0)},${pos.z.toFixed(0)}) hostile=${hostileTotal}`);
    }

    // Respawn if dead
    if (bot.health <= 0) {
      console.log(`[${username}] Died! Waiting for respawn...`);
      await sleep(5000);
      // Bot auto-respawns in mineflayer
    }
  }

  console.log(`[${username}] Done: ${frameIdx} frames, ${hostileTotal} hostile entities`);
  await browser.close();
  return { direction: dir.label, frames: frameIdx, hostile: hostileTotal };
}

function isHostile(name) {
  return ['zombie','skeleton','creeper','spider','enderman','witch','slime',
    'phantom','drowned','husk','stray','cave_spider','pillager','vindicator'
  ].includes(name?.toLowerCase());
}

async function main() {
  console.log(`=== PARALLEL CAPTURE: ${NUM_BOTS} bots × ${TOTAL_PER_BOT} frames ===\n`);

  const promises = [];
  for (let i = 0; i < NUM_BOTS; i++) {
    promises.push(runBot(i));
    await sleep(2000); // stagger spawns
  }

  const results = await Promise.all(promises);

  console.log('\n=== RESULTS ===');
  let totalFrames = 0, totalHostile = 0;
  for (const r of results) {
    console.log(`  ${r.direction}: ${r.frames} frames, ${r.hostile} hostile`);
    totalFrames += r.frames;
    totalHostile += r.hostile;
  }
  console.log(`  TOTAL: ${totalFrames} frames, ${totalHostile} hostile entities`);
}

main().catch(e => { console.error(e); process.exit(1); });
