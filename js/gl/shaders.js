// GL terrain renderer — GLSL ES 3.00 sources (PERF_PLAN.md Step 2.2/2.3).
//
// One full-screen pass. Per fragment:
//   screen -> world px  ->  biome-map chunk (exact integer math)
//          -> edge-noise wobble, evaluated per fragment, never baked
//          -> chunk indirection -> region metadata
//          -> region atlas sampled with the engine's whole-image mod-wrap
//          -> palette LUT -> color (grays resolve per chunk through u_fgTex)
//
// The biome-resolution chain is a port of:
//   js/image_processing.js  getTileOverlayBiome / getUnwobbledTileOverlayBiome
//   js/utils.js             getBiomeAtWorldCoordinates (edge-noise branch)
//   js/edge_noise.js        GetBiomeOffset / GetTrueChunkPosIdAt /
//                           GetWobbledBiome / ComputeMagicValueFromDoubles
// carried over from spikes/webgl-tiles/shaders.js, where it was diff-verified
// against the CPU bake, with the spike's hardcoded 70 / 17920 / 35840 / 7168 /
// 47 promoted to uniforms and its per-layer `isWrapped` guard dropped (see
// scripts/gl_scoping_report.md §4: in a viewport-space renderer the fragment's
// own world Y is authoritative, so the guard's premise no longer holds).
//
// All chunk arithmetic is exact integers; only the wobble noise and the sin/cos
// displacement run in float32 (the JS reference is float64 — the spike measured
// ~0.0025% biome flips from that, confined to seam pixels).
//
// Not ported: per-cell grain (PERF_PLAN.md 2.4, blocked on an external
// reference) — grays and materials paint flat, exactly as the CPU bake does.

import { VISUAL_TILE_OFFSET_X, VISUAL_TILE_OFFSET_Y } from '../constants.js';
import { EDGE_SIGNS } from '../edge_noise.js';
import { CHUNK_FLAG_EDGE_NOISE_EXCEPTION, CHUNK_FLAG_FG_DEFINED, CHUNK_FLAG_FILL, CHUNK_FLAG_HAS_TILES, CHUNK_FLAG_NOISE_INELIGIBLE } from './chunk_textures.js';
import { NO_REGION } from './indirection.js';
import { PALETTE_ALPHA_CHUNK_FG, PALETTE_ALPHA_SKIP } from './palette.js';

const SIGNS_GLSL = `const int SIGNS[48] = int[48](${EDGE_SIGNS.join(', ')});`;

