// Terrain view: the world's cells -- terrain plus pixel scenes -- drawn for a
// camera, behind one interface that every host shares.
//
// Telescope's own page (app.js drawTerrainGL) and an embedding map viewer both
// drive this class and nothing below it. The host owns the camera, the canvas
// it shows and everything that is not a world cell (backgrounds, PoI markers,
// decals); the view owns the WebGL2 context, the GL terrain pass
// (gl/terrain_renderer.js) and the GL scene pass (gl/scene_renderer.js), and
// knows which parallel-world copies a camera can see.
//
// Nothing is stored per zoom level. A frame is shaded from the seed's data for
// exactly the pixels on screen, so panning or zooming never swaps in a coarser
// stand-in for terrain, and a frame costs the same at every zoom.
//
//   const view = new TerrainView({ canvas });          // or no canvas: blit view.canvas yourself
//   view.setWorld({ seed, isNGP, gameMode, tileLayers, biomeData, scenes });
//   await view.prepare();                               // optional: every load step now, timed
//   const r = view.render({ width, height, camX, camY, camZ });
//   if (!r.complete) redraw when onSceneBitmaps fires or after r.redrawInMs
//
// Camera: `camX, camY` are the world position of the view centre in telescope's
// draw space -- generation world coordinates plus a constant offset (drawSpace
// below) -- and `camZ` is screen pixels per world pixel. `pw` / `pwVertical`
// name the parallel world draw space is anchored to (telescope's PW inputs);
// a host with one continuous world leaves them 0 and puts the whole position
// in camX / camY.
//
// Every operation can be switched off per frame (see render) and every load
// step and pass reports its own time (timings), so a benchmark can say what a
// step costs on its own: the terrain pass without scenes, the scene passes
// without terrain, scene loading without either.
//
// Settings that the scene bitmap builds read (material textures, recolor,
// budgets) are realm-wide state in settings.js, shared with the workers; a host
// without telescope's settings UI sets them through applyTerrainSettings().
import { CHUNK_SIZE, WORLD_CHUNK_CENTER_Y } from './constants.js';
import { frameSlo } from './frame_slo.js';
import { GENERATOR_CONFIG } from './generator_config.js';
import { initMaterialAtlas } from './gl/material_atlas.js';
import { GLSceneRenderer } from './gl/scene_renderer.js';
import { GLTerrainRenderer } from './gl/terrain_renderer.js';
import {
	getPixelSceneCacheStats, initPixelSceneTextures, pendingPixelSceneBitmaps, pixelSceneMipLevel,
} from './pixel_scene_generation.js';
import { sceneBitmapPoolStats, syncSceneBitmapPoolSettings } from './scene_bitmap_pool.js';
import { appSettings, updateSettings } from './settings.js';
import { getPWLimit, getWorldCenter, getWorldSize } from './utils.js';

// Below this zoom the per-cell material texels are smaller than half a screen
// pixel: point-sampling them just shimmers, and the flat material colors are
// what the eye averages the texture to anyway. The material-texture detail pass
// auto-disables below it (edge decals have their own gate, EDGE_DECAL_MIN_ZOOM).
export const MATERIAL_DETAIL_MIN_ZOOM = 0.5;

const WORLD_HEIGHT_PX = 48 * CHUNK_SIZE;
const PW_VERTICAL_LIMIT = 683;

/**
 * Draw space: generation world coordinates plus a constant, the same for every
 * parallel world in view (derivation in gl/terrain_renderer.js). A host that
 * thinks in world coordinates converts once per frame.
 */
export function drawSpace(isNGP, gameMode = 'normal') {
	return { x: CHUNK_SIZE * getWorldCenter(isNGP, gameMode), y: CHUNK_SIZE * WORLD_CHUNK_CENTER_Y };
}

/**
 * Applies renderer settings for a host without telescope's settings UI, on this
 * thread and in the scene workers. Telescope's page keeps using its own
 * updateSettingsFromUI / syncSettingsToOverlayWorker.
 */
export function applyTerrainSettings(settings) {
	updateSettings(settings);
	syncSceneBitmapPoolSettings(appSettings);
}

