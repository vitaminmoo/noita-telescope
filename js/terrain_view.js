// Terrain view: the world's cells -- terrain plus pixel scenes -- drawn for a
// camera, behind one interface that every host shares.
//
// Telescope's own page (app.js drawTerrainGL) and an embedding map viewer both
// drive this class and nothing below it. The host owns the camera, the canvas
// it shows and everything that is not a world cell (backgrounds, PoI markers);
// the view owns the WebGL2 context and the three passes that draw into it --
// terrain (gl/terrain_renderer.js), pixel scenes (gl/scene_renderer.js) and
// edge decals (edge_decal_layer.js, gl/decal_renderer.js) -- and knows which
// parallel-world copies a camera can see.
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
import { drawEdgeDecals, EDGE_DECAL_MAX_TILES, EDGE_DECAL_TILE, pendingEdgeDecalTiles } from './edge_decal_layer.js';
import { frameSlo } from './frame_slo.js';
import { GENERATOR_CONFIG } from './generator_config.js';
import { GLDecalRenderer } from './gl/decal_renderer.js';
import { initMaterialAtlas } from './gl/material_atlas.js';
import { GLSceneRenderer } from './gl/scene_renderer.js';
import { GLTerrainRenderer } from './gl/terrain_renderer.js';
import { maxTextureSize } from './gl/textures.js';
import {
	getPixelSceneCacheStats, initPixelSceneTextures, pendingPixelSceneBitmaps, pixelSceneMipLevel,
} from './pixel_scene_generation.js';
import { overlayPoolStats, syncOverlayPoolSettings } from './overlay_worker_pool.js';
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
	syncOverlayPoolSettings(appSettings);
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
		this.decals = new GLDecalRenderer(EDGE_DECAL_TILE, EDGE_DECAL_MAX_TILES);
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
				poolWorkers: overlayPoolStats().inflight,
				decals: this.decals.stats(),
				sceneAtlas: { pages: g.pages, mb: Math.round(g.bytes / 1048576), images: g.slots, maps: g.maps, warmRemaining: g.warmRemaining },
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
	 *   seed, ngPlusCount, isNGP, gameMode
	 *   tileLayers       generateBiomeTiles' layers (PW 0; shared by every PW)
	 *   biomeData        generateBiomeData's result
	 *   terrainResources the renderer's CPU resources, when they were built with
	 *                    the world (generateTerrainWorld's `build`); without
	 *                    them, or when a setting they depend on has changed
	 *                    since, the first frame builds them on this thread
	 *   generatorConfig  GENERATOR_CONFIG by default
	 *   scenes           { 'pwX,pwY': placement list } -- may gain worlds later;
	 *                    a world without a list draws terrain only
	 */
	setWorld(world) {
		this.world = world;
	}

	/**
	 * What a build of the renderer's CPU resources away from this thread has to
	 * match: pass it as generateTerrainWorld's `build`. Creates the context (the
	 * texture size limit is the context's). Null when GL is unavailable.
	 * @param {object} [opts]  engineTerrain: as in render() (default: the setting)
	 */
	buildOptions(opts = {}) {
		if (!this.terrain.initContext()) return null;
		return {
			maxTextureSize: maxTextureSize(this.terrain.gl),
			lut: {
				recolorMaterials: appSettings.recolorMaterials,
				clearSpawnPixels: appSettings.clearSpawnPixels,
			},
			engineTerrain: opts.engineTerrain ?? appSettings.engineTerrain,
		};
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
	 * Steps: context, shaderLink, sceneShaderLink, materialAtlas (fetch),
	 * sceneTextures (the scene builds' atlas + band tables), then with a world:
	 * regionAtlas, chunkTextures,
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
		// The pixel scenes' material-map program: the same library, linked again.
		const sceneLinked = !!this.scenes.matProgram;
		await step('sceneShaderLink', () => this.scenes.initMaterials(terrain));
		if (sceneLinked) t.sceneShaderLink = 0;
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
			prebuilt: w.terrainResources,
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
	 * @param {object} [world]   the world to answer for, when it is not set yet
	 *        (only isNGP and gameMode are read)
	 */
	worldsInView(view, margin = 1, world = this.world) {
		const w = world;
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
	 *   offscreen            true for a frame nobody sees (behind a loading
	 *                        overlay): its unfinished detail is not logged
	 *   onPass               (name) => void, called as 'terrainGL', 'scenesGL'
	 *                        and 'edgeDecals' finish, for a host's own profiler
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
	 *   edgeDecals           the decal band the engine bakes along material
	 *                        borders (default: the setting; needs engineTerrain,
	 *                        pwVertical 0, and only draws at camZ >= 1)
	 *   detailZoom           the zoom every level-of-detail gate reads
	 *                        (default camZ; Infinity = never reduce detail)
	 *
	 * @returns {null|{canvas, terrain:boolean, scenes:boolean, edgeDecals:boolean,
	 *                 worlds:string[], redrawInMs:number|null, detail, complete:boolean}}
	 *   null when GL is unavailable (see `failed`). `scenes` / `edgeDecals` say
	 *   that pass ran; `redrawInMs` is non-null when landed bitmaps were left
	 *   for a later frame. `detail` counts what the frame shows that is not
	 *   final -- { sceneStandIns, scenesMissing, decalTilesMissing } -- and
	 *   `complete` is true only when there is none and nothing is in flight:
	 *   the frame will not change until the camera does.
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
		this.sceneUploadsPending = false;
		this.missingSceneWorlds = 0;
		if (view.scenes !== false && w.scenes) {
			scenes = this.drawScenes(view, worlds, pw, pwVertical, detailZoom);
			lap('scenesGL');
			view.onPass?.('scenesGL');
		}
		// Above the scenes: a tile carries the stamps of the terrain and of every
		// scene painted over it (edge_decal_layer.js).
		let edgeDecals = false;
		if ((view.edgeDecals ?? appSettings.edgeDecals) && engineTerrain && view.terrain !== false) {
			edgeDecals = drawEdgeDecals(terrain, this.decals, w, { ...view, pw, pwVertical }, this.frame);
			lap('edgeDecals');
			view.onPass?.('edgeDecals');
		}
		this.timings.frame = t;
		// What this frame shows that is not final: it will change again with the
		// camera where it is. The frame log counts frames like this as misses.
		const detail = {
			sceneStandIns: scenes ? this.scenes.standIns : 0,
			scenesMissing: (scenes ? this.scenes.missing : 0) + this.missingSceneWorlds,
			decalTilesMissing: edgeDecals ? this.decals.missingInView : 0,
		};
		if (!view.offscreen) frameSlo.detail(detail);
		return {
			canvas,
			terrain: view.terrain !== false,
			scenes,
			edgeDecals,
			worlds,
			redrawInMs: this.redrawInMs,
			detail,
			complete: this.pending().total === 0 && !detail.sceneStandIns && !detail.scenesMissing && !detail.decalTilesMissing,
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
		if (drawn) {
			this.redrawInMs = this.scenes.redrawInMs;
			this.sceneUploadsPending = this.scenes.uploadsPending;
		}
		return drawn;
	}

	/**
	 * What the last frame wanted and did not have yet. A view is complete when
	 * `total` is 0: every scene bitmap in view has been built and uploaded,
	 * every world in view has its placement list, and no decal tile is in flight.
	 */
	pending() {
		const sceneBitmaps = pendingPixelSceneBitmaps();
		// Not `redrawInMs`: that also asks for the idle frames that bring in the
		// material maps of scenes out of view, which no frame is waiting for.
		const sceneUploads = this.sceneUploadsPending ? 1 : 0;
		const sceneWorlds = this.missingSceneWorlds || 0;
		const edgeDecalTiles = pendingEdgeDecalTiles();
		return {
			sceneBitmaps, sceneUploads, sceneWorlds, edgeDecalTiles,
			total: sceneBitmaps + sceneUploads + sceneWorlds + edgeDecalTiles,
		};
	}

	/** Frees the terrain resources; the next frame rebuilds them. */
	invalidate() {
		this.terrain.invalidate();
	}

	/** Frees everything, including the scene atlas pages. */
	dispose() {
		this.scenes.dropAll();
		this.decals.dropAll();
		this.terrain.dispose();
		this.world = null;
	}
}

// Under Render Everything the full-res textured instances of a whole overview
// do not fit the default budget (pixel_scene_generation.js sceneBitmapBudgetBytes).
function defaultSceneBudgetBytes() {
	const budgetMB = appSettings.renderEverything
		? Math.max(appSettings.pixelSceneBitmapBudgetMB || 1024, 2048) : (appSettings.pixelSceneBitmapBudgetMB || 1024);
	return budgetMB * 1024 * 1024;
}
