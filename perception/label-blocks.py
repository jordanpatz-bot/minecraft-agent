#!/usr/bin/env python3
"""
Label block captures for YOLO block detection training.

Projects 3D block positions to 2D screen coordinates using the player's
camera parameters. Each visible block face gets a bounding box label.

Unlike entity labeling, blocks are the terrain — so we use a region-based
approach: find clusters of the same block class and create bounding boxes
around the clusters.

Usage:
    python3 perception/label-blocks.py
"""

import json
import os
import math
import shutil
from pathlib import Path
from collections import defaultdict

PROJ_DIR = Path(__file__).parent.parent
BLOCK_DIR = PROJ_DIR / 'data' / 'block_captures'
LABEL_DIR = PROJ_DIR / 'data' / 'block_labels'

BLOCK_CLASS_NAMES = [
    'Log', 'Leaves', 'Stone', 'Ore', 'Water', 'Lava',
    'CraftingTable', 'Furnace', 'Chest', 'Sand', 'Dirt',
]

IMG_W, IMG_H = 1280, 720
FOV_H = math.radians(70)
FOV_V = FOV_H * IMG_H / IMG_W


def project_to_screen(block_pos, player):
    """Project 3D block center to 2D screen coordinates."""
    # Block center is at block position + 0.5
    bx = block_pos['x'] + 0.5
    by = block_pos['y'] + 0.5
    bz = block_pos['z'] + 0.5

    dx = bx - player['x']
    dy = by - player['y']
    dz = bz - player['z']

    yaw = player.get('yaw', 0)
    pitch = player.get('pitch', 0)

    # Rotate by yaw
    cos_y = math.cos(-yaw)
    sin_y = math.sin(-yaw)
    rx = dx * cos_y - dz * sin_y
    rz = dx * sin_y + dz * cos_y

    if rz <= 0.5:
        return None

    # Rotate by pitch
    cos_p = math.cos(pitch)
    sin_p = math.sin(pitch)
    ry = dy * cos_p - rz * sin_p
    rz2 = dy * sin_p + rz * cos_p

    if rz2 <= 0.5:
        return None

    # Project
    sx = (rx / rz2) / math.tan(FOV_H / 2)
    sy = (ry / rz2) / math.tan(FOV_V / 2)

    px = (1 + sx) * IMG_W / 2
    py = (1 - sy) * IMG_H / 2

    # Approximate block size on screen (1 block at distance d)
    dist = math.sqrt(dx*dx + dy*dy + dz*dz)
    if dist < 1:
        dist = 1
    block_screen_size = (IMG_W / (2 * dist * math.tan(FOV_H / 2)))

    return px, py, block_screen_size


def main():
    LABEL_DIR.mkdir(parents=True, exist_ok=True)

    if not BLOCK_DIR.exists():
        print(f"No block captures found at {BLOCK_DIR}")
        return

    frames = sorted(BLOCK_DIR.glob('frame_*.jpg'))
    print(f"Processing {len(frames)} block frames")

    total_labels = 0
    class_counts = defaultdict(int)

    for frame_path in frames:
        idx = frame_path.stem.replace('frame_', '')
        state_path = BLOCK_DIR / f'state_{idx}.json'
        if not state_path.exists():
            continue

        with open(state_path) as f:
            state = json.load(f)

        player = state.get('player', {})
        blocks_by_class = state.get('blocksByClass', {})

        labels = []

        for cls_str, blocks in blocks_by_class.items():
            cls_id = int(cls_str)
            if cls_id >= len(BLOCK_CLASS_NAMES):
                continue

            # Project each block and find clusters
            screen_points = []
            for block in blocks:
                if block.get('distance', 100) > 12:
                    continue
                result = project_to_screen(block, player)
                if result is None:
                    continue
                px, py, size = result
                if 0 <= px < IMG_W and 0 <= py < IMG_H:
                    screen_points.append((px, py, size))

            if not screen_points:
                continue

            # Create bounding boxes around clusters of nearby points
            # Simple approach: merge overlapping bboxes
            bboxes = []
            for px, py, size in screen_points:
                half = max(size * 0.6, 15)  # minimum 15px bbox
                bboxes.append([px - half, py - half, px + half, py + half])

            # Merge overlapping bboxes
            merged = merge_bboxes(bboxes, overlap_threshold=0.3)

            for bbox in merged:
                x1, y1, x2, y2 = bbox
                # Clamp to image
                x1 = max(0, min(IMG_W, x1))
                y1 = max(0, min(IMG_H, y1))
                x2 = max(0, min(IMG_W, x2))
                y2 = max(0, min(IMG_H, y2))

                w = x2 - x1
                h = y2 - y1
                if w < 10 or h < 10:
                    continue
                if w > IMG_W * 0.8 or h > IMG_H * 0.8:
                    continue

                cx = ((x1 + x2) / 2) / IMG_W
                cy = ((y1 + y2) / 2) / IMG_H
                nw = w / IMG_W
                nh = h / IMG_H

                labels.append(f"{cls_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
                class_counts[BLOCK_CLASS_NAMES[cls_id]] += 1

        # Write label file
        label_name = f'blk_{idx}'
        with open(LABEL_DIR / f'{label_name}.txt', 'w') as f:
            f.write('\n'.join(labels))

        if not (LABEL_DIR / f'{label_name}.jpg').exists():
            shutil.copy2(str(frame_path), str(LABEL_DIR / f'{label_name}.jpg'))

        total_labels += len(labels)

    # Write classes
    with open(LABEL_DIR / 'classes.txt', 'w') as f:
        f.write('\n'.join(BLOCK_CLASS_NAMES))

    print(f"\n=== BLOCK LABELING COMPLETE ===")
    print(f"Total labels: {total_labels}")
    print(f"\nPer-class:")
    for name in sorted(class_counts, key=lambda k: -class_counts[k]):
        print(f"  {name}: {class_counts[name]}")


def merge_bboxes(bboxes, overlap_threshold=0.3):
    """Merge overlapping bounding boxes."""
    if not bboxes:
        return []

    bboxes = sorted(bboxes, key=lambda b: b[0])
    merged = [list(bboxes[0])]

    for bbox in bboxes[1:]:
        last = merged[-1]
        # Check overlap
        overlap_x = max(0, min(last[2], bbox[2]) - max(last[0], bbox[0]))
        overlap_y = max(0, min(last[3], bbox[3]) - max(last[1], bbox[1]))
        overlap_area = overlap_x * overlap_y

        last_area = (last[2] - last[0]) * (last[3] - last[1])
        bbox_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        min_area = min(last_area, bbox_area)

        if min_area > 0 and overlap_area / min_area > overlap_threshold:
            # Merge
            last[0] = min(last[0], bbox[0])
            last[1] = min(last[1], bbox[1])
            last[2] = max(last[2], bbox[2])
            last[3] = max(last[3], bbox[3])
        else:
            merged.append(list(bbox))

    return merged


if __name__ == '__main__':
    main()
