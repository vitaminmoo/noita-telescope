// Posting to a worker that may not have loaded yet.
//
// A module worker's message port can start delivering before its module has
// finished evaluating (its imports await their data), and a message that lands
// before the worker has assigned `onmessage` is dropped without a trace: the
// world worker then scans with no settings, the search never starts. Every
// worker here ends its module by posting { type: 'READY' }; this holds what
// the page posts until that has arrived.
//
// The pools (terrain_workers.js, overlay_worker_pool.js, world_scan_pool.js)
// keep their own queues; this is for a worker used on its own.

/**
 * Makes `worker.postMessage` wait for the worker's READY. The page's own
 * handlers see the READY message too, and have nothing to do for it.
 * @param {Worker} worker  just created
 * @returns {Worker} the same worker
 */
export function holdUntilReady(worker) {
	let ready = false;
	const held = [];
	const post = worker.postMessage.bind(worker);
	worker.postMessage = (message, transfer) => {
		if (ready) post(message, transfer);
		else held.push([message, transfer]);
	};
	worker.addEventListener('message', (e) => {
		if (ready || e.data?.type !== 'READY') return;
		ready = true;
		for (const [message, transfer] of held.splice(0)) post(message, transfer);
	});
	return worker;
}
