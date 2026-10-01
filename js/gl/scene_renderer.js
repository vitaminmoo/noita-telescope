// GL pixel-scene pass: drawNow layer 5's scene images, drawn into the terrain
// renderer's canvas right after the terrain and before it is blitted, instead of
// one (or, with a FORCE AIR mask, two) Canvas2D drawImage per scene per frame.
//
// Scene bitmaps still come from the pixel-scene bitmap cache (built in the
// overlay worker); this pass copies each one it needs into an RGBA atlas page
// once and keeps it there. Pages are shelf-packed in arrival order and evicted
// whole, least recently drawn first, over a byte budget -- scenes of every
// size come and go, and a whole-page eviction never fragments.
//
// Per world copy the visible scenes become one instance buffer, grouped by
// page, rebuilt only when the view crosses a coarse cell, the mip level
// changes, a bitmap lands or a page is evicted. A pan inside a cell is a few
// uniforms and one instanced draw per page: no per-scene JS at all.
//
// FORCE AIR (#000042) and translucent materials, at any level built with
// material textures on, are drawn first as an alpha erase of the terrain
// canvas, so the 2D layers under the terrain blit
// (the background stack) show through the hole. That replaces the Canvas2D
// path's destination-out mask plus the destination-over background refill.
// Unlike the 2D path, all masks of a copy erase before any scene paints, so a
// scene's air no longer erases an EARLIER overlapping scene's pixels.
//
// MATERIAL MAPS. With material textures on, the levels close enough to show
// them (pixelScenesTexturedAt) are not drawn from bitmaps at all. A scene's
// cells get their colors from where they are in the world -- the material's
// texture is sampled at the cell's world position, the density class runs the
// biome's band chooser there -- so a bitmap of it is only good for one
// placement and one zoom band, and building those on demand is what made
// scenes arrive flat and sharpen a few frames later. Instead each scene
// VARIANT is uploaded once as a material map (pixel_scene_generation.js
// buildSceneMaterialMap: what every pixel is, plus the colors-file art) and a
// second program, the terrain shader's own library with a scene main(), shades
// each fragment from its world cell. One upload serves every placement and
// every zoom of those levels, and survives a new seed. Maps of the scenes not
// in view are brought in during idle frames (prewarm), so a pan, a zoom or a
// jump finds them already there.

import {
    forgetSceneMaterialMap, getPixelSceneDrawable, landedSceneMaterialMap, pendingPixelSceneBitmaps,
    PIXEL_SCENE_DATA, PIXEL_SCENE_MAX_MIP, pixelSceneBitmapVersion, pixelSceneCacheEpoch, pixelSceneCacheKeys,
    pixelScenesTexturedAt, releaseSceneMaterialBytes, requestSceneMaterialMap, sceneMaterialKey,
    sceneMaterialMapFailed, sceneMaterialSlotKey, warmPixelScene,
} from '../pixel_scene_generation.js';
import { frameSlo } from '../frame_slo.js';
import { pixelFilterGLSL, SCENE_MATERIAL_FS, SCENE_MATERIAL_VS } from './shaders.js';
import { GLTerrainRenderer } from './terrain_renderer.js';

const VS = `#version 300 es
layout(location = 0) in ivec4 a_rect;   // scene rect in list space: x, y, w, h (world px)
layout(location = 1) in ivec4 a_src;    // atlas x, y and bitmap w, h
layout(location = 2) in ivec2 a_mask;   // atlas x, y of the air mask (same size as the bitmap)
uniform ivec2 u_copyInt;                // list space -> screen-origin space, integer part
uniform vec2 u_copyFrac;
uniform float u_zoom;
uniform vec2 u_screen;
uniform bool u_air;
out vec2 v_local;
flat out ivec4 v_src;
flat out ivec2 v_size;
void main() {
    int c = gl_VertexID;
    vec2 corner = vec2((c == 1 || c == 2 || c == 4) ? 1.0 : 0.0, (c == 2 || c == 4 || c == 5) ? 1.0 : 0.0);
    // Integer add first: list-space positions carry the PW stride.
    vec2 world = vec2(a_rect.xy + u_copyInt) + u_copyFrac + corner * vec2(a_rect.zw);
    vec2 s = world * u_zoom;
    gl_Position = vec4(s.x / u_screen.x * 2.0 - 1.0, 1.0 - s.y / u_screen.y * 2.0, 0.0, 1.0);
    v_local = corner * vec2(a_rect.zw);
    v_src = u_air ? ivec4(a_mask, a_src.zw) : a_src;
    v_size = a_rect.zw;
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_atlas;
uniform bool u_air;
uniform float u_zoom;
in vec2 v_local;
flat in ivec4 v_src;
flat in ivec2 v_size;
out vec4 outColor;
// Texels are premultiplied (UNPACK_PREMULTIPLY_ALPHA_WEBGL), so they average directly.
vec4 sceneTexel(ivec2 q) { return texelFetch(u_atlas, v_src.xy + clamp(q, ivec2(0), v_src.zw - 1), 0); }
${pixelFilterGLSL('sceneFiltered', '', 'sceneTexel(q)')}
void main() {
    // The bitmap (any mip level) is stretched over the scene's full-resolution rect.
    vec2 scale = vec2(v_src.zw) / vec2(v_size);
    vec2 tc = v_local * scale;
    ivec2 t = clamp(ivec2(floor(tc)), ivec2(0), v_src.zw - 1);
    if (u_air) {
        // The air mask stays nearest and binary: it erases, it does not blend.
        if (texelFetch(u_atlas, v_src.xy + t, 0).a == 0.0) discard;
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    vec4 c = sceneFiltered(t, tc - floor(tc), scale / u_zoom);
    // Coverage never drops below the nearest texel's: a one-pixel seam between a
    // scene and the terrain must not turn translucent (see halveWithoutHoles).
    vec4 n = sceneTexel(t);
    if (c.a < n.a) c = c.a > 0.0 ? c * (n.a / c.a) : n;
    if (c.a == 0.0) discard;
    outColor = c;
}`;

