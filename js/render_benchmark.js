// In-app render benchmark (debug panel "Run Render Benchmark").
//
// Flies the camera the way a user does -- synthetic wheel and drag events on
// the canvas, one per animation frame, so the real handlers (hover, bounds,
// draw scheduling, worker requests) all run -- and records what every frame
// cost: the rAF-to-rAF wall time (which is what the eye sees, compositor
// included), drawNow's own time split by render layer, and how long each
// phase's asynchronous work (scene bitmaps, edge-decal tiles) takes to settle
// afterwards. Runs in whatever browser and GPU the page is open in, which is
// the measurement that matters.
//
// Phases: zoom out to about 1.5 world widths, pan a rectangle there, zoom
// back in to life size (1 world px = 1 screen px) at the starting point, pan a
// rectangle there, zoom back out to where the run started.
//
// Every phase and every draw is also a User Timing mark/measure
// ("telescope:bench …"), so a recording in the Firefox Profiler or the Chrome
// Performance panel taken across a run shows the phases as a track and each
// draw as a span, with the browser's own rendering/compositor work alongside.
//
// Results: console.table per phase and per layer, the same as text in the
// debug panel, and the raw samples on app.lastBenchmark (also returned).
import { appSettings } from './settings.js';
import { CHUNK_SIZE } from './constants.js';
import { getWorldSize } from './utils.js';

/** Screen px the drag moves per frame (12 px @ 60 Hz = 720 px/s). */
const DRAG_STEP = 12;
/** Frames per side of the drag rectangle: [right, down, left, up]. */
const DRAG_SIDES = [60, 40, 60, 40];
/** Wall-time cap for each phase's settle wait. */
const SETTLE_TIMEOUT_MS = 20000;

