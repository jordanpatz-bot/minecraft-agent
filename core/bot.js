#!/usr/bin/env node
'use strict';
/**
 * core/bot.js — Minecraft bot lifecycle management.
 * Creates a Mineflayer bot, loads plugins, exposes state extraction.
 *
 * Usage:
 *   const { createAgent } = require('./core/bot');
 *   const agent = await createAgent({ host: 'localhost', port: 25565 });
 *   const state = agent.getState();
 */

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalNear, GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;
const { Movements } = require('mineflayer-pathfinder');

/**
 * Create and connect a bot agent.
 * @param {object} opts - { host, port, username, version }
 * @returns {Promise<object>} agent with bot instance + helper methods
 */
async function createAgent(opts = {}) {
  const config = {
    host: opts.host || 'localhost',
    port: opts.port || 25565,
    username: opts.username || `agent_${Math.random().toString(36).slice(2, 6)}`,
    version: opts.version || '1.20.1',
    auth: opts.auth || 'offline',
    ...opts,
  };

  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot(config);

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
      console.log(`[BOT] Spawned as ${bot.username} at ${fmt(bot.entity.position)}`);

      // Configure pathfinder
      const movements = new Movements(bot);
      movements.canDig = true;
      movements.allowParkour = true;
      movements.maxDropDown = 4;
      movements.scafoldingBlocks = []; // don't place blocks while pathing
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.thinkTimeout = 15000; // 15s to compute path (default 5s)

      const agent = {
        bot,
        config,

        /** Extract full game state as a structured object. */
        getState() {
          return extractState(bot);
        },

        /** Navigate to a position. */
        async goto(x, y, z, range = 1) {
          bot.pathfinder.setGoal(new GoalNear(x, y, z, range));
          return new Promise((res, rej) => {
            bot.once('goal_reached', () => res({ status: 'ok' }));
            setTimeout(() => rej(new Error('Navigation timeout')), 30000);
          });
        },

        /** Navigate to an entity by name. */
        async gotoEntity(name, range = 2) {
          const entity = Object.values(bot.entities).find(e =>
            e.displayName?.toLowerCase().includes(name.toLowerCase()) ||
            e.name?.toLowerCase().includes(name.toLowerCase())
          );
          if (!entity) return { status: 'error', message: `Entity not found: ${name}` };
          return this.goto(entity.position.x, entity.position.y, entity.position.z, range);
        },

        /** Dig the block at the given position. */
        async dig(x, y, z) {
          const block = bot.blockAt(bot.vec3(x, y, z));
          if (!block || block.name === 'air') return { status: 'error', message: 'No block' };
          await bot.dig(block);
          return { status: 'ok', block: block.name };
        },
      };

      resolve(agent);
    });

    bot.on('error', (err) => {
      console.error('[BOT] Error:', err.message);
      reject(err);
    });

    bot.on('kicked', (reason) => {
      console.log('[BOT] Kicked:', reason);
    });

    bot.on('end', () => {
      console.log('[BOT] Disconnected');
    });
  });
}

/**
 * Extract structured game state from the bot.
 * Format matches the Perception interface from the plan.
 */
function extractState(bot) {
  const pos = bot.entity.position;

  // Nearby blocks (5x5x5 cube around player)
  const nearbyBlocks = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (block && block.name !== 'air') {
          nearbyBlocks.push({
            name: block.name,
            position: { x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) + dz },
          });
        }
      }
    }
  }

  // Entities (within 32 blocks)
  const entities = Object.values(bot.entities)
    .filter(e => e !== bot.entity)
    .filter(e => e.position.distanceTo(pos) < 32)
    .map(e => ({
      type: e.type,
      name: e.displayName || e.name || e.type,
      position: { x: +(e.position.x.toFixed(1)), y: +(e.position.y.toFixed(1)), z: +(e.position.z.toFixed(1)) },
      distance: +(e.position.distanceTo(pos).toFixed(1)),
      health: e.health || null,
      hostile: isHostile(e),
    }))
    .sort((a, b) => a.distance - b.distance);

  // Inventory
  const inventory = bot.inventory.items().map(item => ({
    name: item.displayName || item.name,
    count: item.count,
    slot: item.slot,
  }));

  // Equipment
  const equipment = {};
  const hand = bot.heldItem;
  if (hand) equipment.hand = hand.displayName || hand.name;
  // Armor slots
  for (const [slot, name] of [[5, 'helmet'], [6, 'chestplate'], [7, 'leggings'], [8, 'boots']]) {
    const item = bot.inventory.slots[slot];
    if (item) equipment[name] = item.displayName || item.name;
  }

  return {
    // Player state
    player: {
      name: bot.username,
      position: { x: +(pos.x.toFixed(1)), y: +(pos.y.toFixed(1)), z: +(pos.z.toFixed(1)) },
      health: bot.health,
      food: bot.food,
      xp: bot.experience?.level || 0,
      yaw: +(bot.entity.yaw.toFixed(2)),
      pitch: +(bot.entity.pitch.toFixed(2)),
    },
    // World state
    world: {
      time: bot.time.timeOfDay,
      isDay: bot.time.timeOfDay < 13000,
      biome: bot.blockAt(pos)?.biome?.name || 'unknown',
      weather: bot.isRaining ? 'rain' : 'clear',
    },
    // Perception
    entities,
    nearbyBlocks: nearbyBlocks.slice(0, 50), // cap for prompt size
    inventory,
    equipment,
    // Messages (last 10)
    messages: (bot._chatHistory || []).slice(-10),
  };
}

/** Heuristic: is this entity hostile? */
function isHostile(entity) {
  const hostileMobs = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
    'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray',
    'blaze', 'ghast', 'magma_cube', 'wither_skeleton',
    'pillager', 'vindicator', 'ravager', 'evoker',
  ]);
  return hostileMobs.has(entity.name?.toLowerCase());
}

function fmt(pos) {
  return `(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})`;
}

module.exports = { createAgent, extractState };
