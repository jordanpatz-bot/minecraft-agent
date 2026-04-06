#!/usr/bin/env node
'use strict';
/**
 * perception/capture-multi.js — Run multiple capture agents in parallel.
 *
 * Spawns N bots on different viewer ports, each capturing independently
 * in different world areas. Maximizes data collection throughput.
 *
 * Usage: node perception/capture-multi.js [--agents 2] [--frames 400]
 */

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const NUM_AGENTS = parseInt(args.find((_, i, a) => a[i-1] === '--agents') || '2');
const FRAMES_PER = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '400');
const BASE_PORT = 3010;

console.log(`[MULTI] Launching ${NUM_AGENTS} capture agents, ${FRAMES_PER} frames each`);

const children = [];
for (let i = 0; i < NUM_AGENTS; i++) {
  const port = BASE_PORT + i;
  console.log(`[AGENT ${i}] Port ${port}, target ${FRAMES_PER} frames`);

  const child = spawn('node', [
    path.join(__dirname, 'capture-playwright.js'),
    '--frames', String(FRAMES_PER),
    '--port', String(port),
  ], {
    stdio: 'pipe',
    env: {
      ...process.env,
      CAPTURE_AGENT_ID: String(i),
      CAPTURE_PORT: String(port),
    },
  });

  child.stdout.on('data', d => {
    const lines = d.toString().trim().split('\n');
    for (const line of lines) {
      if (line.includes('/') || line.includes('===') || line.includes('[LOC]') || line.includes('[READY]')) {
        console.log(`[A${i}] ${line.trim()}`);
      }
    }
  });
  child.stderr.on('data', d => console.log(`[A${i} ERR] ${d.toString().trim()}`));
  child.on('exit', code => console.log(`[A${i}] Exited with code ${code}`));
  children.push(child);
}

// Wait for all to complete
Promise.all(children.map(c => new Promise(r => c.on('exit', r)))).then(() => {
  console.log('\n[MULTI] All agents complete');
  process.exit(0);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[MULTI] Shutting down...');
  children.forEach(c => c.kill());
  process.exit(0);
});
