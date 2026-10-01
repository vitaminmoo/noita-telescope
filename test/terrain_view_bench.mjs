#!/usr/bin/env node
/* global process */
// Load / pan / zoom benchmark of js/terrain_view.js, through the minimal host
// page (test/terrain_view_host/) in headless Chrome.
//
// It measures the interface itself, not telescope's page: what any host pays to
// get a seed on screen and to move around it. Not part of `node --test` -- it
// needs Chrome, a GPU worth timing and a quiet machine. Run it on demand:
//
//   systemd-run --user --quiet --collect --pipe --wait --slice=claude-limit.slice \
//     -p MemoryMax=10G --working-directory=$PWD \
//     /usr/bin/node test/terrain_view_bench.mjs [--only=cold,reseed,...] [--json=out.json]
//
// (plain `node` makes headless Chrome SIGTRAP in this environment.)
//
// Scenarios (--only, comma separated; default all):
//   cold      a fresh browser opens the page on a seed: every load step's time,
//             and when each milestone happened since navigation
//   return    a browser that has been here before opens the page again (same
//             profile: HTTP cache and compiled code on disk), under each cache
//             policy the server can stand in for and with a round trip of
//             latency per request. This is the load the page-load objective
//             (2 s) is about: complete view, every scene, three worlds
//   reseed    the same page loads other seeds: what a seed costs once assets,
//             workers and the GL program are warm
//   moving    scripted pan and zoom on the loaded world: frame intervals and
//             draw times, and how many frames were missing scenes
//   loading   the same path while a new seed is loading: how far the load
//             holds up the frames
//   ops       one settled view drawn with each operation switched off in turn,
//             GPU included: what the terrain pass, the scene passes, material
//             texels, edge noise and the engine resolve each cost
//   steps     loads with whole steps left out (no scenes, scans on the main
//             thread, no translations): what each adds to a load
//
// Flags: --seed=786433191 --w=1920 --h=1080 --angle=vulkan (or gl, swiftshader)
//        --runs=3 (cold, return and reseed repeats)  --fit=3 (parallel worlds framed)
//        --latency=20 (ms per request in the return scenario's second pass)
import { rmSync, writeFileSync } from 'node:fs';
import { openPage, sleep, startServer } from './helpers/drive.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const SEED = Number(flag('seed', '786433191'));
const W = Number(flag('w', '1920')), H = Number(flag('h', '1080'));
const ANGLE = flag('angle', 'vulkan');
const RUNS = Number(flag('runs', '3'));
const FIT = Number(flag('fit', '3'));
const JSON_OUT = flag('json', null);
const LATENCY = Number(flag('latency', '20'));
const ONLY = flag('only', 'cold,return,reseed,moving,loading,ops,steps').split(',');
// frame_slo.js's: opening the page, and a new seed on a page already up.
const PAGE_BUDGET_MS = 2000, SEED_BUDGET_MS = 1000;
const verdict = (ms, budget) => (ms <= budget ? 'within' : `${f0(ms - budget)} ms over`);

const HOST = '/test/terrain_view_host/index.html';

const sorted = (a) => [...a].sort((x, y) => x - y);
const pct = (a, p) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const med = (a) => pct(a, 0.5);
const f1 = (v) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(1));
const f0 = (v) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(0));

function table(title, head, rows) {
	const all = [head, ...rows].map(r => r.map(String));
	const wid = head.map((_, i) => Math.max(...all.map(r => r[i].length)));
	console.log(`\n${title}`);
	for (const [n, r] of all.entries()) {
		console.log('  ' + r.map((c, i) => (i === 0 ? c.padEnd(wid[i]) : c.padStart(wid[i]))).join('  '));
		if (n === 0) console.log('  ' + wid.map(w => '-'.repeat(w)).join('  '));
	}
}

