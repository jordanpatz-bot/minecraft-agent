
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
try {
  await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
} catch(e) {
  // Walk toward it manually if pathfinder fails
  await bot.lookAt(table.position);
  bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 2000));
  bot.setControlState('forward', false);
}

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
    