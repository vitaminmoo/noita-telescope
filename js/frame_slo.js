// Frame log: every animation frame that misses 60 fps, with what it was
// waiting on.
//
// The objective is a frame every 16.7 ms while the map is moving or loading.
// An average hides the misses that are felt, and drawNow's own time is usually
// not where they come from: the bench measured 80-150 ms gaps between frames
// whose draws took under 20 ms. So this watches the gaps themselves -- the
// interval between consecutive animation frames -- and when one runs over, it
// records everything known about that interval:
//
//   draw     the host's draw calls in it, total and per layer
//   work     main-thread work that reported itself (scene bitmaps landing,
//            resource builds, generation, hover, ...), by kind
//   idle     the part of the interval nothing accounted for: the browser, the
//            GPU process, garbage collection, or code that does not report
//   queue    render items posted and not finished (scene builds, decal tiles),
//            by kind and stage, and the oldest of them
//   landed   render items that finished during the interval
//   counts   what was handed to the GPU in it (scene images and KB uploaded)
//   state    whatever the host and the terrain view registered: caches, pools,
//            pending counts, the camera
//   loaf     the browser's own long-animation-frame attribution, when it has
//            one (Chrome, frames over 50 ms): which script ran for how long
//
// A frame can also be on time and still wrong: scenes drawn from a stand-in
// while their real build is made, scenes and decal tiles not there yet. The
// viewer sees those change afterwards with the camera where it is, so they
// count as misses too. The terrain view reports what each frame shows that is
// not final (frameSlo.detail); a run of such frames is logged as one "detail"
// record when it ends: how long the view took to become final, and the most
// that was unfinished in it.
//
// The other objective is the load, to the complete view -- every scene of
// every world on screen: two seconds for opening the page, one for a new seed
// on a page that is already up, each divided into phases with a budget of
// their own (LOAD_PHASES_MS). A host reports each load it finishes with
// frameSlo.load(); it is logged with its phases whether or not the frame log
// is on.
//
// Three ways out, all carrying the same records:
//   * the console: one line per miss ("[frame] #12 +33 ms ...");
//   * frameSlo.dump() -- every record since the log was switched on, as
//     newline-delimited JSON; `copy(frameSlo.dump())` in the browser console;
//   * on localhost, POSTed to the dev server (tools/dev_server.py appends them
//     to data/dumps/frame_log.ndjson), so a session in a live browser can be
//     read back from disk without copying anything.
//
// Off by default and free while off. On with the Render HUD or the Frame Log
// option on telescope's page, with ?framelog=1 on any page, or
// frameSlo.setEnabled(true).
import { renderHud, renderTrace } from './render_hud.js';

const BUDGET_MS = 1000 / 60;
// What a load is allowed, phase by phase; a load's budget is the sum. Each
// phase ends at a milestone and is measured from the one before, so they add
// up to the whole load however the work inside overlaps:
//   modules   navigation -> the page's script has loaded and run
//   assets    -> everything that does not depend on the seed is fetched and decoded
//   generate  -> the seed's world data exists (biome map, wang tiles, spawn prescan)
//   terrain   -> terrain is on screen (GPU resources built and uploaded, first frame)
//   scenes    -> the view is complete (worlds scanned; every scene and decal of it drawn)
// 'page load' is opening the page; 'new seed' a seed on a page that is already up.
const LOAD_PHASES_MS = {
	'page load': { modules: 250, assets: 250, generate: 400, terrain: 400, scenes: 700 },
	'new seed': { generate: 350, terrain: 350, scenes: 300 },
};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const LOAD_BUDGETS_MS = Object.fromEntries(Object.entries(LOAD_PHASES_MS).map(([k, v]) => [k, sum(v)]));
const LOAD_BUDGET_DEFAULT_MS = 1000;
/** An interval over this is a missed frame: one refresh plus timer slack. */
const MISS_MS = 20;
/** Records kept for dump(). */
const RING = 2000;
/** A frame counts only if the page drew recently: an idle page that stalls is not a miss. */
const ACTIVE_WINDOW_MS = 500;
const CONSOLE_PER_SECOND = 5;
const SINK_URL = '/__frame_log';