export class TerrainView {
	/**
	 * @param {object} [opts]
	 * @param {HTMLCanvasElement|OffscreenCanvas} [opts.canvas]  the canvas to draw
	 *        into (it gets the WebGL2 context, and is resized to each frame's
	 *        width x height). Omitted: a hidden canvas, returned by render() for
	 *        the host to blit.
	 */
	constructor({ canvas = null } = {}) {
		this.terrain = new GLTerrainRenderer({ canvas });
		this.scenes = new GLSceneRenderer();
		this.world = null;
		this.frame = 0;
		/** `prepare`: ms per load step of the last prepare() or lazy build.
		 *  `frame`: main-thread ms per pass of the last render().
		 *  `gpu`: last GPU time per pass, when collectGpuTimings is on. */
		this.timings = { prepare: {}, frame: {}, gpu: {} };
		// What the frame log (frame_slo.js) records about the view at every
		// missed frame: what it is waiting for and how full its caches are.
		frameSlo.addState('terrainView', () => {
			const c = getPixelSceneCacheStats();
			const g = this.scenes.stats();
			return {
				pending: this.pending(),
				sceneCache: {
					entries: c.entries, mb: Math.round(c.bytes / 1048576), budgetMb: Math.round(c.budgetBytes / 1048576),
					building: c.pending, buildingTextured: c.pendingTextured,
					requests: c.requests, refetches: c.refetches, evictions: c.evictions, failures: c.failures,
				},
				sceneWorkers: sceneBitmapPoolStats().inflight,
				sceneAtlas: { pages: g.pages, mb: Math.round(g.bytes / 1048576), images: g.slots },
				gpuMs: this.timings.gpu,
				failed: this.failed,
			};
		});
	}

	/** The canvas the passes draw into (null before the first context). */
	get canvas() { return this.terrain.canvas; }

	/** True once terrain resources are uploaded, i.e. render() will draw. */
	get ready() { return this.terrain.ready; }

	/** Why GL is unavailable (no WebGL2, build failure), or null. The host
	 *  falls back to its own renderer; invalidate() clears it for a retry. */
	get failed() { return this.terrain.failed; }

	/**
	 * The world to draw. Cheap to call every frame: resources are rebuilt only
	 * when the layers / biome data objects or the seed change.
	 * @param {object} world
	 *   seed, isNGP, gameMode
	 *   tileLayers       generateBiomeTiles' layers (PW 0; shared by every PW)
	 *   biomeData        generateBiomeData's result
	 *   generatorConfig  GENERATOR_CONFIG by default
	 *   scenes           { 'pwX,pwY': placement list } -- may gain worlds later;
	 *                    a world without a list draws terrain only
	 */
	setWorld(world) {
		this.world = world;
	}

	/**
	 * GPU time per pass through EXT_disjoint_timer_query_webgl2, into
	 * timings.gpu ({ terrainGL, scenesGL } ms). Results land a few frames late;
	 * call pollGpuTimings() until the pass you drew shows up.
	 */
	collectGpuTimings(on = true) {
		this.terrain.onGpuSample = on ? (sys, ms) => { this.timings.gpu[sys] = ms; } : null;
	}

	pollGpuTimings() {
		this.terrain.pollGpuTimers();
		return this.timings.gpu;
	}

	/**
	 * Runs every load step that does not need a frame, one after another, and
	 * returns the wall time of each. Optional -- render() does the same work
	 * lazily -- but a host that calls it while the world is still generating
	 * (the first three steps need no world) takes them off the first frame, and
	 * a benchmark gets each step on its own.
	 *
	 * Steps: context, shaderLink, materialAtlas (fetch), sceneTextures (the scene
	 * builds' atlas + band tables), then with a world: regionAtlas, chunkTextures,
	 * engineLattice, engineTable, sinHashGrids, materialTables, noiseTable, upload.
	 *
	 * @param {object} [opts]
	 * @param {boolean} [opts.sync]  block on the GPU after the uploads, so `upload`
	 *        includes the GPU's share instead of leaving it to the first frame
	 * @param {boolean} [opts.engineTerrain]  as in render()
	 */
	async prepare(opts = {}) {
		const t = {};
		const step = async (name, fn) => {
			const s = performance.now();
			const r = await fn();
			t[name] = performance.now() - s;
			return r;
		};
		const terrain = this.terrain;
		if (!await step('context', () => terrain.initContext())) {
			this.timings.prepare = t;
			return t;
		}
		const linked = !!terrain.program;
		await step('shaderLink', () => terrain.ensureProgram());
		if (linked) t.shaderLink = 0;
		await step('materialAtlas', () => initMaterialAtlas().catch(() => null));
		await step('sceneTextures', () => initPixelSceneTextures());
		if (this.world && this.ensureResources(opts)) {
			if (this.builtThisCall) Object.assign(t, terrain.buildTimings);
			if (opts.sync) await step('gpuFinish', () => terrain.finish());
		}
		this.timings.prepare = t;
		return t;
	}

