import { NollaPrng } from './nolla_prng.js';
import { BLOCKED_COLORS, GENERAL_SCENES, PIXEL_SCENE_BIOME_MAP } from './pixel_scene_config.js';
import { MATERIAL_COLOR_CONVERSION, MATERIAL_WANG_COLORS } from './potion_config.js';
import { getBiomeAtWorldCoordinates } from './utils.js';
import { biomeEdgeNoiseFlag } from './wobble_flags.js';
import { loadPNG } from './png_sanitizer.js';
import { prescanPixelScene } from './poi_scanner.js';
import { BIOME_BACKGROUND_COLORS, TILE_OVERLAY_COLORS, channelDistance, makeBlackTransparent, terrainFillColorForBiome } from './image_processing.js';
import { GENERATOR_CONFIG } from './generator_config.js';
import { appSettings } from './settings.js';

// This was originally constant but it sometimes needs to be cleared to regenerate the cache...
export let PIXEL_SCENE_DATA = {};
export let PIXEL_SCENE_SPAWN_DATA = {}; // Populated during the prescan of pixel scenes, keyed by biome and scene name, used for looking up spawn points during generation without needing to access the image data again
// ---------------------------------------------------------------------------
// Pixel scene bitmap cache (PERF_PLAN Step 1)
//
// Each recolored variant is uploaded once as an ImageBitmap plus a mip chain
// (1/2 .. 1/16). The draw site picks a level from the camera zoom, so a zoomed-out
// frame blits a handful of pixels per scene instead of a full-resolution image, which
// is what made drawing them at low zoom expensive enough to gate off entirely.
//
// The raw recolored Uint8Array is released once its bitmap exists (the overlay worker
// recolors from the untouched base image, so any variant can be produced again). Entries
// are evicted least-recently-drawn first over a byte budget; an evicted variant is
// re-requested from the overlay worker through the rebuild hook below.
// ---------------------------------------------------------------------------
const PIXEL_SCENE_MAX_MIP = 4; // 1/2, 1/4, 1/8, 1/16
const PIXEL_SCENE_BITMAP_CACHE = new Map(); // `${key}/${variantKey}` -> entry
let pixelSceneCacheBytes = 0;
let pixelSceneDrawTick = 0;

// Left in place of a released Uint8Array so the "do we already have this variant?" checks
// in overlay_manager / world_manager don't re-request it while its bitmap is still alive.
const VARIANT_RELEASED = { released: true };

let variantRebuilder = null;

// overlay_manager registers the way back to the worker here (importing it directly would
// be circular).
export function setPixelSceneVariantRebuilder(fn) {
	variantRebuilder = fn;
}

export function getPixelSceneCacheStats() {
	return { entries: PIXEL_SCENE_BITMAP_CACHE.size, bytes: pixelSceneCacheBytes };
}

function releasePixelSceneEntry(entry) {
	for (const bitmap of entry.levels) {
		if (bitmap) bitmap.close();
	}
	pixelSceneCacheBytes -= entry.bytes;
	PIXEL_SCENE_BITMAP_CACHE.delete(entry.cacheKey);
}

export function clearPixelSceneBitmapCache() {
	for (const entry of [...PIXEL_SCENE_BITMAP_CACHE.values()]) releasePixelSceneEntry(entry);
	pixelSceneCacheBytes = 0;
}

function evictPixelSceneBitmaps(keep) {
	const budget = (appSettings.pixelSceneBitmapBudgetMB || 256) * 1024 * 1024;
	if (pixelSceneCacheBytes <= budget) return;
	const entries = [...PIXEL_SCENE_BITMAP_CACHE.values()].sort((a, b) => a.used - b.used);
	for (const entry of entries) {
		if (pixelSceneCacheBytes <= budget) break;
		if (entry === keep) continue; // never drop the one we are about to draw
		releasePixelSceneEntry(entry);
	}
}

function addPixelSceneBitmap(entry, level, bitmap) {
	const bytes = bitmap.width * bitmap.height * 4;
	entry.levels[level] = bitmap;
	entry.bytes += bytes;
	pixelSceneCacheBytes += bytes;
}

