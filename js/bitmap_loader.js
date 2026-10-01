// Bitmap loader: PNGs decoded to ImageBitmaps in a worker.
//
// The page's background art is a few hundred PNGs that are only ever drawn, so
// all it needs of each is an ImageBitmap. Getting one is cheap for the browser
// (it decodes off-thread) but not for the page: each file is pulled out of a
// zip and stripped of its color chunks first (png_sanitizer.js), a few
// milliseconds of script apiece, and on a first load that script ran on the
// page's thread in the middle of everything else -- 0.8 s of it alone, 2.3 s
// while the seed was loading. Here it runs in a worker of its own and the
// bitmaps are handed over.
//
// Without workers (or if the worker fails) the files load on this thread, as before.
import { loadTimeline } from './load_timeline.js';

let worker = null, ready = false, failed = false;
const queue = [];
const pending = new Map();   // id -> resolve
let nextId = 1;

async function loadHere(paths) {
	const { loadPNGBitmap } = await import('./png_sanitizer.js');
	const errors = [];
	const bitmaps = await Promise.all(paths.map((p) => loadPNGBitmap(p).catch((err) => {
		errors.push(`${p}: ${err?.message ?? err}`);
		return null;
	})));
	return { bitmaps, errors };
}

function start() {
	if (worker || failed) return;
	try {
		worker = new Worker(new URL('./bitmap_loader_worker.js', import.meta.url), { type: 'module', name: 'art' });
	} catch {
		failed = true;
		return;
	}
	worker.onmessage = (e) => {
		const msg = e.data;
		loadTimeline.add(msg.spans);
		if (msg.type === 'READY') {
			ready = true;
			for (const m of queue.splice(0)) worker.postMessage(m);
			return;
		}
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	};
	worker.onerror = (e) => {
		console.warn('bitmap loader worker failed, loading on the page:', e.message ?? '');
		failed = true;
		// Whatever was asked of it is loaded here instead.
		for (const [id, resolve] of pending) { pending.delete(id); resolve(null); }
	};
}

/**
 * Decodes PNGs to ImageBitmaps.
 * @param {string[]} paths  URLs as png_sanitizer.js takes them (relative to js/)
 * @param {string} name     what this batch is, for the load timeline
 * @returns {Promise<{bitmaps: Array<ImageBitmap|null>, errors: string[]}>}
 *          bitmaps in the order of `paths`; null where a file failed
 */
export async function loadBitmaps(paths, name = 'bitmaps') {
	if (typeof Worker !== 'undefined') start();
	if (!worker || failed) return loadTimeline.time(name, () => loadHere(paths));
	const id = nextId++;
	const reply = await new Promise((resolve) => {
		pending.set(id, resolve);
		const msg = { id, paths, name };
		if (ready) worker.postMessage(msg);
		else queue.push(msg);
	});
	return reply ?? loadTimeline.time(name, () => loadHere(paths));
}