	/** Builds + uploads terrain resources when the world changed. */
	ensureResources(opts = {}) {
		const w = this.world;
		const terrain = this.terrain;
		const before = terrain.buildTimings;
		const ok = terrain.ensureResources(w.tileLayers, w.biomeData, {
			isNGP: w.isNGP,
			gameMode: w.gameMode,
			// Color-only settings: a 1 KiB LUT re-upload, never an atlas rebuild.
			lut: {
				recolorMaterials: appSettings.recolorMaterials,
				clearSpawnPixels: appSettings.clearSpawnPixels,
			},
			// Engine resolve mode builds the 1/10 lattices + parameter tables.
			engineTerrain: opts.engineTerrain ?? appSettings.engineTerrain,
			seed: w.seed,
			generatorConfig: w.generatorConfig ?? GENERATOR_CONFIG,
		});
		this.builtThisCall = ok && terrain.buildTimings !== before;
		if (this.builtThisCall) {
			this.timings.prepare = { ...this.timings.prepare, ...terrain.buildTimings };
			const steps = {};
			for (const [k, v] of Object.entries(terrain.buildTimings)) if (v >= 0.5) steps[k] = Math.round(v);
			frameSlo.work('terrainResources', terrain.buildMs, steps);
		}
		return ok;
	}

	/**
	 * The parallel worlds a camera can see, as 'pwX,pwY' keys.
	 * @param {number} [margin]  < 1 widens the area (0.75 = a third further out),
	 *        for a host that generates worlds before they scroll into view
	 */
	worldsInView(view, margin = 1) {
		const w = this.world;
		if (!w) return [];
		const worldWidth = getWorldSize(w.isNGP, w.gameMode) * CHUNK_SIZE;
		const pw = view.pw ?? 0, pwVertical = view.pwVertical ?? 0;
		const cx = pw * worldWidth + view.camX, cy = pwVertical * WORLD_HEIGHT_PX + view.camY;
		const halfW = (view.width / 2) / (view.camZ * margin), halfH = (view.height / 2) / (view.camZ * margin);
		const limit = getPWLimit(w.isNGP, w.gameMode);
		const keys = [];
		// Half-open on the far edges: a view that ends exactly on a world boundary
		// does not see the world beyond it.
		const x1 = Math.ceil((cx + halfW) / worldWidth) - 1, y1 = Math.ceil((cy + halfH) / WORLD_HEIGHT_PX) - 1;
		for (let x = Math.floor((cx - halfW) / worldWidth); x <= x1; x++) {
			for (let y = Math.floor((cy - halfH) / WORLD_HEIGHT_PX); y <= y1; y++) {
				if (x < -limit || x > limit || y < -PW_VERTICAL_LIMIT || y > PW_VERTICAL_LIMIT) continue;
				keys.push(`${x},${y}`);
			}
		}
		return keys;
	}

	/**
	 * Draws one frame.
	 *
	 * @param {object} view
	 *   width, height        frame size in pixels (the canvas is resized to it)
	 *   camX, camY, camZ     view centre in draw space, screen px per world px
	 *   pw, pwVertical       draw space's anchor world (default 0)
	 *   worlds               world keys to draw scenes for (default: worldsInView)
	 *   frame                the host's frame serial (default: a counter)
	 *   onPass               (name) => void, called as 'terrainGL' and 'scenesGL'
	 *                        finish, for a host's own per-layer profiler
	 *  Operations, each on unless said otherwise:
	 *   terrain              false: clear only, no terrain pass
	 *   engineTerrain        the game's per-pixel resolve; false = the 1/10
	 *                        wang-pixel palette path (default: the setting)
	 *   edgeNoise            biome-boundary wobble (default: the setting)
	 *   materialTextures     per-cell material texels (default: the setting,
	 *                        and only at camZ >= MATERIAL_DETAIL_MIN_ZOOM)
	 *   scenes               false: no pixel scenes at all (nothing requested)
	 *   sceneAir, sceneColor false: skip that sub-pass of the scene draw
	 *   sceneBudgetBytes     GPU atlas budget for scene bitmaps
	 *   detailZoom           the zoom every level-of-detail gate reads
	 *                        (default camZ; Infinity = never reduce detail)
	 *
	 * @returns {null|{canvas, terrain:boolean, scenes:boolean, worlds:string[],
	 *                 redrawInMs:number|null, complete:boolean}}
	 *   null when GL is unavailable (see `failed`). `scenes` says the scene pass
	 *   ran; `redrawInMs` is non-null when landed bitmaps were left for a later
	 *   frame; `complete` is false while anything the frame wanted is missing.
	 */
	render(view) {
		const w = this.world;
		if (!w) return null;
		const t = {};
		let t0 = performance.now();
		const lap = (name) => {
			const now = performance.now();
			t[name] = now - t0;
			t0 = now;
		};
		const terrain = this.terrain;
		const engineTerrain = view.engineTerrain ?? appSettings.engineTerrain;
		if (!this.ensureResources({ engineTerrain })) return null;
		lap('resources');

		this.frame = view.frame ?? this.frame + 1;
		const pw = view.pw ?? 0, pwVertical = view.pwVertical ?? 0;
		const detailZoom = view.detailZoom ?? view.camZ;
		const canvas = terrain.render({
			width: view.width,
			height: view.height,
			camX: view.camX,
			camY: view.camY,
			camZ: view.camZ,
			pw,
			pwVertical,
			edgeNoise: view.edgeNoise ?? appSettings.enableEdgeNoise,
			// Per-cell material textures only mean anything once wang colors
			// resolve to their material, which is what recolorMaterials does.
			// Auto-off when zoomed out: sub-pixel texels only alias.
			materialTextures: (view.materialTextures ?? appSettings.materialTextures) && appSettings.recolorMaterials
				&& detailZoom >= MATERIAL_DETAIL_MIN_ZOOM,
			engineTerrain,
			draw: view.terrain !== false,
		});
		if (!canvas) return null;
		lap('terrainGL');
		view.onPass?.('terrainGL');

		const worlds = view.worlds ? [...view.worlds] : this.worldsInView(view);
		let scenes = false;
		this.redrawInMs = null;
		this.missingSceneWorlds = 0;
		if (view.scenes !== false && w.scenes) {
			scenes = this.drawScenes(view, worlds, pw, pwVertical, detailZoom);
			lap('scenesGL');
			view.onPass?.('scenesGL');
		}
		this.timings.frame = t;
		return {
			canvas,
			terrain: view.terrain !== false,
			scenes,
			worlds,
			redrawInMs: this.redrawInMs,
			complete: this.pending().total === 0,
		};
	}

