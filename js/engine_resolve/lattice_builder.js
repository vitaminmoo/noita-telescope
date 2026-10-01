// Builds Noita's global 1/10-scale coverage + material lattices from
// telescope's own assembled wang layers — the same planes the engine's
// topology-2 per-pixel resolver samples (BiomeChunk+0x1d4).
//
// Port of the engine model in WangTile_ApplyMaterialsToGrid @0x008704c0,
// validated bit-exact against a live COVDUMP (99.9856% of every populated cell
// world-wide; 100.0000% on the validation window — the residual classes are
// region-edge wrap and mask-hidden neighbours, see
// reverse/noita docs/worldgen/covergrid_population.md "Corrections"):
//   per region (= one telescope layer buffer, display rows only):
//     RGB 0x000000                 -> skipped (cov 0, mat 0); black is NOT air
//     RGB in the material table    -> mat = id+1, cov = +1.0 (-1.0 iff id == 0)
//     RGB in the biome's spawn set -> magic pixel; cov 0, mat 0
//     otherwise                    -> density ramp ((g + b) + b)/3 on
//                                     1/255-prenormalised float32 channels
//     then the neighbour-majority post-pass (toroidal, strict-> running max)
//   per chunk: rect copy region -> global at dst = trunc(c*512/10),
//              src = dst - trunc(regionMin*512/10)  (51/52 column alternation)
import {
    BIOME_ENGINE, SPAWN_COLORS_BY_BIOME, WANG_COLOR_TO_ID,
} from './engine_data.js';

const F = Math.fround;
const INV255 = F(1 / 255);
const BUFFER_HEADER_ROWS = 4;
const td = (n) => Math.trunc(n / 10);

const COLOR_TO_ID = new Map(WANG_COLOR_TO_ID);
const SPAWN_BY_BIOME = new Map(SPAWN_COLORS_BY_BIOME.map(([c, list]) => [c, new Set(list)]));
const ALL_SPAWN = new Set();
for (const [, list] of SPAWN_COLORS_BY_BIOME) for (const c of list) ALL_SPAWN.add(c);
const ENGINE_BY_COLOR = new Map(BIOME_ENGINE.map(b => [b.color, b]));

function regionPlanes(layer, spawn) {
    const { buffer, width, mapH } = layer;
    const n = width * mapH;
    const cov = new Float32Array(n), mat = new Uint16Array(n);
    // A layer is runs of a few colors, so the answer for the last color is
    // kept: the two table lookups were most of this function's time.
    let lastRgb = 0, lastMat = 0, lastCov = 0;
    for (let y = 0; y < mapH; y++) {
        let s = (y + BUFFER_HEADER_ROWS) * width * 3;
        const drow = y * width;
        for (let x = 0; x < width; x++, s += 3) {
            const g = buffer[s + 1], bl = buffer[s + 2];
            const rgb = (buffer[s] << 16) | (g << 8) | bl;
            if (rgb === 0) continue;
            if (rgb !== lastRgb) {
                lastRgb = rgb;
                const id = COLOR_TO_ID.get(rgb);
                if (id !== undefined) { lastMat = id + 1; lastCov = id === 0 ? -1 : 1; }
                else if (spawn && spawn.has(rgb)) { lastMat = 0; lastCov = 0; /* magic pixel */ }
                else {
                    const fb = F(bl * INV255), fg = F(g * INV255);
                    lastMat = 0;
                    lastCov = F(F(F(fg + fb) + fb) / 3);
                }
            }
            mat[drow + x] = lastMat;
            cov[drow + x] = lastCov;
        }
    }
    neighbourMajority(cov, mat, width, mapH);
    return { cov, mat, width, mapH };
}