function buildPixelSceneEntry(pixelSceneKey, variantKey, cacheKey) {
	const pixelSceneData = PIXEL_SCENE_DATA[pixelSceneKey];
	if (!pixelSceneData) return null;
	const raw = pixelSceneData.variants[variantKey];
	if (!ArrayBuffer.isView(raw)) {
		// Released after its bitmap was built and the bitmap has since been evicted, so
		// ask for the recolor again. Nothing to draw for this scene until it arrives.
		if (raw === VARIANT_RELEASED && variantRebuilder) variantRebuilder(pixelSceneKey, variantKey);
		return null;
	}
	const width = pixelSceneData.width;
	const height = pixelSceneData.height;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	const imageData = ctx.createImageData(width, height);
	imageData.data.set(raw);
	ctx.putImageData(imageData, 0, 0);
	const entry = {
		cacheKey,
		width,
		height,
		levels: new Array(PIXEL_SCENE_MAX_MIP + 1).fill(null),
		// Halving stops once either axis would round to nothing
		maxLevel: Math.min(PIXEL_SCENE_MAX_MIP, Math.floor(Math.log2(Math.max(1, Math.min(width, height))))),
		bytes: 0,
		used: 0,
	};
	addPixelSceneBitmap(entry, 0, canvas.transferToImageBitmap());
	PIXEL_SCENE_BITMAP_CACHE.set(cacheKey, entry);
	// The bitmap is now the only copy this thread needs of the recolored pixels. Material
	// lookups (utils.js) read the pre-biome variants, which are left alone.
	if (variantKey.includes('biome=')) pixelSceneData.variants[variantKey] = VARIANT_RELEASED;
	return entry;
}

