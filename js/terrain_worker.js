// Terrain worker: a seed's generation and the GL terrain's CPU build, off the
// page's thread.
//
// On the page these ran back to back in one task -- the biome map, the wang
// tiles, the spawn prescan, then the renderer's lattices and atlases -- and for
// most of a second nothing else could: no frame, no input. Here they run in
// one or two instances of this worker (js/terrain_workers.js starts them and
// describes the split), and the page gets each product as it is finished:
//
//   BIOME    the biome map            (a few ms in)
//   LAYERS   the wang-tile layers     (the page keeps a copy: hover, search)
//   SPAWNS   the spawn prescan        (what the per-world scans start from)
//   TERRAIN  gl/terrain_cpu_resources (every array the upload needs, transferred)
//
// The worker loads the base biome maps and the wang templates itself, as soon
// as it starts, so a page that generates here never decodes them.
//
// Two instances split a seed like this: the first generates and then builds the
// renderer's resources; the second builds the one resource that needs only the
// seed (the sin-hash and modifier grids) while the first is still generating,
// hands it over, and then runs the prescan on the layers the first sends it.
// The two talk over a MessageChannel, so neither product passes through the
// page on its way.
import { BIOME_CONFIG, generateBiomeData } from './biome_generator.js';
import { GENERATOR_CONFIG } from './generator_config.js';
import { buildSinHashAndGrids } from './gl/engine_resources.js';
import { buildTerrainCpuResources, dropPaletteClosure, terrainCpuResourceBuffers } from './gl/terrain_cpu_resources.js';
import { loadTimeline } from './load_timeline.js';
import { loadPNG } from './png_sanitizer.js';
import { prescanSpawnFunctions } from './poi_scanner.js';
import { updateSettings } from './settings.js';
import { generateBiomeTiles } from './tile_generator.js';

const BASE_MAP_FILES = {
	normal: '../data/biome_maps/biome_map.png',
	ngp: '../data/biome_maps/biome_map_newgame_plus.png',
	nightmare: '../data/biome_maps/biome_map_nightmare.png',
};
const baseMaps = new Map();   // kind -> Promise<{data, width, height}>
const loadBaseMap = (kind) => {
	let p = baseMaps.get(kind);
	if (!p) baseMaps.set(kind, p = loadTimeline.time(`baseMap: ${kind}`, () => loadPNG(BASE_MAP_FILES[kind], { bitmap: false })));
	return p;
};
let templates = null;
const loadTemplates = () => templates ??= loadTimeline.time('wangTemplates', () => Promise.all(Object.values(GENERATOR_CONFIG)
	.filter(conf => conf.enabled && !conf.wangData && conf.wangFile)
	.map(async (conf) => { conf.wangData = await loadPNG(conf.wangFile, { bitmap: false }); })));

// Same precedence as app.generate: NG+ first, then nightmare.
const baseMapKind = (isNGP, gameMode) => (isNGP ? 'ngp' : gameMode === 'nightmare' ? 'nightmare' : 'normal');

let peer = null;                  // MessagePort to the other instance, if any
const peerWaiters = new Map();    // `${type}|${id}` -> resolve
const peerInbox = new Map();      // `${type}|${id}` -> message that arrived before it was awaited

function fromPeer(type, id) {
	const key = `${type}|${id}`;
	const have = peerInbox.get(key);
	if (have) { peerInbox.delete(key); return Promise.resolve(have); }
	return new Promise((resolve) => peerWaiters.set(key, resolve));
}

function onPeerMessage(e) {
	const key = `${e.data.type}|${e.data.id}`;
	const waiter = peerWaiters.get(key);
	if (waiter) { peerWaiters.delete(key); waiter(e.data); }
	else {
		// Kept until its job asks: a job abandoned by the page still runs to its
		// end here. Jobs are numbered in order, so anything this far behind the
		// newest was never going to be asked for.
		for (const k of peerInbox.keys()) if (Number(k.split('|')[1]) < e.data.id - 4) peerInbox.delete(k);
		peerInbox.set(key, e.data);
	}
}

// A step's time, for the timings the page is sent; `span` also puts it on the
// load timeline (the two loads above record their own, where they really ran:
// here they are only waited for).
async function timed(timings, name, fn, span = true) {
	const t0 = performance.now();
	const r = await (span ? loadTimeline.time(name, fn) : fn());
	timings[name] = (timings[name] || 0) + (performance.now() - t0);
	return r;
}

/**
 * The first instance's job (the only one's, when there is no second).
 * msg: { id, seed, ngPlusCount, gameMode, extraRerolls, prescan, settings,
 *        build: { maxTextureSize, lut, engineTerrain } | null,
 *        assisted }   -- a second instance is running `assist` for this id
 */
