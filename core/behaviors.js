#!/usr/bin/env node
'use strict';
/**
 * core/behaviors.js — Behavior engine for autonomous tick-level play.
 *
 * The LLM doesn't micro-manage actions. Instead it composes behaviors:
 *   "follow konigsalat and gather wood when idle"
 *   "explore northeast, mine any ores you find"
 *   "hunt hostile mobs nearby"
 *
 * Behaviors run at tick speed (~50ms) without LLM involvement.
 * The LLM only gets called when:
 *   - A player chats
 *   - The situation changes significantly
 *   - A behavior completes or fails
 *   - A timer fires (every 30-60s regardless)
 *
 * Architecture:
 *   BehaviorEngine manages a stack of active behaviors.
 *   Each behavior has an update() called every tick.
 *   Behaviors can be interrupted by reflexes or LLM decisions.
 */

const pf = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock, GoalFollow } = pf.goals;

// How often each behavior re-evaluates (ms)
const TICK_INTERVAL = 250; // 4 updates per second

/**
 * Base behavior class. All behaviors extend this.
 */
class Behavior {
  constructor(bot, params = {}) {
    this.bot = bot;
    this.params = params;
    this.active = false;
    this.startTime = null;
    this.status = 'idle'; // idle, running, completed, failed
    this.statusMessage = '';
  }

  start() {
    this.active = true;
    this.startTime = Date.now();
    this.status = 'running';
  }

  stop() {
    this.active = false;
    this.status = 'idle';
    this._clearControls();
  }

  _clearControls() {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      this.bot.setControlState(c, false);
    }
  }

  /** Called every TICK_INTERVAL ms. Override in subclasses. */
  update() {}

  /** Summary for LLM context. */
  describe() { return `${this.constructor.name}: ${this.statusMessage || this.status}`; }
}

/**
 * FOLLOW — Follow a player, staying within range.
 * When target stops moving, optionally perform idle actions.
 */
class FollowBehavior extends Behavior {
  constructor(bot, params = {}) {
    super(bot, params);
    this.targetName = params.target || null;
    this.followRange = params.range || 4;
    this.idleBehavior = params.onIdle || null; // 'gather', 'look_around', null
    this.lastTargetPos = null;
    this.targetStill = false;
    this.targetStillSince = null;
    this.isPathing = false;
    this.idleGathering = false;
  }

  start() {
    super.start();
    this.statusMessage = `Following ${this.targetName}`;
  }

  update() {
    if (!this.active) return;

    const target = this._findTarget();
    if (!target) {
      this.statusMessage = `Can't find ${this.targetName}`;
      return;
    }

    const dist = this.bot.entity.position.distanceTo(target.position);

    // Check if target is moving
    if (this.lastTargetPos) {
      const targetMoved = target.position.distanceTo(this.lastTargetPos) > 0.5;
      if (!targetMoved) {
        if (!this.targetStill) {
          this.targetStill = true;
          this.targetStillSince = Date.now();
        }
      } else {
        this.targetStill = false;
        this.targetStillSince = null;
        this.idleGathering = false;
      }
    }
    this.lastTargetPos = target.position.clone();

    // If too far, pathfind to target
    if (dist > this.followRange + 2) {
      if (!this.isPathing) {
        this.isPathing = true;
        this.idleGathering = false;
        this.statusMessage = `Moving to ${this.targetName} (${dist.toFixed(0)}m)`;
        try {
          this.bot.pathfinder.setGoal(new GoalFollow(target, this.followRange), true);
        } catch {}
      }
    } else if (dist <= this.followRange) {
      // Close enough — stop pathing
      if (this.isPathing) {
        this.isPathing = false;
        try { this.bot.pathfinder.stop(); } catch {}
      }

      // Target is still and we're close — do idle behavior
      if (this.targetStill && this.idleBehavior && !this.idleGathering) {
        const stillFor = Date.now() - (this.targetStillSince || Date.now());
        if (stillFor > 3000) {
          this._doIdleBehavior();
        }
      }

      if (!this.idleGathering) {
        // Look at target
        try {
          this.bot.lookAt(target.position.offset(0, 1.6, 0));
        } catch {}
        this.statusMessage = `Near ${this.targetName} (${dist.toFixed(0)}m)`;
      }
    }
  }

