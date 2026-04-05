#!/usr/bin/env node
'use strict';
/**
 * Fast parallel state-only capture (no screenshots).
 * Spawns multiple bots heading in different directions.
 * Screenshots can be rendered later from saved states.
 */
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOTAL = parseInt(process.argv[2] || '200');
const OUTPUT = path.join(__dirname, '..', 'data', 'states');
fs.mkdirSync(OUTPUT, { recursive: true });

const DIRS = [
  { yaw: 0, label: 'S' },
  { yaw: Math.PI, label: 'N' },
  { yaw: -Math.PI/2, label: 'E' },
  { yaw: Math.PI/2, label: 'W' },
];

function isHostile(name) {
  return ['zombie','skeleton','creeper','spider','enderman','witch',
    'slime','phantom','drowned','husk','stray','cave_spider'].includes(name?.toLowerCase());
}

async function runBot(dirIdx) {
  const dir = DIRS[dirIdx];
  const name = `Bot${dir.label}`;
  
  const bot = mineflayer.createBot({ host:'localhost', port:25565, username: name });
  await new Promise(r => bot.once('spawn', r));
  console.log(`[${name}] Spawned at ${bot.entity.position.toString()}`);
  
  // Auto-respawn on death
  bot.on('death', () => { bot.emit('spawn'); });
  
  let idx = 0;
  let hostile = 0;
  const positions = new Set();

  for (let i = 0; i < TOTAL; i++) {
    const pos = bot.entity.position;
    positions.add(`${Math.round(pos.x)},${Math.round(pos.z)}`);

    // Extract state
    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 48)
      .map(e => ({
        type: e.type, name: e.displayName || e.name || e.type,
        x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
        distance: +e.position.distanceTo(pos).toFixed(1),
        hostile: isHostile(e.name),
      }));
    hostile += entities.filter(e => e.hostile).length;

    const blocks = [];
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air') blocks.push({ name: b.name });
        }

    const state = {
      idx: `${dir.label}_${String(idx).padStart(5,'0')}`,
      timestamp: Date.now(), direction: dir.label,
      player: { x:+pos.x.toFixed(1), y:+pos.y.toFixed(1), z:+pos.z.toFixed(1),
                yaw:+bot.entity.yaw.toFixed(2), pitch:+bot.entity.pitch.toFixed(2),
                health: bot.health, food: bot.food },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000,
               biome: bot.blockAt(pos)?.biome?.name || 'unknown' },
      entities, blockTypes: [...new Set(blocks.map(b=>b.name))],
      inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    };

    fs.writeFileSync(path.join(OUTPUT, `${state.idx}.json`), JSON.stringify(state));
    idx++;

    // Sprint in direction
    await bot.look(dir.yaw + (Math.random()-0.5)*0.4, (Math.random()-0.5)*0.3);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    await sleep(2500);
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    await sleep(500);

    if (idx % 50 === 0) {
      console.log(`[${name}] ${idx}/${TOTAL} pos=(${pos.x.toFixed(0)},${pos.z.toFixed(0)}) uniq=${positions.size} hostile=${hostile}`);
    }
  }

  console.log(`[${name}] Done: ${idx} states, ${positions.size} positions, ${hostile} hostile`);
  return { dir: dir.label, states: idx, positions: positions.size, hostile };
}

async function main() {
  console.log(`=== STATE CAPTURE: 4 bots × ${TOTAL} each ===\n`);
  const ps = [];
  for (let i = 0; i < 4; i++) {
    ps.push(runBot(i));
    await sleep(1000);
  }
  const results = await Promise.all(ps);
  console.log('\n=== TOTAL ===');
  const t = results.reduce((a,r) => ({ states: a.states+r.states, positions: a.positions+r.positions, hostile: a.hostile+r.hostile }), {states:0,positions:0,hostile:0});
  console.log(`States: ${t.states}, Unique positions: ${t.positions}, Hostile entities: ${t.hostile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
