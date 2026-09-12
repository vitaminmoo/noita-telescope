/* global Buffer */
// Real surfaceless EGL / OpenGL ES 3 in Node — not a mock, not a browser.
//
// Tier 2 (test/gl_regression.mjs) proves the rendered pixels against the game's
// own dumps, but it needs Chrome, a server and ~40 s of world generation, so it
// only runs on demand. That leaves the cheapest failure — a shader that no
// longer compiles, or a uniform that quietly stopped existing — undetected
// until someone runs the browser tier by hand. This harness closes that gap:
// libEGL creates a pbuffer ES3 context against Mesa's surfaceless platform,
// libGLESv2 provides the GL entry points through koffi, and telescope's own
// TERRAIN_VS / TERRAIN_FS compile, link and draw in-process.
//
// GLSL ES 3.00 is the same language WebGL2 exposes and Mesa's compiler is the
// one Firefox uses on Linux, so a shader that survives here is one Firefox
// accepts. It is deliberately NOT the same compiler as tier 2's ANGLE: the two
// disagree on exactly the corners shaders.js documents (`%` and `/` on negative
// operands), which is why catching Mesa's opinion in CI is worth a gate.
//
// Deliberately no canvas dependency. The reference this was ported from blitted
// every draw into a @napi-rs/canvas 2D context so an integration harness could
// inspect the image; here the only consumer is an assertion, and glReadPixels
// into a typed array answers it without pulling a second canvas package (the
// repo already has `canvas`, and adding a rival would be two native builds for
// a path this gate never takes). createCanvas() therefore returns a plain
// stand-in object: enough of the HTMLCanvasElement surface for renderer code
// that resizes it and registers webglcontextlost listeners, nothing more.
import koffi from 'koffi';

// EGL. Values from eglplatform/egl.h; spelled out because there is no header to
// include and the numbers are stable ABI.
const EGL_PLATFORM_SURFACELESS_MESA = 0x31dd;
const EGL_OPENGL_ES_API = 0x30a0;
const EGL_SURFACE_TYPE = 0x3033;
const EGL_RENDERABLE_TYPE = 0x3040;
const EGL_OPENGL_ES3_BIT = 0x40;
const EGL_ALPHA_SIZE = 0x3021;
const EGL_BLUE_SIZE = 0x3022;
const EGL_GREEN_SIZE = 0x3023;
const EGL_RED_SIZE = 0x3024;
const EGL_HEIGHT = 0x3056;
const EGL_WIDTH = 0x3057;
const EGL_CONTEXT_CLIENT_VERSION = 0x3098;
const EGL_NONE = 0x3038;

// The offscreen surface every draw lands in. Viewports are set per draw; this
// is only the ceiling on how large a test render can be.
const PBUFFER_SIZE = 2048;

// The GL enums this harness exposes, named as WebGL2 names them so renderer
// code reading `gl.COMPILE_STATUS` finds what it expects.
const C = {
	ACTIVE_UNIFORMS: 0x8b86,
	ARRAY_BUFFER: 0x8892,
	BLEND: 0x0be2,
	CLAMP_TO_EDGE: 0x812f,
	COLOR_ATTACHMENT0: 0x8ce0,
	COLOR_BUFFER_BIT: 0x4000,
	COMPILE_STATUS: 0x8b81,
	DEPTH_TEST: 0x0b71,
	FLOAT: 0x1406,
	FRAGMENT_SHADER: 0x8b30,
	FRAMEBUFFER: 0x8d40,
	FRAMEBUFFER_COMPLETE: 0x8cd5,
	INT: 0x1404,
	LINK_STATUS: 0x8b82,
	MAX_TEXTURE_SIZE: 0x0d33,
	NEAREST: 0x2600,
	R8UI: 0x8232,
	R16UI: 0x8234,
	R32F: 0x822e,
	RED_INTEGER: 0x8d94,
	RENDERER: 0x1f01,
	RG16UI: 0x823a,
	RG_INTEGER: 0x8228,
	RGBA: 0x1908,
	RGBA8: 0x8058,
	RGBA8UI: 0x8d7c,
	RGBA16UI: 0x8d76,
	RGBA32F: 0x8814,
	RGBA32I: 0x8d82,
	RGBA_INTEGER: 0x8d99,
	SHADING_LANGUAGE_VERSION: 0x8b8c,
	TEXTURE0: 0x84c0,
	TEXTURE_2D: 0x0de1,
	TEXTURE_MAG_FILTER: 0x2800,
	TEXTURE_MIN_FILTER: 0x2801,
	TEXTURE_WRAP_S: 0x2802,
	TEXTURE_WRAP_T: 0x2803,
	TRIANGLES: 0x0004,
	UNPACK_ALIGNMENT: 0x0cf5,
	UNSIGNED_BYTE: 0x1401,
	UNSIGNED_INT: 0x1405,
	UNSIGNED_SHORT: 0x1403,
	VENDOR: 0x1f00,
	VERSION: 0x1f02,
	VERTEX_SHADER: 0x8b31,
};

