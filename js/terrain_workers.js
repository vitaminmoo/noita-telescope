// Terrain workers: the page's side of js/terrain_worker.js.
//
// One or two instances of the worker generate a seed's terrain and build the GL
// renderer's CPU resources, so the page's thread does neither. With two (the
// default where there are cores to spare) the work that does not depend on the
// wang tiles runs beside the generation instead of after it:
//
//   worker 0   biome map -> wang tiles ---------------> lattices, atlases --> TERRAIN
//   worker 1   sin-hash + modifier grids --(to 0)       prescan -----------> SPAWNS
//                                            tiles --(from 0)--^
//
// The page is handed four promises per seed, each settling as its product is
// ready, so it can start the per-world scans the moment the prescan is in
// rather than when everything is.
//
// App-free: telescope's page and any other host of js/terrain_view.js use it
// through generateTerrainWorld (js/terrain_world.js).
import { appSettings } from './settings.js';
import { reviveTerrainCpuResources } from './gl/terrain_cpu_resources.js';
import { defaultTerrainWorkerCount, takeWorker } from './prespawn.js';

export { defaultTerrainWorkerCount };

function deferred() {
	const d = {};
	d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
	// A product nobody awaits (a superseded seed) must not raise an unhandled rejection.
	d.promise.catch(() => {});
	return d;
}

export class TerrainWorkers {
	/**
	 * @param {object} [opts]
	 * @param {number} [opts.count]      1 or 2 (default defaultTerrainWorkerCount())
	 * @param {string[]} [opts.baseMaps] base biome maps to decode at once
	 *        ('normal', 'ngp', 'nightmare'); the others load on first use
	 */
	constructor({ count = defaultTerrainWorkerCount(), baseMaps = ['normal'] } = {}) {
		this.jobs = new Map();   // id -> job
		this.nextId = 1;
		this.failed = null;
		this.workers = Array.from({ length: Math.min(2, Math.max(1, count)) }, (_, i) => {
			// Held until the worker says its module has loaded (terrain_worker.js
			// READY) -- which a worker the page prespawned (prespawn.js) may
			// already have said: takeWorker replays it into onMessage, so the
			// worker's fields are set through `state` before it is returned.
			const state = { ready: false, queue: [] };
			const w = takeWorker('terrain', i, (msg) => this.onMessage(state, msg));
			state.worker = w;
			w.addEventListener('error', (e) => {
				this.failed = `terrain worker ${i} failed: ${e.message ?? 'no message'}`;
				console.error(this.failed, e.filename ?? '', e.lineno ?? '');
				for (const job of this.jobs.values()) this.fail(job, this.failed);
			});
			return state;
		});
		if (this.workers.length === 2) {
			const { port1, port2 } = new MessageChannel();
			this.post(this.workers[0], { cmd: 'PEER', port: port1 }, [port1]);
			this.post(this.workers[1], { cmd: 'PEER', port: port2 }, [port2]);
		}
		// Only the generating instance reads the templates and the base maps.
		this.post(this.workers[0], { cmd: 'WARM', baseMaps });
	}

	post(w, msg, transfer = []) {
		if (w.ready && w.worker) w.worker.postMessage(msg, transfer);
		else w.queue.push([msg, transfer]);
	}

	onMessage(w, msg) {
		if (msg.type === 'READY') {
			w.ready = true;
			// A prespawned worker's READY is replayed from inside takeWorker,
			// before `worker` is set; nothing has been queued for it yet.
			if (w.worker) this.flush(w);
			return;
		}
		const job = this.jobs.get(msg.id);
		if (!job) return;   // a superseded seed's product
		const at = performance.now() - job.t0;
		if (msg.type === 'BIOME') {
			job.timings.biomeAt = at;
			job.biome.resolve({ biomeData: msg.biomeData, mapWidth: msg.mapWidth, mapHeight: msg.mapHeight });
		} else if (msg.type === 'LAYERS') {
			job.timings.layersAt = at;
			job.layers.resolve(msg.tileLayers);
		} else if (msg.type === 'SPAWNS') {
			job.timings.spawnsAt = at;
			if (msg.ms != null) job.timings.spawnPrescan = msg.ms;
			job.spawns.resolve(msg.tileSpawns);
		} else if (msg.type === 'ASSIST_TIMING') {
			job.timings[msg.name] = msg.ms;
		} else if (msg.type === 'TERRAIN') {
			job.timings.terrainAt = at;
			Object.assign(job.timings, msg.timings);
			job.terrain.resolve(msg.cpu ? reviveTerrainCpuResources(msg.cpu) : null);
			this.settle(job);
		} else if (msg.type === 'FAILED') {
			this.fail(job, msg.error);
		}
	}