function readBitmapPixels(bitmap) {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext('2d');
	ctx.drawImage(bitmap, 0, 0);
	return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

// Halve an image the way a cutout sprite wants to be halved: point sampling, but never
// losing coverage.
//
// Scene alpha is binary - a pixel is either painted material or air - and the seam
// between a scene and whatever it sits on is often one pixel thin. Averaging the 2x2
// block (a box filter) turns that seam into partial alpha, so the dark world behind
// shows through as a hairline crack along the scene edge; plain point sampling drops the
// seam outright and opens the same crack, wider. So the output takes the point sample
// (the block's lower-right pixel, which is what a nearest-neighbour downscale picks) and
// falls back to whichever of the other three is painted when that one is air. Painted
// area can only grow, never perforate, and alpha stays binary all the way down.
function halveWithoutHoles(img) {
	const sw = img.width, sh = img.height, s = img.data;
	// Round up, so an odd-sized level keeps its last row/column instead of dropping it -
	// that trailing row is exactly the kind of one-pixel edge this reduction exists to keep.
	const w = Math.max(1, Math.ceil(sw / 2)), h = Math.max(1, Math.ceil(sh / 2));
	const out = new ImageData(w, h);
	const d = out.data;
	for (let y = 0; y < h; y++) {
		const rowLo = Math.min(y * 2 + 1, sh - 1) * sw;
		const rowHi = y * 2 * sw;
		for (let x = 0; x < w; x++) {
			const colLo = Math.min(x * 2 + 1, sw - 1);
			const colHi = x * 2;
			let p = (rowLo + colLo) * 4;
			if (s[p + 3] !== 255) {
				const b = (rowLo + colHi) * 4, c = (rowHi + colLo) * 4, e = (rowHi + colHi) * 4;
				if (s[b + 3] > s[p + 3]) p = b;
				if (s[c + 3] > s[p + 3]) p = c;
				if (s[e + 3] > s[p + 3]) p = e;
			}
			const o = (y * w + x) * 4;
			d[o] = s[p]; d[o + 1] = s[p + 1]; d[o + 2] = s[p + 2]; d[o + 3] = s[p + 3];
		}
	}
	return out;
}

function buildPixelSceneMips(entry, level) {
	// Each level is reduced from the one above it rather than resampled from the base,
	// which is both cheaper and closer to a proper mip chain. Levels are always built in
	// order, so the first missing one has its parent already in the cache; its pixels are
	// read back once and the rest of the chain is reduced from that copy.
	let first = 1;
	while (first <= level && entry.levels[first]) first++;
	if (first > level) return entry.levels[level];
	let pixels = readBitmapPixels(entry.levels[first - 1]);
	for (let l = first; l <= level; l++) {
		pixels = halveWithoutHoles(pixels);
		const canvas = new OffscreenCanvas(pixels.width, pixels.height);
		canvas.getContext('2d').putImageData(pixels, 0, 0);
		addPixelSceneBitmap(entry, l, canvas.transferToImageBitmap());
	}
	return entry.levels[level];
}

// Largest mip whose resolution still meets the on-screen resolution: at camera zoom z one
// world pixel covers z screen pixels, so a 1/2^L bitmap is enough while 2^-L >= z.
// Anything at or above 1:1 draws the native image, exactly as before.
export function pixelSceneMipLevel(z) {
	if (!(z > 0) || z >= 1) return 0;
	const level = Math.floor(Math.log2(1 / z));
	return level > PIXEL_SCENE_MAX_MIP ? PIXEL_SCENE_MAX_MIP : level;
}

export function injectPixelSceneSpawnData(cachedData) {
	PIXEL_SCENE_SPAWN_DATA = cachedData;
}

export function injectPixelSceneData(cachedData) {
    PIXEL_SCENE_DATA = cachedData;
}

// How close a biome's background color may sit to its fill color before air
// painted with it would be indistinguishable from the surrounding solid rock,
// and how far to darken the fill when that happens.
const AIR_OVER_FILL_TOLERANCE = 24;
const AIR_OVER_FILL_DARKEN = 0.45;

const SCENES_TO_NOT_RECOLOR = ["wand_altar", "wand_altar_vault", "potion_altar", "potion_altar_vault"]; // It would be a waste to recolor these for every biome
const PIXEL_SCENE_AIR_TRANSPARENCY_EXCEPTIONS = {
	"the_end_shop": 0xff,
	"cavern": 0xff,
	"friendroom": 0xff,
	"eyespot": 0xff,
	"altar_snowcastle_capsule": 0xff,
	"altar_vault_capsule": 0xff,
	"altar_snowcave_capsule": 0xff,
	// These two look good when solid if there isn't custom art, but bad if there is. Not really sure what the best option is
	//"altar_top": 0xff,
	//"altar_top_ending": 0xff,
	"tower_start": 0xff,
	"solid_wall_hidden_cavern": 0xff,
	"watercave_layout_1": 0xff,
	"watercave_layout_2": 0xff,
	"watercave_layout_3": 0xff,
	"watercave_layout_4": 0xff,
	"watercave_layout_5": 0xff,
	// Otherwise assume transparent?
}

export async function reloadPixelSceneCache() {
	clearPixelSceneBitmapCache();
	PIXEL_SCENE_DATA = {};
	await loadPixelSceneData();
}

// Returns the bitmap to draw for this scene at the requested mip level (0 = native), or
// null when its recolored pixels aren't available yet. The caller always draws it into
// the scene's full-resolution world rectangle, so the level only changes sampling.
export function getPixelSceneCanvas(pixelScene, level = 0) {
	const pixelSceneKey = pixelScene.key;
	const variantKey = pixelScene.variantKey || '';
	const cacheKey = `${pixelSceneKey}/${variantKey}`;
	let entry = PIXEL_SCENE_BITMAP_CACHE.get(cacheKey);
	if (!entry) {
		entry = buildPixelSceneEntry(pixelSceneKey, variantKey, cacheKey);
		if (!entry) return null;
	}
	entry.used = ++pixelSceneDrawTick;
	const wanted = level > entry.maxLevel ? entry.maxLevel : level;
	const bitmap = entry.levels[wanted] || buildPixelSceneMips(entry, wanted);
	evictPixelSceneBitmaps(entry);
	return bitmap;
}

function getBiomeAlias(biomeName) {
	// Aliases to avoid needing to duplicate files for repeated biomes
	if (biomeName === "coalmine_alt") return "coalmine";
	if (biomeName === "excavationsite_cube_chamber") return "excavationsite";
	if (biomeName === "snowcave_secret_chamber") return "snowcave";
	if (biomeName === "sandcave" || biomeName === "snowcastle_cavern" || biomeName === "snowcastle_hourglass_chamber") return "snowcastle";
	if (biomeName === "rainforest_open" || biomeName === "rainforest_dark") return "rainforest";
	if (biomeName === "vault_frozen") return "vault";
	if (biomeName === "the_end" || biomeName === "the_sky") return "crypt";
	if (biomeName === "scale") return "overworld";
	if (biomeName.includes("temple")) return "temple";
	if (biomeName.includes("pyramid")) return "pyramid";
	if (biomeName.includes("mountain")) return "mountain";
	return biomeName;
}

function getPixelSceneVariant(pixelSceneKey, variantKey) {
	if (variantKey === '') return PIXEL_SCENE_DATA[pixelSceneKey].imgElement;
	if (PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey]) return PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey];
	console.log(`No variant found for pixel scene key ${pixelSceneKey} with variant key ${variantKey}?`);
	return null;
}

//const GENERAL_SCENES = ["wand_altar", "wand_altar_vault", "potion_altar", "potion_altar_vault"]; // These scenes are used in multiple biomes, so we can check for them first before doing the biome-specific lookup
const GENERAL_SCENE_NAMES = GENERAL_SCENES["extras"].map(scene => scene.name);

// Don't use the alias here because spawn points can have different indices per "duplicate" biome, so we need to keep them separate in the data
function getPixelSceneKey(biomeName, sceneName) {
	if (biomeName.includes("temple")) return "temple/" + sceneName;
	if (biomeName.includes("pyramid")) return "pyramid/" + sceneName;
	if (biomeName.includes("mountain")) return "mountain/" + sceneName;
	if (!biomeName || GENERAL_SCENE_NAMES.includes(sceneName) || !GENERATOR_CONFIG[biomeName]) return "general/" + sceneName;
	return biomeName + "/" + sceneName;
}