async function generate(msg) {
	const { id, seed, ngPlusCount = 0, gameMode = 'normal', extraRerolls = 0, build } = msg;
	const timings = {};
	const t0 = performance.now();
	if (msg.settings) updateSettings(msg.settings);
	const isNGP = ngPlusCount > 0;
	const wide = isNGP || gameMode === 'nightmare';
	const mapWidth = wide ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
	const mapHeight = wide ? BIOME_CONFIG.H_NGP : BIOME_CONFIG.H_NG0;

	const base = await timed(timings, 'baseMap', () => loadBaseMap(baseMapKind(isNGP, gameMode)), false);
	await timed(timings, 'wangTemplates', loadTemplates, false);
	const biomeData = await timed(timings, 'biomeMap', () =>
		generateBiomeData(seed, ngPlusCount, gameMode, base.data, mapWidth, mapHeight));
	self.postMessage({ type: 'BIOME', id, biomeData, mapWidth, mapHeight });

	const tileLayers = await timed(timings, 'wangTiles', () =>
		generateBiomeTiles(biomeData.pixels, mapWidth, mapHeight, GENERATOR_CONFIG, seed, ngPlusCount, extraRerolls, gameMode));
	// A copy for the second instance's prescan: this thread still builds from them.
	if (msg.assisted && msg.prescan) {
		await timed(timings, 'layersToPeer', () => peer.postMessage({ type: 'LAYERS', id, tileLayers, isNGP, gameMode }));
	}
	// The page's layers are the last thing posted, once nothing here needs them:
	// then the pixel buffers can be handed over instead of copied.
	const postLayers = () => timed(timings, 'layersPost', () => self.postMessage({ type: 'LAYERS', id, tileLayers },
		[...new Set(tileLayers.map(l => l.buffer?.buffer).filter(Boolean))]));

	if (msg.prescan && !msg.assisted) {
		const tileSpawns = await timed(timings, 'spawnPrescan', () => prescanSpawnFunctions(tileLayers, isNGP, gameMode));
		self.postMessage({ type: 'SPAWNS', id, tileSpawns, ms: timings.spawnPrescan, spans: loadTimeline.take() });
	}

	if (build) {
		// From the second instance when there is one: it has had the whole
		// generation to build it in.
		const sinHash = build.engineTerrain && msg.assisted ? (await fromPeer('SINHASH', id)).sinHash : null;
		const cpu = buildTerrainCpuResources(tileLayers, biomeData, {
			isNGP, gameMode, seed, maxTextureSize: build.maxTextureSize, lut: build.lut,
			engineTerrain: build.engineTerrain, generatorConfig: GENERATOR_CONFIG, sinHash,
		});
		for (const [k, v] of Object.entries(cpu.timings)) timings[k] = v;
		dropPaletteClosure(cpu);
		const transfer = terrainCpuResourceBuffers(cpu);
		await postLayers();
		timings.total = performance.now() - t0;
		self.postMessage({ type: 'TERRAIN', id, cpu, timings, spans: loadTimeline.take() }, transfer);
	} else {
		await postLayers();
		timings.total = performance.now() - t0;
		self.postMessage({ type: 'TERRAIN', id, cpu: null, timings, spans: loadTimeline.take() });
	}
}

/**
 * The second instance's job: what does not need the layers first, then what
 * does not need the first instance.
 * msg: { id, seed, sinHash: boolean, prescan: boolean, settings }
 */
async function assist(msg) {
	const { id, seed } = msg;
	if (msg.settings) updateSettings(msg.settings);
	if (msg.sinHash) {
		const t0 = performance.now();
		const sinHash = loadTimeline.time('sinHashGrids', () => buildSinHashAndGrids(seed));
		self.postMessage({ type: 'ASSIST_TIMING', id, name: 'sinHashGrids', ms: performance.now() - t0 });
		peer.postMessage({ type: 'SINHASH', id, sinHash }, [sinHash.data.buffer]);
	}
	if (msg.prescan) {
		const { tileLayers, isNGP, gameMode } = await fromPeer('LAYERS', id);
		const t0 = performance.now();
		const tileSpawns = loadTimeline.time('spawnPrescan', () => prescanSpawnFunctions(tileLayers, isNGP, gameMode));
		self.postMessage({ type: 'SPAWNS', id, tileSpawns, ms: performance.now() - t0, spans: loadTimeline.take() });
	}
}

self.onmessage = (e) => {
	const msg = e.data;
	if (msg.cmd === 'PEER') {
		peer = msg.port;
		peer.onmessage = onPeerMessage;
		return;
	}
	if (msg.cmd === 'WARM') {
		// Decode what a seed will need before one is asked for.
		for (const kind of msg.baseMaps ?? ['normal']) loadBaseMap(kind).catch(() => {});
		loadTemplates().catch((err) => { templates = null; console.error('[terrain worker] wang templates failed to load:', err); });
		return;
	}
	const job = msg.cmd === 'GENERATE' ? generate : msg.cmd === 'ASSIST' ? assist : null;
	if (!job) return;
	// Every request is answered: the page awaits each product.
	job(msg).catch((err) => {
		console.error(`[terrain worker] ${msg.cmd} of seed ${msg.seed} failed:`, err);
		self.postMessage({ type: 'FAILED', id: msg.id, error: String(err?.stack ?? err) });
	});
};

// See overlay_worker.js: a module worker can be handed messages before this
// module has finished evaluating; the page holds them until this arrives.
loadTimeline.started('modules');
self.postMessage({ type: 'READY', spans: loadTimeline.take() });
