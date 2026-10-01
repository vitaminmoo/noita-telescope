// The draw side of the edge-decal pass: a cache of world-space RGBA tiles that
// sits directly on top of the engine terrain.
//
// js/edge_decals.js stamps the decals; this module decides which tiles the
// camera needs, asks the overlay worker pool for the missing ones and draws the
// ones that have arrived (gl/decal_renderer.js). Tiles are keyed by ABSOLUTE
// world tile coordinate, not by parallel world: a PW shifts which world
// coordinates are on screen, and the stamp is a pure function of those, so the
// same cache serves every PW.
//
// The decals bake into cell colors in game. A tile carries the engine's full
// stamp history — the chunk-generation pass over the terrain, then each pixel
// scene's own paint-time pass over its cells (which also erases the terrain
// stamps under the cells the scene replaced) — so the layer draws ABOVE the
// pixel scenes: every texel left in a tile belongs on top of whatever is under it.
//
// The pass belongs to the terrain view (js/terrain_view.js): it needs nothing
// from the app, only the world being drawn and the GL terrain pass, whose
// material-id output is what the stamp reads.
//
// A tile's pixels travel as raw bytes from the worker to a texture layer. No
// ImageBitmap is made for it, and the copy kept on this thread (for the tiles
// near the view) makes the hover readout an array read instead of a GPU sync.
//
// Imported by the overlay worker too (decodeMaterialIdTile, the tile size), so
// nothing here may touch the pool or the DOM at module load.
import { CHUNK_SIZE, WORLD_CHUNK_CENTER_Y } from './constants.js';
import { EDGE_DECAL_HALO } from './edge_decals.js';
import { frameSlo } from './frame_slo.js';
import { onOverlayPoolReply, postOverlayPoolJob, syncOverlayPoolWorld } from './overlay_worker_pool.js';
import { PIXEL_SCENE_DATA } from './pixel_scene_generation.js';
import { renderTrace } from './render_hud.js';
import { getWorldCenter, getWorldSize, getWorldStride } from './utils.js';

/** World pixels per cached tile. Small enough that tiles pop in one by one
 *  rather than the whole view arriving at once. */
export const EDGE_DECAL_TILE = 256;
/** Below this zoom a decal is smaller than a screen pixel, and the number of
 *  tiles in view stops being reasonable. */
export const EDGE_DECAL_MIN_ZOOM = 1;
/** From this zoom up the view's tiles are generated ahead of being drawn. */
export const EDGE_DECAL_LOOKAHEAD_ZOOM = 0.7;
/** In-flight cap while only looking ahead (the view holds ~2x the tiles). */
const LOOKAHEAD_INFLIGHT = 24;
/** Tiles in flight at once. The material resolve is one GPU batch per draw
 *  and the stamps run in the overlay worker pool, which cannot cancel: the cap
 *  is what keeps a pan from queueing tiles it has already left behind. Misses
 *  past it are asked again on the next draw, centre of the view first. */
const MAX_INFLIGHT = 48;
/** Tiles handed to the GPU material-id pass per draw (see drawEdgeDecals). */
const MAX_REQUEST_PER_DRAW = 12;
/** Tiles requested beyond the view on every side, so a pan never exposes a
 *  missing tile at the edge. */
const PREFETCH_RING = 1;
/** Tiles kept on the GPU: roughly a 4K screen's worth at zoom 1 plus its ring,
 *  times a couple of pans (200 MiB). */
export const EDGE_DECAL_MAX_TILES = 768;
/** Tiles whose pixels are also kept on this thread, for the hover readout: a 4K
 *  screen's worth at zoom 1 (50 MiB). The rest live on the GPU only. */
const MAX_CPU_TILES = 192;

/**
 * Decodes one tile of the GL material-id pass (gl/terrain_renderer.js
 * resolveMaterialTiles: raw RGBA, rows bottom-up, id+1 in R/G) into row-major
 * ids, 0 = air, -1 = unresolved. Pure; the overlay worker runs it so the
 * draw thread never pays for the decode.
 */
export function decodeMaterialIdTile(bytes, w, h) {
    const ids = new Int16Array(w * h);
    for (let y = 0; y < h; y++) {
        let src = (h - 1 - y) * w * 4;
        const dst = y * w;
        for (let x = 0; x < w; x++, src += 4) {
            ids[dst + x] = (bytes[src] | (bytes[src + 1] << 8)) - 1;
        }
    }
    return ids;
}

