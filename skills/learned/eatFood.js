
const foods = ['bread','cooked_beef','cooked_porkchop','apple','cooked_chicken',
  'baked_potato','cooked_mutton','cooked_salmon','cooked_cod','melon_slice',
  'carrot','potato','beetroot','sweet_berries','dried_kelp'];
const food = bot.inventory.items().find(i => foods.includes(i.name));
if (!food) { throw new Error('No food in inventory'); }
await bot.equip(food, 'hand');
await bot.consume();
bot.chat('Ate ' + food.name);
    