#!/usr/bin/env node
/* global process, Buffer */
// Cut pixel-regression fixtures out of existing ground-truth dumps, and measure
// the tier-1 thresholds that go with them.
//
//   node tools/regression_capture.mjs list
//   node tools/regression_capture.mjs sources
//   node tools/regression_capture.mjs add --name NAME --source SRC --rect x,y,w,h \
//        --guards "one line: what this fixture protects" [--tier1 airMask|fillMask|materials|none]
//        [--tier1-mode exact|agreement] [--chunk cx,cy] [--tier2 airMask|rgb|none]
//        [--tier2-mode exact|agreement] [--layers debug-layer-custom-art=1,...]
//   node tools/regression_capture.mjs recut [names...]        re-cut .bin from the dump
//   node tools/regression_capture.mjs check [names...]        measure tier 1, print, write nothing
//   node tools/regression_capture.mjs baseline [names...]     measure tier 1 and WRITE thresholds
//        [--margin=0.5]                                        (alias: --rebaseline)
//
// The dumps themselves are not in the repo (scripts/ is gitignored, the surface
// ground truth lives under ~/reverse/noita/groundtruth). They are registered in
// test/fixtures/regression/sources.json with their world rect and capture date;
// `add`/`recut` are the only things that read them. Tier-2 (GL) thresholds are
// measured by test/gl_regression.mjs --rebaseline, which needs a browser.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readPPM, readPGM16, readMatlist, isDumpAir } from '../test/helpers/netpbm.mjs';
import { FIXTURE_DIR, fixtureNames, loadFixture } from '../test/helpers/fixtures.mjs';
import { evaluateTier1, cellOf } from '../test/helpers/tier1.mjs';
import { engineWorld } from '../test/helpers/generate.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SOURCES = JSON.parse(readFileSync(`${FIXTURE_DIR}sources.json`, 'utf8'));

const argv = process.argv.slice(2);
const cmdArg = argv.find(a => !a.startsWith('-'));
const flag = (n, d = null) => {
	const eq = argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
	if (!eq) return d;
	if (eq.includes('=')) return eq.slice(n.length + 3);
	const i = argv.indexOf(eq);
	return argv[i + 1] ?? d;
};
const has = (n) => argv.some(a => a === `--${n}` || a.startsWith(`--${n}=`));
const nums = (s) => s.split(',').map(Number);

const abs = (p) => (p.startsWith('/') ? p : `${REPO}/${p}`);

