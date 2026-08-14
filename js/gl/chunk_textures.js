// GL terrain renderer — per-chunk lookup textures (PERF_PLAN.md Step 2.2).
//
// The fragment shader resolves a world position to a biome-map chunk and then
// needs four things about that chunk, none of which can be a name lookup on the
// GPU: its biome-map color (the wobble probes compare colors), whether it has
// wang tiles, whether its biome is an edge-noise overlay exception, and whether
// its edge noise is disabled outright (`noise_biome_edges == 0`). Those live in
// one mapWidth x 48 RGBA8UI texture (rgb = color, a = flag bits), exactly like
// the spike's `u_chunkTex` (spikes/webgl-tiles/pipeline.js:83-107) minus its
// per-layer FLAG_IS_LAYER_BIOME, which the region table replaces.
//
// The gray/white palette index resolves to `TILE_FOREGROUND_COLORS[chunkColor]`
// (image_processing.js:378-388), a per-chunk lookup, so it gets its own
// mapWidth x 48 RGBA8UI texture (rgb = color, a = 255 when defined).
//
// Heaven and hell need no variants: biome_generator.js:309-315 broadcasts row 0
// / row 47, so the shader clamps the chunk row instead (report §5).
//
// Flag bits 0 and 1 keep the values indirection.js already assigns them.

import { BIOME_COLOR_TO_NAME, BIOME_COLORS_WITH_TILES } from '../generator_config.js';
import { edgeNoiseOverlayExceptions, TILE_FOREGROUND_COLORS } from '../image_processing.js';
import { biomeEdgeNoiseFlag } from '../wobble_flags.js';
import { EDGE_NOISE } from '../edge_noise.js';
import { CHUNK_FLAG_EDGE_NOISE_EXCEPTION, CHUNK_FLAG_HAS_TILES, BIOME_MAP_HEIGHT } from './indirection.js';

export { CHUNK_FLAG_EDGE_NOISE_EXCEPTION, CHUNK_FLAG_HAS_TILES };
/** `noise_biome_edges == 0`: this chunk's biome never wobbles (utils.js:174). */
export const CHUNK_FLAG_NOISE_INELIGIBLE = 1 << 2;
/** TILE_FOREGROUND_COLORS has an entry for this chunk color. */
export const CHUNK_FLAG_FG_DEFINED = 1 << 3;

/**
 * Builds both mapWidth x 48 RGBA8UI chunk textures in one pass.
 * @param {object} biomeData from generateBiomeData (reads `pixels` only)
 * @param {number} mapWidth getWorldSize(isNGP, gameMode)
 * @returns {{width:number, height:number, chunk:Uint8Array, fg:Uint8Array}}
 */
export function buildChunkTextures(biomeData, mapWidth) {
    const height = BIOME_MAP_HEIGHT;
    const count = mapWidth * height;
    const chunk = new Uint8Array(count * 4);
    const fg = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
        const color = (biomeData.pixels[i] ?? 0) & 0xffffff;
        const name = BIOME_COLOR_TO_NAME[color];
        const fgColor = TILE_FOREGROUND_COLORS[color];
        let flags = 0;
        if (BIOME_COLORS_WITH_TILES.has(color)) flags |= CHUNK_FLAG_HAS_TILES;
        if (name && edgeNoiseOverlayExceptions.has(name)) flags |= CHUNK_FLAG_EDGE_NOISE_EXCEPTION;
        if (biomeEdgeNoiseFlag(color, 'noise_biome_edges') === 0) flags |= CHUNK_FLAG_NOISE_INELIGIBLE;
        if (fgColor !== undefined) flags |= CHUNK_FLAG_FG_DEFINED;
        chunk[i * 4] = (color >> 16) & 0xff;
        chunk[i * 4 + 1] = (color >> 8) & 0xff;
        chunk[i * 4 + 2] = color & 0xff;
        chunk[i * 4 + 3] = flags;
        const f = fgColor ?? 0;
        fg[i * 4] = (f >> 16) & 0xff;
        fg[i * 4 + 1] = (f >> 8) & 0xff;
        fg[i * 4 + 2] = f & 0xff;
        fg[i * 4 + 3] = fgColor !== undefined ? 255 : 0;
    }
    return { width: mapWidth, height, chunk, fg };
}

/**
 * The 512-entry doubled permutation table (`EDGE_NOISE_2`, edge_noise.js:17-21).
 * Indices up to 255 + 255 occur when the two hashed lattice coords are summed.
 */
export function buildNoiseTable512() {
    const t = new Uint8Array(512);
    for (let i = 0; i < 512; i++) t[i] = EDGE_NOISE[i & 0xff];
    return t;
}
