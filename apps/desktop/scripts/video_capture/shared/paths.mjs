/**
 * Repo-relative path helpers for tape capture.
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

/** VIDEO_* preferred; PROMO_* still read. */
export function captureEnv(suffix, fallback) {
  const v = process.env[`VIDEO_${suffix}`] ?? process.env[`PROMO_${suffix}`];
  if (v !== undefined && v !== "") return v;
  return fallback;
}

/**
 * @param {{ tape?: string, out?: string }} opts
 */
export function resolveCapturePaths(opts = {}) {
  const tape = opts.tape || captureEnv("TAPE");
  if (!tape) {
    throw new Error("Missing --tape <id> (or env VIDEO_TAPE)");
  }
  const outArg = opts.out || captureEnv("OUT");
  const outRel = outArg || `apps/video/assets/${tape}`;
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
    user: captureEnv("USER", "dev"),
    pass: captureEnv("PASS", "devpassword"),
    api: captureEnv("API", "http://localhost:8015").replace(/\/$/, ""),
    port: Number(captureEnv("PORT", "5174")),
  };
}