/** The load's phases against their budgets (the host's frameSlo.load record). */
function phaseTable(title, runs) {
	const phases = runs[0].timings.load?.phases;
	if (!phases?.length) return;
	table(`${title}: ms per phase against its budget (median)`, ['phase', 'ms', 'budget', ''],
		phases.map((p, i) => {
			const ms = med(runs.map(r => r.timings.load.phases[i].ms));
			return [p.name, f0(ms), p.budgetMs ?? '-', p.budgetMs == null ? '' : verdict(ms, p.budgetMs)];
		}));
}

/** Waits for the page's own load (auto=1) and returns { timings, timeline }. */
async function waitLoaded(d, what = 'terrainHost.loaded') {
	for (let i = 0; i < 240; i++) {
		const r = await d.evalIn(`(async () => {
			const h = window.terrainHost;
			if (!h || !h.loaded) return null;
			return Promise.race([
				h.loaded.then(t => ({ timings: t, timeline: h.timeline }), e => ({ error: String(e?.stack ?? e) })),
				new Promise(r => setTimeout(() => r(null), 400)),
			]);
		})()`);
		if (r?.error) throw new Error(`${what} failed in the page: ${r.error}`);
		if (r) return r;
		await sleep(100);
	}
	const state = await d.evalIn(`(() => { const h = window.terrainHost; return h && {
		timeline: h.timeline.map(m => m.name + '@' + Math.round(m.t)), pending: h.view.pending(), failed: h.view.failed }; })()`)
		.catch(e => `page not answering: ${e.message}`);
	throw new Error(`${what} did not finish: ${JSON.stringify(state)}\n  errors: ${d.errors.slice(0, 3).join(' | ')}\n  logs: ${d.logs.slice(0, 6).join(' | ')}`);
}

const mark = (timeline, name, which = 'first') => {
	const hits = timeline.filter(m => m.name === name);
	if (!hits.length) return null;
	return (which === 'last' ? hits[hits.length - 1] : hits[0]).t;
};

/** Milestones of one load, in ms since `origin` (navigation, or load:start). */
function milestones(timeline, origin) {
	const from = (name, which) => { const t = mark(timeline, name, which); return t == null ? null : t - origin; };
	return {
		hostReady: from('hostReady'),
		assets: from('assets', 'last'),
		generated: from('generated', 'last'),
		terrainFrame: from('firstFrame', 'last'),
		scansDone: from('scansDone', 'last'),
		complete: from('settled', 'last'),
	};
}

const result = { seed: SEED, width: W, height: H, angle: ANGLE, fit: FIT, when: new Date().toISOString() };
const server = await startServer();
const open = (query, opts = {}) => openPage({ port: server.port, path: `${HOST}?${query}`, angle: ANGLE, width: W, height: H, ...opts });

