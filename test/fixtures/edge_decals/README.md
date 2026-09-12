# Edge-decal fixtures

The EdgeGraphics decal band — the mottled sprite band the engine bakes into cell
colours along material borders (`js/edge_decals.js`) — pinned against the game's
own baked cell colours.

These are **not** the `test/fixtures/regression/` fixtures and do not share their
loader. Those score the engine-resolve chain against a MAPDUMP/MATDUMP; this set
scores the decal stamp against a **BAKEDUMP**, which is the only dump that
carries the band at all.

```sh
node --test test/edge_decals.test.mjs          # the check
node tools/edge_decal_capture.mjs check        # the numbers, writing nothing
node tools/edge_decal_capture.mjs baseline     # re-measure and WRITE thresholds
```

## Why a BAKEDUMP, and what "the game's decal mask" means

A decal is baked straight into the cell's colour, so:

* **MAPDUMP** re-renders the material grid through materials_gfx → carries **no**
  decals;
* **BAKEDUMP** reads the cells' baked `mColor` (`cell+0x30`) → carries **all** of
  them.

Both from the same worker, same rect. Inside a solid cell,

    baked[i] != map[i]   <=>   the engine stamped something visible here

which is the game's own decal mask with no modelling on our side. A fixture
therefore commits three planes: the BAKEDUMP rect, the MAPDUMP rect (the base
colour a decal composites over), and the MATDUMP material grid over the rect
**plus a 32px halo**, because a stamp can originate outside the rect and paint
into it.

## Two things the metric has to get right

**The stamp is fed the GAME's material grid, not telescope's.** The one rect in
this set sits in a `paintsNothing` / `sceneOnly` chunk (biome-map cell 36,13,
`mountain_hall`), where telescope's engine terrain correctly resolves air and the
content is a stamped scene. Scoring stamp-over-our-terrain would measure the
terrain model, not the decal pass. Feeding the game's own grid isolates the rule.

**"Our decal cell" means a VISIBLE one.** Roughly half the texels our stamp lands
carry the material's own base colour, so they change nothing — and the ground
truth cannot see them either (`baked == map` there). At the spawn-mountain rect
we stamp 338 texels of which **182 are base-coloured**; counting raw stamped
cells would claim 24.8 % coverage against the game's 12.4 % and read as a 2×
over-stamp that does not exist. The visible count is 156, i.e. 11.4 %.

## What is pinned, and what is deliberately low

| metric | meaning | mode |
|---|---|---|
| `densityGapPct` | \|game dressed % − ours dressed %\|, in percentage points | `max` |
| `exactRgbPct` | our composite over the game's base colour == the baked colour | `agreement` |
| `cellAgreementPct` | per cell: do we and the game agree whether it is dressed | `agreement` |
| `iouPct` | intersection-over-union of the two decal masks | `agreement` |

`densityGapPct` and `exactRgbPct` are the ones that say the pass still models the
right thing. **`iouPct` is honestly low (31 %) and cannot be fixed** — it is
recorded so that an improvement would be visible, not as a passing grade.

### Why placement cannot be reproduced

Both engine stampers roll a single free-running stream — a thread-local Lehmer
LCG at generation, the shared `g_damageRng` at runtime — so which cells get
dressed depends on chunk generation order, thread scheduling, and how many rolls
other systems consumed first. **Two loads of the same seed already differ from
each other.** `js/edge_decals.js` therefore rolls a position-seeded stream
instead, which reproduces the distribution but not the stream.

That this residual is irreducible was measured, not assumed: re-salting our
position hash and re-running leaves every statistic where it was —

| salt | ours | both (chance ≈ 19) | IoU | exact RGB |
|---|---|---|---|---|
| none (the real seed) | 156 | 77 | 31.0 % | 85.27 % |
| 1 | 171 | 87 | 34.4 % | 85.42 % |
| 12345 | 161 | 91 | 38.1 % | 86.23 % |
| 0xbeef | 148 | 87 | 37.8 % | 87.25 % |

against the game's 169 dressed cells. The real seed scores no better than an
arbitrary salt, so **none** of our agreement comes from reproducing the engine's
stream; all of it is the band geometry (chance overlap would be ~19 cells, we get
77–91). What is left is placement noise, and no fix to the stamp rule reaches it.

One consequence worth stating plainly: on this rect, stamping decals scores
**85.27 %** exact RGB where stamping nothing at all would score **87.62 %**. The
band is in the right places at the right density with the right palette, but each
individually misplaced stamp costs a pixel twice (once where we put it, once
where the game put it). That is the honest cost of a statistical reproduction of
a non-reproducible effect, and it is what these baselines record.

## The set

| fixture | rect | what it guards |
|---|---|---|
| `spawnmountain_decals` | 35×39 @ (573,−459) | the decal pass over spawn-mountain rock: density and palette, not placement |

Ground truth: `~/reverse/noita/groundtruth/edge_decals/` (not in the repo;
`capture.py` beside it), registered in `test/fixtures/regression/sources.json` as
`bakedump/spawnmountain` with its `map` and `mat` twins.

## Adding one

Capture a BAKEDUMP + MAPDUMP + MATDUMP of the same rect from the same worker
(see `~/reverse/noita/docs/runbooks/patching_and_sampling.md`; the `BAKEDUMP`
command is documented in `noita-puppeteer/inject/PROTOCOL.md`), register the
triple in `sources.json` as a `bakedump-ppm` entry with `map`/`mat`/`matlist`
fields, then:

```sh
node tools/edge_decal_capture.mjs add --name NAME --source bakedump/NAME \
  --rect x,y,w,h --guards "one line: what this fixture protects"
node tools/edge_decal_capture.mjs baseline NAME
```

Pick a rect the game actually dressed — `add` prints what share of its solid
pixels the game stamped, and a rect at 0 % guards nothing. Never set a threshold
you did not measure.