// The skipSmoothing post-pass: mat==0 && cov==0 cells take the 4-neighbour
// majority material against a snapshot; neighbour reads wrap toroidally and a
// 2-2 tie goes to the value that REACHED 2 first (strict > running max).
function neighbourMajority(cov, mat, w, h) {
    let out = null;   // copied on the first change: most regions have none
    for (let y = 0; y < h; y++) {
        const row = y * w;
        const up = (y === 0 ? h - 1 : y - 1) * w, down = (y === h - 1 ? 0 : y + 1) * w;
        for (let x = 0; x < w; x++) {
            const i = row + x;
            if (mat[i] !== 0 || cov[i] !== 0) continue;
            // In the order the engine visits them: left, right, up, down.
            const a = mat[row + (x === 0 ? w - 1 : x - 1)], b = mat[row + (x === w - 1 ? 0 : x + 1)];
            const c = mat[up + x], d = mat[down + x];
            // The first value to reach the highest count wins, zeros never counted.
            let best = 0, bestN = 0;
            if (a !== 0) { best = a; bestN = 1; }
            if (b !== 0) {
                const nb = b === a ? 2 : 1;
                if (nb > bestN) { best = b; bestN = nb; }
            }
            if (c !== 0) {
                const nc = 1 + (c === a ? 1 : 0) + (c === b ? 1 : 0);
                if (nc > bestN) { best = c; bestN = nc; }
            }
            if (d !== 0) {
                const nd = 1 + (d === a ? 1 : 0) + (d === b ? 1 : 0) + (d === c ? 1 : 0);
                if (nd > bestN) best = d;
            }
            if (best !== 0) {
                if (!out) out = mat.slice();
                out[i] = best;
            }
        }
    }
    if (out) mat.set(out);
}

// Mirrors gl/indirection.js claimedChunks.
function claimedChunks(layer, mapWidth, mapHeight) {
    const out = [];
    if (layer.validChunks) {
        for (const key of layer.validChunks) {
            const comma = key.indexOf(',');
            const cx = parseInt(key.slice(0, comma), 10), cy = parseInt(key.slice(comma + 1), 10);
            if (cx < 0 || cy < 0 || cx >= mapWidth || cy >= mapHeight) continue;
            out.push([cx, cy]);
        }
        return out;
    }
    const cx0 = layer.chunkBasePos ? layer.chunkBasePos.x : layer.minX;
    const cy0 = layer.chunkBasePos ? layer.chunkBasePos.y : layer.minY;
    const cw = Math.max(1, Math.ceil(layer.w / 512)), ch = Math.max(1, Math.ceil(layer.h / 512));
    for (let cy = Math.max(0, cy0); cy < Math.min(mapHeight, cy0 + ch); cy++)
        for (let cx = Math.max(0, cx0); cx < Math.min(mapWidth, cx0 + cw); cx++) out.push([cx, cy]);
    return out;
}

/**
 * @param {Array<object>} layers output of generateBiomeTiles (read-only)
 * @param {object} generatorConfig GENERATOR_CONFIG (for the per-biome spawn set)
 * @param {number} mapWidth biome-map width in chunks
 * @param {number} mapHeight biome-map height (48)
 * @returns {{GW:number, GH:number, cov:Float32Array, mat:Uint16Array,
 *            chunkCovered:Uint8Array}} chunkCovered is mapWidth*mapHeight.
 */
export function buildEngineLattice(layers, generatorConfig, mapWidth, mapHeight) {
    const GW = td(mapWidth * 512), GH = td(mapHeight * 512);
    const cov = new Float32Array(GW * GH);
    const mat = new Uint16Array(GW * GH);
    const chunkCovered = new Uint8Array(mapWidth * mapHeight);
    for (const layer of layers) {
        if (!layer.buffer) continue;
        const conf = generatorConfig[layer.biomeName];
        const spawn = SPAWN_BY_BIOME.get((conf?.color ?? 0) & 0xffffff) || ALL_SPAWN;
        const rp = regionPlanes(layer, spawn);
        const rox = td(layer.minX * 512), roy = td(layer.minY * 512);
        for (const [cx, cy] of claimedChunks(layer, mapWidth, mapHeight)) {
            const dx0 = td(cx * 512), dx1 = td((cx + 1) * 512);
            const dy0 = td(cy * 512), dy1 = td((cy + 1) * 512);
            let wrote = false;
            for (let dy = dy0; dy < dy1; dy++) {
                const sy = dy - roy;
                if (sy < 0 || sy >= rp.mapH) continue;
                for (let dx = dx0; dx < dx1; dx++) {
                    const sx = dx - rox;
                    if (sx < 0 || sx >= rp.width) continue;
                    if (dx >= GW || dy >= GH) continue;
                    const di = dy * GW + dx;
                    cov[di] = rp.cov[sy * rp.width + sx];
                    mat[di] = rp.mat[sy * rp.width + sx];
                    wrote = true;
                }
            }
            if (wrote) chunkCovered[cy * mapWidth + cx] = 1;
        }
    }
    return { GW, GH, cov, mat, chunkCovered };
}

export { ENGINE_BY_COLOR };
