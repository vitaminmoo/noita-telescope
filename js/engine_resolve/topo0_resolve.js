// Bit-exact port of Noita's TOPOLOGY-0 (BIOME_PROCEDURAL) per-pixel terrain
// resolve -- the branch of WorldSave_ResolveCellMaterialAtPixel @0x0087d0e0 that
// handles biomes whose <Topology type> is absent/BIOME_PROCEDURAL, plus the
// wang-type biomes with wang_template_file="" that the engine demotes to
// topology 0 at runtime (docs/worldgen/covergrid_population.md).
//
//   mat = SelectComponentForCell(biome_data, (int)x, (int)y,
//             CellNoise_EvaluateCaveAndMaterial(grid, x+0.5, y+0.5, chunk))
//
// Chain (addresses are noita.exe VAs, image base 0x00400000):
//   CellNoise_EvaluateCaveAndMaterial @0x0087e110
//     -> modifier      : FloatGrid2D_SampleBilinearSmooth of BitmapCaves grid @Biome+0x1d4
//     -> depthRatio    : CellNoise_EvaluateCaveBoundary  @0x0087e8d0
//                          -> BiomeChunk_EvalSurfaceLine @0x0087eaf0
//     -> carve         : noise_type switch (chunk+0x220); both shipped cases are
//                        ported in carve_noise.js -- 0 = IQ2_SIMPLEX1234
//                        (carveDensity), 3 = SIN_CAPPED_SIMPLEX
//                        (carveDensityType3, 37 biomes incl. every overworld one)
//     -> matNoise      : CellNoise_DispatchMaterialNoise @0x0087e7a0
//                          -> ProceduralNoise_FBM4Octave2D @0x00873cc0 (type 5 simplex)
//   -> BiomeMaterials_SelectComponentForCell @0x0086d2a0 (band_select.js)
//
// Every float32 op follows the binary's instruction order (Math.fround).
//
// LIVE-ANCHORED 2026-08-14 against seed 786433191 (CELLPROBE r/mn/n + PEEK of the
// BiomeChunk param block at +0x218..+0x2a8 for solid_wall / temple_wall /
// watercave / coalmine_alt).
import { ComputeMagicValueFromDoubles } from './simplex_noise.js';
import { getModifierGrid, sampleModifier } from './bitmap_caves.js';
import { carveDensity, carveDensityType3 } from './carve_noise.js';
import { selectComponentForCell } from './band_select.js';

const F = Math.fround;

const _b = new ArrayBuffer(4), _dv = new DataView(_b);
function flt(u) { _dv.setUint32(0, u); return _dv.getFloat32(0); }

export const K0 = {
	SURFACE_BLEND_Y: 380.0,       // _DAT_01053bd0 (double) -- above this the 42px
	                              // left-neighbour surface-line blend applies
	BLEND_DENOM: flt(0x42240000), // _DAT_01053df4 = 41.0f
	MAT_GATE: flt(0x3f028f5c),    // rdata_doubleTable_01053620[2]._4_4_ = 0.51f
	CARVE_GATE: flt(0x3f59999a),  // DAT_01053714 = 0.85f
	HALF_F: flt(0x3f000000),
	TWO_F: flt(0x40000000),
	ONE_F: flt(0x3f800000),
	MOD_FREQ: 0.49162514,         // _DAT_01053958 (double) modifier-grid sample freq
	MOD_YOFF: 6.86e-7,            // _DAT_01053590 (double)
	MOD_SCALE: flt(0x3dcccccd),   // DAT_010534fc = 0.1f
	MOD_BLEND: flt(0x3efd70a4),   // _DAT_01053618 = 0.495f
	MAT_FREQ: 0.05243442,         // DAT_01053858 (double) inside-noise base frequency
	MAT_BIAS: 0.1,                // DAT_01053898 (double)
	SEED_MUL_X: 1.312e-05,        // 0x010535f0, mInsidePerlinOffsetBySeed only
	SEED_MUL_Y: 2.331e-05,        // 0x01053608
};