export async function loadPixelSceneData() {
	// Load key value pairs for all pixel scenes
	let loaded = 0;
	for (const biome of Object.keys(PIXEL_SCENE_BIOME_MAP)) {
		const biomeScenes = PIXEL_SCENE_BIOME_MAP[biome];
		for (const sceneList of Object.values(biomeScenes)) {
			for (const scene of sceneList) {
				if (scene.name === "") continue; // Skip the "no scene" option
				const key = getPixelSceneKey(biome, scene.name);
				if (!PIXEL_SCENE_DATA[key]) {
					const url = `../data/pixel_scenes/${getBiomeAlias(biome)}/${scene.name}.png`;
					const imgData = await loadPNG(url);
					makeBlackTransparent(imgData.data);
					// Prescan the pixel scene for spawn points and store them in a global lookup for later use during generation, keyed by biome and scene name
					const spawnPoints = prescanPixelScene(imgData, biome);
					PIXEL_SCENE_SPAWN_DATA[key] = spawnPoints;
					//console.log(`Loaded pixel scene ${key} with ${spawnPoints.length} spawn points.`);
					PIXEL_SCENE_DATA[key] = {
						key: key,
						biome: biome,
						name: scene.name,
						imgElement: imgData.data, // Store the image data directly since we need to manipulate it for recoloring
						width: imgData.width,
						height: imgData.height,
						//spawnPoints: spawnPoints,
						isCosmetic: spawnPoints.length === 0, // If there are no spawn points, we can consider it purely cosmetic and can optionally skip some checks during generation
						// Which recolor classes this scene actually contains, so it only
						// pays for a per-chunk variant when one of them depends on the
						// chunk it lands in (underlyingBiomeSuffix).
						...classifyPixelSceneColors(imgData.data),
						variants: {}, // Used for color material changes, keyed as `${color}=${material}`
					};
					loaded++;
				}
			}
		}
	}
	console.log(`Loaded ${loaded} pixel scenes.`);
}

// This function scans the pixel scene image for blocked room colors, and returns an array of room objects with their coordinates and colors
export function blockOutRooms(pixels, width, height) {
	let rooms = [];
	for (let y = 4; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 3;
			const color = (pixels[idx] << 16) | (pixels[idx+1] << 8) | pixels[idx+2];
			if (color === 0x000000 || color === 0xffffff) continue;
			if (!BLOCKED_COLORS.includes(color)) continue;

			let startX = x+1;
			let startY = y+1;
			let endX = x+1;
			let endY = y+1;
			let foundEnd = false;
			while (!foundEnd && endX < width) {
				if (endX >= width) break;
				const tempIdx = (startY * width + endX) * 3;
				const tempColor = (pixels[tempIdx] << 16) | (pixels[tempIdx+1] << 8) | pixels[tempIdx+2];
				if (tempColor === 0x000000 || tempColor === 0x323232) {
					endX++;
					continue;
				}
				endX--;
				foundEnd = true;
			}
			if (endX >= width) endX = width - 1;
			foundEnd = false;
			while (!foundEnd && endY < height) {
				if (endY >= height) break;
				const tempIdx = (endY * width + startX) * 3;
				const tempColor = (pixels[tempIdx] << 16) | (pixels[tempIdx+1] << 8) | pixels[tempIdx+2];
				if (tempColor === 0x000000 || tempColor === 0x323232) {
					endY++;
					continue;
				}
				endY--;
				foundEnd = true;
			}
			if (endY >= height) endY = height - 1;

			if (endX > startX && endY > startY) {
				//console.log(`Blocking out room from (${startX}, ${startY}) to (${endX}, ${endY})`);

				// Block out the room with pixels to block pathfinding
				for (let by = startY; by <= endY; by++) {
					for (let bx = startX; bx <= endX; bx++) {
						const bIdx = (by * width + bx) * 3;
						// Magenta for debug
						pixels[bIdx] = 0xff;
						pixels[bIdx + 1] = 0x01;
						pixels[bIdx + 2] = 0xff;
					}
				}
			}

			rooms.push({color, startX, startY, endX, endY});
		}
	}
	return rooms;
}

const CHECK_PIXEL_SCENE_BIOME = true;

// Trailer altar example for validating that the bounds check is working correctly:
// Seed: 119164939, NG+1
// Appears in PW 0, disappears in PW -1, second one appears in PW 9

// TODO: Refactoring pixel scenes to not do the image manipulation here at all
// Instead do it in the overlay worker when generating for display
// Minimize the amount of information returned to keep the worker messages lightweight

