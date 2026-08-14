// Noita's EdgeGraphics decal pass, as a CPU overlay.
//
// When the engine paints a chunk it walks every fresh cell and, for the material's
// <EdgeGraphics> entry, may stamp a little sprite from data/materials_gfx/edge_files
// across the cell — the mottled band you see along every rock/air border. The
// stamp is baked straight into the cells' colors, which is why the game's
// material grid never shows it and telescope's terrain, which is drawn from
// material identity, was missing it entirely.
//
//   BiomeGen_StampEdgeDecalAtCell    @0x00721870  (generation time)
//   BiomeMaterials_PaintEdgeMaterial @0x00721da0  (runtime repaint twin)
//   BiomeMaterials_PaintSpritePattern             (the blitter)
// See reverse/noita docs/worldgen/cell_color_dressing.md.
//
// PLACEMENT IS NOT REPRODUCIBLE, AND CANNOT BE. Both engine stampers roll a
// single free-running stream — a thread-local Lehmer LCG at generation, the
// shared g_damageRng at runtime — so which cells get dressed depends on chunk
// generation order, thread scheduling and how many rolls other systems consumed
// before. Two loads of the same seed differ. What IS reproducible is the
// distribution, so this pass rolls a POSITION-SEEDED stream instead: a 32-bit
// integer hash of (world x, world y, world seed, entry, stream index). Same seed
// and same rect always give the same decals, and the density, band depth and
// palette match the game in aggregate — the best fidelity available in principle.
//
// The other deliberate deviation is stamp ORDER. Every shipped entry sets
// overwrite="0", so an already-dressed cell is not dressed again: a run of edge
// cells does not each lay a full sprite over the last, stamps come out sparse,
// and the band keeps the sprite's own alpha profile instead of filling solid.
// This pass reproduces that with a row-major scan and two masks — the footprint
// of every stamp marks its cells dressed (so no cell under it originates another
// stamp) and the texels it actually wrote mark them painted (so a later stamp
// cannot repaint them). Region boundaries therefore need a halo
// (EDGE_DECAL_HALO) so the masks are warmed up before the visible part starts.
//
// Calibrated against the game's BAKEDUMP/MAPDUMP pair for the Holy Mountain rect
// (-512,11776) 512x512 at seed 786433191: per-material palettes come out exact,
// rock_hard's band profile matches within a couple of points at every depth, and
// templebrick — the one material that stamps at percent="1" — comes out about a
// fifth too dense deep inside thick walls. See
// scripts/ref_resolver/decal_metrics.mjs.
import {
    EDGE_ATLAS_HEIGHT, EDGE_ATLAS_WIDTH, EDGE_ENTRIES_BY_MATERIAL, EDGE_IMAGES,
    MATERIAL_TYPE_BY_NAME,
} from './engine_resolve/edge_data.js';
import { MATERIAL_NAMES_BY_ID } from './engine_resolve/engine_data.js';

export const EDGE_TYPE_COLOR_EDGE_PIXELS = 0;
export const EDGE_TYPE_EVERYWHERE = 1;
export const EDGE_TYPE_CARDINAL_DIRECTIONS = 2;
export const EDGE_TYPE_NORMAL_BASED = 3;

const IMG_FLAG_RANDOM_ROTATION = 1;

/** Widest half-extent any sprite reaches, times three: enough padding for the
 *  painted mask to lose its memory of where the scan started. */
export const EDGE_DECAL_HALO = 64;

// ---------------------------------------------------------------------------
// material id -> entries / type class, resolved once from the generated tables
// ---------------------------------------------------------------------------
const ENTRIES_BY_ID = MATERIAL_NAMES_BY_ID.map(
    name => (name && EDGE_ENTRIES_BY_MATERIAL[name]) || null);
const TYPE_BY_ID = Int8Array.from(MATERIAL_NAMES_BY_ID.map(
    name => (name && MATERIAL_TYPE_BY_NAME[name]) ?? 0));

/** True when any material in the world can produce decals (sanity check). */
export function hasEdgeGraphics() {
    return ENTRIES_BY_ID.some(Boolean);
}

// ---------------------------------------------------------------------------
// the sprite atlas (data/edge_atlas.bin, raw RGBA rows)
// ---------------------------------------------------------------------------
let _atlas = null;
let _loadPromise = null;