// ---------------------------------------------------------------------------
// Per-seed surface-noise X phase (BiomeGrid+0x48), replayed from
// ProceduralTerrain_Init @0x0087a900: MINSTD_SeedAndStep halves the seed once if
// it is >= 2147483646, then three Park-Miller steps (ctor + 2 draws); the third
// state maps to [-100000, 100000).  Seed 1 -> 51121.0625 (live-verified).
// ---------------------------------------------------------------------------
function minstdNext(s) {
	// 16807*s - 2147483647*floor(s/127773), wrapped positive (NollaPrng.Next)
	const v = BigInt(Math.floor(s));
	let r = 16807n * v - 2147483647n * (v / 127773n);
	if (r <= 0n) r += 2147483647n;
	return Number(r);
}
const _phaseCache = new Map();
export function surfaceNoisePhase(worldSeed) {
	if (_phaseCache.has(worldSeed)) return _phaseCache.get(worldSeed);
	let s = worldSeed;
	if (s >= 2147483646.0) s = s * 0.5;
	s = minstdNext(s); // NollaPrng ctor
	s = minstdNext(s); // draw 1: BiomeGrid+0x30
	s = minstdNext(s); // draw 2: BiomeGrid+0x48 = the phase
	// The draw is a float32 unit value that is then scaled in float32 and only
	// the final subtraction happens in double (BiomeGrid+0x48 is a double).
	// Live PEEK of grid+0x48 for seed 786433191 reads exactly 34084.625;
	// evaluating the chain in double gives 34084.62097868 and rounding the whole
	// result to float32 gives 34084.62109375 -- both wrong, and a ~0.004px
	// surface-line shift is worth ~1e-6 of depth ratio, which the carve blend
	// amplifies ~6x into the band input.
	const phase = F(F(s * Math.pow(2, -31)) * 200000.0) - 100000.0;
	_phaseCache.set(worldSeed, phase);
	return phase;
}

// ---------------------------------------------------------------------------
// BiomeChunk_EvalSurfaceLine @0x0087eaf0 -> [topY, botY] (doubles).
//   sampleX = phase + worldX
//   edge 0 : flat
//   edge 1 : topY = startY + Simplex(freq*sampleX, startY*freq) * lowNoise
//            botY = endY   + Simplex(freq*sampleX, endY*freq)   * highNoise
//   edge 2 : topY uses the 4-octave FBM instead of the plain simplex
//   edge 3 : both shifted by (worldX - slopeStartX) * slopeDelta  (raw absolute X)
// startY/endY are floats widened to double; the noise runs in double.
// ---------------------------------------------------------------------------
export function surfaceLine(cfg, phase, wx) {
	const topBase = cfg.startY, botBase = cfg.endY; // already float32 values
	if (cfg.edge === 0) return [topBase, botBase];
	if (cfg.edge === 3) {
		const d = (wx - cfg.slopeStartX) * cfg.slopeDelta;
		return [topBase + d, botBase + d];
	}
	const sx = cfg.freq * (phase + wx);
	if (cfg.edge === 2) throw new Error('topo0: mGradientAddNoise=2 (FBM top) not ported');
	const topY = ComputeMagicValueFromDoubles(sx, topBase * cfg.freq) * cfg.low + topBase;
	const botY = ComputeMagicValueFromDoubles(sx, botBase * cfg.freq) * cfg.high + botBase;
	return [topY, botY];
}