	drawScenes(view, worldKeys, pw, pwVertical, detailZoom) {
		const w = this.world;
		const worldCenter = getWorldCenter(w.isNGP, w.gameMode) * CHUNK_SIZE;
		const worldSize = getWorldSize(w.isNGP, w.gameMode) * CHUNK_SIZE;
		const worlds = [];
		for (const worldKey of worldKeys) {
			const [pwX, pwY] = worldKey.split(',').map(Number);
			const list = w.scenes[worldKey];
			if (!list) { this.missingSceneWorlds++; continue; }
			worlds.push({
				list,
				relOffX: worldCenter - pwX * worldSize,
				relOffY: WORLD_CHUNK_CENTER_Y * CHUNK_SIZE - pwY * WORLD_HEIGHT_PX,
				shiftX: (pwX - pw) * worldSize,
				shiftY: (pwY - pwVertical) * WORLD_HEIGHT_PX,
			});
		}
		const halfW = (view.width / 2) / view.camZ, halfH = (view.height / 2) / view.camZ;
		const drawn = this.scenes.draw(this.terrain, {
			width: view.width,
			height: view.height,
			originX: view.camX - halfW,
			originY: view.camY - halfH,
			zoom: view.camZ,
			level: pixelSceneMipLevel(detailZoom),
			frame: this.frame,
			budgetBytes: view.sceneBudgetBytes ?? defaultSceneBudgetBytes(),
			viewRect: { left: view.camX - halfW, right: view.camX + halfW, top: view.camY - halfH, bottom: view.camY + halfH },
			worlds,
			air: view.sceneAir,
			color: view.sceneColor,
		});
		if (drawn) this.redrawInMs = this.scenes.redrawInMs;
		return drawn;
	}

	/**
	 * What the last frame wanted and did not have yet. A view is complete when
	 * `total` is 0: every scene bitmap in view has been built and uploaded, and
	 * every world in view has its placement list.
	 */
	pending() {
		const sceneBitmaps = pendingPixelSceneBitmaps();
		const sceneUploads = this.redrawInMs != null ? 1 : 0;
		const sceneWorlds = this.missingSceneWorlds || 0;
		return { sceneBitmaps, sceneUploads, sceneWorlds, total: sceneBitmaps + sceneUploads + sceneWorlds };
	}

	/** Frees the terrain resources; the next frame rebuilds them. */
	invalidate() {
		this.terrain.invalidate();
	}

	/** Frees everything, including the scene atlas pages. */
	dispose() {
		this.scenes.dropAll();
		this.terrain.dispose();
		this.world = null;
	}
}

// Under Render Everything the full-res textured instances of a whole overview
// do not fit the default budget (pixel_scene_generation.js sceneBitmapBudgetBytes).
function defaultSceneBudgetBytes() {
	const budgetMB = appSettings.renderEverything
		? Math.max(appSettings.pixelSceneBitmapBudgetMB || 512, 2048) : (appSettings.pixelSceneBitmapBudgetMB || 512);
	return budgetMB * 1024 * 1024;
}