  async _doIdleBehavior() {
    if (this.idleBehavior === 'gather') {
      this.idleGathering = true;
      this.statusMessage = `Gathering while ${this.targetName} is idle`;
      // Find nearest log
      const log = this.bot.findBlock({
        matching: block => block.name.includes('log'),
        maxDistance: 12,
      });
      if (log) {
        try {
          this.bot.pathfinder.setGoal(new GoalNear(log.position.x, log.position.y, log.position.z, 1), true);
          // Wait briefly then try to dig
          setTimeout(async () => {
            try {
              const target = this.bot.blockAt(log.position);
              if (target && target.name.includes('log')) {
                await this.bot.dig(target);
              }
            } catch {}
            this.idleGathering = false;
          }, 4000);
        } catch {
          this.idleGathering = false;
        }
      } else {
        this.idleGathering = false;
      }
    }
  }

  _findTarget() {
    if (!this.targetName) return null;
    return Object.values(this.bot.entities).find(e =>
      e.username?.toLowerCase() === this.targetName.toLowerCase() ||
      e.displayName?.toLowerCase() === this.targetName.toLowerCase()
    );
  }

  stop() {
    super.stop();
    try { this.bot.pathfinder.stop(); } catch {}
  }
}

/**
 * GATHER — Find and collect resources (wood, stone, ores).
 */
class GatherBehavior extends Behavior {
  constructor(bot, params = {}) {
    super(bot, params);
    this.resourceType = params.resource || 'log'; // 'log', 'stone', 'ore', 'any'
    this.maxDistance = params.maxDistance || 32;
    this.isDigging = false;
    this.isPathing = false;
    this.currentTarget = null;
    this.gathered = 0;
    this.targetCount = params.count || Infinity;
    this.lastSearchTime = 0;
  }

  start() {
    super.start();
    this.statusMessage = `Gathering ${this.resourceType}`;
  }

  update() {
    if (!this.active || this.isDigging || this.isPathing) return;
    if (this.gathered >= this.targetCount) {
      this.status = 'completed';
      this.statusMessage = `Gathered ${this.gathered} ${this.resourceType}`;
      return;
    }

    // Don't search too frequently
    if (Date.now() - this.lastSearchTime < 2000) return;
    this.lastSearchTime = Date.now();

    const block = this.bot.findBlock({
      matching: b => this._matchesResource(b),
      maxDistance: this.maxDistance,
    });

    if (!block) {
      this.statusMessage = `No ${this.resourceType} nearby, exploring...`;
      // Wander to find resources
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);
      setTimeout(() => {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
      }, 2000);
      return;
    }

    this.currentTarget = block.position.clone();
    this.statusMessage = `Moving to ${block.name}`;
    this.isPathing = true;

    this.bot.pathfinder.setGoal(
      new GoalNear(block.position.x, block.position.y, block.position.z, 1), true
    );

    // Check if we arrived
    const checkArrival = setInterval(async () => {
      if (!this.active) { clearInterval(checkArrival); return; }
      const dist = this.bot.entity.position.distanceTo(this.currentTarget);
      if (dist < 2.5) {
        clearInterval(checkArrival);
        this.isPathing = false;
        const target = this.bot.blockAt(this.currentTarget);
        if (target && target.name !== 'air' && this._matchesResource(target)) {
          this.isDigging = true;
          this.statusMessage = `Mining ${target.name}`;
          try {
            await this.bot.dig(target);
            this.gathered++;
            this.statusMessage = `Gathered ${this.gathered} ${this.resourceType}`;
          } catch {}
          this.isDigging = false;
        }
      }
    }, 500);

    // Timeout pathfinding after 10s
    setTimeout(() => {
      clearInterval(checkArrival);
      this.isPathing = false;
      this.isDigging = false;
    }, 10000);
  }

  _matchesResource(block) {
    switch (this.resourceType) {
      case 'log': return block.name.includes('log');
      case 'stone': return block.name === 'stone' || block.name === 'cobblestone';
      case 'ore': return block.name.includes('ore');
      case 'any': return block.name.includes('log') || block.name.includes('ore');
      default: return block.name.includes(this.resourceType);
    }
  }

  stop() {
    super.stop();
    try { this.bot.pathfinder.stop(); } catch {}
  }
}

