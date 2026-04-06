#!/usr/bin/env node
'use strict';
/**
 * perception/capture-blocks.js — Capture frames with block type ground truth.
 *
 * For training a block identification model. The bot explores diverse terrain
 * while we capture frames paired with which blocks are visible and where.
 *
 * Block ground truth comes from Mineflayer's block API + 3D→2D projection
 * to identify which blocks appear in the viewport.
 *
 * Key block types to detect:
 * - Logs (all wood types) — resource gathering
 * - Ores (coal, iron, gold, diamond, copper, etc.) — mining
 * - Crafting table — crafting
 * - Furnace — smelting
 * - Chest — storage
 * - Water — navigation / safety
 * - Lava — danger avoidance
 *
 * Usage: node perception/capture-blocks.js [--frames 500] [--port 3004]
 */

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '500');
const VIEWER_PORT = parseInt(args.find((_, i, a) => a[i-1] === '--port') || '3004');
const OUTPUT = path.join(__dirname, '..', 'data', 'block_captures');
fs.mkdirSync(OUTPUT, { recursive: true });

// Block classes we want to detect visually
const BLOCK_CLASSES = {
  // Logs — class 0
  'oak_log': 0, 'spruce_log': 0, 'birch_log': 0, 'jungle_log': 0,
  'acacia_log': 0, 'dark_oak_log': 0, 'mangrove_log': 0, 'cherry_log': 0,
  // Leaves — class 1
  'oak_leaves': 1, 'spruce_leaves': 1, 'birch_leaves': 1, 'jungle_leaves': 1,
  'acacia_leaves': 1, 'dark_oak_leaves': 1, 'mangrove_leaves': 1, 'cherry_leaves': 1,
  'azalea_leaves': 1, 'flowering_azalea_leaves': 1,
  // Stone variants — class 2
  'stone': 2, 'cobblestone': 2, 'mossy_cobblestone': 2, 'andesite': 2,
  'granite': 2, 'diorite': 2, 'deepslate': 2, 'tuff': 2,
  // Ores — class 3
  'coal_ore': 3, 'iron_ore': 3, 'gold_ore': 3, 'diamond_ore': 3,
  'copper_ore': 3, 'lapis_ore': 3, 'redstone_ore': 3, 'emerald_ore': 3,
  'deepslate_coal_ore': 3, 'deepslate_iron_ore': 3, 'deepslate_gold_ore': 3,
  'deepslate_diamond_ore': 3, 'deepslate_copper_ore': 3,
  // Water — class 4
  'water': 4,
  // Lava — class 5
  'lava': 5,
  // Crafting table — class 6
  'crafting_table': 6,
  // Furnace — class 7
  'furnace': 7, 'blast_furnace': 7, 'smoker': 7,
  // Chest — class 8
  'chest': 8, 'barrel': 8, 'ender_chest': 8,
  // Sand — class 9
  'sand': 9, 'red_sand': 9, 'sandstone': 9, 'red_sandstone': 9,
  // Dirt/Grass — class 10
  'dirt': 10, 'grass_block': 10, 'podzol': 10, 'mycelium': 10, 'rooted_dirt': 10,
};

const BLOCK_CLASS_NAMES = [
  'Log', 'Leaves', 'Stone', 'Ore', 'Water', 'Lava',
  'CraftingTable', 'Furnace', 'Chest', 'Sand', 'Dirt',
];

const TIMES = [0, 6000, 12000, 18000];

