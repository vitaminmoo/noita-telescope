#!/usr/bin/env node
/* global process */
// Builds the site as it is deployed (tools/deploy_pages.sh runs this).
//
// A checkout is the site already: index.html loads js/app.js and every worker
// loads its own module graph, a few hundred files each. That is what you want
// while editing, and it is slow to visit: each worker asks for every module of
// its graph again (they share nothing with the page or with each other), and
// since any of those files can change with the next deploy, the server has to
// be asked about each one on every visit (_headers: no-cache).
//
// The build is the same tree with one directory added, assets/, holding
//
//   - the page's scripts and each worker (js/*_worker.js) bundled into one file
//     apiece, named by a hash of its content;
//   - a copy of each entry of data/ (a file or a folder) under a hash of that
//     entry's content: assets/data/<hash>/<entry>, with a gzipped copy beside
//     each file the CDN would not compress itself (it compresses by content
//     type: text and JSON, not .bin or .csv);
//
// and index.html pointing at all of it: its scripts at the bundles, and every
// other URL in it that names a file under js/ or data/ (its preloads, its CSS)
// at the hashed copy. A file in assets/ never changes -- new content gets a
// new name -- so _headers has it cached forever, and a return visit asks the
// server for index.html and nothing else.
//
// js/asset_url.js is how the running code finds those copies: each bundle
// starts by setting the table (__SITE_ASSETS__), and everything that fetches a
// file or starts a worker asks it for the URL. The tree's own js/ and data/ are
// deployed too, unchanged: what the table lacks is fetched from there, as in a
// checkout (test/site_build_check.mjs fails if the page does that for anything).
//
//   node tools/build_site.mjs --out DIR [--src DIR]
//     --out  where to write the site; made new, or emptied if a build is there
//     --src  the tree to build (default: this checkout)
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
// Not part of the site. A deploy builds a `git archive`, which has none of
// these; a build of a working directory would otherwise pick them up.
const SKIP = new Set(['.git', '.github', '.wrangler', '.claude', '.serena', 'node_modules', 'spikes', 'scripts', 'groundtruth']);
const SKIP_DATA = new Set(['dumps', 'verify_out']);
// What the build was made of, for a person or a test to read; and how a later
// build knows the directory is one it may empty. Not under assets/: its name
// does not change with its content.
const MANIFEST = 'build.json';
// Sent as they are by the CDN, and worth compressing.
const GZIP = /\.(bin|csv)$/;
// A folder of data/ with no more files than this is hashed file by file.
const SMALL_FOLDER = 16;

function parseArgs(argv) {
	const args = { src: resolve(HERE, '..'), out: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--out') args.out = resolve(argv[++i] ?? '');
		else if (argv[i] === '--src') args.src = resolve(argv[++i] ?? '');
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (!args.out) throw new Error('usage: build_site.mjs --out DIR [--src DIR]');
	return args;
}

/** Every file under `dir`, as sorted paths relative to it with forward slashes. */
function filesUnder(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
		}
	};
	if (statSync(dir).isDirectory()) walk(dir);
	else return [''];
	return out.sort();
}

/** A hash of an entry of data/ (a file, or a folder with everything in it). */
function hashEntry(path) {
	const h = createHash('sha256');
	for (const f of filesUnder(path)) {
		h.update(f).update('\0');
		h.update(readFileSync(f ? join(path, f) : path)).update('\0');
	}
	return h.digest('hex').slice(0, 12);
}

/**
 * What a module's source needs changed to run from a bundle.
 *
 * import.meta.url: bundled, every module is in one file under assets/, but the
 * code asks where it is to find its neighbours (`new URL('../data/x',
 * import.meta.url)`). Keep the answer: each module's import.meta.url becomes
 * its place in the source tree, reached from the bundle by `toRoot`.
 *
 * import('./x.js'): a module loaded on demand is in the bundle all the same,
 * and esbuild then runs it, and whatever it shares with the rest, through
 * lazy initialisers -- which deadlock on this graph (import cycles through
 * modules with a top-level await: each waits for the other's initialiser).
 * So a lazy import of one of our own modules becomes a static one, and the
 * bundle is plain modules in order. The vendored libraries stay lazy: they
 * import nothing, and most visits never run them.
 */
const sourcePlugin = (src, toRoot) => ({
	name: 'source',
	setup(build) {
		build.onLoad({ filter: /\.js$/ }, (args) => {
			const text = readFileSync(args.path, 'utf8');
			const rel = relative(src, args.path).split(sep).join('/');
			const imports = [];
			const contents = text
				.replaceAll('import.meta.url', `new URL(${JSON.stringify(toRoot + rel)},import.meta.url).href`)
				.replace(/\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g, (all, quote, spec) => {
					if (spec.includes('/vendor/')) return all;
					const name = `__static_import_${imports.length}`;
					imports.push(`import * as ${name} from ${JSON.stringify(spec)};`);
					return `Promise.resolve(${name})`;
				});
			// On the first line, so every other line keeps its number in the source map.
			return contents === text ? null : { contents: imports.join('') + contents, loader: 'js' };
		});
	},
});

