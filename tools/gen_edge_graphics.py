#!/usr/bin/env python3
"""Extract Noita's per-material <EdgeGraphics> decal tables and pack the
edge_files sprites into one RGBA atlas.

The engine dresses freshly generated terrain by stamping little sprites along
material/air borders (BiomeGen_StampEdgeDecalAtCell @0x00721870, the runtime
twin BiomeMaterials_PaintEdgeMaterial @0x00721da0). The decals are baked INTO
the cells' colors, which is why they show up in a baked-color dump but never in
a material-grid dump. See reverse/noita docs/worldgen/cell_color_dressing.md.

Per material, materials.xml carries at most one <EdgeGraphics> under
<Graphics><Edge>, with:

    type      COLOR_EDGE_PIXELS(0) / EVERYWHERE(1) / CARDINAL_DIRECTIONS(2) /
              NORMAL_BASED(3)
    percent   per-(cell x entry) probability that a stamp happens at all
    require_same_material / require_same_material_type
              which 3x3 mask the "is this cell an edge cell" test uses
    overwrite whether an already-dressed cell may be dressed again
    color     the tint COLOR_EDGE_PIXELS composites (unused by the image types)
    <Images>  the sprite list; CARDINAL_DIRECTIONS/NORMAL_BASED pick by the
              edge angle ([min_angle, max_angle) in DEGREES), EVERYWHERE picks
              uniformly at random and may rotate (allow_random_rotation).

CellDataChild inherits its parent's <Graphics>, and therefore its <Edge>, when
it declares none of its own -- 63 declared blocks resolve to 100 materials.

Outputs:
    data/edge_atlas.bin           raw RGBA8 rows, width*height*4 bytes
    js/engine_resolve/edge_data.js  the tables (sprite rects included)

Raw bytes rather than a PNG for the same reason as the material atlas: browser
PNG decoding may alter pixel values and byte-exactness against the game is the
point.

Usage:
    python3 tools/gen_edge_graphics.py [path/to/data.wak.unpacked]
"""

import json
import os
import sys
import xml.etree.ElementTree as ET

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA = os.path.expanduser(
    '~/reverse/noita/noita_Jan_25_2025_15:55:41/data/data.wak.unpacked')
ATLAS_WIDTH = 256

# Cellfactory_helper_004ac580's enum. INGESTION_FREEZING is not in that switch
# (it falls through to the default no-op), so it maps to -1 and is dropped.
TYPE_ENUM = {
    'COLOR_EDGE_PIXELS': 0,
    'EVERYWHERE': 1,
    'CARDINAL_DIRECTIONS': 2,
    'NORMAL_BASED': 3,
}

# The "same material type" gate compares the cell's C++ class (cell vtable+0x04)
# plus two class properties. In XML terms that is cell_type, split for liquids by
# liquid_static (static wall cells) and liquid_sand (powders): a sand_static wall
# and the water lapping against it are different types, so the wall's border with
# the water is an edge, while its border with rock_static is not.
TYPE_KEYS = ['air', 'static', 'sand', 'liquid', 'solid', 'gas', 'fire']

IMG_FLAG_RANDOM_ROTATION = 1
IMG_FLAG_HORIZONTAL_STRIPE = 2
IMG_FLAG_VERTICAL_STRIPE = 4


def parse_materials(xml_path):
    root = ET.parse(xml_path).getroot()
    mats = [c for c in root if c.tag in ('CellData', 'CellDataChild')]
    by_name = {m.get('name'): m for m in mats}

    def inherited(m, attr, depth=0):
        if depth > 16:
            return None
        v = m.get(attr)
        if v is not None:
            return v
        p = by_name.get(m.get('_parent'))
        return inherited(p, attr, depth + 1) if p is not None else None

    def edge_of(m, depth=0):
        if depth > 16:
            return None
        g = m.find('Graphics')
        if g is not None:
            e = g.find('Edge')
            if e is not None:
                return e
        p = by_name.get(m.get('_parent'))
        return edge_of(p, depth + 1) if p is not None else None

    return mats, inherited, edge_of


def type_key(inherited, m):
    cell_type = inherited(m, 'cell_type')
    if cell_type != 'liquid':
        return cell_type if cell_type in TYPE_KEYS else 'air'
    if inherited(m, 'liquid_static') == '1':
        return 'static'
    if inherited(m, 'liquid_sand') == '1':
        return 'sand'
    return 'liquid'


def basename(filename):
    return filename.rsplit('/', 1)[-1]