async function main() {
  console.log(`[BLOCK CAPTURE] Target: ${TARGET} frames`);

  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'BlockBot',
    checkTimeoutInterval: 60000,
  });
  bot.on('error', e => console.log('[BOT ERR]', e.message));
  bot.on('kicked', r => { console.log('[KICKED]', r); process.exit(1); });
  await new Promise(r => bot.once('spawn', r));
  await sleep(2000);

  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
  await rcon.send('gamemode creative BlockBot');
  await rcon.send('spreadplayers 0 0 0 500 false BlockBot');
  await sleep(3000);
  for (let i = 0; i < 15; i++) { await sleep(300); if (bot.entity.onGround) break; }

  const { mineflayer: viewer } = require('prismarine-viewer');
  viewer(bot, { port: VIEWER_PORT, firstPerson: true });
  await sleep(3000);

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

  let frameIdx = 0;
  let timeIdx = 0;
  const blockTypesSeen = new Set();

  while (frameIdx < TARGET) {
    // Relocate every 40 frames
    if (frameIdx % 40 === 0) {
      const rx = Math.floor(Math.random() * 6000 - 3000);
      const rz = Math.floor(Math.random() * 6000 - 3000);
      try { await rcon.send(`spreadplayers ${rx} ${rz} 0 500 false BlockBot`); } catch {}
      await sleep(3000);
      for (let i = 0; i < 15; i++) { await sleep(300); if (bot.entity.onGround) break; }

      timeIdx = (timeIdx + 1) % TIMES.length;
      try { await rcon.send(`time set ${TIMES[timeIdx]}`); } catch {}

      try { await page.reload({ waitUntil: 'networkidle', timeout: 10000 }); } catch {}
      await sleep(3000);

      // Sometimes place useful blocks for training
      if (Math.random() < 0.3) {
        const pos = bot.entity.position;
        try {
          await rcon.send(`setblock ${Math.floor(pos.x)+3} ${Math.floor(pos.y)} ${Math.floor(pos.z)+2} crafting_table`);
          await rcon.send(`setblock ${Math.floor(pos.x)-2} ${Math.floor(pos.y)} ${Math.floor(pos.z)+3} furnace`);
          await rcon.send(`setblock ${Math.floor(pos.x)+4} ${Math.floor(pos.y)} ${Math.floor(pos.z)-1} chest`);
        } catch {}
      }
    }

    const pos = bot.entity.position;
    const idx = String(frameIdx).padStart(5, '0');

    // Vary look direction — sometimes look down (underground blocks), sometimes ahead
    const lookMode = frameIdx % 4;
    switch (lookMode) {
      case 0: // Look ahead
        await bot.look((frameIdx * 0.7) % (Math.PI * 2), 0.1);
        break;
      case 1: // Look down
        await bot.look((frameIdx * 0.5) % (Math.PI * 2), 0.5 + Math.random() * 0.3);
        break;
      case 2: // Look at interesting block if nearby
        const interesting = bot.findBlock({
          matching: b => BLOCK_CLASSES[b.name] !== undefined && BLOCK_CLASSES[b.name] >= 3,
          maxDistance: 16,
        });
        if (interesting) {
          await bot.lookAt(interesting.position.offset(0.5, 0.5, 0.5));
        } else {
          await bot.look(Math.random() * Math.PI * 2, Math.random() * 0.6);
        }
        break;
      case 3: // Scan horizontally
        await bot.look((frameIdx * 1.2) % (Math.PI * 2), (Math.random() - 0.2) * 0.4);
        break;
    }
    await sleep(300);

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
        await page.screenshot({ path: path.join(OUTPUT, `frame_${idx}.jpg`), type: 'jpeg', quality: 85 });
      } catch { continue; }
    }

    // Block state extraction — scan a larger area for diverse block data
    const visibleBlocks = {};
    for (let dx = -8; dx <= 8; dx++)
      for (let dz = -8; dz <= 8; dz++)
        for (let dy = -4; dy <= 4; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air' && BLOCK_CLASSES[b.name] !== undefined) {
            const cls = BLOCK_CLASSES[b.name];
            if (!visibleBlocks[cls]) visibleBlocks[cls] = [];
            visibleBlocks[cls].push({
              name: b.name,
              x: Math.floor(pos.x) + dx,
              y: Math.floor(pos.y) + dy,
              z: Math.floor(pos.z) + dz,
              distance: Math.sqrt(dx*dx + dy*dy + dz*dz),
            });
            blockTypesSeen.add(b.name);
          }
        }

    fs.writeFileSync(path.join(OUTPUT, `state_${idx}.json`), JSON.stringify({
      timestamp: Date.now(), frameIdx,
      player: {
        x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
        yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
      },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000 },
      blocksByClass: visibleBlocks,
      blockClassNames: BLOCK_CLASS_NAMES,
    }));

    frameIdx++;

    // Move for diversity
    if (frameIdx % 3 === 0) {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await sleep(600);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
    }

    if (frameIdx % 50 === 0) {
      console.log(`[${frameIdx}/${TARGET}] blocks=${blockTypesSeen.size}`);
    }
  }

  fs.writeFileSync(path.join(OUTPUT, 'metadata.json'), JSON.stringify({
    frames: frameIdx,
    blockClasses: BLOCK_CLASS_NAMES,
    blockTypesSeen: [...blockTypesSeen].sort(),
  }, null, 2));

  console.log(`\n=== BLOCK CAPTURE DONE: ${frameIdx} frames, ${blockTypesSeen.size} block types ===`);
  await browser.close();
  try { await rcon.end(); } catch {};
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