// ---------------------------------------------------------------------------
// CellNoise_EvaluateCaveBoundary @0x0087e8d0 -> float depth ratio.
//   wy <= topY -> 0 ; wy >= botY -> 1 ; else float((wy-topY)/(botY-topY))
// For wy > 380 the pixel's own chunk line is used unblended (the only case that
// can occur below the overworld).  At/above 380 the engine re-resolves the cell
// and, inside the first 42px of the cell, blends with the LEFT neighbour's line
// (factor 1 - subX/41); `leftCfg` supplies that neighbour when the caller has it.
// ---------------------------------------------------------------------------
export function caveDepthRatio(cfg, phase, wx, wy, leftCfg, subX) {
	let [topY, botY] = surfaceLine(cfg, phase, wx);
	if (wy <= K0.SURFACE_BLEND_Y && leftCfg && subX < 42) {
		const [lTop, lBot] = surfaceLine(leftCfg, phase, wx);
		const f = F(K0.ONE_F - F(subX / K0.BLEND_DENOM));
		topY = (lTop - topY) * f + topY;
		botY = (lBot - botY) * f + botY;
	}
	if (wy <= topY) return 0;
	if (botY <= wy) return K0.ONE_F;
	if (botY === topY) return K0.ONE_F;
	return F((wy - topY) / (botY - topY));
}

// ---------------------------------------------------------------------------
// ProceduralNoise_FBM4Octave2D @0x00873cc0 over EdgeNoise_Simplex2D (type 5).
// Identical to js/surface_terrain.js::fbmSimplex2D (live-validated there).
// ---------------------------------------------------------------------------
const FBM_M0 = F(0.84147);            // 0x3F576A94
const FBM_M1 = F(0.5403);             // 0x3F0A511A
const FBM_L = [F(2.02), F(2.33), F(2.01)];
function fbm4Simplex2D(x, y) {
	const S = (a, b) => F(ComputeMagicValueFromDoubles(a, b));
	let acc = F(S(x, y) * 0.5);
	const u = F(F(F(FBM_M0 * x) + F(FBM_M1 * y)) * FBM_L[0]);
	const v = F(F(F(FBM_M1 * x) + F(-FBM_M0 * y)) * FBM_L[0]);
	acc = F(acc + F(S(u, v) * 0.25));
	const u2 = F(F(F(FBM_M0 * u) + F(FBM_M1 * v)) * FBM_L[1]);
	const v2 = F(F(F(FBM_M1 * u) + F(-FBM_M0 * v)) * FBM_L[1]);
	acc = F(acc + F(S(u2, v2) * 0.125));
	const u3 = F(F(F(FBM_M0 * u2) + F(FBM_M1 * v2)) * FBM_L[2]);
	const v3 = F(F(F(FBM_M1 * u2) + F(-FBM_M0 * v2)) * FBM_L[2]);
	acc = F(acc + F(S(u3, v3) * 0.0625));
	return F(acc / 0.9375);
}

// ---------------------------------------------------------------------------
// CellNoise_DispatchMaterialNoise @0x0087e7a0 -> float ("matNoise").
// ---------------------------------------------------------------------------
export function materialNoise(cfg, wx, wy, worldSeed = 0) {
	let sx = wx * K0.MAT_FREQ * cfg.insideScaleX + K0.MAT_BIAS + cfg.insideOffX;
	let sy = wy * K0.MAT_FREQ * cfg.insideScaleY + K0.MAT_BIAS + cfg.insideOffY;
	if (cfg.insideOffsetBySeed) {
		sx += (worldSeed | 0) * K0.SEED_MUL_X;
		sy += (worldSeed | 0) * K0.SEED_MUL_Y;
	}
	const fx = F(sx), fy = F(sy);
	let n;
	if (cfg.insideFBM) {
		if (cfg.insideNoiseType !== 5)
			throw new Error(`topo0: FBM over noise type ${cfg.insideNoiseType} not ported`);
		n = fbm4Simplex2D(fx, fy);
	} else {
		if (cfg.insideNoiseType !== 5)
			throw new Error(`topo0: noise type ${cfg.insideNoiseType} not ported`);
		n = F(ComputeMagicValueFromDoubles(fx, fy));
	}
	if (cfg.insideSquared) n = F(n * n);
	if (cfg.insideClamped) {
		if (n < cfg.insideScaleMin) n = cfg.insideScaleMin;
		if (n > cfg.insideScaleMax) n = cfg.insideScaleMax;
	}
	if (cfg.insideScaled)
		n = F(F(F(cfg.insideScaleMax - cfg.insideScaleMin) * F(F(n * K0.HALF_F) + K0.HALF_F)) +
			cfg.insideScaleMin);
	return n;
}

