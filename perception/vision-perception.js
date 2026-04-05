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
const fs = require('fs');
const path = require('path');

class VisionPerception {
  constructor(opts = {}) {
    this.detector = new VisionDetector(opts);
    this.lastFrame = null;
    this.lastState = null;
  }

  /**
   * Extract game state from a screenshot.
   * @param {string} framePath — path to screenshot
   * @returns {Promise<object>} state in the same format as bot.getState()
   */
  async perceive(framePath) {
    // Entity detection
    const detections = await this.detector.detect(framePath);

    // Convert detections to entity format matching Mineflayer
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

    // Time of day from frame brightness (TODO: proper classifier)
    // For now, use a simple heuristic

    const state = {
      _source: 'vision',
      player: {
        health: null, // can't determine from screenshot without HUD
        food: null,
        position: null,
      },
      world: {
        isDay: true, // TODO: classify from sky color
      },
      entities,
      nearbyBlocks: [], // TODO: block classifier
      inventory: [], // TODO: HUD reader
      equipment: {},
    };

    this.lastState = state;
    return state;
  }

  /**
   * Run perception on a live viewer, returning vision state.
   * @param {object} page — puppeteer page connected to prismarine-viewer
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

module.exports = { VisionPerception };