/**
 * EXPLORE — Move in a direction, scanning for interesting things.
 */
class ExploreBehavior extends Behavior {
  constructor(bot, params = {}) {
    super(bot, params);
    this.direction = params.direction || 'random'; // 'north', 'south', 'east', 'west', 'random'
    this.scanInterval = params.scanInterval || 5000;
    this.lastScan = 0;
    this.isMoving = false;
    this.discoveredItems = [];
  }

  start() {
    super.start();
    this.statusMessage = `Exploring ${this.direction}`;
    this._setDirection();
  }

  update() {
    if (!this.active) return;

    // Periodically change direction slightly and scan surroundings
    if (Date.now() - this.lastScan > this.scanInterval) {
      this.lastScan = Date.now();

      // Scan for interesting things
      const pos = this.bot.entity.position;
      const nearbyEntities = Object.values(this.bot.entities)
        .filter(e => e !== this.bot.entity && e.position && e.position.distanceTo(pos) < 20);

      const hostiles = nearbyEntities.filter(e => {
        const n = e.name?.toLowerCase();
        return ['zombie','skeleton','creeper','spider','enderman'].includes(n);
      });

      if (hostiles.length > 0) {
        this.statusMessage = `Exploring — ${hostiles.length} hostile(s) nearby`;
      } else {
        this.statusMessage = `Exploring ${this.direction}`;
      }

      // Small direction variation
      if (this.direction === 'random') {
        this._setDirection();
      }

      // Keep moving
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);

      // Jump occasionally for obstacles
      if (Math.random() < 0.2) {
        this.bot.setControlState('jump', true);
        setTimeout(() => this.bot.setControlState('jump', false), 300);
      }
    }
  }

  _setDirection() {
    const yawMap = {
      north: Math.PI, south: 0, east: -Math.PI / 2, west: Math.PI / 2,
      random: Math.random() * Math.PI * 2,
    };
    const yaw = yawMap[this.direction] || yawMap.random;
    this.bot.look(yaw + (Math.random() - 0.5) * 0.3, 0.1);
  }

  stop() {
    super.stop();
    this._clearControls();
  }
}

/**
 * HUNT — Seek and attack hostile mobs.
 */
class HuntBehavior extends Behavior {
  constructor(bot, params = {}) {
    super(bot, params);
    this.targetTypes = params.targets || ['zombie', 'skeleton', 'spider', 'creeper'];
    this.maxRange = params.range || 20;
    this.isAttacking = false;
    this.currentTarget = null;
    this.kills = 0;
  }

  start() {
    super.start();
    this.statusMessage = 'Hunting hostiles';
    // Equip best weapon
    this._equipWeapon();
  }

  update() {
    if (!this.active || this.isAttacking) return;

    const pos = this.bot.entity.position;
    const target = Object.values(this.bot.entities)
      .filter(e => {
        if (!e.position || e === this.bot.entity) return false;
        const name = e.name?.toLowerCase();
        return this.targetTypes.includes(name) && e.position.distanceTo(pos) < this.maxRange;
      })
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0];

    if (!target) {
      this.statusMessage = 'Hunting — no targets, wandering';
      // Wander to find mobs
      if (Math.random() < 0.1) {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        setTimeout(() => {
          this.bot.setControlState('forward', false);
          this.bot.setControlState('sprint', false);
        }, 2000);
      }
      return;
    }

    this.currentTarget = target;
    const dist = pos.distanceTo(target.position);

    if (dist > 3) {
      // Move toward target
      this.statusMessage = `Hunting ${target.name} (${dist.toFixed(0)}m)`;
      this.bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
    } else {
      // Attack!
      this.statusMessage = `Attacking ${target.name}!`;
      this.isAttacking = true;
      try {
        this.bot.attack(target);
      } catch {}
      setTimeout(() => { this.isAttacking = false; }, 500); // attack cooldown
    }
  }

  async _equipWeapon() {
    const weapons = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];
    for (const w of weapons) {
      const item = this.bot.inventory.items().find(i => i.name === w);
      if (item) {
        try { await this.bot.equip(item, 'hand'); } catch {}
        return;
      }
    }
  }

  stop() {
    super.stop();
    try { this.bot.pathfinder.stop(); } catch {}
  }
}

