// Extracts the game's `skip_edge_textures` flags and generates
// js/pixel_scene_edge_flags.js, the manifest the edge-decal pass consults.
//
// The name covers TWO unrelated gates, on two different structs, with two
// different consumers. A Ghidra trace of the binary separated them:
//
// SCENE GATE -- PixelSceneEntry+0x59.
// A pixel scene normally runs its OWN EdgeGraphics decal pass over its rect
// right after its cells are written (PixelScene_TryPaintEntry @0x00880fb0 ->
// BiomeMaterials_PaintEdgeMaterial @0x00721da0). This flag turns that pass off:
// the scene's cells still erase the terrain-pass stamps under them, but nothing
// is stamped back. It is written from exactly two places in the shipped data
// (the third writer, PixelSceneComponent's own field, belongs to entity-spawned
// scenes and has no static manifest to read):
//
//   1. <PixelScene ... material_filename=".." skip_edge_textures="0|1"> in
//      biome/_pixel_scenes*.xml -- the hand-placed one-off scenes (fishing hut,
//      essence altars, bunker, huussi, snowy_ruins_eye_pillar).
//   2. LoadPixelScene( materials, colors, x, y, background, skip_biome_checks,
//      skip_edge_textures, ... ) -- the 7th argument, in any Lua under
//      scripts/ or biome_impl/. It DEFAULTS TO FALSE when omitted -- including
//      inside the lua_script of a biome whose <Topology> sets the flag. The
//      scene path never consults the biome at all.
//
// SEAM GATE -- BiomeChunk+0xc7, from <Topology skip_edge_textures="1"> in a
// biome/*.xml. Its single consumer is the SEAM-BAND stamp pass: the pass that
// dresses only the cells within 8px of a chunk border, deferred until the
// neighbour chunks exist so it can read across the boundary. The gate is
// decided once per chunk by a wobble-resolved biome lookup at the chunk paint
// rect's centre. The generation-time INTERIOR dressing pass is ungated by it,
// and no pixel scene is affected by it. Emitted as SKIP_SEAM_EDGE_BIOMES,
// keyed by biome-map color, for js/edge_decals.js to consult per chunk.
//
// Scene keys are telescope's "dir/name", matched to the game's material PNG the
// same way tools/gen_visual_overlays.mjs does (GAME_DIRS + a dimension check so
// a basename collision across biomes can't cross-wire).
//
//   node tools/gen_edge_flags.mjs [path-to-data.wak.unpacked]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const GAME = process.argv[2]
	?? '/home/vitaminmoo/reverse/noita/noita_Jan_25_2025_15:55:41/data/data.wak.unpacked';
const IMPL = join(GAME, 'biome_impl');
const SCENES = join(repo, 'data', 'pixel_scenes');

// telescope scene dir -> game biome_impl subdirs to try, in order. '' is the
// biome_impl root, where the shared scenes live. (Same table as
// tools/gen_visual_overlays.mjs; keep them in sync.)
const GAME_DIRS = {
	general: [''],
	rainforest_open: ['rainforest'],
	rainforest_dark: ['rainforest_dark', 'rainforest'],
	// spliced scenes were assembled from numbered tiles by the original
	// exporter, so they have no single game material PNG to key on.
	spliced: [],
	sky_islands: ['sky_islands'],
};

function pngSize(path) {
	const b = readFileSync(path);
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// --- telescope scene key -> game material path -----------------------------

/** "dir/name" -> "biome_impl/<gd>/<name>.png" for every telescope scene whose
 *  game PNG can be identified unambiguously. */
function sceneKeyToGamePath() {
	const map = new Map();
	for (const dir of readdirSync(SCENES).sort()) {
		if (!statSync(join(SCENES, dir)).isDirectory()) continue;
		const gameDirs = GAME_DIRS[dir] ?? [dir, ''];
		for (const file of readdirSync(join(SCENES, dir)).sort()) {
			if (!file.endsWith('.png') || file.includes('_visual') || file.includes('_background')) continue;
			const name = file.slice(0, -4);
			for (const gd of gameDirs) {
				const mat = join(IMPL, gd, `${name}.png`);
				if (!existsSync(mat)) continue;
				const a = pngSize(mat), b = pngSize(join(SCENES, dir, file));
				if (a.w !== b.w || a.h !== b.h) continue; // different scene sharing the name
				map.set(`${dir}/${name}`, `data/biome_impl/${gd ? gd + '/' : ''}${name}.png`);
				break;
			}
		}
	}
	return map;
}

// --- Lua LoadPixelScene argument parsing -----------------------------------

/** Splits a Lua call's argument list on top-level commas, honouring nesting and
 *  string literals. `src` starts just after the opening paren. Returns
 *  { args, end } or null when the call is not closed in `src`. */
function splitCallArgs(src, start) {
	const args = [];
	let depth = 0, quote = null, cur = '';
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === '\\') { cur += c + (src[++i] ?? ''); continue; }
			if (c === quote) quote = null;
			cur += c;
			continue;
		}
		if (c === '"' || c === "'") { quote = c; cur += c; continue; }
		if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
		if (c === ')' && depth === 0) { args.push(cur); return { args, end: i }; }
		if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
		if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
		cur += c;
	}
	return null;
}

