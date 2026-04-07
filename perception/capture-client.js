#!/usr/bin/env node
'use strict';
/**
 * perception/capture-client.js — Capture from the real Minecraft client window.
 *
 * Uses macOS `screencapture` to grab the actual game window, paired with
 * Mineflayer state data from a bot on the same server. This gives us
 * real-render training data instead of prismarine-viewer approximations.
 *
 * Requirements:
 * - Minecraft client running and connected to the same server
 * - Bot running on the same server (for state ground truth)
 * - macOS (uses screencapture -l for window capture)
 *
 * The bot and human player should be at the same location so the
 * bot's state matches what the client renders. Use RCON to teleport
 * the bot to the player, or vice versa.
 *
 * Usage:
 *   node perception/capture-client.js [--frames 200] [--interval 2]
 *   node perception/capture-client.js --follow PlayerName
 */

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET = parseInt(args.find((_, i, a) => a[i-1] === '--frames') || '200');
const INTERVAL = parseFloat(args.find((_, i, a) => a[i-1] === '--interval') || '2') * 1000;
const FOLLOW_PLAYER = args.find((_, i, a) => a[i-1] === '--follow') || null;
const OUTPUT = path.join(__dirname, '..', 'data', 'client_captures');
fs.mkdirSync(OUTPUT, { recursive: true });

function isHostile(n) {
  return ['zombie','skeleton','creeper','spider','slime','enderman',
    'witch','phantom','drowned','husk','stray','cave_spider'].includes(n?.toLowerCase());
}

/**
 * Find the Minecraft client window ID on macOS.
 * Returns the window ID for use with `screencapture -l`.
 */
function findMinecraftWindow() {
  // Use Quartz CGWindowListCopyWindowInfo to find Minecraft
  try {
    const windowInfo = execSync(
      `python3 -c "
import Quartz, json
options = Quartz.kCGWindowListOptionOnScreenOnly
windowList = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)
candidates = []
for w in windowList:
    name = w.get('kCGWindowOwnerName', '')
    title = w.get('kCGWindowName', '')
    wid = w.get('kCGWindowNumber', 0)
    bounds = w.get('kCGWindowBounds', {})
    width = int(bounds.get('Width', 0))
    height = int(bounds.get('Height', 0))
    area = width * height
    # Match Minecraft: java process with large window, or window with 'minecraft' in title
    is_mc = False
    if 'minecraft' in (title or '').lower():
        is_mc = True
    elif 'java' in name.lower() and width > 600 and height > 400:
        is_mc = True
    if is_mc and area > 200000:
        candidates.append({'name': name, 'title': title, 'id': wid, 'width': width, 'height': height, 'area': area})
# Pick largest window (most likely the game, not a menu)
candidates.sort(key=lambda x: -x['area'])
if candidates:
    print(json.dumps(candidates[0]))
"`, { timeout: 5000 }
    ).toString().trim();

    if (windowInfo) {
      const win = JSON.parse(windowInfo);
      console.log(`[WINDOW] Found MC: ${win.name} "${win.title}" (${win.width}x${win.height}) ID=${win.id}`);
      return win.id;
    }
  } catch (e) {
    console.log('[WINDOW] Quartz search failed:', e.message.slice(0, 60));
  }

  // Fallback: try AppleScript
  try {
    const result = execSync(`osascript -e '
tell application "System Events"
  repeat with p in (every process whose name contains "java")
    try
      set w to first window of p
      return id of w
    end try
  end repeat
end tell'`, { timeout: 5000 }).toString().trim();
    if (result) {
      console.log(`[WINDOW] Found via AppleScript: ${result}`);
      return parseInt(result);
    }
  } catch {}

  return null;
}

/**
 * Capture a screenshot of a specific window by ID.
 */