// ---------------------------------------------------------------------------
// The BitmapCaves density modifier (step 1 of EvaluateCaveAndMaterial).
//
// cfg.modifier describes what Biome+0x1d4 points at:
//   { kind: 'const', value }  a 1x1 (or uniform) grid -- the shipped default
//                             bundle @0x012085a8 holds a single 1.0f, so every
//                             procedural biome without a <BitmapCaves> block
//                             gets modifier == 1.0 exactly (live-PEEKed).
//   { kind: 'empty' }         an allocated-but-never-generated bundle (w=h=0):
//                             the sampler returns 0 and only the simplex blend
//                             survives -> the "lake mask" (<=0 means AIR).
//   { kind: 'none' }          Biome+0x1d4 == NULL: the whole step is skipped.
//   { kind: 'grid', gridKey } a real 512x256 <BitmapCaves> grid, replayed by
//                             bitmap_caves.js (per biome NAME per world seed).
//                             Sample + blend live in sampleModifier; a key
//                             without ported params falls back to 1.0 exactly
//                             like today's approximation.
// Returns null when the pixel early-outs to air (modifier <= 0).
// ---------------------------------------------------------------------------
export function densityModifier(cfg, wx, wy, gridOffsetX = 0, worldSeed = 0) {
	const mod = cfg.modifier;
	if (!mod || mod.kind === 'none') return K0.ONE_F;
	let m;
	if (mod.kind === 'grid') {
		const g = getModifierGrid(worldSeed, mod.gridKey);
		if (!g) return K0.ONE_F;
		m = sampleModifier(g, wx, wy);
		return m > 0 ? m : null;
	} else if (mod.kind === 'const') {
		m = mod.value;
		if (!(m < K0.ONE_F)) return m > 0 ? m : null; // no blend, no coords needed
	} else if (mod.kind === 'empty') {
		m = 0;
	} else {
		throw new Error(`topo0: modifier kind ${mod.kind} not ported`);
	}
	const off = mod.offsetX !== undefined ? mod.offsetX : gridOffsetX;
	const gx = F((wx * K0.MOD_FREQ + off) * K0.MOD_SCALE);
	const gy = F((off * K0.MOD_YOFF + wy * K0.MOD_FREQ) * K0.MOD_SCALE);
	const s = F(ComputeMagicValueFromDoubles(gx, gy));
	m = F(m + F(F(s * F(K0.ONE_F - m)) * K0.MOD_BLEND));
	return m > 0 ? m : null;
}

// ---------------------------------------------------------------------------
// CellNoise_EvaluateCaveAndMaterial @0x0087e110 -> float (the band-selector
// input).  Returns null for the two early-outs (modifier <= 0, density <= 0),
// which the engine reports as 0.0 -> no band -> AIR for every shipped biome
// whose lowest material_min is > 0; biomes with a band spanning 0 (solid_wall's
// rock_hard_border starts at -0.25) DO paint at ret == 0, so the caller must
// treat null as "engine returned 0.0", not as "no material".
// ---------------------------------------------------------------------------
export function evaluateCaveAndMaterial(cfg, phase, wx, wy, opts = {}) {
	const m = densityModifier(cfg, wx, wy, 0, opts.worldSeed || 0);
	if (m === null) return 0;
	const r = caveDepthRatio(cfg, phase, wx, wy, opts.leftCfg, opts.subX);
	let density = F(r * m);
	if (density <= 0) return 0;

	// matNoise term uses the PRE-carve density for both the gate and the weight
	let matWeight = 0, mn = 0;
	if (K0.MAT_GATE < density && cfg.multPerlin !== 0) {
		matWeight = F(F(density - K0.HALF_F) * K0.TWO_F);
		mn = materialNoise(cfg, wx, wy, opts.worldSeed || 0);
	}

	let addValue = 0;
	if (density > K0.CARVE_GATE) {
		addValue = cfg.insideAddValue;
		if (cfg.noiseType === 0) density = carveDensity(wx, wy, density);
		else if (cfg.noiseType === 3) density = carveDensityType3(wx, wy, density);
		else throw new Error(`topo0: noise_type ${cfg.noiseType} carve branch not ported`);
	}

	if (cfg.depthBlend)
		throw new Error('topo0: chunk+0x24c depth-blended matNoise not ported');

	return F(F(F(F(cfg.multPerlin * matWeight) * mn) + F(cfg.multGradient * density)) + addValue);
}

