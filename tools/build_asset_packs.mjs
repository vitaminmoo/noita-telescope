#!/usr/bin/env node
/* global process, Buffer */
// Rebuilds the asset packs js/asset_pack.js reads: for every PNG under the
// folders a pack covers, the RGBA bytes js/png_sanitizer.js loadPNG decodes it
// to, gzipped, behind a JSON index. The app then inflates instead of decoding.
//
//   node tools/build_asset_packs.mjs [--check]
//
// --check builds nothing: it exits 1 when a pack on disk differs from what
// would be built (test/asset_packs.test.mjs does the same).
//
// Deterministic: entries are sorted by path and gzip is given no timestamp, so
// an unchanged folder rebuilds to the same bytes.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ASSET_PACKS, PACK_MAGIC, PACK_VERSION } from '../js/asset_pack.js';
import { loadPNG } from '../js/png_sanitizer.js';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));

function pngsUnder(folder) {
	return readdirSync(DATA + folder, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile() && e.name.endsWith('.png'))
		.map(e => `${e.parentPath ?? e.path}/${e.name}`.slice(DATA.length).replaceAll('\\', '/').replace(/\/+/g, '/'))
		.sort();
}

/** One pack's bytes, from the PNGs on disk. */
export async function buildAssetPack(spec) {
	const entries = {};
	const members = [];
	let offset = 0;
	for (const paths of [...spec.folders.map(pngsUnder), [...spec.files].sort()]) {
		for (const path of paths) {
			// Through loadPNG itself, so the pack cannot disagree with the decode
			// it replaces (ancillary chunks stripped, then UPNG).
			const img = await loadPNG(`../data/${path}`, { bitmap: false });
			const member = gzipSync(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { level: 9 });
			entries[path] = [offset, member.length, img.width, img.height];
			members.push(member);
			offset += member.length;
		}
	}
	const index = Buffer.from(JSON.stringify({ version: PACK_VERSION, entries }));
	const head = Buffer.alloc(8);
	head.writeUInt32LE(PACK_MAGIC, 0);
	head.writeUInt32LE(index.length, 4);
	return { bytes: Buffer.concat([head, index, ...members]), count: members.length, raw: Object.values(entries).reduce((n, e) => n + e[2] * e[3] * 4, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes('--check');
	let stale = 0;
	mkdirSync(DATA + 'packs', { recursive: true });
	for (const spec of ASSET_PACKS) {
		const { bytes, count, raw } = await buildAssetPack(spec);
		const file = DATA + spec.file;
		if (check) {
			const same = existsSync(file) && Buffer.compare(readFileSync(file), bytes) === 0;
			if (!same) stale++;
			console.log(`${spec.file}: ${same ? 'up to date' : 'STALE'}`);
			continue;
		}
		writeFileSync(file, bytes);
		console.log(`${spec.file}: ${count} images, ${(raw / 1048576).toFixed(1)} MB of pixels in ${(bytes.length / 1024).toFixed(0)} KB`);
	}
	if (stale) { console.error('run node tools/build_asset_packs.mjs'); process.exit(1); }
}
