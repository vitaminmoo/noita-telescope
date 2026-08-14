// Native-resolution contour of the edge-noise'd ("wobbled") biome boundaries.
//
// The tile overlays bake the wobble once per 10-world-pixel map cell, so the biome edge
// they show is quantized to a 10px staircase. This module walks the same resolver the
// overlays use, but at one sample per screen pixel, and strokes the exact curve where
// the resolved biome flips from one chunk's biome to the other's.
//
// Engine facts this relies on:
//  * A world pixel only resolves to a biome other than its own 512px chunk's within
//    BIOME_EDGE_NOISE_EXTENT (42) pixels of a chunk border, so every boundary lives in
//    an 84px band centred on a chunk border line - plus the square where two such bands
//    cross at a chunk corner, which the resolver treats specially by also probing the
//    diagonal neighbour chunks.
//  * A border only wobbles when the two adjacent chunk-grid cells hold different biomes
//    and neither side's flags/overlay exceptions disable the noise. Everywhere else the
//    boundary is the straight chunk line.
//  * The wobble is not a function of the along-border coordinate. It grows fingers and
//    detaches islands of one biome inside the other, so a boundary can be a closed loop
//    with no connection to the chunk line at all.
//
// The contour is therefore extracted from a 2D sample lattice rather than traced along
// the border: every pair of neighbouring lattice points that resolve to different
// biomes contributes the dual edge between them (multi-label marching squares, emitting
// the cell edges instead of chained polylines). Neighbouring dual edges share their
// endpoints exactly, so islands close into loops and the main boundary comes out
// continuous without any strand-matching heuristic.

import { CHUNK_SIZE, BIOME_EDGE_NOISE_EXTENT, WORLD_CHUNK_CENTER_Y } from './constants.js';
import { getWorldCenter, getWorldSize } from './utils.js';
import { getTileOverlayBiome, getUnwobbledTileOverlayBiome, edgeNoiseOverlayExceptions } from './image_processing.js';
import { biomeEdgeNoiseFlag } from './wobble_flags.js';

const WORLD_CHUNK_HEIGHT = 48;
const WORLD_PIXEL_HEIGHT = WORLD_CHUNK_HEIGHT * CHUNK_SIZE;
// Half-width of the band swept perpendicular to a border. One extra pixel beyond the
// noise extent so the outermost samples are provably outside the wobble range and
// therefore hold their own chunk's biome.
const BAND = BIOME_EDGE_NOISE_EXTENT + 1;
// Below this the whole band is thinner than ~2 screen pixels and the wobble cannot be
// told apart from the straight chunk line, so the scan is skipped entirely.
const MIN_BAND_SCREEN_PX = 2;
// Hard ceiling on resolver calls per frame. Segments past it fall back to straight lines
// rather than letting a fully zoomed out view stall the frame.
const MAX_SAMPLES_PER_FRAME = 600000;

const COLOR_HALO = 'rgba(0, 0, 0, 0.85)';
const COLOR_LINE = '#FF00FF';

// Resolver calls made by the frame in progress, returned for profiling.
let samplesThisFrame = 0;

// A border cannot wobble when either side opts out of edge noise, so its contour is the
// straight chunk line. Mirrors the gates in getBiomeAtWorldCoordinates() (the
// noise_biome_edges flag) and getTileOverlayBiome() (the overlay exception list).
function borderIsStraight(useEdgeNoise, a, b) {
	if (!useEdgeNoise) return true;
	if (edgeNoiseOverlayExceptions.has(a.biome) || edgeNoiseOverlayExceptions.has(b.biome)) return true;
	if (biomeEdgeNoiseFlag(a.colorInt, 'noise_biome_edges') === 0) return true;
	if (biomeEdgeNoiseFlag(b.colorInt, 'noise_biome_edges') === 0) return true;
	return false;
}