try {
	// --- cold ------------------------------------------------------------------
	if (ONLY.includes('cold')) {
		const runs = [];
		for (let i = 0; i < RUNS; i++) {
			const d = await open(`seed=${SEED}&fit=${FIT}`);
			try {
				const r = await waitLoaded(d);
				const stats = await d.evalIn('window.terrainHost.stats()');
				// What every thread did during the load, as a text chart (js/load_timeline.js).
				const chart = await d.evalIn(`window.frameSlo.timeline('page load', 72)`);
				runs.push({ ...r, chart, milestones: milestones(r.timeline, 0), renderer: stats.renderer, sceneSlots: stats.scenes.slots });
				if (d.errors.length) console.log('page errors:', d.errors.slice(0, 3));
			} finally { d.close(); }
		}
		result.cold = runs;
		result.renderer = runs[0].renderer;
		console.log(`renderer: ${result.renderer}`);
		console.log(`view: ${W}x${H}, ${FIT} parallel worlds framed (${runs[0].timings.worlds.length} worlds in view), `
			+ `${runs[0].sceneSlots} scene bitmaps on screen`);
		const keys = Object.keys(runs[0].milestones);
		table(`cold load: ms since navigation (${RUNS} fresh browsers)`,
			['milestone', 'median', 'min', 'max'],
			keys.map(k => { const v = runs.map(r => r.milestones[k]); return [k, f0(med(v)), f0(Math.min(...v)), f0(Math.max(...v))]; }));
		const steps = [];
		for (const phase of ['assets', 'generate', 'prepareEarly', 'prepare', 'scan', 'settle']) {
			for (const k of Object.keys(runs[0].timings[phase] ?? {})) {
				if (k === 'frames') continue;
				const v = runs.map(r => r.timings[phase]?.[k]).filter(x => typeof x === 'number');
				if (v.length && med(v) >= 0.5) steps.push([`${phase}.${k}`, f1(med(v))]);
			}
		}
		table('cold load: ms per step (median; steps under 0.5 ms left out)', ['step', 'ms'], steps);
		const ms = med(runs.map(r => r.milestones.complete));
		console.log(`  page load objective (${PAGE_BUDGET_MS} ms to the complete view), cold: ${f0(ms)} ms, ${verdict(ms, PAGE_BUDGET_MS)}`);
		phaseTable('cold load', runs);
		console.log(`\ncold load: what each thread did (the last run)\n${runs[runs.length - 1].chart.split('\n').map(l => '  ' + l).join('\n')}`);
	}

	// --- return ----------------------------------------------------------------
	if (ONLY.includes('return')) {
		const configs = [
			{ name: 'revalidate everything (as deployed)', cache: 'no-cache', latencyMs: 0 },
			{ name: `revalidate everything, ${LATENCY} ms per request`, cache: 'no-cache', latencyMs: LATENCY },
			{ name: 'immutable files', cache: 'immutable', latencyMs: 0 },
			{ name: `immutable files, ${LATENCY} ms per request`, cache: 'immutable', latencyMs: LATENCY },
		];
		const res = {};
		for (const cfg of configs) {
			const srv = await startServer({ cache: cfg.cache, latencyMs: cfg.latencyMs });
			const runs = [];
			try {
				for (let i = 0; i < RUNS; i++) {
					const profile = `/tmp/telescope-return-${process.pid}-${Math.random().toString(36).slice(2)}`;
					const visit = async () => {
						const d = await openPage({ port: srv.port, path: `${HOST}?seed=${SEED}&fit=${FIT}`, angle: ANGLE, width: W, height: H, profile });
						try { return await waitLoaded(d); } finally { await d.quit(); }
					};
					await visit();
					await srv.stats(true);
					const r = await visit();
					runs.push({ ...r, milestones: milestones(r.timeline, 0), net: await srv.stats() });
					rmSync(profile, { recursive: true, force: true });
				}
			} finally { srv.stop(); }
			res[cfg.name] = runs;
		}
		result.return = res;
		const keys = ['hostReady', 'assets', 'generated', 'terrainFrame', 'scansDone', 'complete'];
		table(`return visit, same browser profile: median ms since navigation (${RUNS} runs each); requests the server saw`,
			['cache policy', ...keys, 'requests', '304s', 'KB sent'],
			Object.entries(res).map(([name, runs]) => [name, ...keys.map(k => f0(med(runs.map(r => r.milestones[k])))),
				f0(med(runs.map(r => r.net.requests))), f0(med(runs.map(r => r.net.notModified))), f0(med(runs.map(r => r.net.bytes)) / 1024)]));
		for (const [name, runs] of Object.entries(res)) {
			const ms = med(runs.map(r => r.milestones.complete));
			console.log(`  page load objective (${PAGE_BUDGET_MS} ms to the complete view), ${name}: ${f0(ms)} ms, ${verdict(ms, PAGE_BUDGET_MS)}`);
		}
		phaseTable(`return visit, ${Object.keys(res)[0]}`, Object.values(res)[0]);
	}

	// Everything else shares one warm page.
	const needPage = ['reseed', 'moving', 'loading', 'ops', 'steps'].some(s => ONLY.includes(s));
	if (needPage) {
		const d = await open(`seed=${SEED}&fit=${FIT}`);
		try {
			await waitLoaded(d);
			result.renderer ??= (await d.evalIn('window.terrainHost.stats()')).renderer;

			const load = async (opts) => {
				const r = await d.evalIn(`(async () => {
					const h = window.terrainHost;
					const t = await h.load(${JSON.stringify(opts)});
					return { timings: t, timeline: h.timeline };
				})()`);
				const origin = mark(r.timeline, 'load:start', 'last');
				return { ...r, milestones: milestones(r.timeline.filter(m => m.t >= origin), origin) };
			};

			// --- reseed ----------------------------------------------------------
			if (ONLY.includes('reseed')) {
				const runs = [];
				for (let i = 0; i < RUNS; i++) runs.push(await load({ seed: SEED + 1 + i, fit: FIT }));
				result.reseed = runs;
				const keys = ['generated', 'terrainFrame', 'scansDone', 'complete'];
				table(`new seed on a warm page: ms since the load began (${RUNS} seeds)`,
					['milestone', 'median', 'min', 'max'],
					keys.map(k => { const v = runs.map(r => r.milestones[k]); return [k, f0(med(v)), f0(Math.min(...v)), f0(Math.max(...v))]; }));
				const steps = [];
				for (const phase of ['generate', 'prepare', 'scan', 'settle']) {
					for (const k of Object.keys(runs[0].timings[phase] ?? {})) {
						if (k === 'frames') continue;
						const v = runs.map(r => r.timings[phase]?.[k]).filter(x => typeof x === 'number');
						if (v.length && med(v) >= 0.5) steps.push([`${phase}.${k}`, f1(med(v))]);
					}
				}
				table('new seed on a warm page: ms per step (median)', ['step', 'ms'], steps);
				const ms = med(runs.map(r => r.milestones.complete));
				console.log(`  new seed objective (${SEED_BUDGET_MS} ms to the complete view): ${f0(ms)} ms, ${verdict(ms, SEED_BUDGET_MS)}`);
				phaseTable('new seed', runs);
				await load({ seed: SEED, fit: FIT });
			}

			// World-space camera paths around the main world's mines and vault.
			const overview = { x: 0, y: 12288 - 14 * 512, zoom: W / (FIT * 35840) };
			const paths = {
				'pan at the overview': [overview, { ...overview, x: 20000, ms: 1500 }, { ...overview, ms: 1500 }],
				'zoom in to 1:1': [overview, { x: 600, y: 2600, zoom: 1, ms: 2500 }],
				'pan at 1:1': [{ x: 600, y: 2600, zoom: 1 }, { x: 4600, y: 2600, zoom: 1, ms: 2000 }, { x: 4600, y: 6600, zoom: 1, ms: 2000 }],
				'zoom out to the overview': [{ x: 4600, y: 6600, zoom: 1 }, { ...overview, ms: 2500 }],
			};
			const playRows = (res) => Object.entries(res).map(([name, r]) => [
				name, r.dt.length, f1(med(r.dt)), f1(pct(r.dt, 0.95)), f1(Math.max(...r.dt)),
				r.dt.filter(x => x > 20).length, f1(med(r.draw)), f1(Math.max(...r.draw)), r.incomplete,
			]);
			const playHead = ['path', 'frames', 'dt med', 'dt p95', 'dt max', '>20ms', 'draw med', 'draw max', 'incomplete'];

			// --- moving ----------------------------------------------------------
			if (ONLY.includes('moving')) {
				const res = {};
				for (const pass of ['first', 'again']) {
					res[pass] = {};
					for (const [name, keys] of Object.entries(paths)) {
						res[pass][name] = await d.evalIn(`window.terrainHost.playPath(${JSON.stringify(keys)})`);
					}
				}
				result.moving = res;
				table('moving on the loaded world, first time over the path (ms; "incomplete" = frames drawn with scenes still building)',
					playHead, playRows(res.first));
				table('the same path again (scene bitmaps now cached)', playHead, playRows(res.again));
			}

			// --- loading ---------------------------------------------------------
			if (ONLY.includes('loading')) {
				const keys = [overview, { ...overview, x: 20000, ms: 1200 }, { x: 600, y: 2600, zoom: 0.25, ms: 1200 }, { ...overview, ms: 1200 }];
				const r = await d.evalIn(`(async () => {
					const h = window.terrainHost;
					const loading = h.load({ seed: ${SEED + 100}, fit: 0, settle: true });
					const path = await h.playPath(${JSON.stringify(keys)});
					await loading;
					return path;
				})()`);
				result.loading = r;
				table('pan and zoom while a new seed loads (ms)', playHead, playRows({ 'overview pan, zoom, back': r }));
				const worst = sorted(r.dt).slice(-5).reverse().map(f0).join(', ');
				console.log(`  longest frame intervals: ${worst} ms`);
				await load({ seed: SEED, fit: FIT });
			}

			// --- ops -------------------------------------------------------------
			if (ONLY.includes('ops')) {
				const views = {
					[`overview (${FIT} worlds)`]: overview,
					'1:4': { x: 600, y: 2600, zoom: 0.25 },
					'1:1': { x: 600, y: 2600, zoom: 1 },
				};
				const variants = {
					'everything': {},
					'terrain only': { scenes: false },
					'scenes only': { terrain: false },
					'scenes: air pass only': { terrain: false, sceneColor: false },
					'scenes: colour pass only': { terrain: false, sceneAir: false },
					'no material texels': { materialTextures: false },
					'no edge noise': { edgeNoise: false },
					'no edge decals': { edgeDecals: false },
					'1/10 palette terrain': { engineTerrain: false },
				};
				const res = {};
				for (const [vname, v] of Object.entries(views)) {
					res[vname] = {};
					await d.evalIn(`(async () => { const h = window.terrainHost; h.setView(${JSON.stringify(v)}); await h.settle(); return true; })()`);
					for (const [oname, ops] of Object.entries(variants)) {
						res[vname][oname] = await d.evalIn(`window.terrainHost.measureFrames(30, ${JSON.stringify(ops)})`);
					}
					// The engine-off run rebuilt the resources; put them back.
					await d.evalIn('(async () => { const h = window.terrainHost; h.draw(); await h.settle(); return true; })()');
				}
				result.ops = res;
				table('one settled frame, main thread + GPU, by what is drawn (median ms of 30)',
					['operations', ...Object.keys(views)],
					Object.keys(variants).map(o => [o, ...Object.keys(views).map(v => f1(med(res[v][o])))]));
			}

			// --- steps -----------------------------------------------------------
			if (ONLY.includes('steps')) {
				const variants = {
					'everything (scans in workers)': {},
					'scans on the main thread': { scan: 'main' },
					'terrain only (no scans, no scenes)': { pws: [] },
					'no translations': { translations: false },
				};
				const res = {};
				let n = 200;
				for (const [name, opts] of Object.entries(variants)) {
					const runs = [];
					for (let i = 0; i < RUNS; i++) runs.push(await load({ seed: SEED + (n++), fit: FIT, ...opts }));
					res[name] = runs;
				}
				result.steps = res;
				const keys = ['generated', 'terrainFrame', 'scansDone', 'complete'];
				table(`new seed on a warm page with steps left out: median ms since the load began (${RUNS} seeds each)`,
					['load', ...keys],
					Object.entries(res).map(([name, runs]) => [name, ...keys.map(k => f0(med(runs.map(r => r.milestones[k]))))]));
			}
			if (d.errors.length) console.log('\npage errors:', d.errors.slice(0, 5));
			if (d.logs.length) console.log('\npage warnings:', d.logs.slice(0, 8));
		} finally { d.close(); }
	}
	if (JSON_OUT) {
		writeFileSync(JSON_OUT, JSON.stringify(result, null, '\t') + '\n');
		console.log(`\nwrote ${JSON_OUT}`);
	}
} finally {
	server.stop();
}