let enabled = false;
let rafId = 0;
let lastT = 0;          // when the previous frame callback RAN (performance.now())
let lastStamp = 0;      // the frame time it was called with
let serial = 0;
let lastDrawAt = -Infinity;
let interval = newInterval();
const states = new Map();      // name -> () => value
const records = [];            // every record (session, miss, loaf), oldest first
const missed = [];             // { line, record } for the HUD, newest first
const lastLoad = {};           // name -> { line, record }: the latest load of each kind, until the next replaces it
let episode = null;            // the run of not-final frames in progress
let detailSuspended = false;
let outbox = [];
let flushTimer = 0;
let sinkOk = true;
let consoleWindow = 0, consoleCount = 0, consoleDropped = 0;
let loafObserver = null;

function newInterval() {
	return { draws: 0, drawMs: 0, layers: {}, work: new Map(), counts: {} };
}

const r1 = (v) => Math.round(v * 10) / 10;

function emit(rec) {
	records.push(rec);
	if (records.length > RING) records.shift();
	if (!enabled || !sinkOk) return;
	outbox.push(JSON.stringify(rec));
	if (!flushTimer) flushTimer = setTimeout(flush, 500);
}

function flush() {
	flushTimer = 0;
	if (!outbox.length || !sinkOk) return;
	const body = outbox.join('\n') + '\n';
	outbox = [];
	// The dev server answers 204; anything else (a static host, another server)
	// means nobody is listening, so stop posting.
	fetch(SINK_URL, { method: 'POST', body, keepalive: true })
		.then((r) => { if (!r.ok) sinkOk = false; })
		.catch(() => { sinkOk = false; });
}

function queueSummary(t) {
	const items = renderTrace.activeItems();
	const byKind = {};
	for (const i of items) {
		const k = byKind[i.kind] ??= {};
		k[i.stage] = (k[i.stage] || 0) + 1;
	}
	return {
		total: items.length,
		byKind,
		oldest: items.slice(0, 4).map((i) => ({ kind: i.kind, label: i.label, stage: i.stage, ageMs: Math.round(t - i.t0) })),
		running: items.filter((i) => i.stage === 'running').slice(0, 8).map((i) => `${i.kind}:${i.label}`),
	};
}

function landedSummary(since) {
	const byKind = {};
	for (const i of renderTrace.finishedSince(since)) {
		const k = byKind[i.kind] ??= { n: 0, workerMs: 0, latencyMaxMs: 0 };
		k.n++;
		k.workerMs = r1(k.workerMs + (i.workerMs || 0));
		k.latencyMaxMs = Math.max(k.latencyMaxMs, Math.round(i.t1 - i.t0));
	}
	return byKind;
}

function snapshotState() {
	const out = {};
	for (const [name, fn] of states) {
		try { out[name] = fn(); } catch (err) { out[name] = `error: ${err?.message ?? err}`; }
	}
	return out;
}

/** "#12 +33 ms  draw 12.1 (scenesGL 9.0)  sceneBitmaps 14.2 x3  idle 6.7  queue 14: scene 8 running 6 queued" */
function oneLine(rec) {
	const parts = [`#${rec.n} +${rec.overMs} ms (${rec.dtMs})`];
	if (rec.draw) {
		const top = Object.entries(rec.draw.layers).sort((a, b) => b[1] - a[1]).slice(0, 3)
			.map(([k, v]) => `${k} ${v}`).join(', ');
		parts.push(`draw ${rec.draw.ms}${rec.draw.n > 1 ? ` x${rec.draw.n}` : ''}${top ? ` (${top})` : ''}`);
	}
	for (const w of rec.work) parts.push(`${w.kind} ${w.ms}${w.n > 1 ? ` x${w.n}` : ''}`);
	parts.push(`idle ${rec.idleMs}`);
	if (rec.queue.total) {
		parts.push(`queue ${rec.queue.total}: ` + Object.entries(rec.queue.byKind)
			.map(([kind, stages]) => `${kind} ${Object.entries(stages).map(([s, n]) => `${n} ${s}`).join(' ')}`).join(', '));
	}
	const landed = Object.entries(rec.landed).map(([k, v]) => `${v.n} ${k}`).join(', ');
	if (landed) parts.push(`landed ${landed}`);
	const counts = Object.entries(rec.counts).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
	if (counts) parts.push(counts);
	return parts.join('  ');
}