const UNIFORMS = ['u_copyInt', 'u_copyFrac', 'u_zoom', 'u_screen', 'u_air', 'u_atlas'];

const STRIDE_INTS = 12;             // rect(4) src(4) mask(2) world(2)
const GRID_CELL = 2048;             // list-space bucket for the visibility query
const UPLOAD_BYTES_PER_FRAME = 16 * 1024 * 1024;   // at least one upload always goes through
// Material maps upload in row strips, so one large scene (the lava lake's map
// is 24 MB) spreads over frames instead of landing in one.
const MAP_STRIP_BYTES = 4 * 1024 * 1024;
// Maps brought in ahead of need (prewarm) get a smaller share of a frame, and
// stop short of the budget: they never evict what is being drawn.
const WARM_BYTES_PER_FRAME = 4 * 1024 * 1024;
const WARM_BUDGET_SHARE = 0.75;
const WARM_RETRY_MS = 50;
const LIST_STATES_MAX = 32;
// Bitmaps landing re-run a copy's query at most this often. While a build burst
// streams in (Render Everything's warm-up: thousands of textured instances) a
// requery per landed bitmap per frame costs more than the whole old 2D path.
const VERSION_REQUERY_MS = 50;

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`GL scene shader compile failed: ${log}`);
    }
    return sh;
}

function link(gl, vsSrc, fsSrc) {
    const prog = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc), fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`GL scene program link failed: ${log}`);
    }
    return prog;
}

const cellKey = (cx, cy) => (cx + 0x100000) * 0x200000 + (cy + 0x100000);
const NOT_SHOWN = -1;

export class GLSceneRenderer {
    constructor() {
        this.gl = null;
        this.program = null;
        this.uniforms = null;
        this.vao = null;
        this.failed = null;
        this.lost = false;
        /** Scenes drawn coarser than they had just been shown (see query). */
        this.detailDrops = 0;
        /** Scenes of the last frame's view drawn from a stand-in, and not drawn. */
        this.standIns = 0;
        this.missing = 0;
        /** The material-map program (null until linked; see initMaterials). */
        this.matProgram = null;
        this.matUniforms = null;
        this.matFailed = null;
        this.matLinkMs = 0;
        /** True when the last frame left needed bitmaps or maps for a later one. */
        this.uploadsPending = false;
        /** Maps brought in ahead of need: scenes still to do, as of the last frame. */
        this.warmRemaining = 0;
        this.resetResidency();
    }

    resetResidency() {
        this.pages = [];
        this.openPage = null;
        // `${cacheKey}#${level}` -> { page, x, y, w, h, mask, level } for a bitmap;
        // `${cacheKey}#mat` -> { page, x, y, w, h, art, erase, mat: true, level: 0 } for a material map
        this.slots = new Map();
        this.uploading = new Map();   // slot key -> a material map's slot while its strips go up
        this.bytes = 0;
        this.residency = 0;           // bumped on eviction: list instances may point at dead pages
        this.lists = new Map();       // placement list -> per-copy state, LRU order
        this.epoch = pixelSceneCacheEpoch();
    }

    dropAll() {
        const gl = this.gl;
        if (gl && !this.lost) {
            for (const p of this.pages) gl.deleteTexture(p.tex);
            for (const s of this.lists.values()) if (s.buffer) gl.deleteBuffer(s.buffer);
        }
        // The maps' bytes were released when they went up: have them rebuilt.
        for (const p of this.pages) for (const k of p.maps) forgetSceneMaterialMap(k);
        this.resetResidency();
    }

