// Load Gantt: a finished load's timeline (js/load_timeline.js) as a chart, in a
// modal over the page.
//
// One row per thread and kind of work, a bar wherever it ran, the load's
// phases and their budgets across the top and a time axis under them. Hover a
// bar for what it was and when.
//
//   showLoadGantt(record)      frameSlo.load()'s record, or frameSlo.lastLoad(name)
//
// The frame log opens it: by itself after every load when the host's option or
// ?timeline=1 says so (frameSlo.setTimelineOnLoad), from the [chart] link on a
// load's line in the Render HUD, or frameSlo.showTimeline('page load').
//
// "Copy JSON" puts the load's record on the clipboard (phases, timeline and
// state: what to send along with a question about a load). Esc, the close
// button or a click outside puts it away. The DOM is only touched while a chart
// is shown.

const INK = '#e8e8e6', INK_MUTED = '#9a9a96', INK_OVER = '#ff6b5e', GRID = '#333331', SURFACE = '#161616';
// One color per kind of thread (the render HUD's palette, and three more).
const LANES = [
	['main', '#3987e5', 'page'],
	['network', '#8c8c88', 'fetches'],
	['terrain', '#199e70', 'terrain workers'],
	['world', '#b07ad9', 'scan workers'],
	['overlay', '#d95926', 'scene workers'],
	['art', '#c9a227', 'art worker'],
];
const OTHER_COLOR = '#6fb8c9';
const laneColor = (lane) => (LANES.find(([p]) => lane.startsWith(p)) ?? [null, OTHER_COLOR])[1];
const LABEL_W = 250, TOTAL_W = 60, ROW_H = 15;

let backdrop = null, tip = null;

function el(tag, style, text) {
	const e = document.createElement(tag);
	if (style) Object.assign(e.style, style);
	if (text != null) e.textContent = text;
	return e;
}

const ms = (v) => `${Math.round(v)} ms`;