function captureWindow(windowId, outputPath) {
  try {
    if (windowId) {
      execSync(`screencapture -l ${windowId} -x "${outputPath}"`, { timeout: 5000 });
    } else {
      // Fallback: capture entire screen
      execSync(`screencapture -x "${outputPath}"`, { timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`[CLIENT CAPTURE] Target: ${TARGET} frames, interval: ${INTERVAL}ms`);
  if (FOLLOW_PLAYER) console.log(`[CLIENT CAPTURE] Following player: ${FOLLOW_PLAYER}`);

  // Find Minecraft window
  const windowId = findMinecraftWindow();
  if (!windowId) {
    console.log('[WARN] Could not find Minecraft window — will capture full screen');
    console.log('[WARN] Make sure Minecraft is running and visible');
  }

  // Connect bot for state ground truth (unique name to avoid duplicate login kicks)
  const botName = 'Cam_' + Math.random().toString(36).slice(2, 5);
  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: botName,
    checkTimeoutInterval: 60000,
  });
  bot.on('error', e => console.log('[BOT ERR]', e.message));
  bot.on('kicked', r => console.log('[BOT KICKED]', r));
  await new Promise(r => bot.once('spawn', r));

  // IMMEDIATELY set creative mode so bot can't die
  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });
  await rcon.send(`gamemode creative ${botName}`);
  await sleep(1000);
  console.log('[CAPTURE BOT] Creative mode set — invincible');

  // If following a player, teleport bot to them
  if (FOLLOW_PLAYER) {
    await rcon.send(`tp ${botName} ${FOLLOW_PLAYER}`);
    await sleep(2000);
    console.log(`[FOLLOW] Teleported to ${FOLLOW_PLAYER}`);
  }

  // Audio capture
  const { AudioCapture } = require('./audio-capture');
  const audio = new AudioCapture(bot);
  audio.start();

  let frameIdx = 0;
  const entityTypesSeen = new Set();
  const blockTypesSeen = new Set();

  console.log('[READY] Starting capture — play normally in Minecraft');

  while (frameIdx < TARGET) {
    const idx = String(frameIdx).padStart(5, '0');
    const framePath = path.join(OUTPUT, `frame_${idx}.jpg`);

    // If following player, keep bot near them
    if (FOLLOW_PLAYER) {
      const player = Object.values(bot.entities).find(e =>
        e.username?.toLowerCase() === FOLLOW_PLAYER.toLowerCase()
      );
      if (player && player.position) {
        const dist = bot.entity.position.distanceTo(player.position);
        if (dist > 20) {
          try { await rcon.send(`tp ${botName} ${FOLLOW_PLAYER}`); } catch {}
          await sleep(1000);
        }
        // Look where the player looks for similar viewport
        if (player.yaw !== undefined) {
          await bot.look(player.yaw, player.pitch || 0);
        }
      }
    }

    // Capture screenshot from real client
    const captured = captureWindow(windowId, framePath);
    if (!captured) {
      await sleep(INTERVAL);
      continue;
    }

    // State extraction from bot (ground truth)
    const pos = bot.entity.position;
    if (isNaN(pos.x)) { await sleep(INTERVAL); continue; }

    const entities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 48)
      .map(e => {
        entityTypesSeen.add(e.displayName || e.name);
        return {
          type: e.type, name: e.displayName || e.name,
          x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
          distance: +e.position.distanceTo(pos).toFixed(1),
          hostile: isHostile(e.name),
          isPlayer: e.type === 'player',
          username: e.username || null,
        };
      });

    const blks = new Set();
    for (let dx = -6; dx <= 6; dx++)
      for (let dz = -6; dz <= 6; dz++)
        for (let dy = -3; dy <= 3; dy++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name !== 'air') { blks.add(b.name); blockTypesSeen.add(b.name); }
        }

    const audioEvents = audio.getRecentEvents(INTERVAL + 1000);

    fs.writeFileSync(path.join(OUTPUT, `state_${idx}.json`), JSON.stringify({
      timestamp: Date.now(), frameIdx,
      captureSource: 'client',
      windowId,
      player: {
        x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
        yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
        health: bot.health, food: bot.food,
      },
      world: { time: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000 },
      entities, blockTypes: [...blks],
      audio: {
        events: audioEvents.map(e => ({
          name: e.name, classification: e.classification,
          distance: e.distance, direction: e.direction,
        })),
      },
    }));

    frameIdx++;

    if (frameIdx % 25 === 0) {
      console.log(`[${frameIdx}/${TARGET}] ents=${entityTypesSeen.size} blocks=${blockTypesSeen.size}`);
    }

    await sleep(INTERVAL);
  }

  // Save metadata
  fs.writeFileSync(path.join(OUTPUT, 'metadata.json'), JSON.stringify({
    frames: frameIdx,
    captureSource: 'client',
    entityTypes: [...entityTypesSeen].sort(),
    blockTypes: [...blockTypesSeen].sort(),
  }, null, 2));

  audio.saveEvents(path.join(OUTPUT, 'audio_log.json'));

  console.log(`\n=== CLIENT CAPTURE DONE: ${frameIdx} frames ===`);
  console.log(`Entity types: ${entityTypesSeen.size}, Block types: ${blockTypesSeen.size}`);
  try { await rcon.end(); } catch {}
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
