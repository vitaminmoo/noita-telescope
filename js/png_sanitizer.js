import { loadPackedImage } from "./asset_pack.js";
import { fetchAsset } from "./asset_url.js";

// Detect Node so the rest of this file can pick the npm package instead of the
// browser build. `process` is injected by Node; browsers leave it undefined.
const IS_NODE = typeof process !== 'undefined' && !!process?.versions?.node;

// Lazy, and the browser's copy is vendored (js/vendor/README.md): it used to
// come from a CDN at run time, and the page did not load when that fetch failed.
let _upngPromise = null;
const loadUpng = () => _upngPromise ??= (
    IS_NODE
        ? import("upng-js").then(m => m.default || m)
        : import("./vendor/upng.js").then(m => m.default)
);

// A PNG's bytes, by its URL (relative to this module). The images the app
// reads are in the asset packs (js/asset_pack.js), already decoded; this is
// for one that is not, or a browser that cannot read the packs.
async function fetchPng(url) {
    const response = await fetchAsset(new URL(url, import.meta.url));
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.arrayBuffer();
}

/**
 * sanitizes a PNG buffer by removing ancillary chunks (gAMA, iCCP, sRGB, etc.)
 * that cause browsers to alter pixel values.
 * Returns a Blob to the cleaned image.
 */
export async function sanitizePng(url) {
    const buffer = await fetchPng(url);
    const view = new DataView(buffer);
    
    // PNG Signature: 89 50 4E 47 0D 0A 1A 0A
    if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
        console.warn("Not a valid PNG, skipping sanitization:", url);
        return url; // Return original if not PNG
    }

    const chunks = [];
    // Header is 8 bytes
    chunks.push(buffer.slice(0, 8));

    let offset = 8;
    while (offset < buffer.byteLength) {
        // Chunk Length (4 bytes)
        const length = view.getUint32(offset);
        // Chunk Type (4 bytes)
        const type = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7)
        );

        // Check if we keep this chunk
        // Critical chunks: IHDR, PLTE, IDAT, IEND, tRNS
        // Ancillary chunks to strip: gAMA, cHRM, iCCP, sRGB
        const isCritical = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type);
        
        if (isCritical) {
            // Copy Length(4) + Type(4) + Data(length) + CRC(4) = Length + 12
            chunks.push(buffer.slice(offset, offset + length + 12));
        } else {
            //console.log(`[PNG] Stripping chunk ${type} from ${url.split('/').pop()}`);
        }

        offset += length + 12;
    }

    return new Blob(chunks, { type: 'image/png' });
}

// Node's `fetch` can't read file:// URLs. Read the PNG straight off disk; the
// asset packs exist to spare the browser N requests and the decode, which
// isn't a Node concern.
async function readPngBufferNode(url) {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const fileUrl = new URL(url, import.meta.url);
    return (await fs.readFile(fileURLToPath(fileUrl))).buffer;
}

// Updated version using UPNG

export async function loadPNG(url, { bitmap: wantBitmap = true } = {}) {
    // An asset pack (js/asset_pack.js) has the pixels already decoded, the
    // same bytes the UPNG path below produces.
    if (!IS_NODE) {
        const packed = await loadPackedImage(url);
        if (packed) return { ...packed, bitmap: wantBitmap ? await pixelsToBitmap(packed) : null };
    }
    // TODO: Is this loading the library for every PNG?
    const UPNG = await loadUpng();
    let originalBuffer;
    if (IS_NODE) {
        originalBuffer = await readPngBufferNode(url);
    } else {
        originalBuffer = await fetchPng(url);
    }
    
    // 1. Sanitize the buffer (Remove gAMA, etc.)
    const sanitizedUint8 = stripAncillaryChunks(originalBuffer);

    try {
        // 2. Decode using UPNG (Requires Uint8Array or ArrayBuffer)
        const img = UPNG.decode(sanitizedUint8);
        
        // Convert to a simple RGBA8 array
        const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);

        // 3. Create a bitmap for fast canvas rendering. Node has no
        // `createImageBitmap` and the headless dump scripts never touch
        // `.bitmap`, so skip it there.
        let bitmap = null;
        if (!IS_NODE && wantBitmap) {
            const blob = new Blob([sanitizedUint8], { type: 'image/png' });
            bitmap = await createImageBitmap(blob);
        }

        //console.log(`Loaded and sanitized PNG: ${url.split('/').pop()} (Dimensions: ${img.width}x${img.height})`);
        return {
            data: rgba,
            width: img.width,
            height: img.height,
            bitmap: bitmap
        };
    } catch (e) {
        // Debugging block: If it fails, let's see what the first 8 bytes actually are
        const header = Array.from(new Uint8Array(sanitizedUint8.buffer).slice(0, 8))
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.error(`UPNG Decode Failed. Header bytes: ${header}`);
        throw e;
    }
}

function stripAncillaryChunks(buffer) {
    const view = new DataView(buffer);
    const chunks = [];
    
    // PNG Signature (8 bytes)
    chunks.push(new Uint8Array(buffer.slice(0, 8)));

    let offset = 8;
    while (offset < buffer.byteLength) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7)
        );

        const isCritical = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type);
        
        if (isCritical) {
            // Grab the whole chunk: Length(4) + Type(4) + Data(length) + CRC(4)
            chunks.push(new Uint8Array(buffer.slice(offset, offset + length + 12)));
        }
        offset += length + 12;
    }

    // Combine all Uint8Arrays into one single Uint8Array
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let currentOffset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, currentOffset);
        currentOffset += chunk.length;
    }
    
    return combined;
}

// Straight (unpremultiplied) RGBA bytes as a bitmap: what decoding the PNG
// they came from gives.
function pixelsToBitmap({ data, width, height }) {
    return createImageBitmap(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height));
}

export async function loadPNGBitmap(url) {
    if (IS_NODE) return null;
    const packed = await loadPackedImage(url);
    if (packed) return pixelsToBitmap(packed);
    // Only the bitmap is wanted, so skip loadPNG's JS decode to RGBA.
    const sanitized = stripAncillaryChunks(await fetchPng(url));
    return createImageBitmap(new Blob([sanitized], { type: 'image/png' }));
}
