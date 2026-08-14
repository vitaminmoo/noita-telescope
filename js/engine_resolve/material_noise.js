// BiomeMaterials_ComputeMaterialNoiseDensity @0x0087d010 and the two noise
// generators it calls, on the CPU.
//
// This is the step between "how solid is this cell" and "which material": the
// engine never hands raw coverage to the band chooser. It warps the cell's world
// position by a value-noise field and adds a simplex term whose weight grows with
// how far the coverage is from 0.5, so a uniformly solid region still comes out
// as veins of several materials rather than one. Skipping it is what made a
// pixel scene's white pixels resolve to one flat band answer.
//
// The GL terrain shader already runs this chain (gl/shaders.js engMatNoiseDensity
// / valueNoise2 / carveSimplex); this is its CPU twin, so the scene stamp and the
// terrain under it cannot disagree.
//
// Vendored from the validated reference ports in scripts/ref_resolver
// (resolver.js computeMaterialNoiseDensity, perlin_noise.js
// valueNoisePerlinPerm2D, carve_noise.js carveSimplex2D) so the app does not have
// to import out of scripts/. Every float32 op keeps the binary's instruction
// order; do not "simplify" the arithmetic.
// No imports allowed in this module.

const F = Math.fround;

// ---- exact constants, from their .rdata bit patterns -----------------------
const _dv = new DataView(new ArrayBuffer(8));
function dblFromHex(hi, lo) { _dv.setUint32(0, hi); _dv.setUint32(4, lo); return _dv.getFloat64(0); }
function fltFromHex(u) { _dv.setUint32(0, u); return _dv.getFloat32(0); }

const DENS_X = dblFromHex(0x3fa1eb85, 0x1eb851ec);   // 0x01053828 = 0.035
const DENS_Y = dblFromHex(0x3fb1eb85, 0x1eb851ec);   // 0x01053878 = 0.07
const DENS_WARP = fltFromHex(0x41780000);            // 0x01053d20 = 15.5f
const DENS_SCALE = fltFromHex(0x3d486834);           // 0x010534c4 = 0.048927501f
const DENS_K1 = fltFromHex(0x40ab3333);              // 0x01053c20 = 5.35f
const DENS_K2 = fltFromHex(0x3f733333);              // 0x0105373c = 0.95f
const HALF_F = fltFromHex(0x3f000000);               // 0x0105361c = 0.5f

// @0x00fdffe0 (256 bytes; the binary stores a byte-identical second copy at
// +256 so perm[perm[X]+Y] can index up to 510).
// @0x00fdffe0 (256 bytes; the binary stores a byte-identical second copy at
// +256 so perm[perm[X]+Y] can index up to 510).
const PERM = new Uint8Array([
	23, 125, 161, 52, 103, 117, 70, 37, 247, 101, 203, 169, 124, 126, 44, 123,
	152, 238, 145, 45, 171, 114, 253, 10, 192, 136, 4, 157, 249, 30, 35, 72,
	175, 63, 77, 90, 181, 16, 96, 111, 133, 104, 75, 162, 93, 56, 66, 240,
	8, 50, 84, 229, 49, 210, 173, 239, 141, 1, 87, 18, 2, 198, 143, 57,
	225, 160, 58, 217, 168, 206, 245, 204, 199, 6, 73, 60, 20, 230, 211, 233,
	94, 200, 88, 9, 74, 155, 33, 15, 219, 130, 226, 202, 83, 236, 42, 172,
	165, 218, 55, 222, 46, 107, 98, 154, 109, 67, 196, 178, 127, 158, 13, 243,
	65, 79, 166, 248, 25, 224, 115, 80, 68, 51, 184, 128, 232, 208, 151, 122,
	26, 212, 105, 43, 179, 213, 235, 148, 146, 89, 14, 195, 28, 78, 112, 76,
	250, 47, 24, 251, 140, 108, 186, 190, 228, 170, 183, 139, 39, 188, 244, 246,
	132, 48, 119, 144, 180, 138, 134, 193, 82, 182, 120, 121, 86, 220, 209, 3,
	91, 241, 149, 85, 205, 150, 113, 216, 31, 100, 41, 164, 177, 214, 153, 231,
	38, 71, 185, 174, 97, 201, 29, 95, 7, 92, 54, 254, 191, 118, 34, 221,
	131, 11, 163, 99, 234, 81, 227, 147, 156, 176, 17, 142, 69, 12, 110, 62,
	27, 255, 0, 194, 59, 116, 242, 252, 19, 21, 187, 53, 207, 129, 64, 135,
	61, 40, 167, 237, 102, 223, 106, 159, 197, 189, 215, 137, 36, 32, 22, 5,]);
const PERM512 = new Uint8Array(512);
PERM512.set(PERM, 0);
PERM512.set(PERM, 256);

// (ProceduralNoise_Perlin2D's gradient table @0x011d2960 is deliberately not
// vendored -- only its value-noise twin below is on this path.)

// Constants (bit patterns verified against .rdata)
const C6 = F(6);      // 0x01053c58 = 0x40c00000
const C15 = F(15);    // 0x01053d10 = 0x41700000
const C10 = F(10);    // 0x01053ccc = 0x41200000
const C255 = F(255);  // 0x01053ec4 = 0x437f0000
const C0_5 = F(0.5);  // 0x0105361c = 0x3f000000
const C2 = F(2);      // 0x010539f8 = 0x40000000