/** Installs already-fetched atlas bytes (node / worker callers). */
export function setEdgeDecalAtlas(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length !== EDGE_ATLAS_WIDTH * EDGE_ATLAS_HEIGHT * 4) {
        throw new Error(`edge atlas size mismatch: ${data.length} bytes for ` +
            `${EDGE_ATLAS_WIDTH}x${EDGE_ATLAS_HEIGHT}`);
    }
    _atlas = data;
    return _atlas;
}

/** Kicks off (or returns) the one-time fetch of the sprite atlas. */
export function initEdgeDecalAtlas() {
    return _loadPromise ??= (async () => {
        const resp = await fetch('../data/edge_atlas.bin');
        if (!resp.ok) throw new Error('edge atlas fetch failed');
        return setEdgeDecalAtlas(new Uint8Array(await resp.arrayBuffer()));
    })();
}

export function edgeDecalAtlasReady() {
    return _atlas !== null;
}

// ---------------------------------------------------------------------------
// position-seeded stream
// ---------------------------------------------------------------------------
// A 32-bit integer hash (the murmur3 finalizer over a mixed key). Nothing in the
// engine looks like this — the engine's stream is sequential — so it is chosen
// for decorrelation across all five inputs, not for fidelity.
function hash32(x, y, seed, entry, stream) {
    let h = (x * 0x27d4eb2d) ^ (y * 0x165667b1) ^ (seed * 0x9e3779b1) ^
        (entry * 0x85ebca6b) ^ (stream * 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

const rand01 = (h) => h / 4294967296;

// ---------------------------------------------------------------------------
// stamping
// ---------------------------------------------------------------------------

/** Degrees in [0, 360) for a normal pointing (nx, ny) in SCREEN space (y down). */
function normalAngle(nx, ny) {
    const deg = Math.atan2(-ny, nx) * (180 / Math.PI);
    return deg < 0 ? deg + 360 : deg;
}

/**
 * First image whose [min_angle, max_angle) contains `angle`, scanning from a
 * random start so overlapping ranges are broken up the way the engine does.
 * Returns -1 when the list covers no matching angle.
 */
function pickAngleImage(images, angle, start) {
    for (let k = 0; k < images.length; k++) {
        const img = EDGE_IMAGES[images[(start + k) % images.length]];
        if (angle >= img[4] && angle < img[5]) return images[(start + k) % images.length];
    }
    return -1;
}

/**
 * Stamps the decals a world rect's terrain would carry.
 *
 * @param {Int16Array} mat  material ids, row-major over the WHOLE padded rect
 *                          (0 = air, -1 = unresolved; see material_field.js)
 * @param {number} width    padded rect width
 * @param {number} height   padded rect height
 * @param {number} originX  world x of column 0
 * @param {number} originY  world y of row 0
 * @param {number} worldSeed
 * @returns {Uint8ClampedArray} RGBA over the padded rect; composite it over the
 *          terrain with plain source-over. Crop the halo off before drawing.
 */
export function stampEdgeDecals(mat, width, height, originX, originY, worldSeed) {
    const out = new Uint8ClampedArray(width * height * 4);
    if (!_atlas) return out;
    // `painted` is where a sprite texel actually landed; `dressed` is the whole
    // footprint of every stamp, which is what the engine's overwrite="0" gate
    // reads (PaintSpritePattern marks each covered cell by nudging the low byte
    // of its second color slot, transparent texels included). Without the
    // distinction, neighbouring edge cells stamp through each other's holes and
    // the band fills solid instead of keeping the sprite's alpha profile.
    const painted = new Uint8Array(width * height);
    const dressed = new Uint8Array(width * height);
    const atlas = _atlas;

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const id = mat[i];
            if (id <= 0) continue;
            const entries = ENTRIES_BY_ID[id];
            if (!entries) continue;
            // overwrite="0": an already-dressed cell does not stamp again.
            if (dressed[i]) continue;

            const typeId = TYPE_BY_ID[id];
            for (let e = 0; e < entries.length; e++) {
                const [type, percent, , reqSameMat, reqSameType, colorARGB, images] = entries[e];
                if (rand01(hash32(x + originX, y + originY, worldSeed, e, 0)) >= percent) continue;

                // The edge gate: 4-neighbourhood count of same material (or same
                // material type) must be 2 or 3 — an interior cell has 4, a lone
                // cell 0 or 1.
                let n = 0, nx = 0, ny = 0;
                if (reqSameMat || reqSameType) {
                    const same = reqSameMat
                        ? (j) => mat[j] === id
                        : (j) => mat[j] > 0 && TYPE_BY_ID[mat[j]] === typeId;
                    if (same(i - width)) n++; else ny -= 1;
                    if (same(i + width)) n++; else ny += 1;
                    if (same(i - 1)) n++; else nx -= 1;
                    if (same(i + 1)) n++; else nx += 1;
                    if (n < 2 || n > 3) continue;
                }

                let image;
                if (type === EDGE_TYPE_EVERYWHERE) {
                    const r = rand01(hash32(x + originX, y + originY, worldSeed, e, 1));
                    image = images[Math.min(images.length - 1, (r * images.length) | 0)];
                } else if (type === EDGE_TYPE_CARDINAL_DIRECTIONS || type === EDGE_TYPE_NORMAL_BASED) {
                    if (nx === 0 && ny === 0) continue;
                    const angle = normalAngle(nx, ny);
                    const start = hash32(x + originX, y + originY, worldSeed, e, 2) % images.length;
                    image = pickAngleImage(images, angle, start);
                    if (image < 0) continue;
                } else if (type === EDGE_TYPE_COLOR_EDGE_PIXELS) {
                    const a = (colorARGB >>> 24) & 0xff;
                    if (!a) continue;
                    const o = i * 4;
                    out[o] = (colorARGB >>> 16) & 0xff;
                    out[o + 1] = (colorARGB >>> 8) & 0xff;
                    out[o + 2] = colorARGB & 0xff;
                    out[o + 3] = a;
                    painted[i] = 1;
                    dressed[i] = 1;
                    continue;
                } else {
                    continue;
                }

                const [ax, ay, iw, ih, , , flags] = EDGE_IMAGES[image];
                const rot = (flags & IMG_FLAG_RANDOM_ROTATION)
                    ? hash32(x + originX, y + originY, worldSeed, e, 3) & 3 : 0;
                stampSprite(out, painted, dressed, mat, width, height, x, y, id,
                    atlas, ax, ay, iw, ih, rot);
            }
        }
    }
    return out;
}

