// Maps every pixel scene telescope ships to the BACKGROUND image the game draws
// behind it, and generates js/pixel_scene_backgrounds.js, the manifest the scene
// loader reads.
//
// LoadPixelScene(materials, colors, x, y, background_filename, ...) -- and the
// equivalent <PixelScene background_filename="..."> -- blits that image 1:1 at
// the scene position as a background sprite (z = background_z_index, default
// 50, PixelScene_ProcessQueue @00882dd0). It sits behind every cell and in
// front of the biome backdrop, so it shows through the scene's air (#000042
// force-air included), through gaps its art never paints, and under its
// translucent liquids. It is worldgen, not decoration: no "custom art" toggle
// governs it.
//
// Sources of the scene -> background mapping, all three of which the game
// actually uses (an implicit "<name>_background.png next to the material PNG"
// rule does NOT hold -- plenty of those files ship unreferenced):
//   * lua scene tables:   material_file = "x.png", background_file = "y.png"
//   * lua calls:          LoadPixelScene( "x.png", "x_visual.png", px, py, "y.png" )
//   * biome/*.xml:        <PixelScene material_filename=".." background_filename=".." >
//
// A telescope scene is matched to a game material path by basename within the
// biome_impl subdirs its scene dir maps to (GAME_DIRS, same table as
// tools/gen_visual_overlays.mjs), confirmed by PNG dimensions -- basenames
// collide across biomes ("altar" is both data/biome_impl/altar.png and
// data/biome_impl/temple/altar.png, and only the latter has a background).
//
// Art is shipped under data/backgrounds/<game path minus data/>, the layout
// tools/gen_backgrounds.py already uses for the backdrops and the global
// <BackgroundImages> sprites, so the two share one set of files and one
// preloader (js/biome_backgrounds.js). Files already present are left alone.
//
//   node tools/gen_scene_backgrounds.mjs [path-to-data.wak.unpacked]
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const GAME = process.argv[2]
	?? '/home/vitaminmoo/reverse/noita/noita_Jan_25_2025_15:55:41/data/data.wak.unpacked';
const IMPL = join(GAME, 'biome_impl');
const SCENES = join(repo, 'data', 'pixel_scenes');

// telescope scene dir -> game biome_impl subdirs to try, in order. '' is the
// biome_impl root, where the shared scenes live. Kept in sync with
// tools/gen_visual_overlays.mjs.
const GAME_DIRS = {
	general: [''],
	rainforest_open: ['rainforest'],
	rainforest_dark: ['rainforest_dark', 'rainforest'],
	// spliced scenes were assembled from numbered tiles by the original
	// exporter, so no single game material PNG corresponds to one.
	spliced: [],
	sky_islands: ['sky_islands'],
};

function pngSize(path) {
	const b = readFileSync(path);
	// IHDR width/height at fixed offsets in any valid PNG
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. game material path -> background path

const bgForMaterial = new Map();
const conflicts = [];
function record(material, background, where) {
	if (!material || !background) return;
	if (!material.startsWith('data/') || !background.startsWith('data/')) return;
	// dead references (endgame2_background.png) and lua concat fragments the
	// scan can pick up are dropped here rather than at copy time
	if (!existsSync(join(GAME, background.slice(5)))) return;
	const prev = bgForMaterial.get(material);
	if (prev && prev !== background) {
		conflicts.push(`${material}: ${prev} vs ${background} (${where}, keeping first)`);
		return;
	}
	bgForMaterial.set(material, background);
}

// lua scene tables. Splitting on braces keeps a pairing inside one table entry
// (the fields appear in either order and the entries are flat).
const luaFiles = walk(GAME).filter(p => p.endsWith('.lua'));
for (const file of luaFiles) {
	const text = readFileSync(file, 'utf8');
	for (const segment of text.split(/[{}]/)) {
		const mat = /material_file\s*=\s*"([^"]+)"/.exec(segment);
		const bg = /background_file\s*=\s*"([^"]+)"/.exec(segment);
		if (mat && bg) record(mat[1], bg[1], file);
	}
	// LoadPixelScene( materials, colors, x, y, background, ... ): the position
	// arguments are arbitrary expressions, so the arguments are split on
	// top-level commas rather than matched with a regex.
	for (const m of text.matchAll(/LoadPixelScene\s*\(/g)) {
		// skip commented-out calls (`--LoadPixelScene(...)`)
		const lineStart = text.lastIndexOf('\n', m.index) + 1;
		if (/--[^\n]*$/.test(text.slice(lineStart, m.index))) continue;
		const args = [];
		let depth = 1, arg = '', quote = false;
		for (let i = m.index + m[0].length; i < text.length && depth > 0; i++) {
			const c = text[i];
			if (quote) { if (c === '"') quote = false; arg += c; continue; }
			if (c === '"') { quote = true; arg += c; continue; }
			if (c === '(' || c === '{') depth++;
			else if (c === ')' || c === '}') { depth--; if (depth === 0) break; }
			if (depth === 1 && c === ',') { args.push(arg); arg = ''; continue; }
			arg += c;
		}
		args.push(arg);
		const lit = (s) => { const q = /^\s*"([^"]*)"\s*$/.exec(s ?? ''); return q ? q[1] : null; };
		record(lit(args[0]), lit(args[4]), file);
	}
}

