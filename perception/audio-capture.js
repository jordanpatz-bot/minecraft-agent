#!/usr/bin/env node
'use strict';
/**
 * perception/audio-capture.js — Capture sound events from Minecraft.
 *
 * Listens to Mineflayer's sound events and logs them as structured data.
 * Each sound event includes: name, 3D position, volume, pitch, distance,
 * direction relative to player, and timestamp.
 *
 * This module can run standalone for testing or be integrated into
 * capture scripts to pair audio events with visual frames.
 *
 * Sound events are the "ground truth" for later spectrogram-based
 * audio classification training.
 *
 * Usage (standalone):
 *   node perception/audio-capture.js [--duration 60]
 *
 * Usage (integrated):
 *   const { AudioCapture } = require('./perception/audio-capture');
 *   const audio = new AudioCapture(bot);
 *   audio.start();
 *   // ... later ...
 *   const events = audio.getRecentEvents(5000); // last 5 seconds
 *   const threats = audio.getThreatEvents();
 *   audio.stop();
 */

const fs = require('fs');
const path = require('path');

// Sound classification: which sounds indicate threats, resources, or ambient
const THREAT_SOUNDS = {
  'entity.zombie.ambient': { mob: 'zombie', urgency: 'medium' },
  'entity.zombie.step': { mob: 'zombie', urgency: 'low' },
  'entity.zombie.hurt': { mob: 'zombie', urgency: 'low' },
  'entity.skeleton.ambient': { mob: 'skeleton', urgency: 'medium' },
  'entity.skeleton.step': { mob: 'skeleton', urgency: 'low' },
  'entity.skeleton.shoot': { mob: 'skeleton', urgency: 'high' },
  'entity.creeper.primed': { mob: 'creeper', urgency: 'critical' },
  'entity.creeper.hurt': { mob: 'creeper', urgency: 'medium' },
  'entity.spider.ambient': { mob: 'spider', urgency: 'medium' },
  'entity.spider.step': { mob: 'spider', urgency: 'low' },
  'entity.enderman.ambient': { mob: 'enderman', urgency: 'high' },
  'entity.enderman.stare': { mob: 'enderman', urgency: 'critical' },
  'entity.enderman.teleport': { mob: 'enderman', urgency: 'high' },
  'entity.witch.ambient': { mob: 'witch', urgency: 'medium' },
  'entity.slime.squish': { mob: 'slime', urgency: 'low' },
  'entity.phantom.ambient': { mob: 'phantom', urgency: 'high' },
  'entity.phantom.swoop': { mob: 'phantom', urgency: 'critical' },
  'entity.drowned.ambient': { mob: 'drowned', urgency: 'medium' },
  'entity.arrow.hit': { mob: 'unknown_ranged', urgency: 'high' },
  'entity.arrow.shoot': { mob: 'unknown_ranged', urgency: 'high' },
};

const RESOURCE_SOUNDS = {
  'block.wood.break': { resource: 'wood', action: 'break' },
  'block.stone.break': { resource: 'stone', action: 'break' },
  'block.gravel.break': { resource: 'gravel', action: 'break' },
  'entity.item.pickup': { resource: 'item', action: 'pickup' },
  'entity.experience_orb.pickup': { resource: 'xp', action: 'pickup' },
  'block.chest.open': { resource: 'chest', action: 'open' },
};

const AMBIENT_SOUNDS = {
  'ambient.cave': { type: 'cave', mood: 'ominous' },
  'weather.rain': { type: 'rain', mood: 'neutral' },
  'entity.lightning_bolt.thunder': { type: 'thunder', mood: 'danger' },
};

class AudioCapture {
  constructor(bot) {
    this.bot = bot;
    this.events = [];
    this.running = false;
    this.maxEvents = 10000; // rolling buffer
    this._onSound = null;
    this._onHardcodedSound = null;
  }

