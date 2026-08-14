#!/usr/bin/env python3
"""Pack the game's materials_gfx textures into one RGBA atlas for the GL renderer.

The engine bakes every cell's color at creation time as
    color = materials_gfx/<texture>.png[(x mod w + w) mod w, (y mod h + h) mod h]
(CellFactory_GetCellColor @0x007044a0 / CellFactory_SamplePixelGrid @0x007042c0;
randomize_colors defaults to false and no vanilla material sets it, verified
live against baked cell colors 2026-08-14). The GL terrain shader reproduces
that per fragment, so it needs the raw texel data of every material texture on
the GPU. This script packs the 131 texture files referenced by
data/material_data.json into:

    data/material_atlas.bin   raw RGBA8 rows, atlasW*atlasH*4 bytes
    data/material_atlas.json  {width, height, textures: {file: [x, y, w, h]}}

Raw bytes, not a PNG: browser PNG decoding can alter pixel values (color
management, premultiplication), and byte-exactness against the game is the
whole point.

Usage:
    python3 tools/gen_material_atlas.py [path/to/data.wak.unpacked/materials_gfx]
"""

import json
import os
import sys

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_GFX = os.path.expanduser(
    '~/reverse/noita/noita_Jan_25_2025_15:55:41/data/data.wak.unpacked/materials_gfx')
ATLAS_WIDTH = 1024


def shelf_pack(sizes, width):
    """sizes: [(key, w, h)] -> {key: (x, y)}, total height. Shelf packing,
    tallest first — fine at this scale (131 images, ~4.4 MB)."""
    order = sorted(sizes, key=lambda s: (-s[2], -s[1], s[0]))
    pos = {}
    x = y = shelf_h = 0
    for key, w, h in order:
        if w > width:
            raise SystemExit(f'{key}: width {w} exceeds atlas width {width}')
        if x + w > width:
            x = 0
            y += shelf_h
            shelf_h = 0
        pos[key] = (x, y)
        x += w
        shelf_h = max(shelf_h, h)
    return pos, y + shelf_h


def main():
    gfx = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GFX
    with open(os.path.join(REPO, 'data', 'material_data.json')) as f:
        materials = json.load(f)
    files = sorted({m['texture'] for m in materials if m['texture']})

    images = {}
    sizes = []
    for name in files:
        im = Image.open(os.path.join(gfx, name)).convert('RGBA')
        images[name] = im
        sizes.append((name, im.width, im.height))

    pos, height = shelf_pack(sizes, ATLAS_WIDTH)

    data = bytearray(ATLAS_WIDTH * height * 4)
    rects = {}
    for name, im in images.items():
        x0, y0 = pos[name]
        rects[name] = [x0, y0, im.width, im.height]
        px = im.tobytes()  # RGBA rows
        for row in range(im.height):
            dst = ((y0 + row) * ATLAS_WIDTH + x0) * 4
            src = row * im.width * 4
            data[dst:dst + im.width * 4] = px[src:src + im.width * 4]

    out_bin = os.path.join(REPO, 'data', 'material_atlas.bin')
    out_json = os.path.join(REPO, 'data', 'material_atlas.json')
    with open(out_bin, 'wb') as f:
        f.write(data)
    with open(out_json, 'w') as f:
        json.dump({'width': ATLAS_WIDTH, 'height': height, 'textures': rects},
                  f, indent=0, sort_keys=True)
    used = sum(w * h for _, w, h in sizes)
    print(f'{len(files)} textures -> {ATLAS_WIDTH}x{height} '
          f'({len(data) / 1e6:.1f} MB, {100 * used / (ATLAS_WIDTH * height):.0f}% occupied)')


if __name__ == '__main__':
    main()
