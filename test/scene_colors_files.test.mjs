// Pixel-scene COLORS files: which art the loader will paint a scene's cells
// with, and whether that art ships.
//
// LoadPixelScene's second argument is an explicit path to a colors image, and
// the engine paints each cell's color from it wherever it has alpha, overriding
// the material's texture or flat color. Telescope resolves that path from two
// places (js/pixel_scene_generation.js sceneColorsFileName): the generated
// VISUAL_OVERLAY_SCENES manifest, which only knows the `<name>_visual.png sits
// beside <name>.png` convention, and the hand-written SCENE_COLORS_FILE_ALIASES
// for the call sites that do not follow it.
//
// A scene missing from BOTH fails silently. sceneColorsFileName returns null, no
// fetch is attempted, so not even loadPixelSceneData's "visual art ... missing"
// warning fires, and the room just draws material-derived. That is how the
// cauldron room lost the custom art on its stone AND the color of its sand at
// once: its colors file ships as cauldron_fg.png, a spelling neither source
// knew, so 195,042 pixels of hand-painted art were shipped in the repo and
// loaded by nothing.
//
// Nothing here needs a browser. The draw path is browser-only, but "is the art
// wired to the scene it belongs to, and is the file there" is pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import UPNG from 'upng-js';
import { sceneColorsFileName } from '../js/pixel_scene_generation.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCENES = `${REPO}data/pixel_scenes`;

/** Art suffixes, and the ones that are never a colors file. */
const ART = /^(.*)_(visual|fg)\.png$/;
const NON_SCENE = /_(visual|fg|bg|background|hint_bg|hint_bg_2)$/;

const sceneDirs = () => readdirSync(SCENES).filter(d => statSync(`${SCENES}/${d}`).isDirectory());

test('every colors file the loader resolves actually ships', () => {
	let resolved = 0;
	for (const dir of sceneDirs()) {
		for (const file of readdirSync(`${SCENES}/${dir}`)) {
			if (!file.endsWith('.png')) continue;
			const name = file.slice(0, -4);
			if (NON_SCENE.test(name)) continue;      // art, not a scene's material PNG
			const art = sceneColorsFileName(dir, name);
			if (!art) continue;
			resolved++;
			assert.ok(existsSync(`${SCENES}/${dir}/${art}.png`),
				`${dir}/${name} resolves colors file ${art}.png, which is not shipped`);
		}
	}
	// A wholesale drop (a regenerated manifest that found nothing, say) should
	// not read as "all clear".
	assert.ok(resolved > 200, `only ${resolved} scenes resolve a colors file`);
});

test('art shipped beside a scene is wired to that scene', () => {
	// The cauldron regression, generalized: an art PNG sitting next to the
	// material PNG it is named after is art SOMETHING is meant to paint. If
	// sceneColorsFileName does not name it, it ships and is never loaded, and the
	// room silently draws without it.
	//
	// Art with no `<base>.png` sibling is deliberately out of scope: the
	// sky-island temples' `<biome>_fg.png` / `<biome>_bg.png` are wang templates
	// and background masks named in the static_tile biome XMLs
	// (wang_template_file / static_tile_bg_mask), not pixel-scene colors files.
	let wired = 0;
	for (const dir of sceneDirs()) {
		const files = readdirSync(`${SCENES}/${dir}`);
		const present = new Set(files);
		for (const file of files) {
			const m = ART.exec(file);
			if (!m || !present.has(`${m[1]}.png`)) continue;
			assert.equal(sceneColorsFileName(dir, m[1]), file.slice(0, -4),
				`data/pixel_scenes/${dir}/${file} is art for ${m[1]}.png, but the loader `
				+ `resolves ${sceneColorsFileName(dir, m[1])} for ${dir}/${m[1]}`);
			wired++;
		}
	}
	assert.ok(wired > 200, `only ${wired} scene/art pairs found`);
});

/** RGBA bytes of a repo PNG. */
function rgba(path) {
	const img = UPNG.decode(readFileSync(path));
	return { w: img.width, h: img.height, px: new Uint8Array(UPNG.toRGBA8(img)[0]) };
}

test("the cauldron room's colors file covers exactly its stone and its sand", () => {
	// Why cauldron_fg.png is the colors file for cauldron.png and not some
	// unrelated sprite that happens to sit beside it: its alpha footprint is
	// exactly the scene's painted cells, material by material. No build of the
	// game on disk ships this room, so the pairing rests on the art itself.
	assert.equal(sceneColorsFileName('general', 'cauldron'), 'cauldron_fg');

	const mat = rgba(`${SCENES}/general/cauldron.png`);
	const art = rgba(`${SCENES}/general/cauldron_fg.png`);
	assert.deepEqual([art.w, art.h], [mat.w, mat.h]);

	// materials.xml wang colors (data.wak.unpacked): the room's three materials.
	const MATERIALS = { sand: 0xebcd00, rock_static: 0x353923, rock_hard_border: 0x104344 };
	const cells = { sand: 0, rock_static: 0, rock_hard_border: 0 };
	const painted = { sand: 0, rock_static: 0, rock_hard_border: 0 };
	let artPixels = 0, artOffCells = 0;
	for (let p = 0; p < mat.w * mat.h; p++) {
		const o = p * 4;
		const color = (mat.px[o] << 16) | (mat.px[o + 1] << 8) | mat.px[o + 2];
		const hasArt = art.px[o + 3] !== 0;
		if (hasArt) artPixels++;
		let named = null;
		for (const [k, v] of Object.entries(MATERIALS)) if (v === color) named = k;
		if (named === null) { if (hasArt) artOffCells++; continue; }
		cells[named]++;
		if (hasArt) painted[named]++;
	}

	// The sand is the room's largest material and the art paints all of it: this
	// is the "sand has no custom color" half of the report.
	assert.equal(painted.sand, cells.sand, 'the art should paint every sand cell');
	assert.ok(cells.sand > 80000, `expected a sand floor, got ${cells.sand} cells`);
	// The stone: the art paints all but a few hundred cells of it.
	assert.ok(painted.rock_static / cells.rock_static > 0.99,
		`art covers only ${(100 * painted.rock_static / cells.rock_static).toFixed(1)}% of the stone`);
	assert.equal(painted.rock_hard_border, cells.rock_hard_border);
	// And it paints NOTHING anywhere else -- every art pixel lands on one of the
	// three materials, which is what makes it this scene's colors file.
	assert.equal(artOffCells, 0, 'art outside the scene\'s painted cells');
	assert.equal(artPixels, painted.sand + painted.rock_static + painted.rock_hard_border);
});
