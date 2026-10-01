/* global Buffer */
// data/packs/*.pack hold the decoded pixels of the PNGs the generation and the
// scene builds read (js/asset_pack.js); the app inflates them instead of
// decoding the PNGs. A pack that no longer matches its PNGs gives the app
// different pixels than the files say, silently. Rebuild with
// `node tools/build_asset_packs.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ASSET_PACKS } from '../js/asset_pack.js';
import { buildAssetPack } from '../tools/build_asset_packs.mjs';

for (const spec of ASSET_PACKS) {
	test(`data/${spec.file} matches its PNGs`, async () => {
		const file = new URL(`../data/${spec.file}`, import.meta.url);
		assert.ok(existsSync(file), `data/${spec.file} is missing: run node tools/build_asset_packs.mjs`);
		const { bytes } = await buildAssetPack(spec);
		assert.ok(Buffer.compare(readFileSync(file), bytes) === 0,
			`data/${spec.file} is stale: run node tools/build_asset_packs.mjs`);
	});
}
