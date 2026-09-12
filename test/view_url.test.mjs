// The pure half of the x/y/z URL view parameters (js/view_url.js): the
// noitamap coordinate mapping, the round trip, and what garbage input does.
// The browser glue in app.js (history.replaceState, the throttle, applying the
// view once a world exists) is not covered here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	camZFromLogZoom, cameraFromWorld, formatViewParams, logZoomFromCamZ,
	parseViewParams, worldFromCamera, MAX_CAM_Z, PW_HEIGHT_PX, PW_VERTICAL_LIMIT,
} from '../js/view_url.js';
import { MIN_CAM_Z } from '../js/constants.js';

// Regular (non-NG+) world: 70 chunks wide, centre column 35, 468 parallel worlds.
const NG0 = { size: 70, center: 35, pwLimit: 468 };

const params = (s) => new URLSearchParams(s);

test('telescope default camera sits at world origin', () => {
	// app.js: cam { x: CHUNK_SIZE*35, y: CHUNK_SIZE*24 }, pw 0.
	const w = worldFromCamera({ x: 512 * 35, y: 512 * 24 }, 0, 0, NG0.size, NG0.center);
	assert.equal(w.x, 0);
	// Map space y=0 is 14 chunks above world 0, so 24 chunks down is 10 below it.
	assert.equal(w.y, 512 * 10);
});

test('camera <-> world round trips across parallel worlds', () => {
	for (const [camX, camY, pw, pwVertical] of [
		[0, 0, 0, 0], [17920, 12288, 0, 0], [1, 2, 3, 4],
		[35839, 24575, -7, 11], [512, 512, 468, -683],
	]) {
		const w = worldFromCamera({ x: camX, y: camY }, pw, pwVertical, NG0.size, NG0.center);
		const back = cameraFromWorld(w.x, w.y, NG0.size, NG0.center, NG0.pwLimit);
		assert.deepEqual(back, { camX, camY, pw, pwVertical }, `cam ${camX},${camY} pw ${pw},${pwVertical}`);
	}
});

test('a world position picks the parallel world that contains it', () => {
	// One world width east of centre is pw 1, same in-world position.
	const east = cameraFromWorld(70 * 512, 0, NG0.size, NG0.center, NG0.pwLimit);
	assert.equal(east.pw, 1);
	assert.equal(east.camX, 35 * 512);
	// One vertical world down.
	const down = cameraFromWorld(0, PW_HEIGHT_PX, NG0.size, NG0.center, NG0.pwLimit);
	assert.equal(down.pwVertical, 1);
});

test('z is 100*log2(world pixels across the view width)', () => {
	const width = 1280;
	// A view one world pixel per screen pixel wide shows `width` world pixels.
	assert.equal(logZoomFromCamZ(1, width), 100 * Math.log2(width));
	// noitamap's own definition: z = -100*log2(osdZoom), osdZoom = 1/visibleWorldPx.
	for (const camZ of [0.0625, 0.25, 1, 4]) {
		const osdZoom = 1 / (width / camZ);
		assert.ok(Math.abs(logZoomFromCamZ(camZ, width) - Math.log2(osdZoom) * -100) < 1e-9);
	}
});

test('zoom round trips through an integer z', () => {
	const width = 1280;
	for (const camZ of [0.0625, 0.25, 1, 5]) {
		const z = Math.round(logZoomFromCamZ(camZ, width));
		const back = camZFromLogZoom(z, width);
		// An integer z is a 2^(1/100) step, so it may move the zoom by <0.35%.
		assert.ok(Math.abs(back / camZ - 1) < 0.0035, `${camZ} -> z ${z} -> ${back}`);
	}
});

test('the same z frames the same world width at any container width', () => {
	const z = 1432;
	const wide = camZFromLogZoom(z, 1920);
	const narrow = camZFromLogZoom(z, 800);
	assert.ok(Math.abs((1920 / wide) - (800 / narrow)) < 1e-6);
});

test('absent parameters leave the default view untouched', () => {
	assert.equal(parseViewParams(params('')), null);
	assert.equal(parseViewParams(params('seed=123&ng=2&gamemode=nightmare')), null);
});

test('a partial view keeps the other axes', () => {
	assert.deepEqual(parseViewParams(params('z=1200')), { x: null, y: null, z: 1200 });
	assert.deepEqual(parseViewParams(params('x=10&y=-20')), { x: 10, y: -20, z: null });
});

test('garbage values are ignored, not fatal', () => {
	assert.deepEqual(parseViewParams(params('x=abc&y=&z=abc')), null);
	assert.deepEqual(parseViewParams(params('x=5&z=abc')), { x: 5, y: null, z: null });
	// parseInt semantics, matching noitamap's intQueryValue.
	assert.deepEqual(parseViewParams(params('x=12abc&y=-3.9&z=1e3')), { x: 12, y: -3, z: 1 });
});

test('absurd coordinates clamp to the last reachable parallel world', () => {
	const far = cameraFromWorld(1e12, 1e12, NG0.size, NG0.center, NG0.pwLimit);
	assert.equal(far.pw, NG0.pwLimit);
	assert.equal(far.pwVertical, PW_VERTICAL_LIMIT);
	const back = cameraFromWorld(-1e12, -1e12, NG0.size, NG0.center, NG0.pwLimit);
	assert.equal(back.pw, -NG0.pwLimit);
	assert.equal(back.pwVertical, -PW_VERTICAL_LIMIT);
	for (const v of [far.camX, far.camY, back.camX, back.camY]) assert.ok(Number.isFinite(v));
});

test('absurd zoom clamps to what telescope can draw', () => {
	assert.equal(camZFromLogZoom(100000, 1280), MIN_CAM_Z);
	assert.equal(camZFromLogZoom(-100000, 1280), MAX_CAM_Z);
});

test('formatting matches noitamap toFixed(0), without -0', () => {
	// Ties round away from zero, as toFixed does: -1.5 -> "-2", not Math.round's -1.
	const f = formatViewParams(-0.4, 1432.6, -1.5);
	assert.deepEqual(f, { x: '0', y: '1433', z: '-2' });
	for (const v of [0.5, -0.5, 12.5, -12.5, 1e6 + 0.5]) {
		assert.equal(formatViewParams(v, 0, 0).x, v.toFixed(0) === '-0' ? '0' : v.toFixed(0));
	}
});

test('full URL round trip: parse, apply, re-serialize', () => {
	const width = 1280;
	const view = parseViewParams(params('seed=786433191&x=-3000&y=9000&z=1200'));
	const cam = cameraFromWorld(view.x, view.y, NG0.size, NG0.center, NG0.pwLimit);
	const camZ = camZFromLogZoom(view.z, width);
	const world = worldFromCamera({ x: cam.camX, y: cam.camY }, cam.pw, cam.pwVertical, NG0.size, NG0.center);
	const out = formatViewParams(world.x, world.y, logZoomFromCamZ(camZ, width));
	assert.deepEqual(out, { x: '-3000', y: '9000', z: '1200' });
});
