// Tier 1: what the CPU engine-resolve chain (js/engine_resolve/) answers for a
// fixture rect, scored against the game's own answer.
//
// Two kinds of check, because the engine only owns part of the picture:
//
//   chunkFlags — the per-chunk classification the GL terrain pass uploads
//                (gl/engine_resources.js): which biome the cell is, whether the
//                generator paints anything there, and whether telescope stands a
//                constant fill in for it. Every "the room must be air" /
//                "the Holy Mountain must stay filled" bug is a wrong answer here.
//   pixels     — per-pixel: does the engine paint where the game has terrain
//                (`airMask`), or does it paint the same material (`materials`,
//                against a MATDUMP grid). Scene art and stamped rooms are NOT the
//                engine's output, so those fixtures use `none` and lean on
//                chunkFlags plus the tier-2 render.
import { engineWorld, REPO } from './generate.mjs';
import { expectedAirMask, expectedMaterials, agreement } from './fixtures.mjs';

const CHUNK = 512;
const WORLD_CENTER_Y_CHUNKS = 14;

let configPromise = null;
async function biomeConfig() {
	configPromise ??= (async () => {
		const { GENERATOR_CONFIG, FILL_LAYER_MATERIALS, SCENE_ONLY_COLORS } =
			await import(REPO + '/js/generator_config.js');
		const nameByColor = new Map();
		for (const [key, conf] of Object.entries(GENERATOR_CONFIG)) nameByColor.set(conf.color & 0xffffff, key);
		return { GENERATOR_CONFIG, FILL_LAYER_MATERIALS, SCENE_ONLY_COLORS, nameByColor };
	})();
	return configPromise;
}

/** World pixel -> biome-map cell (no edge wobble; that is the chunk's own cell). */
export function cellOf(x, y, mapWidth) {
	return [
		Math.floor(x / CHUNK) + Math.floor(mapWidth / 2),
		Math.floor(y / CHUNK) + WORLD_CENTER_Y_CHUNKS,
	];
}

/** Engine + telescope classification of one biome-map cell. */
export async function chunkFacts(cx, cy, opts = {}) {
	const w = await engineWorld(opts);
	const cfg = await biomeConfig();
	const info = w.chunkInfo(cx, cy);
	const color = (info.biome?.color ?? 0) & 0xffffff;
	return {
		cell: [cx, cy],
		biome: cfg.nameByColor.get(color) ?? null,
		biomeColor: '0x' + color.toString(16).padStart(6, '0'),
		mode: info.mode,
		paintsNothing: info.paintsNothing,
		sceneOnly: cfg.SCENE_ONLY_COLORS.has(color),
		fillLayerMaterial: cfg.FILL_LAYER_MATERIALS[color] ?? null,
	};
}

/** Runs a fixture's tier-1 checks and returns the measurements (no assertions). */
export async function evaluateTier1(f) {
	const opts = { seed: f.seed, ngPlus: f.ngPlus ?? 0 };
	const w = await engineWorld(opts);
	const { x, y, w: width, h: height } = f.world;

	const flags = [];
	for (const want of (f.tier1?.chunkFlags ?? [])) {
		const [cx, cy] = want.cell ?? cellOf(x, y, w.W);
		const got = await chunkFacts(cx, cy, opts);
		const bad = Object.entries(want).filter(([k, v]) =>
			k !== 'cell' && JSON.stringify(got[k]) !== JSON.stringify(v));
		flags.push({ cell: [cx, cy], want, got, bad });
	}

	const metric = f.tier1?.pixels?.metric ?? 'none';
	const model = new Array(width * height);
	const modelName = new Array(width * height);
	let unresolved = 0;
	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			const id = w.field.materialAt(x + px, y + py);
			const i = py * width + px;
			model[i] = id;
			modelName[i] = w.materialName(id) ?? 'UNRESOLVED';
			if (id < 0) unresolved++;
		}
	}
	const unresolvedPct = 100 * unresolved / (width * height);

	let pixels = null;
	if (metric === 'fillMask') {
		// "Does telescope's terrain cover this pixel at all" — the engine's own
		// output plus the constant stand-in fill it hands to the legacy pipeline
		// for the chunks it generates nothing in (FILL_LAYER_MATERIALS). This is
		// the check for the Holy-Mountain class of bug, where the engine answering
		// "air" quietly deleted a whole basin. It uses the ENGINE wobble to pick
		// the pixel's cell, so a pixel or two right on a biome seam can differ
		// from the legacy pipeline's own edge noise.
		const cfg = await biomeConfig();
		const want = expectedAirMask(f);
		const got = new Array(width * height);
		for (let py = 0; py < height; py++) {
			for (let px = 0; px < width; px++) {
				const i = py * width + px;
				if (model[i] > 0) { got[i] = 'solid'; continue; }
				const cell = w.resolvedCellAt(x + px, y + py);
				got[i] = cfg.FILL_LAYER_MATERIALS[cell.color] ? 'solid' : 'air';
			}
		}
		pixels = agreement(Array.from(want, (a) => (a ? 'air' : 'solid')), got);
	} else if (metric === 'airMask') {
		const want = expectedAirMask(f);
		// The engine "paints nothing" both when it resolves to air and when the
		// chunk is not its to resolve; either way the terrain there is not the
		// generator's output.
		const got = Array.from(model, (id) => (id > 0 ? 'solid' : 'air'));
		pixels = agreement(Array.from(want, (a) => (a ? 'air' : 'solid')), got);
	} else if (metric === 'materials') {
		const want = expectedMaterials(f);
		if (!want) throw new Error(`${f.name}: metric "materials" needs a matpal16 fixture`);
		pixels = agreement(want, modelName);
	}
	return { flags, pixels, unresolvedPct, metric };
}
