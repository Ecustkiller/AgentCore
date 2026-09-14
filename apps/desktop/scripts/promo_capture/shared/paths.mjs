/**
 * Repo-relative path helpers for promo capture.
 * No absolute machine paths — everything resolves from this file or CLI/env.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/desktop */
export const desktopDir = resolve(here, "../../..");
/** monorepo root */
export const root = resolve(desktopDir, "../..");
export const distWeb = resolve(desktopDir, "dist-web");

/**
 * @param {{ tape?: string, out?: string }} opts
 */
export function resolveCapturePaths(opts = {}) {
  const tape = opts.tape || process.env.PROMO_TAPE;
  if (!tape) {
    throw new Error("Missing --tape <id> (or env PROMO_TAPE)");
  }
  const outArg = opts.out || process.env.PROMO_OUT;
  const outRel = outArg || `apps/promo/assets/${tape}`;
  const outRoot = isAbsolute(outRel) ? resolve(outRel) : resolve(root, outRel);
  return {
    tape,
    outRel,
    outRoot,
    stillsDir: resolve(outRoot, "stills"),
    clipsDir: resolve(outRoot, "clips"),
    sequencesDir: resolve(outRoot, "sequences"),
    videoTmpDir: resolve(outRoot, "_video_tmp"),
    videoTmpClipDir: resolve(outRoot, "_video_tmp_clip"),
    clipSeqDir: resolve(outRoot, "sequences/clip-streaming"),
  };
}

export function loadCreds() {
  return {
    user: process.env.PROMO_USER ?? "dev",
    pass: process.env.PROMO_PASS ?? "devpassword",
    api: (process.env.PROMO_API ?? "http://localhost:8015").replace(/\/$/, ""),
    port: Number(process.env.PROMO_PORT ?? 5174),
  };
}
