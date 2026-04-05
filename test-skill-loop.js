#!/usr/bin/env node
'use strict';
/**
 * test-skill-loop.js — Phase 0.4 validation test.
 * Connects to server, asks LLM to write skills, executes them, verifies postconditions.
 *
 * Usage: node test-skill-loop.js
 * Requires: Paper server running on localhost:25565
 */

const { createAgent } = require('./core/bot');
const { SkillWriter } = require('./skills/writer');
const { LLMProvider } = require('./llm/provider');

const GOALS = [
  'Look around by rotating the camera in a full circle',
  'Jump 3 times in a row',
  'Send a chat message saying "Hello, I am a bot!"',
  'Navigate to a position 10 blocks east of the current position',
  'Place a dirt block 2 blocks in front of the bot (use creative inventory to get dirt first with bot.creative.setInventorySlot)',
];

async function main() {
  console.log('=== Phase 0.4: Skill Library Validation ===\n');

  // Connect to server
  console.log('Connecting to server...');
  const agent = await createAgent({
    host: 'localhost',
    port: 25565,
    username: 'SkillBot',
  });

  // Wait for chunks to load
  await new Promise(r => setTimeout(r, 3000));
  console.log(`Spawned at ${JSON.stringify(agent.getState().player.position)}\n`);

  // Set up LLM + skill writer
  const llm = new LLMProvider({ provider: 'claude', model: 'haiku' });
  const writer = new SkillWriter({ llm, maxRetries: 2 });

  const results = [];

  for (const goal of GOALS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`GOAL: ${goal}`);
    console.log('═'.repeat(60));

    const state = agent.getState();
    const result = await writer.writeAndVerify(goal, agent.bot, {
      inventory: state.inventory,
      position: state.player.position,
      nearbyBlocks: state.nearbyBlocks,
    });

    results.push({ goal, ...result });
    console.log(`RESULT: ${result.success ? 'PASS' : 'FAIL'} (${result.attempts} attempts)${result.error ? ' — ' + result.error : ''}`);

    // Brief pause between skills
    await new Promise(r => setTimeout(r, 1000));
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));

  const passed = results.filter(r => r.success).length;
  for (const r of results) {
    const status = r.success ? '✓' : '✗';
    console.log(`  ${status} ${r.goal} (${r.attempts} attempts)`);
  }
  console.log(`\n${passed}/${results.length} passed`);

  // Show stored skills
  console.log('\nStored skills:');
  for (const s of writer.library.list()) {
    console.log(`  ${s.name}: ${s.description}`);
  }

  process.exit(passed > 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
