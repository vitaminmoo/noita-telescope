// Overlay worker pool.
//
// Pixel-scene bitmaps (pixel_scene_generation.js "Bitmaps are BUILT IN THE
// OVERLAY WORKER") and edge-decal tiles (edge_decal_layer.js) are built by a
// pool of instances of the overlay worker, each decoding the scenes it is
// asked for on its own. On the page's single FIFO overlay worker they queued
// behind overlay builds and the recolor job (seconds at load) and filled the
// view in one at a time. Neither job needs the tile layers -- a scene build
// needs only the scene metadata and the settings, a decal stamp the biome map
// on top -- so the pool workers are never sent them.
//
// This module knows nothing about the app: telescope's page (overlay_manager.js)
// and any other host of js/terrain_view.js share it. The caches it feeds are
// module state (pixel_scene_generation.js, edge_decal_layer.js), so there is
// one pool per realm; starting it twice returns the same workers.
import { frameSlo } from './frame_slo.js';
import { PIXEL_SCENE_DATA, putPixelSceneBitmaps, setPixelSceneBitmapRequester } from './pixel_scene_generation.js';
import { renderTrace } from './render_hud.js';

/** Telescope's default: leave two cores for the page and the overlay worker. */
export function defaultOverlayWorkerCount() {
	return Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4) - 2));
}

let workers = null;
const sceneListeners = new Set();
const replyHandlers = new Map();   // message type -> fn(msg)
let syncedBiomeData = null;

function post(w, msg, transfer) {
	if (w.ready) w.postMessage(msg, transfer ?? []);
	else w.queue.push([msg, transfer ?? []]);
}

/**
 * Starts the pool (once) and routes pixel_scene_generation's bitmap requests to
 * it, least-loaded worker first.
 * @param {object} [opts]
 * @param {number} [opts.count]  worker count; only the first call's is used
 * @returns {Worker[]} the pool
 */
export function startOverlayWorkerPool({ count = defaultOverlayWorkerCount() } = {}) {
	if (workers) return workers;
	workers = Array.from({ length: Math.max(1, count) }, (_, i) => {
		const w = new Worker(new URL('./overlay_worker.js', import.meta.url), { type: 'module', name: `overlay-pool-${i}` });
		w.addEventListener('error', (e) =>
			console.error(`overlay pool worker ${i} failed:`, e.message ?? '(no message)', e.filename ?? '', e.lineno ?? ''));
		w.inflight = 0;
		// Held until the worker says its module has loaded (overlay_worker.js READY).
		w.ready = false;
		w.queue = [];
		w.onmessage = (e) => {
			const msg = e.data;
			if (msg.type === 'READY') {
				w.ready = true;
				for (const [m, transfer] of w.queue) w.postMessage(m, transfer);
				w.queue = [];
			}
			else if (msg.type === 'JOB_START') renderTrace.stage(msg.traceId, 'running');
			else if (msg.type === 'JOB_DONE') renderTrace.end(msg.traceId, { workerMs: msg.ms });
			else if (msg.type === 'SCENE_BITMAPS') {
				w.inflight = Math.max(0, w.inflight - 1);
				const t0 = performance.now();
				if (putPixelSceneBitmaps(msg)) for (const fn of sceneListeners) fn(msg);
				frameSlo.work('sceneBitmapsLanded', performance.now() - t0);
			}
			else if (replyHandlers.has(msg.type)) {
				w.inflight = Math.max(0, w.inflight - 1);
				replyHandlers.get(msg.type)(msg);
			}
		};
		return w;
	});
	setPixelSceneBitmapRequester((request) => {
		request.traceId = renderTrace.begin('scene', `${request.key}${request.textured ? ' (tex)' : ''}`, 'pixelScenes');
		postOverlayPoolJob(request);
	});
	return workers;
}

/** Posts one job to the least-loaded worker. Its reply (a message type that
 *  has a handler, see onOverlayPoolReply) frees the slot. */
export function postOverlayPoolJob(msg, transfer) {
	const pool = startOverlayWorkerPool();
	let w = pool[0];
	for (const s of pool) if (s.inflight < w.inflight) w = s;
	w.inflight++;
	post(w, msg, transfer);
}

/** Routes the pool's replies of one message type (other than scene bitmaps) to `fn`. */
export function onOverlayPoolReply(type, fn) {
	replyHandlers.set(type, fn);
}

/**
 * Calls `fn(msg)` whenever a scene bitmap chain lands in the cache, i.e.
 * whenever a redraw would show something new. Returns the function that
 * removes it.
 */
export function onSceneBitmaps(fn) {
	sceneListeners.add(fn);
	return () => sceneListeners.delete(fn);
}

/** PIXEL_SCENE_DATA as the workers want it: metadata only. The worker decodes
 *  each scene's pixels and art itself the first time it needs them
 *  (ensureScenePixels), so never clone any the main thread holds. */
export function sceneMetadataForWorkers() {
	return Object.fromEntries(Object.entries(PIXEL_SCENE_DATA)
		.map(([k, v]) => [k, (v.imgElement || v.visualArt) ? { ...v, imgElement: null, visualArt: null } : v]));
}

/** Sends the scene metadata to every pool worker (after loadPixelSceneData, and
 *  again whenever the main thread's scene table changes). */
export function syncOverlayPoolMetadata(pixelSceneCache = sceneMetadataForWorkers()) {
	for (const w of startOverlayWorkerPool()) post(w, { cmd: 'SYNC_METADATA', pixelSceneCache });
}

/** Sends the world's biome map to every pool worker, once per world: the decal
 *  stamp gates its seam band on it. A few kilobytes, unlike the tile layers. */
export function syncOverlayPoolWorld(biomeData) {
	if (biomeData === syncedBiomeData) return;
	syncedBiomeData = biomeData;
	for (const w of startOverlayWorkerPool()) post(w, { cmd: 'SYNC_METADATA', biomeData });
}

/** Sends the settings object to every pool worker. */
export function syncOverlayPoolSettings(settings) {
	for (const w of startOverlayWorkerPool()) post(w, { cmd: 'SYNC_SETTINGS', settings });
}

/** Jobs in flight per worker, for the frame log and the benchmarks. */
export function overlayPoolStats() {
	return { workers: workers ? workers.length : 0, inflight: workers ? workers.map(w => w.inflight) : [] };
}