export function loadPixelScene(biomeData, biomeName, sceneName, ws, ng, x, y, skipCosmeticScenes = true, checkBounds = true, gameMode = 'normal') {
	const pixelSceneKey = getPixelSceneKey(biomeName, sceneName);
	if (!PIXEL_SCENE_DATA[pixelSceneKey]) {
		console.warn(`Pixel scene data not found for key ${pixelSceneKey}. This should not happen because we preload all pixel scene images.`);
		return null;
	}
	const pixelSceneData = PIXEL_SCENE_DATA[pixelSceneKey];
	if (pixelSceneData.isCosmetic && skipCosmeticScenes) {
		// If the scene is purely cosmetic and we're skipping cosmetic scenes, skip it
		return null;
	}
	// checkBounds matches the skip_biome_checks parameter and only checks the top-left corner, while randomly placed pixel scenes check all corners
	if (checkBounds && biomeName && CHECK_PIXEL_SCENE_BIOME) {
		const topLeft = getBiomeAtWorldCoordinates(biomeData, x, y, ng > 0, gameMode);
		// Check wobbled biome based on edge noise
		if (!topLeft.biome && biomeEdgeNoiseFlag(topLeft.colorInt, 'noise_biome_edges') === null) {
			// This does not appear to ever trigger?
			console.log(`Rejected spawn for pixel scene ${sceneName} at (${x}, ${y}) with unknown biome color ${topLeft.colorInt.toString(16)} in original biome ${biomeName}. This likely means the biome map is missing colors from the data.wak unpack, such as NG+ palette swaps. Accepting spawn but returning null biome so it can be recolored without a biome-specific variant.`);
			return null;
		}
		// Unsure about this, but it would make sense... Seems to help
		if (topLeft.biome !== biomeName) {
			//console.log(`Rejected spawn for pixel scene ${sceneName} at (${x}, ${y}) in biome ${biomeName} because top-left corner is in biome ${topLeft.biome}.`);
			return null;
		}
	}
	// Recolor the pixel scene for the biome if needed
	if (!biomeName || biomeName === "general") {
		// Better fallback
		if (SCENES_TO_NOT_RECOLOR.includes(sceneName)) {
			biomeName = "general";
		} else {
			biomeName = getBiomeAtWorldCoordinates(biomeData, x + pixelSceneData.width/2, y + pixelSceneData.height/2, ng > 0, gameMode, true)?.biome || "general";
		}
	}
	// Exception to the exception because it's in two different biomes which need to be recolored differently
	// There are a few other pixel scenes which could follow this pattern, but they're drawn in the custom art already
	if (sceneName !== "the_end_shop" && GENERAL_SCENE_NAMES.includes(sceneName)) {
		biomeName = "general";
	}
	// Alternative?
	/*
	if (SCENES_TO_NOT_RECOLOR.includes(sceneName)) {
		biomeName = "general";
	}
	else if (!biomeName || biomeName === "general") {
		biomeName = getBiomeAtWorldCoordinates(biomeData, x + pixelSceneData.width/2, y + pixelSceneData.height/2, ng > 0, gameMode)?.biome || "general";
	}
	*/
	const variantKey = `biome=${biomeName}${underlyingBiomeSuffix(biomeData, pixelSceneData, biomeName, sceneName, x, y, ng, gameMode)}`;
	/*
	if (!PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey]) {
		PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey] = recolorPixelSceneForBiome(sceneName, getPixelSceneVariant(pixelSceneKey, ''), PIXEL_SCENE_DATA[pixelSceneKey].width, PIXEL_SCENE_DATA[pixelSceneKey].height, biomeName, x, y);
		//console.log(`Created biome variant of pixel scene ${pixelSceneKey} with key ${variantKey}`);
	}
	*/
	//const pixelSceneImage = PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey];
	//console.log(`Loaded pixel scene ${sceneName} for biome ${biomeName} at (${x}, ${y}) with keys ${pixelSceneKey} / ${variantKey}`);
	return {
		key: pixelSceneKey,
		variantKey: variantKey,
		name: sceneName,
		//imgElement: pixelSceneImage,
		width: pixelSceneData.width,
		height: pixelSceneData.height,
		x: x,
		y: y,
		//spawnPoints: pixelSceneData.spawnPoints,
		material: null,
		type: 'pixel_scene'
	};
}

