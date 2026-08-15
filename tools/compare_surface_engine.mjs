/* global process */
// Whole-surface ground truth vs the ENGINE model (js/engine_resolve/) — the
// same per-pixel chain the GL terrain shader runs: biome-cell wobble ->
// topology-0 surface resolve (surface line + BitmapCaves modifier + carve +
// material bands). Successor to the real-surface branch's
// compare_surface_gt.mjs, which validated that branch's own column solver.
//
// Ground truth: live MAPDUMP solid masks in
//   /home/vitaminmoo/reverse/noita/groundtruth/surface/
//     fullsurface_seed<seed>.json + _masks/x<±N>.bin  (bit-packed air-vs-rest)
//
// Usage: node tools/compare_surface_engine.mjs [seed] [--only <tileX0>]
import { readFileSync, existsSync } from 'node:fs';
import { BIOME_ENGINE } from '../js/engine_resolve/engine_data.js';
import { resolveCellFull } from '../js/engine_resolve/chunk_wobble.js';
import {
	resolveTopo0Pixel, surfaceNoisePhase, topo0Config,
} from '../js/engine_resolve/topo0_resolve.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const SEED = Number(args[0] ?? 786433191);
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? Number(process.argv[onlyIdx + 1]) : null;
const GT_DIR = '/home/vitaminmoo/reverse/noita/groundtruth/surface';
const BAND_TOP = -700; // dump starts -900; clouds/art above -700 are not terrain

const manifest = JSON.parse(readFileSync(`${GT_DIR}/fullsurface_seed${SEED}.json`, 'utf8'));
const map = JSON.parse(readFileSync(`${GT_DIR}/biome_map_ng0.json`, 'utf8'));
const { y0: dumpY0, h: dumpH } = manifest;

const ENGINE_BY_COLOR = new Map(BIOME_ENGINE.map(b => [b.color & 0xffffff, b]));
const bmap = {
	w: map.w,
	colorAt: (cx, cy) => (map.pixels[cy * map.w + cx] ?? 0) & 0xffffff,
};
const hasEdgeNoise = (color) => ENGINE_BY_COLOR.get(color)?.noiseBiomeEdges !== false;
const phase = surfaceNoisePhase(SEED);
const cell = {};

// Placed scenes / spliced art paint OVER the procedural terrain in-game; their
// footprints are not the model's to reproduce.
let sceneZones = [];
if (existsSync(`${GT_DIR}/scene_footprints_seed${SEED}.json`)) {
	const scenes = JSON.parse(readFileSync(`${GT_DIR}/scene_footprints_seed${SEED}.json`, 'utf8'));
	sceneZones = scenes.map((s) => [s.x - 8, s.x + s.w + 8]);
}
const inScene = (x) => sceneZones.some(([a, b]) => x >= a && x <= b);
const KNOWN_ZONES = [
	[-15872, -15828, 'world-edge cliff art (PW boundary)'],
	[11264, 11544, 'sand settled against the pyramid east face'],
];
const inKnown = (x) => KNOWN_ZONES.some(([a, b]) => x >= a && x <= b);

// Engine solid/air at one pixel: 1 solid-ish (any material incl. water — the
// dump mask is air-vs-rest), 0 air, null not resolvable by the topo0 model
// (unsupported biome / topology 2 / art-driven wang chunk).
function modelSolidAt(x, y) {
	resolveCellFull(bmap, x, y, hasEdgeNoise, cell);
	const biome = ENGINE_BY_COLOR.get(cell.color);
	if (!biome || !biome.supported || biome.topo !== 0) return null;
	const leftColor = bmap.colorAt((((cell.cx - 1) % map.w) + map.w) % map.w, cell.cy);
	const leftBiome = ENGINE_BY_COLOR.get(leftColor);
	const subX = (((x + map.w * 256) % 512) + 512) % 512;
	const mat = resolveTopo0Pixel(biome, topo0Config(biome), phase, x, y, {
		worldSeed: SEED, subX, leftCfg: leftBiome ? topo0Config(leftBiome) : null,
	});
	return mat > 0 ? 1 : 0;
}

