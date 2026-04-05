#!/usr/bin/env node
'use strict';
/**
 * perception/state-capture.js — Phase 1 paired data capture.
 *
 * Runs alongside the bot, capturing paired (screenshot, state) snapshots.
 * Screenshots come from the Minecraft client window via macOS screen capture.
 * State comes from Mineflayer API.
 *
 * Usage:
 *   const { StateCapture } = require('./perception/state-capture');
 *   const capture = new StateCapture(agent, { outputDir: './data/captures' });
 *   capture.start(2.0); // capture every 2 seconds
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class StateCapture {
  constructor(agent, opts = {}) {
    this.agent = agent;
    this.outputDir = opts.outputDir || path.join(__dirname, '..', 'data', 'captures');
    this.index = 0;
    this.interval = null;
    this.metadata = {
      startTime: null,
      frames: 0,
      version: agent.config?.version || 'unknown',
    };

    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /** Start capturing at the given interval (seconds). */
  start(intervalSec = 2.0) {
    this.metadata.startTime = new Date().toISOString();
    console.log(`[CAPTURE] Saving to ${this.outputDir} every ${intervalSec}s`);

    this.interval = setInterval(() => this._capture(), intervalSec * 1000);
    // Capture immediately
    this._capture();
  }

  /** Stop capturing. */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Write metadata
    this.metadata.frames = this.index;
    this.metadata.endTime = new Date().toISOString();
    fs.writeFileSync(
      path.join(this.outputDir, 'metadata.json'),
      JSON.stringify(this.metadata, null, 2)
    );
    console.log(`[CAPTURE] Stopped. ${this.index} frames saved.`);
  }

  /** Capture a single paired (screenshot, state) snapshot. */
  async _capture() {
    try {
      const state = this.agent.getState();
      const idx = String(this.index).padStart(5, '0');

      // Save state
      const statePath = path.join(this.outputDir, `state_${idx}.json`);
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      // Capture screenshot via macOS screencapture
      const framePath = path.join(this.outputDir, `frame_${idx}.jpg`);
      await this._screencapture(framePath);

      this.index++;
      if (this.index % 10 === 0) {
        console.log(`[CAPTURE] ${this.index} frames captured`);
      }
    } catch (err) {
      console.warn(`[CAPTURE] Error: ${err.message}`);
    }
  }

  /** Capture the Minecraft window screenshot. */
  _screencapture(outputPath) {
    return new Promise((resolve, reject) => {
      // Use Python + mss for consistent cross-platform capture (same as Qud)
      const script = `
import mss, json, sys
from PIL import Image

try:
    import Quartz
    windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID)
    mc_win = None
    for w in windows:
        name = w.get(Quartz.kCGWindowName, '') or ''
        owner = w.get(Quartz.kCGWindowOwnerName, '') or ''
        if 'Minecraft' in name or 'minecraft' in owner.lower():
            bounds = w[Quartz.kCGWindowBounds]
            area = bounds['Width'] * bounds['Height']
            if mc_win is None or area > mc_win['area']:
                mc_win = {'left': int(bounds['X']), 'top': int(bounds['Y']),
                          'width': int(bounds['Width']), 'height': int(bounds['Height']),
                          'area': area}
    if mc_win:
        with mss.mss() as sct:
            img = sct.grab(mc_win)
            Image.frombytes('RGB', img.size, img.bgra, 'raw', 'BGRX').save(sys.argv[1], quality=85)
        sys.exit(0)
except ImportError:
    pass

# Fallback: capture primary monitor
with mss.mss() as sct:
    img = sct.grab(sct.monitors[1])
    Image.frombytes('RGB', img.size, img.bgra, 'raw', 'BGRX').save(sys.argv[1], quality=85)
`;
      const proc = spawn('python3', ['-c', script, outputPath], { timeout: 5000 });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`screencapture exit ${code}`)));
      proc.on('error', reject);
    });
  }
}

module.exports = { StateCapture };