// Calls with nothing to return and nothing to read back: wrapped uniformly so
// every one of them gets its own glGetError() check (below). A GL error is
// otherwise sticky and anonymous — it surfaces at whatever call happens to look
// next, which is exactly the debugging experience this gate exists to avoid.
const VOID_CALLS = {
	activeTexture: 'void glActiveTexture(uint texture)',
	attachShader: 'void glAttachShader(uint program, uint shader)',
	bindFramebuffer: 'void glBindFramebuffer(uint target, uint framebuffer)',
	bindTexture: 'void glBindTexture(uint target, uint texture)',
	clear: 'void glClear(uint mask)',
	clearColor: 'void glClearColor(float r, float g, float b, float a)',
	compileShader: 'void glCompileShader(uint shader)',
	deleteProgram: 'void glDeleteProgram(uint program)',
	deleteShader: 'void glDeleteShader(uint shader)',
	disable: 'void glDisable(uint capability)',
	enable: 'void glEnable(uint capability)',
	finish: 'void glFinish()',
	flush: 'void glFlush()',
	framebufferTexture2D:
		'void glFramebufferTexture2D(uint target, uint attachment, uint textarget, uint texture, int level)',
	linkProgram: 'void glLinkProgram(uint program)',
	pixelStorei: 'void glPixelStorei(uint name, int value)',
	texImage2D:
		'void glTexImage2D(uint target, int level, int internalFormat, int w, int h, int border, uint format, uint type, const void *data)',
	texParameteri: 'void glTexParameteri(uint target, uint name, int value)',
	texSubImage2D:
		'void glTexSubImage2D(uint target, int level, int x, int y, int w, int h, uint format, uint type, const void *data)',
	uniform1f: 'void glUniform1f(int location, float value)',
	uniform1i: 'void glUniform1i(int location, int value)',
	uniform2f: 'void glUniform2f(int location, float x, float y)',
	uniform2i: 'void glUniform2i(int location, int x, int y)',
	uniform4f: 'void glUniform4f(int location, float x, float y, float z, float w)',
	useProgram: 'void glUseProgram(uint program)',
	viewport: 'void glViewport(int x, int y, int width, int height)',
};

/**
 * Brings up a surfaceless ES3 context and returns the WebGL2-shaped facade.
 * Throws when EGL, GLES or a usable ES3 config is missing — the caller is
 * expected to turn that into a skip, not a failure (see gles_shaders.test.mjs).
 *
 * @returns {{gl: object, renderer: string, version: string, vendor: string,
 *            glsl: string, createCanvas: Function, dispose: Function}}
 */
