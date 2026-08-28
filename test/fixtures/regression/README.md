# Pixel regression fixtures

Small world rects (32×32 … 128×128) where we know exactly what the game puts on
the screen, so that fixing one area and silently breaking another shows up as a
failing test instead of as something the user notices while mousing over the map.

Every bug this set was built from was found by hand. Each fixture pins one of
them, in one line: *what it guards*.

## The two tiers

| | what it runs | what it proves | cost |
|---|---|---|---|
| **Tier 1** | `node --test test/*.test.mjs` (`test/regression_pixels.test.mjs`) | the CPU engine-resolve chain (`js/engine_resolve/`, `js/gl/engine_resources.js`) still classifies these chunks the same way and still resolves the same materials the game has | ~4 s, pure Node, no browser |
| **Tier 2** | `test/gl_regression.mjs` | the **rendered pixels** — the full GL terrain + scene pipeline — still match the game's dump | ~2 min, headless Chrome |

Tier 1 is deliberately part of the default test run. Tier 2 is not: it needs a
browser, a server and a couple of minutes.

```sh
# tier 1
node --test test/*.test.mjs

# tier 2 (plain `node` makes headless Chrome SIGTRAP on this machine)
systemd-run --user --quiet --collect --pipe --wait --slice=claude-limit.slice \
  -p MemoryMax=10G --working-directory=$PWD /usr/bin/node test/gl_regression.mjs

# tier 2, one fixture, keeping the renders to look at
… /usr/bin/node test/gl_regression.mjs rockroom_bug_site --png=/tmp/regr
```

`test/gl_regression.mjs` starts its **own** dev server on a random free port and
kills only that process, so it runs fine while the shared dev server is busy.

## What a fixture is

Two committed files per fixture:

* `<name>.json` — the world rect, the one-line thing it guards, where the ground
  truth came from and when, and the per-tier comparison mode + threshold
  (together with the measurement that threshold was derived from).
* `<name>.bin` — the expected pixels:
  * `rgb8` — `w*h*3` bytes, the game's MAPDUMP colors for the rect;
  * `matpal16` — `w*h` uint16 LE indices into `expected.palette`, the game's
    MATDUMP **material names**. Names, not ids, so neither side's id numbering
    can silently reshuffle the fixture.

`sources.json` registers the dumps the fixtures were cut from, with the world
rect and capture date of each. The dumps themselves are **not** in the repo
(`scripts/` is gitignored, the surface ground truth lives under
`~/reverse/noita/groundtruth/`), and nothing at test time reads them — only
`tools/regression_capture.mjs add` / `recut` do.

### Comparison modes

* `exact` — must be 100 %. Used only where the guarded property is structural
  ("this whole chunk is air", "this whole rect is inside a chunk fill"), not
  where a measurement happened to land on 100 %.
* `agreement` — must be ≥ `threshold`, where `threshold = measured − 0.5`.
  **Never set a threshold you did not measure.** The fixture records `measured`,
  `measuredAt` and `measuredCommit` so it is obvious what state the number
  encodes.

Per-pixel checks over procedural (noise-driven) terrain stay on `agreement` even
when they measure 100 %: `Math.sin`/`Math.cos` are implementation-defined, so a
hair of float drift on another machine must not fail the run.

Some baselines are deliberately **low** (`templewall_basin_top` rgb is 40 %).
Those are honest records of a known gap, not passing grades — they stop the gap
getting *worse* and they make the number visible in the table. Re-baseline them
upward when the gap is fixed.

### What the rgb metric compares

Two classes of pixel are **excluded** from the tier-2 `rgb` comparison, both
because the ground truth cannot answer for them:

* **the game's air** — the dump paints an empty cell `#050505` (or the sky
  gradient above ground) while telescope paints its own nothing-here colour, so
  comparing them only measures the two conventions disagreeing;
