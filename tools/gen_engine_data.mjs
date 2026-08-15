#!/usr/bin/env node
// Regenerates js/engine_resolve/engine_data.js — the committed data tables the
// engine-faithful GL terrain resolver needs at runtime:
//
//   MATERIAL_NAMES_BY_ID     CellFactory load order (matlist), id -> name
//   WANG_COLOR_TO_ID         materials.xml wang_color -> material id ('last' dupe
//                            wins, validated against the game's lattice dump)
//   WANG_PARAMS_BY_ID        wang_noise_percent / wang_curvature / wang_noise_type
//   MATERIAL_FLAT_ABGR_BY_ID engine display color for textureless materials:
//                            CellData+0x64 stores the XML color with R and B
//                            swapped (the word is ABGR), which is what MAPDUMP
//                            renders — so [r, g, b] here = XML [b, g, r]
//   SPAWN_COLORS_BY_BIOME    biome-map color -> magic-pixel colors (per-biome
//                            wang_scripts.csv + lua RegisterSpawnFunction set)
//   BIOME_ENGINE             per biome-map color: runtime topology, band list
//                            (material ids), topology-0 params, support flags
//   PERM_CLASSIC / PERM_CUSTOM  the two 256-byte noise permutation tables
//
// Inputs live outside the repo: the RE workspace's generated band/topo0 tables
// (scripts/ref_resolver/, gitignored) and the game's unpacked data. Regenerate
// with:
//   node tools/gen_engine_data.mjs \
//     [--game /path/to/data.wak.unpacked] [--matlist /path/to/matlist.json]
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const RR = path.join(REPO, 'scripts', 'ref_resolver');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const GAME = flag('--game', process.env.NOITA_DATA ||
    '/home/vitaminmoo/reverse/noita/noita_Jan_25_2025_15:55:41/data/data.wak.unpacked');
const MATLIST = flag('--matlist',
    process.env.MATLIST || path.join(REPO, 'data', 'matlist.json'));

process.env.NOITA_DATA = GAME;
const { CAVES_SETUP } = await import(url.pathToFileURL(path.join(REPO, 'js', 'engine_resolve', 'bitmap_caves.js')));
const { BIOME_BANDS } = await import(url.pathToFileURL(path.join(RR, 'biome_bands.js')));
const { BIOME_TOPO0 } = await import(url.pathToFileURL(path.join(RR, 'biome_topo0.js')));
const { WANG_PARAMS } = await import(url.pathToFileURL(path.join(RR, 'matparams.js')));
const { spawnColorsByBiomeColor } = await import(url.pathToFileURL(path.join(RR, 'spawn_colors.mjs')));

// ---- material ids ----------------------------------------------------------
const matlines = JSON.parse(fs.readFileSync(MATLIST, 'utf8')).lines;
const idByName = new Map();
let maxId = 0;
for (const l of matlines) {
    const m = /^mat id=(\d+) name=(\S+)/.exec(l.trim());
    if (m) { idByName.set(m[2], +m[1]); maxId = Math.max(maxId, +m[1]); }
}
const namesById = new Array(maxId + 1).fill(null);
for (const [n, i] of idByName) namesById[i] = n;

// ---- wang colors + flat colors (materials.xml is authoritative for wang;
// data/material_data.json for the parent-resolved Graphics color) -------------
const xml = fs.readFileSync(path.join(GAME, 'materials.xml'), 'utf8');
const wangByName = new Map();
for (const t of xml.match(/<(CellData|CellDataChild)[^>]*>/g) || []) {
    const n = /\bname="([^"]*)"/.exec(t);
    const w = /\bwang_color="([^"]*)"/.exec(t);
    if (n && w && !wangByName.has(n[1])) wangByName.set(n[1], parseInt(w[1], 16) & 0xffffff);
}
const colorToId = new Map();          // 'last' dupe mode, validated vs the dump
for (const [name, id] of idByName) {
    const c = wangByName.get(name);
    if (c !== undefined) colorToId.set(c, id);
}

const matData = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'material_data.json'), 'utf8'));
const colorByName = new Map();
for (const m of matData) if (m.color) colorByName.set(m.name, m.color);
const flat = new Array(maxId + 1).fill(0);
const flatAlpha = new Array(maxId + 1).fill(255);
for (const [name, id] of idByName) {
    const hex = colorByName.get(name);
    const v = hex ? parseInt(hex, 16) : (0xff000000 | (wangByName.get(name) ?? 0));
    // The XML color TEXT is plain aRGB (water "A0376259" displays #376259,
    // proven by BAKEDUMP). The engine's ABGR is only its in-MEMORY byte layout
    // of the same value; swapping here double-swaps and paints water #596237.
    flat[id] = v & 0xffffff;
    // The alpha byte is the cell's compositing alpha over the background layer
    // (shaders/sprite_cellgrid.frag draws the cell grid with straight src-over
    // alpha): 0xA0 water, 0x38-0x7f gases, 0xFF solids.
    flatAlpha[id] = (v >>> 24) & 0xff;
}

