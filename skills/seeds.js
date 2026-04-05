#!/usr/bin/env node
'use strict';
/**
 * skills/seeds.js — Pre-written seed skills that work reliably.
 * These bootstrap the library so the LLM has working examples to learn from.
 */

const { SkillLibrary } = require('./library');

const SEEDS = [
  {
    name: 'gatherWood',
    description: 'Find and mine the nearest oak/birch log, collecting it into inventory',
    params: { count: 'number of logs to gather (default 1)' },
    code: `
const count = params.count || 1;
let gathered = 0;
for (let i = 0; i < count; i++) {
  const log = bot.findBlock({
    matching: block => block.name.includes('log'),
    maxDistance: 32,
  });
  if (!log) { bot.chat('No logs found nearby'); break; }
  
  // Navigate to the log
  await bot.pathfinder.goto(new goals.GoalBlock(log.position.x, log.position.y, log.position.z));
  
  // Mine it
  await bot.dig(log);
  gathered++;
  bot.chat('Mined ' + gathered + '/' + count + ' logs');
  
  // Wait for item to be collected
  await new Promise(r => setTimeout(r, 500));
}
    `,
    postcondition: 'bot.inventory.items().some(i => i.name.includes("log"))',
  },
  {
    name: 'craftPlanks',
    description: 'Craft any type of logs into planks',
    params: {},
    code: `
const log = bot.inventory.items().find(i => i.name.includes('log'));
if (!log) { throw new Error('No logs in inventory'); }
// Find the matching planks type for this log type
const woodType = log.name.replace('_log', '').replace('stripped_', '');
const planksName = woodType + '_planks';
const planksItem = mcData.itemsByName[planksName];
if (!planksItem) { throw new Error('Unknown planks type: ' + planksName); }
const recipe = bot.recipesFor(planksItem.id)[0];
if (!recipe) { throw new Error('No recipe for ' + planksName); }
await bot.craft(recipe, 1, null);
bot.chat('Crafted ' + planksName);
    `,
    postcondition: 'bot.inventory.items().some(i => i.name.includes("planks"))',
  },
  {
    name: 'craftCraftingTable',
    description: 'Craft a crafting table from any type of planks',
    params: {},
    code: `
const planks = bot.inventory.items().find(i => i.name.includes('planks'));
if (!planks || planks.count < 4) { throw new Error('Need 4+ planks (have ' + (planks?.count || 0) + ')'); }
const recipes = bot.recipesFor(mcData.itemsByName.crafting_table.id);
if (!recipes.length) { throw new Error('No crafting table recipe found'); }
await bot.craft(recipes[0], 1, null);
bot.chat('Crafted crafting table');
    `,
    postcondition: 'bot.inventory.items().some(i => i.name === "crafting_table")',
  },
  {
    name: 'craftWoodenPickaxe',
    description: 'Craft a wooden pickaxe (requires crafting table placed nearby)',
    params: {},
    code: `
// Find or place crafting table
let table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 8 });
if (!table) {
  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!tableItem) { throw new Error('No crafting table in inventory'); }
  await bot.equip(tableItem, 'hand');
  // Look down and find a solid block to place on
  const pos = bot.entity.position;
  for (const offset of [[1,0,0],[0,0,1],[-1,0,0],[0,0,-1]]) {
    const target = pos.offset(offset[0], -1, offset[2]);
    const block = bot.blockAt(target);
    const above = bot.blockAt(target.offset(0, 1, 0));
    if (block && block.name !== 'air' && above && above.name === 'air') {
      try {
        await bot.placeBlock(block, new Vec3(0, 1, 0));
        await new Promise(r => setTimeout(r, 1000));
        break;
      } catch(e) { /* try next position */ }
    }
  }
  table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 8 });
}
if (!table) { throw new Error('Could not find/place crafting table'); }

// Navigate to table
await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));

// Craft sticks (need 2 planks → 4 sticks)
const sticksRecipe = bot.recipesFor(mcData.itemsByName.stick.id, null, 1, table)[0];
if (sticksRecipe) {
  await bot.craft(sticksRecipe, 2, table);
  bot.chat('Crafted sticks');
}

// Craft wooden pickaxe (3 planks + 2 sticks)
const pickRecipe = bot.recipesFor(mcData.itemsByName.wooden_pickaxe.id, null, 1, table)[0];
if (!pickRecipe) { throw new Error('No wooden pickaxe recipe — need 3 planks + 2 sticks'); }
await bot.craft(pickRecipe, 1, table);
bot.chat('Crafted wooden pickaxe!');
    `,
    postcondition: 'bot.inventory.items().some(i => i.name === "wooden_pickaxe")',
  },
  {
    name: 'mineStone',
    description: 'Mine stone blocks to get cobblestone (requires pickaxe equipped)',
    params: { count: 'number of stone to mine (default 3)' },
    code: `
const count = params.count || 3;
// Equip pickaxe
const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
if (pick) await bot.equip(pick, 'hand');

for (let i = 0; i < count; i++) {
  const stone = bot.findBlock({
    matching: block => block.name === 'stone' || block.name === 'cobblestone',
    maxDistance: 16,
  });
  if (!stone) { bot.chat('No stone found, digging down...'); break; }
  
  await bot.pathfinder.goto(new goals.GoalNear(stone.position.x, stone.position.y, stone.position.z, 2));
  await bot.dig(stone);
  await new Promise(r => setTimeout(r, 300));
}
    `,
    postcondition: 'bot.inventory.items().some(i => i.name === "cobblestone")',
  },
  {
    name: 'eatFood',
    description: 'Eat the first available food item from inventory',
    params: {},
    code: `
const foods = ['bread','cooked_beef','cooked_porkchop','apple','cooked_chicken',
  'baked_potato','cooked_mutton','cooked_salmon','cooked_cod','melon_slice',
  'carrot','potato','beetroot','sweet_berries','dried_kelp'];
const food = bot.inventory.items().find(i => foods.includes(i.name));
if (!food) { throw new Error('No food in inventory'); }
await bot.equip(food, 'hand');
await bot.consume();
bot.chat('Ate ' + food.name);
    `,
    postcondition: 'bot.food > 15',
  },
  {
    name: 'buildShelter',
    description: 'Build a small 3x3x3 dirt shelter around the current position',
    params: {},
    code: `
const pos = bot.entity.position.floored();
const dirt = bot.inventory.items().find(i => i.name === 'dirt');
if (!dirt || dirt.count < 20) {
  // Gather dirt first
  for (let i = 0; i < 20; i++) {
    const dirtBlock = bot.findBlock({matching: mcData.blocksByName.dirt.id, maxDistance: 8});
    if (!dirtBlock) break;
    await bot.dig(dirtBlock);
    await new Promise(r => setTimeout(r, 200));
  }
}

// Build walls
const dirtItem = bot.inventory.items().find(i => i.name === 'dirt');
if (!dirtItem) { throw new Error('No dirt to build with'); }
await bot.equip(dirtItem, 'hand');

// Simple: place blocks in a ring around the bot
for (let dx = -1; dx <= 1; dx++) {
  for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue; // leave center open
    for (let dy = 0; dy < 3; dy++) {
      const targetPos = pos.offset(dx, dy, dz);
      const block = bot.blockAt(targetPos);
      if (block && block.name === 'air') {
        try {
          // Find adjacent solid block to place against
          const below = bot.blockAt(targetPos.offset(0, -1, 0));
          if (below && below.name !== 'air') {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
          }
        } catch(e) {}
      }
    }
  }
}
bot.chat('Built shelter!');
    `,
    postcondition: 'true',
  },
  {
    name: 'exploreForward',
    description: 'Sprint forward for several seconds, exploring new terrain',
    params: { duration: 'seconds to run (default 5)' },
    code: `
const duration = (params.duration || 5) * 1000;
bot.setControlState('forward', true);
bot.setControlState('sprint', true);
await new Promise(r => setTimeout(r, duration));
bot.setControlState('forward', false);
bot.setControlState('sprint', false);
bot.chat('Explored forward');
    `,
    postcondition: 'true',
  },
];

function seedLibrary() {
  const library = new SkillLibrary();
  let added = 0;
  for (const skill of SEEDS) {
    if (!library.get(skill.name)) {
      library.store(skill);
      added++;
      console.log(`[SEED] Added: ${skill.name}`);
    }
  }
  console.log(`[SEED] ${added} skills seeded (${library.list().length} total)`);
  return library;
}

if (require.main === module) {
  seedLibrary();
}

module.exports = { seedLibrary, SEEDS };
