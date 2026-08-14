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

// Index into BACKGROUND_IMAGE_PATHS for a biome-map color, or -1 if the biome has
// no background image (or the color is not a known biome).
export function backgroundImageIndex(biomeColorInt) {
	return BY_COLOR.get(biomeColorInt & 0xffffff)?.imageIndex ?? -1;
}

export function backgroundImageColor(imageIndex) {
	return IMAGE_COLORS[imageIndex];
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

export function biomeBackgroundRecord(biomeColorInt) {
	return BY_COLOR.get(biomeColorInt & 0xffffff) ?? null;
}
