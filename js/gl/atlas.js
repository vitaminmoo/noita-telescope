// GL terrain renderer — R8 region atlas (PERF_PLAN.md Step 2.1).
//
// Every generated layer buffer (`layer.buffer`, RGB, width x (mapH+4)) becomes a
// rectangle of palette indices inside one shared R8 texture. Only the displayed
// rows (4 .. mapH+3) are copied, so the +4 header offset is baked into the
// upload and the shader never sees it.
//
// Packing is a shelf pack sorted by height descending, matching
// scripts/gl_palette_census.mjs. Seed 1 / NG+0 packs 55 layers into
// 2048 x 2559 at 61.4% occupancy (5.0 MiB).

import { AIR_INDEX, BUFFER_HEADER_ROWS, buildIndexLookup } from './palette.js';

export const DEFAULT_ATLAS_WIDTH = 2048;
// WebGL2 only guarantees MAX_TEXTURE_SIZE >= 2048; every real device reports
// >= 4096. Query gl.MAX_TEXTURE_SIZE and pass it to chooseAtlasWidth.
export const MIN_GUARANTEED_TEXTURE_SIZE = 2048;

/**
 * Shelf-packs {w, h} items, tallest first.
 * @returns {{width:number, height:number, rects:Array<{x:number,y:number,w:number,h:number}>,
 *            usedArea:number, occupancy:number}|null} null if an item is wider than atlasWidth
 */
export function shelfPack(items, atlasWidth) {
    const order = items.map((it, i) => ({ w: it.w, h: it.h, i }))
        .sort((a, b) => b.h - a.h || b.w - a.w || a.i - b.i);
    const rects = new Array(items.length).fill(null);
    let x = 0, y = 0, shelfH = 0, usedArea = 0;
    for (const it of order) {
        if (it.w > atlasWidth) return null;
        if (x + it.w > atlasWidth) { y += shelfH; x = 0; shelfH = 0; }
        rects[it.i] = { x, y, w: it.w, h: it.h };
        x += it.w;
        if (it.h > shelfH) shelfH = it.h;
        usedArea += it.w * it.h;
    }
    const height = y + shelfH;
    const area = atlasWidth * height;
    return { width: atlasWidth, height, rects, usedArea, occupancy: area ? usedArea / area : 0 };
}

/**
 * Picks the narrowest candidate width whose packed height also fits the device
 * limit, preferring DEFAULT_ATLAS_WIDTH.
 */
export function chooseAtlasWidth(layers, maxTextureSize = 4096) {
    const items = packItemsFor(layers);
    const candidates = [DEFAULT_ATLAS_WIDTH, 4096, 8192, 16384].filter(w => w <= maxTextureSize);
    for (const w of candidates) {
        const pack = shelfPack(items, w);
        if (pack && pack.height <= maxTextureSize) return w;
    }
    return null;
}

function packItemsFor(layers) {
    return layers.map(l => (l && l.buffer) ? { w: l.width, h: l.mapH } : { w: 0, h: 0 });
}

/**
 * Converts every layer buffer to palette indices and packs them into one R8 atlas.
 *
 * @param {Array<object>} layers output of generateBiomeTiles (read-only)
 * @param {object} palette from buildPalette
 * @param {object} [opts]
 * @param {number} [opts.atlasWidth=2048]
 * @returns {{data: Uint8Array, width: number, height: number,
 *            rects: Array<{x:number,y:number,w:number,h:number}|null>,
 *            usedArea: number, occupancy: number, unknownColors: number}}
 */
export function buildRegionAtlas(layers, palette, opts = {}) {
    const atlasWidth = opts.atlasWidth ?? DEFAULT_ATLAS_WIDTH;
    const items = packItemsFor(layers);
    const pack = shelfPack(items, atlasWidth);
    if (!pack) {
        const widest = Math.max(0, ...items.map(i => i.w));
        throw new Error(`GL atlas: layer of width ${widest} does not fit atlas width ${atlasWidth}`);
    }

    const rects = pack.rects.map((r, i) => (layers[i] && layers[i].buffer) ? r : null);
    const data = new Uint8Array(pack.width * pack.height);
    const lut = buildIndexLookup(palette);
    let unknownColors = 0;

    for (let i = 0; i < layers.length; i++) {
        const rect = rects[i];
        if (!rect) continue;
        const { buffer, width, mapH } = layers[i];
        for (let y = 0; y < mapH; y++) {
            let src = ((y + BUFFER_HEADER_ROWS) * width) * 3;
            let dst = (rect.y + y) * pack.width + rect.x;
            for (let x = 0; x < width; x++, src += 3, dst++) {
                const color = (buffer[src] << 16) | (buffer[src + 1] << 8) | buffer[src + 2];
                const idx = lut[color];
                if (idx === 0) { unknownColors++; data[dst] = AIR_INDEX; }
                else data[dst] = idx - 1;
            }
        }
    }

    return {
        data,
        width: pack.width,
        height: pack.height,
        rects,
        usedArea: pack.usedArea,
        occupancy: pack.occupancy,
        unknownColors,
    };
}

/** Reads one atlas texel (debug / verification helper). */
export function atlasIndexAt(atlas, rect, x, y) {
    return atlas.data[(rect.y + y) * atlas.width + (rect.x + x)];
}
