
const pos = bot.entity.position.floored();
const dirt = bot.inventory.items().find(i => i.name === 'dirt');
if (!dirt || dirt.count < 20) {
  // Gather dirt first
  for (let i = 0; i < 20; i++) {
    const dirtBlock = bot.findBlock({matching: mcData.blocksByName.dirt.id, maxDistance: 8});
    if (!dirtBlock) break;
    await bot.dig(dirtBlock);
    await new Promise(r => setTimeout(r, 200));
  }
}

// Build walls
const dirtItem = bot.inventory.items().find(i => i.name === 'dirt');
if (!dirtItem) { throw new Error('No dirt to build with'); }
await bot.equip(dirtItem, 'hand');

// Simple: place blocks in a ring around the bot
for (let dx = -1; dx <= 1; dx++) {
  for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue; // leave center open
    for (let dy = 0; dy < 3; dy++) {
      const targetPos = pos.offset(dx, dy, dz);
      const block = bot.blockAt(targetPos);
      if (block && block.name === 'air') {
        try {
          // Find adjacent solid block to place against
          const below = bot.blockAt(targetPos.offset(0, -1, 0));
          if (below && below.name !== 'air') {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
          }
        } catch(e) {}
      }
    }
  }
}
bot.chat('Built shelter!');
    