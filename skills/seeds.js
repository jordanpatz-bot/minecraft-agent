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
    description: 'Find and mine nearby logs, collecting them into inventory',
    params: { count: 'number of logs to gather (default 1)' },
    code: `
const count = params.count || 1;
let gathered = 0;
for (let i = 0; i < count; i++) {
  const log = bot.findBlock({
    matching: block => block.name.includes('log'),
    maxDistance: 48,
  });
  if (!log) { bot.chat('No logs found nearby'); break; }

  // Navigate near the log (GoalNear is more reliable than GoalBlock)
  try {
    await bot.pathfinder.goto(new goals.GoalNear(log.position.x, log.position.y, log.position.z, 1));
  } catch(e) {
    // If pathfinder fails, try simple walk toward it
    await bot.lookAt(log.position);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 3000));
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }

  // Re-find the block (might have moved)
  const target = bot.blockAt(log.position);
  if (target && target.name.includes('log')) {
    await bot.dig(target);
    gathered++;

    // Collect dropped items — walk around briefly
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 400));
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    await new Promise(r => setTimeout(r, 400));
    bot.setControlState('back', false);
    await new Promise(r => setTimeout(r, 300));
  }
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
    description: 'Craft a wooden pickaxe end-to-end: ensures planks, places table, crafts sticks + pickaxe',
    params: {},
    code: `
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Step 1: Ensure we have enough planks (need 5: 2 for sticks + 3 for pickaxe)
let planks = bot.inventory.items().filter(i => i.name.includes('planks'));
let plankCount = planks.reduce((sum, i) => sum + i.count, 0);
if (plankCount < 5) {
  const logs = bot.inventory.items().filter(i => i.name.includes('log'));
  if (logs.length === 0 && plankCount < 5) throw new Error('Need logs or 5+ planks');
  // Craft logs into planks until we have enough
  while (plankCount < 5) {
    const log = bot.inventory.items().find(i => i.name.includes('log'));
    if (!log) break;
    const woodType = log.name.replace('_log', '').replace('stripped_', '');
    const planksItem = mcData.itemsByName[woodType + '_planks'];
    if (!planksItem) break;
    const recipe = bot.recipesFor(planksItem.id)[0];
    if (!recipe) break;
    await bot.craft(recipe, 1, null);
    await sleep(300);
    plankCount += 4;
  }
}

// Step 2: Ensure we have a crafting table
let tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
if (!tableItem) {
  const ctRecipe = bot.recipesFor(mcData.itemsByName.crafting_table.id)[0];
  if (ctRecipe) {
    await bot.craft(ctRecipe, 1, null);
    await sleep(300);
    tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  }
}
if (!tableItem) throw new Error('Cannot craft crafting table — need 4 planks');

// Step 3: Place the crafting table
let table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 8 });
if (!table) {
  await bot.equip(tableItem, 'hand');
  await sleep(200);

  // Try multiple placement strategies
  const pos = bot.entity.position;
  let placed = false;

  // Strategy A: place on ground next to player
  for (const [dx, dz] of [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
    if (placed) break;
    const groundPos = pos.offset(dx, -1, dz).floored();
    const ground = bot.blockAt(groundPos);
    const above = bot.blockAt(groundPos.offset(0, 1, 0));
    if (ground && ground.name !== 'air' && above && above.name === 'air') {
      try {
        await bot.lookAt(groundPos.offset(0.5, 1.5, 0.5));
        await sleep(200);
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        placed = true;
        await sleep(500);
      } catch(e) { /* try next */ }
    }
  }

  // Strategy B: look down at feet and place
  if (!placed) {
    try {
      const below = bot.blockAt(pos.offset(0, -1, 0).floored());
      if (below && below.name !== 'air') {
        await bot.lookAt(below.position.offset(0.5, 1.5, 0.5));
        await sleep(200);
        // Step back first
        bot.setControlState('back', true);
        await sleep(500);
        bot.setControlState('back', false);
        await sleep(200);
        const target = bot.blockAt(pos.offset(0, -1, 0).floored());
        if (target) {
          await bot.placeBlock(target, new Vec3(0, 1, 0));
          placed = true;
          await sleep(500);
        }
      }
    } catch(e) {}
  }

  await sleep(500);
  table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 8 });
}
if (!table) throw new Error('Could not place crafting table');

// Step 4: Navigate to table
const dist = bot.entity.position.distanceTo(table.position);
if (dist > 3) {
  try {
    await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  } catch(e) {
    await bot.lookAt(table.position);
    bot.setControlState('forward', true);
    await sleep(2000);
    bot.setControlState('forward', false);
  }
}

// Step 5: Get right next to the table and re-find it
await bot.lookAt(table.position.offset(0.5, 0.5, 0.5));
try {
  await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 1));
} catch(e) {
  bot.setControlState('forward', true);
  await sleep(1000);
  bot.setControlState('forward', false);
}
await sleep(500);
// Re-find table (block reference may be stale after pathfinding)
table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
if (!table) throw new Error('Lost sight of crafting table');

// Step 6: Craft sticks if needed
const sticks = bot.inventory.items().find(i => i.name === 'stick');
if (!sticks || sticks.count < 2) {
  const sticksRecipe = bot.recipesFor(mcData.itemsByName.stick.id, null, 1, table)[0];
  if (sticksRecipe) {
    await bot.craft(sticksRecipe, 1, table);
    await sleep(500);
    bot.chat('Crafted sticks');
  }
}

// Step 7: Craft wooden pickaxe
await sleep(300);
const pickRecipe = bot.recipesFor(mcData.itemsByName.wooden_pickaxe.id, null, 1, table)[0];
if (!pickRecipe) throw new Error('No pickaxe recipe found — check materials');
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
