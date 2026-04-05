
const duration = (params.duration || 5) * 1000;
bot.setControlState('forward', true);
bot.setControlState('sprint', true);
await new Promise(r => setTimeout(r, duration));
bot.setControlState('forward', false);
bot.setControlState('sprint', false);
bot.chat('Explored forward');
    