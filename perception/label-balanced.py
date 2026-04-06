#!/usr/bin/env python3
"""
Label balanced captures using forced class + model bounding boxes.

For balanced captures, we KNOW which entity class was spawned (from state JSON).
We use the best YOLO model only for bbox localization, then force the class
from the spawn data. This breaks the feedback loop that biased previous models.

Also generates labels for any model detections that match ground truth entities
(for cases where natural mobs are also present).

Usage:
    python3 perception/label-balanced.py [--conf 0.1]
"""

import json
import os
import sys
from pathlib import Path
from collections import defaultdict
import shutil

PROJ_DIR = Path(__file__).parent.parent
BALANCED_DIR = PROJ_DIR / 'data' / 'balanced_captures'
OLD_LABEL_DIR = PROJ_DIR / 'data' / 'labels_v6'  # existing labels from previous cycles
LABEL_DIR = PROJ_DIR / 'data' / 'labels_v8'
CONF = float(next((sys.argv[i+1] for i, a in enumerate(sys.argv) if a == '--conf'), '0.1'))

CLASS_NAMES = ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Slime',
               'Enderman', 'Witch', 'Cow', 'Pig', 'Sheep',
               'Chicken', 'Squid', 'Cod', 'Item', 'Villager']

# Model for bbox detection
_v6 = PROJ_DIR / 'runs' / 'detect' / 'mc_entities_v6' / 'weights' / 'best.pt'
_v3 = PROJ_DIR / 'runs' / 'detect' / 'runs' / 'detect' / 'mc_entities_v3' / 'weights' / 'best.pt'
MODEL_PATH = _v6 if _v6.exists() else _v3

# Map entity names to class IDs
ENTITY_NAME_MAP = {
    'zombie': 0, 'skeleton': 1, 'creeper': 2, 'spider': 3, 'slime': 4,
    'enderman': 5, 'witch': 6, 'cow': 7, 'pig': 8, 'sheep': 9,
    'chicken': 10, 'squid': 11, 'cod': 12, 'item': 13, 'villager': 14,
    'zombie_villager': 0, 'husk': 0, 'drowned': 0, 'stray': 1, 'cave_spider': 3,
}


def main():
    LABEL_DIR.mkdir(parents=True, exist_ok=True)

    from ultralytics import YOLO
    model = YOLO(str(MODEL_PATH))
    print(f"Model: {MODEL_PATH}")
    print(f"Confidence: {CONF}")

    class_counts = defaultdict(int)
    total_labels = 0
    total_frames = 0

    # Step 1: Process balanced captures (forced class labels)
    if BALANCED_DIR.exists():
        frames = sorted(BALANCED_DIR.glob('frame_*.jpg'))
        print(f"\n[BALANCED] {len(frames)} frames")

        for frame_path in frames:
            idx = frame_path.stem.replace('frame_', '')
            state_path = BALANCED_DIR / f'state_{idx}.json'
            if not state_path.exists():
                continue

            total_frames += 1
            with open(state_path) as f:
                state = json.load(f)

            target_class_id = state.get('targetClassId')
            target_class_name = state.get('targetClass', '')

            # Run model for bbox detection (low conf to catch more)
            results = model(str(frame_path), verbose=False, conf=CONF)

            labels = []
            for r in results:
                if r.boxes is None:
                    continue
                for box in r.boxes:
                    detected_cls = int(box.cls[0])
                    conf = float(box.conf[0])
                    xyxy = box.xyxy[0].tolist()

                    # Force the class to what we actually spawned
                    # (use detected class only if it matches a ground truth entity)
                    forced_cls = target_class_id

                    # Check if this detection might be a naturally spawned mob
                    gt_entities = state.get('entities', [])
                    gt_names = set()
                    for ent in gt_entities:
                        name = (ent.get('name', '') or '').lower().replace(' ', '_')
                        if name in ENTITY_NAME_MAP:
                            gt_names.add(ENTITY_NAME_MAP[name])

                    # If the detection matches a different GT entity, use that class
                    if detected_cls in gt_names and detected_cls != target_class_id:
                        forced_cls = detected_cls

                    # Convert to YOLO format
                    img_w, img_h = 1280, 720
                    cx = ((xyxy[0] + xyxy[2]) / 2) / img_w
                    cy = ((xyxy[1] + xyxy[3]) / 2) / img_h
                    w = (xyxy[2] - xyxy[0]) / img_w
                    h = (xyxy[3] - xyxy[1]) / img_h

                    labels.append(f"{forced_cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                    class_counts[CLASS_NAMES[forced_cls]] += 1

            # Save label
            label_name = f'bal_{idx}'
            with open(LABEL_DIR / f'{label_name}.txt', 'w') as f:
                f.write('\n'.join(labels))
            if not (LABEL_DIR / f'{label_name}.jpg').exists():
                shutil.copy2(str(frame_path), str(LABEL_DIR / f'{label_name}.jpg'))

            total_labels += len(labels)

        print(f"  → {total_labels} labels")

    # Step 2: Copy existing labels from previous cycle (for continuity)
    existing_copied = 0
    if OLD_LABEL_DIR.exists():
        for img_path in sorted(OLD_LABEL_DIR.glob('*.jpg')):
            label_path = img_path.with_suffix('.txt')
            if not label_path.exists():
                continue
            # Don't overwrite balanced labels
            dest_img = LABEL_DIR / img_path.name
            dest_lbl = LABEL_DIR / label_path.name
            if not dest_img.exists():
                shutil.copy2(str(img_path), str(dest_img))
                shutil.copy2(str(label_path), str(dest_lbl))
                existing_copied += 1
                # Count classes
                content = label_path.read_text().strip()
                for line in content.split('\n'):
                    if line.strip():
                        cls = int(line.split()[0])
                        class_counts[CLASS_NAMES[cls]] += 1
                        total_labels += 1

        print(f"\n[EXISTING] Copied {existing_copied} frames from previous cycle")

    # Write classes file
    with open(LABEL_DIR / 'classes.txt', 'w') as f:
        f.write('\n'.join(CLASS_NAMES))

    print(f"\n=== LABELING COMPLETE ===")
    print(f"Total frames: {total_frames + existing_copied}")
    print(f"Total labels: {total_labels}")
    print(f"\nPer-class distribution:")
    for name in sorted(class_counts, key=lambda k: -class_counts[k]):
        print(f"  {name}: {class_counts[name]}")


if __name__ == '__main__':
    main()
