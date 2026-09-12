// Hand-drawn art tiles that stand in for a pixel scene's appearance.
//
// A handful of rooms are drawn from telescope's own low-resolution art rather
// than from the game's material PNG: the cauldron room and the orb rooms today.
// That art is NOT game data -- nothing under data/biome_maps/custom/ exists in
// data.wak, and noita.exe has no string for any of it. The engine paints these
// rooms like any other pixel scene, 1:1 from data/biome_impl/<name>.png
// (PixelScene_TryPaintEntry @0x00880fb0). The tiles are a legibility aid: 16x16
// images blown up over the 512px chunk, so a room reads at a glance when zoomed
// out past the point where its real pixels resolve.
//
// It is still the room's ACTUAL appearance as far as a viewer is concerned, not
// a debug overlay, so it is drawn under the same gate as every other piece of
// scene art -- the "Display Custom Art" checkbox, on by default -- and inside
// the pixel-scene render layer. It is deliberately NOT under the "Custom Art"
// debug layer, which is off by default and covers the expensive full-world
// surface/sky overlays that hide generated terrain.
//
// A stand-in only stands in while the thing it replaces is unreadable. A tile
// pixel is 32 world pixels, so the moment the room's own pixels are resolvable
// the tile is strictly the coarser picture -- and since the density class started
// resolving through the biome's bands (pixel_scene_generation.js densityBiomeFor)
// the real orb room draws its brick frame, its floor materials and the air holes
// that show its background art, all of which the 16x16 tile flattens to one
// blob. So the tile is drawn only below this zoom, where a 512px room is under
// ~128 screen pixels and its detail is mush anyway. Above it the room draws
// itself. The copies that have no scene to draw -- the vertical-PW orb rooms,
// which addStaticPixelScenes only stamps in vertical PW 0 -- keep their tile at
// every zoom; that is app.js's separate orb-repeat pass, not this manifest.
//
// Keys are telescope's scene keys, `${getBiomeAlias(biome)}/${sceneName}` --
// the same space as VISUAL_OVERLAY_SCENES, SCENE_BACKGROUNDS and
// SKIP_EDGE_TEXTURE_SCENES. Values name a file stem under
// data/biome_maps/custom/; `pick` chooses between variants from the world being
// drawn, and returning null means "no art here, draw the scene normally".
//
// To give another scene a tile: drop the PNG in data/biome_maps/custom/ and add
// one line here. Nothing in app.js needs to change.
import { getCauldronVariation } from './cauldron.js';

export const SCENE_ART = {
	// data/scripts/... loads one cauldron scene; which of the two tiles shows is
	// telescope's own 365-day calendar (js/cauldron.js). State 2 is the
	// leap-year December case, which flips per second.
	'general/cauldron': {
		tiles: ['cauldron_room', 'cauldron_room_broken'],
		pick: ({ app }) => {
			if (app.cauldronState === null || app.gameMode === 'nightmare') return null;
			return (app.cauldronState === 0 || (app.cauldronState === 2 && getCauldronVariation()))
				? 'cauldron_room_broken' : 'cauldron_room';
		},
	},
	// Every orb room is the same data/biome_impl/orbroom.png; the cursed tile
	// marks the parallel-world copies, whose orbs carry the curse -- horizontally
	// AND vertically. Only the true main-world room is uncursed: upstream 79ae135
	// ("Fix orb tower minor display bug") added the pwY test to the equivalent
	// predicate back when app.js still chose the tile inline, and the choice has
	// since moved here, so the condition lives here now.
	'general/orbroom': {
		tiles: ['orb_room', 'cursed_orb_room'],
		pick: ({ app, pwX, pwY }) => (pwX === 0 && pwY === 0 && app.gameMode !== 'nightmare')
			? 'orb_room' : 'cursed_orb_room',
	},
};

/**
 * The camera zoom at or above which a stamped scene draws itself instead of its
 * stand-in tile: one 512px room is 128 screen pixels here.
 */
export const SCENE_ART_MAX_ZOOM = 0.25;

/** Every file stem the manifest can ask for, for the art preloader. */
export const SCENE_ART_TILES = [...new Set(Object.values(SCENE_ART).flatMap(e => e.tiles))];

/**
 * The art tile stem for a scene in the world being drawn, or null when the
 * scene has none (the common case) or its condition does not hold.
 *
 * @param {string} key   scene key, e.g. "general/cauldron"
 * @param {object} ctx   { app, pwX, pwY } -- the world this draw pass is on,
 *                       not app.pw, since several worlds can be on screen.
 */
export function sceneArtTile(key, ctx) {
	const entry = SCENE_ART[key];
	return entry ? entry.pick(ctx) : null;
}