* **scene art** — where a stamped scene's colours file (`<name>_visual.png`)
  overrides the cell colours. A MAPDUMP re-renders the *material grid* through
  materials_gfx and carries no scene art at all, so an art-covered pixel is the
  two images answering different questions. No renderer fix can close that, and
  an `rgb` metric over such a rect can never reach 100 %.

The art mask is the same bit-packed `artMask` the scene loader builds,
intersected with the scene's opaque pixels (art over a scene's own air paints
nothing) and read off the placed scenes in the live page, so it cannot drift
from what was drawn. A re-baseline records `comparedPixels` and, where any were
dropped, `artExcluded`, so the percentage says what it is a percentage *of*.

Three fixtures moved when this landed, and the two numbers it produced are the
argument for it:

* `templewall_basin_top` rgb 40 % → **99.9 %** over 5 397 fewer pixels. The
  40 % was never a renderer gap; it was the holy-mountain hall's art.
* `cube_chamber_scene` and `roadblock_west_neighbour` rgb 0 % → **`skip`**.
  Every terrain pixel in both rects is a colours file, so there is nothing for
  the metric to compare and the fixture now says that in a `note` instead of
  recording a 0 % that no fix could ever raise. Both keep their `airMask` check,
  which is what those rects actually guard.

### Tier-1 metrics

| metric | meaning |
|---|---|
| `materials` | engine-resolved material **name** vs the MATDUMP grid |
| `airMask` | does the engine paint where the game has terrain (engine-owned rects) |
| `fillMask` | does telescope's terrain — engine output **plus** the constant stand-in fill it hands to the legacy pipeline — cover the pixel. This is the Holy-Mountain check: the engine answering "air" for `temple_wall` once emptied the whole basin |
| `none` | this rect's content is stamped scene art, which tier 1 does not model; the fixture leans on its `chunkFlags` and on tier 2 |

Every fixture also pins `chunkFlags`: the biome of its chunk(s), the engine mode
(`topo0`/`topo2`/`fallback`), `paintsNothing`, `sceneOnly` and the stand-in
`fillLayerMaterial`. Most of the bugs this set was built from were a wrong
answer *there*, one chunk-classification flip upstream of any pixel.

`maxUnresolvedPct` guards coverage in one direction: the share of pixels the
engine model declines to resolve at all may not grow past its baseline.

## The fixture set

Run `node tools/regression_capture.mjs list` for the current list with rects and
guards. As of the initial set, 33 fixtures over 6 MAPDUMP colour rects, the
MATDUMP surface material grid and the batch-3 per-site MATDUMP rects, all seed
**786433191**, NG+0:

* **roadblock** (`roadblock_chunk_air`, `roadblock_chunk_bottom`,
  `roadblock_west_neighbour`) — the roadblock chunk (33,11) generates nothing
  and must stay air, and the mountain_tree chunk beside it keeps its own art.
* **rock_room** (`rockroom_scene_air`, `rockroom_bug_site`, `rockroom_west_solid`)
  — the room is scene art over air, never a chunk fill; the mouse-over bug site
  (−3595,3238) straddles the solid_wall/rock_room seam, so it also pins the
  wobble.
* **temple_wall** (`templewall_basin_fill`, `templewall_basin_top`) — the engine
  paints nothing in the Holy Mountain basin, so telescope's stand-in fill has to
  survive.
* **watercave** (`watercave_scene`, `watercave_solid_core`), **lavalake**
  (`lavalake_spliced`, `lavalake_open_air`) — stamped / spliced scene content
  over an air chunk.
* **excavationsite / cube chamber** (`cube_procedural`, `cube_carve`,
  `cube_chamber_carve`, `cube_chamber_scene`, `cube_chunk_seam`) — the
  topology-0 surface + carve resolve, the room the carve port was validated on,
  and a chunk seam where the 42px biome-edge wobble decides the answer.