const frame = () => new Promise((r) => requestAnimationFrame(r));
const pct = (a, p) => {
	if (!a.length) return 0;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const r2 = (v) => Math.round(v * 100) / 100;

let running = false;

/**
 * @param {object} app  the app object (js/app.js)
 * @param {{log?: (text:string)=>void}} [opts]  log: also receives the text report
 * @returns {Promise<object|null>} results, or null when a run is already going
 */
export async function runRenderBenchmark(app, opts = {}) {
	if (running || !app.biomeData || !app.tileLayers) return null;
	running = true;
	const canvas = app.canvas;
	const log = opts.log || (() => {});
	const saved = {
		cam: { ...app.cam }, pw: app.pw, pwVertical: app.pwVertical,
		layerTimings: appSettings.debugLayerTimings, layerProfile: app.layerProfile, drawNow: app.drawNow,
	};
	// Per-layer buckets need the profiler on; the wrapper below resets the
	// profile every frame so its once-a-second console report never fires.
	appSettings.debugLayerTimings = true;
	let lastDraw = null;
	app.drawNow = function () {
		this.layerProfile = null;
		const t0 = performance.now();
		saved.drawNow.call(this);
		const t1 = performance.now();
		const layers = {};
		if (this.layerProfile) for (const [k, b] of this.layerProfile.buckets) layers[k] = b.ms;
		lastDraw = { ms: t1 - t0, layers };
		performance.measure('telescope:bench drawNow', { start: t0, end: t1 });
	};

	const rect = () => canvas.getBoundingClientRect();
	const center = () => { const r = rect(); return { x: r.left + canvas.width / 2, y: r.top + canvas.height / 2 }; };
	const worldPx = getWorldSize(app.isNGP, app.gameMode) * CHUNK_SIZE;
	const phases = [];
	let phase = null;

	const beginPhase = (name) => {
		phase = { name, t0: performance.now(), frames: [], draws: [], inputs: [], layers: {}, settleMs: 0, pendingAtEnd: 0 };
		phases.push(phase);
		performance.mark(`telescope:bench ${name} start`);
	};
	// One frame of the run: apply the input, wait for the next animation frame,
	// record what happened in between.
	let lastT = 0;
	const step = async (apply) => {
		lastDraw = null;
		// The synthetic event runs its handlers synchronously (drag maths,
		// hover tooltip, worker requests), so this is the input path's own cost.
		const i0 = performance.now();
		apply();
		phase.inputs.push(performance.now() - i0);
		const t = await frame();
		if (lastT) phase.frames.push(t - lastT);
		lastT = t;
		if (lastDraw) {
			phase.draws.push(lastDraw.ms);
			for (const [k, v] of Object.entries(lastDraw.layers)) (phase.layers[k] ??= []).push(v);
		}
	};
	const endPhase = async () => {
		// Let the worker catch up, drawing as its replies land, and record how
		// long that took: this is the "tiles/scenes still filling in" time.
		const t0 = performance.now();
		while (app.asyncRenderPending() && performance.now() - t0 < SETTLE_TIMEOUT_MS) {
			await new Promise((r) => setTimeout(r, 50));
			await frame();
		}
		phase.settleMs = performance.now() - t0;
		phase.pendingAtEnd = app.asyncRenderPending();
		phase.wallMs = performance.now() - phase.t0;
		performance.mark(`telescope:bench ${phase.name} end`);
		performance.measure(`telescope:bench ${phase.name}`, `telescope:bench ${phase.name} start`, `telescope:bench ${phase.name} end`);
		lastT = 0;
	};

	const wheel = (dir) => {
		const c = center();
		canvas.dispatchEvent(new WheelEvent('wheel', { clientX: c.x, clientY: c.y, deltaY: dir, bubbles: true, cancelable: true }));
	};
	const zoomTo = async (name, target) => {
		beginPhase(name);
		// The wheel handler steps by 1.1 / 0.9 per event, one event per frame.
		let guard = 0;
		while ((target < app.cam.z ? app.cam.z * 0.9 >= target * 0.999 : app.cam.z * 1.1 <= target * 1.001) && guard++ < 400) {
			await step(() => wheel(target < app.cam.z ? 100 : -100));
		}
		await endPhase();
	};
	const dragRect = async (name) => {
		beginPhase(name);
		const c = center();
		let x = c.x, y = c.y;
		canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
		const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
		for (let side = 0; side < 4; side++) {
			for (let i = 0; i < DRAG_SIDES[side]; i++) {
				await step(() => {
					x += dirs[side][0] * DRAG_STEP;
					y += dirs[side][1] * DRAG_STEP;
					canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: 1, bubbles: true }));
				});
			}
		}
		window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, bubbles: true }));
		await endPhase();
	};

	performance.mark('telescope:bench run start');
	const runT0 = performance.now();
	try {
		// Whatever is queued from before the run is not the run's.
		beginPhase('warm-up');
		for (let i = 0; i < 5; i++) await step(() => app.draw());
		await endPhase();

		const overviewZ = canvas.width / (1.5 * worldPx);
		await zoomTo('zoom out to 1.5 worlds', overviewZ);
		await dragRect('drag at 1.5 worlds');
		await zoomTo('zoom in to 1:1', 1);
		await dragRect('drag at 1:1');
		await zoomTo('zoom back out', overviewZ);
	} finally {
		app.drawNow = saved.drawNow;
		appSettings.debugLayerTimings = saved.layerTimings;
		app.layerProfile = saved.layerProfile;
		app.cam.x = saved.cam.x; app.cam.y = saved.cam.y; app.cam.z = saved.cam.z;
		app.pw = saved.pw; app.pwVertical = saved.pwVertical;
		app.checkBounds();
		app.draw();
		running = false;
	}
	performance.mark('telescope:bench run end');
	performance.measure('telescope:bench run', 'telescope:bench run start', 'telescope:bench run end');

	// ---- report -----------------------------------------------------------
	const rows = {};
	for (const p of phases) {
		const long = p.frames.filter((d) => d > 20).length;
		rows[p.name] = {
			frames: p.frames.length,
			'frame p50': r2(pct(p.frames, 0.5)), 'frame p95': r2(pct(p.frames, 0.95)), 'frame max': r2(Math.max(0, ...p.frames)),
			'>20ms': long,
			'draw p50': r2(pct(p.draws, 0.5)), 'draw p95': r2(pct(p.draws, 0.95)), 'draw max': r2(Math.max(0, ...p.draws)),
			'input p95': r2(pct(p.inputs, 0.95)), 'input max': r2(Math.max(0, ...p.inputs)),
			'settle ms': Math.round(p.settleMs), 'pending': p.pendingAtEnd,
		};
	}
	const layerNames = new Set();
	for (const p of phases) for (const k of Object.keys(p.layers)) layerNames.add(k);
	const layerRows = {};
	for (const k of layerNames) {
		const row = {};
		let worst = 0;
		for (const p of phases) {
			const v = p.layers[k] || [];
			row[`${p.name} p95`] = r2(pct(v, 0.95));
			row[`${p.name} max`] = r2(Math.max(0, ...v));
			worst = Math.max(worst, ...v);
		}
		if (worst >= 0.5) layerRows[k] = row;
	}
	const zoomRange = `${r2(canvas.width / (1.5 * worldPx))} .. 1`;
	const info = `[Render benchmark] ${canvas.width}x${canvas.height}, seed ${app.seed}` +
		`${app.ngPlusCount ? ` NG+${app.ngPlusCount}` : ''}, zoom ${zoomRange}, ${Math.round(performance.now() - runT0)} ms total. ` +
		'ms; "frame" = rAF to rAF (what you see), "draw" = drawNow wall time, "input" = the event handlers (drag, hover tooltip), "settle" = async work after the phase.';
	console.log(info);
	console.table(rows);
	console.table(layerRows);
	const text = [info, '', tableText(rows), '', 'per-layer drawNow ms (p95 / max, layers over 0.5 ms):', tableText(layerRows)].join('\n');
	log(text);
	const results = { info, phases, rows, layerRows, text };
	app.lastBenchmark = results;
	return results;
}

function tableText(rows) {
	const names = Object.keys(rows);
	if (!names.length) return '(none)';
	const cols = Object.keys(rows[names[0]]);
	const w0 = Math.max(...names.map((n) => n.length));
	const ws = cols.map((c) => Math.max(c.length, ...names.map((n) => String(rows[n][c]).length)));
	const line = (name, cells) => name.padEnd(w0) + '  ' + cells.map((c, i) => String(c).padStart(ws[i])).join('  ');
	return [line('', cols), ...names.map((n) => line(n, cols.map((c) => rows[n][c])))].join('\n');
}