function pushMiss(rec, line) {
	missed.unshift({ line, record: rec });
	if (missed.length > 40) missed.length = 40;
}

/** "#14 detail 420 ms (25 frames)  37 scenes on stand-ins, 12 not drawn yet, 4 decal tiles" */
function detailLine(rec) {
	const parts = [];
	if (rec.sceneStandIns) parts.push(`${rec.sceneStandIns} scenes on stand-ins`);
	if (rec.scenesMissing) parts.push(`${rec.scenesMissing} scenes not drawn yet`);
	if (rec.decalTilesMissing) parts.push(`${rec.decalTilesMissing} decal tiles not drawn yet`);
	return `#${rec.n} detail ${rec.durationMs} ms (${rec.frames} frames)  ${parts.join(', ')}`;
}

function closeEpisode(t) {
	const e = episode;
	episode = null;
	const rec = {
		type: 'detail',
		n: ++serial,
		t: Math.round(e.t0),
		durationMs: Math.round(t - e.t0),
		frames: e.frames,
		sceneStandIns: e.sceneStandIns,
		scenesMissing: e.scenesMissing,
		decalTilesMissing: e.decalTilesMissing,
		state: e.state,
	};
	emit(rec);
	const line = detailLine(rec);
	console.warn(`[frame] ${line}`, rec);
	pushMiss(rec, line);
}

function toConsole(rec) {
	const sec = Math.floor(rec.t / 1000);
	if (sec !== consoleWindow) {
		if (consoleDropped) console.warn(`[frame] ... and ${consoleDropped} more missed frames in that second (frameSlo.dump() has them)`);
		consoleWindow = sec;
		consoleCount = consoleDropped = 0;
	}
	if (consoleCount++ < CONSOLE_PER_SECOND) console.warn(`[frame] ${oneLine(rec)}`, rec);
	else consoleDropped++;
}

function onFrame(stamp) {
	rafId = requestAnimationFrame(onFrame);
	// Intervals are measured between the times the callback RAN, not between the
	// frame times it is handed. When a task blocks the thread across several
	// refreshes, the callback that finally runs still carries the frame time
	// from before the block: going by frame times, it would close the interval
	// "on time", throw away the work recorded during the block, and leave the
	// next callback to report the gap with nothing in it.
	const t = performance.now();
	const dt = lastT ? t - lastT : 0;
	const stampDt = lastStamp ? stamp - lastStamp : 0;
	lastStamp = stamp;
	const active = interval.draws > 0 || interval.work.size > 0 || t - lastDrawAt < ACTIVE_WINDOW_MS;
	// Run times jitter by a few ms inside a refresh; frame times do not. A miss
	// needs the frame times to agree, or the gap to be past any jitter.
	const late = dt > MISS_MS && (stampDt > MISS_MS || dt > MISS_MS + 5);
	// A hidden tab is throttled, and a gap of seconds is the tab coming back.
	if (late && dt < 10000 && active && !document.hidden) {
		const work = [...interval.work.entries()]
			.map(([kind, w]) => ({ kind, ms: r1(w.ms), n: w.n, maxMs: r1(w.max), ...(w.detail ? { detail: w.detail } : {}) }))
			.sort((a, b) => b.ms - a.ms);
		const layers = {};
		for (const [k, v] of Object.entries(interval.layers)) if (v >= 0.5) layers[k] = r1(v);
		const accounted = interval.drawMs + work.reduce((s, w) => s + w.ms, 0);
		const rec = {
			type: 'miss',
			n: ++serial,
			t: Math.round(t),
			dtMs: r1(dt),
			overMs: r1(dt - BUDGET_MS),
			framesLost: Math.max(1, Math.round(dt / BUDGET_MS) - 1),
			draw: interval.draws ? { n: interval.draws, ms: r1(interval.drawMs), layers } : null,
			work,
			idleMs: r1(Math.max(0, dt - accounted)),
			counts: interval.counts,
			queue: queueSummary(t),
			landed: landedSummary(lastT),
			state: snapshotState(),
		};
		emit(rec);
		toConsole(rec);
		pushMiss(rec, oneLine(rec));
	}
	// A run of not-final frames that just stopped being drawn (the page went
	// idle before the view finished) ends where its last frame was.
	if (episode && t - episode.last > 2000) closeEpisode(episode.last);
	lastT = t;
	interval = newInterval();
}