// biome XML: attribute order varies between files, so the tag is matched first
// and its attributes read out individually.
const biomeDir = join(GAME, 'biome');
for (const file of walk(biomeDir).filter(p => p.endsWith('.xml'))) {
	const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
	for (const tag of text.match(/<PixelScene\b[^>]*>/g) ?? []) {
		const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
		record(attr('material_filename'), attr('background_filename'), file);
	}
}

// ---------------------------------------------------------------------------
// 2. telescope scene -> that background, shipped

const manifest = {};
const sizeNotes = [];
let copied = 0;
for (const dir of readdirSync(SCENES).sort()) {
	if (!statSync(join(SCENES, dir)).isDirectory()) continue;
	const gameDirs = GAME_DIRS[dir] ?? [dir, ''];
	for (const file of readdirSync(join(SCENES, dir)).sort()) {
		if (!file.endsWith('.png') || file.includes('_visual') || file.includes('_background')) continue;
		const name = file.slice(0, -4);
		const ours = pngSize(join(SCENES, dir, file));
		for (const gd of gameDirs) {
			const rel = `data/biome_impl/${gd ? gd + '/' : ''}${name}.png`;
			const mat = join(IMPL, gd, `${name}.png`);
			if (!existsSync(mat)) continue;
			const theirs = pngSize(mat);
			if (theirs.w !== ours.w || theirs.h !== ours.h) continue; // different scene sharing the name
			const bg = bgForMaterial.get(rel);
			if (!bg) break; // this IS the scene, it simply has no background
			const dest = 'data/backgrounds/' + bg.slice(5);
			const destPath = join(repo, dest);
			if (!existsSync(destPath)) {
				mkdirSync(dirname(destPath), { recursive: true });
				copyFileSync(join(GAME, bg.slice(5)), destPath);
				copied++;
			}
			const bgSize = pngSize(destPath);
			if (bgSize.w !== ours.w || bgSize.h !== ours.h) {
				sizeNotes.push(`${dir}/${name}: scene ${ours.w}x${ours.h}, background ${bgSize.w}x${bgSize.h}`);
			}
			manifest[`${dir}/${name}`] = dest;
			break;
		}
	}
}

const sorted = Object.fromEntries(Object.keys(manifest).sort().map(k => [k, manifest[k]]));
const out = `// GENERATED by tools/gen_scene_backgrounds.mjs -- do not edit.
// Scene key (\`\${getBiomeAlias(biome)}/\${sceneName}\`, the data/pixel_scenes
// path) -> the repo-relative background image the engine draws behind that
// scene (LoadPixelScene's background_filename, z = 50). The image is blitted
// 1:1 at the scene's top-left, so a background larger or smaller than the scene
// hangs off / falls short exactly as it does in game.
export const SCENE_BACKGROUNDS = ${JSON.stringify(sorted, null, '\t')};
`;
writeFileSync(join(repo, 'js', 'pixel_scene_backgrounds.js'), out);

console.log(`${bgForMaterial.size} scene->background pairs in the game data`);
for (const c of conflicts) console.log(`  conflict ${c}`);
console.log(`${Object.keys(sorted).length} telescope scenes have one (${copied} PNGs newly copied)`);
if (sizeNotes.length) {
	console.log(`${sizeNotes.length} backgrounds are not scene-sized (anchored top-left):`);
	for (const n of sizeNotes) console.log(`  ${n}`);
}
console.log('js/pixel_scene_backgrounds.js written');
