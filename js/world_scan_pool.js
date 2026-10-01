// Parallel-world scanning in a pool of world workers.
//
// The terrain is generated once per seed and shared by every parallel world;
// what differs per world is the spawn scan (pixel-scene placements, PoIs,
// background sprites), and each world's scan is independent of the others.
// world_worker.js runs one scan; this module runs several at once, one worker
// per world, for a host that wants more than the single FIFO worker telescope's
// page uses (world_manager.js).
//
// App-free: a host hands over the world's biome data and prescanned spawns and
// gets placement lists back.
import { PIXEL_SCENE_DATA, PIXEL_SCENE_SPAWN_DATA } from './pixel_scene_generation.js';
import { appSettings } from './settings.js';
import { TRANSLATIONS } from './translations.js';
import { unlockedSpells } from './unlocks.js';

// Pixel scene metadata without the pixels (PERF_PLAN Step 4).
//
// PIXEL_SCENE_DATA carries every scene's full RGBA image in `imgElement` plus its
// recolored `variants` - a few hundred MB once all scenes are loaded. Only the overlay
// worker recolors, so it is the only worker that needs those pixels; the generation
// side (world worker) and the filtering side (search worker) read spawn data plus a
// handful of scalar fields. Structured cloning the cache wholesale copied the images
// into those workers for nothing, so they get this projection instead.
//
// Keep this in sync with the fields worker-side code reads off PIXEL_SCENE_DATA
// (pixel_scene_generation.js loadPixelScene / loadRandomPixelScene).
export function buildPixelSceneMetadata(sceneData = PIXEL_SCENE_DATA) {
	const metadata = {};
	for (const key of Object.keys(sceneData)) {
		const scene = sceneData[key];
		metadata[key] = {
			key: scene.key,
			biome: scene.biome,
			name: scene.name,
			width: scene.width,
			height: scene.height,
			isCosmetic: scene.isCosmetic,
			// Which recolor classes the scene contains (classifyPixelSceneColors).
			// underlyingBiomeSuffix() reads both to decide whether a scene needs an
			// `@<chunk biome>` variant, and a worker that cannot see them answers "no
			// suffix" for every scene it generates. That is how a pseudo-biome scene
			// (general/, temple/, spliced/) came out of the worker as plain
			// `biome=spliced`: its density-class pixels have no color in either table,
			// so sceneBiomePaint fell back to magenta. The main thread generates the
			// current world and the workers generate all the others, so the same scene
			// resolved two ways, and the parallel-world copies -- which the pixel-scene
			// layer draws at the same world position, and which only come into view
			// when zoomed far out -- painted magenta over the correct main-world one.
			hasAir: scene.hasAir,
			hasBiomeFill: scene.hasBiomeFill,
			// Same shape as the main thread cache, minus the pixels: no recolored variant
			// ever exists on these workers.
			variants: {}
		};
	}
	return metadata;
}

/** One world worker per core the page can spare, at most `max`. */
export function defaultWorldWorkerCount(max = 3) {
	return Math.max(1, Math.min(max, (globalThis.navigator?.hardwareConcurrency || 4) - 2));
}

export class WorldScanPool {
	/** @param {object} [opts]  count: worker count (default defaultWorldWorkerCount()) */
	constructor({ count = defaultWorldWorkerCount() } = {}) {
		this.pending = new Map();   // `${seed}|${ng}|${pw},${pwVertical}` -> { resolve, reject, worker, t0 }
		this.workers = Array.from({ length: Math.max(1, count) }, (_, i) => {
			const w = new Worker(new URL('./world_worker.js', import.meta.url), { type: 'module', name: `world-${i}` });
			w.inflight = 0;
			// Held until the worker says its module has loaded (world_worker.js READY).
			w.ready = false;
			w.queue = [];
			w.addEventListener('error', (e) => {
				console.error(`world worker ${i} failed:`, e.message ?? '(no message)', e.filename ?? '', e.lineno ?? '');
				for (const [key, p] of this.pending) {
					if (p.worker !== w) continue;
					this.pending.delete(key);
					p.reject(new Error(`world worker ${i} failed: ${e.message ?? 'no message'}`));
				}
			});
			w.onmessage = (e) => {
				const msg = e.data;
				if (msg.type === 'READY') {
					w.ready = true;
					for (const m of w.queue) w.postMessage(m);
					w.queue = [];
					return;
				}
				if (msg.type !== 'PW_GENERATED' && msg.type !== 'PW_FAILED') return;
				const key = `${msg.seed}|${msg.ngPlusCount}|${msg.pw},${msg.pwVertical}`;
				const p = this.pending.get(key);
				if (!p) return;
				this.pending.delete(key);
				w.inflight = Math.max(0, w.inflight - 1);
				if (msg.type === 'PW_FAILED') {
					p.reject(new Error(`scan of PW ${msg.pw},${msg.pwVertical} failed in the worker: ${msg.error}`));
					return;
				}
				p.resolve({
					pois: msg.pois, pixelScenes: msg.pixelScenes, bgSprites: msg.bgSprites,
					// The worker's own clock for the scan, and the round trip including
					// both structured clones and any wait behind another scan.
					scanMs: msg.ms ?? null, roundTripMs: performance.now() - p.t0,
				});
			};
			return w;
		});
	}

	/**
	 * Gives every worker the seed's shared data. Structured clones, once per
	 * worker: returns the time the posts took on this thread.
	 */
	sync({ biomeData, tileSpawns }) {
		const t0 = performance.now();
		const pixelSceneCache = buildPixelSceneMetadata();
		for (const w of this.workers) {
			this.post(w, { cmd: 'SYNC_SETTINGS', settings: appSettings, unlockedSpellsCache: unlockedSpells });
			this.post(w, {
				cmd: 'SYNC_METADATA',
				pixelSceneCache,
				pixelSceneSpawnDataCache: PIXEL_SCENE_SPAWN_DATA,
				translationsCache: TRANSLATIONS,
				unlockedSpellsCache: unlockedSpells,
				biomeData,
				tileSpawns,
			});
		}
		return performance.now() - t0;
	}

	/** Scans one world on the least-loaded worker. */
	scan({ seed, ngPlusCount, pw, pwVertical, perks = {}, skipCosmeticScenes = appSettings.skipCosmeticScenes, isDaily = false, gameMode = 'normal' }) {
		const key = `${seed}|${ngPlusCount}|${pw},${pwVertical}`;
		const existing = this.pending.get(key);
		if (existing) return existing.promise;
		let worker = this.workers[0];
		for (const w of this.workers) if (w.inflight < worker.inflight) worker = w;
		worker.inflight++;
		const entry = { worker, t0: performance.now() };
		entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
		this.pending.set(key, entry);
		this.post(worker, { cmd: 'GENERATE_PW', seed, ngPlusCount, pw, pwVertical, perks, skipCosmeticScenes, isDaily, gameMode });
		return entry.promise;
	}

	post(w, msg) {
		if (w.ready) w.postMessage(msg);
		else w.queue.push(msg);
	}

	terminate() {
		for (const w of this.workers) w.terminate();
		for (const p of this.pending.values()) p.reject(new Error('world scan pool terminated'));
		this.pending.clear();
		this.workers = [];
	}
}
