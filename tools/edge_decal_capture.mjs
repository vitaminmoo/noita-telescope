#!/usr/bin/env node
/* global process, Buffer */
// Cut edge-decal fixtures out of a BAKEDUMP/MAPDUMP/MATDUMP triple, and measure
// the baselines that go with them.
//
//   node tools/edge_decal_capture.mjs add --name NAME --source SRC \
//        --rect x,y,w,h --guards "one line: what this fixture protects" [--halo 32]
//   node tools/edge_decal_capture.mjs recut [names...]     re-cut the planes
//   node tools/edge_decal_capture.mjs check [names...]     measure, write nothing
//   node tools/edge_decal_capture.mjs baseline [names...]  measure and WRITE
//        [--margin=0.5]                                    (alias: --rebaseline)
//
// `--source` names a BAKEDUMP entry in test/fixtures/regression/sources.json
// (kind `bakedump-ppm`); its `map` and `mat` fields point at the MAPDUMP and
// MATDUMP of the SAME rect from the SAME worker, which is what makes
// "baked != map inside a solid cell" mean "the engine stamped here".
//
// The dumps are not in the repo (they live under ~/reverse/noita/groundtruth);
// only this tool reads them. See test/fixtures/edge_decals/README.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readPPM, readPGM16, readMatlist } from '../test/helpers/netpbm.mjs';
import { FIXTURE_DIR, decalFixtureNames, loadDecalFixture, evaluateDecalFixture } from '../test/helpers/edge_decals.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SOURCES = JSON.parse(readFileSync(`${REPO}/test/fixtures/regression/sources.json`, 'utf8'));