export async function buildSite({ src, out }) {
	// esbuild is a dev dependency of the checkout that runs the build, which
	// need not be the tree being built (a deploy builds an archive of a commit).
	const esbuild = createRequire(join(HERE, 'x'))('esbuild');

	if (existsSync(out) && readdirSync(out).length) {
		if (!existsSync(join(out, MANIFEST))) throw new Error(`${out} is not empty and not a build of the site; not touching it`);
		rmSync(out, { recursive: true });
	}
	mkdirSync(join(out, 'assets'), { recursive: true });

	// --- the tree itself
	for (const name of readdirSync(src)) {
		if (SKIP.has(name) || resolve(src, name) === out) continue;
		cpSync(join(src, name), join(out, name), {
			recursive: true,
			filter: (p) => !(dirname(p) === join(src, 'data') && SKIP_DATA.has(relative(join(src, 'data'), p))),
		});
	}

	// --- data/, each entry under a hash of its content. An entry is a file or
	// a folder of data/; the files of a small folder are entries by themselves,
	// so that rebuilding one asset pack does not rename the other three.
	const data = {}, gzip = [];
	const entries = readdirSync(join(src, 'data')).filter(name => !SKIP_DATA.has(name)).flatMap((name) => {
		const inside = filesUnder(join(src, 'data', name));
		return inside[0] !== '' && inside.length <= SMALL_FOLDER ? inside.map(f => `${name}/${f}`) : [name];
	}).sort();
	for (const name of entries) {
		const hash = data[name] = hashEntry(join(src, 'data', name));
		const copy = join(out, 'assets/data', hash, name);
		cpSync(join(src, 'data', name), copy, { recursive: true });
		for (const f of filesUnder(copy)) {
			if (!GZIP.test(f || name)) continue;
			const file = f ? join(copy, f) : copy;
			writeFileSync(`${file}.gz`, gzipSync(readFileSync(file), { level: 9 }));
			gzip.push(`data/${name}${f ? `/${f}` : ''}`);
		}
	}
	// The hash a path under data/ is filed under: its own, or its top folder's.
	const dataHash = (path) => data[path] ?? data[path.split('/')[0]];

	const bundle = (assets, toRoot, more) => esbuild.build({
		absWorkingDir: src,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		// Names are kept: whitespace and syntax only, so a stack trace from the
		// deployed site still reads like the source.
		minifyWhitespace: true,
		minifySyntax: true,
		// What only Node runs (the tools and tests import the same modules).
		external: ['node:*', 'upng-js'],
		// Ahead of every module: any of them may ask for a URL as it loads.
		banner: { js: `globalThis.__SITE_ASSETS__=${JSON.stringify(assets)};` },
		plugins: [sourcePlugin(src, toRoot)],
		metafile: true,
		logLevel: 'warning',
		...more,
	});
	const toAssets = { outdir: join(out, 'assets'), entryNames: '[name]-[hash]', sourcemap: true };
	// The name each entry point was written under: 'js/x.js' -> 'assets/x-HASH.js'.
	const written = (result) => {
		const files = {};
		for (const [file, o] of Object.entries(result.metafile.outputs)) {
			if (o.entryPoint) files[o.entryPoint] = relative(out, resolve(src, file)).split(sep).join('/');
		}
		return files;
	};

	// --- the workers. Their table has no workers in it: a worker's name is a
	// hash of its bundle, which would then have to hold its own name (the scene
	// worker's graph includes the module that starts scene workers). None of
	// them starts another, and one that did would get it from js/.
	const workers = readdirSync(join(src, 'js')).filter(f => f.endsWith('_worker.js')).sort().map(f => `js/${f}`);
	const files = written(await bundle({ files: {}, data, gzip }, '../', { ...toAssets, entryPoints: workers }));

	// --- the page: index.html's module scripts, the inline one bundled in place
	const assets = { files, data, gzip };
	let html = readFileSync(join(src, 'index.html'), 'utf8');
	const scripts = [...html.matchAll(/<script type="module"(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)];
	if (!scripts.length) throw new Error('index.html has no module scripts to bundle');
	const pageFiles = {};
	for (const [tag, srcAttr, inline] of scripts) {
		let replacement;
		if (srcAttr) {
			const entry = srcAttr.replace(/^\.\//, '');
			const file = written(await bundle(assets, '../', { ...toAssets, entryPoints: [entry] }))[entry];
			pageFiles[entry] = file;
			replacement = `<script type="module" src="./${file}"></script>`;
		} else {
			// Inline it stays: it is there to run before anything has been fetched.
			const result = await bundle(assets, './', { stdin: { contents: inline, resolveDir: src, sourcefile: 'index.html' }, write: false });
			const code = result.outputFiles[0].text.trim();
			if (code.includes('</script')) throw new Error('the bundled inline script would end its own tag');
			replacement = `<script type="module">${code}</script>`;
		}
		html = html.replace(tag, () => replacement);
	}
	// Whatever else index.html names under js/ or data/ (its preloads, its CSS
	// backgrounds): the copy js/asset_url.js will ask for.
	html = html.replace(/(url\(\s*['"]?|\s(?:src|href)=")(?:\.\/)?((?:js|data)\/[^'")\s]+)/g, (all, lead, path) => {
		if (files[path]) return lead + files[path];
		const under = path.startsWith('data/') ? path.slice('data/'.length) : null;
		if (!under || !dataHash(under)) return all;
		return `${lead}assets/data/${dataHash(under)}/${under}${gzip.includes(path) ? '.gz' : ''}`;
	});
	writeFileSync(join(out, 'index.html'), html);

	const built = { files: { ...pageFiles, ...files }, data, gzip };
	writeFileSync(join(out, MANIFEST), JSON.stringify(built, null, '\t') + '\n');
	return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parseArgs(process.argv.slice(2));
	const t0 = performance.now();
	const { files, data } = await buildSite(args);
	const kb = (f) => `${Math.round(statSync(join(args.out, f)).size / 1024)} KB`;
	for (const [entry, file] of Object.entries(files)) console.log(`${entry.padEnd(30)} ${file}  ${kb(file)}`);
	console.log(`data/: ${Object.keys(data).length} entries under assets/data/<hash>/`);
	console.log(`built ${args.out} in ${Math.round(performance.now() - t0)} ms`);
}
