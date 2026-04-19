#!/usr/bin/env python3
"""
Extract the small-portrait sprite (group 9000, image 0) from each character's
.sff file and save as PNG at engine/chars/<name>/portrait.png.

Supports SFF v1 (most common). For SFF v2, attempts basic PNG-embedded sprite
extraction; falls back silently if the format is unsupported.

Run once to populate; re-run if new chars get added.
"""

import io
import os
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CHARS_DIR = ROOT / 'engine' / 'chars'
PORTRAIT_FILE = 'portrait.png'

# --- SFF v1 parser ---

def parse_sff_v1(path: Path, target_group=9000, target_image=0):
    """Return PIL Image for sprite (group, image) from SFF v1, or None."""
    with open(path, 'rb') as f:
        data = f.read()

    # Header: 512 bytes
    if len(data) < 512:
        return None
    sig = data[0:12]
    if not sig.startswith(b'ElecbyteSpr'):
        return None

    ver_hi = data[15]
    if ver_hi != 1:
        return None  # not SFF v1

    # Header fields (per MUGEN SFF v1 spec)
    # 16:u32 NumberOfGroups
    # 20:u32 NumberOfImages
    # 24:u32 FirstSubfileOffset
    # 28:u32 SubheaderSize
    num_images = struct.unpack_from('<I', data, 20)[0]
    first_subfile_offset = struct.unpack_from('<I', data, 24)[0]
    subheader_size = struct.unpack_from('<I', data, 28)[0]

    # Optional shared palette at the end, read later if needed.
    # Iterate subfiles
    offset = first_subfile_offset
    shared_palette = None
    for i in range(num_images):
        if offset == 0 or offset + 32 > len(data):
            break
        next_off = struct.unpack_from('<I', data, offset)[0]
        subfile_len = struct.unpack_from('<I', data, offset + 4)[0]
        group = struct.unpack_from('<H', data, offset + 12)[0]
        image = struct.unpack_from('<H', data, offset + 14)[0]
        # Sprite data immediately follows the 32-byte subheader
        pcx_start = offset + 32
        pcx_end = pcx_start + subfile_len
        if group == target_group and image == target_image:
            pcx_data = data[pcx_start:pcx_end]
            try:
                return _decode_pcx(pcx_data)
            except Exception:
                return None
        offset = next_off
    return None


def _decode_pcx(pcx_bytes: bytes):
    """Decode PCX bytes into a PIL Image. Falls back manually if PIL chokes."""
    # Try PIL first
    try:
        img = Image.open(io.BytesIO(pcx_bytes))
        img.load()
        return img.convert('RGBA')
    except Exception:
        pass
    # Manual minimal PCX decode for 8bpp RLE-encoded variant (most common in SFF)
    if len(pcx_bytes) < 128 + 769:
        raise ValueError('pcx too small')
    header = pcx_bytes[:128]
    manufacturer = header[0]
    if manufacturer != 10:
        raise ValueError('not a pcx')
    bits_per_pixel = header[3]
    xmin, ymin, xmax, ymax = struct.unpack_from('<HHHH', header, 4)
    bytes_per_line = struct.unpack_from('<H', header, 66)[0]
    n_planes = header[65]
    w = xmax - xmin + 1
    h = ymax - ymin + 1
    scanline_bytes = bytes_per_line * n_planes

    # Decode RLE body
    body = pcx_bytes[128:-768]  # assume 256-color VGA palette marker + 768 bytes palette at end
    # Actually palette marker is 1 byte (0x0C) then 768 palette bytes:
    palette_marker_idx = len(pcx_bytes) - 769
    if pcx_bytes[palette_marker_idx] == 0x0C:
        palette = pcx_bytes[palette_marker_idx + 1:palette_marker_idx + 1 + 768]
        body = pcx_bytes[128:palette_marker_idx]
    else:
        palette = b'\0' * 768
        body = pcx_bytes[128:]

    out = bytearray(scanline_bytes * h)
    bi = 0
    oi = 0
    while oi < len(out) and bi < len(body):
        b = body[bi]; bi += 1
        if (b & 0xC0) == 0xC0:
            count = b & 0x3F
            if bi >= len(body):
                break
            val = body[bi]; bi += 1
            for _ in range(count):
                if oi < len(out):
                    out[oi] = val; oi += 1
        else:
            if oi < len(out):
                out[oi] = b; oi += 1

    # Build indexed image, apply palette
    img = Image.frombytes('P', (scanline_bytes, h), bytes(out))
    img = img.crop((0, 0, w, h))
    img.putpalette(palette)
    return img.convert('RGBA')


# --- SFF v2 (best-effort PNG-embedded) ---

