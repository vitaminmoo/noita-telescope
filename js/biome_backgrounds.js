import { fetchSafeJson } from "./utils.js";

// Biome backgrounds, keyed the way the engine keys them.
//
// The engine builds exactly one background sprite per 512px world chunk
// (ChunkGrid_CreateAndGenerateChunk -> BiomeRenderer_DrawWeatherLayers). The
// biome it uses is sampled at the chunk *center*, which is deep inside the
// interior region where the edge-noise resolver short-circuits, so the
// background never wobbles: its boundaries are dead-straight chunk lines.
//
// What that sprite shows is the biome's `background_image`, repeat-tiled and
// world-aligned. Many biomes share one image -- 67 of the 175 biome-map colors
// resolve to background_cave_02.png alone -- and where two neighbouring chunks
// share an image the game shows one continuous background with no boundary at
// all. Telescope used to paint a flat color per *biome*, which invented visible
// color steps in all of those places.
//
// So the background layer keys on `background_image`, and the flat color for an
// image is the alpha-weighted mean of that image's own pixels (precomputed in
// data/biome_backgrounds.json). Biomes with an empty `background_image` draw no
// background at all in game -- DrawWeatherLayers returns immediately -- so they
// render as void rather than as some flat color.
//
// The tables here are deliberately separate from BIOME_BACKGROUND_COLORS /
// BIOME_COLOR_LOOKUP in image_processing.js: those also drive tile overlays and
// pixel-scene fills, which still want per-biome identity.

const data = await fetchSafeJson('../data/biome_backgrounds.json');

// Sentinel for "the engine draws nothing here".
export const BACKGROUND_VOID = -1;

// Biomes with no background_image that nevertheless sit in telescope's fake sky
// band. In game the sky is painted by the parallax system, not by this chunk
// grid, and telescope models that separately (the sky gradient in
// renderRecolorMap plus the surface overlay art). Voiding them would punch black
// holes in the sky, so they keep whatever color telescope already gives them.
// Every other empty-background biome is genuine void.
const SKY_BIOME_COLORS = new Set([
	0xd3e6f0, // the_sky
	0xfe0000, // sky_light_injector
]);

// background_image path -> index, so per-chunk grids can be Int16Array.
export const BACKGROUND_IMAGE_PATHS = Object.keys(data.images);
const IMAGE_INDEX = new Map(BACKGROUND_IMAGE_PATHS.map((p, i) => [p, i]));
const IMAGE_COLORS = BACKGROUND_IMAGE_PATHS.map((p) => parseInt(data.images[p].color, 16));

// biome-map RGB -> everything the background layer needs about that biome.
const BY_COLOR = new Map();
for (const b of data.biomes) {
	const rgb = parseInt(b.color, 16) & 0xffffff;
	BY_COLOR.set(rgb, {
		imageIndex: b.background_image ? IMAGE_INDEX.get(b.background_image) : -1,
		priority: b.background_edge_priority ?? 0,
		// The renderer only uses the strips as alpha masks, and the 88 referenced
		// strips share just 18 distinct masks, so each path is resolved to the one
		// representative game file shipped under data/weather_gfx/edges/.
		edges: {
			left: data.edgeMasks[b.background_edge_left] ?? null,
			right: data.edgeMasks[b.background_edge_right] ?? null,
			top: data.edgeMasks[b.background_edge_top] ?? null,
			bottom: data.edgeMasks[b.background_edge_bottom] ?? null,
		},
	});
}

// The color the background layer should paint for one biome-map cell:
//   * an RGB int for a biome with a background_image,
//   * BACKGROUND_VOID where the engine draws no background,
//   * null for "keep whatever telescope already decided" -- unknown biome colors
//     and the sky biomes above.
export function backgroundLayerColor(biomeColorInt) {
	const rgb = biomeColorInt & 0xffffff;
	const rec = BY_COLOR.get(rgb);
	if (!rec) return null;
	if (rec.imageIndex < 0) return SKY_BIOME_COLORS.has(rgb) ? null : BACKGROUND_VOID;
	return IMAGE_COLORS[rec.imageIndex];
}

// ---------------------------------------------------------------------------
// Ragged boundary strips
//
// The straight chunk line between two different backgrounds is decorated, not
// displaced. For each of its two "lower" boundaries (left and top) a chunk
// resolves the neighbour at center +/- 512 -- again interior coords, so again no
// wobble -- and if that neighbour's background_image string differs it emits a
// single hand-drawn 64px strip (BiomeRenderer_CreateTransitionSprite @ 006f4910)
// for the *winning* side only, so the winner's background bleeds 64px into the
// loser's chunk. The winner is the higher background_edge_priority, ties broken
// by string compare on the background_image path, which the game documents as
// "if both biomes have edges defined, will use the one with higher priority (if
// priority is same, will compare (>) background_images)".
//
// The art is 64x640 (left/right) or 640x64 (top/bottom): 512 for the boundary
// itself plus 64 of overhang at each end, and the engine trims an overhang with
// SetSourceRect when the adjacent boundary segment is not part of the same
// transition. We reproduce the geometry exactly and approximate "same
// transition" as "both chunks on the adjacent segment carry the same background
// images as this one", which is what the engine's diagonal priority probes come
// down to for a continuous boundary.
//
// This is the cheap variant of the effect: we do not ship the background art
// itself, only the strips' alpha, and fill it with the winner's flat color.

const CHUNK = 512;
const STRIP = 64;
// Strip length along the boundary: the chunk plus one overhang at each end.
const STRIP_LEN = CHUNK + 2 * STRIP;