    init(gl) {
        if (this.failed) return false;
        if (this.gl === gl && this.program) return true;
        this.gl = gl;
        this.matProgram = null;   // a new context: linked again on first use
        this.matFailed = null;
        try {
            this.program = link(gl, VS, FS);
        } catch (err) {
            console.warn('[GL scenes]', err);
            this.failed = String(err);
            return false;
        }
        this.uniforms = Object.fromEntries(UNIFORMS.map(n => [n, gl.getUniformLocation(this.program, n)]));
        this.vao = gl.createVertexArray();
        this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        this.pageSize = Math.min(2048, this.maxTex);
        return true;
    }

    /**
     * Links the material-map program: the terrain shader's library with a
     * scene main(). Seed independent, so a host can do it while the world is
     * still generating (TerrainView.prepare); draw() calls it too.
     */
    initMaterials(terrain) {
        if (this.matFailed || !this.init(terrain.gl)) return false;
        if (this.matProgram) return true;
        const gl = this.gl;
        const t0 = performance.now();
        try {
            this.matProgram = link(gl, SCENE_MATERIAL_VS, SCENE_MATERIAL_FS);
        } catch (err) {
            // The per-instance bitmaps still draw (query falls back to them).
            console.warn('[GL scenes] material-map program unavailable:', err);
            this.matFailed = String(err);
            return false;
        }
        this.matUniforms = terrain.libraryUniforms(this.matProgram);
        this.matUniforms.u_sceneTex = gl.getUniformLocation(this.matProgram, 'u_sceneTex');
        this.matUniforms.u_air = gl.getUniformLocation(this.matProgram, 'u_air');
        this.matLinkMs = performance.now() - t0;
        return true;
    }

    /** For the render HUD's bakes line. */
    stats() {
        let maps = 0;
        for (const p of this.pages) maps += p.maps.length;
        return {
            pages: this.pages.length, bytes: this.bytes, slots: this.slots.size, detailDrops: this.detailDrops,
            maps, warmRemaining: this.warmRemaining,
        };
    }

    // --- atlas pages ------------------------------------------------------

