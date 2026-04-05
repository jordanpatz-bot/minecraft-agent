#!/usr/bin/env node
'use strict';
/**
 * Quick test: connect to a local Minecraft server and dump state.
 * Usage: node core/test-connection.js [host] [port]
 */

const { createAgent } = require('./bot');

const host = process.argv[2] || 'localhost';
const port = parseInt(process.argv[3] || '25565');

async function main() {
  console.log(`Connecting to ${host}:${port}...`);

  try {
    const agent = await createAgent({ host, port, username: 'TestBot' });
    console.log('\n=== CONNECTION SUCCESSFUL ===\n');

    const state = agent.getState();

    console.log('PLAYER:', JSON.stringify(state.player, null, 2));
    console.log('\nWORLD:', JSON.stringify(state.world, null, 2));
    console.log(`\nENTITIES (${state.entities.length}):`);
    for (const e of state.entities.slice(0, 10)) {
      console.log(`  ${e.name} (${e.type}) at ${e.distance}m ${e.hostile ? 'HOSTILE' : ''}`);
    }
    console.log(`\nINVENTORY (${state.inventory.length} items):`);
    for (const item of state.inventory) {
      console.log(`  ${item.name} x${item.count}`);
    }
    console.log('\nEQUIPMENT:', JSON.stringify(state.equipment));
    console.log(`\nNEARBY BLOCKS: ${state.nearbyBlocks.length} non-air blocks`);
    const blockTypes = {};
    for (const b of state.nearbyBlocks) {
      blockTypes[b.name] = (blockTypes[b.name] || 0) + 1;
    }
    console.log('  Types:', JSON.stringify(blockTypes));

    // Test movement
    console.log('\n--- Testing movement ---');
    const pos = state.player.position;
    console.log(`Moving to (${pos.x + 5}, ${pos.y}, ${pos.z})...`);
    try {
      await agent.goto(pos.x + 5, pos.y, pos.z, 1);
      const newState = agent.getState();
      console.log(`Moved to ${JSON.stringify(newState.player.position)}`);
    } catch (e) {
      console.log('Movement test:', e.message);
    }

    console.log('\n=== ALL TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('Connection failed:', err.message);
    console.error('\nMake sure a Minecraft server is running on', `${host}:${port}`);
    console.error('For a quick test server: download Paper from https://papermc.io/downloads/paper');
    process.exit(1);
  }
}

main();
