/* global process */
// Site build check: the deployed build (tools/build_site.mjs) in a real browser.
//
// Builds the site, serves it the way _headers deploys it (assets/ cached
// forever, everything else revalidated) and visits it twice in headless
// Chrome: a first visit with empty caches, then a return visit. It fails when
//
//   - the page reports an error, or its load does not finish;
//   - anything is fetched from js/ or data/: a worker started, or a file
//     fetched, without js/asset_url.js, which the build can then neither bundle
//     nor serve to be cached;
//   - the return visit asks the server for more than the page itself.
//
// With --compare it visits the checkout the same way and prints both, which is
// what the build buys: requests, bytes and load time, first visit and return.
//
//   node test/site_build_check.mjs [--compare] [--latency-ms=N] [--angle=vulkan|swiftshader] [--seed=N]
//
// --latency-ms makes every request cost a round trip (tools/dev_server.py).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../tools/build_site.mjs';
import { openPage, sleep, startServer } from './helpers/drive.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const arg = (name, fallback) => {
	const a = process.argv.find(v => v.startsWith(`--${name}=`));
	return a ? a.slice(name.length + 3) : fallback;
};
const compare = process.argv.includes('--compare');
const latencyMs = Number(arg('latency-ms', 0));
const angle = arg('angle', 'vulkan');
const seed = arg('seed', '786433191');
// What a visit may ask for outside assets/.
const PAGE_PATHS = new Set(['/', '/index.html', '/favicon.ico']);

/** One visit: the load's record, what the server was asked for, what the page complained of. */
async function visit(server, profile) {
	await server.stats(true);
	const d = await openPage({ port: server.port, path: `/index.html?seed=${seed}&ng=0`, angle, width: 1920, height: 1080, profile });
	try {
		let load = null;
		for (let i = 0; i < 600 && !load; i++) {
			await sleep(100);
			load = await d.evalIn(`window.frameSlo?.lastLoad('page load') ?? null`).catch(() => null);
		}
		await sleep(500);   // what the page fetches just after it settles
		const stats = await server.stats();
		return { load, stats, errors: d.errors, logs: d.logs.filter(l => l.startsWith('error')) };
	} finally {
		// The way a user leaves, so the caches are on disk for the return visit.
		await d.quit();
	}
}

async function twoVisits(root) {
	const server = await startServer({ root, latencyMs });
	const profile = mkdtempSync(join(tmpdir(), 'telescope-site-'));
	try {
		const first = await visit(server, profile);
		const again = await visit(server, profile);
		return { first, again };
	} finally {
		server.stop();
		rmSync(profile, { recursive: true, force: true });
	}
}

const line = (label, v) => `${label.padEnd(22)} ${String(v.load?.ms ?? '--').padStart(5)} ms  ${String(v.stats.requests).padStart(5)} requests`
	+ `  (${v.stats.notModified} revalidated)  ${(v.stats.bytes / 1048576).toFixed(1)} MB`;

const out = mkdtempSync(join(tmpdir(), 'telescope-build-'));
const failures = [];
try {
	await buildSite({ src: REPO, out });
	const built = await twoVisits(out);
	for (const [name, v] of Object.entries(built)) {
		if (!v.load) failures.push(`${name} visit: the page load did not finish`);
		for (const e of [...v.errors, ...v.logs]) failures.push(`${name} visit: ${e}`);
		const stray = Object.keys(v.stats.paths).filter(p => !p.startsWith('/assets/') && !PAGE_PATHS.has(p));
		if (stray.length) failures.push(`${name} visit fetched ${stray.length} files outside assets/: ${stray.slice(0, 12).join(' ')}`);
	}
	const asked = Object.keys(built.again.stats.paths).filter(p => !PAGE_PATHS.has(p));
	if (asked.length) failures.push(`the return visit asked the server for ${asked.length} cached files: ${asked.slice(0, 12).join(' ')}`);

	console.log(`seed ${seed}, ${angle}, ${latencyMs} ms per request`);
	console.log(line('build, first visit', built.first));
	console.log(line('build, return visit', built.again));
	if (compare) {
		const checkout = await twoVisits(REPO);
		console.log(line('checkout, first visit', checkout.first));
		console.log(line('checkout, return', checkout.again));
	}
} finally {
	rmSync(out, { recursive: true, force: true });
}
if (failures.length) {
	console.log(`\nFAILED:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log('\nok: the build loads, from assets/ only, and a return visit fetches only the page');
