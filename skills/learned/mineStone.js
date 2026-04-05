
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
    