/** A round step that puts five to ten ticks on an axis `total` ms long. */
function tickStep(total) {
	for (const step of [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) if (total / step <= 10) return step;
	return 10000;
}

export function hideLoadGantt() {
	backdrop?.remove();
	tip?.remove();
	backdrop = tip = null;
}

function showTip(e, text) {
	if (!tip) {
		tip = el('div', {
			position: 'fixed', zIndex: 71, pointerEvents: 'none', background: '#000', color: INK, border: `1px solid ${GRID}`,
			borderRadius: '4px', padding: '3px 6px', font: '11px/1.35 ui-monospace, Menlo, Consolas, monospace', whiteSpace: 'pre',
		});
		document.body.append(tip);
	}
	tip.textContent = text;
	tip.style.display = 'block';
	const w = tip.offsetWidth, h = tip.offsetHeight;
	tip.style.left = `${Math.min(window.innerWidth - w - 8, e.clientX + 14)}px`;
	tip.style.top = `${Math.min(window.innerHeight - h - 8, e.clientY + 14)}px`;
}
const hideTip = () => { if (tip) tip.style.display = 'none'; };

/** Shows `rec` (a load record with a `timeline`) as a chart over the page. */
export function showLoadGantt(rec) {
	hideLoadGantt();
	if (!rec?.timeline?.length || typeof document === 'undefined') return;
	const total = Math.max(1, rec.ms);
	const pct = (v) => `${Math.max(0, Math.min(100, v / total * 100))}%`;

	backdrop = el('div', { position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.5)' });
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) hideLoadGantt(); });
	const panel = el('div', {
		position: 'absolute', left: '50%', top: '16px', transform: 'translateX(-50%)', width: 'min(1200px, calc(100vw - 32px))',
		maxHeight: 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column', background: SURFACE, color: INK,
		font: '11px/1.35 ui-monospace, Menlo, Consolas, monospace', borderRadius: '6px', border: `1px solid ${GRID}`,
		boxSizing: 'border-box', boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
	});
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-label', 'Load timeline');

	// --- header: the verdict, the legend, the buttons
	const head = el('div', { display: 'flex', gap: '14px', alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${GRID}`, flexWrap: 'wrap' });
	head.append(el('span', { color: rec.ok ? INK : INK_OVER, fontWeight: 'bold', fontSize: '13px' },
		`${rec.name}: ${rec.ms} ms, ${rec.ok ? 'within' : `${rec.overMs} over`} the ${rec.budgetMs} ms budget`));
	const present = new Set(rec.timeline.map(t => (LANES.find(([p]) => t.lane.startsWith(p)) ?? [null])[0]));
	for (const [prefix, color, label] of LANES) {
		if (!present.has(prefix)) continue;
		const item = el('span', { color: INK_MUTED, whiteSpace: 'nowrap' });
		item.append(el('span', { display: 'inline-block', width: '9px', height: '9px', background: color, borderRadius: '2px', marginRight: '4px', verticalAlign: '-1px' }), label);
		head.append(item);
	}
	const button = (text, onClick) => {
		const b = el('button', {
			background: 'none', border: `1px solid ${GRID}`, color: INK, font: 'inherit', cursor: 'pointer', borderRadius: '4px', padding: '2px 8px',
		}, text);
		b.addEventListener('click', onClick);
		return b;
	};
	const copy = button('Copy JSON', () => {
		navigator.clipboard?.writeText(JSON.stringify(rec) + '\n').then(() => {
			copy.textContent = 'Copied';
			setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1500);
		}, () => {});
	});
	copy.title = 'The whole record of this load: phases, timeline, state';
	copy.style.marginLeft = 'auto';
	head.append(copy, button('Close (Esc)', hideLoadGantt));
	panel.append(head);

	// A row: label, track, total. The track is where bars are placed by percent.
	const makeRow = (label, height = ROW_H) => {
		const r = el('div', { display: 'flex', alignItems: 'stretch', height: `${height}px`, padding: '0 12px' });
		const l = el('div', { width: `${LABEL_W}px`, flex: 'none', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: `${height}px` }, label);
		const track = el('div', { position: 'relative', flex: '1', minWidth: 0 });
		const t = el('div', { width: `${TOTAL_W}px`, flex: 'none', textAlign: 'right', color: INK_MUTED, lineHeight: `${height}px` });
		r.append(l, track, t);
		return { r, l, track, t };
	};

	// --- the phases against their budgets, and the time axis
	const top = el('div', { borderBottom: `1px solid ${GRID}`, paddingTop: '6px' });
	const phases = makeRow('phase  took / budget', 20);
	phases.l.style.color = INK_MUTED;
	const bounds = [];
	let at = 0;
	for (const p of rec.phases ?? []) {
		const seg = el('div', {
			position: 'absolute', left: pct(at), width: pct(p.ms), top: 0, bottom: '2px', boxSizing: 'border-box',
			background: p.overMs ? 'rgba(255,107,94,0.16)' : 'rgba(255,255,255,0.06)', borderRight: `1px solid ${INK_MUTED}`,
			color: p.overMs ? INK_OVER : INK, whiteSpace: 'pre', overflow: 'hidden', padding: '0 4px', lineHeight: '18px',
		}, `${p.name} ${p.ms}${p.budgetMs == null ? '' : ` / ${p.budgetMs}`}`);
		const from = at;
		seg.addEventListener('mousemove', (e) => showTip(e,
			`${p.name}: ${p.ms} ms${p.budgetMs == null ? '' : ` of ${p.budgetMs}${p.overMs ? ` (${p.overMs} over)` : ''}`}\n${ms(from)} → ${ms(from + p.ms)}`));
		seg.addEventListener('mouseleave', hideTip);
		phases.track.append(seg);
		at += p.ms;
		bounds.push(at);
	}
	const axis = makeRow('', 14);
	const step = tickStep(total);
	for (let t = 0; t <= total; t += step) {
		axis.track.append(el('div', { position: 'absolute', left: pct(t), top: 0, color: INK_MUTED, transform: t ? 'translateX(-50%)' : 'none', fontSize: '10px' }, String(t)));
	}
	axis.t.textContent = 'ms';
	top.append(phases.r, axis.r);
	panel.append(top);

	// --- the rows
	const body = el('div', { overflow: 'auto', padding: '4px 0 8px' });
	let lastLane = null;
	for (const t of rec.timeline) {
		const count = t.n > 1 ? ` ×${t.n}` : '';
		const firstOfLane = t.lane !== lastLane;
		lastLane = t.lane;
		const row = makeRow('');
		row.l.append(el('span', { display: 'inline-block', width: '112px', color: INK }, firstOfLane ? t.lane : ''), el('span', { color: INK_MUTED }, `${t.name}${count}`));
		if (firstOfLane) row.r.style.borderTop = `1px solid ${GRID}`;
		for (let x = step; x < total; x += step) row.track.append(el('div', { position: 'absolute', left: pct(x), top: 0, bottom: 0, borderLeft: '1px solid rgba(255,255,255,0.04)' }));
		for (const b of bounds) row.track.append(el('div', { position: 'absolute', left: pct(b), top: 0, bottom: 0, borderLeft: `1px solid ${GRID}` }));
		for (const [a, b, what] of t.spans) {
			const bar = el('div', {
				position: 'absolute', left: pct(a), width: `max(2px, ${pct(b - a)})`, top: '2px', bottom: '2px',
				background: laneColor(t.lane), borderRadius: '2px',
			});
			const of = typeof what === 'number' ? ` (${what} in a row)` : what ? `: ${what}` : '';
			bar.addEventListener('mousemove', (e) => showTip(e, `${t.lane} · ${t.name}${of}\n${ms(a)} → ${ms(b)}   ${Math.round((b - a) * 10) / 10} ms`));
			bar.addEventListener('mouseleave', hideTip);
			row.track.append(bar);
		}
		row.t.textContent = ms(t.ms);
		row.t.title = `${t.lane} ${t.name}: ${t.ms} ms in all, first at ${ms(t.spans[0][0])}`;
		body.append(row.r);
	}
	panel.append(body);
	backdrop.append(panel);
	document.body.append(backdrop);
}

if (typeof window !== 'undefined') {
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideLoadGantt(); });
}