    newPage(w, h, noEvict = false) {
        const gl = this.gl;
        const bytes = w * h * 4;
        if (noEvict && this.bytes + bytes > this.budget * WARM_BUDGET_SHARE) return null;
        while (this.bytes + bytes > this.budget) {
            // Least recently drawn, never one this frame or the last touched.
            let victim = null;
            for (const p of this.pages) {
                if (p.frame >= this.frame - 1) continue;
                if (!victim || p.frame < victim.frame) victim = p;
            }
            if (!victim) return null;
            this.evictPage(victim);
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        const page = { tex, w, h, bytes, x: 0, y: 0, shelfH: 0, frame: this.frame, keys: [], maps: [], dead: false };
        this.pages.push(page);
        this.bytes += bytes;
        return page;
    }

    evictPage(page) {
        this.gl.deleteTexture(page.tex);
        page.dead = true;
        for (const key of page.keys) this.slots.delete(key);
        for (const [key, slot] of this.uploading) if (slot.page === page) this.uploading.delete(key);
        for (const key of page.maps) forgetSceneMaterialMap(key);
        this.pages.splice(this.pages.indexOf(page), 1);
        if (this.openPage === page) this.openPage = null;
        this.bytes -= page.bytes;
        this.residency++;
    }

    /** Space for a w x h image: shelf-packed into the open page, or a page of its own if oversize.
     *  `noEvict`: only if it fits without evicting anything (prewarm). */
    allocate(w, h, noEvict = false) {
        const P = this.pageSize;
        if (w > P || h > P) {
            if (w > this.maxTex || h > this.maxTex) return null;
            const page = this.newPage(w, h, noEvict);
            return page && { page, x: 0, y: 0 };
        }
        let page = this.openPage;
        if (page) {
            if (page.x + w > P) { page.y += page.shelfH; page.x = 0; page.shelfH = 0; }
            if (page.y + h > P) page = null;
        }
        if (!page) {
            page = this.newPage(P, P, noEvict);
            if (!page) return null;
            this.openPage = page;
        }
        const at = { page, x: page.x, y: page.y };
        page.x += w;
        if (h > page.shelfH) page.shelfH = h;
        return at;
    }

    upload(bitmap, slotKey) {
        const gl = this.gl;
        const at = this.allocate(bitmap.width, bitmap.height);
        if (!at) return null;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, at.page.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, at.x, at.y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        at.page.keys.push(slotKey);
        this.uploadedBytes += bitmap.width * bitmap.height * 4;
        frameSlo.count('sceneUploads');
        frameSlo.count('sceneUploadKb', bitmap.width * bitmap.height * 4 / 1024);
        return at;
    }

    /** Resident slot for a drawable, uploading it (and its air mask) if needed. */
    slotFor(drawable, level, state) {
        const key = `${drawable.cacheKey}#${level}`;
        let slot = this.slots.get(key);
        if (slot) return slot;
        const bmp = drawable.bitmap;
        if (!bmp || !bmp.width || !bmp.height) return null;
        if (this.uploadedBytes > 0 && this.uploadedBytes + bmp.width * bmp.height * 4 > UPLOAD_BYTES_PER_FRAME) {
            state.incomplete = true;
            return null;
        }
        const img = this.upload(bmp, key);
        if (!img) return null;
        let mask = null;
        const m = drawable.airMask;
        if (m && m.width === bmp.width && m.height === bmp.height) {
            mask = this.upload(m, key);
            // No room for the mask: draw the scene without its air rather than not at all.
        }
        slot = { page: img.page, x: img.x, y: img.y, w: bmp.width, h: bmp.height, mask, level };
        this.slots.set(key, slot);
        return slot;
    }

    /**
     * The resident slot of a scene's material map, moving it along if it is
     * not there yet: asks the worker for the map, and once it has landed
     * uploads it a strip at a time within the frame's allowance.
     * @param {boolean} warm  ahead of need: uses the prewarm allowance, never
     *        evicts, and is not counted as work the frame is waiting for
     * @returns the slot once the whole map is on the GPU, else null
     */
    materialSlot(scene, slotKey, state, warm) {
        let slot = this.uploading.get(slotKey);
        if (!slot) {
            const cacheKey = sceneMaterialKey(scene);
            let map = landedSceneMaterialMap(cacheKey);
            if (map && !map.data) {
                // Landed, but its bytes went to a slot that is gone.
                forgetSceneMaterialMap(cacheKey);
                map = null;
            }
            if (!map) {
                if (requestSceneMaterialMap(scene, warm) === 'refused' && warm) this.warmBlocked = true;
                return null;
            }
            // The art layer sits directly under the material layer.
            const at = this.allocate(map.width, map.height * map.layers, warm);
            if (!at) {
                if (warm) this.warmBlocked = true;
                return null;
            }
            slot = {
                page: at.page, x: at.x, y: at.y, w: map.width, h: map.height,
                art: map.layers > 1 ? { x: at.x, y: at.y + map.height } : null,
                erase: map.erase, mat: true, level: 0, mask: null,
                cacheKey, map, rows: 0,
            };
            this.uploading.set(slotKey, slot);
        }
        const gl = this.gl;
        const map = slot.map;
        const total = map.height * map.layers, rowBytes = map.width * 4;
        slot.page.frame = this.frame;   // not evicted half uploaded
        // Raw bytes: a texel's alpha is its cell kind, not coverage.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        while (slot.rows < total) {
            const used = warm ? this.warmUploadedBytes : this.uploadedBytes;
            const cap = warm ? WARM_BYTES_PER_FRAME : UPLOAD_BYTES_PER_FRAME;
            const rows = Math.min(total - slot.rows, Math.max(1, Math.floor(MAP_STRIP_BYTES / rowBytes)));
            if (used > 0 && used + rows * rowBytes > cap) {
                if (warm) this.warmMore = true;
                else state.incomplete = true;
                return null;
            }
            gl.bindTexture(gl.TEXTURE_2D, slot.page.tex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.x, slot.y + slot.rows, map.width, rows,
                gl.RGBA, gl.UNSIGNED_BYTE, map.data, slot.rows * rowBytes);
            slot.rows += rows;
            if (warm) this.warmUploadedBytes += rows * rowBytes;
            else this.uploadedBytes += rows * rowBytes;
            frameSlo.count('sceneUploadKb', rows * rowBytes / 1024);
        }
        frameSlo.count('sceneUploads');
        this.uploading.delete(slotKey);
        slot.map = null;
        releaseSceneMaterialBytes(slot.cacheKey);
        slot.page.keys.push(slotKey);
        slot.page.maps.push(slot.cacheKey);
        this.slots.set(slotKey, slot);
        return slot;
    }

    /**
     * Brings in the material maps of a placement list's scenes that no frame
     * has needed yet, in list order, as far as the request cap, the prewarm
     * upload allowance and the budget allow. Called on frames with nothing
     * else to do; picks up where it left off.
     */
    prewarm(list, s) {
        let firstUndone = -1;
        let i = s.warmFrom;
        for (; i < list.length && !this.warmBlocked && !this.warmMore; i++) {
            const scene = list[i];
            if (!PIXEL_SCENE_DATA[scene.key]) continue;
            const slotKey = sceneMaterialSlotKey(scene);
            if (this.slots.has(slotKey) || this.materialSlot(scene, slotKey, s, true)) continue;
            if (sceneMaterialMapFailed(sceneMaterialKey(scene))) continue;
            if (firstUndone < 0) firstUndone = i;
        }
        s.warmFrom = firstUndone < 0 ? i : firstUndone;
    }