* **rooms and structures, from the batch-3 MATDUMP rects**
  (`ominoustemple_slabs`, `watchtower_slabs`, `orbroom_ice`, `pyramid_chamber`,
  `surface_pond_shore`, `dragoncave_room_air`, `mountaintop_hall`) — material
  identity inside seven hand-built sites. `mountaintop_hall` is the interesting
  one: the engine gets 58 % of the mountain hall and none of its art, so tier 1
  mostly pins the chunk and the render carries the check — which it passes at
  100 % air-mask agreement.
* **surface materials** (`winter_maze_materials`, `winter_east_caves_materials`,
  `winter_surface_line_materials`, `hills_bands_materials`, `coal_bands_materials`,
  `snow_soil_edge_materials`, `desert_surface_materials`, `east_sandstone_materials`,
  `temple_pyramid_materials`) — MATDUMP material identity across nine spots of
  the surface band: the winter is_rare snow maze, east winter's steelfrost veins
  and cave mouths, the winter surface line itself (76 % air, so it pins the
  topology-0 surface height and not only the bands under it), hills bands, the
  coal band, the material fingers at a biome edge, the desert surface skin, the
  east sandstone bands, and the pyramid's structure materials.
* **parallel worlds** (`edr_bands_pw0_materials` / `edr_bands_pw2_materials`,
  `edr_texture_pw0_rgb` / `edr_texture_pw2_rgb`, `winter_surface_pw2_air`,
  `desert_surface_pw2_materials`) — content the engine evaluates FROM the
  absolute coordinate, dumped two parallel worlds east (x + 2·35840) beside its
  main-world twin: the solid_wall (EDR) coal/rock_hard band noise, the winter
  surface line (below the rect at pw2, so it is all air where pw0 has the snow
  line) and the desert surface line (higher at pw2). Only chunk *indices* fold on
  the world stride; noise, topo and texture math never do
  (`ChunkGrid_ResolveChunkAtPosition @0x0087d9a0`). A model that folds the pixel
  itself paints pw0 here and fails these — that is what commit 56961c9 did and
  7e791e6 undid. Each `_pw2` fixture has its pw0 twin in the set, so a failure
  says which frame broke. Ground truth: `groundtruth/pw_wrap/` (MATDUMP +
  MAPDUMP per rect, world verified live as ng0 70×48 before dumping).

### Sites still without usable ground truth (TODO)

No dump on disk covers these, so they are not in the set yet. Capture them with
the runbook below and add a fixture:

* temple decal rect (−512, 11776) — the rect `scripts/ref_resolver/check_material_field.mjs`
  defaults to; no MAPDUMP of it exists.
* tree scene rect (−1427, 436) — `wood_tree` undressed.
  (`roadblock_west_neighbour` covers the same class at a `mountain_tree` chunk.)
* essenceroom (9923, 4339) — undressed.
* coalmine control rect.
* `groundtruth/batch3/temple_*` landed without a `.json`, so its world rect is
  unknown and it is not registered. Ask whoever captured it, or re-dump.

Ground truth that exists but has no fixture yet, because the model scores 0 %
there and a 0 % threshold guards nothing — real open leads, not oversights:

