// Headless telescope world generation for Node.
//
// Runs the real generation path (js/biome_generator.js -> js/tile_generator.js)
// outside a browser so CPU-side tests can ask the engine-resolve chain
// (js/engine_resolve/) what material the engine makes at a world pixel.
//
// Ported from scripts/ref_resolver/gen_layers.mjs (gitignored) so the committed
// test harness owns its own copy; keep the two in sync if that one changes.

// Telescope's generation path is pure JS apart from a handful of canvas calls
// whose output is discarded, so a stub canvas is enough.
function makeFakeCanvas(w, h) {
	const ctx = {
		createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
		putImageData() {}, drawImage() {},
		getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
	};
	return { width: w, height: h, getContext: () => ctx };
}
globalThis.document ??= { createElement: (t) => (t === 'canvas' ? makeFakeCanvas(0, 0) : {}), getElementById: () => null };
globalThis.OffscreenCanvas ??= class { constructor(w, h) { Object.assign(this, makeFakeCanvas(w, h)); } };

export const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

const cache = new Map();

/**
 * Runs telescope's generation path headlessly (memoized per seed/ng/mode).
 * @returns {Promise<{layers, biomeData, W, H, GENERATOR_CONFIG}>}
 */
export async function generate({ seed = 786433191, ngPlus = 0, gameMode = 'normal', quiet = true } = {}) {
	const key = `${seed}|${ngPlus}|${gameMode}`;
	if (cache.has(key)) return cache.get(key);
	const p = (async () => {
		const isNGP = ngPlus > 0;
		const baseMapPath = gameMode === 'nightmare' ? '../data/biome_maps/biome_map_nightmare.png'
			: isNGP ? '../data/biome_maps/biome_map_newgame_plus.png'
				: '../data/biome_maps/biome_map.png';

		const imgProc = await import(REPO + '/js/image_processing.js');
		await imgProc.initBiomeColors();
		const { loadPNG } = await import(REPO + '/js/png_sanitizer.js');
		const { generateBiomeData, BIOME_CONFIG } = await import(REPO + '/js/biome_generator.js');
		const { GENERATOR_CONFIG } = await import(REPO + '/js/generator_config.js');
		const { generateBiomeTiles } = await import(REPO + '/js/tile_generator.js');
		const { updateSettings } = await import(REPO + '/js/settings.js');

		updateSettings({ enableEdgeNoise: true, recolorMaterials: true, clearSpawnPixels: false, gameMode });

		const base = await loadPNG(baseMapPath);
		const W = (isNGP || gameMode === 'nightmare') ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
		const H = BIOME_CONFIG.H_NG0;

		const origLog = console.log, origWarn = console.warn;
		if (quiet) { console.log = () => {}; console.warn = () => {}; }
		try {
			const biomeData = generateBiomeData(seed, ngPlus, gameMode, base.data, W, H);
			for (const k of Object.keys(GENERATOR_CONFIG)) {
				const conf = GENERATOR_CONFIG[k];
				if (conf.enabled && !conf.wangData && conf.wangFile) conf.wangData = await loadPNG(conf.wangFile);
			}
			const layers = await generateBiomeTiles(biomeData.pixels, W, H, GENERATOR_CONFIG, seed, ngPlus, 0, gameMode);
			return { layers, biomeData, W, H, GENERATOR_CONFIG };
		} finally {
			if (quiet) { console.log = origLog; console.warn = origWarn; }
		}
	})();
	cache.set(key, p);
	return p;
}

/**
 * The engine-resolve material field for a world, plus the per-chunk engine
 * classification table (gl/engine_resources.js) the GL terrain pass uploads.
 */
export async function engineWorld(opts = {}) {
	const { seed = 786433191, ngPlus = 0, gameMode = 'normal' } = opts;
	const key = `eng|${seed}|${ngPlus}|${gameMode}`;
	if (cache.has(key)) return cache.get(key);
	const p = (async () => {
		const { layers, biomeData, W, GENERATOR_CONFIG } = await generate(opts);
		const { buildEngineLattice } = await import(REPO + '/js/engine_resolve/lattice_builder.js');
		const { createMaterialField, MATERIAL_UNRESOLVED } = await import(REPO + '/js/engine_resolve/material_field.js');
		const { buildEngineResources, ENGINE_MODE_TOPO0, ENGINE_MODE_TOPO2, ENGINE_MODE_FALLBACK } =
			await import(REPO + '/js/gl/engine_resources.js');
		const { BIOME_ENGINE, MATERIAL_NAMES_BY_ID } = await import(REPO + '/js/engine_resolve/engine_data.js');
		const { resolveCellFull } = await import(REPO + '/js/engine_resolve/chunk_wobble.js');
		const lattice = buildEngineLattice(layers, GENERATOR_CONFIG, W, 48);
		const field = createMaterialField(layers, biomeData, GENERATOR_CONFIG, W, seed, { lattice });
		const res = buildEngineResources(layers, biomeData, GENERATOR_CONFIG, W);
		const MODE_NAME = {
			[ENGINE_MODE_TOPO0]: 'topo0', [ENGINE_MODE_TOPO2]: 'topo2', [ENGINE_MODE_FALLBACK]: 'fallback',
		};
		/** Engine classification of one biome-map cell, as the GL pass sees it. */
		const chunkInfo = (cx, cy) => {
			const bits = res.chunk[cy * W + (((cx % W) + W) % W)];
			return {
				biomeSlot: bits & 0xff,
				biome: BIOME_ENGINE[bits & 0xff],
				mode: MODE_NAME[(bits >> 8) & 3],
				noiseBiomeEdges: !!(bits & (1 << 10)),
				paintsNothing: !!(bits & (1 << 11)),
			};
		};
		// The biome-map cell a world pixel really belongs to after the engine's
		// 42px biome-edge wobble — the same resolve materialAt does internally.
		const ENGINE_BY_COLOR = new Map(BIOME_ENGINE.map(b => [b.color & 0xffffff, b]));
		const bmap = { w: W, colorAt: (cx, cy) => (biomeData.pixels[cy * W + cx] ?? 0) & 0xffffff };
		const hasEdgeNoise = (color) => ENGINE_BY_COLOR.get(color)?.noiseBiomeEdges !== false;
		const cellScratch = {};
		const resolvedCellAt = (x, y) => {
			resolveCellFull(bmap, x, y, hasEdgeNoise, cellScratch);
			return { cx: cellScratch.cx, cy: cellScratch.cy, color: cellScratch.color };
		};

		return {
			seed, ngPlus, W, layers, biomeData, GENERATOR_CONFIG, lattice, field, res, chunkInfo, resolvedCellAt,
			MATERIAL_UNRESOLVED, MATERIAL_NAMES_BY_ID,
			materialName: (id) => (id === MATERIAL_UNRESOLVED ? null : (MATERIAL_NAMES_BY_ID[id] ?? `id${id}`)),
		};
	})();
	cache.set(key, p);
	return p;
}
