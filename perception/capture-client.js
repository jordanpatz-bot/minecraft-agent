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
  try {
    // Use AppleScript to find Minecraft window
    const script = `
tell application "System Events"
  set windowList to {}
  repeat with proc in (every process whose name contains "java" or name contains "Minecraft")
    repeat with win in (every window of proc)
      set end of windowList to {name of proc, name of win, id of win}
    end repeat
  end repeat
  return windowList
end tell`;
    const result = execSync(`osascript -e '${script}'`, { timeout: 5000 }).toString().trim();
    console.log('[WINDOW] Found:', result);

    // Try CGWindowListCopyWindowInfo approach instead
    const cgResult = execSync(
      `python3 -c "
import json, subprocess
out = subprocess.check_output(['osascript', '-e', '''
tell application \\"System Events\\"
  set wList to {}
  repeat with p in (every process whose background only is false)
    try
      repeat with w in (every window of p)
        set end of wList to (name of p) & \\"|\\" & (name of w) & \\"|\\" & (id of w as text)
      end repeat
    end try
  end repeat
  return wList
end tell
'''])
for line in out.decode().split(', '):
  if 'minecraft' in line.lower() or 'java' in line.lower():
    print(line.strip())
"`, { timeout: 10000 }
    ).toString().trim();

    if (cgResult) {
      console.log('[WINDOW] Minecraft windows:', cgResult);
    }
  } catch (e) {
    console.log('[WINDOW] AppleScript search failed:', e.message.slice(0, 80));
  }

  // Fallback: use screencapture with window selection
  // Get window list via CGWindowListCopyWindowInfo
  try {
    const windowInfo = execSync(
      `python3 -c "
import Quartz, json
options = Quartz.kCGWindowListOptionOnScreenOnly
windowList = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)
for w in windowList:
    name = w.get('kCGWindowOwnerName', '')
    title = w.get('kCGWindowName', '')
    wid = w.get('kCGWindowNumber', 0)
    bounds = w.get('kCGWindowBounds', {})
    width = bounds.get('Width', 0)
    height = bounds.get('Height', 0)
    if width > 400 and height > 300:
        if 'minecraft' in name.lower() or 'minecraft' in (title or '').lower() or ('java' in name.lower() and width > 800):
            print(json.dumps({'name': name, 'title': title, 'id': wid, 'width': width, 'height': height}))
"`, { timeout: 5000 }
    ).toString().trim();

    if (windowInfo) {
      const lines = windowInfo.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const win = JSON.parse(lines[0]);
        console.log(`[WINDOW] Found: ${win.name} "${win.title}" (${win.width}x${win.height}) ID=${win.id}`);
        return win.id;
      }
    }
  } catch (e) {
    console.log('[WINDOW] Quartz search failed:', e.message.slice(0, 80));
  }

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

  // Connect bot for state ground truth
  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'ClientCapBot',
    checkTimeoutInterval: 60000,
  });
  bot.on('error', e => console.log('[BOT ERR]', e.message));
  await new Promise(r => bot.once('spawn', r));
  await sleep(2000);

  const rcon = await Rcon.connect({ host: 'localhost', port: 25575, password: 'botadmin' });

  // If following a player, teleport bot to them
  if (FOLLOW_PLAYER) {
    await rcon.send(`tp ClientCapBot ${FOLLOW_PLAYER}`);
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
          try { await rcon.send(`tp ClientCapBot ${FOLLOW_PLAYER}`); } catch {}
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