  start() {
    if (this.running) return;
    this.running = true;

    this._onSound = (soundName, position, volume, pitch) => {
      this._recordEvent({
        source: 'named',
        name: soundName,
        position: { x: +position.x.toFixed(1), y: +position.y.toFixed(1), z: +position.z.toFixed(1) },
        volume, pitch,
      });
    };

    this._onHardcodedSound = (soundId, soundCategory, position, volume, pitch) => {
      const soundName = this.bot.registry?.sounds?.[soundId]?.name || `id_${soundId}`;
      this._recordEvent({
        source: 'hardcoded',
        name: soundName,
        soundId, soundCategory,
        position: position ? { x: +position.x.toFixed(1), y: +position.y.toFixed(1), z: +position.z.toFixed(1) } : null,
        volume, pitch,
      });
    };

    this.bot.on('soundEffectHeard', this._onSound);
    this.bot.on('hardcodedSoundEffectHeard', this._onHardcodedSound);
    console.log('[AUDIO] Sound capture started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._onSound) this.bot.removeListener('soundEffectHeard', this._onSound);
    if (this._onHardcodedSound) this.bot.removeListener('hardcodedSoundEffectHeard', this._onHardcodedSound);
  }

  _recordEvent(rawEvent) {
    const playerPos = this.bot.entity.position;
    const pos = rawEvent.position;

    // Calculate distance and direction relative to player
    let distance = null;
    let direction = null;
    let relativeAngle = null;

    if (pos && playerPos) {
      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      const dz = pos.z - playerPos.z;
      distance = +Math.sqrt(dx*dx + dy*dy + dz*dz).toFixed(1);

      // Angle from player's facing direction
      const soundAngle = Math.atan2(-dx, dz); // MC coordinate system
      const playerYaw = this.bot.entity.yaw;
      relativeAngle = +((soundAngle - playerYaw + Math.PI * 3) % (Math.PI * 2) - Math.PI).toFixed(2);

      // Cardinal-ish direction
      if (Math.abs(relativeAngle) < Math.PI / 4) direction = 'front';
      else if (Math.abs(relativeAngle) > 3 * Math.PI / 4) direction = 'behind';
      else if (relativeAngle > 0) direction = 'left';
      else direction = 'right';
    }

    // Classify the sound
    const cleanName = rawEvent.name.replace('minecraft:', '');
    let classification = 'ambient';
    let threatInfo = null;
    let resourceInfo = null;

    if (THREAT_SOUNDS[cleanName]) {
      classification = 'threat';
      threatInfo = THREAT_SOUNDS[cleanName];
    } else if (RESOURCE_SOUNDS[cleanName]) {
      classification = 'resource';
      resourceInfo = RESOURCE_SOUNDS[cleanName];
    } else if (AMBIENT_SOUNDS[cleanName]) {
      classification = 'ambient_notable';
    }

    const event = {
      timestamp: Date.now(),
      name: cleanName,
      classification,
      position: pos,
      distance,
      direction,
      relativeAngle,
      volume: rawEvent.volume,
      pitch: rawEvent.pitch,
      threatInfo,
      resourceInfo,
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /**
   * Get sound events from the last N milliseconds.
   */
  getRecentEvents(windowMs = 5000) {
    const cutoff = Date.now() - windowMs;
    return this.events.filter(e => e.timestamp > cutoff);
  }

  /**
   * Get threat sounds from the last N milliseconds.
   * Returns sorted by urgency (critical first).
   */
  getThreatEvents(windowMs = 5000) {
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return this.getRecentEvents(windowMs)
      .filter(e => e.classification === 'threat')
      .sort((a, b) => (urgencyOrder[a.threatInfo?.urgency] || 4) - (urgencyOrder[b.threatInfo?.urgency] || 4));
  }

  /**
   * Get a summary suitable for LLM reasoning or reflex processing.
   */
  getSummary(windowMs = 10000) {
    const recent = this.getRecentEvents(windowMs);
    const threats = recent.filter(e => e.classification === 'threat');
    const resources = recent.filter(e => e.classification === 'resource');

    // Aggregate by mob type
    const mobSounds = {};
    for (const t of threats) {
      const mob = t.threatInfo?.mob || 'unknown';
      if (!mobSounds[mob]) mobSounds[mob] = { count: 0, closest: Infinity, direction: null, urgency: 'low' };
      mobSounds[mob].count++;
      if (t.distance !== null && t.distance < mobSounds[mob].closest) {
        mobSounds[mob].closest = t.distance;
        mobSounds[mob].direction = t.direction;
      }
      const urgencyRank = { critical: 4, high: 3, medium: 2, low: 1 };
      if ((urgencyRank[t.threatInfo?.urgency] || 0) > (urgencyRank[mobSounds[mob].urgency] || 0)) {
        mobSounds[mob].urgency = t.threatInfo.urgency;
      }
    }

    return {
      totalSounds: recent.length,
      threats: mobSounds,
      threatCount: threats.length,
      resourceEvents: resources.map(r => ({ name: r.name, distance: r.distance, direction: r.direction })),
      hasCriticalThreat: threats.some(t => t.threatInfo?.urgency === 'critical'),
    };
  }

  /**
   * Save all recorded events to file.
   */
  saveEvents(filepath) {
    fs.writeFileSync(filepath, JSON.stringify(this.events, null, 2));
    console.log(`[AUDIO] Saved ${this.events.length} events to ${filepath}`);
  }
}

module.exports = { AudioCapture };

// --- CLI test mode ---
if (require.main === module) {
  const mineflayer = require('mineflayer');
  const { Rcon } = require('rcon-client');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const DURATION = parseInt(process.argv.find((_, i, a) => a[i-1] === '--duration') || '60');

  async function main() {
    console.log(`[AUDIO TEST] Capturing sound events for ${DURATION}s`);

    const bot = mineflayer.createBot({
      host: 'localhost', port: 25565, username: 'AudioBot',
      checkTimeoutInterval: 60000,
    });
    await new Promise(r => bot.once('spawn', r));

    const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
    await rcon.send('spreadplayers 0 0 0 200 false AudioBot');
    await sleep(3000);

    const audio = new AudioCapture(bot);
    audio.start();

    // Summon some mobs to generate sounds
    const pos = bot.entity.position;
    await rcon.send(`summon zombie ${Math.floor(pos.x)+5} ${Math.floor(pos.y)} ${Math.floor(pos.z)+3}`);
    await rcon.send(`summon skeleton ${Math.floor(pos.x)-5} ${Math.floor(pos.y)} ${Math.floor(pos.z)-3}`);
    await rcon.send(`summon creeper ${Math.floor(pos.x)+8} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`);
    console.log('[TEST] Mobs summoned');

    // Listen for a while
    const interval = setInterval(() => {
      const summary = audio.getSummary(5000);
      if (summary.totalSounds > 0) {
        console.log(`[${audio.events.length} events] Threats: ${JSON.stringify(summary.threats)}`);
      }
    }, 5000);

    await sleep(DURATION * 1000);
    clearInterval(interval);

    audio.saveEvents(path.join(__dirname, '..', 'data', 'audio_events.json'));

    const summary = audio.getSummary(DURATION * 1000);
    console.log('\n=== AUDIO CAPTURE SUMMARY ===');
    console.log(`Total events: ${audio.events.length}`);
    console.log(`Threat events: ${summary.threatCount}`);
    console.log(`Threats:`, JSON.stringify(summary.threats, null, 2));

    // Print unique sound names
    const uniqueSounds = [...new Set(audio.events.map(e => e.name))].sort();
    console.log(`\nUnique sounds (${uniqueSounds.length}):`);
    uniqueSounds.forEach(s => console.log(`  ${s}`));

    await rcon.end();
    process.exit(0);
  }

  main().catch(e => { console.error(e); process.exit(1); });
}
