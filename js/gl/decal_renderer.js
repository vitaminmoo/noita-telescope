// GL edge-decal pass: the world-space decal tiles (edge_decal_layer.js) drawn
// into the terrain renderer's canvas after the scenes, instead of one Canvas2D
// drawImage per tile on top of the blit.
//
// A tile is EDGE_DECAL_TILE square, straight-alpha RGBA, keyed by its absolute
// world tile coordinate. Tiles live in 2D array textures, one layer each, so a
// tile lands with a single texSubImage3D of raw bytes -- no ImageBitmap is
// made for it anywhere -- and the whole view draws as one instanced call per
// array. Arrays are allocated as the cache grows and never shrink; a full cache
// reuses the layer of the tile drawn longest ago.
//
// The pass is nearest-sampled, like the 2D draw it replaces: it only runs at
// zoom >= 1, where a decal texel covers at least one screen pixel.

const VS = `#version 300 es
layout(location = 0) in ivec3 a_tile;   // tile x, tile y, array layer
uniform int u_tileSize;
uniform ivec2 u_offInt;                 // tile space -> screen-origin space (world px), integer part
uniform vec2 u_offFrac;
uniform float u_zoom;
uniform vec2 u_screen;
out vec2 v_local;
flat out int v_layer;
void main() {
    int c = gl_VertexID;
    vec2 corner = vec2((c == 1 || c == 2 || c == 4) ? 1.0 : 0.0, (c == 2 || c == 4 || c == 5) ? 1.0 : 0.0);
    // Integer add first: tile positions carry the parallel-world offset.
    vec2 world = vec2(a_tile.xy * u_tileSize + u_offInt) + u_offFrac + corner * float(u_tileSize);
    vec2 s = world * u_zoom;
    gl_Position = vec4(s.x / u_screen.x * 2.0 - 1.0, 1.0 - s.y / u_screen.y * 2.0, 0.0, 1.0);
    v_local = corner * float(u_tileSize);
    v_layer = a_tile.z;
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray u_tiles;
uniform int u_tileSize;
in vec2 v_local;
flat in int v_layer;
out vec4 outColor;
void main() {
    ivec2 t = clamp(ivec2(floor(v_local)), ivec2(0), ivec2(u_tileSize - 1));
    vec4 c = texelFetch(u_tiles, ivec3(t, v_layer), 0);
    if (c.a == 0.0) discard;
    // Tiles are straight alpha; the canvas is premultiplied.
    outColor = vec4(c.rgb * c.a, c.a);
}`;

const UNIFORMS = ['u_tileSize', 'u_offInt', 'u_offFrac', 'u_zoom', 'u_screen', 'u_tiles'];
/** Layers per array texture: 64 x 256^2 RGBA = 16 MiB. */
const LAYERS_PER_ARRAY = 64;

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`GL decal shader compile failed: ${log}`);
    }
    return sh;
}

export class GLDecalRenderer {
    /**
     * @param {number} tileSize  world pixels per tile side
     * @param {number} maxTiles  tiles kept on the GPU; the least recently drawn go first
     */
    constructor(tileSize, maxTiles) {
        this.tileSize = tileSize;
        this.maxTiles = maxTiles;
        this.gl = null;
        this.program = null;
        this.failed = null;
        this.reset();
    }

    reset() {
        this.arrays = [];             // { tex, used: number of layers handed out }
        this.slots = new Map();       // "tx,ty" -> { array, layer, frame }
        this.buffer = null;
        this.instances = new Int32Array(0);
    }

    /** Forgets every tile (new world, or a restored context). */
    dropAll() {
        const gl = this.gl;
        if (gl) {
            for (const a of this.arrays) gl.deleteTexture(a.tex);
            if (this.buffer) gl.deleteBuffer(this.buffer);
        }
        this.reset();
    }

