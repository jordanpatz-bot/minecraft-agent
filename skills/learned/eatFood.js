
const foods = ['bread','cooked_beef','cooked_porkchop','apple','cooked_chicken',
  'baked_potato','cooked_mutton','cooked_salmon','cooked_cod','melon_slice',
  'carrot','potato','beetroot','sweet_berries','dried_kelp','golden_apple',
  'golden_carrot','rotten_flesh','spider_eye','cookie','pumpkin_pie',
  'mushroom_stew','rabbit_stew','suspicious_stew','honey_bottle'];
const food = bot.inventory.items().find(i => foods.includes(i.name));
if (!food) { throw new Error('No edible food in inventory (checked ' + bot.inventory.items().map(i=>i.name).join(',') + ')'); }
await bot.equip(food, 'hand');
await bot.consume();
bot.chat('Ate ' + food.name);
    