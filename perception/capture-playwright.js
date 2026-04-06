#!/usr/bin/env node
'use strict';
/**
 * perception/capture-playwright.js — Reliable entity-rich data capture.
 *
 * Uses Playwright (not Puppeteer) for WebGL headless rendering.
 * Bot in creative mode, RCON summons entities, captures paired frame+state.
 * Relocates periodically for biome diversity, cycles time of day.
 *
 * Usage: node perception/capture-playwright.js [--frames 500] [--port 3002]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '500');
const VIEWER_PORT = parseInt(args.find((_, i, a) => a[i-1] === '--port') || '3002');
const AGENT_ID = process.env.CAPTURE_AGENT_ID || '0';
const BOT_NAME = `Cap${AGENT_ID}_${Math.random().toString(36).slice(2, 5)}`;
const OUTPUT = path.join(__dirname, '..', 'data', 'entity_captures');
fs.mkdirSync(OUTPUT, { recursive: true });

const MOBS = ['zombie','skeleton','creeper','spider','slime','enderman',
              'witch','cow','pig','sheep','chicken','villager'];
const TIMES = [0, 6000, 12000, 18000];
const TIME_NAMES = ['dawn', 'noon', 'dusk', 'midnight'];

function isHostile(n) {
  return ['zombie','skeleton','creeper','spider','slime','enderman',
    'witch','phantom','drowned','husk','stray','cave_spider'].includes(n?.toLowerCase());
}

async function main() {
  console.log(`[CAPTURE] Target: ${TARGET} frames, viewer port: ${VIEWER_PORT}`);

  // Connect bot
  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: BOT_NAME,
    checkTimeoutInterval: 60000,
  });
  bot.on('error', e => console.log('[BOT ERR]', e.message));
  bot.on('kicked', r => { console.log('[KICKED]', r); process.exit(1); });
  await new Promise(r => bot.once('spawn', r));
  await sleep(2000);

  // Audio capture
  const { AudioCapture } = require('./audio-capture');
  const audio = new AudioCapture(bot);
  audio.start();

  // RCON
  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
  await rcon.send(`gamemode creative ${BOT_NAME}`);
  await sleep(500);

  // Initial teleport
  await rcon.send(`spreadplayers 0 0 0 500 false ${BOT_NAME}`);
  await sleep(3000);
  for (let i = 0; i < 20; i++) { await sleep(300); if (bot.entity.onGround) break; }

  // Start viewer
  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: VIEWER_PORT, firstPerson: true });
  await sleep(3000);

  // Launch Playwright
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(`http://localhost:${VIEWER_PORT}`, { waitUntil: 'networkidle', timeout: 15000 });
  await sleep(5000);
  console.log('[READY] Playwright + viewer connected');

  // Use agent-specific prefix for frame naming (avoids collisions in multi-agent mode)
  const PREFIX = `a${AGENT_ID}_`;
  let frameIdx = 0;
  const existing = fs.readdirSync(OUTPUT).filter(f => f.startsWith(`${PREFIX}frame_`) && f.endsWith('.jpg'));
  if (existing.length > 0) {
    frameIdx = existing.length;
    console.log(`[RESUME] Agent ${AGENT_ID} starting from frame ${frameIdx}`);
  }

  let timeIdx = 0;
  const biomes = new Set(), ents = new Set(), blocks = new Set();

  while (frameIdx < TARGET) {
    // --- Relocate every 40 frames ---
    if (frameIdx % 40 === 0) {
      const rx = Math.floor(Math.random() * 6000 - 3000);
      const rz = Math.floor(Math.random() * 6000 - 3000);
      try { await rcon.send(`spreadplayers ${rx} ${rz} 0 500 false ${BOT_NAME}`); } catch {}
      await sleep(3000);
      for (let i = 0; i < 15; i++) { await sleep(300); if (bot.entity.onGround) break; }

      // Cycle time
      timeIdx = (timeIdx + 1) % TIMES.length;
      try { await rcon.send(`time set ${TIMES[timeIdx]}`); } catch {}

      // Summon diverse mobs
      const pos = bot.entity.position;
      for (let i = 0; i < 8; i++) {
        const mob = MOBS[Math.floor(Math.random() * MOBS.length)];
        const dx = 3 + Math.floor(Math.random() * 15) * (Math.random() < 0.5 ? 1 : -1);
        const dz = 3 + Math.floor(Math.random() * 15) * (Math.random() < 0.5 ? 1 : -1);
        try { await rcon.send(`summon ${mob} ${Math.floor(pos.x)+dx} ${Math.floor(pos.y)+1} ${Math.floor(pos.z)+dz}`); } catch {}
      }
      await sleep(2000);

      // Reload page after teleport
      try { await page.reload({ waitUntil: 'networkidle', timeout: 10000 }); } catch {}
      await sleep(3000);

      console.log(`[LOC] Moved to (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.z)}) time=${TIME_NAMES[timeIdx]}`);
    }

    // --- Vary look direction ---
    const pos = bot.entity.position;
    const nearbyEnts = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 25)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));

    if (nearbyEnts.length > 0 && Math.random() < 0.7) {
      const target = nearbyEnts[Math.floor(Math.random() * Math.min(nearbyEnts.length, 3))];
      await bot.lookAt(target.position.offset(0, target.height || 1, 0));
    } else {
      const angle = (frameIdx * 0.6 + Math.random() * 0.5) % (Math.PI * 2);
      const pitch = (Math.random() - 0.3) * 0.5;
      await bot.look(angle, pitch);
    }
    await sleep(300);

    // --- Screenshot ---
    const idx = String(frameIdx).padStart(5, '0');
    try {
      await page.screenshot({
        path: path.join(OUTPUT, `${PREFIX}frame_${idx}.jpg`),
        type: 'jpeg', quality: 85,
      });
    } catch (e) {
      console.log(`[SCREENSHOT FAIL] ${e.message.slice(0, 60)}`);
      // Try reload
      try {
        await page.reload({ waitUntil: 'networkidle', timeout: 10000 });
        await sleep(3000);
        await page.screenshot({
          path: path.join(OUTPUT, `${PREFIX}frame_${idx}.jpg`),
          type: 'jpeg', quality: 85,
        });
      } catch { continue; }
    }

    // --- State extraction ---
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
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -5; dz <= 5; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air') { blks.add(b.name); blocks.add(b.name); }
        }

    // Audio events from last 2 seconds (paired with this frame)
    const audioEvents = audio.getRecentEvents(2000);
    const audioSummary = audio.getSummary(5000);

    fs.writeFileSync(path.join(OUTPUT, `${PREFIX}state_${idx}.json`), JSON.stringify({
      timestamp: Date.now(), frameIdx,
      player: {
        x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
        yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
        health: bot.health, food: bot.food, onGround: bot.entity.onGround,
      },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000, biome: 'unknown' },
      entities, blockTypes: [...blks],
      audio: {
        recentEvents: audioEvents.map(e => ({
          name: e.name, classification: e.classification,
          distance: e.distance, direction: e.direction,
          volume: e.volume, urgency: e.threatInfo?.urgency,
        })),
        summary: audioSummary,
      },
    }));

    frameIdx++;

    // Occasionally sprint for position diversity
    if (frameIdx % 5 === 0) {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await sleep(800);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
    }

    // Progress
    if (frameIdx % 25 === 0) {
      console.log(`[${frameIdx}/${TARGET}] ents=${ents.size} blocks=${blocks.size} nearby=${entities.length}`);
    }
  }

  // Clean up summoned entities
  try { await rcon.send('kill @e[type=!player,distance=..200]'); } catch {}

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT, `${PREFIX}metadata.json`), JSON.stringify({
    frames: frameIdx, entityTypes: [...ents].sort(), blockTypes: [...blocks].sort(),
    captureMethod: 'playwright',
    audioEvents: audio.events.length,
    uniqueSounds: [...new Set(audio.events.map(e => e.name))].sort(),
  }, null, 2));

  // Save full audio log
  audio.saveEvents(path.join(OUTPUT, `${PREFIX}audio_log.json`));

  console.log(`\n=== DONE: ${frameIdx} frames, ${ents.size} entity types, ${blocks.size} block types ===`);
  await browser.close();
  try { await rcon.end(); } catch {}
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
