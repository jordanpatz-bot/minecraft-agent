
const planks = bot.inventory.items().find(i => i.name.includes('planks'));
if (!planks || planks.count < 4) { throw new Error('Need 4+ planks (have ' + (planks?.count || 0) + ')'); }
const recipes = bot.recipesFor(mcData.itemsByName.crafting_table.id);
if (!recipes.length) { throw new Error('No crafting table recipe found'); }
await bot.craft(recipes[0], 1, null);
bot.chat('Crafted crafting table');
    