export function loadRandomPixelScene(biomeData, biomeName, scene_list, ws, ng, x, y, skipCosmeticScenes = true, gameMode = 'normal') {
	if (!scene_list || scene_list.length === 0) return null;
	const prng = new NollaPrng(0);
	let total_prob = 0;
	for (const scene of scene_list) {
		total_prob += scene.prob;
	}
	let r = prng.ProceduralRandom(ws + ng, x, y) * total_prob;
	for (const scene of scene_list) {
		if (scene.prob <= 0) continue;
		if (r <= scene.prob) {
			if (scene.name === "") return null; // Rolled for no scene
			const pixelSceneKey = getPixelSceneKey(biomeName, scene.name);
			if (!PIXEL_SCENE_DATA[pixelSceneKey]) {
				console.warn(`Pixel scene data not found for key ${pixelSceneKey}. This should not happen because we preload all pixel scene images.`);
				return null;
			}
			const pixelSceneData = PIXEL_SCENE_DATA[pixelSceneKey];
			if (pixelSceneData.isCosmetic && skipCosmeticScenes) {
				// If the scene is purely cosmetic and we're skipping cosmetic scenes, skip it
				return null;
			}
			let outputScene = {
				key: pixelSceneKey,
				name: scene.name, 
				//imgElement: pixelSceneData.imgElement,
				width: pixelSceneData.width,
				height: pixelSceneData.height,
				x: x, 
				y: y, 
				material: null,
				//spawnPoints: pixelSceneData.spawnPoints,
				type: 'pixel_scene'
			};
			// Check all four corners to make sure they are in the same biome
			if (CHECK_PIXEL_SCENE_BIOME) {
				const w = pixelSceneData.width;
				const h = pixelSceneData.height;
				const corners = [
					[x, y],
					[x + w, y],
					[x, y + h],
					[x + w, y + h],
				];
				for (const [cx, cy] of corners) {
					const res = getBiomeAtWorldCoordinates(biomeData, cx, cy, ng > 0, gameMode, true);
					// Reject if the corner's wobbled biome is different (including null)
					if (res.biome !== biomeName) {
						return null;
					}
				}
			}
			// Recolor random materials first so material lookups still work
			let variantKey = '';
			if (scene.color_material) {
				// Sort keys to ensure consistent ordering for caching variants
				const sortedColors = Object.keys(scene.color_material).sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
				for (const color of sortedColors) {
					// Start with the recolored variant
					//let pixelSceneImage = getPixelSceneVariant(pixelSceneKey, variantKey);
					const materials = scene.color_material[color];
					prng.SetRandomSeed(ws + ng, x + 11, y - 21); //?
					let r = prng.ProceduralRandom(ws + ng, x + 11, y - 21); // Note ProceduralRandom returns a value in (0, 1] so this is actually fine
					let mr = Math.ceil(r * materials.length) - 1;
					
					const targetMaterial = materials[mr];
					outputScene.material = targetMaterial;
					let materialColor = MATERIAL_WANG_COLORS[materials[mr]];
					// See if the recolored pixel scene is already cached
					//variantKey += (variantKey !== '' ? '&' : '') + `${color}=${targetMaterial}`;
					// Use material color instead to avoid an extra lookup
					variantKey += (variantKey !== '' ? '&' : '') + `${color}=${materialColor}`;
					/*
					if (!PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey]) {
						PIXEL_SCENE_DATA[pixelSceneKey].variants[variantKey] = recolorPixelScene(
							pixelSceneImage, 
							parseInt(color, 16), 
							parseInt(materialColor, 16)
						);
						//console.log(`Created variant of pixel scene ${pixelSceneKey} with key ${variantKey}`);
					}
					*/
				}
			}
			// Recolor the pixel scene for the biome if needed
			const finalVariantKey = variantKey + (variantKey !== '' ? '&' : '')
				+ `biome=${biomeName}${underlyingBiomeSuffix(biomeData, pixelSceneData, biomeName, scene.name, x, y, ng, gameMode)}`;
			/*
			if (!PIXEL_SCENE_DATA[pixelSceneKey].variants[finalVariantKey]) {
				PIXEL_SCENE_DATA[pixelSceneKey].variants[finalVariantKey] = recolorPixelSceneForBiome(scene.name, getPixelSceneVariant(pixelSceneKey, variantKey), biomeName);
				//console.log(`Created biome variant of pixel scene ${pixelSceneKey} with key ${finalVariantKey}`);
			}
			*/
			outputScene.variantKey = finalVariantKey;
			//outputScene.imgElement = PIXEL_SCENE_DATA[pixelSceneKey].variants[finalVariantKey];

			//console.log(`Loaded pixel scene ${scene.name} at (${x}, ${y}) in biome ${biomeName}.`);
			return outputScene;
		}
		r -= scene.prob;
	}
	console.log(`Impossible zero probability outcome for pixel scene at (${x}, ${y}), total prob ${total_prob}, r ${r}: ${JSON.stringify(scene_list)}`);
	return null;
}

/** Does this scene contain air pixels / "fill with the biome's material" pixels? */
function classifyPixelSceneColors(data) {
	let hasAir = false;
	let hasBiomeFill = false;
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i], g = data[i + 1], b = data[i + 2];
		if (r === 0 && g === 0 && b === 0x42) hasAir = true;
		else if (r === g && g === b && r > 0) hasBiomeFill = true;
		if (hasAir && hasBiomeFill) break;
	}
	return { hasAir, hasBiomeFill };
}

