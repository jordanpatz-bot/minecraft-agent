#!/usr/bin/env python3
"""
Train v8 entity model on balanced + existing labels.

Uses labels_v8/ directory. Applies class-weighted sampling to counteract
the Slime/Zombie bias from older data.

Usage:
    python3 perception/train-v8.py [--epochs 100] [--batch 16]
"""

import argparse
import os
import shutil
import random
from pathlib import Path
from collections import defaultdict

PROJ_DIR = Path(__file__).parent.parent
LABEL_DIR = PROJ_DIR / 'data' / 'labels_v8'

CLASS_NAMES = ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Slime',
               'Enderman', 'Witch', 'Cow', 'Pig', 'Sheep',
               'Chicken', 'Squid', 'Cod', 'Item', 'Villager']


def setup_dataset():
    yolo_dir = PROJ_DIR / 'data' / 'yolo_v8'
    train_imgs = yolo_dir / 'train' / 'images'
    train_labels = yolo_dir / 'train' / 'labels'
    val_imgs = yolo_dir / 'val' / 'images'
    val_labels = yolo_dir / 'val' / 'labels'

    for d in [train_imgs, train_labels, val_imgs, val_labels]:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    # Load all pairs and categorize
    pairs = []
    class_to_pairs = defaultdict(list)

    for img_path in sorted(LABEL_DIR.glob('*.jpg')):
        label_path = img_path.with_suffix('.txt')
        if not label_path.exists():
            continue
        content = label_path.read_text().strip()
        classes_in_frame = set()
        if content:
            for line in content.split('\n'):
                if line.strip():
                    cls = int(line.split()[0])
                    classes_in_frame.add(cls)

        has_labels = len(classes_in_frame) > 0
        pairs.append((img_path, label_path, classes_in_frame, has_labels))

        for cls in classes_in_frame:
            class_to_pairs[cls].append(len(pairs) - 1)

    entity_pairs = [p for p in pairs if p[3]]
    empty_pairs = [p for p in pairs if not p[3]]

    print(f"Total pairs: {len(pairs)}")
    print(f"  With entities: {len(entity_pairs)}")
    print(f"  Empty: {len(empty_pairs)}")

    print(f"\nClass distribution (before balancing):")
    for cls_id in sorted(class_to_pairs.keys()):
        print(f"  {CLASS_NAMES[cls_id]}: {len(class_to_pairs[cls_id])} frames")

    # Balance: oversample rare classes by duplicating their frames
    # Target: each class should have at least min_per_class frames
    min_per_class = 100
    oversampled_indices = set(range(len(entity_pairs)))

    for cls_id, indices in class_to_pairs.items():
        if len(indices) < min_per_class:
            # Need to add more copies
            extra_needed = min_per_class - len(indices)
            extra = [random.choice(indices) for _ in range(extra_needed)]
            oversampled_indices.update(extra)

    # Include limited empties
    max_empty = min(len(empty_pairs), len(entity_pairs) // 4)
    random.shuffle(empty_pairs)

    # Build final dataset
    selected_entity = [pairs[i] for i in oversampled_indices if i < len(pairs)]
    all_selected = selected_entity + empty_pairs[:max_empty]
    random.shuffle(all_selected)

    # 85/15 split
    split = int(len(all_selected) * 0.85)
    train_set = all_selected[:split]
    val_set = all_selected[split:]

    # Copy with dedup names (oversampled frames get suffix)
    name_count = defaultdict(int)
    for pair_list, img_dir, lbl_dir in [
        (train_set, train_imgs, train_labels),
        (val_set, val_imgs, val_labels),
    ]:
        for img_path, label_path, _, _ in pair_list:
            base = img_path.stem
            name_count[base] += 1
            suffix = f'_{name_count[base]}' if name_count[base] > 1 else ''
            shutil.copy2(str(img_path), str(img_dir / f'{base}{suffix}.jpg'))
            shutil.copy2(str(label_path), str(lbl_dir / f'{base}{suffix}.txt'))

    print(f"\nDataset: {len(train_set)} train, {len(val_set)} val")

    yaml_content = f"""path: {yolo_dir.resolve()}
train: train/images
val: val/images

nc: {len(CLASS_NAMES)}
names: {CLASS_NAMES}
"""
    yaml_path = yolo_dir / 'dataset.yaml'
    yaml_path.write_text(yaml_content)
    return str(yaml_path)


def train(yaml_path, epochs=100, batch=16):
    from ultralytics import YOLO

    print(f"\n=== Training YOLOv8-nano v8 ===")
    yolo = YOLO('yolov8n.pt')
    results = yolo.train(
        data=yaml_path,
        epochs=epochs,
        batch=batch,
        imgsz=640,
        device='mps',
        workers=2,
        patience=20,
        save=True,
        project=str(PROJ_DIR / 'runs' / 'detect'),
        name='mc_entities_v8',
        exist_ok=True,
        hsv_h=0.015, hsv_s=0.5, hsv_v=0.3,
        degrees=5.0, translate=0.1, scale=0.3,
        flipud=0.0, fliplr=0.5, mosaic=0.8,
    )

    best_path = PROJ_DIR / 'runs' / 'detect' / 'mc_entities_v8' / 'weights' / 'best.pt'
    print(f"\n=== Training complete ===")
    print(f"Best model: {best_path}")

    best = YOLO(str(best_path))
    metrics = best.val(data=yaml_path)
    print(f"mAP50: {metrics.box.map50:.3f}")
    print(f"mAP50-95: {metrics.box.map:.3f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--setup-only', action='store_true')
    args = parser.parse_args()

    yaml_path = setup_dataset()
    if not args.setup_only:
        train(yaml_path, args.epochs, args.batch)


if __name__ == '__main__':
    main()
