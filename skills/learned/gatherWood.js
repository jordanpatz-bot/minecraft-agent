
const count = params.count || 1;
let gathered = 0;
for (let i = 0; i < count; i++) {
  const log = bot.findBlock({
    matching: block => block.name.includes('log'),
    maxDistance: 48,
  });
  if (!log) { bot.chat('No logs found nearby'); break; }

  // Navigate near the log (GoalNear is more reliable than GoalBlock)
  try {
    await bot.pathfinder.goto(new goals.GoalNear(log.position.x, log.position.y, log.position.z, 1));
  } catch(e) {
    // If pathfinder fails, try simple walk toward it
    await bot.lookAt(log.position);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 3000));
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }

  // Re-find the block (might have moved)
  const target = bot.blockAt(log.position);
  if (target && target.name.includes('log')) {
    await bot.dig(target);
    gathered++;

    // Collect dropped items — walk around briefly
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 400));
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    await new Promise(r => setTimeout(r, 400));
    bot.setControlState('back', false);
    await new Promise(r => setTimeout(r, 300));
  }
}
    