	flush(w) {
		for (const [m, transfer] of w.queue) w.worker.postMessage(m, transfer);
		w.queue = [];
	}

	fail(job, error, superseded = false) {
		const err = new Error(superseded ? 'terrain generation superseded by a newer seed'
			: `terrain generation failed in the worker: ${error}`);
		// A caller that awaits a job it has itself replaced can tell, and stay quiet.
		err.superseded = superseded;
		for (const d of [job.biome, job.layers, job.spawns, job.terrain]) d.reject(err);
		this.jobs.delete(job.id);
	}

	settle(job) {
		// The prescan can finish after the terrain build; keep the job until both are in.
		Promise.allSettled([job.spawns.promise, job.terrain.promise]).then(() => this.jobs.delete(job.id));
	}

	/**
	 * Generates a seed. Any job still running is abandoned: the workers finish
	 * it (they cannot be interrupted) but its products are dropped.
	 *
	 * @param {object} o
	 *   seed, ngPlusCount (0), gameMode ('normal'), extraRerolls (0)
	 *   prescan  false: no spawn prescan (a host that draws terrain only)
	 *   build    { maxTextureSize, lut, engineTerrain } -- TerrainView.buildOptions();
	 *            omitted: no renderer resources, `terrain` resolves null
	 * @returns {{biome, layers, spawns, terrain: Promise, timings: object}}
	 *   biome    { biomeData, mapWidth, mapHeight }
	 *   layers   the wang-tile layers
	 *   spawns   the prescan (null when prescan is false)
	 *   terrain  the build for TerrainView.setWorld's `terrainResources`
	 *   timings  filled as the products land: ms per step in the workers, and
	 *            `biomeAt` / `layersAt` / `spawnsAt` / `terrainAt`, ms from the request
	 */
	generate({ seed, ngPlusCount = 0, gameMode = 'normal', extraRerolls = 0, prescan = true, build = null }) {
		for (const old of this.jobs.values()) this.fail(old, null, true);
		const job = {
			id: this.nextId++, t0: performance.now(), timings: {},
			biome: deferred(), layers: deferred(), spawns: deferred(), terrain: deferred(),
		};
		this.jobs.set(job.id, job);
		if (this.failed) { this.fail(job, this.failed); return this.handle(job); }
		if (!prescan) job.spawns.resolve(null);
		// The workers read the same settings the page does (fill colors, recolor).
		const settings = { ...appSettings };
		const assisted = this.workers.length === 2 && (prescan || !!build?.engineTerrain);
		if (assisted) {
			this.post(this.workers[1], { cmd: 'ASSIST', id: job.id, seed, sinHash: !!build?.engineTerrain, prescan, settings });
		}
		this.post(this.workers[0], {
			cmd: 'GENERATE', id: job.id, seed, ngPlusCount, gameMode, extraRerolls, prescan, build, settings, assisted,
		});
		return this.handle(job);
	}

	handle(job) {
		return {
			biome: job.biome.promise, layers: job.layers.promise, spawns: job.spawns.promise, terrain: job.terrain.promise,
			timings: job.timings,
		};
	}

	terminate() {
		for (const w of this.workers) w.worker.terminate();
		for (const job of this.jobs.values()) this.fail(job, 'terrain workers terminated');
		this.workers = [];
	}
}
