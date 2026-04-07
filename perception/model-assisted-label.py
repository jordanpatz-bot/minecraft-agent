#!/usr/bin/env python3
"""
Model-assisted auto-labeling for Minecraft entity detection.

Strategy: Use the v3 YOLO model (mAP 0.52) to predict bounding boxes,
then validate predictions against Mineflayer ground truth state.
Only keep predictions where the entity class exists in ground truth.

This produces MUCH cleaner labels than spatial projection matching,
because:
1. The model gives precise bounding boxes (it was trained for this)
2. Ground truth tells us what entities SHOULD be visible
3. We only keep predictions that match expected entities

Usage:
    python3 perception/model-assisted-label.py [--conf 0.15] [--visualize]
"""

import json
import os
import sys
from pathlib import Path
from collections import defaultdict

PROJ_DIR = Path(__file__).parent.parent
CAPTURE_DIRS = [
    PROJ_DIR / 'data' / 'captures',
    PROJ_DIR / 'data' / 'gameplay_captures',
    PROJ_DIR / 'data' / 'entity_captures',
    PROJ_DIR / 'data' / 'balanced_captures',
    PROJ_DIR / 'data' / 'client_captures',
]
LABEL_DIR = PROJ_DIR / 'data' / 'labels_v6'
VISUALIZE = '--visualize' in sys.argv
CONF_THRESHOLD = float(next((sys.argv[i+1] for i, a in enumerate(sys.argv) if a == '--conf'), '0.15'))

# Best model
# Use best available model (v6 mAP 0.661 > v3 0.52)
_v6 = PROJ_DIR / 'runs' / 'detect' / 'mc_entities_v6' / 'weights' / 'best.pt'
_v3 = PROJ_DIR / 'runs' / 'detect' / 'runs' / 'detect' / 'mc_entities_v3' / 'weights' / 'best.pt'
MODEL_PATH = _v6 if _v6.exists() else _v3

CLASS_NAMES = ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Slime',
               'Enderman', 'Witch', 'Cow', 'Pig', 'Sheep',
               'Chicken', 'Squid', 'Cod', 'Item', 'Villager', 'Player']

# Map ground truth entity names to class indices
ENTITY_TO_CLASS = {}
for i, name in enumerate(CLASS_NAMES):
    ENTITY_TO_CLASS[name.lower()] = i
# Aliases
ENTITY_TO_CLASS.update({
    'cave_spider': 3, 'husk': 0, 'drowned': 0, 'stray': 1,
    'salmon': 12, 'tropical_fish': 12, 'pufferfish': 12,
    'zombie_villager': 0,
    'player': 15,
})


def get_visible_classes(state):
    """Get set of class indices that should be visible based on ground truth."""
    entities = state.get('entities', [])
    visible = set()
    for ent in entities:
        name = (ent.get('name', '') or '').lower().replace(' ', '_')
        dist = ent.get('distance', 100)
        if dist > 30:  # too far to reliably see
            continue
        # Check if it's a player entity
        if ent.get('isPlayer') or ent.get('type') == 'player':
            visible.add(15)  # Player class
            continue
        if name in ENTITY_TO_CLASS:
            visible.add(ENTITY_TO_CLASS[name])
    return visible


