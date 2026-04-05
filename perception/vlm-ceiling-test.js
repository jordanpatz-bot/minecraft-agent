#!/usr/bin/env node
'use strict';
/**
 * perception/vlm-ceiling-test.js — Phase 1.2: VLM ceiling test.
 *
 * Sends captured frames to Claude Vision (frontier VLM) and scores
 * its perception against Mineflayer ground truth. This establishes
 * the accuracy ceiling for what ANY vision model can extract from
 * a single Minecraft frame.
 *
 * Usage: node perception/vlm-ceiling-test.js [--samples 10] [--capture-dir ./data/captures]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const SAMPLES = parseInt(args.find((_, i, a) => a[i - 1] === '--samples') || '10');
const CAPTURE_DIR = args.find((_, i, a) => a[i - 1] === '--capture-dir') ||
  path.join(__dirname, '..', 'data', 'captures');

const VLM_PROMPT = `You are analyzing a first-person Minecraft screenshot. Describe what you see with precision.

Respond with ONLY a JSON object:
{
  "biome": "plains|forest|desert|jungle|ocean|mountain|swamp|taiga|other",
  "time_of_day": "day|night|dawn|dusk",
  "weather": "clear|rain|snow|thunder",
  "visible_entities": [
    {"type": "zombie|skeleton|creeper|spider|cow|pig|sheep|chicken|squid|villager|player|other", "distance": "near|medium|far"}
  ],
  "visible_blocks": ["grass", "stone", "dirt", "oak_log", "water", "sand", ...],
  "player_status": {
    "holding_item": "nothing|sword|pickaxe|axe|other",
    "health_bar_visible": true/false,
    "hunger_bar_visible": true/false
  },
  "scene_description": "brief 1-sentence description of the scene"
}

Be precise about block types and entity types. Only list what you can actually see.`;

async function main() {
  console.log(`=== VLM Ceiling Test ===`);
  console.log(`Samples: ${SAMPLES}, Capture dir: ${CAPTURE_DIR}`);

  // Find available paired frames
  const files = fs.readdirSync(CAPTURE_DIR);
  const frames = files.filter(f => f.startsWith('frame_') && f.endsWith('.jpg'));
  const states = files.filter(f => f.startsWith('state_') && f.endsWith('.json'));

  console.log(`Available: ${frames.length} frames, ${states.length} states`);

  // Sample evenly across the dataset
  const step = Math.max(1, Math.floor(frames.length / SAMPLES));
  const sampleIndices = [];
  for (let i = 0; i < frames.length && sampleIndices.length < SAMPLES; i += step) {
    const idx = frames[i].replace('frame_', '').replace('.jpg', '');
    const stateFile = `state_${idx}.json`;
    if (states.includes(stateFile)) {
      sampleIndices.push(idx);
    }
  }

  console.log(`Testing ${sampleIndices.length} samples\n`);

  const results = [];

  for (const idx of sampleIndices) {
    const framePath = path.join(CAPTURE_DIR, `frame_${idx}.jpg`);
    const statePath = path.join(CAPTURE_DIR, `state_${idx}.json`);

    const groundTruth = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const frameBase64 = fs.readFileSync(framePath).toString('base64');

    console.log(`--- Sample ${idx} ---`);
    console.log(`Ground truth: ${groundTruth.entities.length} entities, ${groundTruth.blocks.length} blocks`);
    console.log(`  Time: ${groundTruth.world.isDay ? 'day' : 'night'}, Biome: ${groundTruth.world.biome}`);

    // Call Claude Vision
    try {
      const vlmResponse = await callClaudeVision(frameBase64, VLM_PROMPT);
      const vlmParsed = extractJSON(vlmResponse);

      if (vlmParsed) {
        console.log(`VLM says: ${vlmParsed.scene_description}`);

        // Score against ground truth
        const scores = scoreVLM(vlmParsed, groundTruth);
        results.push({ idx, scores, vlm: vlmParsed, groundTruth: summarizeGT(groundTruth) });

        console.log(`  Biome: ${scores.biome ? 'MATCH' : 'MISS'}`);
        console.log(`  Time:  ${scores.timeOfDay ? 'MATCH' : 'MISS'}`);
        console.log(`  Entities: ${scores.entityRecall}/${scores.entityTotal} recalled`);
        console.log(`  Blocks: ${scores.blockRecall}/${scores.blockTotal} types recalled`);
      } else {
        console.log(`  VLM returned unparseable response`);
      }
    } catch (e) {
      console.log(`  VLM error: ${e.message}`);
    }

    console.log();
  }

  // Aggregate scores
  if (results.length > 0) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`VLM CEILING TEST RESULTS (${results.length} samples)`);
    console.log('═'.repeat(50));

    const biomeAcc = results.filter(r => r.scores.biome).length / results.length;
    const timeAcc = results.filter(r => r.scores.timeOfDay).length / results.length;
    const avgEntityRecall = results.reduce((s, r) => s + (r.scores.entityRecall / Math.max(r.scores.entityTotal, 1)), 0) / results.length;
    const avgBlockRecall = results.reduce((s, r) => s + (r.scores.blockRecall / Math.max(r.scores.blockTotal, 1)), 0) / results.length;

    console.log(`Biome accuracy:    ${(biomeAcc * 100).toFixed(0)}%`);
    console.log(`Time accuracy:     ${(timeAcc * 100).toFixed(0)}%`);
    console.log(`Entity recall:     ${(avgEntityRecall * 100).toFixed(0)}%`);
    console.log(`Block type recall: ${(avgBlockRecall * 100).toFixed(0)}%`);

    // Save results
    const reportPath = path.join(CAPTURE_DIR, '..', 'vlm_ceiling_test.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      date: new Date().toISOString(),
      samples: results.length,
      biomeAccuracy: biomeAcc,
      timeAccuracy: timeAcc,
      entityRecall: avgEntityRecall,
      blockTypeRecall: avgBlockRecall,
      details: results,
    }, null, 2));
    console.log(`\nResults saved to ${reportPath}`);
  }
}

function scoreVLM(vlm, gt) {
  // Biome match (fuzzy)
  const gtBiome = (gt.world.biome || 'unknown').toLowerCase();
  const vlmBiome = (vlm.biome || '').toLowerCase();
  const biomeMatch = vlmBiome.includes(gtBiome) || gtBiome.includes(vlmBiome) ||
    (gtBiome === 'unknown' && vlmBiome !== '');

  // Time of day
  const gtDay = gt.world.isDay;
  const vlmDay = vlm.time_of_day === 'day' || vlm.time_of_day === 'dawn';
  const timeMatch = gtDay === vlmDay;

  // Entity recall: how many GT entities did the VLM detect?
  const gtEntityTypes = new Set(gt.entities.filter(e => e.distance < 20).map(e => e.name.toLowerCase()));
  const vlmEntityTypes = new Set((vlm.visible_entities || []).map(e => e.type.toLowerCase()));
  let entityRecall = 0;
  for (const gt of gtEntityTypes) {
    if (vlmEntityTypes.has(gt) || [...vlmEntityTypes].some(v => gt.includes(v) || v.includes(gt))) {
      entityRecall++;
    }
  }

  // Block type recall: how many GT block types did VLM mention?
  const gtBlockTypes = new Set(gt.blocks.map(b => b.name));
  const vlmBlockTypes = new Set((vlm.visible_blocks || []).map(b => b.toLowerCase().replace(/ /g, '_')));
  let blockRecall = 0;
  for (const gt of gtBlockTypes) {
    if (vlmBlockTypes.has(gt) || [...vlmBlockTypes].some(v => gt.includes(v) || v.includes(gt))) {
      blockRecall++;
    }
  }

  return {
    biome: biomeMatch,
    timeOfDay: timeMatch,
    entityRecall,
    entityTotal: gtEntityTypes.size,
    blockRecall,
    blockTotal: gtBlockTypes.size,
  };
}

function summarizeGT(gt) {
  return {
    biome: gt.world.biome,
    isDay: gt.world.isDay,
    entities: gt.entities.filter(e => e.distance < 20).map(e => e.name),
    blockTypes: [...new Set(gt.blocks.map(b => b.name))],
  };
}

async function callClaudeVision(imageBase64, prompt) {
  // Use Claude CLI with image
  const Anthropic = require('@anthropic-ai/sdk');

  // Try SDK first
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    return response.content[0]?.text || '';
  }

  // Fallback: save image to temp file and use Claude CLI
  const tmpPath = '/tmp/mc_vlm_test.jpg';
  fs.writeFileSync(tmpPath, Buffer.from(imageBase64, 'base64'));

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--image', tmpPath, '--model', 'haiku'], {
      timeout: 30000,
    });
    let stdout = '';
    proc.stdout.on('data', d => stdout += d);
    proc.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error('Claude CLI failed')));
    proc.on('error', reject);
  });
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch {} }
  const j = text.match(/(\{[\s\S]*\})/);
  if (j) { try { return JSON.parse(j[1]); } catch {} }
  return null;
}

main().catch(e => { console.error(e); process.exit(1); });
