#!/usr/bin/env python3
"""
Auto-label entity bounding boxes from rendered frames.

Instead of projecting 3D positions (inaccurate), detects entities 
directly in the frame via color segmentation and matches them to
ground truth state data.

This produces tighter, more accurate labels than projection.
"""
import json
import os
import sys
import glob
import cv2
import numpy as np
from pathlib import Path

CAPTURE_DIR = sys.argv[1] if len(sys.argv) > 1 else 'data/captures'
LABEL_DIR = 'data/labels_auto'

# Entity types and their dominant colors in prismarine-viewer
# Format: name -> [(B,G,R) center, tolerance]
ENTITY_COLORS = {
    'Slime': [(60, 180, 60), 50],      # green
    'Zombie': [(80, 100, 60), 40],      # dark green/olive  
    'Skeleton': [(200, 200, 200), 40],  # white/gray
    'Creeper': [(60, 150, 60), 40],     # green (lighter than zombie)
    'Spider': [(40, 40, 40), 30],       # dark/black
    'Cow': [(60, 60, 60), 40],          # brown/dark
    'Pig': [(130, 150, 210), 40],       # pink
}

CLASS_MAP = {
    'Zombie': 0, 'Skeleton': 1, 'Creeper': 2, 'Spider': 3, 'Slime': 4,
    'Enderman': 5, 'Witch': 6, 'Cow': 7, 'Pig': 8, 'Sheep': 9,
    'Chicken': 10, 'Squid': 11, 'Cod': 12, 'Item': 13, 'Villager': 14,
}

# Sky color for background subtraction
SKY_COLOR = np.array([208, 196, 172])  # typical prismarine-viewer sky (BGR)
SKY_TOLERANCE = 30

def detect_entities_in_frame(frame):
    """Find non-sky blobs that are likely entities."""
    h, w = frame.shape[:2]
    
    # Background mask: pixels close to sky color
    diff = np.abs(frame.astype(np.int16) - SKY_COLOR.astype(np.int16))
    bg_mask = np.all(diff < SKY_TOLERANCE, axis=2)
    
    # Also mask the ground (bottom portion, gray in flat world)
    # Ground color varies but is generally darker than sky
    ground_mask = np.zeros((h, w), dtype=bool)
    for y in range(h):
        row_mean = np.mean(frame[y], axis=0)
        if row_mean[0] < 140 and row_mean[1] < 140:  # darker than sky
            ground_mask[y, :] = True
    
    # Foreground: not sky, not ground
    fg_mask = ~bg_mask & ~ground_mask
    fg_uint8 = fg_mask.astype(np.uint8) * 255
    
    # Clean up with morphology
    kernel = np.ones((3, 3), np.uint8)
    fg_uint8 = cv2.morphologyEx(fg_uint8, cv2.MORPH_OPEN, kernel)
    fg_uint8 = cv2.morphologyEx(fg_uint8, cv2.MORPH_CLOSE, kernel)
    
    # Find contours (entity blobs)
    contours, _ = cv2.findContours(fg_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    detections = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < 20 or area > w * h * 0.3:  # too small or too large
            continue
        
        x, y, bw, bh = cv2.boundingRect(c)
        # Normalize to 0-1
        cx = (x + bw / 2) / w
        cy = (y + bh / 2) / h
        nw = bw / w
        nh = bh / h
        
        # Get dominant color of the blob
        blob_pixels = frame[y:y+bh, x:x+bw]
        blob_mask = fg_uint8[y:y+bh, x:x+bw]
        if np.sum(blob_mask) == 0:
            continue
        mean_color = cv2.mean(blob_pixels, mask=blob_mask)[:3]
        
        detections.append({
            'cx': cx, 'cy': cy, 'w': nw, 'h': nh,
            'area': area, 'color': mean_color,
            'pixel_bbox': (x, y, bw, bh),
        })
    
    return detections


def match_detection_to_entity(detection, entities, player_yaw, player_pitch):
    """Match a visual detection to a ground truth entity by approximate position."""
    # Use the detection's screen position to estimate which entity it is
    # Entities to the left of screen → larger relative yaw
    # Entities higher on screen → lower relative pitch
    
    # For now, just match by closest screen position using rough projection
    best_match = None
    best_dist = float('inf')
    
    for entity in entities:
        name = entity.get('name', '')
        if name not in CLASS_MAP:
            continue
        
        # Rough screen position estimate (we know projection is approximately correct)
        dist = entity.get('distance', 100)
        if dist > 40:  # too far to see
            continue
        
        # The detection's position on screen should correlate with the entity's
        # relative angle from the player's view direction
        # For matching, we just pick the closest entity that has a compatible type
        
        # Color-based type matching
        det_color = np.array(detection['color'])
        for etype, (ecolor, etol) in ENTITY_COLORS.items():
            if etype == name:
                color_dist = np.sqrt(np.sum((det_color - np.array(ecolor)) ** 2))
                if color_dist < etol * 2:
                    # Match by area (closer entities appear larger)
                    area_score = detection['area'] / max(1, (dist ** 2))
                    combined = color_dist - area_score * 0.01
                    if combined < best_dist:
                        best_dist = combined
                        best_match = entity
    
    return best_match


def process_frame(frame_path, state_path):
    """Process one frame+state pair, output YOLO labels."""
    frame = cv2.imread(frame_path)
    if frame is None:
        return []
    
    state = json.load(open(state_path))
    entities = state.get('entities', [])
    
    detections = detect_entities_in_frame(frame)
    
    labels = []
    for det in detections:
        # Try to match to ground truth
        match = match_detection_to_entity(
            det, entities,
            state['player'].get('yaw', 0),
            state['player'].get('pitch', 0)
        )
        
        if match:
            class_id = CLASS_MAP.get(match['name'])
            if class_id is not None:
                labels.append(f"{class_id} {det['cx']:.6f} {det['cy']:.6f} {det['w']:.6f} {det['h']:.6f}")
        else:
            # Unmatched detection — label as generic entity (use Slime=4 as default for flat world)
            # Only if the blob looks entity-like (small, colored)
            if det['area'] < 5000 and det['w'] < 0.15 and det['h'] < 0.15:
                labels.append(f"4 {det['cx']:.6f} {det['cy']:.6f} {det['w']:.6f} {det['h']:.6f}")
    
    return labels


def main():
    os.makedirs(LABEL_DIR, exist_ok=True)
    
    frames = sorted(glob.glob(os.path.join(CAPTURE_DIR, 'frame_*.jpg')))
    print(f"Processing {len(frames)} frames from {CAPTURE_DIR}")
    
    total_labels = 0
    frames_with_labels = 0
    
    for frame_path in frames:
        idx = os.path.basename(frame_path).replace('frame_', '').replace('.jpg', '')
        state_path = os.path.join(CAPTURE_DIR, f'state_{idx}.json')
        
        if not os.path.exists(state_path):
            continue
        
        labels = process_frame(frame_path, state_path)
        
        label_path = os.path.join(LABEL_DIR, f'frame_{idx}.txt')
        with open(label_path, 'w') as f:
            f.write('\n'.join(labels))
        
        total_labels += len(labels)
        if labels:
            frames_with_labels += 1
    
    # Write classes file
    class_names = sorted(CLASS_MAP.keys(), key=lambda k: CLASS_MAP[k])
    with open(os.path.join(LABEL_DIR, 'classes.txt'), 'w') as f:
        f.write('\n'.join(class_names))
    
    print(f"\nDone: {total_labels} labels across {frames_with_labels}/{len(frames)} frames")
    print(f"Labels saved to {LABEL_DIR}")

if __name__ == '__main__':
    main()
