#!/usr/bin/env node
'use strict';
/**
 * skills/library.js — Skill storage, retrieval, and execution.
 *
 * Skills are named JS functions with:
 *   - description (for LLM retrieval)
 *   - params (typed parameters)
 *   - dependencies (skills that must exist)
 *   - code (async function body as string)
 *   - postcondition (expression to validate success)
 *   - failCount (auto-deprecate after 3+ failures)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIBRARY_DIR = path.join(__dirname, 'learned');
const INDEX_PATH = path.join(LIBRARY_DIR, 'index.json');

class SkillLibrary {
  constructor() {
    this.skills = {};
    this._load();
  }

  /** Load skills from disk. */
  _load() {
    fs.mkdirSync(LIBRARY_DIR, { recursive: true });
    if (!fs.existsSync(INDEX_PATH)) {
      fs.writeFileSync(INDEX_PATH, '{}');
    }
    try {
      this.skills = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    } catch {
      this.skills = {};
    }
  }

  /** Save skill index to disk. */
  _save() {
    fs.writeFileSync(INDEX_PATH, JSON.stringify(this.skills, null, 2));
  }

  /** List all skills. */
  list() {
    return Object.keys(this.skills).map(name => ({
      name,
      description: this.skills[name].description,
      failCount: this.skills[name].failCount || 0,
    }));
  }

  /** Get a skill by name. */
  get(name) {
    return this.skills[name] || null;
  }

  /** Find skills matching a query (simple keyword search). */
  search(query) {
    const q = query.toLowerCase();
    return this.list().filter(s =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }

  /** Store a new skill. */
  store(skill) {
    const { name, description, params, dependencies, code, postcondition } = skill;
    if (!name || !code) throw new Error('Skill must have name and code');

    this.skills[name] = {
      description: description || '',
      params: params || {},
      dependencies: dependencies || [],
      code,
      postcondition: postcondition || 'true',
      failCount: 0,
      createdAt: new Date().toISOString(),
    };

    // Save code to file
    const codePath = path.join(LIBRARY_DIR, `${name}.js`);
    fs.writeFileSync(codePath, code);

    this._save();
    return { stored: true, name };
  }

  /**
   * Execute a skill against a bot.
   * @param {string} name - skill name
   * @param {object} bot - Mineflayer bot instance
   * @param {object} params - skill parameters
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async execute(name, bot, params = {}) {
    const skill = this.skills[name];
    if (!skill) return { success: false, error: `Skill not found: ${name}` };

    // Check dependencies
    for (const dep of skill.dependencies) {
      if (!this.skills[dep]) {
        return { success: false, error: `Missing dependency: ${dep}` };
      }
    }

    try {
      // Create the function with injected dependencies (same as writer.js)
      const Vec3 = require('vec3').Vec3;
      const { GoalNear, GoalBlock, GoalXZ, GoalFollow } = require('mineflayer-pathfinder').goals;
      const { Movements } = require('mineflayer-pathfinder');
      const mcData = require('minecraft-data')(bot.version);
      const execCode = `return (async () => { ${skill.code} })()`;
      const fn = new Function('bot', 'params', 'Vec3', 'goals', 'Movements', 'mcData', execCode);
      await Promise.race([
        fn(bot, params, Vec3, { GoalNear, GoalBlock, GoalXZ, GoalFollow }, Movements, mcData),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Skill execution timeout (15s)')), 15000)),
      ]);

      // Check postcondition
      const postFn = new Function('bot', 'params', `return (${skill.postcondition})`);
      const passed = postFn(bot, params);

      if (passed) {
        return { success: true };
      } else {
        skill.failCount = (skill.failCount || 0) + 1;
        this._save();
        return { success: false, error: 'Postcondition failed', failCount: skill.failCount };
      }
    } catch (err) {
      skill.failCount = (skill.failCount || 0) + 1;
      this._save();
      return { success: false, error: err.message, failCount: skill.failCount };
    }
  }

  /** Remove a skill. */
  remove(name) {
    if (!this.skills[name]) return false;
    delete this.skills[name];
    const codePath = path.join(LIBRARY_DIR, `${name}.js`);
    try { fs.unlinkSync(codePath); } catch {}
    this._save();
    return true;
  }

  /** Get skills that need rewriting (failCount >= 3). */
  getBroken() {
    return this.list().filter(s => s.failCount >= 3);
  }
}

module.exports = { SkillLibrary };