const cpuTiles = new Map();    // "tx,ty" -> Uint8ClampedArray (straight-alpha RGBA), oldest first
const pending = new Set();
const listeners = new Set();
let worldKey = null;           // seed | ng | gameMode the cache belongs to
let epoch = 0;                 // bumped when the cache is dropped: GPU copies are stale too
let replyRouted = false;

export const edgeDecalWorldKey = (world) => `${world.seed}|${world.ngPlusCount ?? 0}|${world.gameMode}`;

/** Tiles asked for and not yet back — the render harness waits on this. */
export function pendingEdgeDecalTiles() {
    return pending.size;
}

/** Drops every cached tile (seed / NG / game mode change). */
export function invalidateEdgeDecals() {
    cpuTiles.clear();
    pending.clear();
    worldKey = null;
    epoch++;
}

/** Calls `fn(msg)` whenever a tile lands (a redraw would show it). `msg.debug`
 *  carries the worker's timings for the tile. Returns the remover. */
export function onEdgeDecalTile(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Accepts a finished tile from the worker, or discards a stale one. Null
 *  pixels (the worker's data wasn't ready) only clear the pending flag, so the
 *  tile is asked for again on a later draw. */
export function putEdgeDecalTile(key, tx, ty, rgba) {
    pending.delete(`${tx},${ty}`);
    if (!rgba || key !== worldKey) return false;
    cpuTiles.set(`${tx},${ty}`, rgba);
    return true;
}

/**
 * The decal texel covering an absolute world pixel, for the hover tooltip:
 * { tx, ty, r, g, b, a }, or null when the tile's pixels are not held here (the
 * pass is off, zoomed out, the tile has not arrived yet, or it is far from the
 * last view).
 *
 * Tile space IS absolute world space -- the pass only ever runs at pwVertical
 * 0, and its offsets are exactly the hover tooltip's abs-coord conversion --
 * so no PW arithmetic is needed here.
 */
export function edgeDecalAt(worldX, worldY) {
    const tx = Math.floor(worldX / EDGE_DECAL_TILE);
    const ty = Math.floor(worldY / EDGE_DECAL_TILE);
    const rgba = cpuTiles.get(`${tx},${ty}`);
    if (!rgba) return null;
    const i = ((worldY - ty * EDGE_DECAL_TILE) * EDGE_DECAL_TILE + (worldX - tx * EDGE_DECAL_TILE)) * 4;
    return { tx, ty, r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], a: rgba[i + 3] };
}

/**
 * Draws the decal tiles covering the view into the terrain canvas and asks for
 * the missing ones -- those in view and one ring beyond it, nearest the view
 * centre first, up to MAX_INFLIGHT outstanding -- in one batched request.
 *
 * @param terrain  the GLTerrainRenderer (its canvas is drawn into, its
 *                 material-id pass answers the requests)
 * @param decals   the view's GLDecalRenderer
 * @param world    the terrain view's world: seed, ngPlusCount, isNGP, gameMode, scenes
 * @param view     { width, height, camX, camY, camZ, pw, pwVertical } as TerrainView.render
 * @param frame    the frame serial
 * @returns {boolean} true when the pass ran (drew or requested)
 */
