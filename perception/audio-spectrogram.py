#!/usr/bin/env python3
"""
perception/audio-spectrogram.py — Real-time audio spectrogram pipeline.

Captures system audio, computes mel spectrograms, and classifies
Minecraft sound events. This is the game-agnostic approach — works
with raw audio rather than game-specific packet events.

Architecture:
  System audio → mel spectrogram → CNN classifier → structured events

The classifier outputs: {sound_class, confidence, timestamp}
Events feed into the agent's reflex layer at tick speed.

For now, this generates spectrograms and saves them paired with
Mineflayer ground truth events for training a classifier later.

Usage:
  # List audio devices
  python3 perception/audio-spectrogram.py --list-devices

  # Record + generate spectrograms (paired with bot ground truth)
  python3 perception/audio-spectrogram.py --duration 60 --device <id>

  # Generate spectrograms from existing audio file
  python3 perception/audio-spectrogram.py --file audio.wav
"""

import argparse
import json
import os
import sys
import time
import numpy as np
from pathlib import Path

PROJ_DIR = Path(__file__).parent.parent
OUTPUT_DIR = PROJ_DIR / 'data' / 'audio_spectrograms'

# Minecraft sound categories for classification
MC_SOUND_CLASSES = [
    'hostile_ambient',    # zombie groan, skeleton rattle, spider hiss
    'hostile_attack',     # skeleton shoot, creeper fuse, enderman scream
    'passive_ambient',    # cow moo, pig oink, chicken cluck
    'player_action',      # mining, placing, eating, walking
    'environment',        # rain, thunder, water, lava
    'ui',                 # chest open, crafting, inventory
    'silence',            # no significant audio
]

# Spectrogram parameters
SAMPLE_RATE = 22050
HOP_LENGTH = 512
N_MELS = 128
N_FFT = 2048
WINDOW_SEC = 2.0  # seconds per spectrogram window
STRIDE_SEC = 0.5  # overlap stride


def list_devices():
    """List available audio input devices."""
    import sounddevice as sd
    print("Available audio devices:\n")
    print(sd.query_devices())
    print(f"\nDefault input: {sd.default.device[0]}")
    print(f"Default output: {sd.default.device[1]}")
    print("\nFor system audio loopback on macOS:")
    print("  Install BlackHole (brew install blackhole-2ch)")
    print("  Set up Multi-Output Device in Audio MIDI Setup")
    print("  Use the BlackHole device ID with --device")


def compute_spectrogram(audio_chunk, sr=SAMPLE_RATE):
    """Compute mel spectrogram from audio chunk."""
    import librosa

    # Ensure mono
    if audio_chunk.ndim > 1:
        audio_chunk = np.mean(audio_chunk, axis=1)

    # Compute mel spectrogram
    mel = librosa.feature.melspectrogram(
        y=audio_chunk.astype(np.float32),
        sr=sr,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        n_mels=N_MELS,
    )

    # Convert to log scale (dB)
    mel_db = librosa.power_to_db(mel, ref=np.max)

    return mel_db


def classify_spectrogram(mel_db):
    """
    Classify a spectrogram into MC sound categories.

    For now: simple energy-based heuristic.
    TODO: Train a CNN classifier on labeled spectrograms.
    """
    energy = np.mean(mel_db)
    peak = np.max(mel_db)

    # Very simple classification based on energy levels
    if peak < -60:
        return 'silence', 0.9
    elif peak < -30:
        return 'environment', 0.3
    else:
        # Can't distinguish specific sounds without a trained model
        return 'unknown', 0.5