const EDGE_MASK_BITMAPS = new Map();
let edgeMaskPromise = null;

// Kick this off once; the draw path silently skips strips whose mask has not
// arrived yet, so it never blocks generation or the first frames.
export function loadBackgroundEdgeMasks() {
	return edgeMaskPromise ??= (async () => {
		const { loadPNGBitmap } = await import('./png_sanitizer.js');
		const paths = [...new Set(Object.values(data.edgeMasks))];
		await Promise.all(paths.map(async (p) => {
			try { EDGE_MASK_BITMAPS.set(p, await loadPNGBitmap('../' + p)); }
			catch (e) { console.warn('Background edge mask failed to load:', p, e); }
		}));
	})();
}

// Flat-colored copy of one strip, cached per (mask, color) so the per-frame draw
// path never allocates. There are at most ~4 directions x 23 background colors of
// these, and only the ones actually on screen are ever built.
const tintedStrips = new Map();
export function tintedEdgeStrip(maskPath, color) {
	const key = maskPath + '|' + color;
	const hit = tintedStrips.get(key);
	if (hit !== undefined) return hit;
	const mask = EDGE_MASK_BITMAPS.get(maskPath);
	if (!mask) return null; // not loaded yet -- don't cache the miss
	const canvas = document.createElement('canvas');
	canvas.width = mask.width;
	canvas.height = mask.height;
	const ctx = canvas.getContext('2d');
	ctx.drawImage(mask, 0, 0);
	ctx.globalCompositeOperation = 'source-in';
	ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	tintedStrips.set(key, canvas);
	return canvas;
}

function imagePathOf(rec) {
	return rec && rec.imageIndex >= 0 ? BACKGROUND_IMAGE_PATHS[rec.imageIndex] : '';
}

function edgeWinner(a, b) {
	if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
	return imagePathOf(a) >= imagePathOf(b) ? a : b;
}

// Precompute every boundary strip for one biome-map layer, bucketed by chunk row
// so the per-frame draw only walks the visible rows. Coordinates are map-local
// pixels; `skipCells` (optional, one byte per cell) marks cells telescope paints
// no background into -- its fake sky in the main world, the columns that generate
// nothing in the vertical bands -- which therefore have no strips either.
export function buildBackgroundEdges(pixels, w, h, skipCells) {
	const rows = Array.from({ length: h }, () => []);
	const wrapX = (cx) => ((cx % w) + w) % w; // parallel worlds tile horizontally
	const at = (cx, cy) => (cy < 0 || cy >= h) ? null : BY_COLOR.get(pixels[cy * w + wrapX(cx)] & 0xffffff) ?? null;
	const isSkipped = (cx, cy) => !!skipCells && cy >= 0 && cy < h && skipCells[cy * w + wrapX(cx)] === 1;
	const same = (a, b) => imagePathOf(a) === imagePathOf(b);

	for (let cy = 0; cy < h; cy++) {
		for (let cx = 0; cx < w; cx++) {
			const me = at(cx, cy);
			// DrawWeatherLayers returns before it looks at either boundary when the
			// chunk has no background image, so an empty chunk never decorates its
			// own left or top edge.
			if (!me || me.imageIndex < 0 || isSkipped(cx, cy)) continue;

			// Left boundary: this chunk's *_left art sits outside it, the left
			// neighbour's *_right art sits inside it.
			const west = at(cx - 1, cy);
			if (west && !same(me, west) && !isSkipped(cx - 1, cy)) {
				const mine = edgeWinner(me, west) === me;
				const mask = mine ? me.edges.left : west.edges.right;
				if (mask) {
					const keepTop = same(at(cx, cy - 1), me) && same(at(cx - 1, cy - 1), west);
					const keepBottom = same(at(cx, cy + 1), me) && same(at(cx - 1, cy + 1), west);
					const sy = keepTop ? 0 : STRIP;
					const sh = (keepBottom ? STRIP_LEN : STRIP_LEN - STRIP) - sy;
					rows[cy].push({
						mask, color: IMAGE_COLORS[(mine ? me : west).imageIndex],
						sx: 0, sy, sw: STRIP, sh,
						dx: cx * CHUNK - (mine ? STRIP : 0), dy: cy * CHUNK - STRIP + sy,
						dw: STRIP, dh: sh,
					});
				}
			}

			// Top boundary: this chunk's *_top art sits above it, the north
			// neighbour's *_bottom art sits below the line, inside this chunk.
			const north = at(cx, cy - 1);
			if (north && !same(me, north) && !isSkipped(cx, cy - 1)) {
				const mine = edgeWinner(me, north) === me;
				const mask = mine ? me.edges.top : north.edges.bottom;
				if (mask) {
					const keepLeft = same(at(cx - 1, cy), me) && same(at(cx - 1, cy - 1), north);
					const keepRight = same(at(cx + 1, cy), me) && same(at(cx + 1, cy - 1), north);
					const sx = keepLeft ? 0 : STRIP;
					const sw = (keepRight ? STRIP_LEN : STRIP_LEN - STRIP) - sx;
					rows[cy].push({
						mask, color: IMAGE_COLORS[(mine ? me : north).imageIndex],
						sx, sy: 0, sw, sh: STRIP,
						dx: cx * CHUNK - STRIP + sx, dy: cy * CHUNK - (mine ? STRIP : 0),
						dw: sw, dh: STRIP,
					});
				}
			}
		}
	}
	return rows;
}
