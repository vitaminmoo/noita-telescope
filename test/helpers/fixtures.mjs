// Loader + comparison primitives for the pixel regression fixtures.
//
// A fixture is a small world rect (32x32 .. 128x128) with the game's own answer
// for it, cut out of a ground-truth dump. Two files per fixture, both committed:
//
//   <name>.json  metadata: world rect, what it guards, dump provenance, and the
//                per-tier comparison mode + threshold (with the measurement the
//                threshold came from)
//   <name>.bin   the expected pixels, either
//                  rgb8      w*h*3 bytes, the game's MAPDUMP colors
//                  matpal16  w*h uint16 LE indices into `expected.palette`,
//                            the game's MATDUMP material names
//
// Nothing here reads the dumps themselves — those live outside the repo (or in
// gitignored scratch dirs) and are only touched by tools/regression_capture.mjs.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { isDumpAir } from './netpbm.mjs';

export const FIXTURE_DIR = new URL('../fixtures/regression/', import.meta.url).pathname;

/** Fixture names, in file order. */
export function fixtureNames() {
	if (!existsSync(FIXTURE_DIR)) return [];
	return readdirSync(FIXTURE_DIR)
		.filter(f => f.endsWith('.json') && f !== 'sources.json')
		.map(f => f.slice(0, -5)).sort();
}

/** Metadata + expected pixels for one fixture. */
export function loadFixture(name) {
	const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'));
	const raw = readFileSync(`${FIXTURE_DIR}${meta.expected.file}`);
	const { w, h } = meta.world;
	if (meta.expected.format === 'rgb8') {
		if (raw.length !== w * h * 3) throw new Error(`${name}: expected ${w * h * 3} bytes, got ${raw.length}`);
		const f = { ...meta, rgb: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) };
		if (meta.expected.air) {
			// exact air mask cut from the rect's MATDUMP twin (1 = air)
			const a = readFileSync(`${FIXTURE_DIR}${meta.expected.air}`);
			if (a.length !== w * h) throw new Error(`${name}: air mask expected ${w * h} bytes, got ${a.length}`);
			f.air = new Uint8Array(a.buffer, a.byteOffset, a.length);
		}
		return f;
	}
	if (meta.expected.format === 'matpal16') {
		if (raw.length !== w * h * 2) throw new Error(`${name}: expected ${w * h * 2} bytes, got ${raw.length}`);
		return { ...meta, pal: new Uint16Array(raw.buffer, raw.byteOffset, w * h) };
	}
	throw new Error(`${name}: unknown format ${meta.expected.format}`);
}

/** All fixtures (optionally filtered by name). */
export function loadFixtures(only = null) {
	const names = fixtureNames().filter(n => !only || only.length === 0 || only.includes(n));
	return names.map(loadFixture);
}

/** Expected material name per pixel — matpal16 fixtures only. */
export function expectedMaterials(f) {
	if (!f.pal) return null;
	const pal = f.expected.palette;
	return Array.from(f.pal, (i) => pal[i]);
}

/** Expected air mask (1 = the game has nothing there), for either format. */
export function expectedAirMask(f) {
	const { w, h } = f.world;
	const out = new Uint8Array(w * h);
	if (f.air) {
		out.set(f.air);
	} else if (f.rgb) {
		for (let i = 0; i < w * h; i++) out[i] = isDumpAir(f.rgb, i * 3) ? 1 : 0;
	} else {
		const pal = f.expected.palette;
		for (let i = 0; i < w * h; i++) out[i] = pal[f.pal[i]] === 'air' ? 1 : 0;
	}
	return out;
}

/**
 * Agreement between two equal-length label arrays, ignoring positions where
 * `skip` is truthy. Returns percent plus the top disagreements, so a failure
 * message can say *what* changed rather than only that something did.
 */
export function agreement(expected, actual, skip = null) {
	let n = 0, same = 0;
	const diffs = new Map();
	for (let i = 0; i < expected.length; i++) {
		if (skip && skip[i]) continue;
		n++;
		if (expected[i] === actual[i]) { same++; continue; }
		const k = `${expected[i]} -> ${actual[i]}`;
		diffs.set(k, (diffs.get(k) || 0) + 1);
	}
	const top = [...diffs].sort((a, b) => b[1] - a[1]).slice(0, 4)
		.map(([k, v]) => `${k} x${v}`).join(', ');
	return { pct: n ? (100 * same / n) : 100, n, same, top };
}

/**
 * Byte-exact RGB agreement between an expected rgb8 buffer and an RGBA render,
 * over the pixels `skip` does not mask out.
 *
 * Callers mask out the game's air: the dump paints an empty cell #050505 (or the
 * sky gradient above ground) while telescope paints its own nothing-here color,
 * so comparing air pixels only measures the two conventions disagreeing. What is
 * worth guarding byte-for-byte is the terrain: material texture lookups are
 * world-position-indexed and therefore reproducible exactly.
 */
export function rgbAgreement(expectedRgb, actualRgba, count, skip = null) {
	let same = 0, n = 0;
	const diffs = new Map();
	for (let i = 0; i < count; i++) {
		if (skip && skip[i]) continue;
		n++;
		const e = i * 3, a = i * 4;
		if (expectedRgb[e] === actualRgba[a] && expectedRgb[e + 1] === actualRgba[a + 1]
			&& expectedRgb[e + 2] === actualRgba[a + 2]) { same++; continue; }
		const hex = (d, o) => '#' + [0, 1, 2].map(k => d[o + k].toString(16).padStart(2, '0')).join('');
		const k = `${hex(expectedRgb, e)} -> ${hex(actualRgba, a)}`;
		diffs.set(k, (diffs.get(k) || 0) + 1);
	}
	const top = [...diffs].sort((a, b) => b[1] - a[1]).slice(0, 4)
		.map(([k, v]) => `${k} x${v}`).join(', ');
	return { pct: n ? (100 * same / n) : 100, n, same, top };
}

/**
 * Verdict for one measured percentage against a fixture check.
 * `exact` demands 100%; `agreement` demands >= threshold (a threshold that was
 * measured, never guessed — see the README).
 */
export function verdict(check, pct) {
	if (!check || check.mode === 'skip') return { pass: true, why: 'skipped' };
	if (check.mode === 'exact') return { pass: pct >= 100, why: `exact (${pct.toFixed(3)}%)` };
	const pass = pct + 1e-9 >= check.threshold;
	return { pass, why: `${pct.toFixed(3)}% vs >= ${check.threshold}%` };
}
