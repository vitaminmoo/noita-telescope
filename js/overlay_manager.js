// world_manager.js
import { app } from './app.js';
import { loadTimeline } from './load_timeline.js';
import { onEdgeDecalTile } from './edge_decal_layer.js';
import {
	onSceneBitmaps, sceneMetadataForWorkers, startOverlayWorkerPool, syncOverlayPoolMetadata, syncOverlayPoolSettings,
} from './overlay_worker_pool.js';
import { PIXEL_SCENE_DATA, putPixelSceneBitmaps } from './pixel_scene_generation.js';
import { appSettings, updateSettingsFromUI } from './settings.js';
import { renderTrace } from './render_hud.js';

export const overlayWorker = new Worker(new URL('./overlay_worker.js', import.meta.url), { type: 'module', name: 'overlay' });
// A worker whose script fails to load/parse (stale cache, syntax error) dies
// without ever answering, and everything it serves — overlays, pixel scenes,
// edge decals — silently stops. Make that failure loud.
overlayWorker.addEventListener('error', (e) =>
	console.error('overlay worker failed:', e.message ?? '(no message)', e.filename ?? '', e.lineno ?? ''));
overlayWorker.addEventListener('messageerror', () =>
	console.error('overlay worker: message deserialization failed'));

// Keep track of pending generation requests so we don't spam the worker
const pendingOverlayRequests = new Set();

// Overlay builds take the worker 0.5-1.2 s each and it is FIFO: posted as asked,
// a scroll across worlds queued one per world passed, and the ones on screen
// waited behind them all (20+ s, with scene bitmaps and decals stuck behind as
// well). Hold them here instead, a couple in flight at a time, and drop any
// whose world has left the view by the time a slot frees -- it is asked for
// again (loadWorld) if the world comes back.
const MAX_INFLIGHT_OVERLAYS = 2;
let overlayQueue = [];   // { sourceKey, pw, pwVertical, shared }
let overlaysInFlight = 0;

function overlayStillWanted(job) {
	const inView = app.worldsInView;
	if (!inView) return true;
	// A shared (NG) overlay serves its whole row.
	if (job.shared) {
		for (const k of inView) if (k.endsWith(`,${job.pwVertical}`)) return true;
		return false;
	}
	return inView.has(job.sourceKey);
}

function pumpOverlayQueue() {
	while (overlaysInFlight < MAX_INFLIGHT_OVERLAYS && overlayQueue.length) {
		const job = overlayQueue.shift();
		if (!overlayStillWanted(job)) {
			pendingOverlayRequests.delete(job.sourceKey);
			continue;
		}
		overlaysInFlight++;
		overlayWorker.postMessage({
			cmd: 'GENERATE_OVERLAY',
			seed: app.seed,
			ngPlusCount: app.ngPlusCount,
			pw: job.pw,
			pwVertical: job.pwVertical,
			gameMode: app.gameMode,
			traceId: renderTrace.begin('overlay', `PW ${job.sourceKey}`, 'tileOverlays'),
		});
	}
}

function overlayJobFinished() {
	overlaysInFlight = Math.max(0, overlaysInFlight - 1);
	pumpOverlayQueue();
}

export function overlayQueueStats() {
	return { queued: overlayQueue.length, inFlight: overlaysInFlight };
}

overlayWorker.onmessage = async (e) => {
	const msg = e.data;
	loadTimeline.add(msg.spans);

	if (msg.type === 'JOB_START') {
		renderTrace.stage(msg.traceId, 'running');
	}
	else if (msg.type === 'JOB_DONE') {
		renderTrace.end(msg.traceId, { workerMs: msg.ms });
	}
	else if (msg.type === 'STATUS') {
		app.setLoading(true, msg.msg);
	}
	else if (msg.type === 'PIXEL_SCENES_GENERATED') {
		const pixelSceneKeys = msg.pixelSceneKeys;
		const variantKeys = msg.variantKeys;
		const pixelSceneImages = msg.pixelSceneImages;
		for (let i = 0; i < pixelSceneKeys.length; i++) {
			const key = pixelSceneKeys[i];
			const variantKey = variantKeys[i];
			const imgElement = pixelSceneImages[i];
			if (!PIXEL_SCENE_DATA[key].variants) {
				PIXEL_SCENE_DATA[key].variants = {};
			}
			PIXEL_SCENE_DATA[key].variants[variantKey] = imgElement;
		}
		app.draw();
	}
	else if (msg.type === 'SCENE_BITMAPS') {
		if (putPixelSceneBitmaps(msg)) app.draw();
	}
	else if (msg.type === 'OVERLAY_GENERATED') {
		const pwKey = `${msg.pw},${msg.pwVertical}`;
		if (app.seed !== msg.seed || app.ngPlusCount !== msg.ngPlusCount || app.gameMode !== msg.gameMode || appSettings.biomeOverlayMode !== msg.biomeOverlayMode) {
			// Race condition due to user quickly changing seed/ng values while worker is still processing - just ignore the result since it's outdated
			console.warn(`Outdated overlay generation discarded for PW ${msg.pw},${msg.pwVertical}`);
			pendingOverlayRequests.delete(pwKey);
			app.tileOverlaysByPW[pwKey] = null;
			overlayJobFinished();
			// Surprisingly this still didn't fix it
			return;
		}
		// Cache the overlay data sent back from the worker
		app.tileOverlaysByPW[pwKey] = msg.overlays;

		// Just in case, fill the main world overlay to get the NG speedup
		if (!app.isNGP && !app.tileOverlaysByPW[`0,${msg.pwVertical}`]) {
			app.tileOverlaysByPW[`0,${msg.pwVertical}`] = msg.overlays;
		}

		// Clear it from the pending list
		pendingOverlayRequests.delete(pwKey);
		overlayJobFinished();

		// Draw (otherwise we can see blank regions)
		app.draw();
	}
};

