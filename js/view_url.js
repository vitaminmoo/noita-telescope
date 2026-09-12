// The `x` / `y` / `z` URL parameters that frame the view, in noitamap's scheme,
// so a link can be pasted from one tool into the other and land on the same
// region. Everything here is pure: the app.js glue owns the DOM, the history
// writes and the throttling.
//
// ---------------------------------------------------------------------------
// The mapping, derived from noitamap (src/data_sources/url.ts, src/app_osd.ts)
// ---------------------------------------------------------------------------
//
// noitamap draws with OpenSeadragon and writes the viewport centre plus a log
// zoom:
//
//     x = pos.x.toFixed(0)   y = pos.y.toFixed(0)
//     z = (Math.log2(zoom) * -100).toFixed(0)      zoom = 2 ** (z / -100)
//
// `pos` is `viewport.getCenter()` / `viewport.getZoom()`, so x/y/z live in OSD
// *viewport* units. noitamap pins those units to Noita's own world pixels: on
// `add-item` it calls `item.setPosition(Image.TopLeft)` and
// `item.setWidth(Image.Size.Width)` with the raw DZI numbers, e.g. the regular
// map's middle strip is 36352 px wide at TopLeft (-17920, -31744). -17920 is
// -35 * 512 (the world's centre chunk column) and the vertical origin sits one
// 48-chunk parallel world above -14 * 512. So:
//
//     1 OSD viewport unit == 1 Noita world pixel, origin at world (0, 0).
//
// `x` and `y` are therefore just absolute Noita world pixel coordinates of the
// centre of the view — the same numbers telescope already puts in its hover
// tooltip — rounded to whole pixels.
//
// `z` needs one more step. OSD defines its viewport bounds as
// `width = 1 / zoom` in viewport units, i.e. `zoom` is the reciprocal of the
// number of viewport units spanning the container width. With a viewport unit
// being a world pixel that makes z container-independent in meaning:
//
//     z = 100 * log2(world pixels across the width of the view)
//
// Telescope's camera stores the opposite quantity — `cam.z` is screen pixels
// per world pixel (`ctx.scale(cam.z, cam.z)`) — so the two convert as:
//
//     visibleWorldPx = viewWidthPx / cam.z
//     z              = 100 * log2(viewWidthPx / cam.z)
//     cam.z          = viewWidthPx / 2 ** (z / 100)
//
// Larger z is further out, as in noitamap. An integer z is a 2^(1/100) step,
// about 0.7% of zoom, which is finer than a single wheel notch in either tool.
//
// WHICH width goes in matters, and it is NOT telescope's canvas. noitamap's
// #osContainer is `width: 100%` of a full-viewport wrapper with its navbar
// stacked above and its menus overlaid, so OSD measures the whole window.
// Telescope's canvas is #view: the window minus the 300px sidebar (plus its
// 1px border). Feeding the canvas width in would make a shared z mean the same
// world SPAN in both tools but a DIFFERENT magnification — the same link would
// draw everything ~16% smaller here on a 1920px window — which defeats the
// point of pasting a link across to compare the two renderings.
//
// app.js therefore passes the WINDOW width (documentElement.clientWidth, the
// same quantity OSD reads off its container). A shared z is then the same
// screen-pixels-per-world-pixel in both tools, so features are the same size
// and the views are centred on the same world point; telescope simply shows
// less world horizontally, by exactly the sidebar. The vertical span still
// differs, for that reason plus each tool's own aspect ratio.
import { CHUNK_SIZE, MIN_CAM_Z, WORLD_CHUNK_CENTER_Y } from './constants.js';

/** Height of one vertical parallel world, in world pixels (48 chunks). */
export const PW_HEIGHT_PX = 48 * CHUNK_SIZE;
/** World Y of telescope's map-space y=0: the biome map starts 14 chunks up. */
export const WORLD_TOP_PX = WORLD_CHUNK_CENTER_Y * CHUNK_SIZE;
/** Vertical parallel worlds telescope is willing to visit either way. */
export const PW_VERTICAL_LIMIT = 683;
/** Zoomed-in stop for a URL-supplied `z`; the PoI jump already uses 5 px/px. */
export const MAX_CAM_Z = 64;
/** Coordinates further out than this are garbage, not a deep parallel world. */
const COORD_LIMIT = 1e9;