function gitHead() {
	try { return execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
	catch { return 'unknown'; }
}
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- cutting ---

/** Cuts a world rect out of a registered dump -> {format, bytes, palette, summary}. */
function cutRect(srcKey, rect) {
	const src = SOURCES[srcKey];
	if (!src) throw new Error(`unknown source "${srcKey}" (see sources.json)`);
	const [x, y, w, h] = rect;
	if (src.kind === 'mapdump-ppm') {
		const [sx, sy, sw, sh] = src.rect;
		const img = readPPM(abs(src.path));
		if (img.w !== sw || img.h !== sh) throw new Error(`${src.path}: ${img.w}x${img.h} != registered ${sw}x${sh}`);
		if (x < sx || y < sy || x + w > sx + sw || y + h > sy + sh) {
			throw new Error(`rect ${rect} is outside ${srcKey} (${src.rect})`);
		}
		const out = Buffer.alloc(w * h * 3);
		let air = 0;
		const colors = new Map();
		for (let py = 0; py < h; py++) {
			for (let px = 0; px < w; px++) {
				const si = ((y - sy + py) * sw + (x - sx + px)) * 3;
				const di = (py * w + px) * 3;
				out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2];
				if (isDumpAir(img.data, si)) air++;
				const hex = '#' + [0, 1, 2].map(k => img.data[si + k].toString(16).padStart(2, '0')).join('');
				colors.set(hex, (colors.get(hex) || 0) + 1);
			}
		}
		return {
			format: 'rgb8', bytes: out, palette: null,
			summary: {
				airPct: +(100 * air / (w * h)).toFixed(3),
				topColors: Object.fromEntries([...colors].sort((a, b) => b[1] - a[1]).slice(0, 6)),
			},
		};
	}
	if (src.kind === 'matdump-pgm-set' || src.kind === 'matdump-pgm') {
		// A tile set (the surface band, one PGM per 1536px column) and a
		// single-rect PGM differ only in how the tile covering the rect is found.
		let names, img, tile;
		if (src.kind === 'matdump-pgm-set') {
			const dir = abs(src.path);
			const man = JSON.parse(readFileSync(`${dir}/${src.manifest ?? 'manifest.json'}`, 'utf8'));
			names = readMatlist(`${dir}/${src.matlist ?? 'matlist.txt'}`);
			tile = man.tiles.find(t => x >= t.x0 && y >= t.y0 && x + w <= t.x0 + t.w && y + h <= t.y0 + t.h);
			if (!tile) throw new Error(`rect ${rect} spans no single ${srcKey} tile`);
			img = readPGM16(`${dir}/${tile.file}`);
		} else {
			const [sx, sy, sw, sh] = src.rect;
			if (x < sx || y < sy || x + w > sx + sw || y + h > sy + sh) {
				throw new Error(`rect ${rect} is outside ${srcKey} (${src.rect})`);
			}
			names = readMatlist(abs(src.matlist));
			tile = { x0: sx, y0: sy };
			img = readPGM16(abs(src.path));
			if (img.w !== sw || img.h !== sh) throw new Error(`${src.path}: ${img.w}x${img.h} != registered ${sw}x${sh}`);
		}
		const palette = [];
		const index = new Map();
		const out = Buffer.alloc(w * h * 2);
		let air = 0;
		const hist = new Map();
		for (let py = 0; py < h; py++) {
			for (let px = 0; px < w; px++) {
				const id = img.data[(y - tile.y0 + py) * img.w + (x - tile.x0 + px)];
				const name = names.get(id) ?? `id${id}`;
				if (!index.has(name)) { index.set(name, palette.length); palette.push(name); }
				out.writeUInt16LE(index.get(name), (py * w + px) * 2);
				if (name === 'air') air++;
				hist.set(name, (hist.get(name) || 0) + 1);
			}
		}
		return {
			format: 'matpal16', bytes: out, palette,
			summary: {
				airPct: +(100 * air / (w * h)).toFixed(3),
				topMaterials: Object.fromEntries([...hist].sort((a, b) => b[1] - a[1]).slice(0, 6)),
			},
		};
	}
	throw new Error(`unknown source kind ${src.kind}`);
}

function writeFixture(meta, bytes) {
	writeFileSync(`${FIXTURE_DIR}${meta.expected.file}`, bytes);
	writeFileSync(`${FIXTURE_DIR}${meta.name}.json`, JSON.stringify(meta, null, '\t') + '\n');
}

// ------------------------------------------------------------------ verbs ---

async function add() {
	const name = flag('name');
	const srcKey = flag('source');
	const rect = nums(flag('rect'));
	const guards = flag('guards');
	if (!name || !srcKey || rect.length !== 4 || !guards) {
		throw new Error('add needs --name --source --rect x,y,w,h --guards "..."');
	}
	const src = SOURCES[srcKey];
	const cut = cutRect(srcKey, rect);
	const world = { x: rect[0], y: rect[1], w: rect[2], h: rect[3] };
	const eng = await engineWorld({ seed: src.seed, ngPlus: src.ngPlus ?? 0 });
	const chunkCells = (flag('chunk') ? [nums(flag('chunk'))] : [cellOf(world.x, world.y, eng.W)]);
	const meta = {
		name,
		guards,
		seed: src.seed,
		ngPlus: src.ngPlus ?? 0,
		world,
		source: { key: srcKey, ...src },
		expected: { file: `${name}.bin`, format: cut.format, ...(cut.palette ? { palette: cut.palette } : {}) },
		summary: cut.summary,
		tier1: {
			chunkFlags: chunkCells.map(cell => ({ cell })),
			pixels: {
				metric: flag('tier1', cut.format === 'matpal16' ? 'materials' : 'airMask'),
				mode: flag('tier1-mode', 'agreement'),
				threshold: null, measured: null, measuredAt: null, measuredCommit: null,
			},
			maxUnresolvedPct: null,
		},
		tier2: {
			render: { layers: Object.fromEntries((flag('layers', '') || '').split(',').filter(Boolean)
				.map(kv => { const [k, v] = kv.split('='); return [k, v !== '0']; })) },
			checks: [{
				metric: flag('tier2', 'airMask'),
				mode: flag('tier2-mode', 'agreement'),
				threshold: null, measured: null, measuredAt: null, measuredCommit: null,
			}],
		},
	};
	// Fill in the observed chunk classification so the fixture pins it.
	const t1 = await evaluateTier1({ ...meta, ...(cut.format === 'rgb8'
		? { rgb: new Uint8Array(cut.bytes) }
		: { pal: new Uint16Array(cut.bytes.buffer, cut.bytes.byteOffset, world.w * world.h) }) });
	meta.tier1.chunkFlags = t1.flags.map(({ got }) => got);
	writeFixture(meta, cut.bytes);
	console.log(`added ${name}: ${world.w}x${world.h} at (${world.x},${world.y}) from ${srcKey}, ` +
		`${cut.format}, air ${cut.summary.airPct}%`);
	console.log('  chunk:', JSON.stringify(meta.tier1.chunkFlags[0]));
}

