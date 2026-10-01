// Terrain world: what js/terrain_view.js draws, built from a seed without the
// app.
//
// Telescope's page builds the same data inside app.generate(), woven through
// its UI. A host that only wants the map -- an embedding viewer, the terrain
// view's test and benchmark page -- uses these three steps instead:
//
//   await loadTerrainAssets();                             // once per page
//   const world = await generateTerrainWorld({ seed });    // once per seed
//   scanTerrainWorld(world, 0, 0);                         // once per parallel world
//   // or, several worlds at once off the main thread:
//   await scanTerrainWorlds(world, ['0,0', '-1,0', '1,0'], { pool });
//
// Each step records how long each of its parts took in `timings` (ms), so a
// load-time benchmark can name the part a change moved, and every part that is
// optional can be left out.
import { BIOME_CONFIG, generateBiomeData } from './biome_generator.js';
import { frameSlo } from './frame_slo.js';
import { GENERATOR_CONFIG } from './generator_config.js';
import { loadPixelSceneData } from './pixel_scene_generation.js';
import { loadPNG } from './png_sanitizer.js';
import { getSpecialPoIs, prescanSpawnFunctions, scanSpawnFunctions } from './poi_scanner.js';
import { syncOverlayPoolMetadata } from './overlay_worker_pool.js';
import { appSettings } from './settings.js';
import { addStaticPixelScenes } from './static_spawns.js';
import { generateBiomeTiles } from './tile_generator.js';
import { loadTranslations } from './translations.js';

const BASE_MAP_FILES = {
	normal: '../data/biome_maps/biome_map.png',
	ngp: '../data/biome_maps/biome_map_newgame_plus.png',
	nightmare: '../data/biome_maps/biome_map_nightmare.png',
};
const baseMaps = new Map();   // kind -> Promise<{data, width, height}>

function baseMapKind(isNGP, gameMode) {
	// Same precedence as app.generate: NG+ first, then nightmare.
	return isNGP ? 'ngp' : gameMode === 'nightmare' ? 'nightmare' : 'normal';
}

function loadBaseMap(kind) {
	let p = baseMaps.get(kind);
	if (!p) baseMaps.set(kind, p = loadPNG(BASE_MAP_FILES[kind], { bitmap: false }));
	return p;
}

async function timed(timings, name, fn) {
	const t0 = performance.now();
	const r = await fn();
	timings[name] = (timings[name] || 0) + (performance.now() - t0);
	return r;
}

// Generation steps run on the calling thread from start to finish; the frame
// log (frame_slo.js) should say so when one of them is what held a frame up.
function timedSync(timings, name, fn) {
	const t0 = performance.now();
	const r = fn();
	const ms = performance.now() - t0;
	timings[name] = (timings[name] || 0) + ms;
	frameSlo.work(`generate:${name}`, ms);
	return r;
}

/**
 * Loads everything that does not depend on the seed. Safe to call again; what
 * is already loaded is not fetched twice.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.translations]   PoI names (default on; the scan runs
 *        without them, PoIs then carry raw ids)
 * @param {boolean} [opts.sceneWorkers]   start the overlay worker pool and give it
 *        the scene table (default on; off for a host that draws no scenes)
 * @param {string[]} [opts.baseMaps]      which base biome maps to decode now
 *        ('normal', 'ngp', 'nightmare'); the others load on first use
 * @returns {Promise<object>} timings: translations, baseMaps, wangTemplates,
 *          pixelSceneMeta, sceneWorkerSync
 */
export async function loadTerrainAssets({ translations = true, sceneWorkers = true, baseMaps: kinds = ['normal'] } = {}) {
	const timings = {};
	const jobs = [];
	if (translations) jobs.push(timed(timings, 'translations', () => loadTranslations()));
	jobs.push(timed(timings, 'baseMaps', () => Promise.all(kinds.map(loadBaseMap))));
	jobs.push(timed(timings, 'wangTemplates', () => Promise.all(Object.values(GENERATOR_CONFIG)
		.filter(conf => conf.enabled && !conf.wangData && conf.wangFile)
		.map(async (conf) => { conf.wangData = await loadPNG(conf.wangFile); }))));
	jobs.push(timed(timings, 'pixelSceneMeta', () => loadPixelSceneData()));
	await Promise.all(jobs);
	if (sceneWorkers) await timed(timings, 'sceneWorkerSync', () => syncOverlayPoolMetadata());
	return timings;
}

/**
 * Generates a seed's terrain: the biome map, the wang-tile layers every
 * parallel world shares, and the prescan the per-world spawn scans start from.
 *
 * @param {object} opts  seed, ngPlusCount (0), gameMode ('normal'), extraRerolls (0)
 *   prescan  false skips the spawn prescan (a host that draws terrain only)
 * @returns {Promise<object>} the world for TerrainView.setWorld, with empty
 *   `scenes` / `pois` / `bgSprites` (see scanTerrainWorld) and `timings`:
 *   baseMap, wangTemplates, biomeMap, wangTiles, spawnPrescan
 */
