// The scene-art manifest (js/pixel_scene_art.js): which hand-drawn stand-in
// tile a stamped pixel scene gets, and under what conditions it gets none.
//
// These are the parts of the cauldron-room art regression that are reachable
// from Node. The draw pass itself is browser-only (canvas, zoom, bitmaps), but
// everything that decided "no art here" in that bug is pure:
//
//   * the KEY the manifest is written against has to be the key the stamper
//     actually produces -- `${getBiomeAlias(biome)}/${sceneName}`, which for a
//     STATIC_PIXEL_SCENES entry is just its `name`. A typo on either side is
//     silent: sceneArtTile() returns null and the room draws bare.
//   * the SCENE the art hangs off has to survive addStaticPixelScenes' filters.
//     Since the art moved onto the scene (53d7013) an entry that the 'Some'
//     setting drops takes its art down with it, where the old hardcoded blit
//     drew regardless.
//   * `pick` has to hold for every world state, including the two that mean
//     "draw nothing": an unknown cauldron date and Nightmare mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SCENE_ART, SCENE_ART_TILES, SCENE_ART_MAX_ZOOM, sceneArtTile } from '../js/pixel_scene_art.js';
import { STATIC_PIXEL_SCENES } from '../js/static_spawns.js';

const ART_DIR = new URL('../data/biome_maps/custom/', import.meta.url);
const cauldron = (app, extra = {}) => sceneArtTile('general/cauldron', { app, pwX: 0, pwY: 0, ...extra });

test('the manifest imports cleanly outside a browser', () => {
	// It is only testable at all while it pulls in no DOM: importing
	// js/cauldron.js here would drag js/app.js and the worker graph in with it.
	assert.ok(Object.keys(SCENE_ART).length >= 1);
	assert.ok(SCENE_ART_MAX_ZOOM > 0 && SCENE_ART_MAX_ZOOM <= 1);
});

test('every tile the manifest can ask for ships as a PNG', () => {
	for (const stem of SCENE_ART_TILES) {
		assert.ok(existsSync(new URL(`${stem}.png`, ART_DIR)),
			`js/pixel_scene_art.js names ${stem}, but data/biome_maps/custom/${stem}.png is missing`);
	}
});

test('the cauldron room is stamped under exactly the key the manifest uses', () => {
	const entries = STATIC_PIXEL_SCENES.filter(s => s.name.endsWith('/cauldron'));
	assert.equal(entries.length, 1, 'expected one static cauldron scene');
	// A static entry's `name` IS its scene key: addStaticPixelScenes splits it on
	// '/' into (biome folder, scene name) and loadPixelScene keys "general/" +
	// name back, general scenes being biome-less.
	assert.equal(entries[0].name, 'general/cauldron');
	assert.ok(SCENE_ART[entries[0].name], 'no SCENE_ART entry for the stamped cauldron key');
});

test('a scene with art survives the Some setting, or its art goes with it', () => {
	// addStaticPixelScenes drops every entry without `required` when
	// 'Enable Static Pixel Scenes' is 'some'. For a room whose appearance IS the
	// manifest tile that is not a detail level, it is the room vanishing.
	for (const entry of STATIC_PIXEL_SCENES) {
		if (!SCENE_ART[entry.name]) continue;
		assert.ok(entry.required,
			`${entry.name} has scene art but is not 'required', so 'Some' drops the room and its art`);
	}
});

test('cauldron art follows the calendar state', () => {
	assert.equal(cauldron({ cauldronState: 0, gameMode: 'normal' }), 'cauldron_room_broken');
	assert.equal(cauldron({ cauldronState: 1, gameMode: 'normal' }), 'cauldron_room');
});

test('cauldron state 2 flips on the variation, which the caller supplies', () => {
	// The leap-year December case. The clock reader lives in js/cauldron.js and
	// arrives through ctx, so the manifest stays pure.
	const app = { cauldronState: 2, gameMode: 'normal' };
	assert.equal(cauldron(app, { cauldronVariation: () => 1 }), 'cauldron_room_broken');
	assert.equal(cauldron(app, { cauldronVariation: () => 0 }), 'cauldron_room');
	// Absent reader must not throw -- it reads as "not the broken variation".
	assert.equal(cauldron(app), 'cauldron_room');
});

test('cauldron art is skipped when there is no state and in Nightmare', () => {
	assert.equal(cauldron({ cauldronState: null, gameMode: 'normal' }), null);
	assert.equal(cauldron({ cauldronState: 0, gameMode: 'nightmare' }), null);
	assert.equal(cauldron({ cauldronState: 1, gameMode: 'nightmare' }), null);
});

test('only the true main-world orb room is uncursed', () => {
	const app = { gameMode: 'normal' };
	const orb = (pwX, pwY, a = app) => sceneArtTile('general/orbroom', { app: a, pwX, pwY });
	assert.equal(orb(0, 0), 'orb_room');
	assert.equal(orb(1, 0), 'cursed_orb_room');
	assert.equal(orb(-1, 0), 'cursed_orb_room');
	assert.equal(orb(0, 1), 'cursed_orb_room');
	assert.equal(orb(0, 0, { gameMode: 'nightmare' }), 'cursed_orb_room');
});

test('a scene with no manifest entry gets no tile', () => {
	assert.equal(sceneArtTile('general/bunker', { app: {}, pwX: 0, pwY: 0 }), null);
});
