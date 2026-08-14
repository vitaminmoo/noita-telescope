// GL terrain renderer — WebGL2 texture uploads (PERF_PLAN.md Step 2.1).
//
// Deliberately thin: every byte these functions upload is produced by the pure
// modules (palette.js / atlas.js / indirection.js) and verified headlessly by
// scripts/test_atlas.mjs. Nothing here is wired into app.js — that is Step 2.5.
//
// All integer textures use NEAREST + CLAMP_TO_EDGE (integer internal formats are
// not filterable in WebGL2) and are read with texelFetch only; the shader does
// the region mod-wrap itself rather than relying on REPEAT.
// UNPACK_ALIGNMENT must be 1: atlas rows are rarely multiples of 4 bytes.

import { PALETTE_SIZE } from './palette.js';
import { REGION_META_TEXELS, packRegionMeta } from './indirection.js';

/** Interleaves the indirection table into RG16UI texel order (r=slot, g=flags). */
export function packIndirection(indirection) {
    const { width, height, slots, flags } = indirection;
    const data = new Uint16Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
        data[i * 2] = slots[i];
        data[i * 2 + 1] = flags[i];
    }
    return data;
}

function makeTexture(gl, target = gl.TEXTURE_2D) {
    const tex = gl.createTexture();
    gl.bindTexture(target, tex);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

/** R8UI atlas of palette indices. Sample with `usampler2D` + texelFetch. */
export function createRegionAtlasTexture(gl, atlas) {
    const tex = makeTexture(gl);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, atlas.width, atlas.height, 0,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, atlas.data);
    return tex;
}

/** RG16UI chunk indirection: r = region slot (NO_REGION sentinel), g = chunk flags. */
export function createIndirectionTexture(gl, indirection) {
    const tex = makeTexture(gl);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16UI, indirection.width, indirection.height, 0,
        gl.RG_INTEGER, gl.UNSIGNED_SHORT, packIndirection(indirection));
    return tex;
}

/** RGBA32I region metadata, 2 x N (texel (0,slot) and (1,slot) per region). */
export function createRegionMetaTexture(gl, regions) {
    const tex = makeTexture(gl);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32I, REGION_META_TEXELS, regions.length, 0,
        gl.RGBA_INTEGER, gl.INT, packRegionMeta(regions));
    return tex;
}

/** RGBA8 256x1 palette LUT (index -> color; alpha carries the paint mode). */
export function createPaletteTexture(gl, paletteLUT) {
    const tex = makeTexture(gl);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_SIZE, 1, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, paletteLUT);
    return tex;
}

/**
 * Uploads a full resource set from buildTerrainResources().
 * @returns {{atlas: WebGLTexture, indirection: WebGLTexture,
 *            regionMeta: WebGLTexture, palette: WebGLTexture}}
 */
export function uploadTerrainTextures(gl, resources) {
    return {
        atlas: createRegionAtlasTexture(gl, resources.atlas),
        indirection: createIndirectionTexture(gl, resources.indirection),
        regionMeta: createRegionMetaTexture(gl, resources.regions),
        palette: createPaletteTexture(gl, resources.paletteLUT),
    };
}

/** Re-uploads only the 1 KiB palette LUT (setting changes: recolor, spawn pixels, white mode). */
export function updatePaletteTexture(gl, texture, paletteLUT) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PALETTE_SIZE, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, paletteLUT);
}

export function deleteTerrainTextures(gl, textures) {
    if (!textures) return;
    for (const tex of Object.values(textures)) if (tex) gl.deleteTexture(tex);
}

/**
 * Largest texture the context supports; callers pass this to chooseAtlasWidth so
 * the atlas stays inside the device limit.
 */
export function maxTextureSize(gl) {
    return gl.getParameter(gl.MAX_TEXTURE_SIZE);
}
