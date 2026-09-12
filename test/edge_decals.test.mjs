// The EdgeGraphics decal pass, scored against the game's own baked cell colours.
//
// Separate from test/regression_pixels.test.mjs because it asks a different
// question with a different ground truth: those fixtures pin the engine-resolve
// chain against MAPDUMP/MATDUMP, this one pins js/edge_decals.js against a
// BAKEDUMP -- the only dump that carries the decal band at all.
//
// What these numbers mean, and why the placement ones are low, is in
// test/fixtures/edge_decals/README.md. The short version: the engine rolls its
// stamps off a free-running RNG stream that cannot be recovered offline, so this
// fixture pins the pass's DENSITY and PALETTE (which are reproducible) and
// records its PLACEMENT overlap (which is not) so that any future improvement
// is visible instead of invisible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decalFixtureNames, loadDecalFixture, evaluateDecalFixture } from './helpers/edge_decals.mjs';

const names = decalFixtureNames();

test('the edge-decal fixture set is present', () => {
	assert.ok(names.length >= 1, `only ${names.length} edge-decal fixtures found`);
});

for (const name of names) {
	test(`edge decals: ${name}`, async () => {
		const f = loadDecalFixture(name);
		const r = await evaluateDecalFixture(f);

		for (const [metric, check] of Object.entries(f.checks)) {
			if (!check || check.threshold === null) continue;
			const got = r[metric];
			assert.notEqual(got, undefined, `${name}: no measurement for ${metric}`);
			const why = `${name} guards: ${f.guards}\n  ${metric} ${got.toFixed(3)}`
				+ ` vs ${check.mode === 'max' ? '<=' : '>='} ${check.threshold}`
				+ `\n  baseline ${check.measured} measured ${check.measuredAt} at ${check.measuredCommit}`
				+ `\n  game ${r.gameDecalPct.toFixed(2)}% of ${r.solid} solid px dressed, ours ${r.ourDecalPct.toFixed(2)}%`
				+ ` (both ${r.both}, game-only ${r.gameOnly}, ours-only ${r.oursOnly})`;
			if (check.mode === 'max') assert.ok(got <= check.threshold + 1e-9, why);
			else assert.ok(got + 1e-9 >= check.threshold, why);
		}
	});
}
