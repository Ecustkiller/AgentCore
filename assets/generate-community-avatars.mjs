/**
 * WeChat / community avatars from the Orbit cropped master.
 * Official = same art. Beta = desktop channel hue + 「测」inside
 * the circular crop (not the squircle corner used by pack icons).
 *
 *   node assets/generate-community-avatars.mjs
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const assets = dirname(fileURLToPath(import.meta.url));
const src = join(assets, "agentcore-icon-orbit-cropped.png");
const outDir = join(assets, "community");

/** Badge fully inside the inscribed circle WeChat applies. */
function circleSafeBadge(size) {
  const R = size / 2;
  const badgeR = Math.round(size * 0.15);
  const margin = Math.round(size * 0.06);
  const dist = R - badgeR - margin;
  const axis = dist / Math.SQRT2;
  return {
    badgeR,
    cx: R + axis,
    cy: R - axis,
    fontSize: Math.round(badgeR * 1.15),
  };
}

async function writeBeta(dest) {
  const meta = await sharp(src).metadata();
  const size = Math.min(meta.width ?? 1024, meta.height ?? 1024);
  const { badgeR, cx, cy, fontSize } = circleSafeBadge(size);
  const svg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${cx}" cy="${cy}" r="${badgeR}" fill="#c45c26"/>
  <text x="${cx}" y="${cy + 1}" font-size="${fontSize}"
    font-family="Segoe UI, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    font-weight="700" fill="#ffffff" text-anchor="middle"
    dominant-baseline="central">测</text>
</svg>`,
  );

  await sharp(src)
    .ensureAlpha()
    .modulate({ hue: 42, saturation: 1.06 })
    .composite([{ input: svg, blend: "over" }])
    .png()
    .toFile(dest);
  console.log(`→ ${dest}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const official = join(outDir, "wechat-official.png");
  copyFileSync(src, official);
  console.log(`→ ${official}`);
  await writeBeta(join(outDir, "wechat-beta.png"));
  console.log("✓ community avatars");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