const argv = process.argv.slice(2);
const cmdArg = argv.find(a => !a.startsWith('-'));
const flag = (n, d = null) => {
	const eq = argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
	if (!eq) return d;
	if (eq.includes('=')) return eq.slice(n.length + 3);
	return argv[argv.indexOf(eq) + 1] ?? d;
};
const has = (n) => argv.some(a => a === `--${n}` || a.startsWith(`--${n}=`));
const abs = (p) => (p.startsWith('/') ? p : `${REPO}/${p}`);
const today = () => new Date().toISOString().slice(0, 10);
const gitHead = () => {
	try { return execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
	catch { return 'unknown'; }
};

/** Cuts the three planes a decal fixture needs out of one capture triple. */
function cutRect(srcKey, rect, halo) {
	const src = SOURCES[srcKey];
	if (!src) throw new Error(`unknown source "${srcKey}" (see sources.json)`);
	if (src.kind !== 'bakedump-ppm') throw new Error(`${srcKey} is ${src.kind}, need bakedump-ppm`);
	const [x, y, w, h] = rect;
	const [sx, sy, sw, sh] = src.rect;
	const pw = w + 2 * halo, ph = h + 2 * halo;
	if (x - halo < sx || y - halo < sy || x + w + halo > sx + sw || y + h + halo > sy + sh) {
		throw new Error(`rect ${rect} + halo ${halo} is outside ${srcKey} (${src.rect})`);
	}
	const baked = readPPM(abs(src.path));
	const base = readPPM(abs(src.map));
	const mat = readPGM16(abs(src.mat));
	const names = readMatlist(abs(src.matlist));
	for (const [n, img] of [['baked', baked], ['map', base], ['mat', mat]]) {
		if (img.w !== sw || img.h !== sh) throw new Error(`${srcKey} ${n}: ${img.w}x${img.h} != registered ${sw}x${sh}`);
	}
	// the rect itself: the two colour planes
	const bakedOut = Buffer.alloc(w * h * 3), baseOut = Buffer.alloc(w * h * 3);
	for (let py = 0; py < h; py++) {
		for (let px = 0; px < w; px++) {
			const s = ((y - sy + py) * sw + (x - sx + px)) * 3, d = (py * w + px) * 3;
			for (let k = 0; k < 3; k++) { bakedOut[d + k] = baked.data[s + k]; baseOut[d + k] = base.data[s + k]; }
		}
	}
	// the rect PLUS the halo: the material grid the stamp reads (a stamp can
	// originate up to a sprite's reach outside the rect and paint into it)
	const palette = [], index = new Map();
	const matOut = Buffer.alloc(pw * ph * 2);
	const hist = new Map();
	let air = 0;
	for (let py = 0; py < ph; py++) {
		for (let px = 0; px < pw; px++) {
			const id = mat.data[(y - halo - sy + py) * sw + (x - halo - sx + px)];
			const name = id === 0 ? 'air' : id === 0xffff ? 'nochunk' : (names.get(id) ?? `id${id}`);
			if (!index.has(name)) { index.set(name, palette.length); palette.push(name); }
			matOut.writeUInt16LE(index.get(name), (py * pw + px) * 2);
			hist.set(name, (hist.get(name) || 0) + 1);
			if (name === 'air') air++;
		}
	}
	// how much of the rect the game itself dressed -- the fixture's reason to exist
	let solid = 0, dressed = 0;
	for (let py = 0; py < h; py++) {
		for (let px = 0; px < w; px++) {
			const s = (py + halo) * pw + (px + halo);
			const name = palette[matOut.readUInt16LE(s * 2)];
			if (name === 'air' || name === 'nochunk') continue;
			solid++;
			const d = (py * w + px) * 3;
			if (bakedOut[d] !== baseOut[d] || bakedOut[d + 1] !== baseOut[d + 1] || bakedOut[d + 2] !== baseOut[d + 2]) dressed++;
		}
	}
	return {
		baked: bakedOut, base: baseOut, mat: matOut, palette,
		summary: {
			solidPx: solid,
			gameDressedPx: dressed,
			gameDressedPct: +(100 * dressed / solid).toFixed(3),
			haloAirPct: +(100 * air / (pw * ph)).toFixed(3),
			topMaterials: Object.fromEntries([...hist].sort((a, b) => b[1] - a[1]).slice(0, 6)),
		},
	};
}

function writeFixture(meta, cut) {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(`${FIXTURE_DIR}${meta.expected.baked}`, cut.baked);
	writeFileSync(`${FIXTURE_DIR}${meta.expected.base}`, cut.base);
	writeFileSync(`${FIXTURE_DIR}${meta.expected.mat}`, cut.mat);
	writeFileSync(`${FIXTURE_DIR}${meta.name}.json`, JSON.stringify(meta, null, '\t') + '\n');
}

/** The metric set a decal fixture pins, with nulls until `baseline` fills them. */
const emptyChecks = () => ({
	// the two that say whether the pass is still modelling the right thing
	densityGapPct: { mode: 'max', threshold: null, measured: null, measuredAt: null, measuredCommit: null },
	exactRgbPct: { mode: 'agreement', threshold: null, measured: null, measuredAt: null, measuredCommit: null },
	cellAgreementPct: { mode: 'agreement', threshold: null, measured: null, measuredAt: null, measuredCommit: null },
	// placement overlap: honestly low, and pinned so an improvement is visible
	iouPct: { mode: 'agreement', threshold: null, measured: null, measuredAt: null, measuredCommit: null },
});

async function add() {
	const name = flag('name'), srcKey = flag('source'), guards = flag('guards');
	const rect = (flag('rect') || '').split(',').map(Number);
	const halo = Number(flag('halo', '32'));
	if (!name || !srcKey || rect.length !== 4 || !guards) {
		throw new Error('add needs --name --source --rect x,y,w,h --guards "..."');
	}
	const src = SOURCES[srcKey];
	const cut = cutRect(srcKey, rect, halo);
	const meta = {
		name, guards,
		seed: src.seed, ngPlus: src.ngPlus ?? 0,
		world: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] },
		halo,
		// Chunk boundaries sit where (world + grid shift) is a multiple of 512.
		// Both shifts are whole chunks for every shipped map width, so both are 0
		// here; they are stored rather than assumed (js/overlay_worker.js).
		chunkShiftX: 0, chunkShiftY: 0,
		source: { key: srcKey, ...src },
		expected: {
			baked: `${name}.baked.bin`, base: `${name}.base.bin`, mat: `${name}.mat.bin`,
			format: 'rgb8+rgb8+matpal16', palette: cut.palette,
		},
		summary: cut.summary,
		checks: emptyChecks(),
		note: null,
	};
	writeFixture(meta, cut);
	console.log(`added ${name}: ${rect[2]}x${rect[3]} at (${rect[0]},${rect[1]}) +${halo} halo from ${srcKey}`);
	console.log(`  ${cut.summary.solidPx} solid px, the game dressed ${cut.summary.gameDressedPct}% of them`);
}

