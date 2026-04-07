#!/usr/bin/env node
'use strict';
/**
 * playtest-visuals.js — Spawn Buddy, cycle equipment, teleport player to Buddy.
 *
 * Buddy stands idle while we swap gear sets every ~60s and tp konigsalat over.
 * Designed for visual capture / observation playtesting.
 *
 * Usage: node playtest-visuals.js [--interval 60] [--player konigsalat]
 */

const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');

const args = process.argv.slice(2);
const INTERVAL = parseInt(args.find((_, i, a) => a[i-1] === '--interval') || '60') * 1000;
const PLAYER = args.find((_, i, a) => a[i-1] === '--player') || 'konigsalat';
const BOT_NAME = 'Buddy';

// Equipment loadouts — each is a full outfit applied via RCON
// Using 1.20.1 /item replace syntax
const LOADOUTS = [
  {
    name: 'Diamond Knight',
    slots: {
      'armor.head': 'diamond_helmet',
      'armor.chest': 'diamond_chestplate',
      'armor.legs': 'diamond_leggings',
      'armor.feet': 'diamond_boots',
      'weapon.mainhand': 'diamond_sword',
      'weapon.offhand': 'shield',
    }
  },
  {
    name: 'Iron Warrior',
    slots: {
      'armor.head': 'iron_helmet',
      'armor.chest': 'iron_chestplate',
      'armor.legs': 'iron_leggings',
      'armor.feet': 'iron_boots',
      'weapon.mainhand': 'iron_axe',
      'weapon.offhand': 'torch',
    }
  },
  {
    name: 'Gold King',
    slots: {
      'armor.head': 'golden_helmet',
      'armor.chest': 'golden_chestplate',
      'armor.legs': 'golden_leggings',
      'armor.feet': 'golden_boots',
      'weapon.mainhand': 'golden_sword',
      'weapon.offhand': 'totem_of_undying',
    }
  },
  {
    name: 'Leather Scout (Red)',
    slots: {
      'armor.head': 'leather_helmet{display:{color:16711680}}',
      'armor.chest': 'leather_chestplate{display:{color:16711680}}',
      'armor.legs': 'leather_leggings{display:{color:16711680}}',
      'armor.feet': 'leather_boots{display:{color:16711680}}',
      'weapon.mainhand': 'bow',
      'weapon.offhand': 'arrow 64',
    }
  },
  {
    name: 'Leather Scout (Blue)',
    slots: {
      'armor.head': 'leather_helmet{display:{color:255}}',
      'armor.chest': 'leather_chestplate{display:{color:255}}',
      'armor.legs': 'leather_leggings{display:{color:255}}',
      'armor.feet': 'leather_boots{display:{color:255}}',
      'weapon.mainhand': 'trident',
      'weapon.offhand': 'nautilus_shell',
    }
  },
  {
    name: 'Leather Scout (Green)',
    slots: {
      'armor.head': 'leather_helmet{display:{color:65280}}',
      'armor.chest': 'leather_chestplate{display:{color:65280}}',
      'armor.legs': 'leather_leggings{display:{color:65280}}',
      'armor.feet': 'leather_boots{display:{color:65280}}',
      'weapon.mainhand': 'crossbow',
      'weapon.offhand': 'spyglass',
    }
  },
  {
    name: 'Netherite Tank',
    slots: {
      'armor.head': 'netherite_helmet',
      'armor.chest': 'netherite_chestplate',
      'armor.legs': 'netherite_leggings',
      'armor.feet': 'netherite_boots',
      'weapon.mainhand': 'netherite_sword',
      'weapon.offhand': 'shield',
    }
  },
  {
    name: 'Chainmail Ranger',
    slots: {
      'armor.head': 'chainmail_helmet',
      'armor.chest': 'chainmail_chestplate',
      'armor.legs': 'chainmail_leggings',
      'armor.feet': 'chainmail_boots',
      'weapon.mainhand': 'crossbow',
      'weapon.offhand': 'firework_rocket 64',
    }
  },
  {
    name: 'Wizard (No Armor)',
    slots: {
      'armor.head': 'carved_pumpkin',
      'armor.chest': 'elytra',
      'armor.legs': 'leather_leggings{display:{color:4915330}}',
      'armor.feet': 'leather_boots{display:{color:4915330}}',
      'weapon.mainhand': 'blaze_rod',
      'weapon.offhand': 'ender_eye',
    }
  },
  {
    name: 'Pirate',
    slots: {
      'armor.head': 'leather_helmet{display:{color:3355443}}',
      'armor.chest': 'leather_chestplate{display:{color:11184810}}',
      'armor.legs': 'leather_leggings{display:{color:3355443}}',
      'armor.feet': 'leather_boots{display:{color:5592405}}',
      'weapon.mainhand': 'iron_sword',
      'weapon.offhand': 'map',
    }
  },
  {
    name: 'Naked Fist Fighter',
    slots: {
      'weapon.mainhand': 'air',
      'weapon.offhand': 'air',
      'armor.head': 'air',
      'armor.chest': 'air',
      'armor.legs': 'air',
      'armor.feet': 'air',
    }
  },
  {
    name: 'Mixed Mismatch',
    slots: {
      'armor.head': 'iron_helmet',
      'armor.chest': 'diamond_chestplate',
      'armor.legs': 'golden_leggings',
      'armor.feet': 'leather_boots{display:{color:16753920}}',
      'weapon.mainhand': 'fishing_rod',
      'weapon.offhand': 'clock',
    }
  },
  {
    name: 'Turtle Master',
    slots: {
      'armor.head': 'turtle_helmet',
      'armor.chest': 'leather_chestplate{display:{color:43520}}',
      'armor.legs': 'leather_leggings{display:{color:43520}}',
      'armor.feet': 'leather_boots{display:{color:43520}}',
      'weapon.mainhand': 'trident',
      'weapon.offhand': 'heart_of_the_sea',
    }
  },
  {
    name: 'Enderslayer',
    slots: {
      'armor.head': 'diamond_helmet',
      'armor.chest': 'netherite_chestplate',
      'armor.legs': 'diamond_leggings',
      'armor.feet': 'netherite_boots',
      'weapon.mainhand': 'netherite_axe',
      'weapon.offhand': 'end_crystal',
    }
  },
  {
    name: 'Farmer',
    slots: {
      'armor.head': 'leather_helmet{display:{color:9127187}}',
      'armor.chest': 'leather_chestplate{display:{color:6697728}}',
      'armor.legs': 'leather_leggings{display:{color:4929536}}',
      'armor.feet': 'leather_boots{display:{color:5592405}}',
      'weapon.mainhand': 'iron_hoe',
      'weapon.offhand': 'wheat 64',
    }
  },
];

