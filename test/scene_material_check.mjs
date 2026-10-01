#!/usr/bin/env node
/* global process */
// Scene material check: the GL scene pass draws a pixel scene from its material
// map, shading every cell on the GPU from the cell's world position
// (js/gl/scene_renderer.js "MATERIAL MAPS"). The CPU build of the same thing --
// texturePixelSceneForBiome, one instance at a time, which the Canvas2D path
// still draws from and which was measured against the game -- is the reference:
// this draws every scene variant a seed places, alone and at 1:1, through the
// minimal terrain view host and compares it with that build pixel for pixel.
//
//   systemd-run --user --quiet --collect --pipe --wait --slice=claude-limit.slice \
//     -p MemoryMax=10G --working-directory=$PWD \
//     /usr/bin/node test/scene_material_check.mjs [--seed=N] [--max=N] [--only=substr]
//       [--angle=swiftshader|vulkan] [--tolerance=2] [--allow=0.1]
//
// Two things are compared per scene:
//   color  the scene drawn over nothing, against the CPU build's pixels;
//   erase  which terrain pixels the scene's erase pass removes (air, the density
//          class answering air, translucent materials), against the CPU build's
//          air mask, wherever the terrain under the scene is not air already.
// A pixel differs when a channel is off by more than --tolerance (of 255). The
// run fails when a scene differs in more than --allow percent of its pixels
// (and more than a few of them): the band chooser runs in float32 on both
// sides but not in the same order of operations, so a handful of cells on a
// band's edge can land either way. Seed 786433191: 44 of 18.9 M pixels.
import { openPage, sleep, startServer } from './helpers/drive.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(s => s.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const SEED = Number(flag('seed', '786433191'));
const MAX = Number(flag('max', '0'));
const ONLY = flag('only', '');
const ANGLE = flag('angle', 'swiftshader');
const TOLERANCE = Number(flag('tolerance', '2'));
const ALLOW = Number(flag('allow', '0.1'));
const FEW = 8;