// ---------------------------------------------------------------------------
// Full topology-0 resolve for one world pixel: returns the material id, or -1
// for AIR.  `biome` is the BIOME_ENGINE entry and `cfg` its topo0Config().
// The engine samples the noise at the pixel CENTRE (x+0.5, y+0.5) but hands the
// band chooser the truncated integer coordinates.
// ---------------------------------------------------------------------------
export function resolveTopo0Pixel(biome, cfg, phase, x, y, opts = {}) {
	// A biome with no MaterialComponents keeps the ctor's empty BiomeMaterials
	// (setMin=+FLT_MAX, setMax=-FLT_MAX -- live-PEEKed on temple_wall), so its
	// pre-gate can never pass: the topology-0 path paints NOTHING there.
	if (!biome || biome.bands.length === 0) return -1;
	// Nor does a BIOME_WANG_TILE biome with an empty wang_template_file. It never
	// gets a wang region -- ProceduralTerrain_Init @0x0087a900 builds one only for
	// `Biome+0x04 == 2 && wang_template_file.size() != 0` -- so the generator writes
	// nothing and the chunk is whatever its biome lua's LoadPixelScene stamps.
	// gen_topo0.py demotes the class to topology 0 so there is *a* density to
	// evaluate, and evaluateCaveAndMaterial below still answers it for callers that
	// want the number, but the game never paints it. Live on seed 786433191:
	// roadblock's chunk MAPDUMPs 0/262144 filled where this density says 100% solid
	// (its scene, data/biome_impl/roadblock.png, is fully transparent), while
	// watercave's chunk is solid only because watercave.lua stamps
	// watercave_layout_N.png over it -- same class, difference entirely in the scene.
	if (biome.paintsNothing) return -1;
	const ret = evaluateCaveAndMaterial(cfg, phase, x + 0.5, y + 0.5, opts);
	return selectComponentForCell(biome, x, y, ret, opts.worldSeed || 0);
}

// ---------------------------------------------------------------------------
// The generated BIOME_ENGINE tables carry the topology-0 parameters flattened
// (engine_data.js `t0`), and only for biomes whose `supported` flag is set —
// which is exactly the subset this port covers: inside-noise type 5, no
// depth-blended material noise, no seed-offset inside noise, and a density
// modifier that is a constant, an empty bundle or absent. Widen those checks
// here if `supported` ever widens.
// ---------------------------------------------------------------------------
const _cfgCache = new WeakMap();
export function topo0Config(engineBiome) {
	if (!engineBiome) return null;
	let cfg = _cfgCache.get(engineBiome);
	if (cfg) return cfg;
	const t = engineBiome.t0;
	cfg = {
		...t,
		insideNoiseType: 5,
		insideOffsetBySeed: false,
		depthBlend: false,
		modifier: { kind: t.modKind, value: t.modValue, gridKey: t.gridKey ?? null },
	};
	_cfgCache.set(engineBiome, cfg);
	return cfg;
}