/**
 * The `@<biome>` suffix a scene's `biome=` variant key carries when its recolor
 * depends on the chunk it landed in, or '' when it does not.
 *
 * The recolor target is the scene's *folder* biome, which for everything under
 * general/ and temple/ is a pseudo-biome shared across the map. Two things it
 * therefore cannot answer: whether the chunk beneath is solid material, which
 * decides if the scene's air may stay transparent; and what color the scene's
 * "fill with the biome's own material" pixels take, since a pseudo-biome has no
 * entry in either color table -- which is what used to paint the orb room floors
 * magenta. Naming the chunk's biome in the variant key answers both, at one
 * cached variant per underlying biome, and only for scenes that contain the
 * class in question.
 */
function underlyingBiomeSuffix(biomeData, sceneData, biomeName, sceneName, x, y, ng, gameMode) {
	// The altars are deliberately never recolored per biome; keep them at one variant.
	if (SCENES_TO_NOT_RECOLOR.includes(sceneName)) return '';
	const needsFillColor = sceneData.hasBiomeFill && TILE_OVERLAY_COLORS[biomeName] === undefined;
	if (!sceneData.hasAir && !needsFillColor) return '';
	const under = getBiomeAtWorldCoordinates(biomeData, x + sceneData.width / 2, y + sceneData.height / 2, ng > 0, gameMode, true)?.biome;
	if (!under || under === biomeName) return '';
	if (needsFillColor) return `@${under}`;
	return terrainFillColorForBiome(under) === undefined ? '' : `@${under}`;
}

