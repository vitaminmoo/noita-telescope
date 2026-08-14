// GL terrain renderer — per-material texture atlas.
//
// The engine bakes every cell's color at chunk generation:
//     color = materials_gfx/<texture>.png[(x mod w + w) mod w, (y mod h + h) mod h]
// with the cell's absolute world coordinates, or the material's flat color when
// it has no texture (CellFactory_GetCellColor @0x007044a0 — randomize_colors
// defaults to false and nothing in vanilla sets it, verified against live baked
// cell colors). The fragment shader reproduces exactly that: it already has the
// fragment's exact integer world position, so a material only needs its texel
// rect on an atlas texture.
//
// tools/gen_material_atlas.py packs the 131 texture files referenced by
// data/material_data.json into data/material_atlas.{bin,json}; this module
// loads them and derives the two GPU-side lookup tables:
//
//   palette index -> material entry   (buildPaletteMaterialTable)
//   fill chunk    -> material entry   (buildFillMaterialTable)
//
// where a "material entry" is a 1-based index into the atlas rect list (0 = no
// texture -> the shader keeps the flat palette / foreground color).
//
// The .bin is raw RGBA rows rather than a PNG so no browser image decode can
// touch the bytes — byte-exactness against the game is the point.

import { FILL_LAYER_MATERIALS } from '../generator_config.js';
import { MATERIAL_COLOR_LOOKUP, MATERIAL_DATA } from '../potion_config.js';
import { BIOME_MAP_HEIGHT } from './indirection.js';
import { PALETTE_SIZE, FIRST_COLOR_INDEX } from './palette.js';

let _atlas = null;      // {width, height, data, meta, entryCount, entryByMaterial}
let _loadPromise = null;

/** Kicks off (or returns) the one-time fetch of the atlas data. */
export function initMaterialAtlas() {
    return _loadPromise ??= (async () => {
        const [metaResp, binResp] = await Promise.all([
            fetch('../data/material_atlas.json'),
            fetch('../data/material_atlas.bin'),
        ]);
        if (!metaResp.ok || !binResp.ok) throw new Error('material atlas fetch failed');
        const layout = await metaResp.json();
        const data = new Uint8Array(await binResp.arrayBuffer());
        if (data.length !== layout.width * layout.height * 4) {
            throw new Error(`material atlas size mismatch: ${data.length} bytes for ${layout.width}x${layout.height}`);
        }

        // 1-based entry per texture file, in the json's (sorted) key order.
        const files = Object.keys(layout.textures).sort();
        const entryByFile = new Map();
        const meta = new Uint16Array(files.length * 4);
        files.forEach((file, i) => {
            entryByFile.set(file, i + 1);
            meta.set(layout.textures[file], i * 4);   // x, y, w, h
        });

        const entryByMaterial = new Map();
        for (const m of MATERIAL_DATA) {
            if (m.texture && entryByFile.has(m.texture)) {
                entryByMaterial.set(m.name, entryByFile.get(m.texture));
            }
        }

        _atlas = {
            width: layout.width,
            height: layout.height,
            data,
            meta,
            entryCount: files.length,
            entryByMaterial,
        };
        return _atlas;
    })();
}

/** The loaded atlas, or null while the fetch is in flight / failed. */
export function getMaterialAtlas() {
    return _atlas;
}

/** Material entry index (1-based, 0 = no texture) for a material name. */
export function materialAtlasEntry(atlas, name) {
    return (atlas && name && atlas.entryByMaterial.get(name)) || 0;
}

/** Negative-safe modulo, as the engine's texel wrap does it. */
const pmod = (v, m) => ((v % m) + m) % m;

/**
 * The engine's baked cell color for a textured material at absolute world
 * coordinates: materials_gfx/<texture>.png[(x mod w + w) mod w, ...], the same
 * rule the fragment shader's materialTexel() runs (CellFactory_GetCellColor
 * @0x007044a0).
 *
 * Returns 0xRRGGBB, or -1 for a transparent texel — the engine creates no cell
 * there, so the caller must paint nothing rather than paint black.
 */
export function materialTexelRGB(atlas, entry, worldX, worldY) {
    const m = (entry - 1) * 4;
    const rx = atlas.meta[m], ry = atlas.meta[m + 1], rw = atlas.meta[m + 2], rh = atlas.meta[m + 3];
    const o = ((ry + pmod(worldY, rh)) * atlas.width + (rx + pmod(worldX, rw))) * 4;
    if (atlas.data[o + 3] === 0) return -1;
    return (atlas.data[o] << 16) | (atlas.data[o + 1] << 8) | atlas.data[o + 2];
}

/** Material entry index for a raw 0xRRGGBB wang color (0 = no texture). */
function entryForWangColor(atlas, raw) {
    const name = MATERIAL_COLOR_LOOKUP[raw.toString(16).padStart(6, '0')];
    return (name && atlas.entryByMaterial.get(name)) || 0;
}

/**
 * 256x1 R8UI: palette index -> material entry. Direct color entries resolve
 * through their wang color; air / gray / white stay 0 (no texture).
 */
export function buildPaletteMaterialTable(atlas, palette) {
    const table = new Uint8Array(PALETTE_SIZE);
    for (let i = FIRST_COLOR_INDEX; i < palette.size; i++) {
        table[i] = entryForWangColor(atlas, palette.colors[i]);
    }
    return table;
}

/**
 * mapWidth x 48 R8UI: fill chunk -> material entry of its fill material.
 * Mirrors buildChunkTextures' CHUNK_FLAG_FILL set (FILL_LAYER_MATERIALS), so a
 * fill chunk's flat foreground color and its texture entry always describe the
 * same material.
 */
export function buildFillMaterialTable(atlas, biomeData, mapWidth) {
    const table = new Uint8Array(mapWidth * BIOME_MAP_HEIGHT);
    for (let i = 0; i < table.length; i++) {
        const color = (biomeData.pixels[i] ?? 0) & 0xffffff;
        const material = FILL_LAYER_MATERIALS[color];
        if (material === undefined) continue;
        table[i] = atlas.entryByMaterial.get(material) ?? 0;
    }
    return table;
}