/**
 * IDLE — Stand still, look around. Lowest priority behavior.
 */
class IdleBehavior extends Behavior {
  constructor(bot, params = {}) {
    super(bot, params);
    this.lookInterval = 3000;
    this.lastLook = 0;
  }

  update() {
    if (!this.active) return;
    if (Date.now() - this.lastLook > this.lookInterval) {
      this.lastLook = Date.now();
      this.bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.3) * 0.4);
      this.statusMessage = 'Idle — looking around';
    }
  }
}


/**
 * COMPOUND — Composable behavior with conditional interrupts.
 *
 * The LLM can say: "follow player, gather when idle, hunt if hostiles nearby"
 * This creates a compound with:
 *   primary: follow(player)
 *   interrupts: [
 *     { condition: 'hostile_nearby', behavior: hunt, range: 10 },
 *     { condition: 'target_idle', behavior: gather, resource: 'log' },
 *   ]
 *
 * The compound checks interrupts each tick and switches sub-behaviors.
 */
class CompoundBehavior extends Behavior {
  constructor(bot, params = {}) {
    super(bot, params);
    this.primaryName = params.primary || 'idle';
    this.primaryParams = params.primaryParams || {};
    this.interrupts = params.interrupts || [];
    this.activeSub = null;
    this.activeSubName = '';
    this.registry = null; // set by engine
    this.lastInterruptCheck = 0;
  }

  start() {
    super.start();
    this._switchTo(this.primaryName, this.primaryParams);
    this.statusMessage = `Compound: ${this.primaryName} (+ ${this.interrupts.length} interrupts)`;
  }

  update() {
    if (!this.active) return;

    // Check interrupts every 2 seconds
    if (Date.now() - this.lastInterruptCheck > 2000) {
      this.lastInterruptCheck = Date.now();
      const triggered = this._checkInterrupts();
      if (triggered) {
        if (this.activeSubName !== triggered.behavior) {
          console.log(`[COMPOUND] Interrupt: ${triggered.condition} → ${triggered.behavior}`);
          this._switchTo(triggered.behavior, triggered.params || {});
        }
      } else if (this.activeSubName !== this.primaryName) {
        // No interrupt active, return to primary
        console.log(`[COMPOUND] Resuming primary: ${this.primaryName}`);
        this._switchTo(this.primaryName, this.primaryParams);
      }
    }

    // Update active sub-behavior
    if (this.activeSub && this.activeSub.active) {
      this.activeSub.update();
      this.statusMessage = `Compound[${this.activeSubName}]: ${this.activeSub.statusMessage}`;
    }
  }

  _checkInterrupts() {
    const pos = this.bot.entity.position;
    if (isNaN(pos.x)) return null;

    for (const interrupt of this.interrupts) {
      switch (interrupt.condition) {
        case 'hostile_nearby': {
          const range = interrupt.range || 15;
          const hostile = Object.values(this.bot.entities).find(e => {
            if (!e.position || e === this.bot.entity) return false;
            const n = e.name?.toLowerCase();
            const isHostile = ['zombie','skeleton','creeper','spider','enderman','witch','slime'].includes(n);
            return isHostile && e.position.distanceTo(pos) < range;
          });
          if (hostile) return interrupt;
          break;
        }
        case 'resource_nearby': {
          const resourceType = interrupt.resource || 'log';
          const block = this.bot.findBlock({
            matching: b => b.name.includes(resourceType),
            maxDistance: interrupt.range || 10,
          });
          if (block) return interrupt;
          break;
        }
        case 'low_health': {
          if (this.bot.health < (interrupt.threshold || 10)) return interrupt;
          break;
        }
        case 'night': {
          if (this.bot.time.timeOfDay >= 13000) return interrupt;
          break;
        }
        case 'target_idle': {
          // Check if follow target is stationary
          if (this.activeSub instanceof FollowBehavior && this.activeSub.targetStill) {
            const stillFor = Date.now() - (this.activeSub.targetStillSince || Date.now());
            if (stillFor > (interrupt.idleThreshold || 5000)) return interrupt;
          }
          break;
        }
      }
    }
    return null;
  }

