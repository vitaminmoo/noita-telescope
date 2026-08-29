// The draw side of the edge-decal pass: a cache of world-space RGBA tiles that
// sits directly on top of the engine terrain.
//
// js/edge_decals.js stamps the decals; this module decides which tiles the
// camera needs, asks the overlay worker for the missing ones and blits the ones
// that have arrived. Tiles are keyed by ABSOLUTE world tile coordinate, not by
// parallel world: a PW shifts which world coordinates are on screen, and the
// stamp is a pure function of those, so the same cache serves every PW.
//
// The decals bake into cell colors in game. A tile carries the engine's full
// stamp history — the chunk-generation pass over the terrain, then each pixel
// scene's own paint-time pass over its cells (which also erases the terrain
// stamps under the cells the scene replaced) — so the layer draws ABOVE the
// pixel scenes: every texel left in a tile belongs on top of whatever is under it.
import { CHUNK_SIZE, WORLD_CHUNK_CENTER_Y } from './constants.js';
import { getWorldCenter, getWorldSize } from './utils.js';

/** World pixels per cached tile. Small enough that tiles pop in one by one
 *  rather than the whole view arriving at once. */
export const EDGE_DECAL_TILE = 256;
/** Below this zoom a decal is smaller than a screen pixel, and the number of
 *  tiles in view stops being reasonable. */
export const EDGE_DECAL_MIN_ZOOM = 1;
/** Tiles in flight at once. The material resolve is one GPU batch per draw
 *  and the stamp runs in the overlay worker, which is FIFO and cannot cancel:
 *  the cap is what keeps a pan from queueing tiles it has already left behind.
 *  Misses past it are asked again on the next draw, centre of the view first. */
const MAX_INFLIGHT = 48;
/** Tiles requested beyond the view on every side, so a pan never exposes a
 *  missing tile at the edge. */
const PREFETCH_RING = 1;
/** Roughly a 4K screen's worth at zoom 1 plus its ring, times a couple of pans. */
const MAX_CACHED_TILES = 768;

const tiles = new Map();       // "tx,ty" -> ImageBitmap
const pending = new Set();
let worldKey = null;           // seed | ng | gameMode the cache belongs to

export const edgeDecalWorldKey = (app) => `${app.seed}|${app.ngPlusCount}|${app.gameMode}`;

/** Tiles asked for and not yet back — the render harness waits on this. */
export function pendingEdgeDecalTiles() {
    return pending.size;
}

/** Drops every cached tile (seed / NG / game mode change). */
export function invalidateEdgeDecals() {
    for (const bitmap of tiles.values()) bitmap.close?.();
    tiles.clear();
    pending.clear();
    worldKey = null;
}

/** Accepts a finished tile from the worker, or discards a stale one. A null
 *  bitmap (worker data wasn't ready) only clears the pending flag, so the
 *  tile is asked for again on a later draw. */
export function putEdgeDecalTile(key, tx, ty, bitmap) {
    pending.delete(`${tx},${ty}`);
    if (!bitmap || key !== worldKey) { bitmap?.close?.(); return false; }
    if (tiles.size >= MAX_CACHED_TILES) {
        const oldest = tiles.keys().next().value;
        tiles.get(oldest).close?.();
        tiles.delete(oldest);
    }
    tiles.set(`${tx},${ty}`, bitmap);
    return true;
}

// 1x1 scratch for edgeDecalAt(). willReadFrequently keeps it CPU-backed, so the
// per-hover getImageData is a plain array read rather than a GPU sync.
let probeCtx = null;

/**
 * The decal texel covering an absolute world pixel, for the hover tooltip:
 * { tx, ty, r, g, b, a }, or null when no tile is cached there (the pass is off,
 * zoomed out, or the tile has not arrived yet). One 1x1 drawImage + getImageData,
 * off the draw path entirely.
 *
 * Tile space IS absolute world space -- drawEdgeDecals() only ever runs at
 * pwVertical 0, and its offX/offY are exactly the hover tooltip's abs-coord
 * conversion -- so no PW arithmetic is needed here.
 */
