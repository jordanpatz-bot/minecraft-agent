
const log = bot.inventory.items().find(i => i.name.includes('log'));
if (!log) { throw new Error('No logs in inventory'); }
const planksRecipe = bot.recipesFor(mcData.itemsByName.oak_planks?.id || mcData.itemsByName.birch_planks?.id)[0];
if (!planksRecipe) { throw new Error('No planks recipe found'); }
await bot.craft(planksRecipe, 1, null);
bot.chat('Crafted planks');
    