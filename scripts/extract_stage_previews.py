#!/usr/bin/env python3
"""
Extract a preview thumbnail for each stage by reading the biggest sprite out
of its .sff file and saving as PNG at engine/stage-previews/<name>.png.

Reuses the SFF parsers from extract_portraits.py. Stages don't have a
canonical "portrait" coordinate the way chars do (group 9000/0), so we walk
every sprite and keep the one with the largest pixel count — that's almost
always the main background layer.

Run once to populate; re-run if new stages get added.
"""

import io
import os
import struct
import sys
from pathlib import Path

from PIL import Image

# Reach up one dir — we live at scripts/
ROOT = Path(__file__).resolve().parents[1]
STAGES_DIR = ROOT / 'engine' / 'stages'
OUT_DIR = ROOT / 'engine' / 'stage-previews'

# Import the SFF parsers from the portrait script so we don't duplicate
# SFF v1 / v2 parser code.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_portraits import parse_sff_v1 as _portrait_v1  # noqa: E402
from extract_portraits import parse_sff_v2 as _portrait_v2  # noqa: E402
from extract_portraits import _decode_pcx, _decode_rle8, _decode_rle5, _decode_lz5, _read_v2_palette  # noqa: E402


def walk_sff_v1(path: Path):
    """Yield (group, image, PIL Image) for every sprite in an SFF v1 file."""
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 512 or not data[:12].startswith(b'ElecbyteSpr') or data[15] != 1:
        return
    num_images = struct.unpack_from('<I', data, 20)[0]
    first_subfile_offset = struct.unpack_from('<I', data, 24)[0]
    offset = first_subfile_offset
    for _ in range(num_images):
        if offset == 0 or offset + 32 > len(data):
            break
        next_off = struct.unpack_from('<I', data, offset)[0]
        subfile_len = struct.unpack_from('<I', data, offset + 4)[0]
        group = struct.unpack_from('<H', data, offset + 12)[0]
        image = struct.unpack_from('<H', data, offset + 14)[0]
        pcx_start = offset + 32
        pcx_end = pcx_start + subfile_len
        try:
            img = _decode_pcx(data[pcx_start:pcx_end])
            yield group, image, img
        except Exception:
            pass
        offset = next_off


def walk_sff_v2(path: Path):
    """Yield (group, image, PIL Image) for every sprite in an SFF v2 file."""
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 68 or not data.startswith(b'ElecbyteSpr') or data[15] != 2:
        return
    sprite_offset = struct.unpack_from('<I', data, 36)[0]
    total_sprites = struct.unpack_from('<I', data, 40)[0]
    palette_offset = struct.unpack_from('<I', data, 44)[0]
    total_palettes = struct.unpack_from('<I', data, 48)[0]
    ldata_offset = struct.unpack_from('<I', data, 52)[0]
    tdata_offset = struct.unpack_from('<I', data, 60)[0]
    SPRITE_NODE_SIZE = 28
    for i in range(total_sprites):
        off = sprite_offset + i * SPRITE_NODE_SIZE
        if off + SPRITE_NODE_SIZE > len(data):
            break
        group = struct.unpack_from('<H', data, off)[0]
        image = struct.unpack_from('<H', data, off + 2)[0]
        width = struct.unpack_from('<H', data, off + 4)[0]
        height = struct.unpack_from('<H', data, off + 6)[0]
        fmt = data[off + 14]
        data_offset = struct.unpack_from('<I', data, off + 16)[0]
        data_length = struct.unpack_from('<I', data, off + 20)[0]
        pal_index = struct.unpack_from('<H', data, off + 24)[0]
        flags = struct.unpack_from('<H', data, off + 26)[0]
        if width == 0 or height == 0 or data_length < 4:
            continue
        base = tdata_offset if (flags & 1) else ldata_offset
        abs_off = base + data_offset
        if abs_off + data_length > len(data):
            continue
        sprite_bytes = data[abs_off:abs_off + data_length]
        body = sprite_bytes[4:]
        if fmt in (10, 11, 12):
            probe = body[:8]
            png_bytes = body if probe.startswith(b'\x89PNG') else (body[4:] if body[4:8] == b'\x89PNG' else body)
            try:
                img = Image.open(io.BytesIO(png_bytes))
                img.load()
                yield group, image, img.convert('RGBA')
            except Exception:
                pass
            continue
        if fmt == 0:
            pixels = body
        elif fmt == 2:
            pixels = _decode_rle8(body)
        elif fmt == 3:
            pixels = _decode_rle5(body)
        elif fmt == 4:
            pixels = _decode_lz5(body)
        else:
            continue
        palette = _read_v2_palette(data, palette_offset, total_palettes, pal_index, ldata_offset)
        if not palette:
            continue
        expected = width * height
        pixels = pixels + b'\x00' * max(0, expected - len(pixels))
        pixels = pixels[:expected]
        try:
            img = Image.frombytes('P', (width, height), pixels)
            rgb = bytearray()
            for p in range(0, min(len(palette), 1024), 4):
                rgb.extend(palette[p:p + 3])
            rgb.extend(b'\x00' * (768 - len(rgb)))
            img.putpalette(bytes(rgb[:768]))
            yield group, image, img.convert('RGBA')
        except Exception:
            pass


def biggest_sprite(sff_path: Path):
    """Return the widest+tallest PIL Image in the .sff, or None."""
    best = None
    best_area = 0
    walker = walk_sff_v1 if True else walk_sff_v2
    for walker in (walk_sff_v1, walk_sff_v2):
        for _g, _i, img in walker(sff_path):
            w, h = img.size
            area = w * h
            if area > best_area:
                best = img
                best_area = area
    return best


def extract_one(def_path: Path, force=False):
    name = def_path.stem
    out = OUT_DIR / f'{name}.png'
    if out.exists() and not force:
        return 'skipped'
    sff = def_path.with_suffix('.sff')
    if not sff.exists():
        # Try reading .def [BG Def] / [BGdef] section for sprite reference.
        try:
            text = def_path.read_text(errors='replace')
            for line in text.splitlines():
                low = line.lower().strip()
                if low.startswith('spr') and '=' in low:
                    _, v = low.split('=', 1)
                    p = def_path.parent / v.strip().strip('"')
                    if p.exists() and p.suffix.lower() == '.sff':
                        sff = p
                        break
        except Exception:
            pass
    if not sff.exists():
        return 'no_sff'
    try:
        img = biggest_sprite(sff)
    except Exception:
        return 'parse_fail'
    if img is None:
        return 'parse_fail'
    w, h = img.size
    # Scale to fit within 320x240 (4:3 stage aspect, modest size)
    target_w = 320
    scale = min(1.0, target_w / w)
    new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
    if new_size != (w, h):
        img = img.resize(new_size, Image.LANCZOS if scale < 1 else Image.NEAREST)
    out.parent.mkdir(exist_ok=True)
    try:
        img.save(out, 'PNG')
        return 'ok'
    except Exception:
        return 'save_fail'


def main():
    force = '--force' in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    stats = {'ok': 0, 'skipped': 0, 'no_sff': 0, 'parse_fail': 0, 'save_fail': 0, 'err': 0}
    if only:
        defs = [STAGES_DIR / f'{n}.def' for n in only]
    else:
        defs = sorted(STAGES_DIR.glob('*.def'))
    for def_path in defs:
        try:
            r = extract_one(def_path, force=force)
        except Exception:
            r = 'err'
        stats[r] = stats.get(r, 0) + 1
    print('stage previews extracted:')
    for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
        print(f'  {k:15s} {v}')


if __name__ == '__main__':
    main()