export async function generateTerrainWorld({ seed, ngPlusCount = 0, gameMode = 'normal', extraRerolls = 0, prescan = true }) {
	const timings = {};
	const isNGP = ngPlusCount > 0;
	const wide = isNGP || gameMode === 'nightmare';
	const mapWidth = wide ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
	const mapHeight = wide ? BIOME_CONFIG.H_NGP : BIOME_CONFIG.H_NG0;

	const base = await timed(timings, 'baseMap', () => loadBaseMap(baseMapKind(isNGP, gameMode)));
	await timed(timings, 'wangTemplates', async () => {
		for (const conf of Object.values(GENERATOR_CONFIG)) {
			if (conf.enabled && !conf.wangData && conf.wangFile) conf.wangData = await loadPNG(conf.wangFile);
		}
	});
	const biomeData = timedSync(timings, 'biomeMap', () =>
		generateBiomeData(seed, ngPlusCount, gameMode, base.data, mapWidth, mapHeight));
	// generateBiomeTiles is async in name only: it never yields.
	const t0 = performance.now();
	const tileLayers = await generateBiomeTiles(biomeData.pixels, mapWidth, mapHeight, GENERATOR_CONFIG, seed, ngPlusCount, extraRerolls, gameMode);
	timings.wangTiles = performance.now() - t0;
	frameSlo.work('generate:wangTiles', timings.wangTiles);
	const tileSpawns = prescan
		? timedSync(timings, 'spawnPrescan', () => prescanSpawnFunctions(tileLayers, isNGP, gameMode)) : null;

	return {
		seed, ngPlusCount, isNGP, gameMode, mapWidth, mapHeight,
		tileLayers, biomeData, tileSpawns,
		generatorConfig: GENERATOR_CONFIG,
		scenes: {}, pois: {}, bgSprites: {},
		timings,
	};
}

/**
 * Scans one parallel world on this thread: its pixel-scene placements, PoIs and
 * background sprites, into world.scenes / .pois / .bgSprites under 'pw,pwVertical'.
 * @returns {number} ms taken (also in world.timings['scan pw,pwVertical'])
 */
export function scanTerrainWorld(world, pw = 0, pwVertical = 0, { perks = {}, isDaily = false } = {}) {
	if (!world.tileSpawns) throw new Error('scanTerrainWorld: the world was generated with prescan: false');
	const t0 = performance.now();
	const key = `${pw},${pwVertical}`;
	const { seed, ngPlusCount, gameMode, biomeData } = world;
	const skipCosmetic = appSettings.skipCosmeticScenes;
	const scan = scanSpawnFunctions(biomeData, world.tileSpawns, seed, ngPlusCount, pw, pwVertical, skipCosmetic, perks, gameMode);
	let scenes = scan.finalPixelScenes;
	let pois = scan.generatedSpawns.concat(getSpecialPoIs(biomeData, seed, ngPlusCount, pw, pwVertical, perks, gameMode));
	if (appSettings.enableStaticPixelScenes !== 'off') {
		const fixed = addStaticPixelScenes(seed, ngPlusCount, pw, pwVertical, biomeData, skipCosmetic, perks, isDaily, gameMode);
		scenes = scenes.concat(fixed.pixelScenes);
		pois = pois.concat(fixed.pois);
	}
	world.scenes[key] = scenes;
	world.pois[key] = pois;
	world.bgSprites[key] = scan.backgroundSprites;
	const ms = performance.now() - t0;
	world.timings[`scan ${key}`] = ms;
	frameSlo.work('generate:scan', ms, { world: key });
	return ms;
}

/**
 * Scans several parallel worlds at once in a WorldScanPool (world_scan_pool.js).
 * Resolves when all of them are in the world; `onWorld(key)` fires as each lands,
 * so a host can draw a world's scenes as soon as its scan is back.
 *
 * world.timings gets `scanSync` (this thread's cost of handing the seed's data
 * to the workers) and, per world, `scan <key>` (the worker's own clock) and
 * `scanRoundTrip <key>`.
 */
export async function scanTerrainWorlds(world, keys, { pool, perks = {}, isDaily = false, onWorld = null } = {}) {
	if (!world.tileSpawns) throw new Error('scanTerrainWorlds: the world was generated with prescan: false');
	if (pool.syncedWorld !== world) {
		world.timings.scanSync = pool.sync({ biomeData: world.biomeData, tileSpawns: world.tileSpawns });
		frameSlo.work('generate:scanSync', world.timings.scanSync);
		pool.syncedWorld = world;
	}
	await Promise.all(keys.map(async (key) => {
		const [pw, pwVertical] = key.split(',').map(Number);
		const r = await pool.scan({
			seed: world.seed, ngPlusCount: world.ngPlusCount, pw, pwVertical, perks, isDaily, gameMode: world.gameMode,
		});
		world.scenes[key] = r.pixelScenes;
		world.pois[key] = r.pois;
		world.bgSprites[key] = r.bgSprites;
		if (r.scanMs != null) world.timings[`scan ${key}`] = r.scanMs;
		world.timings[`scanRoundTrip ${key}`] = r.roundTripMs;
		onWorld?.(key);
	}));
}
