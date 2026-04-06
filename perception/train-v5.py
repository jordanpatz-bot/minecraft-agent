#!/usr/bin/env python3
"""
perception/train-v5.py — Train YOLOv8-nano v5 on unified labeled dataset.

Reads from data/labels/ (produced by auto-label-all.py), sets up YOLO dataset
structure, and trains on Apple Silicon MPS.

Usage:
    python3 perception/train-v5.py [--epochs 80] [--batch 16] [--resume]
"""

import argparse
import os
import shutil
import random
from pathlib import Path

PROJ_DIR = Path(__file__).parent.parent
LABEL_DIR = PROJ_DIR / 'data' / 'labels'

CLASS_NAMES = ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Slime',
               'Enderman', 'Witch', 'Cow', 'Pig', 'Sheep',
               'Chicken', 'Squid', 'Cod', 'Item', 'Villager']


def setup_dataset():
    """Build YOLO dataset from unified labels directory."""
    yolo_dir = PROJ_DIR / 'data' / 'yolo_v5'
    train_imgs = yolo_dir / 'train' / 'images'
    train_labels = yolo_dir / 'train' / 'labels'
    val_imgs = yolo_dir / 'val' / 'images'
    val_labels = yolo_dir / 'val' / 'labels'

    for d in [train_imgs, train_labels, val_imgs, val_labels]:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    # Find all paired image+label files
    pairs = []
    for img_path in sorted(LABEL_DIR.glob('*.jpg')):
        label_path = img_path.with_suffix('.txt')
        if label_path.exists():
            # Check if label has content (entity labels)
            content = label_path.read_text().strip()
            has_labels = len(content) > 0
            pairs.append((img_path, label_path, has_labels))

    print(f"Found {len(pairs)} image+label pairs")

    # Separate frames WITH entities from empty frames
    entity_frames = [p for p in pairs if p[2]]
    empty_frames = [p for p in pairs if not p[2]]
    print(f"  With entities: {entity_frames.__len__()}")
    print(f"  Empty: {empty_frames.__len__()}")

    # Balance the dataset: include all entity frames + limited empty frames
    # (too many empty frames diluted v4, but some empty frames help reduce false positives)
    max_empty = min(len(empty_frames), len(entity_frames) // 2)
    random.shuffle(empty_frames)
    selected_empty = empty_frames[:max_empty]

    all_pairs = entity_frames + selected_empty
    random.shuffle(all_pairs)

    # Split 85/15 train/val
    split_idx = int(len(all_pairs) * 0.85)
    train_pairs = all_pairs[:split_idx]
    val_pairs = all_pairs[split_idx:]

    for pair_list, img_dir, lbl_dir in [
        (train_pairs, train_imgs, train_labels),
        (val_pairs, val_imgs, val_labels),
    ]:
        for img_path, label_path, _ in pair_list:
            shutil.copy2(str(img_path), str(img_dir / img_path.name))
            shutil.copy2(str(label_path), str(lbl_dir / label_path.name))

    print(f"Dataset: {len(train_pairs)} train, {len(val_pairs)} val")
    print(f"  (includes {max_empty} balanced empty frames)")

    # Write dataset YAML
    yaml_content = f"""path: {yolo_dir.resolve()}
train: train/images
val: val/images

nc: {len(CLASS_NAMES)}
names: {CLASS_NAMES}
"""
    yaml_path = yolo_dir / 'dataset.yaml'
    yaml_path.write_text(yaml_content)
    print(f"Config: {yaml_path}")
    return str(yaml_path)


def train(yaml_path, epochs=80, batch=16, resume=False):
    """Train YOLOv8-nano."""
    from ultralytics import YOLO

    print(f"\n=== Training YOLOv8-nano v5 ===")
    print(f"Epochs: {epochs}, Batch: {batch}")

    if resume:
        model_path = str(PROJ_DIR / 'runs' / 'detect' / 'mc_entities_v5' / 'weights' / 'last.pt')
        if os.path.exists(model_path):
            print(f"Resuming from {model_path}")
            yolo = YOLO(model_path)
        else:
            print("No checkpoint found, starting fresh")
            yolo = YOLO('yolov8n.pt')
    else:
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
        name='mc_entities_v5',
        exist_ok=True,
        # Augmentation for Minecraft's blocky visuals
        hsv_h=0.015,
        hsv_s=0.5,
        hsv_v=0.3,
        degrees=5.0,
        translate=0.1,
        scale=0.3,
        flipud=0.0,  # don't flip upside down
        fliplr=0.5,
        mosaic=0.8,
    )

    print(f"\n=== Training complete ===")
    best_path = PROJ_DIR / 'runs' / 'detect' / 'mc_entities_v5' / 'weights' / 'best.pt'
    print(f"Best model: {best_path}")

    # Validate
    print("\n=== Validation ===")
    best = YOLO(str(best_path))
    metrics = best.val(data=yaml_path)
    print(f"mAP50: {metrics.box.map50:.3f}")
    print(f"mAP50-95: {metrics.box.map:.3f}")

    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--epochs', type=int, default=80)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--setup-only', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()

    yaml_path = setup_dataset()

    if not args.setup_only:
        train(yaml_path, epochs=args.epochs, batch=args.batch, resume=args.resume)


if __name__ == '__main__':
    main()
