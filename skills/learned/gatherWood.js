
const count = params.count || 1;
let gathered = 0;
for (let i = 0; i < count; i++) {
  const log = bot.findBlock({
    matching: block => block.name.includes('log'),
    maxDistance: 32,
  });
  if (!log) { bot.chat('No logs found nearby'); break; }
  
  // Navigate to the log
  await bot.pathfinder.goto(new goals.GoalBlock(log.position.x, log.position.y, log.position.z));
  
  // Mine it
  await bot.dig(log);
  gathered++;
  bot.chat('Mined ' + gathered + '/' + count + ' logs');
  
  // Wait for item to be collected
  await new Promise(r => setTimeout(r, 500));
}
    