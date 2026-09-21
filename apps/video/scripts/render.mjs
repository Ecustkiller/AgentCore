/*
 * Render a Remotion composition by id.
 *
 * Usage (cwd = apps/video):
 *   node scripts/render.mjs Kit-Logo out/logo.mp4
 *   node scripts/render.mjs PixelCheck out/pixel-check.png --still
 *   pnpm render -- Kit-GraphRun out/graph-run.mp4
 *
 * Extra flags after the output path are forwarded to `remotion render` / `still`.
 */
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const stillIdx = args.indexOf("--still");
const isStill = stillIdx >= 0;
if (isStill) args.splice(stillIdx, 1);

const compositionId = args[0] ?? "Kit-Logo";
const out =
  args[1] ??
  (isStill ? `out/${compositionId}.png` : `out/${compositionId}.mp4`);
const extra = args.slice(2).join(" ");

const cmd = isStill
  ? `npx remotion still ${compositionId} ${out} ${extra}`.trim()
  : `npx remotion render ${compositionId} ${out} ${extra}`.trim();

console.log(`▶ ${cmd}`);
execSync(cmd, { stdio: "inherit" });
