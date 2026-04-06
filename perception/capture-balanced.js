#!/usr/bin/env node
'use strict';
/**
 * perception/capture-balanced.js — Balanced per-class entity capture.
 *
 * Spawns ONE entity type at a time in controlled quantities, captures
 * frames, then clears and moves to the next type. Ensures equal
 * representation across all entity classes.
 *
 * For labeling: since we control what's spawned, we can force the
 * class label rather than relying on the (biased) detector model.
 * The detector is only used for bounding box localization.
 *
 * Usage: node perception/capture-balanced.js [--per-class 60] [--port 3002]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const FRAMES_PER_CLASS = parseInt(args.find((_, i, a) => a[i-1] === '--per-class') || '60');
const VIEWER_PORT = parseInt(args.find((_, i, a) => a[i-1] === '--port') || '3002');
const OUTPUT = path.join(__dirname, '..', 'data', 'balanced_captures');
fs.mkdirSync(OUTPUT, { recursive: true });

// All 15 entity classes we want to train on
const ENTITY_CLASSES = [
  { name: 'zombie', classId: 0, summonCmd: 'zombie' },
  { name: 'skeleton', classId: 1, summonCmd: 'skeleton' },
  { name: 'creeper', classId: 2, summonCmd: 'creeper' },
  { name: 'spider', classId: 3, summonCmd: 'spider' },
  { name: 'slime', classId: 4, summonCmd: 'slime' },
  { name: 'enderman', classId: 5, summonCmd: 'enderman' },
  { name: 'witch', classId: 6, summonCmd: 'witch' },
  { name: 'cow', classId: 7, summonCmd: 'cow' },
  { name: 'pig', classId: 8, summonCmd: 'pig' },
  { name: 'sheep', classId: 9, summonCmd: 'sheep' },
  { name: 'chicken', classId: 10, summonCmd: 'chicken' },
  { name: 'squid', classId: 11, summonCmd: 'squid' },
  // Cod needs water — handle specially
  { name: 'cod', classId: 12, summonCmd: 'cod', needsWater: true },
  // Items are dropped by killing mobs — skip for now
  // { name: 'item', classId: 13, summonCmd: null },
  { name: 'villager', classId: 14, summonCmd: 'villager' },
];

const TIMES = [0, 6000, 12000, 18000];
const TIME_NAMES = ['dawn', 'noon', 'dusk', 'midnight'];

function isHostile(n) {
  return ['zombie','skeleton','creeper','spider','slime','enderman',
    'witch','phantom','drowned','husk','stray','cave_spider'].includes(n?.toLowerCase());
}

async function main() {
  const totalFrames = FRAMES_PER_CLASS * ENTITY_CLASSES.length;
  console.log(`[BALANCED] ${ENTITY_CLASSES.length} classes × ${FRAMES_PER_CLASS} frames = ${totalFrames} total`);

  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'BalBot',
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

  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
  await rcon.send('gamemode creative BalBot');
  await sleep(500);

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
  console.log('[READY]');

  let globalIdx = 0;
  let timeIdx = 0;

  for (const entityClass of ENTITY_CLASSES) {
    console.log(`\n=== CLASS: ${entityClass.name} (${FRAMES_PER_CLASS} frames) ===`);

    // Skip water entities for now (need special handling)
    if (entityClass.needsWater) {
      console.log(`  [SKIP] ${entityClass.name} needs water — skipping`);
      continue;
    }

    // Relocate to fresh terrain
    const rx = Math.floor(Math.random() * 4000 - 2000);
    const rz = Math.floor(Math.random() * 4000 - 2000);
    await rcon.send(`spreadplayers ${rx} ${rz} 0 500 false BalBot`);
    await sleep(3000);
    for (let i = 0; i < 15; i++) { await sleep(300); if (bot.entity.onGround) break; }

    // Cycle time for visual diversity
    timeIdx = (timeIdx + 1) % TIMES.length;
    await rcon.send(`time set ${TIMES[timeIdx]}`);

    // Reload viewer
    try { await page.reload({ waitUntil: 'networkidle', timeout: 10000 }); } catch {}
    await sleep(3000);

    // Kill existing mobs to start clean
    await rcon.send('kill @e[type=!player,distance=..100]');
    await sleep(1000);

    let classFrames = 0;
    while (classFrames < FRAMES_PER_CLASS) {
      const pos = bot.entity.position;

      // Spawn 3-5 of this entity type at various distances
      const spawnCount = 3 + Math.floor(Math.random() * 3);
      for (let s = 0; s < spawnCount; s++) {
        const dx = (3 + Math.floor(Math.random() * 10)) * (Math.random() < 0.5 ? 1 : -1);
        const dz = (3 + Math.floor(Math.random() * 10)) * (Math.random() < 0.5 ? 1 : -1);
        const spawnPos = `${Math.floor(pos.x)+dx} ${Math.floor(pos.y)+1} ${Math.floor(pos.z)+dz}`;
        try { await rcon.send(`summon ${entityClass.summonCmd} ${spawnPos}`); } catch {}
      }
      await sleep(1500); // let them render

      // Capture 5 frames from different angles per spawn group
      for (let angle = 0; angle < 5 && classFrames < FRAMES_PER_CLASS; angle++) {
        // Look toward spawned entities
        const nearbyEnts = Object.values(bot.entities)
          .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 30)
          .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));

        if (nearbyEnts.length > 0) {
          const target = nearbyEnts[Math.min(angle, nearbyEnts.length - 1)];
          await bot.lookAt(target.position.offset(0, target.height || 1, 0));
        } else {
          await bot.look((angle * Math.PI * 2 / 5) + Math.random() * 0.3, (Math.random() - 0.3) * 0.4);
        }
        await sleep(300);

        const idx = String(globalIdx).padStart(5, '0');

        // Screenshot
        try {
          await page.screenshot({
            path: path.join(OUTPUT, `frame_${idx}.jpg`),
            type: 'jpeg', quality: 85,
          });
        } catch (e) {
          try {
            await page.reload({ waitUntil: 'networkidle', timeout: 10000 });
            await sleep(2000);
            await page.screenshot({
              path: path.join(OUTPUT, `frame_${idx}.jpg`),
              type: 'jpeg', quality: 85,
            });
          } catch { continue; }
        }

        // State extraction — include forced class info for labeling
        const entities = Object.values(bot.entities)
          .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 48)
          .map(e => ({
            type: e.type, name: e.displayName || e.name,
            x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
            distance: +e.position.distanceTo(pos).toFixed(1),
            hostile: isHostile(e.name),
          }));

        const blks = new Set();
        for (let dx = -4; dx <= 4; dx++)
          for (let dz = -4; dz <= 4; dz++)
            for (let dy = -2; dy <= 2; dy++) {
              const b = bot.blockAt(pos.offset(dx, dy, dz));
              if (b && b.name !== 'air') blks.add(b.name);
            }

        const audioEvents = audio.getRecentEvents(2000);

        fs.writeFileSync(path.join(OUTPUT, `state_${idx}.json`), JSON.stringify({
          timestamp: Date.now(), frameIdx: globalIdx,
          targetClass: entityClass.name,
          targetClassId: entityClass.classId,
          spawnedCount: spawnCount,
          player: {
            x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
            yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
          },
          world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000, biome: 'unknown' },
          entities, blockTypes: [...blks],
          audio: {
            events: audioEvents.map(e => ({
              name: e.name, classification: e.classification,
              distance: e.distance, direction: e.direction,
            })),
          },
        }));

        globalIdx++;
        classFrames++;
      }

      // Move slightly for position diversity
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await sleep(600);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);

      // Kill old mobs periodically to prevent buildup
      if (classFrames % 20 === 0) {
        await rcon.send('kill @e[type=!player,distance=..100]');
        await sleep(500);
      }
    }

    console.log(`  [DONE] ${entityClass.name}: ${classFrames} frames captured`);
  }

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT, 'metadata.json'), JSON.stringify({
    frames: globalIdx,
    framesPerClass: FRAMES_PER_CLASS,
    classes: ENTITY_CLASSES.filter(c => !c.needsWater).map(c => c.name),
    captureMethod: 'balanced-per-class',
  }, null, 2));

  audio.saveEvents(path.join(OUTPUT, 'audio_log.json'));

  console.log(`\n=== BALANCED CAPTURE COMPLETE: ${globalIdx} frames ===`);
  await browser.close();
  try { await rcon.end(); } catch {};
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