/** Every LoadPixelScene call in `src`, as { path, skip } where `skip` is
 *  true/false from an explicit 7th argument or null when it was omitted (or is
 *  not a literal, or the material path is not a literal). */
function loadPixelSceneCalls(src) {
	const out = [];
	const re = /\bLoadPixelScene\s*\(/g;
	let m;
	while ((m = re.exec(src))) {
		const call = splitCallArgs(src, m.index + m[0].length);
		if (!call) continue;
		const lit = /^\s*"([^"]*)"\s*$/.exec(call.args[0] ?? '');
		if (!lit || !lit[1].endsWith('.png')) continue;
		const seventh = (call.args[6] ?? '').trim();
		const skip = seventh === 'true' ? true : seventh === 'false' ? false : null;
		out.push({ path: lit[1], skip, line: src.slice(0, m.index).split('\n').length });
	}
	return out;
}

// --- observations ----------------------------------------------------------

/** All *.lua under a directory tree. */
function luaFiles(dir, acc = []) {
	if (!existsSync(dir)) return acc;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) luaFiles(p, acc);
		else if (e.name.endsWith('.lua')) acc.push(p);
	}
	return acc;
}

/** path -> [{ flag, source }] */
const observations = new Map();
function observe(path, flag, source) {
	if (!observations.has(path)) observations.set(path, []);
	observations.get(path).push({ flag, source });
}

const biomeDir = join(GAME, 'biome');

// 1. <PixelScene material_filename=".." skip_edge_textures="0|1">
for (const file of readdirSync(biomeDir).sort()) {
	if (!file.endsWith('.xml')) continue;
	const txt = readFileSync(join(biomeDir, file), 'utf8');
	for (const el of txt.match(/<PixelScene\b[^>]*>/g) ?? []) {
		const mat = /material_filename="([^"]+)"/.exec(el);
		const skip = /skip_edge_textures="([01])"/.exec(el);
		if (!mat || !skip || !mat[1]) continue;
		observe(mat[1], skip[1] === '1', `biome/${file} <PixelScene>`);
	}
}

// 2. Every Lua LoadPixelScene call. A biome's own lua_script is scanned by the
// same rule as any other: the 7th argument, and FALSE when it is omitted. The
// biome's <Topology> flag is deliberately not consulted -- it gates the seam
// band, not the scene pass.
for (const f of [...luaFiles(join(GAME, 'scripts')), ...luaFiles(join(GAME, 'biome_impl'))]) {
	const rel = f.slice(GAME.length + 1);
	for (const c of loadPixelSceneCalls(readFileSync(f, 'utf8'))) {
		observe(c.path, c.skip ?? false, `${rel}:${c.line}`);
	}
}

// --- the seam gate: biome-map color -> <Topology skip_edge_textures> --------

/** Biome-map colors (0xRRGGBB) whose biome sets <Topology skip_edge_textures="1">,
 *  as `{ color, biome }` sorted by color. biome/_biomes_all.xml is the only
 *  file in the game data that binds a biome XML to a biome-map color; several
 *  colors can share one biome file, so it is walked rather than inverted. */