// The lattice is anchored to world coordinate 0 rather than to any one region, so two
// regions that cover the same world pixel always sample it at the same lattice index and
// emit identical geometry. `step` is one screen pixel in world units, never finer than
// the resolver's own pixel grid.
const latticeCoord = (index, step) => Math.round(index * step);
// The dual-grid line sitting between lattice index `index` and `index + 1`. Dual edges
// only ever run between these, which is what makes neighbouring edges share endpoints.
//
// A world cell at integer coordinate x covers the square [x, x + 1), so the boundary
// between differing cells x and x + 1 is the line x + 1, not the midpoint x + 0.5. The
// sample at lattice index `index` stands for the whole block of cells from its own world
// coordinate up to (not including) the next sample's, so the line separating it from the
// next sample is that next sample's coordinate: the shared edge of the two blocks. At
// step 1 that is +0.5 past the old midpoint, at coarser steps +step/2, and it is always
// a whole world coordinate instead of landing mid-cell.
const dualCoord = (index, step) => latticeCoord(index + 1, step);

// Lattice index range of the ±BAND square centred on the chunk border coordinate `coord`.
// Band middles start and end on these same indices, so a corner square and the border
// bands running out of it share one lattice line: no gap between them, and nothing
// duplicated but that line.
const bandLowIndex = (coord, step) => Math.ceil((coord - BAND) / step);
const bandHighIndex = (coord, step) => Math.floor((coord + BAND) / step);

/**
 * Resolves one lattice rectangle and appends the dual edge of every biome change inside
 * it to `path`. Sampling runs column by column so only two columns are ever held.
 *
 * `iFrom`..`iTo` and `jFrom`..`jTo` are inclusive lattice indices along world x and y;
 * `backX`/`backY` shift world coordinates into the canvas draw space.
 */
function sampleRegion(path, opts, iFrom, iTo, jFrom, jTo, step, backX, backY) {
	const { biomeData, isNGP, gameMode, useEdgeNoise } = opts;
	const height = jTo - jFrom + 1;
	if (height < 1 || iTo < iFrom) return;

	// World y of each sampled row, and the draw-space y of the dual lines between them:
	// gapY[n] is the line above row n, gapY[n + 1] the line below it.
	const rowY = new Float64Array(height);
	const gapY = new Float64Array(height + 1);
	for (let n = 0; n < height; n++) rowY[n] = latticeCoord(jFrom + n, step);
	for (let n = 0; n <= height; n++) gapY[n] = dualCoord(jFrom + n - 1, step) + backY;

	let previous = new Int32Array(height);
	let current = new Int32Array(height);
	let havePrevious = false;

	for (let i = iFrom; i <= iTo; i++) {
		const worldX = latticeCoord(i, step);
		for (let n = 0; n < height; n++) {
			samplesThisFrame++;
			current[n] = getTileOverlayBiome(biomeData, worldX, rowY[n], isNGP, gameMode, useEdgeNoise).colorInt;
		}

		const leftX = dualCoord(i - 1, step) + backX;
		const rightX = dualCoord(i, step) + backX;

		// Vertically adjacent samples inside this column: the dual edge is the horizontal
		// segment across the column, on the dual line between the two rows.
		for (let n = 0; n + 1 < height; n++) {
			if (current[n] === current[n + 1]) continue;
			const y = gapY[n + 1];
			path.moveTo(leftX, y);
			path.lineTo(rightX, y);
		}

		// Horizontally adjacent samples across the previous column boundary: the dual edge
		// is the vertical segment on the dual line between the two columns.
		if (havePrevious) {
			for (let n = 0; n < height; n++) {
				if (previous[n] === current[n]) continue;
				path.moveTo(leftX, gapY[n]);
				path.lineTo(leftX, gapY[n + 1]);
			}
		}

		const spare = previous;
		previous = current;
		current = spare;
		havePrevious = true;
	}
}

function straightSegment(path, vertical, borderCoord, from, to, backX, backY) {
	if (vertical) {
		path.moveTo(borderCoord + backX, from + backY);
		path.lineTo(borderCoord + backX, to + backY);
	}
	else {
		path.moveTo(from + backX, borderCoord + backY);
		path.lineTo(to + backX, borderCoord + backY);
	}
}