def record_and_process(duration, device_id=None):
    """Record system audio and generate spectrograms in real-time."""
    import sounddevice as sd

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Configure recording
    if device_id is not None:
        sd.default.device = device_id

    print(f"Recording for {duration}s at {SAMPLE_RATE}Hz...")
    print(f"Device: {sd.query_devices(sd.default.device[0])['name']}")

    # Record
    frames = int(duration * SAMPLE_RATE)
    audio = sd.rec(frames, samplerate=SAMPLE_RATE, channels=1, dtype='float32')
    sd.wait()

    print(f"Recorded {len(audio)} samples ({duration}s)")

    # Process into spectrogram windows
    window_samples = int(WINDOW_SEC * SAMPLE_RATE)
    stride_samples = int(STRIDE_SEC * SAMPLE_RATE)

    spectrograms = []
    idx = 0
    pos = 0
    while pos + window_samples <= len(audio):
        chunk = audio[pos:pos + window_samples].flatten()
        mel_db = compute_spectrogram(chunk)
        sound_class, confidence = classify_spectrogram(mel_db)

        spectrograms.append({
            'index': idx,
            'start_sec': pos / SAMPLE_RATE,
            'end_sec': (pos + window_samples) / SAMPLE_RATE,
            'classification': sound_class,
            'confidence': confidence,
            'energy': float(np.mean(mel_db)),
            'peak': float(np.max(mel_db)),
            'shape': list(mel_db.shape),
        })

        # Save spectrogram as numpy array
        np.save(str(OUTPUT_DIR / f'spec_{idx:05d}.npy'), mel_db)

        idx += 1
        pos += stride_samples

    # Save raw audio
    import soundfile as sf
    sf.write(str(OUTPUT_DIR / 'recording.wav'), audio, SAMPLE_RATE)

    # Save metadata
    with open(OUTPUT_DIR / 'spectrograms.json', 'w') as f:
        json.dump({
            'total': idx,
            'sample_rate': SAMPLE_RATE,
            'window_sec': WINDOW_SEC,
            'stride_sec': STRIDE_SEC,
            'n_mels': N_MELS,
            'spectrograms': spectrograms,
        }, f, indent=2)

    print(f"\nGenerated {idx} spectrograms")
    print(f"Output: {OUTPUT_DIR}")

    # Print classification summary
    from collections import Counter
    classes = Counter(s['classification'] for s in spectrograms)
    print(f"Classifications: {dict(classes)}")


def process_file(filepath):
    """Generate spectrograms from an existing audio file."""
    import librosa

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Loading {filepath}...")
    audio, sr = librosa.load(filepath, sr=SAMPLE_RATE, mono=True)
    print(f"Loaded {len(audio)} samples ({len(audio)/sr:.1f}s)")

    window_samples = int(WINDOW_SEC * sr)
    stride_samples = int(STRIDE_SEC * sr)

    spectrograms = []
    idx = 0
    pos = 0
    while pos + window_samples <= len(audio):
        chunk = audio[pos:pos + window_samples]
        mel_db = compute_spectrogram(chunk, sr)
        sound_class, confidence = classify_spectrogram(mel_db)

        spectrograms.append({
            'index': idx,
            'start_sec': pos / sr,
            'end_sec': (pos + window_samples) / sr,
            'classification': sound_class,
            'confidence': confidence,
            'energy': float(np.mean(mel_db)),
            'peak': float(np.max(mel_db)),
        })

        np.save(str(OUTPUT_DIR / f'spec_{idx:05d}.npy'), mel_db)
        idx += 1
        pos += stride_samples

    with open(OUTPUT_DIR / 'spectrograms.json', 'w') as f:
        json.dump({'total': idx, 'spectrograms': spectrograms}, f, indent=2)

    print(f"Generated {idx} spectrograms → {OUTPUT_DIR}")


def generate_training_data():
    """
    Generate labeled spectrogram training data from MC sound files.

    Downloads Minecraft sound assets and creates labeled spectrograms
    for training the classifier.
    """
    print("TODO: Extract MC sound assets and generate labeled training spectrograms")
    print("MC sounds are in .minecraft/assets/objects/ as .ogg files")
    print("Each sound maps to a category in MC_SOUND_CLASSES")


def main():
    parser = argparse.ArgumentParser(description='Audio spectrogram pipeline')
    parser.add_argument('--list-devices', action='store_true')
    parser.add_argument('--duration', type=int, default=30)
    parser.add_argument('--device', type=int, default=None)
    parser.add_argument('--file', type=str, default=None)
    parser.add_argument('--generate-training', action='store_true')
    args = parser.parse_args()

    if args.list_devices:
        list_devices()
    elif args.file:
        process_file(args.file)
    elif args.generate_training:
        generate_training_data()
    else:
        record_and_process(args.duration, args.device)


if __name__ == '__main__':
    main()