let loadoutIndex = 0;
let rcon = null;

async function connectRcon() {
  rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
  console.log('[RCON] Connected');
  return rcon;
}

async function rconCmd(cmd) {
  try {
    const res = await rcon.send(cmd);
    console.log(`  > ${cmd}  →  ${res}`);
    return res;
  } catch (e) {
    console.error(`  > ${cmd}  FAILED: ${e.message}`);
    // Reconnect on failure
    try { await rcon.end(); } catch (_) {}
    rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
    return null;
  }
}

// Locations to cycle through — spread across different biomes/terrain
const LOCATIONS = [
  { name: 'Nearby plains', x: 0, z: 0 },
  { name: 'Forest', x: 500, z: 200 },
  { name: 'Mountains', x: -800, z: 600 },
  { name: 'Desert', x: 1200, z: -400 },
  { name: 'Ocean coast', x: -200, z: -1500 },
  { name: 'Jungle', x: 1500, z: 1500 },
  { name: 'Taiga', x: -1200, z: -800 },
  { name: 'Savanna', x: 2000, z: 0 },
  { name: 'Swamp', x: -500, z: 1000 },
  { name: 'Badlands', x: 2500, z: -1000 },
  { name: 'Snowy peaks', x: -2000, z: 2000 },
  { name: 'Dark forest', x: 800, z: -1200 },
  { name: 'Meadow', x: -1500, z: 400 },
  { name: 'River valley', x: 300, z: 2000 },
  { name: 'Stony shore', x: -3000, z: -500 },
];