/**
 * Strokes the wobbled biome boundary contour for everything in view.
 *
 * @param {CanvasRenderingContext2D} ctx canvas already under the camera transform
 * @param {object} opts biomeData, isNGP, gameMode, useEdgeNoise, camZ, viewRect,
 *                      worldsInView and worldOffsets, straight from drawNow()
 * @returns {number} resolver samples taken, for profiling
 */
export function drawBiomeBoundaryContour(ctx, opts) {
	const { biomeData, isNGP, gameMode, camZ, viewRect, worldsInView, worldOffsets } = opts;
	const useEdgeNoise = opts.useEdgeNoise;
	samplesThisFrame = 0;
	if (!biomeData || !worldsInView || !worldOffsets) return 0;

	const mapWidth = getWorldSize(isNGP, gameMode);
	const worldPixelWidth = mapWidth * CHUNK_SIZE;
	const halfWorldPixelWidth = getWorldCenter(isNGP, gameMode) * CHUNK_SIZE;
	// One sample per screen pixel, but never finer than the resolver's own pixel grid.
	const step = Math.max(1, 1 / camZ);
	// Zoomed far enough out that the band collapses to a line, so nothing to scan.
	const bandTooSmall = 2 * BAND * camZ < MIN_BAND_SCREEN_PX;

	const path = new Path2D();
	const chunkInfo = (worldX, worldY) => getUnwobbledTileOverlayBiome(biomeData, worldX, worldY, isNGP, gameMode);

	for (const worldKey of worldsInView) {
		const offsets = worldOffsets[worldKey];
		if (!offsets) continue;
		const { pwX, pwY, shiftX, shiftY } = offsets;

		// Clip the view to the draw-space rectangle this parallel world occupies, then
		// convert that rectangle into the world coordinates its content was generated
		// with (the same mapping the PoI layer uses: draw = world + half world + shift).
		const drawLeft = Math.max(viewRect.left, shiftX);
		const drawRight = Math.min(viewRect.right, shiftX + worldPixelWidth);
		const drawTop = Math.max(viewRect.top, shiftY);
		const drawBottom = Math.min(viewRect.bottom, shiftY + WORLD_PIXEL_HEIGHT);
		if (drawLeft >= drawRight || drawTop >= drawBottom) continue;

		// worldX = drawX + backX is inverted below to put the path back in draw space.
		const backX = shiftX + halfWorldPixelWidth - pwX * worldPixelWidth;
		const backY = shiftY + WORLD_CHUNK_CENTER_Y * CHUNK_SIZE - pwY * WORLD_PIXEL_HEIGHT;
		const worldLeft = drawLeft - backX;
		const worldRight = drawRight - backX;
		const worldTop = drawTop - backY;
		const worldBottom = drawBottom - backY;

		// Lattice index range of the visible rectangle. Every region is clamped into it,
		// so offscreen parts of a band are never resolved.
		const viewIFrom = Math.ceil(worldLeft / step);
		const viewITo = Math.floor(worldRight / step);
		const viewJFrom = Math.ceil(worldTop / step);
		const viewJTo = Math.floor(worldBottom / step);
		const region = (i0, i1, j0, j1) => sampleRegion(path, opts,
			Math.max(i0, viewIFrom), Math.min(i1, viewITo),
			Math.max(j0, viewJFrom), Math.min(j1, viewJTo),
			step, backX, backY);

		// Chunk borders sit on multiples of CHUNK_SIZE in world coordinates because the
		// world centre offsets are a whole number of chunks in every game mode. The chunk
		// ranges below run one chunk past the view so that a band, or a corner square,
		// reaching in from just offscreen is still found.
		const colFrom = Math.floor((worldLeft - BAND) / CHUNK_SIZE);
		const colTo = Math.floor((worldRight + BAND) / CHUNK_SIZE);
		const rowFrom = Math.floor((worldTop - BAND) / CHUNK_SIZE);
		const rowTo = Math.floor((worldBottom + BAND) / CHUNK_SIZE);

		// Chunk corners whose ±BAND square still has to be sampled, keyed "cx,cy". A
		// corner is only interesting when one of the four borders meeting there wobbles;
		// if none of them do, all four chunks around it hold the same biome.
		const corners = new Map();

		// Vertical borders, including any whose 84px band reaches into the view.
		for (let cx = Math.ceil((worldLeft - BAND) / CHUNK_SIZE); cx <= colTo; cx++) {
			const borderX = cx * CHUNK_SIZE;
			for (let cy = rowFrom; cy <= rowTo; cy++) {
				const rowCenterY = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
				const left = chunkInfo(borderX - CHUNK_SIZE / 2, rowCenterY);
				const right = chunkInfo(borderX + CHUNK_SIZE / 2, rowCenterY);
				if (left.colorInt === right.colorInt) continue;
				if (bandTooSmall || samplesThisFrame > MAX_SAMPLES_PER_FRAME || borderIsStraight(useEdgeNoise, left, right)) {
					const from = Math.max(worldTop, cy * CHUNK_SIZE);
					const to = Math.min(worldBottom, (cy + 1) * CHUNK_SIZE);
					if (from < to) straightSegment(path, true, borderX, from, to, backX, backY);
					continue;
				}
				corners.set(cx + ',' + cy, { x: borderX, y: cy * CHUNK_SIZE });
				corners.set(cx + ',' + (cy + 1), { x: borderX, y: (cy + 1) * CHUNK_SIZE });
				// The band between this row's two corner squares; the squares themselves
				// are sampled once each below however many borders run into them.
				region(bandLowIndex(borderX, step), bandHighIndex(borderX, step),
					bandHighIndex(cy * CHUNK_SIZE, step), bandLowIndex((cy + 1) * CHUNK_SIZE, step));
			}
		}

		// Horizontal borders.
		for (let cy = Math.ceil((worldTop - BAND) / CHUNK_SIZE); cy <= rowTo; cy++) {
			const borderY = cy * CHUNK_SIZE;
			for (let cx = colFrom; cx <= colTo; cx++) {
				const colCenterX = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
				const top = chunkInfo(colCenterX, borderY - CHUNK_SIZE / 2);
				const bottom = chunkInfo(colCenterX, borderY + CHUNK_SIZE / 2);
				if (top.colorInt === bottom.colorInt) continue;
				if (bandTooSmall || samplesThisFrame > MAX_SAMPLES_PER_FRAME || borderIsStraight(useEdgeNoise, top, bottom)) {
					const from = Math.max(worldLeft, cx * CHUNK_SIZE);
					const to = Math.min(worldRight, (cx + 1) * CHUNK_SIZE);
					if (from < to) straightSegment(path, false, borderY, from, to, backX, backY);
					continue;
				}
				corners.set(cx + ',' + cy, { x: cx * CHUNK_SIZE, y: borderY });
				corners.set((cx + 1) + ',' + cy, { x: (cx + 1) * CHUNK_SIZE, y: borderY });
				region(bandHighIndex(cx * CHUNK_SIZE, step), bandLowIndex((cx + 1) * CHUNK_SIZE, step),
					bandLowIndex(borderY, step), bandHighIndex(borderY, step));
			}
		}

		// Corner squares last, so a frame that runs out of budget spends what it has on
		// the long stretches of border rather than on the joints.
		for (const corner of corners.values()) {
			if (samplesThisFrame > MAX_SAMPLES_PER_FRAME) break;
			region(bandLowIndex(corner.x, step), bandHighIndex(corner.x, step),
				bandLowIndex(corner.y, step), bandHighIndex(corner.y, step));
		}
	}

	ctx.save();
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.strokeStyle = COLOR_HALO;
	ctx.lineWidth = 3 / camZ;
	ctx.stroke(path);
	ctx.strokeStyle = COLOR_LINE;
	ctx.lineWidth = 1 / camZ;
	ctx.stroke(path);
	ctx.restore();

	return samplesThisFrame;
}
