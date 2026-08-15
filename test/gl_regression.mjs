#!/usr/bin/env node
/* global process, Buffer */
// Tier 2 of the pixel regression harness: render every fixture rect 1:1 through
// the real GL terrain pipeline in a headless browser and compare the pixels
// against the game's own dump.
//
// Not part of `node --test test/*.test.mjs` — it needs Chrome, ~40s of world
// generation, and a server. Run it on demand:
//
//   systemd-run --user --quiet --collect --pipe --wait --slice=claude-limit.slice \
//     -p MemoryMax=10G --working-directory=/home/vitaminmoo/repos/noita-telescope \
//     /usr/bin/node test/gl_regression.mjs [names...] [--rebaseline] [--margin=0.5] [--png DIR]
//
// (plain `node` makes headless Chrome SIGTRAP in this environment.)
//
// It starts its own dev server on a random free port, so it does not care
// whether the shared one on :8767 is busy, and kills only what it spawned.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import UPNG from 'upng-js';
import { startServer, drive, sleep } from './helpers/drive.mjs';
import {
	FIXTURE_DIR, fixtureNames, loadFixture, expectedAirMask, agreement, rgbAgreement, verdict,
} from './helpers/fixtures.mjs';
import { isRenderAir } from './helpers/netpbm.mjs';

