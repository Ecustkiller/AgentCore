#!/usr/bin/env node
/**
 * Write gitignored sponsor posters from env (Mac GHA secrets).
 * Unset / blank env → skip that file. Never prints payload.
 *
 *   SPONSOR_WECHAT_PNG_B64=… SPONSOR_ALIPAY_JPG_B64=… node scripts/materialize-sponsor-posters.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dest = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/renderer/assets/support",
);

const FILES = [
  { env: "SPONSOR_WECHAT_PNG_B64", name: "wechat.png" },
  { env: "SPONSOR_ALIPAY_JPG_B64", name: "alipay.jpg" },
];

mkdirSync(dest, { recursive: true });
for (const { env, name } of FILES) {
  const raw = process.env[env]?.trim() ?? "";
  if (!raw) {
    console.log(`sponsor posters: skip ${name} (${env} unset)`);
    continue;
  }
  const buf = Buffer.from(raw, "base64");
  writeFileSync(join(dest, name), buf);
  console.log(`sponsor posters: wrote ${name} (${buf.length} bytes)`);
}
