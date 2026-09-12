// Pixel-scene background art: the scene->background manifest and the per-biome
// overrides that a flat, scene-keyed map cannot express.
//
// LoadPixelScene's background_filename is blitted 1:1 at the scene's top-left,
// behind the cells and in front of the biome backdrop
// (docs/worldgen/background_rendering.md in the RE repo). The mapping is keyed
// by the CALL SITE, not by the scene: data/biome_impl/essenceroom.png is loaded
// by nine biome scripts, and they do not all pass the same background.
//
//   essenceroom, essenceroom_alc, essenceroom_hell, gun_room, tower_end
//       -> essenceroom_background_with_diamond.png   (a ~98% opaque slab)
//   rock_room, moon_room, essenceroom_air
//       -> essenceroom_background_diamond.png        (~88% transparent)
//
// That difference is the whole point: with the transparent one the biome's own
// backdrop tiles show through the room and only the diamond silhouette is
// painted, and with the opaque one the room is walled off in flat brown. The
// generator's first-wins map used to hand all nine the opaque slab, which
// filled every rock_room / moon_room chunk edge to edge (seed 786433191 ng0:
// biome-map cells 28,20 and 66,20 -- the chunk at world (-3584,3072) is the
// rock_room next to the reported spot at (-3593,3129)).
//
// Nothing here needs a browser: it pins the generated manifest against the art
// actually shipped, including the alpha property that makes the two arts
// different answers rather than two spellings of one answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import UPNG from 'upng-js';
import { SCENE_BACKGROUNDS, SCENE_BACKGROUNDS_BY_BIOME } from '../js/pixel_scene_backgrounds.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Share of the PNG's pixels that are fully transparent / fully opaque. */
function alphaProfile(repoRelPath) {
	const img = UPNG.decode(readFileSync(REPO + repoRelPath));
	const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);
	let clear = 0, opaque = 0;
	for (let i = 3; i < rgba.length; i += 4) {
		if (rgba[i] === 0) clear++;
		else if (rgba[i] === 255) opaque++;
	}
	const n = img.width * img.height;
	return { w: img.width, h: img.height, clear: clear / n, opaque: opaque / n };
}

test('every scene background the manifests name is shipped', () => {
	const paths = new Set(Object.values(SCENE_BACKGROUNDS));
	for (const scenes of Object.values(SCENE_BACKGROUNDS_BY_BIOME)) {
		for (const p of Object.values(scenes)) paths.add(p);
	}
	assert.ok(paths.size > 0, 'no scene backgrounds at all');
	for (const p of paths) {
		assert.ok(existsSync(REPO + p), `${p} is referenced but not shipped`);
	}
});

test('the essence room keeps a per-biome background, not one shared answer', () => {
	// The three biomes whose own lua passes the transparent art. If a future
	// regeneration collapses these back into the flat map, the rock_room and
	// moon_room chunks silently go back to being flat brown blocks.
	for (const biome of ['rock_room', 'moon_room', 'essenceroom_air']) {
		assert.equal(
			SCENE_BACKGROUNDS_BY_BIOME[biome]?.essenceroom,
			'data/backgrounds/biome_impl/essenceroom_background_diamond.png',
			`${biome} should stamp the essence room with the transparent diamond art`);
	}
	// ... and the biomes that are NOT overridden still get the opaque one, which
	// is what the shared scene key carries.
	assert.equal(SCENE_BACKGROUNDS['general/essenceroom'],
		'data/backgrounds/biome_impl/essenceroom_background_with_diamond.png');
	for (const biome of ['essenceroom', 'gun_room', 'tower_end', 'essenceroom_hell']) {
		assert.equal(SCENE_BACKGROUNDS_BY_BIOME[biome]?.essenceroom, undefined,
			`${biome} uses the scene default and should not be overridden`);
	}
});

test('the two essence-room backgrounds differ in the way that matters', () => {
	const diamond = alphaProfile('data/backgrounds/biome_impl/essenceroom_background_diamond.png');
	const slab = alphaProfile('data/backgrounds/biome_impl/essenceroom_background_with_diamond.png');

	// Same footprint, so choosing between them can only change what shows
	// through -- never where the sprite lands.
	assert.deepEqual([diamond.w, diamond.h], [512, 512]);
	assert.deepEqual([slab.w, slab.h], [512, 512]);

	// The override art is mostly holes: the biome backdrop is meant to show
	// through it. (Measured 87.6% fully transparent.)
	assert.ok(diamond.clear > 0.8,
		`diamond art should be mostly transparent, got ${(diamond.clear * 100).toFixed(1)}%`);
	// The default art is a wall: it hides the backdrop completely.
	assert.ok(slab.opaque > 0.9,
		`with_diamond art should be near-fully opaque, got ${(slab.opaque * 100).toFixed(1)}%`);
});
