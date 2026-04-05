await bot.chat('Jumping!');

for (let i = 0; i < 3; i++) {
  bot.setControlState('jump', true);
  await new Promise(resolve => setTimeout(resolve, 150));
  bot.setControlState('jump', false);
  await new Promise(resolve => setTimeout(resolve, 400));
}

await bot.chat('Done!');
