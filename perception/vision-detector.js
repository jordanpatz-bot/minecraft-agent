#!/usr/bin/env node
'use strict';
/**
 * perception/vision-detector.js — Run YOLO entity detection on frames.
 *
 * Loads the trained YOLOv8 model and provides entity detection
 * from screenshots. Can be used as the vision perception layer
 * instead of Mineflayer API reads.
 *
 * Usage:
 *   const { VisionDetector } = require('./perception/vision-detector');
 *   const detector = new VisionDetector();
 *   const entities = await detector.detect('screenshot.jpg');
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Find best available model
// v7 (mc_entities_v6/best.pt): mAP 0.795 on 5 classes (best for common mobs)
// v8 (mc_entities_v8/best.pt): mAP 0.569 on 12 classes (best coverage)
const MODEL_CANDIDATES = [
  path.join(__dirname, '..', 'runs', 'detect', 'mc_entities_v8', 'weights', 'best.pt'),
  path.join(__dirname, '..', 'runs', 'detect', 'mc_entities_v6', 'weights', 'best.pt'),
  path.join(__dirname, '..', 'runs', 'detect', 'runs', 'detect', 'mc_entities_v3', 'weights', 'best.pt'),
];
const MODEL_PATH = MODEL_CANDIDATES.find(p => fs.existsSync(p)) || MODEL_CANDIDATES[MODEL_CANDIDATES.length - 1];
const CLASS_NAMES = ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Slime', 'Enderman', 'Witch', 'Cow', 'Pig', 'Sheep', 'Chicken', 'Squid', 'Cod', 'Item', 'Villager', 'Player'];

class VisionDetector {
  constructor(opts = {}) {
    this.modelPath = opts.modelPath || MODEL_PATH;
    this.confidence = opts.confidence || 0.25;
    this.classNames = CLASS_NAMES;
  }

  /**
   * Detect entities in an image file.
   * @param {string} imagePath — path to JPEG image
   * @returns {Promise<Array>} detected entities [{name, confidence, x, y, w, h}]
   */
  async detect(imagePath) {
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
                'hostile': cls < 7,  # classes 0-6 are hostile mobs
                'isPlayer': cls == 15,
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
          reject(new Error(`Detection failed: ${stderr.slice(0, 200)}`));
        } else {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            resolve([]);
          }
        }
      });
    });
  }

  /**
   * Compare vision detections against Mineflayer ground truth.
   * @returns {{ recall, precision, detections, groundTruth }}
   */
  static compare(detections, groundTruthEntities) {
    const gtNames = new Set(groundTruthEntities.filter(e => e.distance < 30).map(e => e.name));
    const detNames = new Set(detections.map(d => d.name));

    let tp = 0;
    for (const name of gtNames) {
      if (detNames.has(name)) tp++;
    }

    return {
      recall: gtNames.size > 0 ? tp / gtNames.size : 1,
      precision: detNames.size > 0 ? tp / detNames.size : 1,
      truePositives: tp,
      groundTruthCount: gtNames.size,
      detectionCount: detNames.size,
    };
  }
}

module.exports = { VisionDetector };

// CLI test
if (require.main === module) {
  const detector = new VisionDetector();
  const testFrame = process.argv[2] || 'data/captures/frame_00100.jpg';
  console.log(`Testing on ${testFrame}...`);
  detector.detect(testFrame).then(dets => {
    console.log(`Detected ${dets.length} entities:`);
    for (const d of dets) {
      console.log(`  ${d.name} (${d.confidence}) at [${d.x1},${d.y1},${d.x2},${d.y2}] hostile=${d.hostile}`);
    }
  }).catch(console.error);
}