  _switchTo(name, params) {
    if (this.activeSub) this.activeSub.stop();
    const BehaviorClass = this.registry?.[name];
    if (!BehaviorClass) return;
    this.activeSub = new BehaviorClass(this.bot, params);
    this.activeSubName = name;
    this.activeSub.start();
  }

  stop() {
    super.stop();
    if (this.activeSub) this.activeSub.stop();
  }

  describe() {
    const interruptDesc = this.interrupts.map(i => `${i.condition}→${i.behavior}`).join(', ');
    return `Compound[${this.activeSubName}]: ${this.activeSub?.statusMessage || 'starting'} | interrupts: ${interruptDesc}`;
  }
}


/**
 * BehaviorEngine — manages active behaviors with priority.
 *
 * Supports simple behaviors and compound behaviors with interrupts.
 * The LLM sets behaviors via setBehavior().
 */
class BehaviorEngine {
  constructor(bot) {
    this.bot = bot;
    this.currentBehavior = null;
    this.behaviorName = 'idle';
    this._interval = null;

    // Registry of behavior constructors
    this.registry = {
      follow: FollowBehavior,
      gather: GatherBehavior,
      explore: ExploreBehavior,
      hunt: HuntBehavior,
      idle: IdleBehavior,
      compound: CompoundBehavior,
    };
  }

  /**
   * Set the active behavior. Called by the LLM strategy layer.
   * @param {string} name — behavior name (follow, gather, explore, hunt, idle)
   * @param {object} params — behavior-specific parameters
   */
  setBehavior(name, params = {}) {
    // Stop current behavior
    if (this.currentBehavior) {
      this.currentBehavior.stop();
    }

    const BehaviorClass = this.registry[name];
    if (!BehaviorClass) {
      console.log(`[BEHAVIOR] Unknown behavior: ${name}`);
      return false;
    }

    this.currentBehavior = new BehaviorClass(this.bot, params);
    this.behaviorName = name;
    // Pass registry to compound behaviors so they can create sub-behaviors
    if (this.currentBehavior.registry !== undefined) {
      this.currentBehavior.registry = this.registry;
    }
    this.currentBehavior.start();
    console.log(`[BEHAVIOR] Set: ${name} ${JSON.stringify(params)}`);
    return true;
  }

  /** Start the behavior tick loop. */
  start() {
    if (this._interval) return;
    this._interval = setInterval(() => {
      if (this.currentBehavior && this.currentBehavior.active) {
        try {
          this.currentBehavior.update();
        } catch (e) {
          console.log(`[BEHAVIOR] Error in ${this.behaviorName}: ${e.message}`);
        }
      }
    }, TICK_INTERVAL);

    // Default to idle
    if (!this.currentBehavior) {
      this.setBehavior('idle');
    }
    console.log('[BEHAVIOR] Engine started');
  }

  /** Stop the behavior engine. */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this.currentBehavior) {
      this.currentBehavior.stop();
    }
  }

  /** Get current behavior status for LLM context. */
  getStatus() {
    return {
      behavior: this.behaviorName,
      status: this.currentBehavior?.status || 'none',
      description: this.currentBehavior?.describe() || 'No active behavior',
      params: this.currentBehavior?.params || {},
      runningFor: this.currentBehavior?.startTime
        ? Math.floor((Date.now() - this.currentBehavior.startTime) / 1000)
        : 0,
    };
  }

  /** Check if current behavior completed or failed (triggers LLM re-evaluation). */
  needsReplan() {
    if (!this.currentBehavior) return true;
    return this.currentBehavior.status === 'completed' ||
           this.currentBehavior.status === 'failed';
  }
}

module.exports = {
  BehaviorEngine,
  Behavior,
  FollowBehavior,
  GatherBehavior,
  ExploreBehavior,
  HuntBehavior,
  IdleBehavior,
  CompoundBehavior,
};
