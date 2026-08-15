// overlay_worker.js
import { injectPixelSceneData, PIXEL_SCENE_DATA, pixelSceneMaterialGrid, recolorPixelScene, recolorPixelSceneForBiome } from './pixel_scene_generation.js';
import * as bandSelect from './engine_resolve/band_select.js';
import { createTileOverlaysCheap, createTileOverlays, createTileOverlaysExpanded } from './image_processing.js';
import { appSettings, updateSettings } from './settings.js';
import { CHUNK_SIZE } from './constants.js';
import { EDGE_DECAL_TILE } from './edge_decal_layer.js';
import { EDGE_DECAL_HALO, initEdgeDecalAtlas, stampEdgeDecals } from './edge_decals.js';
import { createMaterialField, resolveMaterialRect } from './engine_resolve/material_field.js';
import { GENERATOR_CONFIG } from './generator_config.js';
import { getWorldSize } from './utils.js';

let workerBiomeData = null;
let workerTileLayers = null;
let workerRecolorBuffers = null;

self.onmessage = async function(e) {
	const data = e.data;

	if (data.cmd === 'SYNC_METADATA') {
		injectPixelSceneData(data.pixelSceneCache);
		workerBiomeData = data.biomeData;
		workerTileLayers = data.tileLayers;
		workerRecolorBuffers = data.recolorBuffers;
	}
	else if (data.cmd === 'SYNC_SETTINGS') {
		updateSettings(data.settings);
		// Unlocks not needed here, hopefully
		return; 
	}
	else if (data.cmd === 'GENERATE_PIXEL_SCENES') {
		generatePixelSceneImagesWorker(data.pixelSceneKeys, data.variantKeys);
	}
	else if (data.cmd === 'GENERATE_OVERLAY') {
		generateOverlayWorker(data.seed, data.ngPlusCount, data.pw, data.pwVertical, data.gameMode);
	}
	else if (data.cmd === 'GENERATE_EDGE_DECAL_TILE') {
		await generateEdgeDecalTileWorker(data);
	}
};

// ---------------------------------------------------------------------------
// Edge decals
//
// One world-space RGBA tile per request. The per-pixel material field the stamp
// reads is a pure function of the world, so it is built once per seed and kept;
// the 1/10 coverage lattice inside it is the only expensive part (~0.2 s).
// ---------------------------------------------------------------------------
let decalField = null;
let decalFieldKey = null;
// A scene's material grid is a pure function of (scene, variant, position), and
// neighbouring tiles keep asking for the same scenes, so keep a bounded cache.
const sceneGridCache = new Map();
const SCENE_GRID_CACHE_MAX = 128;

function sceneGridFor(scene) {
	const key = `${scene.key}/${scene.variantKey || ''}@${scene.x},${scene.y}`;
	let grid = sceneGridCache.get(key);
	if (grid === undefined) {
		grid = pixelSceneMaterialGrid(scene, bandSelect);
		if (sceneGridCache.size >= SCENE_GRID_CACHE_MAX) {
			sceneGridCache.delete(sceneGridCache.keys().next().value);
		}
		sceneGridCache.set(key, grid);
	}
	return grid;
}

async function generateEdgeDecalTileWorker(msg) {
	const { worldKey, tx, ty, seed, ngPlusCount, gameMode, scenes } = msg;
	let bitmap = null;
	if (workerTileLayers && workerBiomeData) {
		await initEdgeDecalAtlas();
		if (decalFieldKey !== worldKey) {
			const mapWidth = getWorldSize(ngPlusCount > 0, gameMode);
			decalField = createMaterialField(workerTileLayers, workerBiomeData,
				GENERATOR_CONFIG, mapWidth, seed);
			decalFieldKey = worldKey;
			sceneGridCache.clear();
		}
		const P = EDGE_DECAL_HALO;
		const size = EDGE_DECAL_TILE + 2 * P;
		const x0 = tx * EDGE_DECAL_TILE - P;
		const y0 = ty * EDGE_DECAL_TILE - P;
		const mat = resolveMaterialRect(decalField, x0, y0, size, size);
		// Chunk boundaries sit where (world + grid shift) is a multiple of 512;
		// both shifts are whole chunks for every shipped map width, but the stamp
		// clips to its own chunk so pass it rather than assume.
		const mapWidth = getWorldSize(ngPlusCount > 0, gameMode);
		const sceneGrids = (scenes || []).map(sceneGridFor).filter(Boolean);
		const stats = {};
		const rgba = stampEdgeDecals(mat, size, size, x0, y0, seed, {
			chunkShiftX: (mapWidth * 256) % CHUNK_SIZE,
			chunkShiftY: (14 * CHUNK_SIZE) % CHUNK_SIZE,
			// The scenes overlapping this tile, in paint order: each one runs the
			// engine's scene-time decal pass on top of the terrain passes.
			scenes: sceneGrids,
			// The biome map gates the seam band per chunk: a biome whose
			// <Topology> sets skip_edge_textures dresses its interior only.
			biomeData: workerBiomeData,
			mapWidth,
			stats,
		});
		var decalDebug = { scenesSent: (scenes || []).length, gridsBuilt: sceneGrids.length, ...stats };

		const T = EDGE_DECAL_TILE;
		const cropped = new Uint8ClampedArray(T * T * 4);
		for (let row = 0; row < T; row++) {
			const src = ((row + P) * size + P) * 4;
			cropped.set(rgba.subarray(src, src + T * 4), row * T * 4);
		}
		const canvas = new OffscreenCanvas(T, T);
		canvas.getContext('2d').putImageData(new ImageData(cropped, T, T), 0, 0);
		bitmap = canvas.transferToImageBitmap();
	}

	self.postMessage({
		type: 'EDGE_DECAL_TILE',
		worldKey, tx, ty, bitmap,
		debug: typeof decalDebug !== 'undefined' ? decalDebug : null,
	}, bitmap ? [bitmap] : []);
}