// The browser's own account of a long frame: which script entry points ran and
// for how long. Arrives after the frame, so it is its own record, matched to
// the miss it explains by time.
function watchLongFrames() {
	if (loafObserver || typeof PerformanceObserver === 'undefined') return;
	if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return;
	loafObserver = new PerformanceObserver((list) => {
		if (!enabled) return;
		for (const e of list.getEntries()) {
			const end = e.startTime + e.duration;
			const miss = records.findLast((r) => r.type === 'miss' && r.t >= e.startTime - 5 && r.t <= end + 40);
			emit({
				type: 'loaf',
				miss: miss?.n ?? null,
				t: Math.round(e.startTime),
				durationMs: r1(e.duration),
				blockingMs: r1(e.blockingDuration ?? 0),
				renderStartMs: e.renderStart ? r1(e.renderStart - e.startTime) : null,
				styleAndLayoutMs: e.styleAndLayoutStart ? r1(end - e.styleAndLayoutStart) : null,
				scripts: (e.scripts ?? []).map((s) => ({
					invoker: s.invoker,
					fn: s.sourceFunctionName || null,
					src: s.sourceURL ? `${s.sourceURL.split('/').pop()}:${s.sourceCharPosition}` : null,
					ms: r1(s.duration),
					forcedLayoutMs: r1(s.forcedStyleAndLayoutDuration ?? 0),
				})).sort((a, b) => b.ms - a.ms).slice(0, 6),
			});
		}
	});
	loafObserver.observe({ type: 'long-animation-frame', buffered: false });
}