// ---- wang sampler params by id ---------------------------------------------
const params = [];
for (let id = 0; id <= maxId; id++) {
    const p = (namesById[id] && WANG_PARAMS.get(namesById[id])) || { scale: 1.0, threshold: 0.5, type: 0 };
    params.push([p.scale, p.threshold, p.type]);
}

// ---- per-biome engine table -------------------------------------------------
const colors = [...new Set([...Object.keys(BIOME_BANDS), ...Object.keys(BIOME_TOPO0)].map(Number))]
    .sort((a, b) => a - b);
const biomes = [];
for (const color of colors) {
    const bands = BIOME_BANDS[color];
    const t0 = BIOME_TOPO0[color];
    if (!t0) continue;
    const bandList = [];
    let unsupportedBand = false;
    for (const c of (bands ? bands.bands : [])) {
        if (c.poly) { unsupportedBand = true; continue; }
        if (c.rare && c.rare.fbm) { unsupportedBand = true; continue; }
        const id = idByName.get(c.mat);
        if (id === undefined) { unsupportedBand = true; continue; }
        bandList.push({
            mat: id, min: c.min, max: c.max,
            limY: c.limitY || null,
            addP: c.addPerlin || null,
            rare: c.rare ? {
                sx: c.rare.sx, sy: c.rare.sy, ox: c.rare.ox, oy: c.rare.oy,
                perlin: c.rare.perlin, polka: c.rare.polka, boxed: c.rare.boxed,
                plo: c.rare.plo, phi: c.rare.phi, prob: c.rare.prob,
                rmin: c.rare.rmin, rmax: c.rare.rmax,
            } : null,
        });
    }
    // noise_type is the XML enum verbatim (NoiseType_FromString @0x00486179:
    // IQ2_SIMPLEX1234=0, IQ_SIMPLEX=1, SIN_CAPPED_EVERYTHING=2,
    // SIN_CAPPED_SIMPLEX=3) and reaches the carve switch at Biome+0x220
    // unchanged — live-PEEKed 3 on an excavationsite_cube_chamber chunk (seed
    // 786433191), same as the lake object in
    // docs/reference/biome_topology_struct.md. Both shipped values (0 and 3)
    // have a ported carve branch; see carve_noise.js.
    const noiseType = t0.noiseType;
    // Grids are cached per biome NAME; unnamed biomes share '_EMPTY_'. Only the
    // grids whose <BitmapCaves> params are ported (bitmap_caves.js CAVES_SETUP)
    // are supported — the other named grids would silently render modifier 1.0.
    const gridKey = t0.modifier.kind === 'grid' ? (t0.name || '_EMPTY_') : null;
    const gridOK = gridKey !== null && CAVES_SETUP[gridKey] !== undefined;
    // topology-0 support: the noise/edge/modifier variants the shader implements.
    // The carve switch only runs above density 0.85, which the 'empty' lake-mask
    // modifier caps at ~0.5 — so an unported noise_type is harmless there.
    const carveReachable = !(t0.modifier.kind === 'empty');
    const topo0OK = t0.topo === 0
        && (noiseType === 0 || noiseType === 3 || !carveReachable)
        && (t0.edge === 0 || t0.edge === 1 || t0.edge === 3)
        && t0.insideNoiseType === 5
        && !t0.depthBlend
        && (t0.modifier.kind === 'const' || t0.modifier.kind === 'empty' || t0.modifier.kind === 'none'
            || gridOK)
        && !unsupportedBand;
    const topo2OK = t0.topo === 2 && !unsupportedBand;
    // `paintsNothing`: a BIOME_WANG_TILE biome whose wang_template_file is empty.
    // ProceduralTerrain_Init @0x0087a900 only builds a wang region (and with it the
    // covergrid the topology-2 resolve samples) when
    //     Biome+0x04 == 2 && wang_template_file.size() != 0
    // so these biomes get no covergrid and generate no terrain at all — every pixel
    // in their chunk comes from the pixel scene their biome lua stamps. Live-checked
    // on seed 786433191: roadblock's chunk MAPDUMPs 0/262144 filled (its scene,
    // data/biome_impl/roadblock.png, is 100% transparent), while watercave's chunk is
    // solid only because watercave.lua stamps watercave_layout_N.png over it. Both
    // are this class; the difference is entirely in the scene, never in the bands.
    // (gen_topo0.py demotes the class to `topo: 0` so the offline resolver has
    //  *something* to evaluate; that density is not what the game paints.)
    const paintsNothing = t0.xmlType === 'BIOME_WANG_TILE' && t0.topo === 0;
    biomes.push({
        color,
        topo: t0.topo,
        supported: t0.topo === 2 ? topo2OK : topo0OK,
        paintsNothing,
        noiseBiomeEdges: t0.noiseBiomeEdges,
        setMin: bands ? bands.setMin : 0,
        setMax: bands ? bands.setMax : 0,
        bands: bandList,
        t0: {
            edge: t0.edge, startY: t0.startY, endY: t0.endY, freq: t0.freq,
            low: t0.low, high: t0.high, slopeStartX: t0.slopeStartX, slopeDelta: t0.slopeDelta,
            multGradient: t0.multGradient, multPerlin: t0.multPerlin,
            insideAddValue: t0.insideAddValue,
            insideScaleX: t0.insideScaleX, insideScaleY: t0.insideScaleY,
            insideOffX: t0.insideOffX, insideOffY: t0.insideOffY,
            insideFBM: t0.insideFBM, insideSquared: t0.insideSquared,
            insideClamped: t0.insideClamped, insideScaled: t0.insideScaled,
            insideScaleMin: t0.insideScaleMin, insideScaleMax: t0.insideScaleMax,
            noiseType,
            modKind: t0.modifier.kind, modValue: t0.modifier.value ?? 0,
            gridKey,
        },
    });
}

