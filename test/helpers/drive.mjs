/* global process */
// Headless browser driver for the tier-2 (GL) regression run.
//
// Owns its own throwaway HTTP server on a random free port so it can run while
// the shared dev server is busy, and its own Chrome profile. Only the processes
// it spawned are ever killed.
//
// Chrome flags matter: `--use-gl=swiftshader` silently drops WebGL2 and the page
// falls back to a CPU renderer, which is NOT what we are testing. The working
// combination is ANGLE over SwiftShader.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function freePort() {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.on('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

/** Starts tools/dev_server.py on a free port; returns {port, stop}. */
export async function startServer() {
	const port = await freePort();
	const proc = spawn('python3', [`${REPO}/tools/dev_server.py`, String(port)],
		{ stdio: ['ignore', 'ignore', 'ignore'] });
	for (let i = 0; i < 100; i++) {
		await sleep(100);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/index.html`, { method: 'HEAD' });
			if (r.ok) break;
		} catch { /* not up yet */ }
	}
	return { port, stop: () => { if (proc.pid) proc.kill('SIGTERM'); } };
}

/**
 * Launches headless Chrome, opens telescope for one seed, and waits until the
 * world has generated. Returns an `evalIn` that runs an expression in the page.
 */
export async function drive({ port, seed = 786433191, ng = 0, settleMs = 8000, quiet = true } = {}) {
	const profile = `/tmp/telescope-regr-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0',
		`--user-data-dir=${profile}`, '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader',
		'--enable-unsafe-swiftshader', '--window-size=1280,800', 'about:blank'],
	{ stdio: ['ignore', 'ignore', 'pipe'] });
	const wsUrl = await new Promise((resolve, reject) => {
		let buf = '';
		chrome.stderr.on('data', (d) => {
			buf += d;
			const m = /ws:\/\/[^\s]+/.exec(buf);
			if (m) resolve(m[0]);
		});
		setTimeout(() => reject(new Error('chrome did not report a devtools endpoint')), 20000);
	});
	const ws = new WebSocket(wsUrl);
	await new Promise((r) => ws.addEventListener('open', r));
	let nextId = 1;
	const pending = new Map();
	const errors = [];
	ws.addEventListener('message', (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const p = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
		}
		if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params).slice(0, 400));
	});
	const send = (m, p = {}, s) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
	});
	const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
	const evalIn = async (expr) => {
		const r = await send('Runtime.evaluate',
			{ expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
		return r.result.value;
	};
	await send('Runtime.enable', {}, sessionId);
	await send('Page.enable', {}, sessionId);
	await send('Page.navigate',
		{ url: `http://127.0.0.1:${port}/index.html?seed=${seed}&ng=${ng}` }, sessionId);
	let ready = false;
	for (let i = 0; i < 90 && !ready; i++) {
		await sleep(2000);
		ready = await evalIn(`(async () => { try { const m = await import('/js/app.js');
			return !!(m.app.pixelScenesByPW && m.app.pixelScenesByPW['0,0'] && m.app.tileLayers.length);
		} catch (e) { return false; } })()`).catch(() => false);
		if (!quiet && !ready) process.stderr.write('.');
	}
	if (!ready) throw new Error('telescope did not finish generating');
	await sleep(settleMs);
	return { evalIn, errors, close: () => { chrome.kill(); } };
}

export { sleep };