export const frameSlo = {
	budgetMs: BUDGET_MS,

	get enabled() { return enabled; },

	setEnabled(on) {
		on = !!on;
		if (on === enabled || typeof requestAnimationFrame === 'undefined') return;
		enabled = on;
		renderHud.setTracing(on);
		if (on) {
			lastT = lastStamp = 0;
			interval = newInterval();
			sinkOk = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location?.hostname ?? '');
			emit({
				type: 'session',
				at: new Date().toISOString(),
				url: globalThis.location?.href ?? null,
				userAgent: globalThis.navigator?.userAgent ?? null,
				cores: globalThis.navigator?.hardwareConcurrency ?? null,
				devicePixelRatio: globalThis.devicePixelRatio ?? null,
				window: [globalThis.innerWidth ?? 0, globalThis.innerHeight ?? 0],
				budgetMs: r1(BUDGET_MS),
				missOverMs: MISS_MS,
				state: snapshotState(),
			});
			watchLongFrames();
			renderHud.setMissSource((n) => ({
				loads: Object.keys(LOAD_BUDGETS_MS).map((name) => ({ name, ...(lastLoad[name] ?? {}) })),
				frames: missed.slice(0, n),
			}));
			rafId = requestAnimationFrame(onFrame);
		} else {
			cancelAnimationFrame(rafId);
			rafId = 0;
			renderHud.setMissSource(null);
			flush();
		}
	},

	/**
	 * The host's draw call: its main-thread time, and optionally the time of
	 * each layer or pass inside it ({ name: ms }).
	 */
	drew(ms, layers = null) {
		if (!enabled) return;
		lastDrawAt = performance.now();
		interval.draws++;
		interval.drawMs += ms;
		if (layers) for (const k in layers) interval.layers[k] = (interval.layers[k] || 0) + layers[k];
	},

	/**
	 * Main-thread work outside the draw reports itself here: a kind, how long
	 * it took, and optionally a small detail object (the last one is kept).
	 */
	work(kind, ms, detail = null) {
		if (!enabled) return;
		let w = interval.work.get(kind);
		if (!w) interval.work.set(kind, w = { ms: 0, n: 0, max: 0, detail: null });
		w.ms += ms;
		w.n++;
		if (ms > w.max) w.max = ms;
		if (detail) w.detail = detail;
	},

	/**
	 * Adds to a named count for the current interval: things whose cost is not
	 * main-thread time (bytes handed to the GPU, images uploaded).
	 */
	count(name, n = 1) {
		if (!enabled) return;
		interval.counts[name] = (interval.counts[name] || 0) + n;
	},

	/** Runs `fn` and reports its time as `kind`. */
	time(kind, fn, detail = null) {
		if (!enabled) return fn();
		const t0 = performance.now();
		try { return fn(); } finally { this.work(kind, performance.now() - t0, detail); }
	},

	loadBudgetsMs: LOAD_BUDGETS_MS,
	loadPhasesMs: LOAD_PHASES_MS,

	/**
	 * A load finished: the view the host opened on is complete. `name` is
	 * 'page load' (timed from navigation) or 'new seed' (from the request, on a
	 * page already up), `ms` the time it took, and `phases` how long each phase
	 * of it took, in order, as { name: ms } -- the names of LOAD_PHASES_MS, each
	 * of which has a budget of its own. Returns the record.
	 */
	load(name, ms, phases = null) {
		const budgetMs = LOAD_BUDGETS_MS[name] ?? LOAD_BUDGET_DEFAULT_MS;
		const budgets = LOAD_PHASES_MS[name] ?? {};
		const rec = {
			type: 'load',
			name,
			t: Math.round(performance.now()),
			ms: Math.round(ms),
			budgetMs,
			overMs: Math.max(0, Math.round(ms - budgetMs)),
			ok: ms <= budgetMs,
			phases: Object.entries(phases ?? {}).map(([phase, v]) => {
				const b = budgets[phase] ?? null;
				return { name: phase, ms: Math.round(v), budgetMs: b, overMs: b == null ? null : Math.max(0, Math.round(v - b)) };
			}),
			state: snapshotState(),
		};
		emit(rec);
		// "terrain 462/400!": what the phase took, its budget, and a mark when over.
		const detail = rec.phases.length ? '  ' + rec.phases.map((p) =>
			`${p.name} ${p.ms}${p.budgetMs == null ? '' : `/${p.budgetMs}${p.overMs ? '!' : ''}`}`).join(', ') : '';
		const line = `${name}: ${rec.ms} ms, ${rec.ok ? 'within' : `${rec.overMs} ms over`} the ${budgetMs} ms budget${detail}`;
		console.info(`[load] ${line}`);
		// The HUD keeps the latest load of each kind above the missed frames
		// until the next one replaces it.
		lastLoad[name] = { line, record: rec };
		return rec;
	},

	/**
	 * What a frame just drawn shows that is not final, as the terrain view
	 * counts it: { sceneStandIns, scenesMissing, decalTilesMissing }. All zero
	 * ends the run of not-final frames in progress, which is then logged.
	 */
	detail(d) {
		if (!enabled || detailSuspended) return;
		const t = performance.now();
		if (!(d.sceneStandIns || d.scenesMissing || d.decalTilesMissing)) {
			if (episode) closeEpisode(t);
			return;
		}
		episode ??= { t0: t, frames: 0, sceneStandIns: 0, scenesMissing: 0, decalTilesMissing: 0, state: snapshotState() };
		episode.frames++;
		episode.last = t;
		for (const k of ['sceneStandIns', 'scenesMissing', 'decalTilesMissing']) if (d[k] > episode[k]) episode[k] = d[k];
	},

	/** Frames nobody sees (a loading overlay is up) are not counted as not-final. */
	suspendDetail(on) {
		detailSuspended = !!on;
		if (on) episode = null;
	},

	/** A named piece of state read at every miss: `fn` returns something JSON-able and small. */
	addState(name, fn) { states.set(name, fn); },
	removeState(name) { states.delete(name); },

	/** Missed frames since the log was switched on. */
	get missed() { return serial; },

	/** Every record so far, as newline-delimited JSON. */
	dump() { return records.map((r) => JSON.stringify(r)).join('\n'); },

	/** One line per miss, oldest first. */
	text() { return records.filter((r) => r.type === 'miss').map(oneLine).join('\n'); },

	clear() {
		records.length = 0;
		missed.length = 0;
		serial = 0;
	},
};

if (typeof window !== 'undefined') {
	window.frameSlo = frameSlo;
	if (new URLSearchParams(window.location.search).get('framelog') === '1') frameSlo.setEnabled(true);
}
