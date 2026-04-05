#!/usr/bin/env node
'use strict';
/**
 * perception/validate-capture.js — Validate paired data captures.
 * Checks that frame screenshots match their state files.
 *
 * Usage: node perception/validate-capture.js [capture_dir]
 */

const fs = require('fs');
const path = require('path');

const captureDir = process.argv[2] || path.join(__dirname, '..', 'data', 'captures');

if (!fs.existsSync(captureDir)) {
  console.log('No capture directory found:', captureDir);
  process.exit(1);
}

const files = fs.readdirSync(captureDir);
const states = files.filter(f => f.startsWith('state_') && f.endsWith('.json'));
const frames = files.filter(f => f.startsWith('frame_') && f.endsWith('.jpg'));

console.log(`Capture directory: ${captureDir}`);
console.log(`States: ${states.length}, Frames: ${frames.length}`);

if (states.length === 0) {
  console.log('No captures found.');
  process.exit(0);
}

// Check pairing
let paired = 0;
let missing = 0;
for (const state of states) {
  const idx = state.replace('state_', '').replace('.json', '');
  const frame = `frame_${idx}.jpg`;
  if (frames.includes(frame)) {
    paired++;
  } else {
    missing++;
  }
}
console.log(`Paired: ${paired}, Missing frames: ${missing}`);

// Sample a few states for quality check
const samples = states.slice(0, 5);
for (const state of samples) {
  const data = JSON.parse(fs.readFileSync(path.join(captureDir, state), 'utf8'));
  const pos = data.player?.position;
  const entities = data.entities?.length || 0;
  const blocks = data.nearbyBlocks?.length || 0;
  console.log(`  ${state}: pos=(${pos?.x?.toFixed(0)},${pos?.y?.toFixed(0)},${pos?.z?.toFixed(0)}) entities=${entities} blocks=${blocks}`);
}

// Metadata
const metaPath = path.join(captureDir, 'metadata.json');
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  console.log('\nMetadata:', JSON.stringify(meta, null, 2));
}

console.log('\nValidation complete.');