* the lake ramp (`groundtruth/pw_wrap/lake_pw0_*`, rect (−13570,300,512,512)):
  the game is a flat water pool there (261754/262144 water) while telescope
  draws the authored mud-over-sand ramp. The ramp is real but inert in the
  shipped game — the lake biomes' BitmapCaves modifier grid is empty, so the
  density multiplies to 0 and the water band wins; see
  `~/reverse/noita/docs/systems/world_tree_and_spire.md` ("WHY the ramp is
  inert"). Telescope keeps the ramp on purpose (a mod un-masks it in game), so
  this dump is a record of the divergence, not a fixture.
* the surface pond's water body (`matdump/surface_pond` around (2944,192)):
  `water` vs the model's `sand_static`. The lake "settled water" band rule
  (`limit_min_y`) is ported for lakes but this pond is not following it.
* `matdump/mountaintop` below the hall (around (704,−704), (896,−576)): snow,
  rock and *gold* the engine model does not resolve at all.

## Adding a fixture from a dump that already exists

```sh
node tools/regression_capture.mjs sources          # what dumps are registered, and present
node tools/regression_capture.mjs add \
  --name rockroom_bug_site --source mapdump/rockroom --rect=-3595,3238,64,64 \
  --tier1 fillMask --guards "the rock_room air pocket at (-3595,3238) stays air"
node tools/regression_capture.mjs baseline rockroom_bug_site      # measure + write tier-1 threshold
… /usr/bin/node test/gl_regression.mjs rockroom_bug_site --rebaseline   # measure + write tier-2
```

`add` cuts the rect out of the registered dump, writes `<name>.bin`, and records
the engine's current classification of the chunk. Prefer several small rects to
one big one: a 64×64 that says *one* thing fails with a readable message.

To register a new dump, add an entry to `sources.json` with its `path`, world
`rect`, `seed`, `captured` date and a `note` saying how the rect is known.

## Capturing NEW ground truth for a rect

Ground truth means the game's own answer. Telescope's renders are **not** ground
truth. The two authoritative forms:

* **MAPDUMP** → `.ppm`, the rendered material colors of a world rect;
* **MATDUMP** → 16-bit `.pgm`, raw engine material ids (frozen physics), plus
  `matlist.txt` for id→name.

Full protocol: `~/reverse/noita/docs/runbooks/patching_and_sampling.md`. The
short version, for one rect at seed 786433191 NG+0:

1. Start `noitad` (`go run ./cmd/noitad` in `~/repos/noita-puppeteer/`, `:8088`).
   Only one worker at a time — workers share the Wine `%APPDATA%`.
2. `POST /workers {seed: 786433191, ng_count: 0, persistent_workdir: true,
   extra_env: ["NOITA_DEBUG=1"]}` → `{id, work_dir}`. A nonzero seed auto-starts
   the run; seed 0 cannot be forced.
3. Poll `STATUS` until it reports your seed with a non-null `grid=`.
4. `GODMODE`, then `PTELE <cx> <cy>` to the middle of the rect.
5. `MAPDUMP <x> <y> <w> <h> out.ppm` (camera-sweeps the chunks in first). For
   material identity use the MATDUMP command instead.
6. The file lands in `work_dir` on the host. Copy it somewhere durable, then
   register it in `sources.json` **with its rect** — an unlabelled dump is
   nearly worthless later (the `mapdump/lavalake` note is what recovering one
   costs).

`scripts/live_dump.py <seed> <ng> name=x,y,w,h …` (gitignored) already does
steps 2–6 for a list of rects.

Two cautions:

* Never use a dump taken while a `POKE` patch was live — that is a modified
  game. `scripts/probe_out/pw1.ppm` is one such dump and is deliberately not
  registered.
* Physics settles: sand and water move a few pixels between generation and the
  dump. Two independent MAPDUMP captures of the same rect
  (`scripts/bugfix/rockroom.ppm` vs `scripts/probe_out/rockroom.ppm`, 10 h and
  two workers apart) agree byte-for-byte on **99.960 %** of pixels. That is the
  measured game-side noise floor; do not set a threshold tighter than it on a
  rect with settling materials.

## Re-baselining

Thresholds encode the render at the commit named in each fixture
(`measuredCommit`). After an intentional improvement:

```sh
node tools/regression_capture.mjs baseline [names…] [--margin=0.5]   # tier 1
… /usr/bin/node test/gl_regression.mjs [names…] --rebaseline         # tier 2
```

Both rewrite `measured`, `measuredAt`, `measuredCommit` and `threshold` in place
(`exact` fixtures keep 100). Re-baselining is a deliberate act: it should appear
in a commit whose message says *why* the number moved. A threshold that goes
**down** without an explanation is a regression being blessed.

`recut <names…>` re-cuts the expected pixels from the registered dump — for when
a dump is recaptured, never to make a failing test pass.
