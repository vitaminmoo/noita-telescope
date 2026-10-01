#!/usr/bin/env node
/* global process, Buffer */
// Flicker check: records every frame a page draws while a seed loads or the
// camera is cut to a new place, and reports the pixels that changed and then
// changed BACK within a few frames -- something
// that was drawn, vanished or turned into something else, and returned. A load
// should only ever add: terrain appears, a scene's stand-in is replaced by its
// real build, a decal tile lands. A pixel returning to an earlier value is a
// flash.
//
// The camera holds still during the load, so frames compare pixel for pixel.
//
//   systemd-run --user --quiet --collect --pipe --wait --slice=claude-limit.slice \
//     -p MemoryMax=10G --working-directory=$PWD \
//     /usr/bin/node test/flicker_check.mjs [--seed=N] [--view=overview|mid|close]
//       [--reseed] [--jump] [--host=view|app] [--png=DIR] [--w=960 --h=540] [--angle=vulkan]
//
// --host=view (default) is the minimal terrain view host; --host=app is
// telescope's own page, where the first load is hidden behind the loading
// overlay, so only --reseed and --jump say anything.
// --reseed loads a second seed on the warm page and checks that load instead
// (scene bitmaps cached, workers warm: what a visitor's later seeds look like).
// --jump loads the seed at the overview first, then cuts the camera to --view
// and checks the frames until that view is complete: what arriving somewhere
// new looks like while its scenes and decals load.
// --png writes the frames around the worst flash, and a mask of every pixel
// that flashed.
import { mkdirSync, writeFileSync } from 'node:fs';
import UPNG from 'upng-js';
import { openPage, sleep, startServer } from './helpers/drive.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const SEED = Number(flag('seed', '786433191'));
const W = Number(flag('w', '960')), H = Number(flag('h', '540'));
const ANGLE = flag('angle', 'vulkan');
const VIEW = flag('view', 'overview');
const PNG_DIR = flag('png', null);
const RESEED = argv.includes('--reseed');
const JUMP = argv.includes('--jump');
const HOST = flag('host', 'view');
if (HOST === 'app' && !RESEED && !JUMP) { console.error('--host=app needs --reseed or --jump'); process.exit(1); }
/** A change that reverts within this many frames is a flash. */
const MAX_FLASH_FRAMES = Number(flag('frames', '6'));
const MAX_FRAMES = 420;

// World-space views (x, y of the centre; zoom).
const VIEWS = {
	overview: null,                                   // the host's own: three worlds framed
	mid: { x: 600, y: 2600, zoom: 0.25 },
	close: { x: 600, y: 2600, zoom: 1 },
};
if (!(VIEW in VIEWS)) { console.error(`unknown --view=${VIEW}`); process.exit(1); }