const stats = [];
let ungoverned = 0, governed = 0, skippedCols = 0;
const t0 = performance.now();
for (const tile of manifest.tiles) {
	if (ONLY !== null && tile.x0 !== ONLY) continue;
	const mask = readFileSync(`${GT_DIR}/fullsurface_seed${SEED}_masks/x${tile.x0}.bin`);
	const gameSolidAt = (c, wy) => {
		const r = wy - dumpY0;
		return (mask[Math.floor(r / 8) * tile.w + c] >> (7 - (r % 8))) & 1;
	};
	const yHi = dumpY0 + dumpH;
	for (let c = 0; c < tile.w; c++) {
		const x = tile.x0 + c;
		if (inScene(x) || inKnown(x)) { skippedCols++; continue; }
		let firstGame = null, firstModel = null, badPx = 0, n = 0, unresolved = 0;
		for (let y = BAND_TOP; y < yHi; y++) {
			const m = modelSolidAt(x, y);
			if (m === null) { unresolved++; continue; }
			const g = gameSolidAt(c, y);
			if (g && firstGame === null) firstGame = y;
			if (m && firstModel === null) firstModel = y;
			if (g !== m) badPx++;
			n++;
		}
		// mostly art/wang/topo2: not this model's column
		if (n < (yHi - BAND_TOP) / 2) { ungoverned++; continue; }
		governed++;
		if (firstGame === null) firstGame = yHi;
		if (firstModel === null) firstModel = yHi;
		// vegetation/props top the terrain with a thin solid run the terrain
		// model does not include: tag them, keep them out of the headline
		let prop = false;
		if (firstGame < firstModel - 10 && firstGame < yHi) {
			let runEnd = firstGame;
			while (runEnd < yHi && gameSolidAt(c, runEnd)) runEnd++;
			prop = runEnd - firstGame < 40 && Math.abs(runEnd - firstModel) < 25;
		}
		stats.push({ x, dFirst: firstGame - firstModel, badFrac: n ? badPx / n : 0, prop, unresolved });
	}
}
console.log(`resolved in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const terr = stats.filter(s => !s.prop);
const mean = (a, f) => a.length ? a.reduce((s, v) => s + f(v), 0) / a.length : 0;
console.log(`columns: ${governed} governed, ${ungoverned} ungoverned, ${skippedCols} scene/known-skipped, ${stats.filter(s => s.prop).length} prop-tagged`);
console.log(`terrain columns: mean |dFirst| ${mean(terr, s => Math.abs(s.dFirst)).toFixed(2)}px, ` +
	`mean badFrac ${(100 * mean(terr, s => s.badFrac)).toFixed(3)}%, ` +
	`>10px first-solid err: ${terr.filter(s => Math.abs(s.dFirst) > 10).length} ` +
	`(${(100 * terr.filter(s => Math.abs(s.dFirst) > 10).length / (terr.length || 1)).toFixed(2)}%)`);

// worst 512px chunk-column groups
const groups = new Map();
for (const s of terr) {
	const g = Math.floor((s.x + map.w * 256) / 512);
	if (!groups.has(g)) groups.set(g, []);
	groups.get(g).push(s);
}
const ranked = [...groups.entries()]
	.map(([g, list]) => ({
		g, x0: g * 512 - map.w * 256, n: list.length,
		bad: mean(list, s => s.badFrac), dAbs: mean(list, s => Math.abs(s.dFirst)),
	}))
	.sort((a, b) => b.bad - a.bad);
console.log('worst chunk-column groups (x0, cols, badFrac, mean|dFirst|):');
for (const r of ranked.slice(0, 12)) {
	console.log(`  x=${String(r.x0).padStart(7)}  n=${String(r.n).padStart(4)}  ` +
		`${(100 * r.bad).toFixed(2)}%  ${r.dAbs.toFixed(1)}px`);
}