def pack(sizes, width):
    """sizes: [(key, w, h)] -> {key: (x, y)}, total height. Tallest-first shelf
    packing; 118 sprites of at most 40x24 make placement quality irrelevant."""
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
    data_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DATA
    mats, inherited, edge_of = parse_materials(os.path.join(data_dir, 'materials.xml'))

    # ---- collect entries -----------------------------------------------------
    files = {}            # basename -> PIL image
    image_key_to_index = {}
    images = []           # [file, min_angle, max_angle, flags]
    entries_by_material = {}
    skipped_types = {}

    for m in mats:
        edge = edge_of(m)
        if edge is None:
            continue
        entries = []
        for eg in edge.findall('EdgeGraphics'):
            type_name = eg.get('type') or ''
            type_id = TYPE_ENUM.get(type_name, -1)
            if type_id < 0:
                skipped_types[type_name] = skipped_types.get(type_name, 0) + 1
                continue
            idxs = []
            for im in eg.iter('Image'):
                fname = basename(im.get('filename') or '')
                if not fname:
                    continue
                if fname not in files:
                    path = os.path.join(data_dir, 'materials_gfx', 'edge_files', fname)
                    files[fname] = Image.open(path).convert('RGBA')
                lo = float(im.get('min_angle', 0))
                hi = float(im.get('max_angle', 360))
                flags = 0
                if im.get('allow_random_rotation') == '1':
                    flags |= IMG_FLAG_RANDOM_ROTATION
                if im.get('do_only_horizontal_stripe') == '1':
                    flags |= IMG_FLAG_HORIZONTAL_STRIPE
                if im.get('do_only_vertical_stripe') == '1':
                    flags |= IMG_FLAG_VERTICAL_STRIPE
                key = (fname, lo, hi, flags)
                if key not in image_key_to_index:
                    image_key_to_index[key] = len(images)
                    images.append(list(key))
                idxs.append(image_key_to_index[key])
            color = eg.get('color')
            entries.append([
                type_id,
                float(eg.get('percent', 1)),
                1 if eg.get('overwrite') == '1' else 0,
                1 if eg.get('require_same_material') == '1' else 0,
                1 if eg.get('require_same_material_type') == '1' else 0,
                (int(color, 16) & 0xffffffff) if color else 0,
                idxs,
            ])
        if entries:
            entries_by_material[m.get('name')] = entries

    # ---- pack the sprites ----------------------------------------------------
    sizes = [(f, im.width, im.height) for f, im in files.items()]
    pos, height = pack(sizes, ATLAS_WIDTH)
    blob = bytearray(ATLAS_WIDTH * height * 4)
    rects = {}
    for name, im in files.items():
        x0, y0 = pos[name]
        rects[name] = (x0, y0, im.width, im.height)
        px = im.tobytes()
        for row in range(im.height):
            dst = ((y0 + row) * ATLAS_WIDTH + x0) * 4
            src = row * im.width * 4
            blob[dst:dst + im.width * 4] = px[src:src + im.width * 4]

    image_rows = []
    for fname, lo, hi, flags in images:
        x, y, w, h = rects[fname]
        image_rows.append([x, y, w, h, lo, hi, flags])

    # ---- material type keys --------------------------------------------------
    type_by_material = {}
    for m in mats:
        type_by_material[m.get('name')] = TYPE_KEYS.index(type_key(inherited, m))

    # ---- emit ----------------------------------------------------------------
    with open(os.path.join(REPO, 'data', 'edge_atlas.bin'), 'wb') as f:
        f.write(blob)

    def jdump(v):
        return json.dumps(v, separators=(',', ':'), sort_keys=True)

    out = f'''// GENERATED by tools/gen_edge_graphics.py — do not edit by hand.
// Noita's per-material <EdgeGraphics> decal tables, parent-resolved, plus the
// rects of the edge_files sprites packed into data/edge_atlas.bin.
//
// EDGE_IMAGES[i] = [atlasX, atlasY, w, h, minAngle, maxAngle, flags]
//   angles are DEGREES in [0, 360); flags: 1 = allow_random_rotation,
//   2 = do_only_horizontal_stripe, 4 = do_only_vertical_stripe.
// EDGE_ENTRIES_BY_MATERIAL[name] = [[type, percent, overwrite,
//   requireSameMaterial, requireSameMaterialType, colorARGB, [imageIndex...]]]
//   type: 0 COLOR_EDGE_PIXELS, 1 EVERYWHERE, 2 CARDINAL_DIRECTIONS,
//         3 NORMAL_BASED (Cellfactory_helper_004ac580).
// MATERIAL_TYPE_BY_NAME[name] indexes MATERIAL_TYPE_KEYS — the equivalence
//   class the require_same_material_type edge gate compares.
export const EDGE_ATLAS_WIDTH = {ATLAS_WIDTH};
export const EDGE_ATLAS_HEIGHT = {height};
export const MATERIAL_TYPE_KEYS = {jdump(TYPE_KEYS)};
export const EDGE_IMAGES = {jdump(image_rows)};
export const EDGE_ENTRIES_BY_MATERIAL = {jdump(entries_by_material)};
export const MATERIAL_TYPE_BY_NAME = {jdump(type_by_material)};
'''
    dest = os.path.join(REPO, 'js', 'engine_resolve', 'edge_data.js')
    with open(dest, 'w') as f:
        f.write(out)

    used = sum(w * h for _, w, h in sizes)
    print(f'{len(entries_by_material)} materials with edge graphics, '
          f'{len(images)} image entries over {len(files)} sprites')
    print(f'atlas {ATLAS_WIDTH}x{height} '
          f'({len(blob) / 1e3:.0f} kB, {100 * used / (ATLAS_WIDTH * height):.0f}% occupied)')
    print(f'wrote {dest} ({len(out) / 1024:.0f} KiB)')
    if skipped_types:
        print('skipped unsupported types:', skipped_types)


if __name__ == '__main__':
    main()
