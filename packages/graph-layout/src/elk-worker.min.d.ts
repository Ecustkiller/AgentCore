/** Minimal typings for elkjs fake-Worker entry (main-thread fallback only). */
declare module "elkjs/lib/elk-worker.min.js" {
  export class Worker {
    constructor(url?: string);
    postMessage(message: unknown): void;
    terminate(): void;
    onmessage: ((ev: MessageEvent) => void) | null;
  }
}
