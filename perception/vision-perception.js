#!/usr/bin/env node
'use strict';
/**
 * perception/vision-perception.js — Vision-based game state extraction.
 *
 * Replaces Mineflayer state reads with vision-based perception:
 * - Entity detection via YOLO model
 * - Block identification (TODO)
 * - Time of day from sky brightness
 *
 * Matches the same format as core/bot.js extractState() so the agent
 * can swap between API and vision seamlessly.
 */

const { VisionDetector } = require('./vision-detector');
const { BlockDetector } = require('./block-detector');
const fs = require('fs');
const path = require('path');

class VisionPerception {
  constructor(opts = {}) {
    this.detector = new VisionDetector(opts);
    this.blockDetector = new BlockDetector(opts.blockOpts || {});
    this.lastFrame = null;
    this.lastState = null;
  }

  /**
   * Extract game state from a screenshot.
   * @param {string} framePath — path to screenshot
   * @returns {Promise<object>} state in the same format as bot.getState()
   */
  async perceive(framePath) {
    // Run entity and block detection in parallel
    const [detections, blockDetections] = await Promise.all([
      this.detector.detect(framePath),
      this.blockDetector.detect(framePath).catch(() => []),
    ]);

    // Convert entity detections to Mineflayer-compatible format
    const entities = detections.map((d, i) => ({
      type: 'mob',
      name: d.name,
      position: { x: 0, y: 0, z: 0 }, // unknown without depth
      distance: estimateDistance(d), // rough estimate from bbox size
      health: null,
      hostile: d.hostile,
      confidence: d.confidence,
      bbox: { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 },
    }));

    // Convert block detections to structured format
    const visibleBlocks = blockDetections.map(b => ({
      name: b.name,
      confidence: b.confidence,
      isResource: b.isResource,
      isDanger: b.isDanger,
      bbox: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
      // Estimate screen position (center of bbox)
      screenX: (b.x1 + b.x2) / 2,
      screenY: (b.y1 + b.y2) / 2,
    }));

    // Time of day from sky color analysis
    const timeInfo = classifyTimeFromFrame(framePath);

    const state = {
      _source: 'vision',
      player: {
        health: null, // not available in prismarine-viewer (no HUD)
        food: null,
        position: null,
      },
      world: {
        isDay: timeInfo.isDay,
        timePhase: timeInfo.phase,
        skyBrightness: timeInfo.brightness,
      },
      entities,
      nearbyBlocks: visibleBlocks,
      inventory: [], // requires Mineflayer API, not visible in viewer
      equipment: {},
    };

    this.lastState = state;
    return state;
  }

  /**
   * Run perception on a live viewer, returning vision state.
   * @param {object} page — Playwright or Puppeteer page connected to prismarine-viewer
   * @returns {Promise<object>} vision state
   */
  async perceiveLive(page) {
    const tmpPath = '/tmp/mc_vision_frame.jpg';
    await page.screenshot({ path: tmpPath, type: 'jpeg', quality: 85 });
    return this.perceive(tmpPath);
  }
}

/**
 * Rough distance estimate from bounding box size.
 * Larger bbox = closer entity.
 */
function estimateDistance(detection) {
  const bboxArea = (detection.x2 - detection.x1) * (detection.y2 - detection.y1);
  // Empirical: a slime at ~5m fills about 50x50px = 2500px²
  // At 10m: ~25x25 = 625px²
  // At 20m: ~12x12 = 144px²
  if (bboxArea > 2000) return 5;
  if (bboxArea > 500) return 10;
  if (bboxArea > 100) return 20;
  return 30;
}

/**
 * Classify time of day from sky color in the top portion of the frame.
 * Uses the average color of the sky region to determine day phase.
 */
function classifyTimeFromFrame(framePath) {
  try {
    const { execSync } = require('child_process');
    // Use Python+cv2 for quick sky analysis
    const script = `
import cv2, json, sys, numpy as np
frame = cv2.imread('${framePath}')
if frame is None:
    print(json.dumps({"isDay": True, "phase": "unknown", "brightness": 128}))
    sys.exit(0)

h, w = frame.shape[:2]
# Sample top 15% of frame for sky color
sky = frame[:int(h*0.15), :]
avg_b, avg_g, avg_r = [float(x) for x in cv2.mean(sky)[:3]]
brightness = (avg_r + avg_g + avg_b) / 3

# Classify based on brightness and color
if brightness > 170:
    phase = "day"
    is_day = True
elif brightness > 120:
    # Dawn/dusk: warm tones (more red)
    if avg_r > avg_b + 20:
        phase = "dusk"
    else:
        phase = "dawn"
    is_day = True
elif brightness > 50:
    phase = "dusk"
    is_day = False
else:
    phase = "night"
    is_day = False

print(json.dumps({"isDay": is_day, "phase": phase, "brightness": round(brightness, 1)}))
`;
    const result = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
    return JSON.parse(result.toString().trim());
  } catch {
    return { isDay: true, phase: 'unknown', brightness: 128 };
  }
}

module.exports = { VisionPerception };
