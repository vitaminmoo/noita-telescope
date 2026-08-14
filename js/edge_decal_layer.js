// The draw side of the edge-decal pass: a cache of world-space RGBA tiles that
// sits directly on top of the engine terrain.
//
// js/edge_decals.js stamps the decals; this module decides which tiles the
// camera needs, asks the overlay worker for the missing ones and blits the ones
// that have arrived. Tiles are keyed by ABSOLUTE world tile coordinate, not by
// parallel world: a PW shifts which world coordinates are on screen, and the
// stamp is a pure function of those, so the same cache serves every PW.
//
// The decals bake into cell colors in game, so they belong immediately above the
// terrain and below the pixel scenes — a scene's own cells get dressed by the
// engine too, but that needs the scene's materials in the field and is not part
// of this pass yet.
import { CHUNK_SIZE, WORLD_CHUNK_CENTER_Y } from './constants.js';
import { getWorldCenter, getWorldSize } from './utils.js';

/** World pixels per cached tile. Small enough that tiles pop in one by one
 *  rather than the whole view arriving at once. */
export const EDGE_DECAL_TILE = 256;
/** Below this zoom a decal is smaller than a screen pixel, and the number of
 *  tiles in view stops being reasonable. */
export const EDGE_DECAL_MIN_ZOOM = 1;
/** Tiles asked for per draw, so panning stays responsive while the queue fills. */
const REQUESTS_PER_DRAW = 4;
/** Roughly a 4K screen's worth at zoom 1, times a couple of pans. */
const MAX_CACHED_TILES = 512;

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

/** Accepts a finished tile from the worker, or discards a stale one. */
export function putEdgeDecalTile(key, tx, ty, bitmap) {
    pending.delete(`${tx},${ty}`);
    if (key !== worldKey) { bitmap.close?.(); return false; }
    if (tiles.size >= MAX_CACHED_TILES) {
        const oldest = tiles.keys().next().value;
        tiles.get(oldest).close?.();
        tiles.delete(oldest);
    }
    tiles.set(`${tx},${ty}`, bitmap);
    return true;
}

/**
 * Blits the decal tiles covering `viewRect` and asks for the missing ones.
 *
 * @param {CanvasRenderingContext2D} ctx  already under the camera transform
 * @param {object} app
 * @param {{left:number,right:number,top:number,bottom:number}} viewRect
 * @param {(tx:number, ty:number)=>void} request
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

    let asked = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const tileKey = `${tx},${ty}`;
            const bitmap = tiles.get(tileKey);
            if (bitmap) {
                ctx.drawImage(bitmap,
                    tx * EDGE_DECAL_TILE + offX, ty * EDGE_DECAL_TILE + offY,
                    EDGE_DECAL_TILE, EDGE_DECAL_TILE);
                continue;
            }
            if (asked >= REQUESTS_PER_DRAW || pending.has(tileKey)) continue;
            pending.add(tileKey);
            asked++;
            request(key, tx, ty);
        }
    }
    return true;
}
