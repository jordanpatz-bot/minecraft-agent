
// Find or place crafting table
let table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
if (!table) {
  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!tableItem) { throw new Error('No crafting table'); }
  // Place it on the ground nearby
  const ground = bot.blockAt(bot.entity.position.offset(1, -1, 0));
  if (ground) {
    await bot.equip(tableItem, 'hand');
    await bot.placeBlock(ground, new Vec3(0, 1, 0));
    await new Promise(r => setTimeout(r, 500));
    table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
  }
}
if (!table) { throw new Error('Could not find/place crafting table'); }

// Need sticks + planks
const sticksRecipe = bot.recipesFor(mcData.itemsByName.stick.id, null, 1, table)[0] || bot.recipesFor(mcData.itemsByName.stick.id)[0];
if (sticksRecipe) await bot.craft(sticksRecipe, 1, table);

const pickRecipe = bot.recipesFor(mcData.itemsByName.wooden_pickaxe.id, null, 1, table)[0];
if (!pickRecipe) { throw new Error('No wooden pickaxe recipe'); }
await bot.craft(pickRecipe, 1, table);
bot.chat('Crafted wooden pickaxe!');
    