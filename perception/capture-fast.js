#!/usr/bin/env node
'use strict';
/**
 * perception/capture-fast.js — Fast, reliable entity capture.
 *
 * Simpler approach: bot spawns, RCON summons entities nearby,
 * captures frames in a tight loop, relocates periodically.
 * No gameplay actions — just screenshot + state as fast as possible.
 *
 * Usage: node perception/capture-fast.js [--frames 500]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '500');
const OUTPUT = path.join(__dirname, '..', 'data', 'entity_captures');
fs.mkdirSync(OUTPUT, { recursive: true });

const MOBS = ['zombie','skeleton','creeper','spider','slime','enderman',
              'witch','cow','pig','sheep','chicken','villager'];
const TIMES = [0, 6000, 12000, 18000];

function isHostile(n) {
  return ['zombie','skeleton','creeper','spider','slime','enderman',
    'witch','phantom','drowned','husk','stray','cave_spider'].includes(n?.toLowerCase());
}

async function main() {
  console.log(`[FAST CAPTURE] Target: ${TARGET} frames`);

  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'CapBot',
    checkTimeoutInterval: 60000,
  });
  bot.on('error', e => console.log('[BOT ERR]', e.message));
  bot.on('kicked', r => { console.log('[KICKED]', r); process.exit(1); });
  await new Promise(r => bot.once('spawn', r));
  await sleep(2000);

  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
  await rcon.send('gamemode creative CapBot');
  await sleep(500);

  // Teleport to surface
  await rcon.send('spreadplayers 0 0 0 500 false CapBot');
  await sleep(3000);

  // Start viewer on port 3002
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: 3002, firstPerson: true });

  // Launch puppeteer
  const puppeteer = require('puppeteer');
  let browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    defaultViewport: { width: 1280, height: 720 },
  });
  let page = await browser.newPage();
  await page.goto('http://localhost:3002', { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(3000);
  console.log('[READY]');

  let frameIdx = 0;
  let timeIdx = 0;
  const biomes = new Set(), ents = new Set(), blocks = new Set();

  // Check existing frames to continue from where we left off
  const existing = fs.readdirSync(OUTPUT).filter(f => f.startsWith('frame_') && f.endsWith('.jpg'));
  if (existing.length > 0) {
    frameIdx = existing.length;
    console.log(`[RESUME] Starting from frame ${frameIdx}`);
  }

  while (frameIdx < TARGET) {
    // Relocate every 30 frames
    if (frameIdx % 30 === 0) {
      const rx = Math.floor(Math.random() * 6000 - 3000);
      const rz = Math.floor(Math.random() * 6000 - 3000);
      try {
        await rcon.send(`spreadplayers ${rx} ${rz} 0 500 false CapBot`);
      } catch (e) {
        console.log('[RCON ERR]', e.message);
        // Reconnect RCON
        try { await rcon.end(); } catch {}
        try {
          const { Rcon: R } = require('rcon-client');
          const newRcon = await R.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
          Object.assign(rcon, newRcon);
        } catch {}
      }
      await sleep(3000);

      // Cycle time of day
      timeIdx = (timeIdx + 1) % TIMES.length;
      try { await rcon.send(`time set ${TIMES[timeIdx]}`); } catch {}

      // Summon diverse mobs nearby
      const pos = bot.entity.position;
      for (let i = 0; i < 6; i++) {
        const mob = MOBS[Math.floor(Math.random() * MOBS.length)];
        const dx = 3 + Math.floor(Math.random() * 12);
        const dz = -6 + Math.floor(Math.random() * 12);
        try { await rcon.send(`summon ${mob} ${Math.floor(pos.x)+dx} ${Math.floor(pos.y)+1} ${Math.floor(pos.z)+dz}`); } catch {}
      }
      await sleep(1500);

      // Reload viewer page
      try { await page.reload({ waitUntil: 'networkidle2', timeout: 10000 }); } catch {}
      await sleep(1000);

      console.log(`[LOC] Moved to (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.z)}) time=${TIMES[timeIdx]}`);
    }

    const pos = bot.entity.position;
    const idx = String(frameIdx).padStart(5, '0');

    // Vary look direction
    const angle = (frameIdx * 0.7) % (Math.PI * 2);
    const pitch = (Math.random() - 0.3) * 0.5;

    // Sometimes look at nearest entity
    const nearEnt = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 25)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0];

    if (nearEnt && Math.random() < 0.6) {
      await bot.lookAt(nearEnt.position.offset(0, nearEnt.height || 1, 0));
    } else {
      await bot.look(angle, pitch);
    }
    await sleep(200);

    // Screenshot
    let ok = false;
    try {
      await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
      ok = true;
    } catch (e) {
      console.log(`[SCREENSHOT FAIL] Reconnecting...`);
      try {
        await browser.close();
      } catch {}
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          defaultViewport: { width: 1280, height: 720 },
        });
        page = await browser.newPage();
        await page.goto('http://localhost:3002', { waitUntil: 'networkidle2', timeout: 15000 });
        await sleep(2000);
        await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
        ok = true;
      } catch (e2) {
        console.log(`[RECONNECT FAIL] ${e2.message.slice(0, 60)}`);
        continue;
      }
    }

    if (!ok) continue;

    // State
    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 48)
      .map(e => {
        ents.add(e.displayName || e.name);
        return {
          type: e.type, name: e.displayName || e.name,
          x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
          distance: +e.position.distanceTo(pos).toFixed(1),
          hostile: isHostile(e.name),
        };
      });

    const blks = new Set();
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air') { blks.add(b.name); blocks.add(b.name); }
        }

    fs.writeFileSync(path.join(OUTPUT, `state_${idx}.json`), JSON.stringify({
      timestamp: Date.now(), frameIdx,
      player: {
        x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
        yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
        health: bot.health, food: bot.food, onGround: bot.entity.onGround,
      },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000, biome: 'unknown' },
      entities, blockTypes: [...blks],
    }));

    frameIdx++;

    // Progress
    if (frameIdx % 25 === 0) {
      console.log(`[${frameIdx}/${TARGET}] ents=${ents.size} blocks=${blocks.size}`);
    }
  }

  fs.writeFileSync(path.join(OUTPUT, 'metadata.json'), JSON.stringify({
    frames: frameIdx, entityTypes: [...ents].sort(), blockTypes: [...blocks].sort(),
  }, null, 2));

  console.log(`\n=== DONE: ${frameIdx} frames, ${ents.size} entity types, ${blocks.size} block types ===`);
  try { await rcon.end(); } catch {}
  try { await browser.close(); } catch {}
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