    init(gl) {
        if (this.failed) return false;
        if (this.gl === gl && this.program) return true;
        if (this.gl !== gl) this.reset();   // a new context: every name we held is gone
        this.gl = gl;
        try {
            const prog = gl.createProgram();
            const vs = compile(gl, gl.VERTEX_SHADER, VS), fs = compile(gl, gl.FRAGMENT_SHADER, FS);
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                throw new Error(`GL decal program link failed: ${gl.getProgramInfoLog(prog)}`);
            }
            this.program = prog;
        } catch (err) {
            console.warn('[GL decals]', err);
            this.failed = String(err);
            return false;
        }
        this.uniforms = Object.fromEntries(UNIFORMS.map(n => [n, gl.getUniformLocation(this.program, n)]));
        this.vao = gl.createVertexArray();
        return true;
    }

    has(key) {
        return this.slots.has(key);
    }

    stats() {
        return { tiles: this.slots.size, bytes: this.arrays.length * LAYERS_PER_ARRAY * this.tileSize * this.tileSize * 4 };
    }

    /** A free layer, or the layer of the tile drawn longest ago (never one from this frame). */
    allocate(frame) {
        const gl = this.gl;
        if (this.slots.size < this.maxTiles) {
            let array = this.arrays[this.arrays.length - 1];
            if (!array || array.used === LAYERS_PER_ARRAY) {
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.tileSize, this.tileSize, LAYERS_PER_ARRAY);
                array = { tex, used: 0 };
                this.arrays.push(array);
            }
            return { array, layer: array.used++ };
        }
        let victimKey = null, victim = null;
        for (const [key, slot] of this.slots) {
            if (slot.frame >= frame) continue;
            if (!victim || slot.frame < victim.frame) { victim = slot; victimKey = key; }
        }
        if (!victim) return null;
        this.slots.delete(victimKey);
        return { array: victim.array, layer: victim.layer };
    }

    /**
     * Uploads one tile. `rgba` is tileSize^2 * 4 bytes, straight alpha, rows
     * top-down. Returns false when the cache is full of tiles drawn this frame.
     */
    put(key, rgba, frame) {
        const gl = this.gl;
        let slot = this.slots.get(key);
        if (!slot) {
            slot = this.allocate(frame);
            if (!slot) return false;
            slot.frame = frame;
            this.slots.set(key, slot);
        }
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, slot.array.tex);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot.layer, this.tileSize, this.tileSize, 1,
            gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        return true;
    }

    /**
     * Draws the resident tiles among `tiles` over whatever the canvas holds.
     * @param terrain  the GLTerrainRenderer whose context and canvas are drawn into
     * @param view { width, height, zoom, frame,
     *               offX, offY: tile space -> screen-origin space, in world px
     *                           (tile t's left edge is at t * tileSize + off),
     *               tiles: [{ key, tx, ty }] }
     */
    draw(terrain, view) {
        const gl = terrain.gl;
        if (!gl || terrain.contextLost) { this.lost = true; return false; }
        if (this.lost) {
            // Restored context: every texture and the program went with the old one.
            this.reset();
            this.program = null;
            this.lost = false;
        }
        if (!this.init(gl)) return false;
        const { tiles } = view;
        if (this.instances.length < tiles.length * 3) this.instances = new Int32Array(tiles.length * 3 * 2);
        // Instances grouped by array, so each array is one draw.
        const groups = new Map();
        for (const t of tiles) {
            const slot = this.slots.get(t.key);
            if (!slot) continue;
            slot.frame = view.frame;
            let g = groups.get(slot.array);
            if (!g) groups.set(slot.array, g = []);
            g.push(t.tx, t.ty, slot.layer);
        }
        if (!groups.size) return true;

        const q = terrain.gpuTimerBegin();
        const u = this.uniforms;
        gl.viewport(0, 0, view.width, view.height);
        gl.useProgram(this.program);
        const ix = Math.floor(view.offX), iy = Math.floor(view.offY);
        gl.uniform1i(u.u_tileSize, this.tileSize);
        gl.uniform2i(u.u_offInt, ix, iy);
        gl.uniform2f(u.u_offFrac, view.offX - ix, view.offY - iy);
        gl.uniform1f(u.u_zoom, view.zoom);
        gl.uniform2f(u.u_screen, view.width, view.height);
        gl.uniform1i(u.u_tiles, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindVertexArray(this.vao);
        if (!this.buffer) this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribDivisor(0, 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        for (const [array, g] of groups) {
            this.instances.set(g);
            gl.bufferData(gl.ARRAY_BUFFER, this.instances.subarray(0, g.length), gl.DYNAMIC_DRAW);
            gl.vertexAttribIPointer(0, 3, gl.INT, 12, 0);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, array.tex);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, g.length / 3);
        }
        gl.disable(gl.BLEND);
        gl.vertexAttribDivisor(0, 0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        terrain.gpuTimerEnd(q, (ms) => terrain.gpuSample('edgeDecalsGL', ms));
        return true;
    }
}