export function createNativeGLES() {
	const egl = koffi.load('libEGL.so.1');
	const lib = koffi.load('libGLESv2.so.2');

	const eglGetPlatformDisplay = egl.func(
		'void *eglGetPlatformDisplay(uint platform, void *native, const intptr_t *attributes)');
	const eglInitialize = egl.func('uint eglInitialize(void *display, _Out_ int *major, _Out_ int *minor)');
	const eglChooseConfig = egl.func(
		'uint eglChooseConfig(void *display, const int *attributes, _Out_ void **configs, int size, _Out_ int *count)');
	const eglBindAPI = egl.func('uint eglBindAPI(uint api)');
	const eglCreatePbufferSurface = egl.func(
		'void *eglCreatePbufferSurface(void *display, void *config, const int *attributes)');
	const eglCreateContext = egl.func(
		'void *eglCreateContext(void *display, void *config, void *shared, const int *attributes)');
	const eglMakeCurrent = egl.func('uint eglMakeCurrent(void *display, void *draw, void *read, void *context)');
	const eglDestroyContext = egl.func('uint eglDestroyContext(void *display, void *context)');
	const eglDestroySurface = egl.func('uint eglDestroySurface(void *display, void *surface)');
	const eglTerminate = egl.func('uint eglTerminate(void *display)');

	// No X11, no Wayland, no device node to pick: Mesa's surfaceless platform
	// renders into memory (llvmpipe/softpipe when there is no GPU), which is what
	// makes this runnable on a headless CI box.
	const display = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, null, null);
	if (!display) throw new Error('eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA) returned no display');
	if (!eglInitialize(display, [0], [0])) throw new Error('eglInitialize failed on the surfaceless display');

	const configs = [null];
	const count = [0];
	const ok = eglChooseConfig(display, [
		EGL_SURFACE_TYPE, 1,                      // EGL_PBUFFER_BIT
		EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
		EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
		EGL_NONE,
	], configs, 1, count);
	if (!ok || !count[0]) throw new Error('no EGL config with an ES3 pbuffer (Mesa too old, or no swrast driver)');

	eglBindAPI(EGL_OPENGL_ES_API);
	const surface = eglCreatePbufferSurface(display, configs[0],
		[EGL_WIDTH, PBUFFER_SIZE, EGL_HEIGHT, PBUFFER_SIZE, EGL_NONE]);
	const context = eglCreateContext(display, configs[0], null, [EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE]);
	if (!surface || !context) throw new Error('EGL ES3 pbuffer surface / context creation failed');
	if (!eglMakeCurrent(display, surface, surface, context)) throw new Error('eglMakeCurrent failed');

	const glGetError = lib.func('uint glGetError()');
	const glGetString = lib.func('const char *glGetString(uint name)');
	const glGetIntegerv = lib.func('void glGetIntegerv(uint name, _Out_ int *value)');
	const glCreateShader = lib.func('uint glCreateShader(uint type)');
	const glCreateProgram = lib.func('uint glCreateProgram()');
	const glShaderSource = lib.func(
		'void glShaderSource(uint shader, int count, const char **source, const int *lengths)');
	const glGetShaderiv = lib.func('void glGetShaderiv(uint shader, uint name, _Out_ int *value)');
	const glGetProgramiv = lib.func('void glGetProgramiv(uint program, uint name, _Out_ int *value)');
	const glGetShaderInfoLog = lib.func(
		'void glGetShaderInfoLog(uint shader, int capacity, _Out_ int *length, _Out_ char *log)');
	const glGetProgramInfoLog = lib.func(
		'void glGetProgramInfoLog(uint program, int capacity, _Out_ int *length, _Out_ char *log)');
	const glGetUniformLocation = lib.func('int glGetUniformLocation(uint program, const char *name)');
	const glGetActiveUniform = lib.func(
		'void glGetActiveUniform(uint program, uint index, int capacity, _Out_ int *length, _Out_ int *size, _Out_ uint *type, _Out_ char *name)');
	const glGenTextures = lib.func('void glGenTextures(int count, _Out_ uint *textures)');
	const glDeleteTextures = lib.func('void glDeleteTextures(int count, const uint *textures)');
	const glGenFramebuffers = lib.func('void glGenFramebuffers(int count, _Out_ uint *framebuffers)');
	const glDeleteFramebuffers = lib.func('void glDeleteFramebuffers(int count, const uint *framebuffers)');
	const glCheckFramebufferStatus = lib.func('uint glCheckFramebufferStatus(uint target)');
	const glDrawArrays = lib.func('void glDrawArrays(uint mode, int first, int count)');
	const glReadPixels = lib.func(
		'void glReadPixels(int x, int y, int w, int h, uint format, uint type, _Out_ uint8_t *data)');

	// Every wrapped call ends here. Errors are reported against the call that
	// produced them instead of the next call that happens to ask.
	const check = (label) => {
		const err = glGetError();
		if (err) throw new Error(`${label}: GL error 0x${err.toString(16)}`);
	};
	const readLog = (get, handle) => {
		const buf = Buffer.alloc(64 * 1024);
		get(handle, buf.length, [0], buf);
		return buf.toString('utf8').split('\0')[0];
	};

	const gl = { ...C };
	for (const [name, signature] of Object.entries(VOID_CALLS)) {
		const native = lib.func(signature);
		const isUniform = name.startsWith('uniform');
		gl[name] = (...args) => {
			// WebGL silently ignores a uniform set through a null location (the
			// name was optimized out); GL spells that location -1. Translate, so
			// renderer code that stores getUniformLocation()'s null and sets it
			// unconditionally behaves here exactly as it does in a browser.
			if (isUniform && (args[0] === null || args[0] === undefined)) args[0] = -1;
			native(...args);
			check(name);
		};
	}

	gl.getError = glGetError;
	gl.getParameter = (name) => {
		// Strings and integers come back through different entry points; the
		// handful of string parameters are the ones a diagnostic asks for.
		if (name === C.VENDOR || name === C.RENDERER || name === C.VERSION || name === C.SHADING_LANGUAGE_VERSION) {
			return glGetString(name);
		}
		const value = [0];
		glGetIntegerv(name, value);
		return value[0];
	};
	gl.createShader = (type) => {
		const sh = glCreateShader(type);
		check('createShader');
		return sh;
	};
	gl.createProgram = () => {
		const p = glCreateProgram();
		check('createProgram');
		return p;
	};
	// WebGL passes the source as one string; GL wants an array plus a count.
	gl.shaderSource = (shader, source) => {
		glShaderSource(shader, 1, [source], null);
		check('shaderSource');
	};
	gl.getShaderParameter = (shader, name) => {
		const value = [0];
		glGetShaderiv(shader, name, value);
		check('getShaderParameter');
		// WebGL hands back a boolean for the status pnames; renderer code tests
		// the result directly, and 0/1 would pass either way, but matching the
		// real API keeps a strict comparison honest.
		return (name === C.COMPILE_STATUS) ? !!value[0] : value[0];
	};
	gl.getProgramParameter = (program, name) => {
		const value = [0];
		glGetProgramiv(program, name, value);
		check('getProgramParameter');
		return (name === C.LINK_STATUS) ? !!value[0] : value[0];
	};
	gl.getShaderInfoLog = (shader) => readLog(glGetShaderInfoLog, shader);
	gl.getProgramInfoLog = (program) => readLog(glGetProgramInfoLog, program);
	// WebGL returns a WebGLUniformLocation object or null; GL returns -1 for a
	// name the linker did not keep. Null is what callers branch on, and
	// glUniform*(-1, ...) is a documented no-op either way.
	gl.getUniformLocation = (program, name) => {
		const loc = glGetUniformLocation(program, name);
		check('getUniformLocation');
		return loc < 0 ? null : loc;
	};
	gl.getActiveUniform = (program, index) => {
		const name = Buffer.alloc(256);
		const size = [0];
		const type = [0];
		glGetActiveUniform(program, index, name.length, [0], size, type, name);
		check('getActiveUniform');
		return { name: name.toString('utf8').split('\0')[0], size: size[0], type: type[0] };
	};
	gl.createTexture = () => {
		const value = [0];
		glGenTextures(1, value);
		check('createTexture');
		return value[0];
	};
	gl.deleteTexture = (texture) => {
		glDeleteTextures(1, [texture]);
		check('deleteTexture');
	};
	gl.createFramebuffer = () => {
		const value = [0];
		glGenFramebuffers(1, value);
		check('createFramebuffer');
		return value[0];
	};
	gl.deleteFramebuffer = (fb) => {
		glDeleteFramebuffers(1, [fb]);
		check('deleteFramebuffer');
	};
	gl.checkFramebufferStatus = (target) => {
		const status = glCheckFramebufferStatus(target);
		check('checkFramebufferStatus');
		return status;
	};
	gl.drawArrays = (mode, first, count_) => {
		glDrawArrays(mode, first, count_);
		check('drawArrays');
	};
	// WebGL's readPixels writes into the caller's typed array; koffi copies the
	// bytes back out of the _Out_ buffer, so the same call shape works here.
	gl.readPixels = (x, y, w, h, format, type, pixels) => {
		glReadPixels(x, y, w, h, format, type, pixels);
		check('readPixels');
	};

	// The renderer under test resizes its canvas and subscribes to context-loss
	// events. Neither means anything to a pbuffer, but both have to exist or the
	// code under test throws before it ever reaches a GL call.
	const createCanvas = (width = 1, height = 1) => {
		const events = new EventTarget();
		return {
			width, height,
			addEventListener: events.addEventListener.bind(events),
			removeEventListener: events.removeEventListener.bind(events),
			dispatchEvent: events.dispatchEvent.bind(events),
			getContext: (type) => (type === 'webgl2' ? gl : null),
		};
	};

	return {
		gl,
		renderer: glGetString(C.RENDERER),
		version: glGetString(C.VERSION),
		vendor: glGetString(C.VENDOR),
		glsl: glGetString(C.SHADING_LANGUAGE_VERSION),
		createCanvas,
		dispose() {
			eglMakeCurrent(display, null, null, null);
			eglDestroyContext(display, context);
			eglDestroySurface(display, surface);
			eglTerminate(display);
		},
	};
}