/**
 * Absolute Noita world pixel coordinates of telescope's camera centre.
 * Mirrors the tooltip math in app.js: map space plus the parallel-world offsets.
 */
export function worldFromCamera(cam, pw, pwVertical, worldSize, worldCenter) {
	return {
		x: cam.x + pw * worldSize * CHUNK_SIZE - worldCenter * CHUNK_SIZE,
		y: cam.y + pwVertical * PW_HEIGHT_PX - WORLD_TOP_PX,
	};
}

/**
 * Inverse of worldFromCamera: split an absolute world position into the
 * parallel world that contains it and telescope's in-world camera coordinates.
 * Coordinates beyond the parallel-world limits clamp to the edge of the last
 * reachable world rather than flying off into ungenerated space.
 */
export function cameraFromWorld(x, y, worldSize, worldCenter, pwLimit) {
	const spanX = worldSize * CHUNK_SIZE;
	let relX = clamp(x, -COORD_LIMIT, COORD_LIMIT) + worldCenter * CHUNK_SIZE;
	let pw = Math.floor(relX / spanX);
	let camX = relX - pw * spanX;
	if (pw < -pwLimit) { pw = -pwLimit; camX = 0; }
	else if (pw > pwLimit) { pw = pwLimit; camX = spanX; }

	const relY = clamp(y, -COORD_LIMIT, COORD_LIMIT) + WORLD_TOP_PX;
	let pwVertical = Math.floor(relY / PW_HEIGHT_PX);
	let camY = relY - pwVertical * PW_HEIGHT_PX;
	if (pwVertical < -PW_VERTICAL_LIMIT) { pwVertical = -PW_VERTICAL_LIMIT; camY = 0; }
	else if (pwVertical > PW_VERTICAL_LIMIT) { pwVertical = PW_VERTICAL_LIMIT; camY = PW_HEIGHT_PX; }

	return { camX, camY, pw, pwVertical };
}

/** Telescope's px-per-world-px -> noitamap's `z`. */
export function logZoomFromCamZ(camZ, viewWidthPx) {
	return 100 * Math.log2(viewWidthPx / camZ);
}

/** noitamap's `z` -> telescope's px-per-world-px, clamped to what it can draw. */
export function camZFromLogZoom(z, viewWidthPx) {
	return clamp(viewWidthPx / Math.pow(2, z / 100), MIN_CAM_Z, MAX_CAM_Z);
}

/**
 * Read x/y/z off a URLSearchParams. Returns null when none of them is present,
 * so a bare URL leaves the default view alone; otherwise each field is either a
 * finite number or null (missing, or unparseable — `z=abc` is ignored, not
 * fatal). parseInt semantics match noitamap's intQueryValue.
 */
export function parseViewParams(params) {
	const x = intParam(params, 'x');
	const y = intParam(params, 'y');
	const z = intParam(params, 'z');
	if (x === null && y === null && z === null) return null;
	return { x, y, z };
}

/** The three values as the strings that go in the URL (whole units, like noitamap). */
export function formatViewParams(x, y, z) {
	return { x: intString(x), y: intString(y), z: intString(z) };
}

function intParam(params, name) {
	if (!params.has(name)) return null;
	const parsed = Number.parseInt(params.get(name), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

// toFixed(0) is what noitamap writes, and it is not Math.round: it strips the
// sign first and rounds the magnitude, so ties go away from zero (-1.5 -> "-2",
// where Math.round gives -1). Use it directly so the two tools agree on every
// value; the only fixup is -0, which must not reach the URL as "-0".
function intString(value) {
	if (!Number.isFinite(value)) return '0';
	const text = value.toFixed(0);
	return text === '-0' ? '0' : text;
}

function clamp(value, lo, hi) {
	return Math.min(hi, Math.max(lo, value));
}
