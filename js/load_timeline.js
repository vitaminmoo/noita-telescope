// Load timeline: what ran when, on the page and in every worker, on one clock.
//
// A load is no longer one thing after another on one thread: the terrain
// workers generate while the page fetches its tables, the scan workers start
// before the terrain is on screen, the scene workers build eight at a time. The
// phases of a load (frame_slo.js) say when each milestone was reached; this
// says what every thread was doing meanwhile, so a load can be drawn as a Gantt
// chart (js/load_gantt.js) and the gaps -- a worker waiting for another, the
// page idle while a module graph loads -- can be seen.
//
// A span is [lane, name, start, end]. `lane` is the thread: 'main', or the
// worker's name ('terrain-0', 'world-1', 'overlay-pool-3'). `name` is what ran;
// spans of one kind on a lane share a name, with the particular thing after a
// colon ('scan: 0,-1'), and are charted on one row. Times are milliseconds
// since the epoch as performance.timeOrigin + performance.now() gives them,
// which is the same clock on every thread.
//
// Threads record their own spans. A worker hands what it recorded to the page
// with its replies (take), the page keeps a ring of everything (add), and a
// finished load cuts its window out of the ring (capture).
//
// No imports: the workers and the prespawn script load this before anything else.

const RING = 8000;
/** Spans of one kind on one lane closer than this are charted as one bar. */
const MERGE_GAP_MS = 2;

const isWorker = typeof globalThis.WorkerGlobalScope !== 'undefined' && globalThis instanceof globalThis.WorkerGlobalScope;
const LANE = isWorker ? (globalThis.name || 'worker') : 'main';
let spans = [];

/** Now, on the clock every thread shares (ms since the epoch, sub-millisecond). */
export const epochNow = () => performance.timeOrigin + performance.now();

function push(span) {
	spans.push(span);
	if (spans.length > RING) spans.splice(0, spans.length - RING);
}

// Lanes in the order a load uses them.
const LANE_ORDER = ['main', 'network', 'terrain', 'world', 'overlay'];
const laneRank = (lane) => {
	const i = LANE_ORDER.findIndex(p => lane.startsWith(p));
	return i < 0 ? LANE_ORDER.length : i;
};

export const loadTimeline = {
	lane: LANE,
	now: epochNow,

	/** Records a span: `start` and `end` are epochNow() values. */
	span(name, start, end, lane = LANE) {
		push([lane, name, start, end]);
	},

	/** Runs `fn` (sync or async) and records it as `name` on this thread's lane. */
	time(name, fn) {
		const start = epochNow();
		const done = () => push([LANE, name, start, epochNow()]);
		let r;
		try { r = fn(); } catch (err) { done(); throw err; }
		if (r && typeof r.then === 'function') return r.finally(done);
		done();
		return r;
	},

	/** This thread since it started, as a span: a worker's module graph loading. */
	started(name = 'start') {
		push([LANE, name, performance.timeOrigin, epochNow()]);
	},

	/** Worker side: the spans recorded since the last call, to send with a reply. */
	take() {
		const s = spans;
		spans = [];
		return s;
	},

	/** Every span this thread holds, as recorded: for a closer look than the chart's rows. */
	all() {
		return spans.slice();
	},

	/** Page side: spans a worker sent. */
	add(list) {
		if (list) for (const s of list) push(s);
	},

	/**
	 * Page side: what ran between `start` and `end` (epochNow() values), as
	 * chart rows: one per lane and kind of work, in lane order, each with its
	 * bars merged where they touch. Times are ms from `start`, clipped to the
	 * window.
	 * @returns {Array<{lane, name, n, ms, spans: Array}>}  `n` spans recorded,
	 *          `ms` the time the row's bars cover; each bar is [start, end,
	 *          what] -- the particular thing when the bar is one span ('0,-1'
	 *          of 'scan: 0,-1'), or how many spans it merges
	 */
	capture(start, end) {
		const rows = new Map();
		for (const [lane, name, a, b] of spans) {
			if (b < start || a > end) continue;
			const colon = name.indexOf(':');
			const kind = colon < 0 ? name : name.slice(0, colon);
			const key = `${lane}\n${kind}`;
			let row = rows.get(key);
			if (!row) rows.set(key, row = { lane, name: kind, n: 0, raw: [] });
			row.n++;
			row.raw.push([Math.max(a, start) - start, Math.min(b, end) - start, colon < 0 ? '' : name.slice(colon + 1).trim()]);
		}
		const r1 = (v) => Math.round(v * 10) / 10;
		const out = [];
		for (const row of rows.values()) {
			row.raw.sort((x, y) => x[0] - y[0]);
			const merged = [];
			for (const [a, b, what] of row.raw) {
				const last = merged[merged.length - 1];
				if (last && a <= last[1] + MERGE_GAP_MS) {
					last[1] = Math.max(last[1], b);
					last[2] = typeof last[2] === 'number' ? last[2] + 1 : 2;
				} else merged.push([a, b, what]);
			}
			const ms = merged.reduce((s, [a, b]) => s + (b - a), 0);
			if (ms < 0.5) continue;
			out.push({ lane: row.lane, name: row.name, n: row.n, ms: r1(ms), spans: merged.map(([a, b, what]) => [r1(a), r1(b), what]) });
		}
		out.sort((x, y) => laneRank(x.lane) - laneRank(y.lane)
			|| x.lane.localeCompare(y.lane, undefined, { numeric: true })
			|| x.spans[0][0] - y.spans[0][0]);
		return out;
	},
};

