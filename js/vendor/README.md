# Vendored libraries

Copies of the two libraries the page used to import from jsDelivr at run time.
A failed CDN fetch stopped the page loading at all; from here they are served,
cached and deployed with everything else.

| File | Package | Licence | Source |
|---|---|---|---|
| `upng.js` | upng-js 2.1.0 | MIT | https://cdn.jsdelivr.net/npm/upng-js@2.1.0/+esm |
| `pako.js` | pako 1.0.6 (upng's inflate) | MIT | https://cdn.jsdelivr.net/npm/pako@1.0.6/+esm |
| `zip.js` | @zip.js/zip.js 2.8.61 | BSD-3-Clause | https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8/index.min.js |

The files are jsDelivr's ESM builds as served, with two edits: `upng.js`
imports `./pako.js` instead of jsDelivr's `/npm/pako@1.0.6/+esm`, and the
source-map comments are removed. Node keeps using the npm packages
(`js/png_sanitizer.js`).
