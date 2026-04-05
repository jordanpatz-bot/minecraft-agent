
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
    