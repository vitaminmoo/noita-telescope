// GL terrain renderer — WebGL2 driver (PERF_PLAN.md Step 2.3/2.5).
//
// Owns an offscreen WebGL2 canvas sized to the main canvas and renders the
// terrain layer (drawNow layer 4, "tile overlays") in one full-screen pass, from
// the resources buildTerrainResources() derives from `layer.buffer`. app.js then
// blits it with a single ctx.drawImage() at the layer-4 position, so layer
// ordering is unchanged and the CPU bake path stays untouched.
//
// Coordinate model (derivation in the Step 2.5 notes):
//   canvasX = worldX + 512*getWorldCenter - pw*512*mapWidth
//   canvasY = worldY + 14*512            - pwVertical*48*512
// i.e. drawNow's world space is generation world space plus a constant offset,
// for *every* parallel world in view: the per-PW `pwOffset` / `pwOffsetVertical`
// hacks in the CPU draw exactly cancel the difference between the PW stride
// (70*512, or 64*512-8) and the biome-map pitch. Horizontal PWs therefore need
// nothing but that offset — the shader undoes the PW stride before sampling a
// region, so the content repeats exactly as the CPU bakes it.
//
// Vertical PWs are NOT rendered here: heaven and hell replace the whole biome
// map with a row-0 / row-47 broadcast, which under the chunk-indirection design
// would tile one region across the entire band instead of drawing each layer
// where the CPU draws it. `rendersWorld()` reports which worlds the GL pass
// covers so app.js can keep drawing the others from the CPU overlays.

import { CHUNK_SIZE, WORLD_CHUNK_CENTER_Y } from '../constants.js';
import { getWorldCenter, getWorldSize } from '../utils.js';
import { buildChunkTextures, buildNoiseTable512 } from './chunk_textures.js';
import { BIOME_MAP_HEIGHT } from './indirection.js';
import { buildPaletteLUT } from './palette.js';
import { TERRAIN_FS, TERRAIN_VS } from './shaders.js';
import {
    createChunkTexture, createForegroundTexture, createIndirectionTexture, createNoiseTexture,
    createPaletteTexture, createRegionAtlasTexture, createRegionMetaTexture, deleteTerrainTextures,
    maxTextureSize, updatePaletteTexture,
} from './textures.js';
import { buildTerrainResources } from './terrain_resources.js';

const UNIFORM_NAMES = [
    'u_chunkTex', 'u_fgTex', 'u_noiseTex', 'u_indirTex', 'u_regionTex', 'u_atlasTex', 'u_paletteTex',
    'u_originInt', 'u_originFrac', 'u_invZoom', 'u_screenSize',
    'u_mapWidth', 'u_worldWidth', 'u_centerPx', 'u_baseY', 'u_maxRow', 'u_worldSizeX', 'u_edgeNoise',
];

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`GL terrain shader compile failed: ${log}`);
    }
    return sh;
}

function link(gl, vsSrc, fsSrc) {
    const prog = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`GL terrain program link failed: ${log}`);
    }
    return prog;
}

export class GLTerrainRenderer {
    constructor() {
        this.canvas = null;
        this.gl = null;
        this.program = null;
        this.uniforms = null;
        this.textures = null;
        this.resources = null;
        this.contextLost = false;
        this.failed = null;      // error message; disables GL mode until the next build
        this.sourceKey = null;   // identity of the layers/biomeData the resources came from
        this.lutKey = null;
        this.stats = null;
        this.buildMs = 0;
    }

    /** True once a context exists and resources are uploaded. */
    get ready() {
        return !!(this.gl && !this.contextLost && !this.failed && this.textures && this.resources);
    }

    /** Worlds this renderer covers; the rest stay on the CPU overlay draw. */
    rendersWorld(pwY) {
        return pwY === 0;
    }

