#!/usr/bin/env python3
"""
perception/train-detector.py — Train YOLOv8-nano entity detector.

Uses paired frame+label data from the capture pipeline.
Produces a lightweight model for real-time entity detection.

Usage:
    python3 perception/train-detector.py [--epochs 50] [--batch 16]
"""

import argparse
import os
import shutil
from pathlib import Path

def setup_dataset(data_dir):
    """Organize data into YOLO directory structure."""
    data_dir = Path(data_dir)
    captures_dir = data_dir / 'captures'
    labels_dir = data_dir / 'labels'

    # YOLO expects: images/ and labels/ directories side by side
    yolo_dir = data_dir / 'yolo_dataset'
    train_imgs = yolo_dir / 'train' / 'images'
    train_labels = yolo_dir / 'train' / 'labels'
    val_imgs = yolo_dir / 'val' / 'images'
    val_labels = yolo_dir / 'val' / 'labels'

    for d in [train_imgs, train_labels, val_imgs, val_labels]:
        d.mkdir(parents=True, exist_ok=True)

    # Get all paired frames
    frames = sorted(captures_dir.glob('frame_*.jpg'))
    print(f"Found {len(frames)} frames")

    # Split 80/20 train/val
    split_idx = int(len(frames) * 0.8)
    train_frames = frames[:split_idx]
    val_frames = frames[split_idx:]

    copied = 0
    for frame_list, img_dir, lbl_dir in [
        (train_frames, train_imgs, train_labels),
        (val_frames, val_imgs, val_labels),
    ]:
        for frame in frame_list:
            idx = frame.stem.replace('frame_', '')
            label_file = labels_dir / f'frame_{idx}.txt'

            if label_file.exists():
                shutil.copy2(frame, img_dir / frame.name)
                shutil.copy2(label_file, lbl_dir / f'frame_{idx}.txt')
                copied += 1

    print(f"Copied {copied} paired files ({len(train_frames)} train, {len(val_frames)} val)")

    # Write dataset YAML
    yaml_content = f"""path: {yolo_dir.resolve()}
train: train/images
val: val/images

nc: 15
names: ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Slime', 'Enderman', 'Witch', 'Cow', 'Pig', 'Sheep', 'Chicken', 'Squid', 'Cod', 'Item', 'Villager']
"""
    yaml_path = yolo_dir / 'dataset.yaml'
    yaml_path.write_text(yaml_content)
    print(f"Dataset config: {yaml_path}")

    return str(yaml_path)


def train(yaml_path, epochs=50, batch=16, model='yolov8n.pt'):
    """Train YOLOv8 model."""
    from ultralytics import YOLO

    print(f"\n=== Training YOLOv8-nano ===")
    print(f"Dataset: {yaml_path}")
    print(f"Epochs: {epochs}, Batch: {batch}")
    print(f"Base model: {model}")

    yolo = YOLO(model)
    results = yolo.train(
        data=yaml_path,
        epochs=epochs,
        batch=batch,
        imgsz=640,
        device='mps',  # Apple Silicon GPU
        workers=2,
        patience=10,
        save=True,
        project='runs/detect',
        name='minecraft_entities',
        exist_ok=True,
    )

    print(f"\n=== Training complete ===")
    print(f"Best model: runs/detect/minecraft_entities/weights/best.pt")
    return results


def main():
    parser = argparse.ArgumentParser(description='Train MC entity detector')
    parser.add_argument('--epochs', type=int, default=50)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--data-dir', default=os.path.join(os.path.dirname(__file__), '..', 'data'))
    parser.add_argument('--setup-only', action='store_true', help='Only setup dataset, skip training')
    args = parser.parse_args()

    yaml_path = setup_dataset(args.data_dir)

    if not args.setup_only:
        train(yaml_path, epochs=args.epochs, batch=args.batch)


if __name__ == '__main__':
    main()
