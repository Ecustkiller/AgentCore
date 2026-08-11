/**
 * ELK instance: prefer a real Web Worker (elk-api + elk-worker.min.js);
 * fall back to the in-process fake Worker when `Worker` is unavailable
 * (Node / vitest / promo precompute) or construction fails (CSP / sandbox).
 *
 * Do not import `elkjs/lib/elk.bundled` — its "worker" is a setTimeout(0)
 * shim that still runs GWT synchronously on the main thread.
 */
/// <reference path="./elk-worker.min.d.ts" />
import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ElkInstance } from "elkjs/lib/elk-api.js";

/** Relative so Vite/webpack emit the classic worker script as a same-origin asset. */
const ELK_WORKER_SCRIPT = new URL(
  "../node_modules/elkjs/lib/elk-worker.min.js",
  import.meta.url,
);

let elkInstance: ElkInstance | null = null;
let elkInit: Promise<ElkInstance> | null = null;

function tryCreateRealWorkerElk(): ElkInstance | null {
  if (typeof globalThis.Worker !== "function") return null;
  try {
    return new ELK({
      workerFactory: () => new globalThis.Worker(ELK_WORKER_SCRIPT),
    });
  } catch {
    return null;
  }
}

async function createMainThreadElk(): Promise<ElkInstance> {
  // Same fake Worker elk.bundled / main.js use — GWT on the calling thread.
  const { Worker: FakeWorker } = await import("elkjs/lib/elk-worker.min.js");
  return new ELK({
    workerFactory: (url?: string) =>
      new FakeWorker(url) as unknown as Worker,
  });
}

/** Lazily construct a shared ELK client (real Worker or main-thread fallback). */
export function getElk(): Promise<ElkInstance> {
  if (elkInstance) return Promise.resolve(elkInstance);
  if (!elkInit) {
    elkInit = (async () => {
      const real = tryCreateRealWorkerElk();
      const instance = real ?? (await createMainThreadElk());
      elkInstance = instance;
      return instance;
    })();
  }
  return elkInit;
}
