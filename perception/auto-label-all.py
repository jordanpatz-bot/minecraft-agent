#!/usr/bin/env python3
"""
Auto-label entity bounding boxes from ALL capture directories.

Improved labeler that:
1. Processes all capture dirs (captures/, gameplay_captures/, entity_captures/)
2. Uses adaptive background subtraction for diverse terrain
3. Matches blobs to ground truth entities by angular position
4. Outputs unified YOLO labels to data/labels/

Usage:
    python3 perception/auto-label-all.py [--visualize]
"""
import json
import os
import sys
import glob
import cv2
import numpy as np
from pathlib import Path
import math

PROJ_DIR = Path(__file__).parent.parent
CAPTURE_DIRS = [
    PROJ_DIR / 'data' / 'captures',
    PROJ_DIR / 'data' / 'gameplay_captures',
    PROJ_DIR / 'data' / 'entity_captures',
]
LABEL_DIR = PROJ_DIR / 'data' / 'labels'
VISUALIZE = '--visualize' in sys.argv

CLASS_MAP = {
    'Zombie': 0, 'Skeleton': 1, 'Creeper': 2, 'Spider': 3, 'Slime': 4,
    'Enderman': 5, 'Witch': 6, 'Cow': 7, 'Pig': 8, 'Sheep': 9,
    'Chicken': 10, 'Squid': 11, 'Cod': 12, 'Item': 13, 'Villager': 14,
}

# Reverse: case-insensitive lookup
CLASS_LOOKUP = {}
for name, idx in CLASS_MAP.items():
    CLASS_LOOKUP[name.lower()] = idx

# Minecraft entity display names → class ID
ENTITY_ALIASES = {
    'zombie': 0, 'skeleton': 1, 'creeper': 2, 'spider': 3, 'slime': 4,
    'enderman': 5, 'witch': 6, 'cow': 7, 'pig': 8, 'sheep': 9,
    'chicken': 10, 'squid': 11, 'cod': 12, 'item': 13, 'villager': 14,
    'cave_spider': 3, 'husk': 0, 'drowned': 0, 'stray': 1,
    'salmon': 12, 'tropical_fish': 12, 'pufferfish': 12,
}

# Image dimensions
IMG_W, IMG_H = 1280, 720

# FOV for projection (prismarine-viewer default)
FOV_H = math.radians(70)
FOV_V = FOV_H * IMG_H / IMG_W


def get_class_id(entity_name):
    """Map entity name/displayName to class ID."""
    if not entity_name:
        return None
    name = entity_name.lower().replace(' ', '_')
    if name in ENTITY_ALIASES:
        return ENTITY_ALIASES[name]
    # Try partial match
    for key, val in ENTITY_ALIASES.items():
        if key in name or name in key:
            return val
    return None


def project_entity_to_screen(entity, player):
    """Project 3D entity position to 2D screen coordinates."""
    # Relative position
    dx = entity['x'] - player['x']
    dy = entity['y'] - player['y']
    dz = entity['z'] - player['z']

    # Player facing direction
    yaw = player.get('yaw', 0)
    pitch = player.get('pitch', 0)

    # Rotate by yaw (around Y axis)
    cos_y = math.cos(-yaw)
    sin_y = math.sin(-yaw)
    rx = dx * cos_y - dz * sin_y
    rz = dx * sin_y + dz * cos_y

    # Entity behind player
    if rz <= 0.1:
        return None

    # Rotate by pitch (around X axis)
    cos_p = math.cos(pitch)
    sin_p = math.sin(pitch)
    ry = dy * cos_p - rz * sin_p
    rz2 = dy * sin_p + rz * cos_p

    if rz2 <= 0.1:
        return None

    # Project to screen
    sx = (rx / rz2) / math.tan(FOV_H / 2)
    sy = (ry / rz2) / math.tan(FOV_V / 2)

    # Convert from [-1,1] to pixel coordinates
    px = (1 + sx) * IMG_W / 2
    py = (1 - sy) * IMG_H / 2

    return px, py


