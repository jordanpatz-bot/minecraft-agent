#!/usr/bin/env node
'use strict';
/**
 * perception/generate-labels.js — Convert paired state data to YOLO labels.
 *
 * For each frame, projects ground truth entity 3D positions into 2D screen
 * coordinates using the camera parameters, then outputs YOLO-format labels.
 *
 * YOLO format: class_id center_x center_y width height (normalized 0-1)
 *
 * Usage: node perception/generate-labels.js [--capture-dir ./data/captures]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CAPTURE_DIR = args.find((_, i, a) => a[i - 1] === '--capture-dir') ||
  path.join(__dirname, '..', 'data', 'captures');
const LABEL_DIR = path.join(CAPTURE_DIR, '..', 'labels');

// Class mapping for entity types
const CLASSES = {
  'Zombie': 0,
  'Skeleton': 1,
  'Creeper': 2,
  'Spider': 3,
  'Slime': 4,
  'Enderman': 5,
  'Witch': 6,
  'Cow': 7,
  'Pig': 8,
  'Sheep': 9,
  'Chicken': 10,
  'Squid': 11,
  'Cod': 12,
  'Item': 13,
  'Villager': 14,
};

// Camera parameters matching prismarine-viewer defaults
const FOV = 75 * (Math.PI / 180); // 75 degrees
const ASPECT = 1280 / 720;
const NEAR = 0.1;
const FAR = 1000;
const IMG_W = 1280;
const IMG_H = 720;

/**
 * Project a 3D world position to 2D screen coordinates.
 * Uses perspective projection matching prismarine-viewer's camera.
 */
function projectToScreen(entityPos, playerPos, playerYaw, playerPitch) {
  // Relative position
  const dx = entityPos.x - playerPos.x;
  const dy = entityPos.y - playerPos.y;
  const dz = entityPos.z - playerPos.z;

  // Rotate by player yaw (around Y axis) and pitch (around X axis)
  const cosYaw = Math.cos(-playerYaw);
  const sinYaw = Math.sin(-playerYaw);
  const cosPitch = Math.cos(-playerPitch);
  const sinPitch = Math.sin(-playerPitch);

  // Yaw rotation (Y axis)
  const rx = dx * cosYaw - dz * sinYaw;
  const ry = dy;
  const rz = dx * sinYaw + dz * cosYaw;

  // Pitch rotation (X axis)
  const fx = rx;
  const fy = ry * cosPitch - rz * sinPitch;
  const fz = ry * sinPitch + rz * cosPitch;

  // Behind camera check
  if (fz <= 0) return null;

  // Perspective projection
  const fovScale = 1 / Math.tan(FOV / 2);
  const screenX = (fx * fovScale / (fz * ASPECT)) * 0.5 + 0.5;
  const screenY = (-fy * fovScale / fz) * 0.5 + 0.5;

  // Out of frame check
  if (screenX < 0 || screenX > 1 || screenY < 0 || screenY > 1) return null;

  return { x: screenX, y: screenY, depth: fz };
}

/**
 * Estimate entity bounding box size based on distance.
 * Approximate — real size depends on entity type and model.
 */
function estimateBBox(entityName, depth) {
  // Base entity sizes (width, height in blocks)
  const sizes = {
    'Zombie': { w: 0.6, h: 1.95 },
    'Skeleton': { w: 0.6, h: 1.99 },
    'Creeper': { w: 0.6, h: 1.7 },
    'Spider': { w: 1.4, h: 0.9 },
    'Slime': { w: 2.04, h: 2.04 }, // large slime
    'Enderman': { w: 0.6, h: 2.9 },
    'Witch': { w: 0.6, h: 1.95 },
    'Cow': { w: 0.9, h: 1.4 },
    'Pig': { w: 0.9, h: 0.9 },
    'Sheep': { w: 0.9, h: 1.3 },
    'Chicken': { w: 0.4, h: 0.7 },
    'Squid': { w: 0.8, h: 0.8 },
    'Cod': { w: 0.5, h: 0.3 },
    'Item': { w: 0.25, h: 0.25 },
    'Villager': { w: 0.6, h: 1.95 },
  };

  const size = sizes[entityName] || { w: 0.6, h: 1.0 };
  const fovScale = 1 / Math.tan(FOV / 2);

  // Project size to screen space
  const screenW = (size.w * fovScale / (depth * ASPECT));
  const screenH = (size.h * fovScale / depth);

  return { w: Math.min(screenW, 1.0), h: Math.min(screenH, 1.0) };
}

function main() {
  fs.mkdirSync(LABEL_DIR, { recursive: true });

  const stateFiles = fs.readdirSync(CAPTURE_DIR)
    .filter(f => f.startsWith('state_') && f.endsWith('.json'))
    .sort();

  console.log(`Processing ${stateFiles.length} states from ${CAPTURE_DIR}`);
  console.log(`Labels output: ${LABEL_DIR}`);

  let totalLabels = 0;
  let framesWithEntities = 0;
  const classCounts = {};

  for (const stateFile of stateFiles) {
    const idx = stateFile.replace('state_', '').replace('.json', '');
    const state = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, stateFile), 'utf8'));

    const player = state.player;
    const entities = state.entities || [];

    const labels = [];

    for (const entity of entities) {
      const className = entity.name;
      const classId = CLASSES[className];
      if (classId === undefined) continue; // unknown entity type

      const screenPos = projectToScreen(
        { x: entity.x, y: entity.y, z: entity.z },
        { x: player.x, y: player.y + 1.62, z: player.z }, // eye height
        player.yaw,
        player.pitch
      );

      if (!screenPos) continue; // behind camera or out of frame

      const bbox = estimateBBox(className, screenPos.depth);
      if (bbox.w < 0.005 || bbox.h < 0.005) continue; // too small to see

      // YOLO format: class_id center_x center_y width height
      labels.push(`${classId} ${screenPos.x.toFixed(6)} ${screenPos.y.toFixed(6)} ${bbox.w.toFixed(6)} ${bbox.h.toFixed(6)}`);
      classCounts[className] = (classCounts[className] || 0) + 1;
      totalLabels++;
    }

    // Write label file (even if empty — YOLO needs empty files for negative examples)
    const labelFile = path.join(LABEL_DIR, `frame_${idx}.txt`);
    fs.writeFileSync(labelFile, labels.join('\n'));

    if (labels.length > 0) framesWithEntities++;
  }

  // Write classes file
  const classNames = Object.entries(CLASSES).sort((a, b) => a[1] - b[1]).map(e => e[0]);
  fs.writeFileSync(path.join(LABEL_DIR, 'classes.txt'), classNames.join('\n'));

  // Write dataset config
  const datasetConfig = {
    path: path.resolve(CAPTURE_DIR, '..'),
    train: 'captures',
    val: 'captures',
    nc: classNames.length,
    names: classNames,
  };
  fs.writeFileSync(path.join(LABEL_DIR, 'dataset.yaml'),
    `path: ${datasetConfig.path}\ntrain: captures\nval: captures\nnc: ${datasetConfig.nc}\nnames: [${classNames.map(n => `'${n}'`).join(', ')}]\n`);

  console.log(`\n=== LABEL GENERATION COMPLETE ===`);
  console.log(`Total labels: ${totalLabels}`);
  console.log(`Frames with entities: ${framesWithEntities}/${stateFiles.length}`);
  console.log(`Class distribution:`);
  for (const [name, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
  console.log(`\nClasses file: ${path.join(LABEL_DIR, 'classes.txt')}`);
  console.log(`Dataset config: ${path.join(LABEL_DIR, 'dataset.yaml')}`);
}

main();
