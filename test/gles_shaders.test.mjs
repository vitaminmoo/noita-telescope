/* global Buffer */
// Tier 0 of the GL harness: compile, link and draw telescope's real terrain
// shaders through surfaceless EGL / OpenGL ES 3 in Node — seconds, no browser,
// no world generation, no fixtures.
//
// It does NOT replace test/gl_regression.mjs, which is the only tier that knows
// whether the pixels are RIGHT. This one answers the cheaper question tier 2
// cannot be run often enough to answer: does the shader the app ships still
// build at all, do the uniforms the renderer looks up still exist, and does a
// draw through the linked program raise a GL error. Those are the breakages a
// one-line edit to shaders.js causes, and until now nothing in `node --test`
// could see them.
//
// Skips (never fails) when koffi, libEGL or a Mesa ES3 driver are missing, so
// the suite stays green on a machine without them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TERRAIN_FS, TERRAIN_VS } from '../js/gl/shaders.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let native = null;
let skip = false;
try {
	const { createNativeGLES } = await import('./helpers/native_gles.mjs');
	native = createNativeGLES();
} catch (err) {
	skip = `no surfaceless ES3 context: ${err && err.message ? err.message : err}`;
}
const gl = native?.gl;

// The uniform list is read out of terrain_renderer.js rather than imported: the
// module pulls in the whole texture/atlas graph (and a material-atlas fetch) on
// import, none of which this gate needs. Parsing the literal still fails loudly
// if the array is renamed or removed, which is the drift worth catching.
function uniformNames() {
	const src = readFileSync(`${REPO}/js/gl/terrain_renderer.js`, 'utf8');
	const m = /const UNIFORM_NAMES = \[([\s\S]*?)\];/.exec(src);
	assert.ok(m, 'UNIFORM_NAMES not found in js/gl/terrain_renderer.js');
	return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

// Uniforms the linker is ENTITLED to drop, with the reason. GLSL strips any
// uniform no code path reads, and getUniformLocation then answers null — which
// is harmless (the renderer's uniform1i on a null location is a no-op) but must
// stay a short, named list: an unexpected addition means a uniform the renderer
// still sets stopped being read by the shader, i.e. a feature quietly died.
const EXPECTED_UNUSED = {
	// Declared in TERRAIN_FS but never read: every world-width fold in the
	// shader goes through u_worldSizeX (the parallel-world stride), which is
	// NOT the same number in NG+/nightmare (64*512-8 vs 64*512). The renderer
	// still uploads it; the linker drops it.
	u_worldWidth: 'declared in TERRAIN_FS but unread — all folds use u_worldSizeX',
};

function compile(type, src, what) {
	const sh = gl.createShader(type);
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	assert.ok(gl.getShaderParameter(sh, gl.COMPILE_STATUS),
		`${what} failed to compile:\n${gl.getShaderInfoLog(sh)}`);
	return sh;
}

let program = null;
function terrainProgram() {
	if (program) return program;
	const vs = compile(gl.VERTEX_SHADER, TERRAIN_VS, 'TERRAIN_VS');
	const fs = compile(gl.FRAGMENT_SHADER, TERRAIN_FS, 'TERRAIN_FS');
	const p = gl.createProgram();
	gl.attachShader(p, vs);
	gl.attachShader(p, fs);
	gl.linkProgram(p);
	assert.ok(gl.getProgramParameter(p, gl.LINK_STATUS),
		`the terrain program failed to link:\n${gl.getProgramInfoLog(p)}`);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	program = p;
	return p;
}

// The sampler split mirrors the declarations in shaders.js. It matters for the
// draw: a sampler's texture must match its declared type, and terrain_renderer
// binds a type-matched placeholder for exactly that reason ("a FLOAT sampler
// sharing unit 0 with the integer u_chunkTex is a draw-time
// INVALID_OPERATION"). Getting it wrong here would fail the draw, so the draw
// test doubles as a check that the sampler types in the shader are what the
// renderer's bindTextures() assumes.
const USAMPLERS = ['u_chunkTex', 'u_fgTex', 'u_noiseTex', 'u_indirTex', 'u_atlasTex', 'u_matAtlasTex',
	'u_matMetaTex', 'u_palMatTex', 'u_fgMatTex', 'u_latMatTex', 'u_engChunkTex'];
const ISAMPLERS = ['u_regionTex'];
const FSAMPLERS = ['u_paletteTex', 'u_covTex', 'u_engTableTex', 'u_sinHashTex'];

const CHUNK_SIZE = 512;
const DRAW_W = 64, DRAW_H = 64;

/** A 1x1 zero texture of the given class, NEAREST-filtered (integer textures
 *  are incomplete under any other filter). Zeroed on purpose: a chunk texel of
 *  0 carries no flags, so the shader takes its documented "nothing here" exits
 *  instead of wandering into region lookups against a 1x1 atlas. */
function placeholder(kind) {
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	const zeros = Buffer.alloc(16);
	if (kind === 'uint') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, zeros);
	else if (kind === 'int') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32I, 1, 1, 0, gl.RGBA_INTEGER, gl.INT, zeros);
	else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, zeros);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return tex;
}

/**
 * Runs one full-screen terrain pass over a 64x64 viewport, the way
 * GLTerrainRenderer.render() does: bind every sampler to its own type-matched
 * unit, upload the camera/world uniforms, draw the attribute-less triangle.
 * @returns {Uint8Array} the RGBA readback
 */