def adaptive_background_mask(frame):
    """Create background mask adaptive to terrain type, not just flat sky."""
    h, w = frame.shape[:2]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # Multiple background detection strategies:

    # 1. Sky: high brightness, low saturation, blue-ish hue in top portion
    sky_mask = np.zeros((h, w), dtype=np.uint8)
    top_quarter = frame[:h//3]
    # Find dominant color in top third (likely sky)
    pixels = top_quarter.reshape(-1, 3).astype(np.float32)
    if len(pixels) > 100:
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
        _, labels, centers = cv2.kmeans(pixels, 2, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
        # The more common cluster in the top is the sky
        counts = np.bincount(labels.flatten())
        sky_color = centers[np.argmax(counts)].astype(np.int16)
        # Mark pixels similar to sky color
        diff = np.abs(frame.astype(np.int16) - sky_color)
        sky_mask = np.all(diff < 35, axis=2).astype(np.uint8) * 255

    # 2. Ground: detect large uniform regions in bottom half
    ground_mask = np.zeros((h, w), dtype=np.uint8)
    bottom_half = frame[h//2:]
    bottom_hsv = hsv[h//2:]
    # Ground tends to be low saturation, variable value
    low_sat = bottom_hsv[:, :, 1] < 40
    ground_mask[h//2:] = low_sat.astype(np.uint8) * 255

    # 3. Large connected components are likely background (terrain)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 30, 100)
    # Dilate edges to connect nearby edges
    kernel = np.ones((5, 5), np.uint8)
    edges = cv2.dilate(edges, kernel, iterations=1)
    # Regions WITHOUT edges are likely smooth background
    smooth = (edges == 0).astype(np.uint8) * 255

    # Combine background signals
    bg_mask = cv2.bitwise_or(sky_mask, ground_mask)

    return bg_mask


def detect_blobs(frame, bg_mask):
    """Find foreground blobs (potential entities)."""
    h, w = frame.shape[:2]

    # Foreground is where background mask is NOT set
    fg = cv2.bitwise_not(bg_mask)

    # Clean up
    kernel_small = np.ones((3, 3), np.uint8)
    kernel_med = np.ones((5, 5), np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel_small)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel_med)

    contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    blobs = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < 30 or area > w * h * 0.25:
            continue

        x, y, bw, bh = cv2.boundingRect(c)
        # Reject very thin or very wide blobs (likely terrain artifacts)
        aspect = bw / max(bh, 1)
        if aspect > 5 or aspect < 0.1:
            continue

        # Get mean color
        blob_mask_roi = fg[y:y+bh, x:x+bw]
        blob_pixels = frame[y:y+bh, x:x+bw]
        if np.sum(blob_mask_roi) == 0:
            continue
        mean_color = cv2.mean(blob_pixels, mask=blob_mask_roi)[:3]

        blobs.append({
            'x': x, 'y': y, 'w': bw, 'h': bh,
            'cx': (x + bw / 2), 'cy': (y + bh / 2),
            'area': area, 'color': mean_color,
        })

    return blobs


def match_blobs_to_entities(blobs, entities, player):
    """Match detected blobs to ground truth entities via projection."""
    matches = []
    used_blobs = set()
    used_entities = set()

    # Project all entities to screen
    projected = []
    for i, ent in enumerate(entities):
        if ent.get('distance', 100) > 35:
            continue
        class_id = get_class_id(ent.get('name', ''))
        if class_id is None:
            continue
        screen_pos = project_entity_to_screen(ent, player)
        if screen_pos is None:
            continue
        px, py = screen_pos
        if 0 <= px < IMG_W and 0 <= py < IMG_H:
            projected.append((i, px, py, class_id, ent))

    # Match each projected entity to closest blob
    for ent_idx, px, py, class_id, ent in projected:
        best_blob = None
        best_dist = float('inf')

        for j, blob in enumerate(blobs):
            if j in used_blobs:
                continue
            dist = math.sqrt((blob['cx'] - px)**2 + (blob['cy'] - py)**2)
            # Allow generous matching radius (projection isn't perfect)
            max_radius = max(150, ent.get('distance', 10) * 10)
            if dist < max_radius and dist < best_dist:
                best_dist = dist
                best_blob = j

        if best_blob is not None:
            used_blobs.add(best_blob)
            used_entities.add(ent_idx)
            blob = blobs[best_blob]
            matches.append({
                'blob': blob,
                'entity': ent,
                'class_id': class_id,
                'proj_dist': best_dist,
            })

    return matches


def process_frame(frame_path, state_path):
    """Process one frame+state pair, return YOLO labels."""
    frame = cv2.imread(frame_path)
    if frame is None:
        return [], None

    with open(state_path) as f:
        state = json.load(f)

    entities = state.get('entities', [])
    player = state.get('player', {})
    h, w = frame.shape[:2]

    # Detect foreground blobs
    bg_mask = adaptive_background_mask(frame)
    blobs = detect_blobs(frame, bg_mask)

    # Match blobs to ground truth entities
    matches = match_blobs_to_entities(blobs, entities, player)

    labels = []
    for m in matches:
        blob = m['blob']
        class_id = m['class_id']

        # YOLO format: class cx cy w h (normalized 0-1)
        cx = blob['cx'] / w
        cy = blob['cy'] / h
        nw = blob['w'] / w
        nh = blob['h'] / h

        # Clamp to valid range
        cx = max(0, min(1, cx))
        cy = max(0, min(1, cy))
        nw = max(0.005, min(0.5, nw))
        nh = max(0.005, min(0.5, nh))

        labels.append(f"{class_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

    vis_frame = None
    if VISUALIZE and matches:
        vis_frame = frame.copy()
        for m in matches:
            b = m['blob']
            cv2.rectangle(vis_frame, (b['x'], b['y']),
                         (b['x']+b['w'], b['y']+b['h']), (0, 255, 0), 2)
            label = list(CLASS_MAP.keys())[m['class_id']]
            cv2.putText(vis_frame, f"{label} d={m['proj_dist']:.0f}",
                       (b['x'], b['y']-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

    return labels, vis_frame


def main():
    LABEL_DIR.mkdir(parents=True, exist_ok=True)

    if VISUALIZE:
        vis_dir = PROJ_DIR / 'data' / 'label_viz'
        vis_dir.mkdir(parents=True, exist_ok=True)

    total_frames = 0
    total_labels = 0
    frames_with_labels = 0
    class_counts = {}

    for cap_dir in CAPTURE_DIRS:
        if not cap_dir.exists():
            print(f"[SKIP] {cap_dir} not found")
            continue

        frames = sorted(cap_dir.glob('frame_*.jpg'))
        print(f"\n[DIR] {cap_dir.name}: {len(frames)} frames")

        dir_labels = 0
        for frame_path in frames:
            idx = frame_path.stem.replace('frame_', '')
            state_path = cap_dir / f'state_{idx}.json'

            if not state_path.exists():
                continue

            total_frames += 1

            # Use source directory prefix to avoid collisions between dirs
            prefix = cap_dir.name[:3]  # 'cap', 'gam', 'ent'
            label_name = f'{prefix}_{idx}'

            labels, vis_frame = process_frame(str(frame_path), str(state_path))

            # Write label file (even if empty — YOLO needs the file)
            label_path = LABEL_DIR / f'{label_name}.txt'
            with open(label_path, 'w') as f:
                f.write('\n'.join(labels))

            # Copy frame with matching name for YOLO dataset
            import shutil
            img_dest = LABEL_DIR / f'{label_name}.jpg'
            if not img_dest.exists():
                shutil.copy2(str(frame_path), str(img_dest))

            if labels:
                frames_with_labels += 1
                dir_labels += len(labels)
                for l in labels:
                    cls = int(l.split()[0])
                    cls_name = list(CLASS_MAP.keys())[cls]
                    class_counts[cls_name] = class_counts.get(cls_name, 0) + 1

            if VISUALIZE and vis_frame is not None:
                cv2.imwrite(str(vis_dir / f'{label_name}.jpg'), vis_frame)

            total_labels += len(labels)

        print(f"  → {dir_labels} labels")

    # Write classes file
    class_names = sorted(CLASS_MAP.keys(), key=lambda k: CLASS_MAP[k])
    with open(LABEL_DIR / 'classes.txt', 'w') as f:
        f.write('\n'.join(class_names))

    print(f"\n=== LABELING COMPLETE ===")
    print(f"Frames processed: {total_frames}")
    print(f"Frames with labels: {frames_with_labels}/{total_frames}")
    print(f"Total labels: {total_labels}")
    print(f"\nPer-class counts:")
    for name, count in sorted(class_counts.items(), key=lambda x: -x[1]):
        print(f"  {name}: {count}")
    print(f"\nOutput: {LABEL_DIR}")


if __name__ == '__main__':
    main()
