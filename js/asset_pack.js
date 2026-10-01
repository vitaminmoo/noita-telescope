// Asset packs: the PNGs the generation and the scene builds read pixels from,
// already decoded.
//
// Those pixels are needed as bytes (wang templates, base biome maps, pixel
// scenes and their colors files), so each PNG used to be pulled out of a zip
// and inflated and unfiltered in JavaScript (UPNG) -- on a first visit, most of
// what the workers did before they could start: a few hundred milliseconds for
// the terrain worker's templates, and well over a second across the scene
// workers for the scenes of an overview.
//
// A pack (tools/build_asset_packs.mjs) holds the same RGBA bytes UPNG would
// produce, one gzip member per image, so reading one is the browser's own
// inflate (DecompressionStream) and nothing else. An image that is not in a
// pack -- or a browser without DecompressionStream -- falls back to the PNG.
//
// Layout: 'NTPK', u32 LE index length, the index as JSON
// ({ version, entries: { '<path under data/>': [offset, length, width, height] } }),
// then the members; offsets count from the end of the index.
//
// The packs are generated files: test/asset_packs.test.mjs fails when one no
// longer matches its PNGs.
import { assetUrl } from './asset_url.js';

const DATA_URL = new URL('../data/', import.meta.url).href;

/** Which pack holds which images of data/: whole folders, and single files. */
export const ASSET_PACKS = [
	// What a seed's generation reads: the wang templates and the base biome maps.
	{
		file: 'packs/terrain.pack',
		folders: ['wang_tiles/'],
		files: ['biome_maps/biome_map.png', 'biome_maps/biome_map_newgame_plus.png', 'biome_maps/biome_map_nightmare.png'],
	},
	// The pixel scenes and their colors files.
	{ file: 'packs/pixel_scenes.pack', folders: ['pixel_scenes/'], files: [] },
];

export const PACK_MAGIC = 0x4b50544e;   // 'NTPK', little-endian
export const PACK_VERSION = 1;

const loaded = new Map();   // pack file -> Promise<{ blob, base, entries } | null>

function loadPack(file) {
	let p = loaded.get(file);
	if (!p) {
		p = (async () => {
			const response = await fetch(assetUrl(new URL(file, DATA_URL)));
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const blob = await response.blob();
			const head = new DataView(await blob.slice(0, 8).arrayBuffer());
			if (head.getUint32(0, true) !== PACK_MAGIC) throw new Error('not an asset pack');
			const indexLength = head.getUint32(4, true);
			const index = JSON.parse(await blob.slice(8, 8 + indexLength).text());
			if (index.version !== PACK_VERSION) throw new Error(`pack version ${index.version}, expected ${PACK_VERSION}`);
			return { blob, base: 8 + indexLength, entries: index.entries };
		})().catch((err) => {
			// The PNGs are still there: say so once and decode those instead.
			console.warn(`asset pack ${file} unavailable, decoding PNGs instead:`, err);
			return null;
		});
		loaded.set(file, p);
	}
	return p;
}

/**
 * The decoded pixels of a PNG under data/, from its pack.
 * @param {string} url  the PNG's URL, as loadPNG is given it
 * @returns {Promise<{data: Uint8Array, width: number, height: number}|null>}
 *          null when no pack holds it (the caller decodes the PNG)
 */
export async function loadPackedImage(url) {
	if (typeof DecompressionStream === 'undefined') return null;
	const href = new URL(url, import.meta.url).href;
	if (!href.startsWith(DATA_URL)) return null;
	const path = href.slice(DATA_URL.length);
	const spec = ASSET_PACKS.find(s => s.files.includes(path) || s.folders.some(f => path.startsWith(f)));
	if (!spec) return null;
	const pack = await loadPack(spec.file);
	const entry = pack?.entries[path];
	if (!entry) return null;
	const [offset, length, width, height] = entry;
	const member = pack.blob.slice(pack.base + offset, pack.base + offset + length);
	const bytes = await new Response(member.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
	if (bytes.byteLength !== width * height * 4) throw new Error(`asset pack entry ${path} is ${bytes.byteLength} bytes, expected ${width * height * 4}`);
	return { data: new Uint8Array(bytes), width, height };
}