let locationIndex = 0;

async function applyLoadout(loadout) {
  console.log(`\n[LOADOUT] Applying: ${loadout.name}`);
  for (const [slot, item] of Object.entries(loadout.slots)) {
    await rconCmd(`item replace entity ${BOT_NAME} ${slot} with minecraft:${item}`);
  }
}

async function teleportToLocation(loc) {
  console.log(`[LOCATION] Moving to: ${loc.name} (${loc.x}, ${loc.z})`);
  // Spread Buddy to a safe surface spot near the target coordinates
  await rconCmd(`spreadplayers ${loc.x} ${loc.z} 0 30 false ${BOT_NAME}`);
  // Brief pause for chunks to load
  await new Promise(r => setTimeout(r, 3000));
  // Night time for spooky mob visuals
  await rconCmd('time set midnight');
  await rconCmd('weather clear');
}

async function teleportPlayerToBuddy() {
  console.log(`[TP] Teleporting ${PLAYER} to ${BOT_NAME}`);
  await rconCmd(`tp ${PLAYER} ${BOT_NAME}`);
}

async function cycle() {
  const loadout = LOADOUTS[loadoutIndex % LOADOUTS.length];
  const location = LOCATIONS[locationIndex % LOCATIONS.length];

  // Move Buddy to new location first
  await teleportToLocation(location);
  // Apply gear
  await applyLoadout(loadout);
  // Bring player over, keep them invulnerable
  await rconCmd(`effect give ${PLAYER} resistance 9999 255 true`);
  await teleportPlayerToBuddy();

  loadoutIndex++;
  locationIndex++;
  console.log(`[NEXT] Loadout ${loadoutIndex}/${LOADOUTS.length}, Location ${locationIndex}/${LOCATIONS.length}. Next cycle in ${INTERVAL/1000}s`);
}

// --- Main ---
(async () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Visual Playtest — Equipment Cycling     ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Bot: ${BOT_NAME}`);
  console.log(`║  Player: ${PLAYER}`);
  console.log(`║  Interval: ${INTERVAL/1000}s`);
  console.log(`║  Loadouts: ${LOADOUTS.length}`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Spawn bot
  console.log('[BOT] Connecting Buddy to server...');
  const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: BOT_NAME,
    version: '1.20.1',
    auth: 'offline',
  });

  bot.once('spawn', async () => {
    console.log(`[BOT] ${BOT_NAME} spawned at ${bot.entity.position}`);

    // Connect RCON
    await connectRcon();

    // Give Buddy creative mode (can't die, no falling)
    await rconCmd(`gamemode creative ${BOT_NAME}`);
    // Night + monsters
    await rconCmd('time set midnight');
    await rconCmd('weather clear');
    await rconCmd('difficulty hard');

    // Wait a beat then do first cycle
    setTimeout(async () => {
      await cycle();

      // Set up recurring cycle
      setInterval(async () => {
        await cycle();
      }, INTERVAL);
    }, 5000);
  });

  bot.on('error', (err) => console.error('[BOT ERROR]', err.message));
  bot.on('kicked', (reason) => {
    console.error('[BOT KICKED]', reason);
    process.exit(1);
  });

  // Buddy looks at the player periodically for visual interest
  setInterval(() => {
    if (!bot.entity) return;
    const player = bot.players[PLAYER];
    if (player && player.entity) {
      bot.lookAt(player.entity.position.offset(0, 1.6, 0));
    }
  }, 2000);

  // Handle exit
  process.on('SIGINT', async () => {
    console.log('\n[STOP] Shutting down...');
    try { await rcon.end(); } catch (_) {}
    bot.quit();
    process.exit(0);
  });
})();
