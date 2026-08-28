// Which biome-map CELL governs a world pixel -- port of
// ChunkGrid_ResolveChunkAtPosition @0x0087d9a0, the first step of
// WorldSave_ResolveCellMaterialAtPixel @0x0087d0e0.
//
// The plain lookup is cell = ((x + mapW*256) >> 9, (y + 7168) >> 9).  Within 42px
// of a cell edge whose neighbour cell holds a DIFFERENT biome, and when both
// sides have noise_biome_edges != 0, the engine re-looks-up the cell at a
// wobbled position:
//     s   = EdgeNoise_Simplex2D(sx*0.05, sy*0.05)     (shifted coords, doubles)
//     col offset (added to shifted_x) = sin(sy*0.005)*30 + s*11
//     row offset (added to shifted_y) = cos(sx*0.005)*30 + s*11
// sin-of-Y feeds the COLUMN and cos-of-X the ROW -- the engine cross-wires the
// axes.  big_noise_biome_edges is 1 for every shipped biome, so the simplex-only
// 2.5px branch never runs; fat_biome_edges is 0 everywhere live.  All int casts
// are C truncation.
//
// Same algorithm as js/surface_terrain.js::resolveCellFull on the real-surface
// branch (live-validated there); duplicated here so the ref_resolver stays
// importable from node without the browser module graph.
import { ComputeMagicValueFromDoubles } from './simplex_noise.js';

const BIOME_MAP_H = 48;

export function cellColorAt(bmap, cx, cy) {
	const w = bmap.w;
	const c = ((cx % w) + w) % w;
	const r = cy < 0 ? 0 : cy > BIOME_MAP_H - 1 ? BIOME_MAP_H - 1 : cy;
	return bmap.colorAt(c, r);
}

// hasEdgeNoise(color) -> boolean (the biome's noise_biome_edges flag).
// Returns { origColor, color, cx, cy } -- `color` is the RESOLVED cell's biome.
export function resolveCellFull(bmap, wx, wy, hasEdgeNoise, out = {}) {
	const mapW = bmap.w;
	// Only the chunk INDEX folds on the PW stride (NG+/nightmare content
	// repeats on 64*512-8, not on the 64-chunk map pitch -- game-proven; see
	// utils.getWorldStride; ng0 is untouched, stride == pitch). The shifted
	// coordinate itself stays absolute: the engine derives sub_x and the wobble
	// simplex/sin/cos from the raw shifted_x and folds only (shifted_x >> 9).
	const strideX = mapW === 64 ? 64 * 512 - 8 : mapW * 512;
	const sx = wx + mapW * 256; // grid x_shift = worldW/2 (= 17920 for mapW 70)
	const sy = wy + 7168; //       grid y_shift = 14*512
	const fx = Math.trunc(sx), fy = Math.trunc(sy);
	const cxAbs = fx >> 9, cy = fy >> 9;
	const cx = Math.trunc(((sx % strideX) + strideX) % strideX) >> 9;
	const origColor = cellColorAt(bmap, cx, cy);
	out.origColor = origColor;
	out.color = origColor;
	out.cx = ((cx % mapW) + mapW) % mapW;
	out.cy = cy < 0 ? 0 : cy > BIOME_MAP_H - 1 ? BIOME_MAP_H - 1 : cy;
	if (!hasEdgeNoise(origColor)) return out;
	const subX = fx & 0x1ff, subY = fy & 0x1ff;
	if (subX >= 42 && subY >= 42 && subX <= 470 && subY <= 470) return out;
	let nColor = null;
	const probe = (dx, dy) => {
		const c = cellColorAt(bmap, cx + dx, cy + dy);
		if (c !== origColor) nColor = c;
		return nColor !== null;
	};
	// engine probe order: left, top, right, bottom, then only the matching corners
	const hit = (subX < 42 && probe(-1, 0)) ||
		(subY < 42 && probe(0, -1)) ||
		(subX > 470 && probe(1, 0)) ||
		(subY > 470 && probe(0, 1)) ||
		(subX < 42 && ((subY < 42 && probe(-1, -1)) || (subY > 470 && probe(-1, 1)))) ||
		(subX > 470 && ((subY < 42 && probe(1, -1)) || (subY > 470 && probe(1, 1))));
	if (!hit || !hasEdgeNoise(nColor)) return out;
	const s = ComputeMagicValueFromDoubles(sx * 0.05, sy * 0.05);
	const offCol = Math.sin(sy * 0.005) * 30.0 + s * 11.0; // sin-of-Y -> column
	const offRow = Math.cos(sx * 0.005) * 30.0 + s * 11.0; // cos-of-X -> row
	// The wobble's cell offset, computed on the absolute coordinate, applied to
	// the folded index.
	const wCx = cx + ((Math.trunc(offCol + sx) >> 9) - cxAbs), wCy = Math.trunc(offRow + sy) >> 9;
	const wColor = cellColorAt(bmap, wCx, wCy);
	if (!hasEdgeNoise(wColor)) return out;
	out.color = wColor;
	out.cx = ((wCx % mapW) + mapW) % mapW;
	out.cy = wCy < 0 ? 0 : wCy > BIOME_MAP_H - 1 ? BIOME_MAP_H - 1 : wCy;
	return out;
}
