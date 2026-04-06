#!/usr/bin/env node
'use strict';
/**
 * core/reflex.js — Reflex tier: sub-100ms survival heuristics.
 * These are hardcoded rules, NOT LLM-driven.
 *
 * Checks run every game tick. When triggered, they interrupt
 * whatever the skill/strategy tier is doing.
 */

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray',
  'blaze', 'ghast', 'magma_cube', 'wither_skeleton',
  'pillager', 'vindicator', 'ravager', 'evoker', 'cave_spider',
]);

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'apple', 'cooked_chicken',
  'baked_potato', 'cooked_mutton', 'cooked_salmon', 'cooked_cod',
  'melon_slice', 'carrot', 'potato', 'beetroot', 'sweet_berries',
  'dried_kelp', 'golden_apple', 'golden_carrot',
]);

class ReflexTier {
  constructor(bot, opts = {}) {
    this.bot = bot;
    this.active = false;
    this.lastReflex = null;
    this._onTick = null;
    this.audioCapture = opts.audioCapture || null; // optional AudioCapture instance
  }

  /** Start monitoring (hooks into physics tick). */
  start() {
    this._onTick = () => this._check();
    this.bot.on('physicsTick', this._onTick);
    console.log('[REFLEX] Monitoring started');
  }

  /** Stop monitoring. */
  stop() {
    if (this._onTick) {
      this.bot.removeListener('physicsTick', this._onTick);
      this._onTick = null;
    }
  }

  /** Check all reflexes. Called every physics tick (~50ms). */
  _check() {
    if (this.active) return; // don't re-enter while handling a reflex

    const bot = this.bot;
    const pos = bot.entity.position;

    // 1. Hostile mob within 4 blocks → flee
    const nearbyHostile = Object.values(bot.entities).find(e => {
      if (!e.position || e === bot.entity) return false;
      const dist = e.position.distanceTo(pos);
      return dist < 4 && HOSTILE_MOBS.has(e.name?.toLowerCase());
    });

    if (nearbyHostile) {
      this._triggerFlee(nearbyHostile);
      return;
    }

    // 2. Health critical (<= 4 hearts = 8 HP) → eat if possible
    if (bot.health <= 8 && bot.food < 18) {
      const food = bot.inventory.items().find(i => FOOD_ITEMS.has(i.name));
      if (food) {
        this._triggerEat(food);
        return;
      }
    }

    // 3. Audio threat: critical sound behind player → dodge
    if (this.audioCapture) {
      const threats = this.audioCapture.getThreatEvents(2000);
      const critical = threats.find(t =>
        t.threatInfo?.urgency === 'critical' && t.distance && t.distance < 10
      );
      if (critical) {
        this._triggerAudioDodge(critical);
        return;
      }
    }

    // 4. On fire → jump into water or crouch
    if (bot.entity.isOnFire) {
      this._triggerFireResponse();
      return;
    }
  }

  async _triggerFlee(entity) {
    this.active = true;
    this.lastReflex = { type: 'flee', entity: entity.name, time: Date.now() };
    console.log(`[REFLEX] FLEE from ${entity.name} at ${entity.position.distanceTo(this.bot.entity.position).toFixed(0)}m`);

    // Sprint away from the hostile
    const bot = this.bot;
    const away = bot.entity.position.minus(entity.position).normalize();
    const target = bot.entity.position.plus(away.scaled(10));
    await bot.lookAt(target);
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);

    setTimeout(() => {
      bot.setControlState('sprint', false);
      bot.setControlState('forward', false);
      this.active = false;
    }, 3000);
  }

  async _triggerEat(food) {
    this.active = true;
    this.lastReflex = { type: 'eat', food: food.name, time: Date.now() };
    console.log(`[REFLEX] EAT ${food.name} (HP: ${this.bot.health})`);

    try {
      await this.bot.equip(food, 'hand');
      await this.bot.consume();
    } catch (e) {
      // ignore eat failures
    }
    this.active = false;
  }

  async _triggerAudioDodge(soundEvent) {
    this.active = true;
    this.lastReflex = { type: 'audio_dodge', sound: soundEvent.name, direction: soundEvent.direction, time: Date.now() };
    console.log(`[REFLEX] AUDIO DODGE — ${soundEvent.name} from ${soundEvent.direction} at ${soundEvent.distance}m`);

    const bot = this.bot;
    // Sprint away from the sound direction
    // If sound is behind → sprint forward. If left → sprint right. Etc.
    const dir = soundEvent.direction;
    if (dir === 'behind') {
      bot.setControlState('forward', true);
    } else if (dir === 'front') {
      bot.setControlState('back', true);
    } else if (dir === 'left') {
      bot.setControlState('right', true);
    } else {
      bot.setControlState('left', true);
    }
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);

    setTimeout(() => {
      for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) {
        bot.setControlState(c, false);
      }
      this.active = false;
    }, 1500);
  }

  async _triggerFireResponse() {
    this.active = true;
    this.lastReflex = { type: 'fire', time: Date.now() };
    console.log('[REFLEX] ON FIRE — crouching');

    this.bot.setControlState('sneak', true);
    setTimeout(() => {
      this.bot.setControlState('sneak', false);
      this.active = false;
    }, 2000);
  }
}

module.exports = { ReflexTier, HOSTILE_MOBS, FOOD_ITEMS };