function generatePixelSceneImagesWorker(pixelSceneKeys, variantKeys) {
	let outputPixelSceneKeys = [];
	let outputVariantKeys = [];
	let arraybuffers = [];

	for (let i = 0; i < pixelSceneKeys.length; i++) {
		const pixelSceneKey = pixelSceneKeys[i];
		const variantKey = variantKeys[i];
		const pixelSceneData = PIXEL_SCENE_DATA[pixelSceneKey];
		// Split variant key to recolor in parts
		const variantParts = variantKey.split('&');
		let recoloredPixelScene = pixelSceneData.imgElement;
		let currentVariantKey = '';
		for (const part of variantParts) {
			const variantSides = part.split('=');
			if (variantSides[0] === 'biome') {
				// Biome recolor
				recoloredPixelScene = recolorPixelSceneForBiome(PIXEL_SCENE_DATA[pixelSceneKey].name, recoloredPixelScene, variantSides[1]);
			}
			else {
				// Material recolor
				recoloredPixelScene = recolorPixelScene(recoloredPixelScene, parseInt(variantSides[0], 16), parseInt(variantSides[1], 16));
			}
			currentVariantKey += (currentVariantKey !== '' ? '&' : '') + part;
			outputPixelSceneKeys.push(pixelSceneKey);
			outputVariantKeys.push(currentVariantKey);
			arraybuffers.push(recoloredPixelScene);
		}
	}

	self.postMessage({
		type: 'PIXEL_SCENES_GENERATED',
		pixelSceneKeys: outputPixelSceneKeys,
		variantKeys: outputVariantKeys,
		pixelSceneImages: arraybuffers
	});
}

function generateOverlayWorker(seed, ngPlusCount, pw, pwVertical, gameMode) {
	const biomeOverlayMode = appSettings.biomeOverlayMode;
	const isNGP = ngPlusCount > 0;
	let canvases;

	if (biomeOverlayMode === 'normal' || biomeOverlayMode === 'expanded') {
		const recolorBuffer = pwVertical < 0
			? workerRecolorBuffers?.heaven
			: pwVertical > 0
				? workerRecolorBuffers?.hell
				: workerRecolorBuffers?.normal;

		// Metadata is synchronized before overlay requests. Fall back to the cheap
		// path only if a request races before its RGB recolor data arrives.
		if (recolorBuffer) {
			canvases = biomeOverlayMode === 'expanded'
				? createTileOverlaysExpanded(workerBiomeData, recolorBuffer, workerTileLayers, pw, pwVertical, isNGP, gameMode)
				: createTileOverlays(workerBiomeData, recolorBuffer, workerTileLayers, pw, pwVertical, isNGP, gameMode);
		}
	}

	if (!canvases) {
		canvases = createTileOverlaysCheap(workerBiomeData, workerTileLayers, pw, pwVertical, isNGP, gameMode);
	}


	// Extract the rendered pixels from each canvas into a transferable ImageBitmap
	const bitmaps = [];
	if (canvases && canvases.length > 0) {
		bitmaps.push(...canvases.map(canvas => canvas.transferToImageBitmap()));
	}

	self.postMessage({
		type: 'OVERLAY_GENERATED',
		seed: seed,
		ngPlusCount: ngPlusCount,
		pw: pw,
		pwVertical: pwVertical,
		gameMode: gameMode,
		biomeOverlayMode: biomeOverlayMode,
		overlays: bitmaps
	}, bitmaps);
}

// Reference for later
/*
const biomeOverlayMode = document.getElementById('debug-biome-overlay-mode').value;
if (biomeOverlayMode !== 'none') {
if (!this.tileOverlaysByPW[`${pwX},${pwY}`]) {
	// Major timesave in NG, we can reuse the same overlay...
	if (!this.isNGP) {
		if (this.tileOverlaysByPW[`0,${pwY}`]) {
			this.tileOverlaysByPW[`${pwX},${pwY}`] = this.tileOverlaysByPW[`0,${pwY}`];
		}
	}
	if (!this.tileOverlaysByPW[`${pwX},${pwY}`]) {
		// Generate it now (this seems like a bad idea since it will hang)
		// Use different recolor map for vertical PWs
		let recolorMapUsed = this.recolorOffscreenBuffer;
		if (pwY < 0) {
			recolorMapUsed = this.recolorOffscreenHeavenBuffer;
		}
		else if (pwY > 0) {
			recolorMapUsed = this.recolorOffscreenHellBuffer;
		}
		if (biomeOverlayMode === 'expanded') {
			this.tileOverlaysByPW[`${pwX},${pwY}`] = createTileOverlaysExpanded(this.biomeData, recolorMapUsed, this.tileLayers, pwX, pwY, this.isNGP);
		}
		else if (biomeOverlayMode === 'normal') {
			this.tileOverlaysByPW[`${pwX},${pwY}`] = createTileOverlays(this.biomeData, recolorMapUsed, this.tileLayers, pwX, pwY, this.isNGP);
		}
		else {
			this.tileOverlaysByPW[`${pwX},${pwY}`] = createTileOverlaysCheap(this.biomeData, this.tileLayers, pwX, pwY, this.isNGP);
		}
	}
}
*/
