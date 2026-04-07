
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
    