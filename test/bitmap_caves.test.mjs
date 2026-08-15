// Tests for the BitmapCaves density-modifier grid replay (js/bitmap_caves.js).
// Ground-truth fixtures: live-dumped seed-1 grids collected from headless game
// workers, at /home/vitaminmoo/reverse/noita/groundtruth/surface/ (see its
// README). Fixture-dependent tests skip when that directory is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
	getModifierGrid, gridSeedFromWorldSeed, minstdSeedAndStep, sampleModifier,
} from '../js/engine_resolve/bitmap_caves.js';

const GT = '/home/vitaminmoo/reverse/noita/groundtruth/surface/';
const haveFixtures = existsSync(GT + 'desert_seed1_modifier.f32');

function loadGrid(name) {
	const raw = readFileSync(GT + name);
	return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

test('seed chain: grid seed derives from the 5th step after SeedAndStep', () => {
	// Byte-verified against Biome_InitializeFromConfig @0x0086b9f0 (worldSeed 1).
	assert.equal(gridSeedFromWorldSeed(1), 940422544);
	assert.equal(minstdSeedAndStep(1), 16807);
});

test('grids are deterministic and cached per (seed, key)', () => {
	const a = getModifierGrid(1, '$biome_desert');
	const b = getModifierGrid(1, '$biome_desert');
	assert.equal(a, b);
	assert.equal(a.W, 512);
	assert.equal(a.H, 256);
	// unknown key (biome without <BitmapCaves>) -> no grid
	assert.equal(getModifierGrid(1, '$biome_lake'), null);
});

test('sampling: modifier is 1.0 far from any feature', () => {
	const g = { W: 512, H: 256, data: new Float32Array(512 * 256).fill(1.0), node94: 2560 };
	assert.equal(sampleModifier(g, 6000, 100), 1.0);
});

test('replay matches live grid structure (seed 1)', { skip: !haveFixtures }, () => {
	// Known-good anchors: the first surface cave of both grids carves the same
	// cells as the live game (byte-verified positions).
	const winter = getModifierGrid(1, '$biome_winter');
	const gtW = loadGrid('winter_seed1_modifier.f32');
	assert.ok(winter.data[0 * 512 + 5] < 1 && gtW[0 * 512 + 5] < 1, 'winter surf cave 0 at (5,0)');
	assert.ok(winter.data[0 * 512 + 207] < 1 && gtW[0 * 512 + 207] < 1, 'winter surf cave at (207,0)');
	// Winter residual = ONLY the un-replayable phase F (do_beginning_down mixes
	// g_damageRng). All diffs must be real phase-F carves - zero 1-ULP-class
	// rounding dust is tolerated anymore.
	let mism = 0, dust = 0;
	for (let i = 0; i < gtW.length; i++) {
		if (gtW[i] !== winter.data[i]) {
			mism++;
			if (Math.abs(gtW[i] - winter.data[i]) <= 1e-5) dust++;
		}
	}
	assert.ok(mism <= 2400, `winter mismatched cells ${mism} regressed above 2400`);
	assert.equal(dust, 0, `winter has ${dust} 1-ULP-class rounding mismatches (should be phase-F-only)`);
});

test('desert grid is byte-exact (seed 1)', { skip: !haveFixtures }, () => {
	const desert = getModifierGrid(1, '$biome_desert');
	const gtD = loadGrid('desert_seed1_modifier.f32');
	let mism = 0;
	for (let i = 0; i < gtD.length; i++) {
		if (gtD[i] !== desert.data[i]) mism++;
	}
	assert.equal(mism, 0, `desert grid must be byte-exact, got ${mism} mismatched cells`);
});

// THE parity direction invariant: everything after the replayed phases (the
// runtime-seeded phase F / do_beginning_down) can only CARVE the live grid
// further (min-merge) - so a live cell may be LOWER than the replay, but a
// replay cell lower than live is impossible unless the replay stamps something
// the game does not. That exact signature (896 phantom-carve cells) was the
// missed-structure-draws bug: hills/winter <CaveStructure> entries consume RNG
// between phases C and E, and skipping them desynced the do_beginning_paths
// carves into the wrong place. Auto-discovers every *_seedN_modifier.f32
// fixture so new ground-truth dumps are covered without editing this test.
test('replay never carves where the live grid does not (all fixtures)',
	{ skip: !haveFixtures }, () => {
	const KEY = { winter: '$biome_winter', unnamed: '_EMPTY_', desert: '$biome_desert' };
	const files = readdirSync(GT).filter((f) => /^(winter|unnamed|desert)_seed\d+_modifier\.f32$/.test(f));
	assert.ok(files.length >= 3, `only ${files.length} grid fixtures found`);
	for (const f of files) {
		const [, tag, seedStr] = /^(\w+?)_seed(\d+)_modifier\.f32$/.exec(f);
		const live = loadGrid(f);
		const grid = getModifierGrid(Number(seedStr), KEY[tag]);
		let replLower = 0, example = null;
		for (let i = 0; i < live.length; i++) {
			if (grid.data[i] < live[i]) {
				replLower++;
				if (!example) example = `cell (row ${Math.floor(i / 512)}, col ${i % 512}): live ${live[i].toFixed(3)} replay ${grid.data[i].toFixed(3)}`;
			}
		}
		assert.equal(replLower, 0,
			`${f}: replay carves ${replLower} cells the live game does not (first: ${example}) - phase draw-count desync?`);
	}
});
