// GL terrain renderer — everything the upload needs that is computed, not
// uploaded: the CPU half of GLTerrainRenderer.buildAndUpload.
//
// Nothing here touches a GL context or the DOM, so it runs wherever the tile
// layers are: on the page (the renderer builds lazily when it is handed none)
// or in the terrain worker (js/terrain_worker.js), which builds it beside the
// generation and hands the arrays over, leaving the page only the uploads.
//
// What it does NOT build is the three material tables (material color, palette
// material, fill material): they read the material atlas, which lives with the
// renderer, and cost a few milliseconds.
import { getWorldSize } from '../utils.js';
import { buildChunkTextures, buildNoiseTable512 } from './chunk_textures.js';
import { buildEngineResources, buildEngineTable, buildSinHashAndGrids, surfaceNoisePhase } from './engine_resources.js';
import { buildTerrainResources } from './terrain_resources.js';

/**
 * @param {Array<object>} layers     generateBiomeTiles' layers
 * @param {object} biomeData         generateBiomeData's result
 * @param {object} opts
 *   isNGP, gameMode, seed
 *   maxTextureSize   gl.MAX_TEXTURE_SIZE of the context that will upload
 *   lut              buildPaletteLUT options (recolorMaterials, clearSpawnPixels)
 *   engineTerrain    build the engine-resolve lattices and modifier grids
 *   generatorConfig  GENERATOR_CONFIG
 *   sinHash          buildSinHashAndGrids(seed), when it was built elsewhere
 *                    (it needs only the seed, so it can run beside the generation)
 * @returns {object} `timings` holds the wall time of each step (ms)
 */
export function buildTerrainCpuResources(layers, biomeData, opts) {
    const timings = {};
    const timed = (name, fn) => {
        const s = performance.now();
        const r = fn();
        timings[name] = (timings[name] || 0) + (performance.now() - s);
        return r;
    };
    const { isNGP = false, gameMode = 'normal', seed = 0 } = opts;
    const mapWidth = getWorldSize(isNGP, gameMode);
    const resources = timed('regionAtlas', () => buildTerrainResources(layers, biomeData, {
        isNGP, gameMode, maxTextureSize: opts.maxTextureSize, lut: opts.lut,
    }));
    const chunkTextures = timed('chunkTextures', () => buildChunkTextures(biomeData, mapWidth));
    // Engine resolve mode: the game's own 1/10 lattices + per-biome tables,
    // built from the same layers (lattice_builder.js, bit-exact vs COVDUMP).
    let engine = null, sinHash = null;
    if (opts.engineTerrain) {
        engine = timed('engineLattice', () => buildEngineResources(layers, biomeData, opts.generatorConfig ?? {}, mapWidth));
        // sin-hash rows + the seed's BitmapCaves modifier grids (one texture)
        sinHash = opts.sinHash ?? timed('sinHashGrids', () => buildSinHashAndGrids(seed));
    }
    // The per-biome band table also serves the pixel-scene material pass
    // (scene_renderer.js), whatever the terrain mode.
    const engTable = timed('engineTable', () => buildEngineTable(seed));
    const noiseTable = timed('noiseTable', () => buildNoiseTable512());
    return {
        // What the build depended on, so the renderer can tell a stale one.
        seed, isNGP, gameMode, engineTerrain: !!opts.engineTerrain, maxTextureSize: opts.maxTextureSize,
        recolorMaterials: opts.lut?.recolorMaterials !== false,
        mapWidth, resources, chunkTextures, engine, engTable, sinHash, noiseTable,
        surfacePhase: opts.engineTerrain ? surfaceNoisePhase(seed) : 0,
        timings,
    };
}

/** The typed-array buffers of a build, for a transferring postMessage. */
export function terrainCpuResourceBuffers(cpu) {
    const buffers = new Set();
    const walk = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 4) return;
        if (ArrayBuffer.isView(v)) { buffers.add(v.buffer); return; }
        if (v instanceof Map || v instanceof Set) return;
        for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };
    walk(cpu, 0);
    return [...buffers];
}

/**
 * Makes a build that crossed a postMessage whole again: the palette's lookup
 * closure does not survive a structured clone (dropPaletteClosure removes it
 * before the post).
 */
export function reviveTerrainCpuResources(cpu) {
    const palette = cpu.resources.palette;
    if (!palette.indexOf) palette.indexOf = (color) => palette.index.get(color);
    return cpu;
}

export function dropPaletteClosure(cpu) {
    delete cpu.resources.palette.indexOf;
    return cpu;
}