function recut(names) {
	for (const name of names) {
		const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'));
		const { x, y, w, h } = meta.world;
		const cut = cutRect(meta.source.key, [x, y, w, h]);
		meta.expected.format = cut.format;
		if (cut.palette) meta.expected.palette = cut.palette;
		meta.summary = cut.summary;
		writeFixture(meta, cut.bytes);
		console.log(`recut ${name} from ${meta.source.key}`);
	}
}

async function measure(names, { write }) {
	const margin = Number(flag('margin', '0.5'));
	const commit = gitHead();
	const rows = [];
	let fail = 0;
	for (const name of names) {
		const f = loadFixture(name);
		const r = await evaluateTier1(f);
		const badFlags = r.flags.filter(fl => fl.bad.length);
		const pct = r.pixels ? r.pixels.pct : null;
		if (write) {
			const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'));
			meta.tier1.chunkFlags = r.flags.map(fl => fl.got);
			if (pct !== null) {
				meta.tier1.pixels.measured = +pct.toFixed(3);
				meta.tier1.pixels.measuredAt = today();
				meta.tier1.pixels.measuredCommit = commit;
				meta.tier1.pixels.threshold = meta.tier1.pixels.mode === 'exact'
					? 100 : Math.max(0, +(pct - margin).toFixed(2));
			}
			meta.tier1.maxUnresolvedPct = Math.min(100, +(r.unresolvedPct + margin).toFixed(2));
			writeFileSync(`${FIXTURE_DIR}${name}.json`, JSON.stringify(meta, null, '\t') + '\n');
		}
		// `baseline` has just rewritten the flags, so a diff there is the update,
		// not a failure; only `check` reports it as one.
		const flagState = badFlags.length
			? `FLAGS ${write ? 'UPDATED' : 'DIFFER'} (${badFlags.map(b => b.bad.map(([k]) => k).join('/')).join(' ')})`
			: 'flags ok';
		if (badFlags.length && !write) fail++;
		rows.push([name, r.metric, pct === null ? '-' : pct.toFixed(2) + '%',
			r.unresolvedPct.toFixed(1) + '%', flagState, r.pixels?.top ?? '']);
	}
	const wid = [0, 1, 2, 3, 4].map(i => Math.max(...rows.map(r => String(r[i]).length)));
	for (const r of rows) {
		console.log(r.slice(0, 5).map((c, i) => String(c).padEnd(wid[i])).join('  ')
			+ (r[5] ? `  ${String(r[5]).slice(0, 70)}` : ''));
	}
	return fail;
}

const cmd = cmdArg ?? (has('rebaseline') ? 'baseline' : 'check');
const rest = argv.filter(a => !a.startsWith('-') && a !== cmd);
const targets = rest.length ? rest : fixtureNames();

if (!existsSync(FIXTURE_DIR)) throw new Error(`no fixture dir at ${FIXTURE_DIR}`);
if (cmd === 'list') {
	for (const n of fixtureNames()) {
		const f = loadFixture(n);
		console.log(`${n.padEnd(32)} ${String(f.world.w) + 'x' + f.world.h} @ (${f.world.x},${f.world.y})  ` +
			`[${f.source.key}]  ${f.guards}`);
	}
} else if (cmd === 'sources') {
	for (const [k, s] of Object.entries(SOURCES)) {
		console.log(`${k.padEnd(24)} ${s.kind.padEnd(16)} ${existsSync(abs(s.path)) ? 'present' : 'MISSING'}  ` +
			`${s.path}  ${s.rect ? `rect ${s.rect}` : ''} captured ${s.captured}`);
	}
} else if (cmd === 'add') {
	await add();
} else if (cmd === 'recut') {
	recut(targets);
} else if (cmd === 'check' || cmd === 'baseline') {
	const fail = await measure(targets, { write: cmd === 'baseline' });
	if (fail) process.exitCode = 1;
} else {
	throw new Error(`unknown command "${cmd}"`);
}
