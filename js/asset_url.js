// Asset URLs: where a file of the site is fetched from.
//
// In a checkout that is where it lies. A deployed build (tools/build_site.mjs)
// also holds each worker bundled into one file and each entry of data/ under a
// name made from a hash of its content, in assets/, which is served to be
// cached forever: a return visit asks the network for nothing but index.html.
// assetUrl() maps a file's own URL to that copy. A file the build does not
// know is fetched from where it lies, as in a checkout.
//
// Whatever the page or a worker fetches or starts goes through it:
//
//   new Worker(assetUrl(new URL('./x_worker.js', import.meta.url)), ...)
//   fetchAsset(new URL('../data/x.json', import.meta.url))
//
// fetchAsset() is fetch() of that URL. The build also keeps a gzipped copy of
// the files the CDN would send as they are (it compresses text types only: the
// material atlas alone is 4.4 MB as a .bin and 0.6 MB gzipped), and fetchAsset
// asks for that one and inflates it.
//
// No imports: prespawn.js loads this before anything else.

// Nothing is kept in the module, so these work before the module has been
// evaluated: the import cycles have modules fetching their data (a top-level
// await) while half the graph is still waiting its turn.
function locate(url) {
	// The site's root: this file is js/asset_url.js, in a build too (there
	// import.meta.url is each module's place in the source tree, not its bundle's).
	const root = new URL('../', import.meta.url).href;
	const href = new URL(url, root).href;
	// { files: { 'js/x_worker.js': 'assets/x_worker-HASH.js' },
	//   data: { '<file or folder of data/>': 'HASH' }, gzip: ['data/<file with a .gz beside its copy>'] }:
	// the first thing a bundle sets; a checkout has none.
	const assets = globalThis.__SITE_ASSETS__;
	if (!assets || !href.startsWith(root)) return { href, gzip: null };
	const path = href.slice(root.length);
	const file = assets.files[path];
	if (file) return { href: root + file, gzip: null };
	// A path under data/ is filed under its own hash or its top folder's.
	const under = /^data\/(([^/?#]+)[^?#]*)/.exec(path);
	const hash = under && (assets.data[under[1]] ?? assets.data[under[2]]);
	if (!hash) return { href, gzip: null };
	const copy = `${root}assets/data/${hash}/${path.slice('data/'.length)}`;
	return { href: copy, gzip: assets.gzip.includes(path) ? `${copy}.gz` : null };
}

/**
 * @param {string|URL} url  absolute, or relative to the site's root ('data/rng/orb_seeds.json')
 * @returns {string} the URL to fetch it from
 */
export function assetUrl(url) {
	return locate(url).href;
}

/**
 * fetch() of a file of the site, by its own URL (as assetUrl takes it).
 * @returns {Promise<Response>}
 */
export async function fetchAsset(url) {
	const { href, gzip } = locate(url);
	if (!gzip || typeof DecompressionStream === 'undefined') return fetch(href);
	const response = await fetch(gzip);
	if (!response.ok) return response;
	return new Response(response.body.pipeThrough(new DecompressionStream('gzip')), { status: response.status });
}