export function drawEdgeDecals(terrain, decals, world, view, frame) {
    if ((view.pwVertical ?? 0) !== 0) return false;
    // Below the drawing zoom but close to it, the view's tiles are asked for
    // without being drawn, so zooming in across EDGE_DECAL_MIN_ZOOM finds them
    // (mostly) ready instead of filling in over the following frames.
    const drawing = view.camZ >= EDGE_DECAL_MIN_ZOOM;
    if (!drawing && view.camZ < EDGE_DECAL_LOOKAHEAD_ZOOM) return false;
    if (!terrain.gl || !decals.init(terrain.gl)) return false;
    const key = edgeDecalWorldKey(world);
    if (key !== worldKey) {
        invalidateEdgeDecals();
        worldKey = key;
    }
    if (decals.epoch !== epoch) {
        decals.dropAll();
        decals.epoch = epoch;
    }

    // The terrain shader's own mapping: world = canvas - centerPx + pw*worldWidth
    // (gl/terrain_renderer.js render()), so canvas = world + offX.
    const worldWidth = getWorldSize(world.isNGP, world.gameMode) * CHUNK_SIZE;
    const offX = getWorldCenter(world.isNGP, world.gameMode) * CHUNK_SIZE - (view.pw ?? 0) * worldWidth;
    const offY = WORLD_CHUNK_CENTER_Y * CHUNK_SIZE;
    const halfW = (view.width / 2) / view.camZ, halfH = (view.height / 2) / view.camZ;
    const left = view.camX - halfW, top = view.camY - halfH;

    const tx0 = Math.floor((left - offX) / EDGE_DECAL_TILE);
    const tx1 = Math.floor((left + 2 * halfW - offX) / EDGE_DECAL_TILE);
    const ty0 = Math.floor((top - offY) / EDGE_DECAL_TILE);
    const ty1 = Math.floor((top + 2 * halfH - offY) / EDGE_DECAL_TILE);
    const cx = (view.camX - offX) / EDGE_DECAL_TILE - 0.5;
    const cy = (view.camY - offY) / EDGE_DECAL_TILE - 0.5;

    const missing = [];
    const visible = [];
    const ring = drawing ? PREFETCH_RING : 0;
    let uploads = 0;
    for (let ty = ty0 - ring; ty <= ty1 + ring; ty++) {
        for (let tx = tx0 - ring; tx <= tx1 + ring; tx++) {
            const tileKey = `${tx},${ty}`;
            let have = decals.has(tileKey);
            if (!have) {
                const rgba = cpuTiles.get(tileKey);
                if (rgba && decals.put(tileKey, rgba, frame)) {
                    have = true;
                    uploads++;
                }
            }
            if (have) {
                if (drawing && tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) visible.push({ key: tileKey, tx, ty });
                continue;
            }
            if (pending.has(tileKey)) continue;
            missing.push({ tx, ty, d: (tx - cx) * (tx - cx) + (ty - cy) * (ty - cy) });
        }
    }
    if (uploads) {
        frameSlo.count('decalUploads', uploads);
        // The pixels are on the GPU now; this thread keeps only the newest for the hover.
        for (const k of cpuTiles.keys()) {
            if (cpuTiles.size <= MAX_CPU_TILES) break;
            if (decals.has(k)) cpuTiles.delete(k);
        }
    }
    if (visible.length) {
        decals.draw(terrain, {
            width: view.width, height: view.height, zoom: view.camZ, frame,
            offX: offX - left, offY: offY - top, tiles: visible,
        });
    }
    // A request is one GPU batch (a 320x320 engine resolve per tile) issued
    // this frame; a whole screen's worth at once is several screens of shader
    // work on top of the frame's own, so it goes out in per-draw slices.
    const room = Math.min(MAX_REQUEST_PER_DRAW, (drawing ? MAX_INFLIGHT : LOOKAHEAD_INFLIGHT) - pending.size);
    if (missing.length && room > 0) {
        missing.sort((a, b) => a.d - b.d);
        // Tiles the request declines (scene placement not ready for their
        // world) are not marked pending, so they are asked for again later.
        for (const t of requestEdgeDecalTiles(terrain, world, key, missing.slice(0, room))) pending.add(`${t.tx},${t.ty}`);
    }
    return true;
}

/**
 * Asks for a batch of world-space edge-decal tiles. The per-pixel material ids
 * -- 24 ms a tile on the CPU -- come from the GL terrain renderer's material-id
 * pass (one batched draw + async readback for the whole request); the stamp
 * itself runs in the overlay worker pool, which gets the id grid handed to it.
 *
 * Returns the tiles it accepted; a tile whose world has no scene placement list
 * yet is left out so the layer asks for it again later, and so is everything
 * while the engine resolve is not ready to answer.
 */