function seamSkipBiomes() {
	const topoFlag = new Map();   // "data/biome/x.xml" -> boolean
	for (const file of readdirSync(biomeDir).sort()) {
		if (!file.endsWith('.xml')) continue;
		const txt = readFileSync(join(biomeDir, file), 'utf8');
		const topo = /<Topology\b[^>]*>/s.exec(txt);
		topoFlag.set(`data/biome/${file}`, !!topo && /skip_edge_textures="1"/.test(topo[0]));
	}
	// A biome-map color can be listed twice (mountain_hall_3 and the unused
	// mountain_hall_trailer share 0x224060), so names collect per color.
	const byColor = new Map();
	const all = readFileSync(join(biomeDir, '_biomes_all.xml'), 'utf8')
		.replace(/<!--[\s\S]*?-->/g, '');
	for (const el of all.match(/<Biome\b[^>]*>/g) ?? []) {
		const bf = /biome_filename="([^"]+)"/.exec(el);
		const col = /color="([0-9a-fA-F]{6,8})"/.exec(el);
		if (!bf || !col || !topoFlag.get(bf[1])) continue;
		const color = parseInt(col[1], 16) & 0xffffff;
		const biome = bf[1].replace(/^data\/biome\/|\.xml$/g, '');
		if (!byColor.has(color)) byColor.set(color, []);
		if (!byColor.get(color).includes(biome)) byColor.get(color).push(biome);
	}
	return [...byColor].sort((a, b) => a[0] - b[0])
		.map(([color, biomes]) => ({ color, biome: biomes.join(' / ') }));
}

const seamBiomes = seamSkipBiomes();

// --- resolve ---------------------------------------------------------------

const keyToPath = sceneKeyToGamePath();
const flagged = [];
const conflicts = [];
let seen = 0;
for (const [key, path] of [...keyToPath].sort()) {
	const obs = observations.get(path);
	if (!obs || !obs.length) continue;
	seen++;
	const on = obs.filter(o => o.flag), off = obs.filter(o => !o.flag);
	if (on.length && off.length) {
		// Mixed: telescope keys one scene per material PNG and cannot tell the
		// flagged placement from the unflagged one, so the majority of the real
		// placements wins -- which for every conflicting scene in the shipped
		// data is the unflagged one (a shared altar/wand pedestal that a single
		// skip_edge_textures biome happens to also place).
		conflicts.push({ key, path, on: on.map(o => o.source), off: off.map(o => o.source) });
		if (on.length > off.length) flagged.push(key);
		continue;
	}
	if (on.length) flagged.push(key);
}

flagged.sort();
const out = `// GENERATED by tools/gen_edge_flags.mjs -- do not edit.
// Scenes the game paints with \`skip_edge_textures\` set: their cells still
// erase the terrain decal pass under them, but the scene runs no decal pass of
// its own (PixelScene_TryPaintEntry @0x00880fb0). Keys are telescope's
// "dir/name", the same space as VISUAL_OVERLAY_SCENES.
export const SKIP_EDGE_TEXTURE_SCENES = new Set(${JSON.stringify(flagged, null, '\t')});

// Biome-map colors (0xRRGGBB) whose biome sets <Topology skip_edge_textures="1">.
// That flag lands in BiomeChunk+0xc7 and gates ONLY the seam-band stamp pass --
// the deferred pass over the cells within 8px of a chunk border. The chunk's
// value is decided by one wobble-resolved biome lookup at the chunk centre, so
// it is a per-chunk decision, not a per-cell one, and the interior dressing
// pass ignores it entirely.
export const SKIP_SEAM_EDGE_BIOMES = new Set([
${seamBiomes.map(b => `\t0x${b.color.toString(16).padStart(6, '0')}, // ${b.biome}`).join('\n')}
]);
`;
writeFileSync(join(repo, 'js', 'pixel_scene_edge_flags.js'), out);

console.log(`${observations.size} scene paths observed in the game data`);
console.log(`${seamBiomes.length} biome-map colors gate the seam band: ` +
	`${[...new Set(seamBiomes.map(b => b.biome))].join(', ')}`);
console.log(`${seen} of telescope's ${keyToPath.size} matched scenes carry an observation`);
console.log(`${flagged.length} flagged: ${flagged.join(', ')}`);
if (conflicts.length) {
	console.log(`\n${conflicts.length} conflicting scene(s) (same PNG seen with both values):`);
	for (const c of conflicts) {
		console.log(`  ${c.key} (${c.path})`);
		console.log(`    skip=1: ${c.on.join(', ')}`);
		console.log(`    skip=0: ${c.off.join(', ')}`);
		console.log(`    -> resolved to skip=${c.on.length > c.off.length ? 1 : 0}`);
	}
}
console.log('\njs/pixel_scene_edge_flags.js written');