def process_frames():
    """Run model on all frames, filter by ground truth."""
    from ultralytics import YOLO

    if not MODEL_PATH.exists():
        print(f"ERROR: Model not found at {MODEL_PATH}")
        sys.exit(1)

    LABEL_DIR.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(MODEL_PATH))
    print(f"Model loaded: {MODEL_PATH}")
    print(f"Confidence threshold: {CONF_THRESHOLD}")

    if VISUALIZE:
        import cv2
        vis_dir = PROJ_DIR / 'data' / 'label_viz_v6'
        vis_dir.mkdir(parents=True, exist_ok=True)

    total_frames = 0
    total_labels = 0
    frames_with_labels = 0
    class_counts = defaultdict(int)
    filtered_count = 0

    for cap_dir in CAPTURE_DIRS:
        if not cap_dir.exists():
            print(f"[SKIP] {cap_dir}")
            continue

        # Find all frames (both original and agent-prefixed)
        frames = sorted(cap_dir.glob('*frame_*.jpg'))
        print(f"\n[DIR] {cap_dir.name}: {len(frames)} frames")

        dir_labels = 0
        for frame_path in frames:
            # Extract prefix and index from filename like "a0_frame_00001.jpg" or "frame_00001.jpg"
            stem = frame_path.stem
            if '_frame_' in stem:
                prefix, _, idx = stem.partition('_frame_')
                prefix += '_'
            else:
                prefix = ''
                idx = stem.replace('frame_', '')
            state_path = cap_dir / f'{prefix}state_{idx}.json'
            if not state_path.exists():
                continue

            total_frames += 1

            with open(state_path) as f:
                state = json.load(f)

            # Get which entity classes SHOULD be visible
            visible_classes = get_visible_classes(state)

            # Run model inference
            results = model(str(frame_path), verbose=False, conf=CONF_THRESHOLD)

            labels = []
            for r in results:
                if r.boxes is None:
                    continue
                for box in r.boxes:
                    cls = int(box.cls[0])
                    conf = float(box.conf[0])
                    xyxy = box.xyxy[0].tolist()

                    # FILTER: only keep predictions matching ground truth
                    if cls not in visible_classes:
                        filtered_count += 1
                        continue

                    # Convert xyxy to YOLO format (cx, cy, w, h normalized)
                    img_w, img_h = 1280, 720  # standard capture size
                    cx = ((xyxy[0] + xyxy[2]) / 2) / img_w
                    cy = ((xyxy[1] + xyxy[3]) / 2) / img_h
                    w = (xyxy[2] - xyxy[0]) / img_w
                    h = (xyxy[3] - xyxy[1]) / img_h

                    labels.append(f"{cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                    class_counts[CLASS_NAMES[cls]] += 1

            # Write label file
            prefix = cap_dir.name[:3]
            label_name = f'{prefix}_{idx}'
            label_path = LABEL_DIR / f'{label_name}.txt'
            with open(label_path, 'w') as f:
                f.write('\n'.join(labels))

            # Copy frame
            import shutil
            img_dest = LABEL_DIR / f'{label_name}.jpg'
            if not img_dest.exists():
                shutil.copy2(str(frame_path), str(img_dest))

            if labels:
                frames_with_labels += 1
                dir_labels += len(labels)
                total_labels += len(labels)

            if VISUALIZE and labels:
                import cv2
                frame = cv2.imread(str(frame_path))
                for l in labels:
                    parts = l.split()
                    cls_id = int(parts[0])
                    cx_n, cy_n, w_n, h_n = [float(x) for x in parts[1:]]
                    x1 = int((cx_n - w_n/2) * 1280)
                    y1 = int((cy_n - h_n/2) * 720)
                    x2 = int((cx_n + w_n/2) * 1280)
                    y2 = int((cy_n + h_n/2) * 720)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(frame, CLASS_NAMES[cls_id], (x1, y1-5),
                               cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
                cv2.imwrite(str(vis_dir / f'{label_name}.jpg'), frame)

        print(f"  → {dir_labels} labels")

    # Write classes
    with open(LABEL_DIR / 'classes.txt', 'w') as f:
        f.write('\n'.join(CLASS_NAMES))

    print(f"\n=== MODEL-ASSISTED LABELING COMPLETE ===")
    print(f"Frames: {total_frames}")
    print(f"With labels: {frames_with_labels}/{total_frames}")
    print(f"Total labels: {total_labels}")
    print(f"Filtered (not in ground truth): {filtered_count}")
    print(f"\nPer-class:")
    for name in sorted(class_counts, key=lambda k: -class_counts[k]):
        print(f"  {name}: {class_counts[name]}")


if __name__ == '__main__':
    process_frames()