export function edgeDecalAt(worldX, worldY) {
    const tx = Math.floor(worldX / EDGE_DECAL_TILE);
    const ty = Math.floor(worldY / EDGE_DECAL_TILE);
    const bitmap = tiles.get(`${tx},${ty}`);
    if (!bitmap) return null;
    if (!probeCtx) {
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 1;
        probeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.drawImage(bitmap,
        worldX - tx * EDGE_DECAL_TILE, worldY - ty * EDGE_DECAL_TILE, 1, 1, 0, 0, 1, 1);
    const [r, g, b, a] = probeCtx.getImageData(0, 0, 1, 1).data;
    return { tx, ty, r, g, b, a };
}

/**
 * Blits the decal tiles covering `viewRect` and asks for the missing ones --
 * those in view and one ring beyond it, nearest the view centre first, up to
 * MAX_INFLIGHT outstanding -- in one batched request.
 *
 * @param {CanvasRenderingContext2D} ctx  already under the camera transform
 * @param {object} app
 * @param {{left:number,right:number,top:number,bottom:number}} viewRect
 * @param {(key:string, tiles:Array<{tx:number,ty:number}>)=>Array<{tx:number,ty:number}>} request
 *        returns the subset it accepted (the rest are asked again later)
 * @returns {boolean} true when anything was drawn or requested
 */
export function drawEdgeDecals(ctx, app, viewRect, request) {
    if (app.cam.z < EDGE_DECAL_MIN_ZOOM || app.pwVertical !== 0) return false;
    const key = edgeDecalWorldKey(app);
    if (key !== worldKey) {
        invalidateEdgeDecals();
        worldKey = key;
    }

    // The terrain shader's own mapping: world = canvas - centerPx + pw*worldWidth
    // (gl/terrain_renderer.js render()), so canvas = world + offX.
    const worldWidth = getWorldSize(app.isNGP, app.gameMode) * CHUNK_SIZE;
    const offX = getWorldCenter(app.isNGP, app.gameMode) * CHUNK_SIZE - app.pw * worldWidth;
    const offY = WORLD_CHUNK_CENTER_Y * CHUNK_SIZE;

    const tx0 = Math.floor((viewRect.left - offX) / EDGE_DECAL_TILE);
    const tx1 = Math.floor((viewRect.right - offX) / EDGE_DECAL_TILE);
    const ty0 = Math.floor((viewRect.top - offY) / EDGE_DECAL_TILE);
    const ty1 = Math.floor((viewRect.bottom - offY) / EDGE_DECAL_TILE);
    const cx = ((viewRect.left + viewRect.right) / 2 - offX) / EDGE_DECAL_TILE - 0.5;
    const cy = ((viewRect.top + viewRect.bottom) / 2 - offY) / EDGE_DECAL_TILE - 0.5;

    const missing = [];
    for (let ty = ty0 - PREFETCH_RING; ty <= ty1 + PREFETCH_RING; ty++) {
        for (let tx = tx0 - PREFETCH_RING; tx <= tx1 + PREFETCH_RING; tx++) {
            const tileKey = `${tx},${ty}`;
            const bitmap = tiles.get(tileKey);
            if (bitmap) {
                if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) {
                    ctx.drawImage(bitmap,
                        tx * EDGE_DECAL_TILE + offX, ty * EDGE_DECAL_TILE + offY,
                        EDGE_DECAL_TILE, EDGE_DECAL_TILE);
                }
                continue;
            }
            if (pending.has(tileKey)) continue;
            missing.push({ tx, ty, d: (tx - cx) * (tx - cx) + (ty - cy) * (ty - cy) });
        }
    }
    const room = MAX_INFLIGHT - pending.size;
    if (missing.length && room > 0) {
        missing.sort((a, b) => a.d - b.d);
        // Tiles the request declines (scene placement not ready for their
        // world) are not marked pending, so they are asked for again later.
        for (const t of request(key, missing.slice(0, room))) pending.add(`${t.tx},${t.ty}`);
    }
    return true;
}
