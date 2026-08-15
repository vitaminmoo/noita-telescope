// Tier 1 of the pixel regression harness: pure-Node checks that the CPU
// engine-resolve chain still answers what the game answered for a set of small
// world rects, one test per fixture.
//
// Fixtures live in test/fixtures/regression/ (see its README for what each one
// guards, where the ground truth came from, and how to add more). Tier 2 —
// the full GL render compared to the same rects — is test/gl_regression.mjs,
// which needs a browser and is run on demand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureNames, loadFixture, verdict } from './helpers/fixtures.mjs';
import { evaluateTier1 } from './helpers/tier1.mjs';

const names = fixtureNames();

test('the regression fixture set is present', () => {
	assert.ok(names.length >= 10, `only ${names.length} regression fixtures found`);
});

for (const name of names) {
	test(`regression: ${name}`, async () => {
		const f = loadFixture(name);
		const r = await evaluateTier1(f);

		// 1. The engine's classification of the fixture's chunk(s): which biome
		//    the cell is, whether the generator paints anything there, and whether
		//    telescope stands a constant fill in for it. Every "room filled solid"
		//    / "basin went empty" bug is a wrong answer here.
		for (const fl of r.flags) {
			assert.equal(fl.bad.length, 0,
				`${name} guards: ${f.guards}\n  chunk ${fl.cell} changed: `
				+ fl.bad.map(([k, v]) => `${k} ${JSON.stringify(v)} -> ${JSON.stringify(fl.got[k])}`).join(', '));
		}

		// 2. Per-pixel: the engine model against the game's own pixels.
		const check = f.tier1?.pixels;
		if (check && check.metric !== 'none' && check.threshold !== null) {
			const v = verdict(check, r.pixels.pct);
			assert.ok(v.pass,
				`${name} guards: ${f.guards}\n  ${check.metric} agreement ${v.why}`
				+ `\n  baseline ${check.measured}% measured ${check.measuredAt} at ${check.measuredCommit}`
				+ `\n  top diffs: ${r.pixels.top}`);
		}

		// 3. Coverage must not shrink: pixels the model declines to resolve at all
		//    (a chunk it has no terrain model for) may not grow past the baseline.
		if (f.tier1?.maxUnresolvedPct !== null && f.tier1?.maxUnresolvedPct !== undefined) {
			assert.ok(r.unresolvedPct <= f.tier1.maxUnresolvedPct,
				`${name}: engine-unresolved pixels grew to ${r.unresolvedPct.toFixed(2)}% `
				+ `(baseline allows ${f.tier1.maxUnresolvedPct}%)`);
		}
	});
}