export function syncOverlayWorkerData() {
	const pixelSceneCache = sceneMetadataForWorkers();
	overlayWorker.postMessage({
		cmd: 'SYNC_METADATA',
		pixelSceneCache,
		biomeData: app.biomeData,
		tileLayers: app.tileLayers,
		// Do not transfer these buffers: the main renderer continues to use them.
		// Structured cloning gives the worker independent RGB lookup data.
		recolorBuffers: {
			normal: app.recolorOffscreenBuffer,
			heaven: app.recolorOffscreenHeavenBuffer,
			hell: app.recolorOffscreenHellBuffer
		}
	});
	syncOverlayPoolMetadata(pixelSceneCache);
	pendingOverlayRequests.clear();
	overlayQueue = [];
	overlaysInFlight = 0;
}

export function syncSettingsToOverlayWorker() {
	updateSettingsFromUI();
	overlayWorker.postMessage({
		cmd: 'SYNC_SETTINGS',
		settings: appSettings
	});
	syncOverlayPoolSettings(appSettings);
	//console.log(appSettings);
}

export function recolorPixelScenes(pixelSceneList) {
	const pixelSceneKeys = [];
	const variantKeys = [];
	// Only the material-substitution variants: the one main-thread reader is the
	// hover's material lookup (utils.js), which reads the pre-biome variant. The
	// biome recolors (always the key's last part) are the scene workers' job, and
	// doing them here held the worker for seconds after every load.
	const seen = new Set();
	for (const scene of pixelSceneList) {
		const pixelSceneData = PIXEL_SCENE_DATA[scene.key];
		if (!pixelSceneData) continue;
		if (!pixelSceneData.variants) {
			pixelSceneData.variants = {};
		}
		const variantKey = (scene.variantKey || '').replace(/&?biome=[^&]+/, '');
		if (!variantKey) continue;
		const combinedKey = `${scene.key}/${variantKey}`;
		if (!pixelSceneData.variants[variantKey] && !seen.has(combinedKey)) {
			pixelSceneKeys.push(scene.key);
			variantKeys.push(variantKey);
			seen.add(combinedKey);
		}
	}
	if (pixelSceneKeys.length > 0) {
		console.log(`Requesting recolors for ${pixelSceneKeys.length} pixel scenes`);
		const payload = {
			cmd: 'GENERATE_PIXEL_SCENES',
			pixelSceneKeys,
			variantKeys,
			traceId: renderTrace.begin('recolor', `${pixelSceneKeys.length} scene variants`, 'pixelScenes'),
		};
		overlayWorker.postMessage(payload);
	}
}

// Scene bitmaps and edge-decal tiles are built by the overlay worker pool
// (overlay_worker_pool.js), which telescope shares with every other host of
// js/terrain_view.js. Something new to show on each arrival.
startOverlayWorkerPool();
onSceneBitmaps(() => app.draw());
onEdgeDecalTile((msg) => {
	// Kept for harness inspection; bounded so a long session cannot grow it.
	if (msg.debug) {
		const d = (app._decalDebug ??= []);
		d.push({ tx: msg.tx, ty: msg.ty, ...msg.debug });
		if (d.length > 64) d.shift();
	}
	app.draw();
});

export function getOrGenerateOverlay(pw, pwVertical) {
	const pwKey = `${pw},${pwVertical}`;

	// Speedup for NG where we can reuse the same overlay: every world in a row
	// shares its PW-0 overlay. Ask only for that one -- requesting per world
	// while it was still generating gave each world in view its own full copy
	// (a few hundred MB each), kept for the rest of the session.
	const shared = !app.isNGP && app.gameMode !== 'nightmare';
	const sourceKey = shared ? `0,${pwVertical}` : pwKey;
	if (shared && app.tileOverlaysByPW[sourceKey]) {
		app.tileOverlaysByPW[pwKey] = app.tileOverlaysByPW[sourceKey];
		return;
	}

	if (app.tileOverlaysByPW[pwKey]) {
		return; // Overlay is already generated and cached
	}

	if (pendingOverlayRequests.has(sourceKey)) {
		return; // Overlay is already being generated
	}

	pendingOverlayRequests.add(sourceKey);
	overlayQueue.push({ sourceKey, pw: shared ? 0 : pw, pwVertical, shared });
	pumpOverlayQueue();
}

export function isOverlayPending(pw, pwVertical) {
	const pwKey = `${pw},${pwVertical}`;
	return pendingOverlayRequests.has(pwKey);
}

export function invalidatePendingOverlays() {
	// Worker jobs cannot be cancelled, but clearing this set allows replacement
	// requests immediately. Their results are rejected by the overlay-mode check.
	pendingOverlayRequests.clear();
	overlayQueue = [];
	overlaysInFlight = 0;
}