// fade(t) = ((t*6 - 15)*t + 10)*t*t*t, in the binary's exact MULSS/SUBSS order.
function fade5(t) {
	let a = F(t * C6);
	a = F(a - C15);
	a = F(a * t);
	a = F(a + C10);
	a = F(a * t);
	a = F(a * t);
	a = F(a * t);
	return a;
}

// The binary's lattice floor here is CVTTSS2SI + "DEC unless (float)i <= v",
// i.e. a TRUE floor (unlike the simplex skew floor).
function lfloor(v) {
	return Math.floor(v);
}

// ProceduralNoise_ValueNoisePerlinPerm2D @0x00872be0 (XMM0 = x, XMM1 = y)
export function valueNoisePerlinPerm2D(x, y) {
	x = F(x); y = F(y);
	const ix = lfloor(x), iy = lfloor(y);
	const fx = F(x - ix);
	const fy = F(y - iy);
	const X = ix & 0xff, Xp = (ix + 1) & 0xff;
	const Y = iy & 0xff, Yp = (iy + 1) & 0xff;
	const pX = PERM512[X], pX1 = PERM512[Xp];
	const v00 = F(PERM512[pX + Y] / C255);
	const v01 = F(PERM512[pX + Yp] / C255);
	const v10 = F(PERM512[pX1 + Y] / C255);
	const v11 = F(PERM512[pX1 + Yp] / C255);
	const fdY = fade5(fy);
	const A = F(F(F(v01 - v00) * fdY) + v00);
	const B = F(F(F(v11 - v10) * fdY) + v10);
	const fdX = fade5(fx);
	const r = F(F(F(B - A) * fdX) + A);
	return F(F(r - C0_5) * C2);
}
// Permutation table @0xfdf730 (classic Ken Perlin table, byte-verified against
// the binary; the second 256 bytes are a wrapped copy, so index up to 511).
const CARVE_PERM = new Uint8Array([
	151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
	140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
	247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
	57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
	74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
	60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
	65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
	200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
	52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
	207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
	119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
	129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
	218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
	81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
	184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
	222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
]);
const CARVE_PERM512 = new Uint8Array(512);
CARVE_PERM512.set(CARVE_PERM, 0);
CARVE_PERM512.set(CARVE_PERM, 256);

const F2 = F(0.3660253882408142); // @0x010535bc (sqrt3-1)/2
const G2 = F(0.21132487058639526); // @0x01053548 (3-sqrt3)/6
const G2x2 = F(0.4226497411727905); // @0x010535d4

// The binary's floor for the skew coords is trunc + DEC unless value > 0:
// it maps -2.0 -> -3 and 0.0 -> -1 (a bias real floor doesn't have). Keep it.
function skewFloor(v) {
	let i = Math.trunc(v);
	if (!(v > 0)) i -= 1;
	return i;
}

// ProceduralNoise_Simplex2D @0x00872d40: Gustavson 2D simplex, 8-gradient
// variant ((+-x or +-y) + (+-2 * the other)), corner cutoff t = 0.5 - x^2 - y^2,
// contribution (u+v)*t^4, sum * 40. Output roughly [-1, 1].
export function carveSimplex2D(x, y) {
	const s = F(F(x + y) * F2);
	const i = skewFloor(F(x + s));
	const j = skewFloor(F(s + y));
	const t = F(F(i + j) * G2);
	const x0 = F(x - F(F(i) - t));
	const y0 = F(y - F(F(j) - t));
	let i1, j1;
	if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
	const x1 = F(F(x0 - i1) + G2);
	const y1 = F(F(y0 - j1) + G2);
	const x2 = F(F(x0 - 1) + G2x2);
	const y2 = F(F(y0 - 1) + G2x2);
	const ii = i & 0xff, jj = j & 0xff;
	const corner = (cx, cy, g) => {
		const tt = F(F(F(0.5) - F(cx * cx)) - F(cy * cy));
		if (tt < 0) return 0;
		const t2 = F(tt * tt);
		let u = (g & 7) < 4 ? cx : cy;
		let v = (g & 7) < 4 ? cy : cx;
		if (g & 1) u = -u;
		v = F(v * ((g & 2) ? -2 : 2));
		return F(F(u + v) * F(t2 * t2));
	};
	const n0 = corner(x0, y0, CARVE_PERM512[CARVE_PERM512[jj] + ii] & 7);
	const n1 = corner(x1, y1, CARVE_PERM512[CARVE_PERM512[jj + j1] + ii + i1] & 7);
	const n2 = corner(x2, y2, CARVE_PERM512[CARVE_PERM512[jj + 1] + ii + 1] & 7);
	return F(F(F(n1 + n0) + n2) * 40);
}


/**
 * The density the band chooser is actually fed, for a cell whose coverage is
 * `coverage` (1.0 for a pixel scene's density pixels -- fully solid).
 */
export function computeMaterialNoiseDensity(x, y, coverage) {
	const cov = F(coverage);
	const n1 = valueNoisePerlinPerm2D(F(x * DENS_X), F(y * DENS_Y));
	const warp = F(n1 * DENS_WARP);
	const t = F(F(cov - HALF_F) * HALF_F);
	const sy = F(F(F(y) + warp) * DENS_SCALE);
	const sx = F(F(F(x) + warp) * DENS_SCALE);
	const n2 = carveSimplex2D(sx, sy);
	let m = F(t * t);
	m = F(m * DENS_K1);
	m = F(m * DENS_K2);
	const r = F(F(n2 * m) + cov);
	return HALF_F > r ? HALF_F : r;
}
