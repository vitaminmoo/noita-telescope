// world_worker.js
import { injectPixelSceneData, injectPixelSceneSpawnData } from './pixel_scene_generation.js';
import { getSpecialPoIs, scanSpawnFunctions } from './poi_scanner.js';
import { addStaticPixelScenes } from './static_spawns.js';
import { injectTranslations } from './translations.js';
import { updateSettings } from './settings.js';
import { injectUnlocksData } from './unlocks.js';

let worldState = null;
let workerBiomeData = null;
let workerTileSpawns = null;

self.onmessage = async function(e) {
    const data = e.data;

    if (data.cmd === 'SYNC_METADATA') {
        injectPixelSceneData(data.pixelSceneCache);
		injectPixelSceneSpawnData(data.pixelSceneSpawnDataCache);
        injectTranslations(data.translationsCache);
		injectUnlocksData(data.unlockedSpellsCache);
		workerBiomeData = data.biomeData;
        workerTileSpawns = data.tileSpawns;
    }
	else if (data.cmd === 'SYNC_SETTINGS') {
		updateSettings(data.settings);
		injectUnlocksData(data.unlockedSpellsCache);
		return; 
	}
	else if (data.cmd === 'GENERATE_PW') {
		worldState = data;
		// This handler is async, so a throw in the scan would otherwise become an
		// unhandled rejection in the worker: no error event on the page, and the
		// world simply never arrives. Answer every request, as the scene builds do.
		try {
			generatePWWorker();
		} catch (err) {
			console.error(`[world worker] scan of PW ${data.pw},${data.pwVertical} failed:`, err);
			self.postMessage({
				type: 'PW_FAILED', seed: data.seed, ngPlusCount: data.ngPlusCount, pw: data.pw, pwVertical: data.pwVertical,
				error: String(err?.stack ?? err),
			});
		}
	}
};

function generatePWWorker() {
	if (!worldState) return;

	const { seed, ngPlusCount, pw, pwVertical, skipCosmeticScenes, perks, isDaily, gameMode } = worldState;
	const t0 = performance.now();
	
	//self.postMessage({ type: 'STATUS', msg: `Searching PW ${pw >= 0 ? '+' : ''}${pw}, ${pwVertical}...` });

	const scanResults = scanSpawnFunctions(workerBiomeData, workerTileSpawns, seed, ngPlusCount, pw, pwVertical, skipCosmeticScenes, perks, gameMode);
	const specialPoIs = getSpecialPoIs(workerBiomeData, seed, ngPlusCount, pw, pwVertical, perks, gameMode);
	const staticSpawnResults = addStaticPixelScenes(seed, ngPlusCount, pw, pwVertical, workerBiomeData, skipCosmeticScenes, perks, isDaily, gameMode);
	
	specialPoIs.push(...staticSpawnResults.pois);
	const finalPixelScenes = scanResults.finalPixelScenes.concat(staticSpawnResults.pixelScenes);
	const generatedSpawns = scanResults.generatedSpawns.concat(specialPoIs);

	// Unsurprisingly, the pixel scenes take up way too much space to be sending them back and forth like this. It's like 68 MB per world
	/*
	console.log(`--- PW ${pw >= 0 ? '+' : ''}${pw}, ${pwVertical} Generated ---`);
    console.log(`PoIs Payload Size: ${getPayloadSize(generatedSpawns)}`);
    console.log(`Pixel Scenes Payload Size: ${getPayloadSize(finalPixelScenes)}`);
    console.log(`----------------------------------`);
	*/
	// Stripped out the images and let the overlay worker process them separately, this reduces the payload size to around 0.5 MB

	self.postMessage({
		type: 'PW_GENERATED',
		seed: seed,
		ngPlusCount: ngPlusCount,
		pw: pw,
		pwVertical: pwVertical,
		pois: generatedSpawns,
		pixelScenes: finalPixelScenes,
		bgSprites: scanResults.backgroundSprites,
		// This thread's time for the scan, without the clone back (world_scan_pool.js).
		ms: performance.now() - t0
	});
}

// A module worker's message port can start delivering before this module has
// finished evaluating (its imports await their data), and a message that lands
// before `onmessage` is assigned is dropped without a trace. A pool that posts
// to a worker it has only just created (scene_bitmap_pool.js,
// world_scan_pool.js) holds its messages until this arrives.
self.postMessage({ type: 'READY' });