function drawTerrain(engineTerrain) {
	const p = terrainProgram();
	const u = Object.fromEntries(uniformNames().map(n => [n, gl.getUniformLocation(p, n)]));
	gl.useProgram(p);
	gl.disable(gl.BLEND);
	gl.disable(gl.DEPTH_TEST);

	const textures = [];
	const units = [...USAMPLERS.map(n => [n, 'uint']), ...ISAMPLERS.map(n => [n, 'int']),
		...FSAMPLERS.map(n => [n, 'float'])];
	units.forEach(([name, kind], i) => {
		const tex = placeholder(kind);
		textures.push(tex);
		gl.activeTexture(gl.TEXTURE0 + i);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.uniform1i(u[name], i);
	});

	// A plausible NG0 camera at the world origin; the values only have to be the
	// kind the renderer uploads, since this gate asserts execution, not pixels.
	gl.uniform2i(u.u_originInt, 0, 0);
	gl.uniform2f(u.u_originFrac, 0, 0);
	gl.uniform1f(u.u_invZoom, 1);
	gl.uniform2f(u.u_screenSize, DRAW_W, DRAW_H);
	gl.uniform1i(u.u_mapWidth, 70);
	gl.uniform1i(u.u_worldWidth, 70 * CHUNK_SIZE);
	gl.uniform1i(u.u_centerPx, 35 * CHUNK_SIZE);
	gl.uniform1i(u.u_baseY, 14 * CHUNK_SIZE);
	gl.uniform1i(u.u_maxRow, 47);
	gl.uniform1i(u.u_worldSizeX, 70 * CHUNK_SIZE);
	gl.uniform1i(u.u_edgeNoise, 1);
	gl.uniform1i(u.u_matDetail, 0);
	gl.uniform1i(u.u_engineTerrain, engineTerrain ? 1 : 0);
	gl.uniform1f(u.u_surfacePhase, 0);
	gl.uniform2i(u.u_vpOrigin, 0, 0);
	gl.uniform1i(u.u_materialIdOut, 0);

	gl.viewport(0, 0, DRAW_W, DRAW_H);
	// Opaque blue, then draw: the shader writes vec4(0) for every fragment it
	// resolves to air, so a blue pixel left behind means the fragment shader
	// never ran and the "no GL error" assertion would have been vacuous.
	gl.clearColor(0, 0, 1, 1);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.finish();

	const pixels = new Uint8Array(DRAW_W * DRAW_H * 4);
	gl.readPixels(0, 0, DRAW_W, DRAW_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	for (const tex of textures) gl.deleteTexture(tex);
	return pixels;
}

test('a surfaceless OpenGL ES 3 context comes up', { skip }, (t) => {
	t.diagnostic(`GL_VENDOR   ${native.vendor}`);
	t.diagnostic(`GL_RENDERER ${native.renderer}`);
	t.diagnostic(`GL_VERSION  ${native.version}`);
	t.diagnostic(`GLSL        ${native.glsl}`);
	assert.match(native.version, /OpenGL ES 3\./, 'the context must really be ES3 (ES2 has no #version 300 es)');
});

test('TERRAIN_VS compiles', { skip }, () => {
	gl.deleteShader(compile(gl.VERTEX_SHADER, TERRAIN_VS, 'TERRAIN_VS'));
});

test('TERRAIN_FS compiles', { skip }, () => {
	gl.deleteShader(compile(gl.FRAGMENT_SHADER, TERRAIN_FS, 'TERRAIN_FS'));
});

test('the terrain program links', { skip }, () => {
	assert.ok(terrainProgram() > 0);
});

test('every uniform the renderer looks up exists in the linked program', { skip }, (t) => {
	const p = terrainProgram();
	const names = uniformNames();
	assert.ok(names.length >= 30, `UNIFORM_NAMES parsed as only ${names.length} entries`);

	const missing = names.filter(n => gl.getUniformLocation(p, n) === null);
	const unexpected = missing.filter(n => !(n in EXPECTED_UNUSED));
	assert.deepEqual(unexpected, [],
		`the shader no longer reads ${unexpected.join(', ')} — a renderer feature lost its input`);

	// The other direction: a name on the expected-unused list that suddenly
	// resolves is fine, but it must not be silently forgotten, so say so.
	for (const [name, why] of Object.entries(EXPECTED_UNUSED)) {
		t.diagnostic(gl.getUniformLocation(p, name) === null
			? `${name}: optimized out as expected (${why})`
			: `${name}: now resolves — EXPECTED_UNUSED can drop it`);
	}

	// Every name the linker DID keep is one the renderer must still be setting;
	// an active uniform missing from UNIFORM_NAMES never gets uploaded and reads
	// as zero at draw time, which is the silent-black-screen class of bug.
	const active = [];
	for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
		active.push(gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''));
	}
	assert.deepEqual(active.filter(n => !names.includes(n)), [],
		'the shader reads a uniform UNIFORM_NAMES does not list, so the renderer never uploads it');
});

test('a full-screen terrain pass draws with no GL error', { skip }, () => {
	const pixels = drawTerrain(false);
	assert.equal(pixels.length, DRAW_W * DRAW_H * 4);
	const blue = pixels.findIndex((v, i) => i % 4 === 2 && v === 255);
	assert.equal(blue, -1, 'a cleared-blue pixel survived the draw: the fragment shader never ran there');
});

test('the engine-resolve branch draws with no GL error', { skip }, () => {
	// u_engineTerrain flips main() onto the engine chain (engResolveCell ->
	// engTopo0/engTopo2), which is most of the shader's code and never runs in
	// the legacy pass above. Zeroed tables make it resolve to air, but every
	// texelFetch, loop and sampler on that path still executes.
	const pixels = drawTerrain(true);
	const blue = pixels.findIndex((v, i) => i % 4 === 2 && v === 255);
	assert.equal(blue, -1, 'a cleared-blue pixel survived the engine-mode draw');
});

after(() => native?.dispose());
