// Minimal Netpbm readers for the ground-truth dumps the game's hook writes.
//
//   P6 / .ppm  — MAPDUMP: 8-bit RGB, the rendered material colors of a world rect
//   P5 / .pgm  — MATDUMP: 16-bit big-endian, raw engine material ids of a rect
import { readFileSync } from 'node:fs';

const WS = new Set([32, 10, 13, 9]);

function header(buf, count) {
	let i = 0;
	const tok = [];
	while (tok.length < count) {
		while (WS.has(buf[i])) i++;
		if (buf[i] === 35) { while (buf[i] !== 10) i++; continue; } // '#' comment
		const s = i;
		while (!WS.has(buf[i])) i++;
		tok.push(buf.slice(s, i).toString());
	}
	return { tok, body: i + 1 };
}

/** 8-bit RGB PPM -> {w, h, data: Uint8Array (w*h*3)}. */
export function readPPM(path) {
	const b = readFileSync(path);
	const { tok, body } = header(b, 4);
	if (tok[0] !== 'P6') throw new Error(`${path}: not a P6 PPM (${tok[0]})`);
	const w = +tok[1], h = +tok[2];
	return { w, h, data: new Uint8Array(b.buffer, b.byteOffset + body, w * h * 3) };
}

/** 16-bit BE PGM -> {w, h, data: Uint16Array (w*h)}. */
export function readPGM16(path) {
	const b = readFileSync(path);
	const { tok, body } = header(b, 4);
	if (tok[0] !== 'P5') throw new Error(`${path}: not a P5 PGM (${tok[0]})`);
	if (+tok[3] < 256) throw new Error(`${path}: 8-bit PGM, expected 16-bit`);
	const w = +tok[1], h = +tok[2];
	const out = new Uint16Array(w * h);
	for (let i = 0; i < out.length; i++) out[i] = (b[body + 2 * i] << 8) | b[body + 2 * i + 1];
	return { w, h, data: out };
}

/**
 * "Is this MAPDUMP pixel empty?" — the hook paints an unfilled cell #050505
 * underground and the sky gradient above ground; below worldY 0 that gradient is
 * a dark brown (75,60,45 minus depth) that must NOT be read as air, so only the
 * literal sky blue and the near-black empty color count.
 */
export function isDumpAir(d, i) {
	return (d[i] <= 6 && d[i + 1] <= 6 && d[i + 2] <= 6)
		|| (d[i] === 0x87 && d[i + 1] === 0xce && d[i + 2] === 0xeb);
}

/** Same question for a telescope RGBA render: transparent or (near-)black. */
export function isRenderAir(d, i) {
	return d[i + 3] < 16 || (d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12);
}

/** id -> name table from a MATDUMP `matlist.txt`. */
export function readMatlist(path) {
	const names = new Map();
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const m = /^mat id=(\d+) name=(\S+)/.exec(line);
		if (m) names.set(+m[1], m[2]);
	}
	return names;
}
