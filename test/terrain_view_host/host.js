// The smallest host of js/terrain_view.js: one canvas, one camera, no app.
//
// Three jobs:
//   * the reference for embedding the view somewhere that is not telescope's
//     page -- everything a host has to do is in this file;
//   * the page the correctness run renders game-truth fixtures through
//     (test/gl_regression.mjs --host=view);
//   * the page the load / pan / zoom benchmark drives (test/terrain_view_bench.mjs).
//
// Nothing here imports js/app.js. Drag to pan, wheel to zoom.
//
// URL: ?seed=786433191&ng=0&mode=normal
//      &fit=3                parallel worlds to frame side by side (default 3)
//      &pws=0,0;-1,0;1,0     worlds to scan (default: every world the framed view sees,
//                            heaven and hell rows included); pws=none scans nothing
//      &scan=workers|main    where the parallel-world scans run (default workers)
//      &gen=workers|main     where the seed is generated and the renderer's CPU resources
//                            are built: the terrain workers, or this thread (default workers)
//      &worldWorkers=N &sceneWorkers=N &terrainWorkers=N   pool sizes (sceneWorkers: the
//                            overlay pool, which builds scene bitmaps and decal tiles;
//                            terrainWorkers: 1 or 2) (default: what the modules pick)
//      &scenes=0  &terrain=0  &engine=0  &textures=0  &edgenoise=0  &decals=0   switch an operation off
//      &auto=0               do not load on arrival; a driver calls terrainHost.load()
//      &framelog=1           log every frame over the 60 fps budget (js/frame_slo.js)
import { frameSlo } from '../../js/frame_slo.js';
import { loadTimeline } from '../../js/load_timeline.js';
import { onEdgeDecalTile } from '../../js/edge_decal_layer.js';
import { onSceneBitmaps, overlayPoolStats, startOverlayWorkerPool } from '../../js/overlay_worker_pool.js';
import { applyTerrainSettings, drawSpace, TerrainView } from '../../js/terrain_view.js';
import { generateTerrainWorld, loadTerrainAssets, scanTerrainWorld, scanTerrainWorlds } from '../../js/terrain_world.js';
import { TerrainWorkers } from '../../js/terrain_workers.js';
import { getWorldSize } from '../../js/utils.js';
import { WorldScanPool } from '../../js/world_scan_pool.js';

const params = new URLSearchParams(location.search);
const flag = (name) => params.get(name) !== '0';
const canvas = document.getElementById('view');
const statusEl = document.getElementById('status');

const host = {
	view: new TerrainView({ canvas }),
	world: null,
	pool: null,
	// Draw space, like TerrainView.render: world coordinates + drawSpace().
	cam: { x: 0, y: 0, z: 0.05 },
	size: { width: 0, height: 0 },
	// Per-frame switches handed to render(); a driver flips them between runs.
	ops: {
		terrain: flag('terrain'),
		scenes: flag('scenes'),
		engineTerrain: flag('engine'),
		materialTextures: flag('textures'),
		edgeNoise: flag('edgenoise'),
		edgeDecals: flag('decals'),
	},
	/** Marks since navigation start (ms), in the order they happened. */
	timeline: [],
	/** ms per step, by phase: assets, generate, prepare, scan, firstFrame. */
	timings: {},
	lastFrame: null,
	frames: 0,
	loads: 0,
	onFrame: null,
};
window.terrainHost = host;

// Both pools start with the page, so the workers load their modules while the
// assets are fetched instead of after the world exists.
const num = (name) => (params.has(name) ? Number(params.get(name)) : undefined);
const DEFAULT_SCAN = params.get('scan') || 'workers';
host.scanMode = DEFAULT_SCAN;
const DEFAULT_GEN = params.get('gen') || 'workers';
if (flag('scenes')) startOverlayWorkerPool({ count: num('sceneWorkers') });
if (host.scanMode === 'workers') host.pool = new WorldScanPool({ count: num('worldWorkers') });
// The terrain workers decode the base map and the wang templates as they start.
if (DEFAULT_GEN === 'workers') host.terrainWorkers = new TerrainWorkers({ count: num('terrainWorkers') });

const mark = (name) => host.timeline.push({ name, t: performance.now() });