/**
 * Blits one sprite centred on cell (cx, cy), rotated by `rot` quarter turns.
 * Only cells of the SOURCE material are touched — a rock sprite never bleeds
 * into the air or into the brick next to it. Every one of them is marked
 * dressed, transparent texels included, so the next edge cell along the border
 * does not stamp a second sprite through this one's holes; a pixel already
 * painted keeps the earlier sprite's texel (overwrite="0").
 */
function stampSprite(out, painted, dressed, mat, width, height, cx, cy, id,
    atlas, ax, ay, iw, ih, rot) {
    const swap = (rot & 1) === 1;
    const dw = swap ? ih : iw;
    const dh = swap ? iw : ih;
    const x0 = cx - (dw >> 1);
    const y0 = cy - (dh >> 1);
    for (let dy = 0; dy < dh; dy++) {
        const py = y0 + dy;
        if (py < 0 || py >= height) continue;
        for (let dx = 0; dx < dw; dx++) {
            const px = x0 + dx;
            if (px < 0 || px >= width) continue;
            const di = py * width + px;
            if (mat[di] !== id) continue;
            dressed[di] = 1;
            if (painted[di]) continue;
            let sx, sy;
            switch (rot) {
                case 1: sx = dy; sy = ih - 1 - dx; break;
                case 2: sx = iw - 1 - dx; sy = ih - 1 - dy; break;
                case 3: sx = iw - 1 - dy; sy = dx; break;
                default: sx = dx; sy = dy; break;
            }
            const so = ((ay + sy) * EDGE_ATLAS_WIDTH + ax + sx) * 4;
            const a = atlas[so + 3];
            if (!a) continue;
            const o = di * 4;
            out[o] = atlas[so];
            out[o + 1] = atlas[so + 1];
            out[o + 2] = atlas[so + 2];
            out[o + 3] = a;
            painted[di] = 1;
        }
    }
}