function requestEdgeDecalTiles(terrain, world, key, tiles) {
    if (!terrain.engineReady) return [];
    const accepted = [];
    const jobs = [];
    for (const t of tiles) {
        const scenes = edgeDecalTileScenes(world, t.tx, t.ty);
        if (!scenes) continue;
        accepted.push(t);
        jobs.push({ tx: t.tx, ty: t.ty, scenes });
    }
    if (!jobs.length) return accepted;
    if (!replyRouted) {
        replyRouted = true;
        onOverlayPoolReply('EDGE_DECAL_TILE', (msg) => {
            if (putEdgeDecalTile(msg.worldKey, msg.tx, msg.ty, msg.rgba)) for (const fn of listeners) fn(msg);
        });
    }
    syncOverlayPoolWorld(world.biomeData);
    const P = EDGE_DECAL_HALO, size = EDGE_DECAL_TILE + 2 * P;
    const base = {
        cmd: 'GENERATE_EDGE_DECAL_TILE', worldKey: key,
        seed: world.seed, ngPlusCount: world.ngPlusCount ?? 0, gameMode: world.gameMode,
    };
    for (const job of jobs) job.traceId = renderTrace.begin('decal', `tile ${job.tx},${job.ty}`, 'edgeDecals', 'gpu');
    const rects = jobs.map(j => ({ x0: j.tx * EDGE_DECAL_TILE - P, y0: j.ty * EDGE_DECAL_TILE - P, w: size, h: size }));
    // The batch's GPU time, split evenly over its tiles for the HUD.
    const onGpuMs = (ms) => { for (const job of jobs) renderTrace.gpu(job.traceId, ms / jobs.length, jobs.length); };
    terrain.resolveMaterialTiles(rects, onGpuMs).then((grids) => {
        for (const [i, job] of jobs.entries()) {
            const rgba = grids?.[i];
            if (!rgba) {
                // The pass could not answer (context lost mid-flight): free the tile to be asked again.
                renderTrace.end(job.traceId);
                putEdgeDecalTile(key, job.tx, job.ty, null);
                continue;
            }
            renderTrace.stage(job.traceId, 'queued');
            postOverlayPoolJob({ ...base, tx: job.tx, ty: job.ty, scenes: job.scenes, matRGBA: rgba, size, traceId: job.traceId },
                [rgba.buffer]);
        }
    });
    return accepted;
}

/** The pixel scenes overlapping one tile's padded rect, in paint order, or
 *  null when a world the tile touches has no placement list yet. */
function edgeDecalTileScenes(world, tx, ty) {
    // The pixel scenes overlapping the tile's padded rect, in paint order: the
    // engine dresses a scene's cells with its own decal pass at paint time, so
    // the worker needs to know what landed here. Tiles are world-space and
    // scene positions are absolute (scanSpawnFunctions / addStaticPixelScenes
    // already add the parallel-world stride) — but each list only HOLDS its own
    // world's scenes, so the main-world list answers nothing west of x=-17920
    // or east of 17920: handed to every PW, it stamped every parallel world as
    // if it had no scenes at all (terrain stamps left under scene cells, scene
    // borders undressed). Read the list of every world the tile touches instead.
    //
    // Which world a tile belongs to follows the chunk grid (mapWidth chunks per
    // world), the same wrap the terrain uses. In NG+ scenes sit on the 8px-short
    // stride (64*512-8), so a scene from world k can drift into world k+1's
    // chunk frame near a seam; every loaded world's list is scanned for
    // overlaps, so such a scene is still found as long as its world is loaded.
    //
    // No list yet for a world the tile needs (still generating) -> decline, so
    // the layer retries on a later draw instead of caching a tile with the
    // scene stamps missing.
    const scenes = [];
    const P = EDGE_DECAL_HALO;
    const left = tx * EDGE_DECAL_TILE - P, right = left + EDGE_DECAL_TILE + 2 * P;
    const top = ty * EDGE_DECAL_TILE - P, bottom = top + EDGE_DECAL_TILE + 2 * P;
    const centerPx = getWorldCenter(world.isNGP, world.gameMode) * CHUNK_SIZE;
    const worldPx = getWorldStride(world.isNGP, world.gameMode); // scenes sit on the PW stride
    const pwOf = (x) => Math.floor((x + centerPx) / worldPx);
    const byPW = world.scenes;
    if (!byPW) return null;
    for (let k = pwOf(left); k <= pwOf(right - 1); k++) {
        if (!byPW[`${k},0`]) return null;
    }
    for (const pwKey in byPW) {
        if (!pwKey.endsWith(',0') || !byPW[pwKey]) continue;   // the pass never runs in vertical worlds
        for (const scene of byPW[pwKey]) {
            const data = PIXEL_SCENE_DATA[scene.key];
            if (!data) continue;
            if (scene.x + data.width <= left || scene.x >= right ||
                scene.y + data.height <= top || scene.y >= bottom) continue;
            scenes.push({ key: scene.key, variantKey: scene.variantKey, x: scene.x, y: scene.y });
        }
    }
    return scenes;
}