// ---- spawn colors -----------------------------------------------------------
const spawnByBiome = [];
for (const [color, set] of spawnColorsByBiomeColor()) {
    spawnByBiome.push([color, [...set].sort((a, b) => a - b)]);
}
spawnByBiome.sort((a, b) => a[0] - b[0]);

// ---- permutation tables -----------------------------------------------------
const carveSrc = fs.readFileSync(path.join(RR, 'carve_noise.js'), 'utf8');
const perlinSrc = fs.readFileSync(path.join(RR, 'perlin_noise.js'), 'utf8');
const grabPerm = (src, label) => {
    const m = /const PERM = new Uint8Array\(\[([\s\S]*?)\]\)/.exec(src);
    if (!m) throw new Error('no PERM table in ' + label);
    const t = m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
    if (t.length !== 256) throw new Error(`${label}: ${t.length} entries`);
    return t;
};
const permClassic = grabPerm(carveSrc, 'carve_noise.js');
const permCustom = grabPerm(perlinSrc, 'perlin_noise.js');

// ---- emit -------------------------------------------------------------------
const out = `// GENERATED by tools/gen_engine_data.mjs — do not edit by hand.
// Data tables for the engine-faithful GL terrain resolver. Sources: the game's
// materials.xml / biome XML (via the RE workspace's generated band and topology
// tables, validated bit-exact against live dumps) and the CellFactory material
// id order captured from a live game (MATLIST).
export const MATERIAL_NAMES_BY_ID = ${JSON.stringify(namesById)};
export const WANG_COLOR_TO_ID = ${JSON.stringify([...colorToId.entries()])};
export const WANG_PARAMS_BY_ID = ${JSON.stringify(params)};
export const MATERIAL_FLAT_RGB_BY_ID = ${JSON.stringify(flat)};
export const MATERIAL_FLAT_ALPHA_BY_ID = ${JSON.stringify(flatAlpha)};
export const SPAWN_COLORS_BY_BIOME = ${JSON.stringify(spawnByBiome)};
export const BIOME_ENGINE = ${JSON.stringify(biomes)};
export const PERM_CLASSIC = ${JSON.stringify(permClassic)};
export const PERM_CUSTOM = ${JSON.stringify(permCustom)};
`;
const dest = path.join(REPO, 'js', 'engine_resolve', 'engine_data.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`wrote ${dest}: ${namesById.length} materials, ${biomes.length} biomes ` +
    `(${biomes.filter(b => b.supported && b.topo === 2).length} topo2 + ` +
    `${biomes.filter(b => b.supported && b.topo === 0).length} topo0 supported), ` +
    `${spawnByBiome.length} spawn sets, ${(out.length / 1024).toFixed(0)} KiB`);