/**
 * A captured load as a text chart, one row per lane and kind of work, for a
 * terminal (the benchmark and the test drivers print it; the page draws
 * js/load_gantt.js instead):
 *
 *   page load 1559 ms    modules |assets|generate   |terrain|scenes        |
 *   main        modules       0  200  ████████
 *   terrain-0   wang tiles  402  178          ███████
 *
 * @param {object} rec    frameSlo.load()'s record: name, ms, phases, timeline
 * @param {number} width  columns of chart
 */
export function timelineText(rec, width = 64) {
	const rows = rec.timeline ?? [];
	if (!rows.length) return '';
	const total = Math.max(1, rec.ms);
	const col = (ms) => Math.max(0, Math.min(width, Math.round(ms / total * width)));
	const laneW = Math.max(4, ...rows.map(r => r.lane.length));
	const nameW = Math.max(4, ...rows.map(r => r.name.length + (r.n > 1 ? ` x${r.n}`.length : 0)));
	const pad = ' '.repeat(laneW + nameW + 2 + 6 + 6 + 2);
	// The phases as a ruler: each one's name in its own stretch, a bar at its end.
	let ruler = '';
	let at = 0;
	for (const p of rec.phases ?? []) {
		const endCol = col(at + p.ms);
		const room = endCol - ruler.length - 1;
		if (room >= 0) ruler += (p.name + (p.overMs ? '!' : '')).slice(0, room).padEnd(room) + '|';
		at += p.ms;
	}
	const lines = [`${rec.name} ${rec.ms} ms (budget ${rec.budgetMs})`.padEnd(pad.length).slice(0, pad.length) + ruler];
	for (const r of rows) {
		const cells = new Array(width).fill(' ');
		for (const [a, b] of r.spans) {
			// A bar of any length shows: at least one column.
			const c0 = Math.min(width - 1, Math.floor(a / total * width));
			const c1 = Math.max(c0 + 1, col(b));
			for (let c = c0; c < c1; c++) cells[c] = '█';
		}
		const name = r.name + (r.n > 1 ? ` x${r.n}` : '');
		lines.push(`${r.lane.padEnd(laneW)}  ${name.padEnd(nameW)}${String(Math.round(r.spans[0][0])).padStart(6)}${String(Math.round(r.ms)).padStart(6)}  ${cells.join('').trimEnd()}`);
	}
	lines.splice(1, 0, `${'lane'.padEnd(laneW)}  ${'work'.padEnd(nameW)}${'start'.padStart(6)}${'ms'.padStart(6)}`);
	return lines.join('\n');
}
