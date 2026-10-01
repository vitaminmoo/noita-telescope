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
//   fetch(assetUrl(new URL('../data/x.json', import.meta.url)))
//
// No imports: prespawn.js loads this before anything else.

/**
 * @param {string|URL} url  absolute, or relative to the site's root ('data/rng/orb_seeds.json')
 * @returns {string} the URL to fetch it from
 */
export function assetUrl(url) {
	// Nothing is kept in the module, so this works before the module has been
	// evaluated: the import cycles have modules fetching their data (a
	// top-level await) while half the graph is still waiting its turn.
	//
	// The site's root: this file is js/asset_url.js, in a build too (there
	// import.meta.url is each module's place in the source tree, not its bundle's).
	const root = new URL('../', import.meta.url).href;
	const href = new URL(url, root).href;
	// { files: { 'js/x_worker.js': 'assets/x_worker-HASH.js' }, data: { '<entry of data/>': 'HASH' } }:
	// the first thing a bundle sets; a checkout has none.
	const assets = globalThis.__SITE_ASSETS__;
	if (!assets || !href.startsWith(root)) return href;
	const path = href.slice(root.length);
	const file = assets.files[path];
	if (file) return root + file;
	const entry = /^data\/([^/?#]+)/.exec(path);
	const hash = entry && assets.data[entry[1]];
	return hash ? `${root}assets/data/${hash}/${path.slice('data/'.length)}` : href;
}
