// Measurement for the edge-decal fixtures: what js/edge_decals.js stamps over a
// world rect, scored against the game's own BAKED cell colours.
//
// The decal pass bakes into cell colours, so a MAPDUMP -- which re-renders the
// material grid through materials_gfx -- carries NONE of it, while a BAKEDUMP
// (cell+0x30 mColor) carries all of it. Inside a solid cell the two dumps
// disagree exactly where the engine stamped something, so
//
//     game decal cell  <=>  baked[i] != base[i]        (base = the MAPDUMP)
//
// is the game's own decal mask, with no modelling on our side at all.
//
// Two deliberate choices make this fixture measure the DECAL PASS and nothing
// else:
//
//   * the stamp is fed the GAME'S material grid (the fixture's MATDUMP plane),
//     not telescope's engine-resolve output. The rect is a `paintsNothing`
//     scene-only chunk, where telescope's terrain model correctly resolves air,
//     so scoring the two together would only measure the terrain model.
//   * "our decal cell" means a VISIBLE one -- a stamp whose composited colour
//     actually differs from the cell's base colour. Roughly half of the texels
//     the stamp lands carry the material's own base colour, and the game's mask
//     cannot see those either (baked == base there), so counting raw stamped
//     cells overstates our coverage about twofold and is not comparable to the
//     ground truth.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

let modules = null;
async function load() {
	modules ??= await (async () => {
		const ED = await import(`${REPO}/js/engine_resolve/engine_data.js`);
		const decals = await import(`${REPO}/js/edge_decals.js`);
		decals.setEdgeDecalAtlas(readFileSync(`${REPO}/data/edge_atlas.bin`));
		const idByName = new Map();
		ED.MATERIAL_NAMES_BY_ID.forEach((n, i) => { if (n && !idByName.has(n)) idByName.set(n, i); });
		return { ED, decals, idByName };
	})();
	return modules;
}

export const FIXTURE_DIR = new URL('../fixtures/edge_decals/', import.meta.url).pathname;

/** Fixture names in test/fixtures/edge_decals/, in file order. */
export function decalFixtureNames() {
	if (!existsSync(FIXTURE_DIR)) return [];
	return readdirSync(FIXTURE_DIR)
		.filter(f => f.endsWith('.json'))
		.map(f => f.slice(0, -5)).sort();
}

/** Metadata + the three committed planes for one decal fixture. */
export function loadDecalFixture(name) {
	const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'));
	const { w, h } = meta.world;
	const halo = meta.halo;
	const pw = w + 2 * halo, ph = h + 2 * halo;
	const rd = (file) => {
		const b = readFileSync(`${FIXTURE_DIR}${file}`);
		return new Uint8Array(b.buffer, b.byteOffset, b.length);
	};
	const baked = rd(meta.expected.baked);
	const base = rd(meta.expected.base);
	if (baked.length !== w * h * 3) throw new Error(`${name}: baked plane is ${baked.length} bytes, want ${w * h * 3}`);
	if (base.length !== w * h * 3) throw new Error(`${name}: base plane is ${base.length} bytes, want ${w * h * 3}`);
	const mraw = readFileSync(`${FIXTURE_DIR}${meta.expected.mat}`);
	if (mraw.length !== pw * ph * 2) throw new Error(`${name}: material plane is ${mraw.length} bytes, want ${pw * ph * 2}`);
	const pal = new Uint16Array(mraw.buffer, mraw.byteOffset, pw * ph);
	return { ...meta, baked, base, pal, pw, ph };
}

/**
 * Runs js/edge_decals.js over the fixture's material grid and scores it against
 * the baked dump. Returns the measurements only; the test does the asserting.
 */
export async function evaluateDecalFixture(f) {
	const { decals, idByName } = await load();
	const { x, y, w, h } = f.world;
	const halo = f.halo;
	const { pw, ph } = f;
	const names = f.expected.palette;

	// The game's material ids are its own; the fixture stores NAMES so neither
	// side's id numbering can silently reshuffle it.
	const mat = new Int16Array(pw * ph);
	for (let i = 0; i < pw * ph; i++) {
		const n = names[f.pal[i]];
		if (n === 'air') { mat[i] = 0; continue; }
		if (n === 'nochunk') { mat[i] = -1; continue; }
		const id = idByName.get(n);
		mat[i] = id === undefined ? -1 : id;
	}

	const rgba = decals.stampEdgeDecals(mat, pw, ph, x - halo, y - halo, f.seed, {
		chunkShiftX: f.chunkShiftX ?? 0,
		chunkShiftY: f.chunkShiftY ?? 0,
	});

	const px = (buf, i) => (buf[i * 3] << 16) | (buf[i * 3 + 1] << 8) | buf[i * 3 + 2];
	let solid = 0, game = 0, ours = 0, both = 0, gameOnly = 0, oursOnly = 0;
	let stamped = 0, invisible = 0, exact = 0, noDecal = 0;
	for (let py = 0; py < h; py++) {
		for (let px0 = 0; px0 < w; px0++) {
			const r = py * w + px0;                       // fixture rect index
			const s = (py + halo) * pw + (px0 + halo);    // padded grid index
			const n = names[f.pal[s]];
			if (n === 'air' || n === 'nochunk') continue;
			solid++;
			const b = px(f.baked, r), m = px(f.base, r);
			const a = rgba[s * 4 + 3];
			let c = m;
			if (a) {
				const t = a / 255;
				c = (Math.round(rgba[s * 4] * t + ((m >> 16) & 0xff) * (1 - t)) << 16)
					| (Math.round(rgba[s * 4 + 1] * t + ((m >> 8) & 0xff) * (1 - t)) << 8)
					| Math.round(rgba[s * 4 + 2] * t + (m & 0xff) * (1 - t));
			}
			const g = b !== m;               // the game stamped something visible here
			const o = a !== 0 && c !== m;    // so did we
			if (a) stamped++;
			if (a && !o) invisible++;
			if (g) game++;
			if (o) ours++;
			if (g && o) both++; else if (g) gameOnly++; else if (o) oursOnly++;
			if (c === b) exact++;
			if (m === b) noDecal++;
		}
	}
	const pct = (n) => (solid ? 100 * n / solid : 100);
	return {
		solid, both, gameOnly, oursOnly, stamped, invisible,
		gameDecalPct: pct(game),
		ourDecalPct: pct(ours),
		densityGapPct: Math.abs(pct(game) - pct(ours)),
		cellAgreementPct: pct(solid - gameOnly - oursOnly),
		iouPct: (both + gameOnly + oursOnly) ? 100 * both / (both + gameOnly + oursOnly) : 100,
		exactRgbPct: pct(exact),
		noDecalRgbPct: pct(noDecal),
	};
}
