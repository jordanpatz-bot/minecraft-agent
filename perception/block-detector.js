#!/usr/bin/env node
'use strict';
/**
 * perception/block-detector.js — Run YOLO block detection on frames.
 *
 * Companion to vision-detector.js. Identifies block types in screenshots.
 * Both detectors can run per-frame during gameplay.
 *
 * Usage:
 *   const { BlockDetector } = require('./perception/block-detector');
 *   const detector = new BlockDetector();
 *   const blocks = await detector.detect('screenshot.jpg');
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Find best block model
const MODEL_CANDIDATES = [
  path.join(__dirname, '..', 'runs', 'detect', 'mc_blocks_v1', 'weights', 'best.pt'),
];
const MODEL_PATH = MODEL_CANDIDATES.find(p => fs.existsSync(p)) || MODEL_CANDIDATES[0];

const BLOCK_CLASS_NAMES = [
  'Log', 'Leaves', 'Stone', 'Ore', 'Water', 'Lava',
  'CraftingTable', 'Furnace', 'Chest', 'Sand', 'Dirt',
];

class BlockDetector {
  constructor(opts = {}) {
    this.modelPath = opts.modelPath || MODEL_PATH;
    this.confidence = opts.confidence || 0.3;
    this.classNames = BLOCK_CLASS_NAMES;
  }

  async detect(imagePath) {
    if (!fs.existsSync(this.modelPath)) {
      return []; // no model trained yet
    }

    return new Promise((resolve, reject) => {
      const script = `
import json, sys
from ultralytics import YOLO

model = YOLO('${this.modelPath}')
results = model('${imagePath}', verbose=False, conf=${this.confidence})

detections = []
for r in results:
    if r.boxes is not None:
        for box in r.boxes:
            cls = int(box.cls[0])
            conf = float(box.conf[0])
            xyxy = box.xyxy[0].tolist()
            names = ${JSON.stringify(this.classNames)}
            detections.append({
                'name': names[cls] if cls < len(names) else f'class_{cls}',
                'confidence': round(conf, 3),
                'x1': round(xyxy[0], 1),
                'y1': round(xyxy[1], 1),
                'x2': round(xyxy[2], 1),
                'y2': round(xyxy[3], 1),
                'isResource': cls in [0, 3, 6, 7, 8],  # Log, Ore, CraftingTable, Furnace, Chest
                'isDanger': cls == 5,  # Lava
            })

print(json.dumps(detections))
`;
      const proc = spawn('python3', ['-c', script], { timeout: 10000 });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code !== 0) {
          resolve([]); // fail gracefully
        } else {
          try { resolve(JSON.parse(stdout.trim())); }
          catch { resolve([]); }
        }
      });
    });
  }
}

module.exports = { BlockDetector };
