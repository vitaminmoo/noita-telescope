// GL terrain renderer — CPU-side resource build (PERF_PLAN.md Step 2.1).
//
// One call turns the output of generateBiomeTiles into everything the GPU needs:
// a global palette, an R8 index atlas of every layer buffer, the per-region
// metadata (atlas rect + world anchor), and the chunk indirection table.
//
// Read-only over `layer.buffer` — the buffers and the POI scanner path are
// untouched by design (PERF_PLAN.md hard constraint).
//
// Rebuild trigger: the same one as generateBiomeTiles (seed / NG+ / game mode).
// Setting changes that only affect colors need buildPaletteLUT + a 1 KiB
// texSubImage2D, not a rebuild.

import { buildRegionAtlas, chooseAtlasWidth } from './atlas.js';
import { buildChunkIndirection, buildRegionTable } from './indirection.js';
import { buildPalette, buildPaletteLUT } from './palette.js';

/**
 * @param {Array<object>} layers output of generateBiomeTiles
 * @param {object} biomeData output of generateBiomeData (only `pixels` is read)
 * @param {object} [opts]
 * @param {boolean} [opts.isNGP=false]
 * @param {string}  [opts.gameMode='normal']
 * @param {number}  [opts.atlasWidth] overrides the automatic choice
 * @param {number}  [opts.maxTextureSize=4096] both atlas axes stay within this;
 *                  pass gl.MAX_TEXTURE_SIZE
 * @param {object}  [opts.lut] options forwarded to buildPaletteLUT
 * @returns {{palette, atlas, regions, indirection, paletteLUT, stats}}
 */
export function buildTerrainResources(layers, biomeData, opts = {}) {
    const isNGP = opts.isNGP ?? false;
    const gameMode = opts.gameMode ?? 'normal';
    // 2048 wide is enough for NG0 (2048x2559), but nightmare packs 4608 rows
    // there, so the width is chosen against the texture limit by default.
    const maxTextureSize = opts.maxTextureSize ?? 4096;
    const atlasWidth = opts.atlasWidth ?? chooseAtlasWidth(layers, maxTextureSize);
    if (!atlasWidth) throw new Error(`GL atlas: no candidate width packs within MAX_TEXTURE_SIZE ${maxTextureSize}`);

    const palette = buildPalette(layers);
    const paletteLUT = buildPaletteLUT(palette, opts.lut);
    const atlas = buildRegionAtlas(layers, palette, { atlasWidth });
    const regions = buildRegionTable(layers, atlas.rects, { isNGP, gameMode });
    const indirection = buildChunkIndirection(biomeData, layers, regions, { isNGP, gameMode });

    return {
        palette,
        paletteLUT,
        atlas,
        regions,
        indirection,
        stats: {
            layers: layers.length,
            regions: regions.length,
            paletteSize: palette.size,
            collapsedGrayLevels: palette.grayLevels.length,
            atlasWidth: atlas.width,
            atlasHeight: atlas.height,
            atlasBytes: atlas.width * atlas.height,
            occupancy: atlas.occupancy,
            coveredChunks: indirection.covered,
            chunkConflicts: indirection.conflicts,
            unknownColors: atlas.unknownColors,
        },
    };
}