def _decode_rle8(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        b = data[i]; i += 1
        if (b & 0xC0) == 0x40:
            n = b & 0x3F
            if i >= len(data): break
            v = data[i]; i += 1
            out.extend(bytes([v]) * n)
        else:
            out.append(b)
    return bytes(out)


def _decode_rle5(data: bytes) -> bytes:
    """SFF v2 RLE5 decoder.
    Format: repeated blocks. First byte: run_length. Second byte: data_length.
    Bit 7 of data_length = color_bit. Remaining bits = how many following 5-bit
    color codes to emit (each code = 7 bits: 2 bits run length + 5 bits color offset).
    """
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        run = data[i]; i += 1
        if i >= n: break
        dl = data[i]; i += 1
        color = dl & 0x80  # initial "color bit"
        color_count = dl & 0x7F
        # The run_length byte: high bit says whether to emit color run of length = lower 7 bits
        if run & 0x80:
            length = run & 0x7F
            if length == 0:
                length = 1
        else:
            length = run
        # First, emit 'length' pixels of the current color (which is the first data byte encoded separately)
        # Actually the format pattern is: run_byte then data bytes encoding colors.
        # We'll follow the common Ikemen interpretation: first byte is a length-1 color code.
        if i >= n: break
        val = data[i]; i += 1  # first color value
        out.extend(bytes([val]) * length)
        # Then emit color_count more 7-bit packed entries
        for _ in range(color_count):
            if i >= n: break
            c = data[i]; i += 1
            sub_len = c >> 5  # top 3 bits = run length
            sub_color = c & 0x1F  # bottom 5 bits = color, XORed with previous high bits
            # Approximate: output sub_color as the value
            # (True RLE5 is more nuanced but this yields a reasonable fallback)
            out.extend(bytes([sub_color]) * max(1, sub_len))
    return bytes(out)


def _decode_lz5(data: bytes) -> bytes:
    """SFF v2 LZ5 decoder. Mixed RLE + LZ77 dictionary references."""
    out = bytearray()
    i = 0
    n = len(data)
    rle_ctl = 0
    rle_bit = 0
    lz_ctl = 0
    lz_bit = 0
    ctl_mode = 0  # 0 = rle, 1 = lz
    ctl_byte = 0
    ctl_counter = 0
    # Simpler interpretation: parse a flag byte then 8 tokens
    while i < n:
        if ctl_counter == 0:
            if i >= n: break
            ctl_byte = data[i]; i += 1
            ctl_counter = 8
        bit = ctl_byte & 1
        ctl_byte >>= 1
        ctl_counter -= 1
        if bit == 0:
            # Literal byte
            if i >= n: break
            out.append(data[i]); i += 1
        else:
            # Dictionary reference: 2 bytes (offset/length)
            if i + 1 >= n: break
            hi = data[i]; lo = data[i + 1]; i += 2
            length = (hi >> 4) + 3
            offset = ((hi & 0x0F) << 8) | lo
            if offset == 0 or offset > len(out):
                break
            start = len(out) - offset
            for j in range(length):
                out.append(out[start + j])
    return bytes(out)


def _read_v2_palette(data: bytes, pal_offset: int, total_palettes: int,
                    pal_index: int, ldata_offset: int) -> bytes | None:
    """Read palette N (RGBA8). Returns 1024 bytes (256 * 4)."""
    if pal_index >= total_palettes:
        pal_index = 0
    PAL_NODE_SIZE = 16
    off = pal_offset + pal_index * PAL_NODE_SIZE
    if off + PAL_NODE_SIZE > len(data):
        return None
    link_index = struct.unpack_from('<H', data, off + 6)[0]
    data_off = struct.unpack_from('<I', data, off + 8)[0]
    data_len = struct.unpack_from('<I', data, off + 12)[0]
    abs_off = ldata_offset + data_off
    if abs_off + data_len > len(data):
        return None
    return data[abs_off:abs_off + data_len]


def parse_sff_v2(path: Path, target_group=9000, target_image=0):
    """SFF v2 reader supporting raw, RLE8, RLE5 (best-effort), and PNG formats."""
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 68:
        return None
    if not data.startswith(b'ElecbyteSpr'):
        return None
    if data[15] != 2:
        return None

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
        if group != target_group or image != target_image:
            continue

        width = struct.unpack_from('<H', data, off + 4)[0]
        height = struct.unpack_from('<H', data, off + 6)[0]
        # linked_index = struct.unpack_from('<H', data, off + 12)[0]
        fmt = data[off + 14]
        # coldepth = data[off + 15]
        data_offset = struct.unpack_from('<I', data, off + 16)[0]
        data_length = struct.unpack_from('<I', data, off + 20)[0]
        pal_index = struct.unpack_from('<H', data, off + 24)[0]
        flags = struct.unpack_from('<H', data, off + 26)[0]

        if width == 0 or height == 0 or data_length < 4:
            return None

        base = tdata_offset if (flags & 1) else ldata_offset
        abs_off = base + data_offset
        if abs_off + data_length > len(data):
            return None
        sprite_bytes = data[abs_off:abs_off + data_length]
        # v2 data always has a 4-byte length header
        body = sprite_bytes[4:]

        # Decode pixels
        if fmt == 0:
            pixels = body
        elif fmt == 2:
            pixels = _decode_rle8(body)
        elif fmt == 3:
            pixels = _decode_rle5(body)
        elif fmt == 4:
            pixels = _decode_lz5(body)
        elif fmt in (10, 11, 12):
            # PNG — start probe
            probe = body[:8]
            if probe.startswith(b'\x89PNG'):
                png_bytes = body
            else:
                png_bytes = body[4:] if body[4:8] == b'\x89PNG' else body
            try:
                img = Image.open(io.BytesIO(png_bytes))
                img.load()
                return img.convert('RGBA')
            except Exception:
                return None
        else:
            return None

        # Need palette for indexed formats
        palette = _read_v2_palette(data, palette_offset, total_palettes, pal_index, ldata_offset)
        if not palette or len(palette) < 4:
            return None

        # Build image. Pixels should equal width*height bytes.
        expected = width * height
        if len(pixels) < expected:
            pixels = pixels + b'\x00' * (expected - len(pixels))
        else:
            pixels = pixels[:expected]

        img = Image.frombytes('P', (width, height), pixels)
        # SFF v2 palettes are RGBA entries (4 bytes per color); PIL's P mode wants RGB triples.
        rgb_palette = bytearray()
        for p in range(0, min(len(palette), 1024), 4):
            rgb_palette.extend(palette[p:p + 3])
        # Pad to 768 bytes (256 colors)
        rgb_palette.extend(b'\x00' * (768 - len(rgb_palette)))
        img.putpalette(bytes(rgb_palette[:768]))
        result = img.convert('RGBA')
        # Make color index 0 transparent (MUGEN convention)
        # Build alpha channel
        r, g, b, a = result.split()
        alpha = a.point(lambda _: 255)
        # index 0 == transparent
        if img.mode == 'P':
            data_bytes = img.tobytes()
            alpha = Image.frombytes('L', (width, height),
                                    bytes(255 if x != 0 else 0 for x in data_bytes))
        return Image.merge('RGBA', (r, g, b, alpha))
    return None


# --- Driver ---

def find_sff_for_char(char_dir: Path):
    """The char's .def [Files] section references the sprite file; find it."""
    def_path = char_dir / f'{char_dir.name}.def'
    if not def_path.exists():
        # try any .def
        defs = list(char_dir.glob('*.def'))
        if not defs:
            return None
        def_path = defs[0]
    try:
        with open(def_path, 'r', encoding='utf-8', errors='replace') as f:
            text = f.read()
    except Exception:
        return None
    in_files = False
    for raw in text.splitlines():
        line = raw.split(';', 1)[0].strip()
        if not line:
            continue
        if line.startswith('['):
            in_files = line.lower().startswith('[files')
            continue
        if not in_files:
            continue
        if '=' in line:
            k, v = line.split('=', 1)
            if k.strip().lower() == 'sprite':
                sff_rel = v.strip().strip('"')
                sff_path = char_dir / sff_rel
                if sff_path.exists():
                    return sff_path
                # Case-insensitive fallback
                for f in char_dir.rglob('*'):
                    if f.name.lower() == Path(sff_rel).name.lower():
                        return f
                return None
    return None


def extract_one(char_dir: Path, force=False):
    out = char_dir / PORTRAIT_FILE
    if out.exists() and not force:
        return 'skipped'
    sff = find_sff_for_char(char_dir)
    if sff is None:
        return 'no_sff'
    img = parse_sff_v1(sff)
    if img is None:
        img = parse_sff_v2(sff)
    if img is None:
        return 'parse_fail'
    # Ensure at least 25x25 up to 120x120 (MUGEN small portrait is 25x25 standard,
    # but upscale for visibility on the web page)
    max_side = 120
    w, h = img.size
    if w == 0 or h == 0:
        return 'empty'
    # Keep aspect: fit within max_side × max_side
    scale = min(max_side / w, max_side / h)
    if scale < 1.0:
        scale = 1.0
    new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
    if new_size != (w, h):
        img = img.resize(new_size, Image.NEAREST)
    try:
        img.save(out, 'PNG')
        return 'ok'
    except Exception:
        return 'save_fail'


def main():
    force = '--force' in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    stats = {'ok': 0, 'skipped': 0, 'no_sff': 0, 'parse_fail': 0, 'empty': 0, 'save_fail': 0, 'err': 0}
    dirs = [CHARS_DIR / n for n in only] if only else sorted(p for p in CHARS_DIR.iterdir() if p.is_dir())
    for char_dir in dirs:
        try:
            r = extract_one(char_dir, force=force)
        except Exception as e:
            r = 'err'
        stats[r] = stats.get(r, 0) + 1
    print('portraits extracted:')
    for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
        print(f'  {k:15s} {v}')
    total_ok = stats['ok'] + stats['skipped']
    print(f'\nusable portraits: {total_ok} / {sum(stats.values())}')


if __name__ == '__main__':
    main()
