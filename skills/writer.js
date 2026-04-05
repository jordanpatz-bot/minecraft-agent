#!/usr/bin/env node
'use strict';
/**
 * skills/writer.js — LLM-powered skill generation and verification.
 *
 * Given a goal, asks the LLM to write Mineflayer code,
 * executes it, checks the postcondition, and stores on success.
 */

const { LLMProvider, extractJSON } = require('../llm/provider');
const { SkillLibrary } = require('./library');

const SKILL_SYSTEM_PROMPT = `You are a Minecraft bot programmer. You write JavaScript code that controls a Mineflayer bot.

The bot object has these key APIs:
- bot.dig(block) — mine a block (async)
- bot.placeBlock(referenceBlock, faceVector) — place a block (async)
- bot.equip(item, destination) — equip item to 'hand', 'head', etc. (async)
- bot.craft(recipe, count, craftingTable) — craft items (async)
- bot.blockAt(position) — get block at position
- bot.findBlock({matching, maxDistance, count}) — find nearby blocks
- bot.inventory.items() — list inventory items
- bot.entity.position — bot's current position
- bot.chat(message) — send chat message
- bot.creative.setInventorySlot(slot, item) — set inventory in creative mode
- bot.pathfinder.goto(goal) — navigate to a goal (async, from mineflayer-pathfinder)
- bot.setControlState(control, state) — set movement (forward, back, left, right, jump, sprint, sneak)
- bot.lookAt(position) — look at a position (async)
- bot.attack(entity) — attack an entity
- bot.activateBlock(block) — interact with a block (crafting table, furnace, etc.)
- bot.tossStack(item) — drop an item

INJECTED VARIABLES (available in your code, do NOT use require()):
- Vec3 — Vec3 class. Use: new Vec3(x, y, z) or pos.offset(dx, dy, dz)
- goals — pathfinder goals. Use: new goals.GoalNear(x, y, z, range), new goals.GoalBlock(x, y, z)
- Movements — pathfinder movements config
- mcData — minecraft-data for the server version

Common patterns:
- Find blocks: bot.findBlock({matching: mcData.blocksByName['oak_log'].id, maxDistance: 32, count: 5})
- Navigate: bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))
- Get position: const pos = bot.entity.position; const below = pos.offset(0, -1, 0);
- Get block below: bot.blockAt(bot.entity.position.offset(0, -1, 0))
- Inventory check: bot.inventory.items().find(i => i.name === 'dirt')

IMPORTANT: Do NOT use require() — all modules are already injected as variables.

You must respond with ONLY a JSON object:
{
  "name": "skillName",
  "description": "what this skill does",
  "code": "// JS code that uses bot and params\\nawait bot.chat('Starting...');\\n// ... your code here",
  "postcondition": "bot.inventory.items().some(i => i.name === 'oak_log')",
  "params": {"paramName": "description"}
}

RULES:
- The code runs inside an async function with (bot, params) arguments
- Use await for all async operations
- Keep code simple and focused on ONE task
- The postcondition must be a JS expression that returns true/false
- Handle errors gracefully — if a block isn't found, don't crash`;

class SkillWriter {
  constructor(opts = {}) {
    this.llm = opts.llm || new LLMProvider({ provider: 'claude', model: 'haiku' });
    this.library = opts.library || new SkillLibrary();
    this.maxRetries = opts.maxRetries || 3;
  }

  /**
   * Generate a skill from a natural language goal.
   * @param {string} goal - what the skill should accomplish
   * @param {object} context - current game state for context
   * @returns {Promise<object>} the generated skill definition
   */
  async generate(goal, context = {}) {
    const contextStr = context.inventory
      ? `\nCurrent inventory: ${JSON.stringify(context.inventory)}\nPosition: ${JSON.stringify(context.position)}\nNearby blocks: ${JSON.stringify(context.nearbyBlocks?.slice(0, 20))}`
      : '';

    const prompt = `Write a Mineflayer skill for this goal: "${goal}"${contextStr}

Existing skills in library: ${this.library.list().map(s => s.name).join(', ') || 'none'}`;

    const response = await this.llm.call(SKILL_SYSTEM_PROMPT, prompt);
    const skill = extractJSON(response);

    if (!skill || !skill.name || !skill.code) {
      throw new Error(`LLM returned invalid skill: ${response.slice(0, 200)}`);
    }

    return skill;
  }

  /**
   * Generate, execute, verify, and store a skill.
   * Retries with error feedback on failure.
   * @param {string} goal
   * @param {object} bot - Mineflayer bot instance
   * @param {object} context - game state
   * @returns {Promise<{success: boolean, skill?: object, error?: string}>}
   */
  async writeAndVerify(goal, bot, context = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      console.log(`[SKILL] Attempt ${attempt}/${this.maxRetries}: "${goal}"`);

      try {
        // Generate skill (include previous error for retry context)
        const errorContext = lastError
          ? `\n\nPREVIOUS ATTEMPT FAILED with error: ${lastError}\nFix the issue and try a different approach.`
          : '';
        const prompt = `Write a Mineflayer skill for this goal: "${goal}"${errorContext}`;
        const response = await this.llm.call(SKILL_SYSTEM_PROMPT, prompt + (context.inventory ? `\nInventory: ${JSON.stringify(context.inventory)}` : ''));
        const skill = extractJSON(response);

        if (!skill || !skill.name || !skill.code) {
          lastError = `Invalid skill JSON: ${response.slice(0, 100)}`;
          continue;
        }

        console.log(`[SKILL] Generated: ${skill.name} — ${skill.description}`);

        // Execute with injected dependencies
        console.log(`[SKILL] Executing...`);
        const execCode = `return (async () => { ${skill.code} })()`;
        const fn = new Function('bot', 'params', 'Vec3', 'goals', 'Movements', 'mcData', execCode);
        const Vec3 = require('vec3').Vec3;
        const { GoalNear, GoalBlock, GoalXZ, GoalFollow } = require('mineflayer-pathfinder').goals;
        const { Movements } = require('mineflayer-pathfinder');
        const mcData = require('minecraft-data')(bot.version);
        await Promise.race([
          fn(bot, skill.params || {}, Vec3, { GoalNear, GoalBlock, GoalXZ, GoalFollow }, Movements, mcData),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Execution timeout (15s)')), 15000)),
        ]);

        // Check postcondition
        console.log(`[SKILL] Checking postcondition: ${skill.postcondition}`);
        const postFn = new Function('bot', 'params', `return (${skill.postcondition})`);
        const passed = postFn(bot, skill.params || {});

        if (passed) {
          console.log(`[SKILL] PASS — storing "${skill.name}"`);
          this.library.store(skill);
          return { success: true, skill, attempts: attempt };
        } else {
          lastError = `Postcondition failed: ${skill.postcondition}`;
          console.log(`[SKILL] Postcondition failed`);
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[SKILL] Error: ${err.message}`);
      }
    }

    return { success: false, error: lastError, attempts: this.maxRetries };
  }
}

module.exports = { SkillWriter };
