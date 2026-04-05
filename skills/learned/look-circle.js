const startPos = bot.entity.position.clone();
const radius = 10;
const steps = 12;

await bot.chat('Spinning around...');

for (let i = 0; i < steps; i++) {
  const angle = (i / steps) * Math.PI * 2;
  const lookX = startPos.x + Math.cos(angle) * radius;
  const lookZ = startPos.z + Math.sin(angle) * radius;
  const lookPos = new Vec3(lookX, startPos.y, lookZ);
  
  await bot.lookAt(lookPos);
  await new Promise(resolve => setTimeout(resolve, 150));
}

await bot.chat('Full circle complete!');