function recut(names) {
	for (const name of names) {
		const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'));
		const { x, y, w, h } = meta.world;
		const cut = cutRect(meta.source.key, [x, y, w, h], meta.halo);
		meta.expected.palette = cut.palette;
		// `baseline` records the no-decal ceiling in the summary and `cutRect`
		// cannot recompute it (it takes running the stamp), so carry it across
		// rather than dropping it: a recut must not quietly lose a measurement.
		const noDecal = meta.summary?.noDecalRgbPct;
		meta.summary = { ...cut.summary, ...(noDecal === undefined ? {} : { noDecalRgbPct: noDecal }) };
		writeFixture(meta, cut);
		console.log(`recut ${name} from ${meta.source.key}`);
	}
}

async function measure(names, { write }) {
	const margin = Number(flag('margin', '0.5'));
	const commit = gitHead();
	for (const name of names) {
		const f = loadDecalFixture(name);
		const r = await evaluateDecalFixture(f);
		console.log(`\n${name}  ${f.world.w}x${f.world.h} @(${f.world.x},${f.world.y})  ${r.solid} solid px`);
		console.log(`  decal cells   game ${r.gameDecalPct.toFixed(2)}%   ours ${r.ourDecalPct.toFixed(2)}%  (gap ${r.densityGapPct.toFixed(2)} pp)`);
		console.log(`  our stamps    ${r.stamped} texels, ${r.invisible} of them base-coloured (invisible to the ground truth)`);
		console.log(`  placement     both ${r.both}, game-only ${r.gameOnly}, ours-only ${r.oursOnly}  IoU ${r.iouPct.toFixed(2)}%`);
		console.log(`  cell agree    ${r.cellAgreementPct.toFixed(2)}%`);
		console.log(`  exact RGB     ${r.exactRgbPct.toFixed(2)}%   (stamping nothing at all would score ${r.noDecalRgbPct.toFixed(2)}%)`);
		if (!write) continue;
		const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'));
		const stamp = { measuredAt: today(), measuredCommit: commit };
		for (const k of Object.keys(meta.checks)) {
			const v = r[k];
			if (v === undefined) continue;
			meta.checks[k] = {
				...meta.checks[k], ...stamp, measured: +v.toFixed(3),
				threshold: meta.checks[k].mode === 'max'
					? +(v + margin).toFixed(2)
					: Math.max(0, +(v - margin).toFixed(2)),
			};
		}
		meta.summary.noDecalRgbPct = +r.noDecalRgbPct.toFixed(3);
		writeFileSync(`${FIXTURE_DIR}${name}.json`, JSON.stringify(meta, null, '\t') + '\n');
		console.log('  (baselines written)');
	}
}

const cmd = cmdArg ?? (has('rebaseline') ? 'baseline' : 'check');
const rest = argv.filter(a => !a.startsWith('-') && a !== cmd);
const targets = rest.length ? rest : decalFixtureNames();

if (cmd === 'add') await add();
else if (cmd === 'recut') recut(targets);
else if (cmd === 'list') for (const n of targets) {
	const f = loadDecalFixture(n);
	console.log(`${n.padEnd(28)} ${f.world.w}x${f.world.h} @(${f.world.x},${f.world.y})  [${f.source.key}]  ${f.guards}`);
}
else if (cmd === 'check' || cmd === 'baseline') await measure(targets, { write: cmd === 'baseline' });
else throw new Error(`unknown command "${cmd}"`);