    residentSlot(keys, level) {
        for (const k of keys) {
            const s = this.slots.get(`${k}#${level}`);
            if (s) return s;
        }
        return null;
    }

    // --- per placement list ----------------------------------------------

    listState(list, relOffX, relOffY) {
        let s = this.lists.get(list);
        if (s && (s.relOffX !== relOffX || s.relOffY !== relOffY)) {
            if (s.buffer) this.gl.deleteBuffer(s.buffer);
            this.lists.delete(list);
            s = null;
        }
        if (s) {
            this.lists.delete(list);   // re-insert: Map order is the LRU order
            this.lists.set(list, s);
            return s;
        }
        // Scenes bucketed by every grid cell their rect touches.
        const grid = new Map();
        for (let i = 0; i < list.length; i++) {
            const scene = list[i];
            const data = PIXEL_SCENE_DATA[scene.key];
            if (!data) continue;
            const x = scene.x + relOffX, y = scene.y + relOffY;
            const cx0 = Math.floor(x / GRID_CELL), cx1 = Math.floor((x + data.width - 1) / GRID_CELL);
            const cy0 = Math.floor(y / GRID_CELL), cy1 = Math.floor((y + data.height - 1) / GRID_CELL);
            for (let cy = cy0; cy <= cy1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    const k = cellKey(cx, cy);
                    let cell = grid.get(k);
                    if (!cell) grid.set(k, cell = []);
                    cell.push(i);
                }
            }
        }
        s = {
            relOffX, relOffY, grid, stamp: new Uint32Array(list.length), stampN: 0,
            // The mip level each scene was last drawn from (NOT_SHOWN: never).
            shownLevel: new Int8Array(list.length).fill(NOT_SHOWN),
            buffer: null, colorGroups: [], airGroups: [], matColorGroups: [], matAirGroups: [],
            queryKey: null, version: -1, residency: -1, queriedAt: 0, incomplete: false, frame: this.frame,
            // prewarm: the first scene whose map is not resident yet, and when it last ran
            warmFrom: 0, warmResidency: -1, warmedAt: 0,
        };
        this.lists.set(list, s);
        for (const [oldList, old] of this.lists) {
            if (this.lists.size <= LIST_STATES_MAX) break;
            if (old.frame >= this.frame - 1) continue;
            if (old.buffer) this.gl.deleteBuffer(old.buffer);
            this.lists.delete(oldList);
        }
        return s;
    }

    /**
     * Picks what every scene near the view draws from and rebuilds the copy's
     * instance buffer. `near` (the view plus a cell) gets real requests and
     * uploads; the rest of `warm` (half a screen further) is only warmed, the
     * same margin the 2D path warms.
     */
    query(list, s, level, near, warm, view) {
        const gl = this.gl;
        const stamp = ++s.stampN;
        s.incomplete = false;
        // Scenes of the view that are not showing what was asked for: drawn from
        // a stand-in (another level's build, or the flat one), or not at all.
        // Either way the frame will change again without the camera moving.
        let standIns = 0, missing = 0;
        // Each scene's best slot key at this level, built once per list and level:
        // string building was most of a query.
        const textured = pixelScenesTexturedAt(level);
        // Textured levels draw from material maps; from per-instance bitmaps
        // only where the material program is unavailable.
        const useMaps = textured && this.materials;
        const keyId = `${level}|${textured}|${useMaps}`;
        if (s.keyId !== keyId) {
            s.keyId = keyId;
            s.primaryKeys = new Array(list.length);
        }
        const primaryKeys = s.primaryKeys;
        const hitI = [], hitSlot = [];
        const cx0 = Math.floor(warm.left / GRID_CELL), cx1 = Math.floor(warm.right / GRID_CELL);
        const cy0 = Math.floor(warm.top / GRID_CELL), cy1 = Math.floor(warm.bottom / GRID_CELL);
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const cell = s.grid.get(cellKey(cx, cy));
                if (!cell) continue;
                for (const i of cell) {
                    if (s.stamp[i] === stamp) continue;
                    s.stamp[i] = stamp;
                    const scene = list[i];
                    const data = PIXEL_SCENE_DATA[scene.key];
                    const x = scene.x + s.relOffX, y = scene.y + s.relOffY;
                    if (x + data.width < warm.left || x > warm.right || y + data.height < warm.top || y > warm.bottom) continue;
                    let pk = primaryKeys[i];
                    if (pk === undefined) {
                        pk = primaryKeys[i] = useMaps ? sceneMaterialSlotKey(scene) : `${pixelSceneCacheKeys(scene, level)[0]}#${level}`;
                    }
                    let slot = this.slots.get(pk) || null;
                    let primary = !!slot;
                    const inView = !(x + data.width < view.left || x > view.right || y + data.height < view.top || y > view.bottom);
                    if (!slot) {
                        const isNear = !(x + data.width < near.left || x > near.right || y + data.height < near.top || y > near.bottom);
                        if (useMaps) {
                            slot = this.materialSlot(scene, pk, s, !isNear);
                            primary = !!slot;
                        } else if (isNear) {
                            const d = getPixelSceneDrawable(scene, level);
                            // A stand-in (the shared flat build, while this
                            // instance's textured one is being made) is not
                            // brought in fresh. Arriving cold at a textured
                            // zoom, the terrain under the scene is already
                            // textured: the flat colours would replace it for
                            // a few frames and then be replaced in turn, and
                            // the scene reads as a flash. A stand-in already
                            // on the GPU -- the scene was on screen from
                            // further out -- keeps being drawn (the search
                            // below), so zooming in stays continuous.
                            if (d && (!textured || `${d.cacheKey}#${level}` === pk)) {
                                slot = this.slotFor(d, level, s);
                                primary = !!slot && `${d.cacheKey}#${level}` === pk;
                            }
                        } else {
                            warmPixelScene(scene, level);
                        }
                        // Nothing at this level yet: whatever of this scene is already
                        // resident, nearest level first, finer before coarser. Each
                        // level is searched by ITS OWN keys -- a textured level's
                        // instance build is keyed by that level -- so zooming in keeps
                        // the textured build that was on screen until the next one
                        // lands, instead of dropping to the flat one from further out.
                        if (!slot) {
                            for (let dl = 0; !slot && dl <= PIXEL_SCENE_MAX_MIP; dl++) {
                                if (dl > 0 && level - dl >= 0) {
                                    slot = this.residentSlot(pixelSceneCacheKeys(scene, level - dl), level - dl);
                                }
                                if (!slot && level + dl <= PIXEL_SCENE_MAX_MIP) {
                                    const keys = pixelSceneCacheKeys(scene, level + dl);
                                    slot = this.residentSlot(dl === 0 ? keys.slice(1) : keys, level + dl);
                                }
                            }
                        }
                    }
                    if (!slot) {
                        if (inView) missing++;
                        continue;
                    }
                    if (!primary && inView) standIns++;
                    // A scene drawn coarser than both what is asked for and what it
                    // was last drawn at has visibly lost detail: counted, for the
                    // frame log and the flicker check.
                    const shown = s.shownLevel[i];
                    if (shown !== NOT_SHOWN && slot.level > level && slot.level > shown) {
                        this.detailDrops++;
                        frameSlo.count('sceneDetailDrops');
                    }
                    s.shownLevel[i] = slot.level;
                    hitI.push(i);
                    hitSlot.push(slot);
                }
            }
        }

        // Four draw lists, each grouped by atlas page (one instanced draw per
        // page): the erase and the color pass, for bitmaps and for material maps.
        const AIR = 0, MAT_AIR = 1, COLOR = 2, MAT_COLOR = 3;
        const byPage = [new Map(), new Map(), new Map(), new Map()];
        let total = 0;
        const add = (pass, page, k) => {
            let hits = byPage[pass].get(page);
            if (!hits) { byPage[pass].set(page, hits = []); page.frame = this.frame; }
            hits.push(k);
            total++;
        };
        for (let k = 0; k < hitI.length; k++) {
            const slot = hitSlot[k];
            if (slot.mat) {
                add(MAT_COLOR, slot.page, k);
                if (slot.erase) add(MAT_AIR, slot.page, k);
            } else {
                add(COLOR, slot.page, k);
                if (slot.mask && !slot.mask.page.dead) add(AIR, slot.mask.page, k);
            }
        }
        const out = new Int32Array(Math.max(1, total) * STRIDE_INTS);
        const write = (at, i, slot) => {
            const scene = list[i];
            const data = PIXEL_SCENE_DATA[scene.key];
            const o = at * STRIDE_INTS;
            out[o] = scene.x + s.relOffX; out[o + 1] = scene.y + s.relOffY;
            out[o + 2] = data.width; out[o + 3] = data.height;
            out[o + 4] = slot.x; out[o + 5] = slot.y; out[o + 6] = slot.w; out[o + 7] = slot.h;
            if (slot.mat) {
                out[o + 8] = slot.art ? slot.art.x : -1; out[o + 9] = slot.art ? slot.art.y : 0;
                out[o + 10] = scene.x; out[o + 11] = scene.y;
            } else if (slot.mask) {
                out[o + 8] = slot.mask.x; out[o + 9] = slot.mask.y;
            }
        };
        let at = 0;
        const groups = byPage.map((pages) => {
            const gs = [];
            for (const [page, hits] of pages) {
                gs.push({ page, first: at, count: hits.length });
                for (const k of hits) write(at++, hitI[k], hitSlot[k]);
            }
            return gs;
        });
        s.airGroups = groups[AIR];
        s.matAirGroups = groups[MAT_AIR];
        s.colorGroups = groups[COLOR];
        s.matColorGroups = groups[MAT_COLOR];
        s.standIns = standIns;
        s.missing = missing;
        if (!s.buffer) s.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
    }

    /** One instanced draw per page of `groups`, with the program in use and
     *  the atlas sampler's unit active. `airUniform`: that program's u_air. */
    drawGroups(s, groups, airUniform, air) {
        const gl = this.gl;
        if (!groups.length) return;
        gl.uniform1i(airUniform, air ? 1 : 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
        const B = STRIDE_INTS * 4;
        for (const g of groups) {
            if (g.page.dead) continue;
            g.page.frame = this.frame;
            gl.bindTexture(gl.TEXTURE_2D, g.page.tex);
            const off = g.first * B;
            gl.vertexAttribIPointer(0, 4, gl.INT, B, off);
            gl.vertexAttribIPointer(1, 4, gl.INT, B, off + 16);
            gl.vertexAttribIPointer(2, 2, gl.INT, B, off + 32);
            gl.vertexAttribIPointer(3, 2, gl.INT, B, off + 40);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, g.count);
        }
    }

    /**
     * Draws the scenes of every world copy into the terrain canvas.
     * @param terrain the GLTerrainRenderer whose context and canvas are drawn into
     * @param view { width, height, originX, originY (draw space of screen 0,0), zoom,
     *               level, frame, budgetBytes, viewRect (draw space),
     *               worlds: [{ list, relOffX, relOffY, shiftX, shiftY }],
     *               air, color }  -- `air: false` / `color: false` skip that
     *               sub-pass (the bitmaps are still requested and uploaded), so
     *               each can be timed on its own
     * @returns true when drawn (the 2D scene draw is then skipped). Afterwards
     *          `redrawInMs` is non-null when newly landed bitmaps were left for a
     *          later frame: redraw after that long.
     */
    draw(terrain, view) {
        if (terrain.contextLost || !terrain.gl) { this.lost = true; return false; }
        const gl = terrain.gl;
        if (this.lost || this.gl !== gl) {
            // Restored context: every name we held is gone.
            this.lost = true;
            this.dropAll();
            this.program = null;
            this.lost = false;
        }
        if (!this.init(gl)) return false;
        if (this.epoch !== pixelSceneCacheEpoch()) this.dropAll();
        this.frame = view.frame;
        this.budget = view.budgetBytes;
        this.uploadedBytes = 0;
        this.warmUploadedBytes = 0;
        this.warmMore = this.warmBlocked = false;
        // Material maps need the terrain's tables and the frame's camera.
        this.materials = terrain.sceneMaterialsReady && !!terrain.frameState && this.initMaterials(terrain);

        const { width, height, zoom, level, viewRect } = view;
        const vw = viewRect.right - viewRect.left, vh = viewRect.bottom - viewRect.top;
        // Power-of-two cells so a small zoom step does not move every boundary.
        const cell = 2 ** Math.ceil(Math.log2(Math.max(512, Math.max(vw, vh) / 8)));
        const version = pixelSceneBitmapVersion();
        const now = performance.now();
        this.redrawInMs = null;
        this.uploadsPending = false;

        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindVertexArray(this.vao);
        for (let i = 0; i < 4; i++) {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribDivisor(i, 1);
        }

        const copies = [];
        for (const w of view.worlds) {
            const s = this.listState(w.list, w.relOffX, w.relOffY);
            s.frame = this.frame;
            // The view in this copy's list space.
            const l = viewRect.left - w.shiftX, r = viewRect.right - w.shiftX;
            const t = viewRect.top - w.shiftY, b = viewRect.bottom - w.shiftY;
            const qx0 = Math.floor(l / cell), qx1 = Math.floor(r / cell);
            const qy0 = Math.floor(t / cell), qy1 = Math.floor(b / cell);
            const queryKey = `${level},${cell},${qx0},${qx1},${qy0},${qy1}`;
            const stale = queryKey !== s.queryKey || s.residency !== this.residency || s.incomplete
                || (s.version !== version && now - s.queriedAt >= VERSION_REQUERY_MS);
            if (!stale && s.version !== version) {
                // Deferred: the caller must redraw, or the last bitmap of a burst
                // stays a stand-in until the next pan.
                const wait = VERSION_REQUERY_MS - (now - s.queriedAt);
                this.redrawInMs = this.redrawInMs == null ? wait : Math.min(this.redrawInMs, wait);
                this.uploadsPending = true;
            }
            if (stale) {
                // Near covers every position the view can reach before the key changes.
                const near = { left: qx0 * cell - cell, right: (qx1 + 1) * cell + cell,
                    top: qy0 * cell - cell, bottom: (qy1 + 1) * cell + cell };
                const warm = { left: near.left - vw / 2, right: near.right + vw / 2,
                    top: near.top - vh / 2, bottom: near.bottom + vh / 2 };
                this.query(w.list, s, level, near, warm, { left: l, right: r, top: t, bottom: b });
                s.queryKey = queryKey;
                s.version = version;
                s.queriedAt = now;
                // An eviction during this query leaves the copies before it pointing
                // at a dead page for one frame (skipped in drawGroups), then requeried.
                s.residency = this.residency;
                if (s.incomplete) {   // upload cap hit: finish next frame
                    this.redrawInMs = 0;
                    this.uploadsPending = true;
                }
            }
            copies.push({ w, s });
        }
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        // As of each copy's last query (a query reruns when a bitmap lands).
        this.standIns = this.missing = 0;
        for (const c of copies) {
            this.standIns += c.s.standIns || 0;
            this.missing += c.s.missing || 0;
        }
        // With the frame itself final, bring in the maps of the scenes it does
        // not show, so the next pan, zoom or jump finds them resident.
        this.warmRemaining = 0;
        if (this.materials && pixelScenesTexturedAt(0)) {
            const idle = !this.uploadsPending && !this.standIns && !this.missing && pendingPixelSceneBitmaps() === 0;
            for (const { w, s } of copies) {
                if (s.warmResidency !== this.residency) { s.warmFrom = 0; s.warmResidency = this.residency; }
                if (idle && s.warmFrom < w.list.length && now - s.warmedAt >= WARM_RETRY_MS) {
                    this.prewarm(w.list, s);
                    // Waiting on the worker: look again when a map lands (a
                    // redraw), not every frame. Waiting on the upload
                    // allowance: next frame.
                    if (!this.warmMore) s.warmedAt = now;
                }
                this.warmRemaining += w.list.length - s.warmFrom;
            }
            if (this.warmMore && this.redrawInMs == null) this.redrawInMs = 0;
        }

        const q = terrain.gpuTimerBegin();
        const u = this.uniforms;
        gl.viewport(0, 0, width, height);
        gl.enable(gl.BLEND);
        const setCopy = ({ w }) => {
            const ox = w.shiftX - view.originX, oy = w.shiftY - view.originY;
            const ix = Math.floor(ox), iy = Math.floor(oy);
            gl.uniform2i(u.u_copyInt, ix, iy);
            gl.uniform2f(u.u_copyFrac, ox - ix, oy - iy);
        };
        // Bitmaps: this file's program, the atlas page on unit 0.
        const drawBitmaps = (air) => {
            if (!copies.some(c => (air ? c.s.airGroups : c.s.colorGroups).length)) return;
            gl.useProgram(this.program);
            gl.uniform1i(u.u_atlas, 0);
            gl.uniform1f(u.u_zoom, zoom);
            gl.uniform2f(u.u_screen, width, height);
            gl.activeTexture(gl.TEXTURE0);
            for (const c of copies) {
                setCopy(c);
                this.drawGroups(c.s, air ? c.s.airGroups : c.s.colorGroups, u.u_air, air);
            }
        };
        // Material maps: the terrain library's program. Its tables take the
        // units below LIBRARY_UNITS, the atlas page the one above; the camera
        // is the terrain pass', and instances carry absolute world positions,
        // so there is nothing to set per copy.
        const drawMaps = (air) => {
            if (!this.materials || !copies.some(c => (air ? c.s.matAirGroups : c.s.matColorGroups).length)) return;
            const mu = this.matUniforms;
            gl.useProgram(this.matProgram);
            if (!terrain.applyLibraryState(mu)) return;
            gl.uniform1i(mu.u_sceneTex, GLTerrainRenderer.LIBRARY_UNITS);
            gl.activeTexture(gl.TEXTURE0 + GLTerrainRenderer.LIBRARY_UNITS);
            for (const c of copies) this.drawGroups(c.s, air ? c.s.matAirGroups : c.s.matColorGroups, mu.u_air, air);
        };
        // Air first: erase the terrain (premultiplied dst * (1 - 1)).
        if (view.air !== false) {
            gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
            drawBitmaps(true);
            drawMaps(true);
        }
        if (view.color !== false) {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            drawBitmaps(false);
            drawMaps(false);
        }
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
        for (let i = 0; i < 4; i++) gl.vertexAttribDivisor(i, 0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        terrain.gpuTimerEnd(q, (ms) => terrain.gpuSample('scenesGL', ms));
        return true;
    }
}