// One triangle covering the viewport; no attributes, no buffers, no VAO state.
export const TERRAIN_VS = `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const TERRAIN_FS = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_chunkTex;    // mapW x 48 RGBA8UI: rgb = biome-map color, a = flags
uniform highp usampler2D u_fgTex;       // mapW x 48 RGBA8UI: rgb = TILE_FOREGROUND_COLORS, a = 255 if defined
uniform highp usampler2D u_noiseTex;    // 512x1 R8UI: EDGE_NOISE doubled
uniform highp usampler2D u_indirTex;    // mapW x 48 RG16UI: r = region slot, g = chunk flags
uniform highp isampler2D u_regionTex;   // 2 x N RGBA32I region metadata
uniform highp usampler2D u_atlasTex;    // R8UI palette-index atlas of every layer buffer
uniform sampler2D u_paletteTex;         // 256x1 RGBA8: rgb = color, a = paint mode

// Camera: world coords of screen pixel (0,0) split into an exact integer part
// and a fraction, so world positions stay exact out to the parallel-world
// extremes where float32 alone would lose whole pixels.
uniform ivec2 u_originInt;
uniform vec2 u_originFrac;
uniform float u_invZoom;
uniform vec2 u_screenSize;

uniform int u_mapWidth;     // getWorldSize(): 70 normal NG0, 64 NG+/nightmare
uniform int u_worldWidth;   // u_mapWidth * 512
uniform int u_centerPx;     // 512 * getWorldCenter()
uniform int u_baseY;        // 14 * 512
uniform int u_maxRow;       // 47
uniform int u_worldSizeX;   // parallel-world X stride: 70*512, or 64*512-8
uniform bool u_edgeNoise;

const int CHUNK = 512;
const int TILE = 10;
// constants.js VISUAL_TILE_OFFSET_*: every layer anchor satisfies
// worldX = -u_centerPx + VIS_X + 10*rasterTile (verified for all 70x48 chunk
// bases x {normal,nightmare} x {NG0,NG+}), which is what rasterChunk inverts.
const int VIS_X = ${VISUAL_TILE_OFFSET_X};
const int VIS_Y = ${VISUAL_TILE_OFFSET_Y};
const int BAND = 42;        // BIOME_EDGE_NOISE_EXTENT
// GetTrueChunkPosIdAt hardcodes 70 even in NG+ (edge_noise.js:124 "Actually
// this makes no difference anyway"). Deliberately NOT u_mapWidth.
const int TRUE_CHUNK_MODULUS = 70;

const float SQRT312 = 0.36602540378443864676; // (sqrt(3)-1)/2
const float SQRT336 = 0.21132486540518711775; // (3-sqrt(3))/6
${SIGNS_GLSL}

out vec4 outColor;

int pmod(int a, int b) { int m = a % b; return m < 0 ? m + b : m; }
// Floor division. JS '>>' on a negative int floors; GLSL ES leaves '>>' of a
// negative value implementation-defined, so every shift is spelled out.
int fdiv(int a, int b) { int q = a / b; if (a % b != 0 && ((a < 0) != (b < 0))) q -= 1; return q; }
int parity(int x, int y) { return pmod(x, 2) * 2 + pmod(y, 2); }

int noiseAt(int i) { return int(texelFetch(u_noiseTex, ivec2(i, 0), 0).r); }
uvec4 chunkAt(ivec2 p) { return texelFetch(u_chunkTex, ivec2(pmod(p.x, u_mapWidth), clamp(p.y, 0, u_maxRow)), 0); }
bool exceptionAt(ivec2 p) { return (chunkAt(p).a & ${CHUNK_FLAG_EDGE_NOISE_EXCEPTION}u) != 0u; }

// TILE_FOREGROUND_COLORS for a chunk: the gray/white class resolves to it, and
// so does a fill biome's constant material (chunk_textures.js FILL_BIOME_COLORS).
vec4 chunkForeground(ivec2 p) {
    uvec4 fg = texelFetch(u_fgTex, ivec2(pmod(p.x, u_mapWidth), clamp(p.y, 0, u_maxRow)), 0);
    return vec4(vec3(fg.rgb) / 255.0, 1.0);
}

// getUnwobbledTileOverlayBiome's cell math (image_processing.js:111-116).
ivec2 unwob(int wx, int wy) {
    return ivec2(pmod(wx + u_centerPx, u_worldWidth) / CHUNK,
                 pmod(wy + u_baseY, (u_maxRow + 1) * CHUNK) / CHUNK);
}

// ComputeMagicValueFromDoubles (simplex-style gradient noise), float32.
float magicNoise(float x, float y) {
    float d7 = (x + y) * SQRT312;
    float d6 = d7 + x;
    uint u2 = uint(int(d6));          // JS 'd >>> 0': truncate toward zero
    if (d6 < float(u2)) u2 -= 1u;
    d7 = d7 + y;
    uint u1 = uint(int(d7));
    if (d7 < float(u1)) u1 -= 1u;
    float dd = float(u1 + u2) * SQRT336;
    float d10 = x - (float(u2) - dd);
    float d9  = y - (float(u1) - dd);
    int i1 = int(u1 & 0xffu);
    int i2 = int(u2 & 0xffu);
    int s1 = (d9 < d10) ? 1 : 0;
    int s2 = (d10 <= d9) ? 1 : 0;
    float e7  = (d10 - float(s1)) + SQRT336;
    float e3  = (d9 - float(s2)) + SQRT336;
    float e11 = (d10 - 1.0) + SQRT336 * 2.0;
    float e4  = (d9 - 1.0) + SQRT336 * 2.0;
    float dm = 0.0;
    float d5 = (0.5 - d10 * d10) - d9 * d9;
    if (d5 >= 0.0) {
        int m12 = noiseAt(noiseAt(i1) + i2) % 12;
        dm = (float(SIGNS[m12 * 4 + 1]) * d9 + float(SIGNS[m12 * 4]) * d10) * d5 * d5 * d5 * d5;
    }
    float dmid = 0.0;
    float d5b = (0.5 - e7 * e7) - e3 * e3;
    if (d5b >= 0.0) {
        int m12 = noiseAt(noiseAt(s2 + i1) + i2 + s1) % 12;
        dmid = (float(SIGNS[m12 * 4 + 1]) * e3 + float(SIGNS[m12 * 4]) * e7) * d5b * d5b * d5b * d5b;
    }
    float d8 = 0.0;
    float d3 = (0.5 - e11 * e11) - e4 * e4;
    if (d3 >= 0.0) {
        int m12 = noiseAt(noiseAt(i1 + 1) + i2 + 1) % 12;
        d8 = (float(SIGNS[m12 * 4 + 1]) * e4 + float(SIGNS[m12 * 4]) * e11) * d3 * d3 * d3 * d3;
    }
    return (dmid + dm + d8) * 70.0;   // literal 70 in the engine, not the world size
}

// GetWobbledBiome (sincos branch, highDetail = true). Takes shifted coords.
int wobbledParity(int sx, int sy) {
    float nv = magicNoise(float(sx) * 0.05, float(sy) * 0.05);
    float sv = sin(float(sy) * 0.005);
    float cv = cos(float(sx) * 0.005);
    float x2 = cv * 30.0 + nv * 11.0;
    float y2 = sv * 30.0 + nv * 11.0;
    return parity(fdiv(int(floor(y2 + float(sx))), CHUNK),
                  fdiv(int(floor(x2 + float(sy))), CHUNK));
}

// GetTrueChunkPosIdAt
int trueChunkParity(int wx, int wy) {
    int sx = wx + u_centerPx;
    int sy = wy + u_baseY;
    int scx = sx & 511;
    int scy = sy & 511;
    if (scx < BAND || scy < BAND || scx > CHUNK - BAND || scy > CHUNK - BAND) return wobbledParity(sx, sy);
    return parity(pmod(fdiv(sx, CHUNK), TRUE_CHUNK_MODULUS), clamp(fdiv(sy, CHUNK), 0, u_maxRow));
}

// GetOriginalChunkPosIdAt
int origChunkParity(int wx, int wy) {
    return parity(pmod(fdiv(wx + u_centerPx, CHUNK), u_mapWidth), fdiv(wy + u_baseY, CHUNK));
}

// GetBiomeOffset
ivec2 biomeOffset(int wx, int wy) {
    int o = origChunkParity(wx, wy);
    int t = trueChunkParity(wx, wy);
    int dY = pmod(t - o, 2);
    int dX = pmod(fdiv(t, 2) - fdiv(o, 2), 2);
    int mx = pmod(wx, CHUNK);
    int my = pmod(wy, CHUNK);
    int sX = mx < BAND ? -1 : (mx > CHUNK - BAND ? 1 : 0);
    int sY = my < BAND ? -1 : (my > CHUNK - BAND ? 1 : 0);
    return ivec2(dX * sX, dY * sY);
}

// Chunk that OWNS the region-buffer content at a world coordinate.
//
// Region buffers are masked chunk by chunk on the engine's *tile raster* grid
// (image_processing.js chunkRasterStart = trunc(51.2 * chunk), applyMasking's
// 51/51/51/51/52 column runs), not on the 512-px chunk grid. Because every
// layer anchor satisfies  worldX = -u_centerPx + VISUAL_TILE_OFFSET + 10*raster,
// chunk c's unmasked content begins 2*(c mod 5) px *before* c's true 512-px
// boundary. Picking the region on the 512-px grid therefore samples chunk c-1's
// region inside that 0..8 px sliver, where applyMasking already zeroed the
// buffer -> a dead-straight transparent seam at every region border (visible as
// gaps along the rainforest / rainforest_open borders). The CPU bake has no such
// seam: it picks the layer with chunkAtRasterTile and only the *colors* with
// getTileOverlayBiome, so the region lookup below uses this grid while the whole
// biome/wobble chain stays on the true grid.
int rasterChunk(int world, int base, int visualOffset) {
    int t = fdiv(world + base - visualOffset, TILE);
    // chunkAtRasterTile (image_processing.js:178-180).
    return t >= 0 ? ((t + 1) * TILE + CHUNK - 1) / CHUNK - 1 : fdiv(t * TILE, CHUNK);
}

// getBiomeAtWorldCoordinates with useEdgeNoise = true
void biomeAt(int wx, int wy, out ivec2 fpos, out ivec2 opos) {
    ivec2 o = unwob(wx, wy);
    int sbx = pmod(wx, CHUNK);
    int sby = pmod(wy, CHUNK);
    bool nearX = sbx < BAND || sbx > CHUNK - BAND;
    bool nearY = sby < BAND || sby > CHUNK - BAND;
    ivec2 off = ivec2(0);
    if (nearX || nearY) off = biomeOffset(wx, wy);
    int bX = pmod(o.x + off.x, u_mapWidth);
    int bY = clamp(o.y + off.y, 0, u_maxRow);
    uvec4 oc = chunkAt(o);
    uvec4 nc = chunkAt(ivec2(bX, bY));
    bool skip = (oc.a & ${CHUNK_FLAG_NOISE_INELIGIBLE}u) != 0u || (nc.a & ${CHUNK_FLAG_NOISE_INELIGIBLE}u) != 0u;
    if (!skip) {
        // Probe neighbors in engine order; only the FIRST differing one counts.
        ivec2 probes[8];
        int pc = 0;
        if (sbx < BAND)  { probes[pc] = ivec2(o.x - 1, o.y); pc++; }
        if (sby < BAND)  { probes[pc] = ivec2(o.x, o.y - 1); pc++; }
        if (sbx > CHUNK - BAND) { probes[pc] = ivec2(o.x + 1, o.y); pc++; }
        if (sby > CHUNK - BAND) { probes[pc] = ivec2(o.x, o.y + 1); pc++; }
        if (sbx < BAND) {
            if (sby < BAND)  { probes[pc] = ivec2(o.x - 1, o.y - 1); pc++; }
            if (sby > CHUNK - BAND) { probes[pc] = ivec2(o.x - 1, o.y + 1); pc++; }
        }
        if (sbx > CHUNK - BAND) {
            if (sby < BAND)  { probes[pc] = ivec2(o.x + 1, o.y - 1); pc++; }
            if (sby > CHUNK - BAND) { probes[pc] = ivec2(o.x + 1, o.y + 1); pc++; }
        }
        bool found = false;
        for (int p = 0; p < 8; p++) {
            if (p >= pc) break;
            uvec4 pcC = chunkAt(probes[p]);
            if (all(equal(pcC.rgb, oc.rgb))) continue;
            found = true;
            if ((pcC.a & ${CHUNK_FLAG_NOISE_INELIGIBLE}u) != 0u) skip = true;
            break;
        }
        if (pc > 0 && !found) skip = true;
    }
    if (skip) { bX = o.x; bY = o.y; }
    fpos = ivec2(bX, bY);
    opos = o;
}

// getTileOverlayBiome. u_edgeNoise is per layer on the CPU; here the layer is
// whatever region covers the resolved chunk, so an exception biome under the
// fragment is the same condition (image_processing.js:331).
void overlayBiome(int wx, int wy, out ivec2 pos, out bool ignored) {
    ignored = false;
    pos = unwob(wx, wy);
    if (!u_edgeNoise) return;
    int scx = pmod(wx, CHUNK);
    int scy = pmod(wy, CHUNK);
    if (scx >= BAND && scx <= CHUNK - BAND && scy >= BAND && scy <= CHUNK - BAND) return;
    if (exceptionAt(pos)) return;   // layer's own biome ignores edge noise

    bool adjEx = false;
    if (scx < BAND && exceptionAt(unwob(wx - scx - 1, wy))) adjEx = true;
    else if (scy < BAND && exceptionAt(unwob(wx, wy - scy - 1))) adjEx = true;
    else if (scx > CHUNK - BAND && exceptionAt(unwob(wx + CHUNK - scx, wy))) adjEx = true;
    else if (scy > CHUNK - BAND && exceptionAt(unwob(wx, wy + CHUNK - scy))) adjEx = true;
    if (adjEx) { ignored = true; return; }

    ivec2 fpos;
    ivec2 opos;
    biomeAt(wx, wy, fpos, opos);
    if (!exceptionAt(fpos) && !exceptionAt(opos)) { pos = fpos; return; }
    ignored = true;
}

void main() {
    // Screen pixel center -> world. gl_FragCoord.y counts from the bottom.
    vec2 pix = vec2(gl_FragCoord.x, u_screenSize.y - gl_FragCoord.y);
    vec2 off = u_originFrac + pix * u_invZoom;
    ivec2 w = u_originInt + ivec2(floor(off));

    outColor = vec4(0.0);

    // Vertical parallel worlds keep the CPU overlays (see terrain_renderer.js).
    if (fdiv(w.y + u_baseY, (u_maxRow + 1) * CHUNK) != 0) return;
    int pwX = fdiv(w.x + u_centerPx, u_worldWidth);

    ivec2 pos;
    bool ignored;
    overlayBiome(w.x, w.y, pos, ignored);

    uvec4 cc = chunkAt(pos);
    // Constant-material fill biome: every cell the engine paints there is the
    // biome's fill material, so the resolved chunk is the whole answer — no
    // region, no atlas, no palette. Checked before the ignored early-out
    // because "ignore edge noise" means "use the unwobbled chunk" (which is what
    // overlayBiome leaves in pos), not "paint nothing"; a fill chunk next to a
    // holy-mountain wall is still solid rock in game.
    if ((cc.a & ${CHUNK_FLAG_FILL}u) != 0u) { outColor = chunkForeground(pos); return; }
    if (ignored) return;
    if ((cc.a & ${CHUNK_FLAG_HAS_TILES}u) == 0u) return;

    // The engine's whole-image mod-wrap, in the parallel world's own frame:
    // region anchors are PW-0 world coords, so undo the PW stride first.
    int sx = w.x - pwX * u_worldSizeX;

    // Region ownership follows the buffers' own masking grid (rasterChunk), not
    // the 512-px chunk grid — and it is NOT shifted by the wobble. The CPU bake
    // never moves wang content across a chunk border: every layer draws its own
    // buffer at its own fixed world position (image_processing.js
    // createTileOverlaysExpanded, "Central area"), so the *only* layer that can
    // paint a world pixel is the one owning that pixel's raster chunk. Edge noise
    // enters through the colors alone — the gray/foreground class and the
    // suppression rules read the wobbled chunk (pos, above), which is exactly
    // what getTileOverlayBiome feeds the CPU bake.
    //
    // Shifting this lookup by the wobble (as the pre-fix shader did, both on the
    // true grid and on the raster grid) samples a *different region's* buffer
    // inside every 42-px chunk-border band. Where neighbouring chunks share one
    // region that is invisible; where biomes alternate chunk by chunk it is not.
    // Seed 786433191's underground jungle (rows 27-29, cols 30-36: rainforest /
    // rainforest_open / fungicave in a checkerboard) showed it plainly: on a
    // 19k-sample lattice over x[-2700..-1500] y[7300..7550], the shifted lookup
    // left 299 samples sampling *outside* the chosen region's extent (whole-image
    // mod-wrap garbage) and 322 more painting air where the CPU paints terrain;
    // unshifted, all 18963 samples agree with the CPU's layer and palette index.
    ivec2 rpos = ivec2(pmod(rasterChunk(sx, u_centerPx, VIS_X), u_mapWidth),
                       clamp(rasterChunk(w.y, u_baseY, VIS_Y), 0, u_maxRow));
    uint slot = texelFetch(u_indirTex, rpos, 0).r;
    if (slot == ${NO_REGION}u) return;

    ivec4 m0 = texelFetch(u_regionTex, ivec2(0, int(slot)), 0);  // atlasX, atlasY, width, mapH
    ivec4 m1 = texelFetch(u_regionTex, ivec2(1, int(slot)), 0);  // originX, originY, flags, biomeColor

    int lx = pmod(fdiv(sx - m1.x, TILE), m0.z);
    int ly = pmod(fdiv(w.y - m1.y, TILE), m0.w);
    uint idx = texelFetch(u_atlasTex, ivec2(m0.x + lx, m0.y + ly), 0).r;

    vec4 pal = texelFetch(u_paletteTex, ivec2(int(idx), 0), 0);
    int mode = int(pal.a * 255.0 + 0.5);
    if (mode == ${PALETTE_ALPHA_SKIP}) return;                 // air, or cleared spawn pixel
    if (mode == ${PALETTE_ALPHA_CHUNK_FG}) {                   // gray / white: per-chunk foreground
        if ((cc.a & ${CHUNK_FLAG_FG_DEFINED}u) == 0u) return;
        outColor = chunkForeground(pos);
        return;
    }
    outColor = vec4(pal.rgb, 1.0);
}
`;