const server = await startServer();
let d = null;
let failed = 0;
try {
	d = await openPage({ port: server.port, angle: ANGLE, width: 1280, height: 800, path: '/test/terrain_view_host/index.html?auto=0' });
	for (let i = 0; i < 200; i++) {
		if (await d.evalIn('!!window.terrainHost').catch(() => false)) break;
		await sleep(200);
	}
	const variants = await d.evalIn(`(async () => {
		const h = window.terrainHost;
		await h.load({ seed: ${SEED}, fit: 3 });
		const g = await import('/js/pixel_scene_generation.js');
		await g.initPixelSceneTextures();
		// One placement per variant, the first in each world's list.
		const seen = new Set();
		window.sceneCheck = [];
		for (const [worldKey, list] of Object.entries(h.world.scenes)) {
			for (const scene of list) {
				if (!g.PIXEL_SCENE_DATA[scene.key]) continue;
				const id = scene.key + '/' + (scene.variantKey || '');
				if (seen.has(id) || !id.includes(${JSON.stringify(ONLY)})) continue;
				seen.add(id);
				window.sceneCheck.push({ worldKey, scene, id });
			}
		}
		window.sceneCheckWorld = h.world;
		return window.sceneCheck.length;
	})()`);
	const count = MAX > 0 ? Math.min(MAX, variants) : variants;
	console.log(`seed ${SEED}: ${variants} scene variants placed, checking ${count} (${ANGLE})`);

	const rows = [];
	for (let i = 0; i < count; i++) {
		const r = await d.evalIn(`(async () => {
			const h = window.terrainHost;
			const g = await import('/js/pixel_scene_generation.js');
			const { worldKey, scene, id } = window.sceneCheck[${i}];
			const data = g.PIXEL_SCENE_DATA[scene.key];
			const w = data.width, hh = data.height;
			await g.ensureScenePixels(data);
			const built = g.buildTexturedScenePixels(scene, data, true, 0);
			if (!built) return { id, error: 'no CPU build' };
			const ref = data.visualArt ? g.overlayVisualArt(built.pixels, w, hh, data.visualArt) : built.pixels;
			const gl = h.view.terrain.gl;
			const frame = async (ops, scenes) => {
				h.view.setWorld({ ...window.sceneCheckWorld, scenes });
				// The scene's own list, wherever the scene sits: a list reaches
				// outside its world (the moon is in the main world's, far above it).
				Object.assign(h.ops, { terrain: true, scenes: true, edgeDecals: false, sceneAir: true, sceneColor: true, worlds: [worldKey] }, ops);
				h.size = { width: w, height: hh };
				h.setView({ x: scene.x + w / 2, y: scene.y + hh / 2, zoom: 1 });
				await h.settle();
				h.draw();
				const up = new Uint8Array(w * hh * 4);
				gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, up);
				return up;   // premultiplied, rows bottom-up
			};
			// Every scanned world keeps a list, so the view is not left waiting for one.
			const only = Object.fromEntries(Object.keys(window.sceneCheckWorld.scenes).map(k => [k, k === worldKey ? [scene] : []]));
			const color = await frame({ terrain: false }, only);
			const terrain = await frame({ scenes: false }, {});
			const erased = await frame({ sceneColor: false }, only);
			const T = ${TOLERANCE};
			let painted = 0, colorDiff = 0, under = 0, eraseDiff = 0, worst = 0;
			for (let y = 0; y < hh; y++) {
				for (let x = 0; x < w; x++) {
					const p = (y * w + x) * 4, q = ((hh - 1 - y) * w + x) * 4;
					const a = ref[p + 3];
					if (a || color[q + 3]) painted++;
					let dmax = Math.abs(a - color[q + 3]);
					for (let c = 0; c < 3; c++) dmax = Math.max(dmax, Math.abs(Math.round(ref[p + c] * a / 255) - color[q + c]));
					if (dmax > T) colorDiff++;
					if (dmax > worst) worst = dmax;
					if (terrain[q + 3]) {
						under++;
						const want = !!(built.airMask && built.airMask[p + 3]);
						if (want !== (erased[q + 3] === 0)) eraseDiff++;
					}
				}
			}
			return { id, w, h: hh, painted, colorDiff, worst, under, eraseDiff, art: !!data.visualArt };
		})()`);
		rows.push(r);
		const pct = (n, of) => (of ? (100 * n / of).toFixed(3) : '0.000');
		if (r.error) { failed++; console.log(`FAIL ${r.id}: ${r.error}`); continue; }
		// A few cells either way are allowed whatever the scene's size.
		const over = (n, of) => n > Math.max(FEW, of * ALLOW / 100);
		const bad = over(r.colorDiff, r.painted) || over(r.eraseDiff, r.under);
		if (bad) failed++;
		if (bad || argv.includes('--verbose')) {
			console.log(`${bad ? 'FAIL' : 'ok  '} ${r.id} ${r.w}x${r.h}${r.art ? ' art' : ''}: color ${r.colorDiff}/${r.painted} (${pct(r.colorDiff, r.painted)}%, worst ${r.worst})`
				+ ` erase ${r.eraseDiff}/${r.under} (${pct(r.eraseDiff, r.under)}%)`);
		}
	}
	const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
	console.log(`${rows.length} variants: color ${sum('colorDiff')} of ${sum('painted')} pixels differ `
		+ `(${(100 * sum('colorDiff') / Math.max(1, sum('painted'))).toFixed(4)}%), `
		+ `erase ${sum('eraseDiff')} of ${sum('under')} (${(100 * sum('eraseDiff') / Math.max(1, sum('under'))).toFixed(4)}%), ${failed} failing`);
	if (d.errors.length) console.log('page errors:', d.errors.slice(0, 3));
	if (failed && d.logs.length) console.log('page log:', d.logs.slice(0, 6));
} finally {
	if (d) d.close();
	server.stop();
}
process.exit(failed ? 1 : 0);
