import { logger } from "./logger.server";

const inFlight = new Map();

/**
 * Runs work after the HTTP response has been sent, so Shopify gets its 2xx
 * promptly. In-process only: work lost to a crash is picked up by
 * resumeInFlightWork() on the next boot (see recovery.server.js).
 *
 * The same `key` is never run twice concurrently in this process; the DB
 * state machine guards against duplicates across processes.
 */
export function enqueue(key, fn) {
  if (inFlight.has(key)) {
    logger.debug({ event: "job.deduplicated", key }, "job already running");
    return inFlight.get(key);
  }

  const job = new Promise((resolve) => setImmediate(resolve))
    .then(fn)
    .catch((err) => logger.error({ event: "job.failed", key, err }, "background job failed"))
    .finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** Test helper: resolves once every queued job (including ones they enqueue) has settled. */
export async function drainJobs() {
  while (inFlight.size) await Promise.all([...inFlight.values()]);
}