export function recolorPixelSceneForBiome(sceneName, sourceData, targetBiome) {
	//const recolorMaterials = document.getElementById('recolor-materials').checked;
	const recolorMaterials = appSettings.recolorMaterials;

	const outData = new Uint8Array(sourceData.length);
	outData.set(sourceData);

	// Some scene name exceptions because this just isn't working

	// `biome=<folder>@<chunk biome>`: the folder decides the colors, the suffix
	// (underlyingBiomeSuffix) names the biome of the chunk the scene landed in.
	const at = targetBiome.indexOf('@');
	const underlyingBiome = at < 0 ? null : targetBiome.slice(at + 1);
	if (at >= 0) targetBiome = targetBiome.slice(0, at);
	const fillBiomeUnderScene = (underlyingBiome && terrainFillColorForBiome(underlyingBiome) !== undefined)
		? underlyingBiome : null;

	// A scene's gray/white pixels are the engine's "fill with this biome's own
	// material" class, so in a constant-material biome they must come out as that
	// biome's fill color -- the same one the terrain around them paints. Otherwise
	// they take the hand-authored foreground color, which for these biomes equals
	// the background color and leaves the carved room reading as a flat block.
	// The pseudo-biomes (general/, temple/, spliced/) have no entry in either
	// color table, so their scenes' fill pixels used to come out magenta -- most
	// visibly the orb rooms, whose whole floor is that class. Falling back to the
	// biome under the scene answers it exactly: those pixels are "fill with the
	// chunk's own material", which is what the suffix names.
	let targetColor = terrainFillColorForBiome(targetBiome)
		?? TILE_OVERLAY_COLORS[targetBiome]
		?? (underlyingBiome ? terrainFillColorForBiome(underlyingBiome) ?? TILE_OVERLAY_COLORS[underlyingBiome] : undefined)
		?? 0xff00ff;
	let bgColor = BIOME_BACKGROUND_COLORS[targetBiome]
		?? (underlyingBiome ? BIOME_BACKGROUND_COLORS[underlyingBiome] : undefined)
		?? 0x000000;

	// Air over a fill has to punch a visible hole in solid material, so it must
	// not come out the same color as the fill. For friend_1..6 the biome maps
	// give foreground and background the same unauthored pixel, so the "correct"
	// background would erase the room; darken the fill instead, which is roughly
	// what a background reads as next to its own material anyway.
	const fillUnder = terrainFillColorForBiome(fillBiomeUnderScene ?? targetBiome);
	if (fillUnder !== undefined && channelDistance(bgColor, fillUnder) <= AIR_OVER_FILL_TOLERANCE) {
		bgColor = ((Math.round(((fillUnder >> 16) & 0xFF) * AIR_OVER_FILL_DARKEN) << 16)
			| (Math.round(((fillUnder >> 8) & 0xFF) * AIR_OVER_FILL_DARKEN) << 8)
			| Math.round((fillUnder & 0xFF) * AIR_OVER_FILL_DARKEN));
	}
	let targetR = (targetColor >> 16) & 0xFF;
	let targetG = (targetColor >> 8) & 0xFF;
	let targetB = targetColor & 0xFF;
	let bgColorR = (bgColor >> 16) & 0xFF;
	let bgColorG = (bgColor >> 8) & 0xFF;
	let bgColorB = bgColor & 0xFF;
	/*
	const biomeMapWidth = getWorldSize(app.ngPlusCount > 0);
	if (targetR === 255 && targetG === 0 && targetB === 255) {
		// As a fallback, use the color of the biome map?
		// TODO: Currently using app references here when I probably shouldn't
		// Using center of the pixel scene, but it shouldn't really matter
		const chunkX = (Math.floor((biomeMapWidth * 256 + x + width/2) / 512) % getWorldSize(app.ngPlusCount > 0) + getWorldSize(app.ngPlusCount > 0)) % getWorldSize(app.ngPlusCount > 0);
		let chunkY = Math.floor((14*512 + y + height/2) / 512);
		if (chunkY < 0) chunkY = 0;
		if (chunkY > 47) chunkY = 47;
		const bgColorIdx = (chunkY * biomeMapWidth + chunkX)*3;
		const bgColor = (app.recolorOffscreenBuffer[bgColorIdx] << 16) | (app.recolorOffscreenBuffer[bgColorIdx + 1] << 8) | app.recolorOffscreenBuffer[bgColorIdx + 2];
		if (y > 22000) {
			console.log(bgColor, BIOME_BACKGROUND_COLORS["the_end"] & 0xffffff)
		}
		// TODO: Some attempt to make the background color not exactly the same as the terrain color... Need to just get a better background and foreground.
		targetR = Math.floor(app.recolorOffscreenBuffer[bgColorIdx] * 0.75);
		targetG = Math.floor(app.recolorOffscreenBuffer[bgColorIdx + 1] * 0.75);
		targetB = Math.floor(app.recolorOffscreenBuffer[bgColorIdx + 2] * 0.75);
		bgColorR = 0;
		bgColorG = 0;
		bgColorB = 0;
	}
	*/

	for (let i = 0; i < outData.length; i += 4) {
		const r = outData[i];
		const g = outData[i + 1];
		const b = outData[i + 2];

		// Handle Grays (Material Recolor)
		if (r === g && g === b && r > 0) {
			outData[i] = targetR;
			outData[i + 1] = targetG;
			outData[i + 2] = targetB;
			//outData[i + 3] = targetA;
		} 
		// Replace Air with Background
		else if (r === 0x00 && g === 0x00 && b === 0x42) {
			outData[i] = bgColorR;
			outData[i + 1] = bgColorG;
			outData[i + 2] = bgColorB;
			// Transparent air is only right when nothing is painted underneath:
			// it lets whatever is already on the canvas show through, which for a
			// wang biome is the layer's own terrain. In a constant-material fill
			// biome the whole chunk is solid, so transparent air would leave the
			// carved room filled in and invisible -- the scene has to punch the
			// hole itself, in the color the background layer would have shown.
			// Hiisi base is the hand-found instance of the same rule.
			if (targetBiome === "snowcastle" || fillBiomeUnderScene
				|| terrainFillColorForBiome(targetBiome) !== undefined) {
				outData[i + 3] = 0xff;
			}
			else if (PIXEL_SCENE_AIR_TRANSPARENCY_EXCEPTIONS[sceneName]) {
				outData[i + 3] = PIXEL_SCENE_AIR_TRANSPARENCY_EXCEPTIONS[sceneName];
			}
			else {
				outData[i + 3] = 0x00;
			}
		} 
		// Recolor Wang Colors
		else if (recolorMaterials && (r > 0 || g > 0 || b > 0)) {
			const rgb = (r << 16) | (g << 8) | b;
			const matColor = MATERIAL_COLOR_CONVERSION[rgb];
			if (matColor) {
				outData[i] = (matColor >> 16) & 0xFF;
				outData[i + 1] = (matColor >> 8) & 0xFF;
				outData[i + 2] = matColor & 0xFF;
			}
		}
	}

	return outData;
}

// Width and height are not actually needed here
export function recolorPixelScene(sourceData, sourceColor, targetColor) {
    const outData = new Uint8Array(sourceData.length);
	outData.set(sourceData);

	const sourceR = (sourceColor >> 16) & 0xFF;
	const sourceG = (sourceColor >> 8) & 0xFF;
	const sourceB = sourceColor & 0xFF;

	const targetR = (targetColor >> 16) & 0xFF;
	const targetG = (targetColor >> 8) & 0xFF;
	const targetB = targetColor & 0xFF;

    for (let i = 0; i < outData.length; i += 4) {
        const r = outData[i];
		const g = outData[i + 1];
		const b = outData[i + 2];
		if (r === sourceR && g === sourceG && b === sourceB) {
			outData[i] = targetR;
			outData[i + 1] = targetG;
			outData[i + 2] = targetB;
		}
    }

    return outData;
}