
const planks = bot.inventory.items().find(i => i.name.includes('planks'));
if (!planks || planks.count < 4) { throw new Error('Need 4+ planks'); }
const recipe = bot.recipesFor(mcData.itemsByName.crafting_table.id)[0];
if (!recipe) { throw new Error('No crafting table recipe'); }
await bot.craft(recipe, 1, null);
bot.chat('Crafted crafting table');
    