// Workers started before the page's own module graph has loaded.
//
// A worker is not useful the moment it is created: it has its own module graph
// to fetch and evaluate, and the terrain worker then decodes the wang
// templates. Created by the module that uses them, the workers only began that
// once the page's whole graph had loaded -- so a first load waited for the two
// in turn. A page that puts
//
//   <script type="module">import { prespawnWorkers } from './js/prespawn.js'; prespawnWorkers();</script>
//
// ahead of its main script starts them while the main graph is still being
// fetched. The pools (terrain_workers.js, overlay_worker_pool.js) take their
// workers from here, and create them themselves when the page did not prespawn.
//
// Next to no imports, on purpose: this module has to run before anything else
// has loaded.
import { assetUrl } from './asset_url.js';

const cores = () => globalThis.navigator?.hardwareConcurrency || 4;

// The browser keeps the timing of the first 250 resources a page fetches and
// drops the rest; this page's modules alone are more. The load timeline
// (js/load_timeline.js) reads them, so make room before they start arriving.
globalThis.performance?.setResourceTimingBufferSize?.(3000);

/** Terrain workers: two when the machine can spare them, else one. */
export function defaultTerrainWorkerCount() {
	return cores() >= 4 ? 2 : 1;
}

/**
 * Overlay pool (scene builds, decal stamps): on up to eight cores, all but two
 * of them, at most four; beyond that half the cores, at most eight. A first
 * load is a few hundred scene builds that share nothing, so each worker added
 * takes its share off the wait -- 4 workers filled an overview in ~720 ms, 8
 * in about half that.
 */
export function defaultOverlayWorkerCount() {
	const n = cores();
	return Math.max(1, Math.min(8, Math.max(Math.min(4, n - 2), Math.floor(n / 2))));
}

const KINDS = {
	terrain: { file: './terrain_worker.js', name: (i) => `terrain-${i}` },
	overlay: { file: './overlay_worker.js', name: (i) => `overlay-pool-${i}` },
};
// kind -> [{ worker, messages }] not taken yet. Kept on globalThis, not in the
// module: a deployed build (tools/build_site.mjs) bundles the page's inline
// script apart from its main one, and both have to see the same workers.
const spawned = (globalThis.__prespawnedWorkers ??= new Map());

function spawn(kind, index) {
	const k = KINDS[kind];
	const worker = new Worker(assetUrl(new URL(k.file, import.meta.url)), { type: 'module', name: k.name(index) });
	// What the worker says before a pool takes it (its READY) is kept for the pool.
	const entry = { worker, messages: [] };
	worker.onmessage = (e) => entry.messages.push(e.data);
	return entry;
}

/**
 * Starts workers now, for the pools to take later.
 * @param {object} [counts]  { terrain, overlay }: how many of each. Default:
 *        the terrain workers only. They are what a first load waits for; the
 *        scene workers have until the worlds are scanned to be ready, and
 *        starting them here too only puts a dozen module graphs in the way of
 *        the two that matter.
 */
export function prespawnWorkers(counts = { terrain: defaultTerrainWorkerCount() }) {
	if (typeof Worker === 'undefined') return;
	for (const [kind, n] of Object.entries(counts)) {
		if (!KINDS[kind] || spawned.has(kind)) continue;
		spawned.set(kind, Array.from({ length: n || 0 }, (_, i) => ({ ...spawn(kind, i), index: i })));
	}
}

/**
 * The `index`-th worker of a kind: the prespawned one if there is one, else a
 * new one. `onMessage` becomes its message handler and is first given
 * anything the worker said before it was taken.
 */
export function takeWorker(kind, index, onMessage) {
	const list = spawned.get(kind);
	const at = list ? list.findIndex(e => e.index === index) : -1;
	const entry = at >= 0 ? list.splice(at, 1)[0] : spawn(kind, index);
	const { worker, messages } = entry;
	worker.onmessage = (e) => onMessage(e.data);
	for (const msg of messages.splice(0)) onMessage(msg);
	return worker;
}
