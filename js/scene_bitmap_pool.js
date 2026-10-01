// Scene bitmap worker pool.
//
// Pixel-scene bitmaps (pixel_scene_generation.js "Bitmaps are BUILT IN THE
// OVERLAY WORKER") are built by a pool of scene-only instances of the overlay
// worker, each decoding the scenes it is asked for on its own. On the shared
// FIFO overlay worker they queued behind overlay builds and the recolor job
// (seconds at load) and filled the view in one at a time. A scene build needs
// only the scene metadata and the settings, so the pool workers never get the
// biome data or tile layers.
//
// This module knows nothing about the app: telescope's page (overlay_manager.js)
// and any other host of js/terrain_view.js share it. The scene bitmap cache it
// feeds is module state of pixel_scene_generation.js, so there is one pool per
// realm; starting it twice returns the same workers.
import { PIXEL_SCENE_DATA, putPixelSceneBitmaps, setPixelSceneBitmapRequester } from './pixel_scene_generation.js';
import { renderTrace } from './render_hud.js';

/** Telescope's default: leave two cores for the page and the overlay worker. */
export function defaultSceneWorkerCount() {
	return Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4) - 2));
}

let sceneWorkers = null;
const listeners = new Set();

/**
 * Starts the pool (once) and routes pixel_scene_generation's bitmap requests to
 * it, least-loaded worker first.
 * @param {object} [opts]
 * @param {number} [opts.count]  worker count; only the first call's is used
 * @returns {Worker[]} the pool
 */
export function startSceneBitmapPool({ count = defaultSceneWorkerCount() } = {}) {
	if (sceneWorkers) return sceneWorkers;
	sceneWorkers = Array.from({ length: Math.max(1, count) }, (_, i) => {
		const w = new Worker(new URL('./overlay_worker.js', import.meta.url), { type: 'module', name: `scene-${i}` });
		w.addEventListener('error', (e) =>
			console.error(`scene worker ${i} failed:`, e.message ?? '(no message)', e.filename ?? '', e.lineno ?? ''));
		w.inflight = 0;
		// Held until the worker says its module has loaded (overlay_worker.js READY).
		w.ready = false;
		w.queue = [];
		w.onmessage = (e) => {
			const msg = e.data;
			if (msg.type === 'READY') {
				w.ready = true;
				for (const m of w.queue) w.postMessage(m);
				w.queue = [];
			}
			else if (msg.type === 'JOB_START') renderTrace.stage(msg.traceId, 'running');
			else if (msg.type === 'JOB_DONE') renderTrace.end(msg.traceId, { workerMs: msg.ms });
			else if (msg.type === 'SCENE_BITMAPS') {
				w.inflight = Math.max(0, w.inflight - 1);
				if (putPixelSceneBitmaps(msg)) for (const fn of listeners) fn(msg);
			}
		};
		return w;
	});
	setPixelSceneBitmapRequester((request) => {
		request.traceId = renderTrace.begin('scene', `${request.key}${request.textured ? ' (tex)' : ''}`, 'pixelScenes');
		let w = sceneWorkers[0];
		for (const s of sceneWorkers) if (s.inflight < w.inflight) w = s;
		w.inflight++;
		post(w, request);
	});
	return sceneWorkers;
}

function post(w, msg) {
	if (w.ready) w.postMessage(msg);
	else w.queue.push(msg);
}

/**
 * Calls `fn(msg)` whenever a bitmap chain lands in the cache, i.e. whenever a
 * redraw would show something new. Returns the function that removes it.
 */
export function onSceneBitmaps(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
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
export function syncSceneBitmapPoolMetadata(pixelSceneCache = sceneMetadataForWorkers()) {
	for (const w of startSceneBitmapPool()) post(w, { cmd: 'SYNC_METADATA', pixelSceneCache });
}

/** Sends the settings object to every pool worker. */
export function syncSceneBitmapPoolSettings(settings) {
	for (const w of startSceneBitmapPool()) post(w, { cmd: 'SYNC_SETTINGS', settings });
}

/** Builds in flight per worker, for the render HUD and the benchmarks. */
export function sceneBitmapPoolStats() {
	return { workers: sceneWorkers ? sceneWorkers.length : 0, inflight: sceneWorkers ? sceneWorkers.map(w => w.inflight) : [] };
}
