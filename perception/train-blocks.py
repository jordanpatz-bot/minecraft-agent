#!/usr/bin/env python3
"""
Train YOLOv8-nano block classifier.

Separate model from entity detection, runs in parallel during gameplay.

Usage:
    python3 perception/train-blocks.py [--epochs 80] [--batch 16]
"""

import argparse
import os
import shutil
import random
from pathlib import Path

PROJ_DIR = Path(__file__).parent.parent
LABEL_DIR = PROJ_DIR / 'data' / 'block_labels'

BLOCK_CLASS_NAMES = [
    'Log', 'Leaves', 'Stone', 'Ore', 'Water', 'Lava',
    'CraftingTable', 'Furnace', 'Chest', 'Sand', 'Dirt',
]


def setup_dataset():
    yolo_dir = PROJ_DIR / 'data' / 'yolo_blocks'
    train_imgs = yolo_dir / 'train' / 'images'
    train_labels = yolo_dir / 'train' / 'labels'
    val_imgs = yolo_dir / 'val' / 'images'
    val_labels = yolo_dir / 'val' / 'labels'

    for d in [train_imgs, train_labels, val_imgs, val_labels]:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    pairs = []
    for img_path in sorted(LABEL_DIR.glob('*.jpg')):
        label_path = img_path.with_suffix('.txt')
        if label_path.exists():
            content = label_path.read_text().strip()
            pairs.append((img_path, label_path, len(content) > 0))

    entity_pairs = [p for p in pairs if p[2]]
    empty_pairs = [p for p in pairs if not p[2]]

    print(f"Total: {len(pairs)}, with labels: {len(entity_pairs)}, empty: {len(empty_pairs)}")

    # Include all labeled + some empties
    max_empty = min(len(empty_pairs), len(entity_pairs) // 5)
    selected = entity_pairs + empty_pairs[:max_empty]
    random.shuffle(selected)

    split = int(len(selected) * 0.85)
    train_set = selected[:split]
    val_set = selected[split:]

    for pair_list, img_dir, lbl_dir in [
        (train_set, train_imgs, train_labels),
        (val_set, val_imgs, val_labels),
    ]:
        for img_path, label_path, _ in pair_list:
            shutil.copy2(str(img_path), str(img_dir / img_path.name))
            shutil.copy2(str(label_path), str(lbl_dir / label_path.name))

    print(f"Dataset: {len(train_set)} train, {len(val_set)} val")

    yaml_content = f"""path: {yolo_dir.resolve()}
train: train/images
val: val/images

nc: {len(BLOCK_CLASS_NAMES)}
names: {BLOCK_CLASS_NAMES}
"""
    yaml_path = yolo_dir / 'dataset.yaml'
    yaml_path.write_text(yaml_content)
    return str(yaml_path)


def train(yaml_path, epochs=80, batch=16):
    from ultralytics import YOLO

    print(f"\n=== Training YOLOv8-nano Block Classifier ===")
    yolo = YOLO('yolov8n.pt')
    results = yolo.train(
        data=yaml_path,
        epochs=epochs,
        batch=batch,
        imgsz=640,
        device='mps',
        workers=2,
        patience=15,
        save=True,
        project=str(PROJ_DIR / 'runs' / 'detect'),
        name='mc_blocks_v1',
        exist_ok=True,
        hsv_h=0.01, hsv_s=0.3, hsv_v=0.2,
        degrees=3.0, translate=0.1, scale=0.2,
        flipud=0.0, fliplr=0.5, mosaic=0.8,
    )

    best_path = PROJ_DIR / 'runs' / 'detect' / 'mc_blocks_v1' / 'weights' / 'best.pt'
    print(f"\nBest model: {best_path}")

    best = YOLO(str(best_path))
    metrics = best.val(data=yaml_path)
    print(f"mAP50: {metrics.box.map50:.3f}")
    print(f"mAP50-95: {metrics.box.map:.3f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--epochs', type=int, default=80)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--setup-only', action='store_true')
    args = parser.parse_args()

    yaml_path = setup_dataset()
    if not args.setup_only:
        train(yaml_path, args.epochs, args.batch)


if __name__ == '__main__':
    main()
