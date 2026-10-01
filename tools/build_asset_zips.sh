#!/bin/sh
# Rebuilds the asset zips js/zip_extraction.js reads, one per folder, from every
# PNG in it. A file missing from its folder's zip is fetched on its own, which
# is how the scene colors files (*_visual.png etc.) came to cost ~180 extra
# requests. Deflated even though PNGs already are: it still saves ~25% of the
# download, and zip.js inflates through the browser's native DecompressionStream.
#
# The app reads the PIXELS of the pixel scenes (and of the wang templates and
# base biome maps) from data/packs instead, already decoded; the zips are what
# it falls back to. When a PNG in one of those folders changes, rebuild the
# packs too: node tools/build_asset_packs.mjs (test/asset_packs.test.mjs fails
# until you do).
#
# Run: tools/build_asset_zips.sh [folder...]   (default: all of them)
set -eu
cd "$(dirname "$0")/../data"
[ $# -gt 0 ] || set -- pixel_scenes weather_gfx backgrounds
for dir in "$@"; do
	rm -f "$dir.zip"
	(cd "$dir" && find . -name '*.png' | sed 's|^\./||' | LC_ALL=C sort | zip -q -9 -X -D "../$dir.zip" -@)
	echo "$dir.zip: $(unzip -Z1 "$dir.zip" | wc -l) files, $(wc -c < "$dir.zip") bytes"
done