const server = await startServer();
let d = null;
try {
	d = await openPage({
		port: server.port, angle: ANGLE, width: W, height: H,
		path: HOST === 'app' ? `/index.html?seed=${SEED}&ng=0` : '/test/terrain_view_host/index.html?auto=0',
	});
	for (let i = 0; i < 200; i++) {
		const up = HOST === 'app'
			? `(async () => { try { const m = await import('/js/app.js'); return !!m.app.initialViewSettled; } catch (e) { return false; } })()`
			: '!!window.terrainHost';
		if (await d.evalIn(up).catch(() => false)) break;
		await sleep(HOST === 'app' ? 1000 : 200);
	}
	// Each host as the same few operations. `frames` are RGBA, rows top-down.
	const VIEW_HOST = `(() => {
		const h = window.terrainHost;
		const gl = () => h.view.terrain.gl;
		return {
			load: async (seed, view) => { if (view) h.setView(view); await h.load({ seed, fit: view ? 0 : 3 }); },
			jump: async (view) => { h.setView(view); await h.ensureWorlds(); },
			settle: () => h.settle(),
			record: (frames, stamps, max) => {
				const draw = h.draw;
				h.draw = () => {
					const r = draw();
					const g = gl();
					if (g && r && frames.length < max) {
						const w = g.drawingBufferWidth, hh = g.drawingBufferHeight;
						const up = new Uint8Array(w * hh * 4);
						g.readPixels(0, 0, w, hh, g.RGBA, g.UNSIGNED_BYTE, up);
						const px = new Uint8Array(w * hh * 4);   // readPixels rows are bottom-up
						for (let y = 0; y < hh; y++) px.set(up.subarray((hh - 1 - y) * w * 4, (hh - y) * w * 4), y * w * 4);
						frames.push(px);
						stamps.push({ t: Math.round(performance.now()), pending: h.view.pending() });
					}
					return r;
				};
				return () => { h.draw = draw; };
			},
			tick: async () => { h.draw(); await new Promise(r => setTimeout(r, 16)); },
			size: () => [gl().drawingBufferWidth, gl().drawingBufferHeight],
			cam: () => h.cam, world: () => h.world, scenes: () => Object.values(h.world.scenes).flat(),
		};
	})()`;
	const APP_HOST = `(await (async () => {
		const { app } = await import('/js/app.js');
		const u = await import('/js/utils.js');
		const settle = async () => {
			for (let idle = 0, i = 0; idle < 8 && i < 1500; i++) {
				app.drawNow();
				idle = app.asyncRenderPending() ? 0 : idle + 1;
				await new Promise(r => setTimeout(r, 50));
			}
		};
		return {
			load: async (seed) => { document.getElementById('seed').value = seed; await app.generate(true, true); },
			jump: async (view) => {
				app.cam.x = view.x + 512 * u.getWorldCenter(app.isNGP, app.gameMode);
				app.cam.y = view.y + 512 * 14;
				app.cam.z = view.zoom;
				app.checkBounds();
			},
			settle,
			record: (frames, stamps, max) => {
				const draw = app.drawNow.bind(app);
				app.drawNow = () => {
					draw();
					if (frames.length < max && app.biomeData && app.tileLayers) {
						frames.push(new Uint8Array(app.ctx.getImageData(0, 0, app.canvas.width, app.canvas.height).data));
						stamps.push({ t: Math.round(performance.now()), pending: { async: app.asyncRenderPending(), worlds: app.worldsInView.size } });
					}
				};
				return () => { app.drawNow = draw; };
			},
			tick: async () => { app.drawNow(); await new Promise(r => setTimeout(r, 16)); },
			size: () => [app.canvas.width, app.canvas.height],
			cam: () => app.cam, world: () => ({ isNGP: app.isNGP, gameMode: app.gameMode }),
			scenes: () => Object.values(app.pixelScenesByPW).filter(Boolean).flat(),
		};
	})())`;
	const result = await d.evalIn(`(async () => {
		const host = ${HOST === 'app' ? APP_HOST : VIEW_HOST};
		const view = ${JSON.stringify(VIEWS[VIEW])};
		if (${HOST !== 'app'} && (${RESEED} || ${JUMP})) await host.load(${RESEED ? SEED + 1 : SEED}, ${JUMP} ? null : view);
		if (${HOST === 'app'} && ${RESEED} && view) { await host.jump(view); await host.settle(); }
		if (${JUMP}) await host.settle();

		// Record every frame from here on.
		const frames = [], stamps = [];
		const stop = host.record(frames, stamps, ${MAX_FRAMES});
		if (${JUMP}) await host.jump(view); else await host.load(${HOST === 'app' ? SEED + 1 : SEED}, view);
		await host.settle();
		for (let i = 0; i < 20; i++) await host.tick();
		stop();
		const h = { cam: host.cam(), world: host.world() };
		const gl = () => ({ drawingBufferWidth: host.size()[0], drawingBufferHeight: host.size()[1] });

		const w = gl().drawingBufferWidth, hgt = gl().drawingBufferHeight, n = frames.length;
		// flashAt[i]: pixels of frame i that differ from frame i-1 and whose
		// frame i-1 value comes back within MAX_FLASH_FRAMES.
		const flashAt = new Uint32Array(n);
		const mask = new Uint8Array(w * hgt);
		const same = (a, b, p) => a[p] === b[p] && a[p + 1] === b[p + 1] && a[p + 2] === b[p + 2] && a[p + 3] === b[p + 3];
		for (let i = 1; i < n - 1; i++) {
			const prev = frames[i - 1], cur = frames[i];
			for (let q = 0; q < w * hgt; q++) {
				const p = q * 4;
				if (same(prev, cur, p)) continue;
				for (let k = 1; k <= ${MAX_FLASH_FRAMES} && i + k < n; k++) {
					if (same(prev, frames[i + k], p)) { flashAt[i]++; mask[q] = 255; break; }
				}
			}
		}
		let worst = 0;
		for (let i = 1; i < n; i++) if (flashAt[i] > flashAt[worst]) worst = i;
		// Where the flashing pixels are, in world coordinates, and which scenes cover them.
		let x0 = w, y0 = hgt, x1 = -1, y1 = -1, total = 0;
		for (let q = 0; q < w * hgt; q++) {
			if (!mask[q]) continue;
			total++;
			const x = q % w, y = Math.floor(q / w);
			if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
		}
		const ds = (await import('/js/terrain_view.js')).drawSpace(h.world.isNGP, h.world.gameMode);
		const toWorld = (sx, sy) => ({
			x: Math.round(h.cam.x + (sx - w / 2) / h.cam.z - ds.x), y: Math.round(h.cam.y + (sy - hgt / 2) / h.cam.z - ds.y) });
		// Scenes under the flashing pixels of the worst frame, by how many of them each covers.
		const g = await import('/js/pixel_scene_generation.js');
		const hits = new Map();
		if (flashAt[worst]) {
			const prev = frames[worst - 1], cur = frames[worst];
			const pts = [];
			for (let q = 0; q < w * hgt; q++) {
				if (same(prev, cur, q * 4) || !mask[q]) continue;
				pts.push(toWorld(q % w + 0.5, Math.floor(q / w) + 0.5));
			}
			const step = Math.max(1, Math.floor(pts.length / 4000));
			for (const s of host.scenes()) {
				const data = g.PIXEL_SCENE_DATA[s.key];
				if (!data) continue;
				let c = 0;
				for (let i = 0; i < pts.length; i += step) {
					const p = pts[i];
					if (p.x >= s.x && p.x < s.x + data.width && p.y >= s.y && p.y < s.y + data.height) c++;
				}
				if (c) hits.set(s.key, (hits.get(s.key) || 0) + c);
			}
		}
		const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
		const around = [worst - 1, worst, worst + 1].filter(i => i >= 0 && i < n);
		return {
			w, h: hgt, frames: n, zoom: h.cam.z,
			flashFrames: [...flashAt].map((c, i) => ({ i, c, ...stamps[i] })).filter(f => f.c > 0),
			total, worst, bbox: total ? { screen: [x0, y0, x1, y1], world: [toWorld(x0, y0), toWorld(x1 + 1, y1 + 1)] } : null,
			scenes: [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
			png: ${PNG_DIR ? 'true' : 'false'} ? { mask: b64(mask), frames: around.map(i => ({ i, px: b64(frames[i]) })) } : null,
		};
	})()`);

	const { w, h } = result;
	console.log(`${HOST === 'app' ? 'telescope page' : 'view host'}, ${VIEW} view at zoom ${result.zoom.toFixed(4)}, ${w}x${h}, ${JUMP ? 'cut from the overview' : RESEED ? 'second seed on a warm page' : 'first load'}: ${result.frames} frames recorded`);
	if (!result.total) {
		console.log('no pixel changed and changed back: no flashing');
	} else {
		console.log(`${result.total} pixels (${(100 * result.total / (w * h)).toFixed(2)}% of the frame) flashed, in ${result.flashFrames.length} frames`);
		console.log(`  screen box ${result.bbox.screen.join(', ')}; world ${JSON.stringify(result.bbox.world)}`);
		console.log('  frame  pixels  t(ms)  pending at that frame');
		for (const f of result.flashFrames.slice(0, 40)) {
			console.log(`  ${String(f.i).padStart(5)}  ${String(f.c).padStart(6)}  ${String(f.t).padStart(5)}  ${JSON.stringify(f.pending)}`);
		}
		if (result.scenes.length) console.log(`  scenes under the worst frame's flashing pixels (frame ${result.worst}): ${result.scenes.map(([k, c]) => `${k} (${c})`).join(', ')}`);
	}
	if (PNG_DIR && result.png) {
		mkdirSync(PNG_DIR, { recursive: true });
		// Opaque, so the transparent air of the view host shows as black.
		const flip = (u8, bpp) => {
			const out = new Uint8Array(w * h * 4);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const s = (y * w + x) * bpp, o = (y * w + x) * 4;
				if (bpp === 1) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; }
				else { out[o] = u8[s]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s + 2]; out[o + 3] = 255; }
			}
			return out;
		};
		const write = (name, u8, bpp) => writeFileSync(`${PNG_DIR}/${name}.png`, Buffer.from(UPNG.encode([flip(u8, bpp).buffer], w, h, 0)));
		write('flash_mask', Buffer.from(result.png.mask, 'base64'), 1);
		for (const f of result.png.frames) write(`frame_${String(f.i).padStart(3, '0')}`, Buffer.from(f.px, 'base64'), 4);
		console.log(`wrote ${PNG_DIR}/flash_mask.png and frames ${result.png.frames.map(f => f.i).join(', ')}`);
	}
	if (d.errors.length) console.log('page errors:', d.errors.slice(0, 3));
	if (result.total) process.exitCode = 1;
} finally {
	if (d) d.close();
	server.stop();
}