function resize(width = canvas.clientWidth, height = canvas.clientHeight) {
	host.size = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// --- drawing -----------------------------------------------------------------

let rafId = 0, redrawTimer = 0;

/** Draws now. Returns TerrainView.render's result, or null before a world exists. */
host.draw = () => {
	if (host.holdFrame) return null;
	const t0 = performance.now();
	const r = host.view.render({
		width: host.size.width, height: host.size.height,
		camX: host.cam.x, camY: host.cam.y, camZ: host.cam.z,
		...host.ops,
	});
	host.lastFrame = { ms: performance.now() - t0, complete: !!r?.complete, drawn: !!r };
	host.frames++;
	frameSlo.drew(host.lastFrame.ms, host.view.timings.frame);
	if (r && host.ops.scenes) host.ensureWorlds();
	if (r && r.redrawInMs != null && !redrawTimer) {
		redrawTimer = setTimeout(() => { redrawTimer = 0; host.requestDraw(); }, Math.max(0, r.redrawInMs));
	}
	host.onFrame?.(host.lastFrame);
	return r;
};

host.requestDraw = () => {
	if (rafId) return;
	rafId = requestAnimationFrame(() => { rafId = 0; host.draw(); showStatus(); });
};

/**
 * Scans every world the camera sees, or is about to (a third beyond the view),
 * that has no scene list yet. Returns the promise of the scans it started.
 */
const scanning = new Set();
host.ensureWorlds = () => {
	const world = host.world;
	// While a load runs it scans its own worlds, in its own order.
	if (!world?.tileSpawns || host.loading) return Promise.resolve();
	const keys = host.view.worldsInView({
		width: host.size.width, height: host.size.height, camX: host.cam.x, camY: host.cam.y, camZ: host.cam.z,
	}, 0.75).filter(k => !world.scenes[k] && !scanning.has(`${world.seed}|${k}`));
	if (!keys.length) return Promise.resolve();
	if (host.scanMode !== 'workers') {
		for (const key of keys) {
			const [pw, pwVertical] = key.split(',').map(Number);
			scanTerrainWorld(world, pw, pwVertical);
		}
		host.requestDraw();
		return Promise.resolve();
	}
	for (const k of keys) scanning.add(`${world.seed}|${k}`);
	host.pool ??= new WorldScanPool({ count: num('worldWorkers') });
	return scanTerrainWorlds(world, keys, { pool: host.pool, onWorld: () => host.requestDraw() })
		.finally(() => { for (const k of keys) scanning.delete(`${world.seed}|${k}`); });
};

// A scene bitmap or a decal tile landed: the frame on screen is stale.
onSceneBitmaps(() => host.requestDraw());
onEdgeDecalTile(() => host.requestDraw());

// --- camera --------------------------------------------------------------------

/** Centres the view on a world position (generation coordinates) at `zoom`. */
host.setView = ({ x, y, zoom }) => {
	const ds = drawSpace(host.world?.isNGP ?? false, host.world?.gameMode ?? 'normal');
	host.cam = { x: x + ds.x, y: y + ds.y, z: zoom };
};

/** Frames `count` whole parallel worlds side by side, centred on the main one. */
host.fitWorlds = (count = 3, w = host.world) => {
	const worldWidth = getWorldSize(w?.isNGP ?? false, w?.gameMode ?? 'normal') * 512;
	const zoom = Math.min(host.size.width / (count * worldWidth), host.size.height / (48 * 512));
	host.cam = { x: worldWidth / 2, y: 24 * 512, z: zoom };
};

// --- loading -------------------------------------------------------------------

/**
 * Loads a seed step by step, timing each one. Every optional step can be
 * switched off, so a run can isolate what one of them costs.
 *
 * @param {object} o
 *   seed, ng, gameMode
 *   fit        parallel worlds to frame side by side
 *   pws        world keys to scan, in order (default: every world the framed
 *              view sees); [] scans nothing (terrain only)
 *   scan       'workers' (the world scan pool) or 'main'
 *   gen        'workers' (the terrain workers: generation and the renderer's
 *              CPU build off this thread, the scans started as soon as the
 *              prescan is in) or 'main' (this thread, one step after another)
 *   translations  load PoI names (not needed to draw)
 *   settle     keep drawing until the view is complete before resolving
 *   reveal     'terrain': draw the terrain as soon as it is ready, scenes as
 *              they arrive (the first load's default); 'scanned': keep the
 *              frame on screen until the worlds are scanned (a later seed's)
 * @returns the host's timings object
 */
host.load = async (o = {}) => {
	const {
		seed, ng = 0, gameMode = 'normal', scan = DEFAULT_SCAN, gen = DEFAULT_GEN,
		translations = true, settle = true, fit = 3,
	} = o;
	host.scanMode = scan;
	host.loading = true;
	const T = host.timings = {};
	mark('load:start');
	// A load that scans no world draws no scenes: nothing would ever place them.
	const wantScenes = flag('scenes') && !(o.pws && o.pws.length === 0);
	host.ops.scenes = wantScenes;
	const inWorkers = gen === 'workers';
	if (inWorkers) host.terrainWorkers ??= new TerrainWorkers({ count: num('terrainWorkers') });
	// A later seed is shown when its scenes can be: until then the frame on
	// screen stays the old seed's. Drawing its terrain first would take away
	// every scene the two seeds share (the static ones) for the few frames the
	// scans are out, and bring them back.
	const reveal = o.reveal ?? (host.world ? 'scanned' : 'terrain');
	host.holdFrame = reveal === 'scanned';

	// Seed-independent, so it overlaps the fetches: context, program link, atlas.
	applyTerrainSettings({ terrainRenderer: 'gl', gameMode });
	const early = host.view.prepare();

	let t0 = performance.now();
	// The terrain workers load the base map and the wang templates themselves,
	// and need nothing loaded here: with them, the seed generates while this
	// thread's assets (translations, the scene table) are still coming in.
	const assetsStart = t0;
	const assets = loadTerrainAssets({
		translations, sceneWorkers: wantScenes, ...(inWorkers ? { baseMaps: [], wangTemplates: false } : {}),
	}).then((timings) => {
		timings.total = performance.now() - assetsStart;
		mark('assets');
		return timings;
	});
	if (!inWorkers) await assets;

	// The scans need the biome map and the prescan, not the terrain: with the
	// terrain workers they start while the renderer's resources are still
	// being built. The camera and the worlds it sees follow from the game mode.
	let pws = null, scans = Promise.resolve(), scanT0 = 0;
	// Set when the workers' prescan landed; the scans then wait only for the
	// scene table and the translations they hand the scan workers.
	let scansAsked = null;
	const startScans = (world) => {
		if (fit) host.fitWorlds(fit, world);
		// What the view will ask for: the main world first, then the rest.
		pws = o.pws ?? host.view.worldsInView({
			width: host.size.width, height: host.size.height, camX: host.cam.x, camY: host.cam.y, camZ: host.cam.z,
		}, 1, world).sort((a, b) => (a === '0,0' ? -1 : b === '0,0' ? 1 : 0));
		T.worlds = pws;
		scanT0 = performance.now();
		if (pws.length && scan === 'workers' && world.tileSpawns) {
			host.pool ??= new WorldScanPool({ count: num('worldWorkers') });
			for (const k of pws) scanning.add(`${world.seed}|${k}`);
			scans = scanTerrainWorlds(world, pws, { pool: host.pool, onWorld: () => { mark('scanned'); host.requestDraw(); } })
				.finally(() => { for (const k of pws) scanning.delete(`${world.seed}|${k}`); });
		}
	};

	t0 = performance.now();
	const world = await generateTerrainWorld({
		seed, ngPlusCount: ng, gameMode, prescan: wantScenes,
		...(inWorkers ? {
			workers: host.terrainWorkers,
			build: host.view.buildOptions({ engineTerrain: host.ops.engineTerrain }),
			onSpawns: (w) => { scansAsked = assets.then(() => startScans(w)); },
		} : {}),
	});
	T.assets = await assets;
	T.generate = { ...world.timings, total: performance.now() - t0 };
	mark('generated');

	T.prepareEarly = await early;
	host.world = world;
	host.view.setWorld(world);
	if (scansAsked) await scansAsked;
	else startScans(world);

	// With the terrain workers this is the uploads alone.
	const p0 = performance.now();
	T.prepare = { ...await host.view.prepare({ sync: true, engineTerrain: host.ops.engineTerrain }) };
	T.prepare.total = performance.now() - p0;
	mark('prepared');

	// Terrain is drawable now, whatever the scans are doing.
	const f0 = performance.now();
	if (!host.holdFrame) {
		host.draw();
		host.view.terrain.finish();
	}
	T.firstFrame = { terrainOnly: performance.now() - f0 };
	mark('firstFrame');

	if (pws.length && scan === 'main') {
		for (const key of pws) {
			const [pw, pwVertical] = key.split(',').map(Number);
			scanTerrainWorld(world, pw, pwVertical);
			mark('scanned');
		}
	}
	await scans;
	host.loading = false;
	host.holdFrame = false;
	T.scan = { total: performance.now() - scanT0 };
	for (const [k, v] of Object.entries(world.timings)) if (k.startsWith('scan')) T.scan[k] = v;
	mark('scansDone');

	if (settle) {
		const s0 = performance.now();
		T.settle = { frames: await host.settle(), total: performance.now() - s0 };
		mark('settled');
		// The page's first load is timed from navigation; a later seed from its
		// request. Phases run from one milestone to the next (frame_slo.js).
		const first = host.loads++ === 0;
		const at = (name) => host.timeline.findLast(m => m.name === name).t;
		const began = first ? 0 : at('load:start');
		const done = performance.now();
		T.load = frameSlo.load(first ? 'page load' : 'new seed', done - began, first ? {
			modules: at('hostReady'),
			assets: at('assets') - at('hostReady'),
			generate: at('generated') - at('assets'),
			terrain: at('firstFrame') - at('generated'),
			scenes: done - at('firstFrame'),
		} : {
			generate: at('generated') - began,
			terrain: at('firstFrame') - at('generated'),
			scenes: done - at('firstFrame'),
		});
	}
	showStatus();
	return T;
};

/**
 * Draws until nothing the view wants is missing (scene bitmaps built and
 * uploaded, every world's scenes in), or `maxMs` passes. Returns frames drawn.
 */
host.settle = async (maxMs = 60000) => {
	const t0 = performance.now();
	let n = 0;
	for (;;) {
		const r = host.draw();
		n++;
		if (!r || r.complete || performance.now() - t0 > maxMs) return n;
		await new Promise(res => setTimeout(res, 16));
	}
};

// --- for the drivers -----------------------------------------------------------

/**
 * Renders one world rect at 1:1 and returns it as a PNG data URL, once the
 * view is complete. Transparent where the world is air.
 */
host.renderRect = async ({ x, y, w, h }) => {
	resize(w, h);
	host.setView({ x: x + w / 2, y: y + h / 2, zoom: 1 });
	await host.ensureWorlds();
	await host.settle();
	// toDataURL must follow the draw in the same task: the drawing buffer is
	// not preserved across a composite.
	host.draw();
	return canvas.toDataURL('image/png');
};

/**
 * Plays a camera path, one step per animation frame, and reports each frame.
 * `keys`: [{ x, y, zoom, ms }] -- world position and zoom to reach, and how long
 * the move from the previous key takes (the first key is the start). Zoom
 * interpolates geometrically, as a wheel zoom does.
 * @returns {Promise<{dt:number[], draw:number[], incomplete:number}>} per frame:
 *   the animation-frame interval and the draw call's main-thread time (ms)
 */
host.playPath = async (keys) => {
	const ds = drawSpace(host.world?.isNGP ?? false, host.world?.gameMode ?? 'normal');
	const dt = [], draw = [];
	let incomplete = 0;
	let last = await new Promise(requestAnimationFrame);
	for (let k = 1; k < keys.length; k++) {
		const a = keys[k - 1], b = keys[k];
		const start = last;
		for (;;) {
			const now = await new Promise(requestAnimationFrame);
			const u = Math.min(1, (now - start) / b.ms);
			host.cam = {
				x: a.x + (b.x - a.x) * u + ds.x,
				y: a.y + (b.y - a.y) * u + ds.y,
				z: a.zoom * (b.zoom / a.zoom) ** u,
			};
			host.draw();
			dt.push(now - last);
			draw.push(host.lastFrame.ms);
			if (!host.lastFrame.complete) incomplete++;
			last = now;
			if (u >= 1) break;
		}
	}
	return { dt, draw, incomplete };
};

/**
 * Draws the current view `n` times with some operations switched (`ops`, as in
 * host.ops), blocking on the GPU after each, and returns each frame's wall time
 * in ms: main thread plus GPU, for that set of operations alone.
 */
host.measureFrames = (n, ops = {}) => {
	const saved = host.ops;
	host.ops = { ...saved, ...ops };
	const frame = () => {
		const t0 = performance.now();
		host.draw();
		host.view.terrain.finish();
		return performance.now() - t0;
	};
	frame();   // the first draw after a switch may upload or requery
	const ms = Array.from({ length: n }, frame);
	host.ops = saved;
	return ms;
};

host.stats = () => ({
	renderer: rendererName(),
	pending: host.view.pending(),
	scenePool: overlayPoolStats(),
	scenes: host.view.scenes.stats(),
	frame: host.view.timings.frame,
	gpu: host.view.pollGpuTimings(),
});

function rendererName() {
	const gl = host.view.terrain.gl;
	if (!gl) return null;
	const ext = gl.getExtension('WEBGL_debug_renderer_info');
	return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

function showStatus() {
	const T = host.timings;
	const ms = (v) => (v == null ? '-' : `${v.toFixed(0)} ms`);
	const p = host.view.pending();
	statusEl.textContent = [
		host.world ? `seed ${host.world.seed}  NG+${host.world.ngPlusCount}` : 'no world',
		`assets ${ms(T.assets?.total)}  generate ${ms(T.generate?.total)}`,
		`gpu prepare ${ms(T.prepare?.total)}  scans ${ms(T.scan?.total)}`,
		`scenes ${ms(T.settle?.total)}`,
		T.load ? `${T.load.name}: ${T.load.ms} ms (budget ${T.load.budgetMs})` : '',
		`frame ${host.lastFrame ? host.lastFrame.ms.toFixed(2) : '-'} ms  zoom ${host.cam.z.toFixed(4)}`,
		`pending: ${p.sceneBitmaps} scene builds, ${p.edgeDecalTiles} decal tiles, ${p.sceneWorlds} worlds`,
		frameSlo.enabled ? `frames over 60 fps: ${frameSlo.missed}` : '',
		host.view.failed ? `GL unavailable: ${host.view.failed}` : '',
	].filter(Boolean).join('\n');
}

// --- manual pan / zoom ---------------------------------------------------------

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
	drag = { x: e.clientX, y: e.clientY };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
	if (!drag) return;
	host.cam.x -= (e.clientX - drag.x) / host.cam.z;
	host.cam.y -= (e.clientY - drag.y) / host.cam.z;
	drag = { x: e.clientX, y: e.clientY };
	host.requestDraw();
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
	e.preventDefault();
	// Zoom about the cursor: the world point under it stays put.
	const wx = host.cam.x + (e.clientX - host.size.width / 2) / host.cam.z;
	const wy = host.cam.y + (e.clientY - host.size.height / 2) / host.cam.z;
	host.cam.z = Math.min(32, Math.max(0.005, host.cam.z * Math.exp(-e.deltaY * 0.0015)));
	host.cam.x = wx - (e.clientX - host.size.width / 2) / host.cam.z;
	host.cam.y = wy - (e.clientY - host.size.height / 2) / host.cam.z;
	host.requestDraw();
}, { passive: false });
window.addEventListener('resize', () => { resize(); host.requestDraw(); });

frameSlo.addState('view', () => ({
	x: Math.round(host.cam.x), y: Math.round(host.cam.y), z: +host.cam.z.toFixed(4),
	canvas: [host.size.width, host.size.height], loading: !!host.loading, dragging: !!drag,
}));

resize();
mark('hostReady');
loadTimeline.started('modules');

if (flag('auto') && params.has('seed')) {
	host.loaded = host.load({
		seed: Number(params.get('seed')),
		ng: Number(params.get('ng') || 0),
		gameMode: params.get('mode') || 'normal',
		pws: !params.has('pws') ? undefined
			: params.get('pws') === 'none' ? [] : params.get('pws').split(';').filter(Boolean),
		fit: Number(params.get('fit') || 3),
	}).catch((err) => {
		host.loading = false;
		statusEl.textContent = `load failed: ${err?.stack ?? err}`;
		throw err;
	});
}
