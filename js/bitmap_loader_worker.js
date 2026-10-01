// Decodes PNGs to ImageBitmaps off the page's thread (js/bitmap_loader.js).
import { loadTimeline } from './load_timeline.js';
import { loadPNGBitmap } from './png_sanitizer.js';

self.onmessage = async (e) => {
	const { id, paths, name } = e.data;
	const start = loadTimeline.now();
	// One that fails is null: the page warns about it and draws without it.
	const errors = [];
	const bitmaps = await Promise.all(paths.map((p) => loadPNGBitmap(p).catch((err) => {
		errors.push(`${p}: ${err?.message ?? err}`);
		return null;
	})));
	loadTimeline.span(name, start, loadTimeline.now());
	self.postMessage({ id, bitmaps, errors, spans: loadTimeline.take() }, bitmaps.filter(Boolean));
};

// See overlay_worker.js: the page holds its requests until this arrives.
loadTimeline.started('modules');
self.postMessage({ type: 'READY', spans: loadTimeline.take() });