    initContext() {
        if (this.gl || this.failed) return !!this.gl;
        if (typeof document === 'undefined') { this.failed = 'no DOM'; return false; }
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', {
            alpha: true, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: true, preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
        });
        if (!gl) { this.failed = 'WebGL2 unavailable'; return false; }
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            this.contextLost = true;
            this.textures = null;
            this.program = null;
            console.warn('[GL terrain] context lost, falling back to the CPU bake');
        });
        canvas.addEventListener('webglcontextrestored', () => {
            this.contextLost = false;
            this.sourceKey = null; // force a rebuild + re-upload
            console.log('[GL terrain] context restored');
        });
        this.canvas = canvas;
        this.gl = gl;
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        return true;
    }

    /**
     * Builds + uploads the terrain resources if the inputs changed. Cheap to call
     * every frame: it compares the layer/biome data identities.
     */
    ensureResources(layers, biomeData, opts = {}) {
        if (this.failed || this.contextLost) return false;
        if (!this.initContext()) return false;
        if (!layers || !layers.length || !biomeData) return false;

        const { isNGP = false, gameMode = 'normal' } = opts;
        const key = `${layers.length}|${isNGP}|${gameMode}`;
        const same = this.textures && this.sourceKey === key &&
            this.sourceLayers === layers && this.sourceBiomeData === biomeData;
        if (!same) {
            try {
                this.buildAndUpload(layers, biomeData, { isNGP, gameMode, lut: opts.lut });
            } catch (err) {
                this.failed = String(err && err.message ? err.message : err);
                console.error('[GL terrain] resource build failed, staying on the CPU bake:', err);
                return false;
            }
            this.sourceKey = key;
            this.sourceLayers = layers;
            this.sourceBiomeData = biomeData;
            this.mapWidth = getWorldSize(isNGP, gameMode);
            this.centerPx = CHUNK_SIZE * getWorldCenter(isNGP, gameMode);
            this.worldSizeX = (isNGP || gameMode === 'nightmare') ? 64 * CHUNK_SIZE - 8 : 70 * CHUNK_SIZE;
        }
        this.updateLUT(opts.lut);
        return true;
    }

    buildAndUpload(layers, biomeData, opts) {
        const gl = this.gl;
        const t0 = performance.now();
        const mapWidth = getWorldSize(opts.isNGP, opts.gameMode);
        const resources = buildTerrainResources(layers, biomeData, {
            isNGP: opts.isNGP,
            gameMode: opts.gameMode,
            maxTextureSize: maxTextureSize(gl),
            lut: opts.lut,
        });
        const chunkTextures = buildChunkTextures(biomeData, mapWidth);

        deleteTerrainTextures(gl, this.textures);
        this.textures = {
            atlas: createRegionAtlasTexture(gl, resources.atlas),
            indirection: createIndirectionTexture(gl, resources.indirection),
            regionMeta: createRegionMetaTexture(gl, resources.regions),
            palette: createPaletteTexture(gl, resources.paletteLUT),
            chunk: createChunkTexture(gl, chunkTextures),
            fg: createForegroundTexture(gl, chunkTextures),
            noise: createNoiseTexture(gl, buildNoiseTable512()),
        };
        this.resources = resources;

        if (!this.program) {
            this.program = link(gl, TERRAIN_VS, TERRAIN_FS);
            this.uniforms = {};
            for (const name of UNIFORM_NAMES) this.uniforms[name] = gl.getUniformLocation(this.program, name);
        }
        this.buildMs = performance.now() - t0;
        this.stats = resources.stats;
        console.log(`[GL terrain] resources built in ${this.buildMs.toFixed(1)} ms`, resources.stats);
    }

    /** Re-uploads the 1 KiB LUT when a color setting changed (no atlas rebuild). */
    updateLUT(lutOpts) {
        if (!this.textures || !this.resources) return;
        const key = JSON.stringify(lutOpts ?? {});
        if (key === this.lutKey) return;
        this.lutKey = key;
        const lut = buildPaletteLUT(this.resources.palette, lutOpts);
        this.resources.paletteLUT = lut;
        updatePaletteTexture(this.gl, this.textures.palette, lut);
    }

    /** Frees GPU resources; the next ensureResources() rebuilds them. */
    invalidate() {
        if (this.gl && this.textures) deleteTerrainTextures(this.gl, this.textures);
        this.textures = null;
        this.resources = null;
        this.sourceKey = null;
        this.sourceLayers = null;
        this.sourceBiomeData = null;
        this.lutKey = null;
        this.failed = null;
    }

    /**
     * Renders the terrain for one frame.
     * @param {object} view { width, height, camX, camY, camZ, pw, pwVertical, edgeNoise }
     * @returns {HTMLCanvasElement|null} the canvas to blit, or null when unavailable
     */
    render(view) {
        if (!this.ready) return null;
        const gl = this.gl;
        const { width, height, camX, camY, camZ } = view;
        if (width <= 0 || height <= 0) return null;
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        // World coords of screen pixel (0,0), split so the integer part stays exact.
        const originX = camX - (width / 2) / camZ - this.centerPx + view.pw * CHUNK_SIZE * this.mapWidth;
        const originY = camY - (height / 2) / camZ - WORLD_CHUNK_CENTER_Y * CHUNK_SIZE
            + view.pwVertical * BIOME_MAP_HEIGHT * CHUNK_SIZE;
        const intX = Math.floor(originX);
        const intY = Math.floor(originY);

        const u = this.uniforms;
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.program);

        const units = [
            ['u_chunkTex', this.textures.chunk],
            ['u_fgTex', this.textures.fg],
            ['u_noiseTex', this.textures.noise],
            ['u_indirTex', this.textures.indirection],
            ['u_regionTex', this.textures.regionMeta],
            ['u_atlasTex', this.textures.atlas],
            ['u_paletteTex', this.textures.palette],
        ];
        units.forEach(([name, tex], i) => {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(u[name], i);
        });

        gl.uniform2i(u.u_originInt, intX, intY);
        gl.uniform2f(u.u_originFrac, originX - intX, originY - intY);
        gl.uniform1f(u.u_invZoom, 1 / camZ);
        gl.uniform2f(u.u_screenSize, width, height);
        gl.uniform1i(u.u_mapWidth, this.mapWidth);
        gl.uniform1i(u.u_worldWidth, this.mapWidth * CHUNK_SIZE);
        gl.uniform1i(u.u_centerPx, this.centerPx);
        gl.uniform1i(u.u_baseY, WORLD_CHUNK_CENTER_Y * CHUNK_SIZE);
        gl.uniform1i(u.u_maxRow, BIOME_MAP_HEIGHT - 1);
        gl.uniform1i(u.u_worldSizeX, this.worldSizeX);
        gl.uniform1i(u.u_edgeNoise, view.edgeNoise ? 1 : 0);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return this.canvas;
    }
}