const argv = process.argv.slice(2);
const flagVal = (n, d) => {
	const a = argv.find(s => s.startsWith(`--${n}=`));
	return a ? a.slice(n.length + 3) : d;
};
const REBASELINE = argv.includes('--rebaseline');
const MARGIN = Number(flagVal('margin', '0.5'));
const PNG_DIR = flagVal('png', null);
const only = argv.filter(a => !a.startsWith('-'));
const names = only.length ? only : fixtureNames();
if (!names.length) { console.error('no fixtures'); process.exit(1); }

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const gitHead = () => {
	try { return execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
	catch { return 'unknown'; }
};

// Terrain-only baseline: the fixtures are ground truth for the world's cells,
// not for background art, atmosphere or debug overlays. A fixture can flip any
// of these through its own tier2.render.layers.
const BASE_LAYERS = {
	'debug-layer-biome-background': false,
	'debug-layer-custom-art': false,
	'debug-layer-atmosphere': false,
	'debug-layer-alpha-mask': false,
	'debug-layer-tile-overlays': true,
	'debug-layer-pixel-scenes': true,
	'debug-layer-debug-boxes': false,
	'debug-layer-secrets': false,
	'debug-layer-misc': false,
};

const fixtures = names.map(loadFixture);
const seeds = new Set(fixtures.map(f => `${f.seed}|${f.ngPlus ?? 0}`));
if (seeds.size !== 1) throw new Error(`fixtures span several worlds (${[...seeds]}); run them per seed`);
const [seed, ng] = [...seeds][0].split('|').map(Number);

const server = await startServer();
let d = null;
try {
	d = await drive({ port: server.port, seed, ng });
	await d.evalIn(`(async () => {
		const s = await import('/js/settings.js');
		s.appSettings.terrainRenderer = 'gl';
		s.appSettings.engineTerrain = true;
		s.appSettings.checkerboardUnpainted = false;
		const cb = document.getElementById('debug-unpainted-checkerboard');
		if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
		return true;
	})()`);

	const rows = [];
	let failures = 0;
	if (PNG_DIR) mkdirSync(PNG_DIR, { recursive: true });

	for (const f of fixtures) {
		const layers = { ...BASE_LAYERS, ...(f.tier2?.render?.layers ?? {}) };
		const { x, y, w, h } = f.world;
		await d.evalIn(`(async () => {
			for (const [id, on] of ${JSON.stringify(Object.entries(layers))}) {
				const el = document.getElementById(id);
				if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change')); }
			}
			const m = await import('/js/app.js');
			const u = await import('/js/utils.js');
			m.app.canvas.width = ${w}; m.app.canvas.height = ${h};
			m.app.cam.x = ${x + w / 2} + 512 * u.getWorldCenter(m.app.isNGP, m.app.gameMode);
			m.app.cam.y = ${y + h / 2} + 512 * 14;
			m.app.cam.z = 1;
			m.app.drawNow();
			return true;
		})()`);
		await sleep(2500);
		const dataUrl = await d.evalIn(`(async () => {
			const m = await import('/js/app.js');
			m.app.drawNow();
			await new Promise(r => setTimeout(r, 400));
			return m.app.canvas.toDataURL('image/png');
		})()`);
		const png = Buffer.from(dataUrl.split(',')[1], 'base64');
		if (PNG_DIR) writeFileSync(`${PNG_DIR}/${f.name}.png`, png);
		const img = UPNG.decode(png);
		if (img.width !== w || img.height !== h) throw new Error(`${f.name}: rendered ${img.width}x${img.height}, want ${w}x${h}`);
		const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);

		const wantAir = expectedAirMask(f);
		const gotAir = new Array(w * h);
		for (let i = 0; i < w * h; i++) gotAir[i] = isRenderAir(rgba, i * 4) ? 'air' : 'solid';
		const rgb = f.rgb ? rgbAgreement(f.rgb, rgba, w * h, wantAir) : null;
		const measured = {
			airMask: agreement(Array.from(wantAir, a => (a ? 'air' : 'solid')), gotAir),
			// An all-air rect has no terrain colors to compare; only its mask.
			rgb: rgb && rgb.n > 0 ? rgb : null,
		};

		const checks = f.tier2?.checks ?? [];
		for (const metric of ['airMask', 'rgb']) {
			const m = measured[metric];
			if (!m) continue;
			const c = checks.find(k => k.metric === metric);
			if (!c || c.threshold === null) {
				rows.push([f.name, metric, `${m.pct.toFixed(3)}%`, 'info', 'no baseline yet']);
				continue;
			}
			const v = verdict(c, m.pct);
			if (!v.pass) failures++;
			rows.push([f.name, metric, `${m.pct.toFixed(3)}%`, v.pass ? 'pass' : 'FAIL',
				v.why + (v.pass ? '' : `  ${m.top}`)]);
		}

		if (REBASELINE) {
			const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${f.name}.json`, 'utf8'));
			meta.tier2.checks = ['airMask', 'rgb'].filter(k => measured[k]).map((k) => {
				const prev = (meta.tier2.checks ?? []).find(c => c.metric === k) ?? { metric: k, mode: 'agreement' };
				const pct = measured[k].pct;
				return {
					...prev,
					measured: +pct.toFixed(3),
					measuredAt: new Date().toISOString().slice(0, 10),
					measuredCommit: gitHead(),
					threshold: prev.mode === 'exact' ? 100 : Math.max(0, +(pct - MARGIN).toFixed(2)),
				};
			});
			writeFileSync(`${FIXTURE_DIR}${f.name}.json`, JSON.stringify(meta, null, '\t') + '\n');
		}
	}

	const wid = [0, 1, 2, 3].map(i => Math.max(...rows.map(r => String(r[i]).length)));
	console.log('\nfixture'.padEnd(wid[0] + 1) + '  metric'.padEnd(wid[1] + 2) + '  agreement  verdict');
	for (const r of rows) {
		console.log(r.slice(0, 4).map((c, i) => String(c).padEnd(wid[i])).join('  ') + (r[4] ? `  ${r[4]}` : ''));
	}
	if (d.errors.length) console.log(`\npage errors: ${d.errors.length}\n  ${d.errors.slice(0, 3).join('\n  ')}`);
	console.log(`\n${rows.length} checks, ${failures} failing${REBASELINE ? ' (thresholds rewritten)' : ''}`);
	if (failures) process.exitCode = 1;
} finally {
	if (d) d.close();
	server.stop();
}
