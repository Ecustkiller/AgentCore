#!/usr/bin/env node
/**
 * Vendor the macOS arm64 whisper.cpp CLI and its Homebrew dylibs into the app.
 * Generated binaries stay out of git; electron-builder copies them to Resources/voice.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(desktopRoot, "resources", "voice", "mac-arm64");
const backendDir = join(outputRoot, "libexec");

function run(command, args, opts = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
  }).trim();
}

function brewPrefix(name) {
  return run("brew", ["--prefix", name]);
}

function installName(args) {
  run("install_name_tool", args);
}

function sign(path) {
  run("codesign", ["--force", "--sign", "-", path]);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("[whisper] skip: bundled voice engine is macOS arm64 only");
  process.exit(0);
}

const whisperPrefix = brewPrefix("whisper-cpp");
const ggmlPrefix = brewPrefix("ggml");
const libompPrefix = brewPrefix("libomp");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(backendDir, { recursive: true });

const files = {
  cli: join(outputRoot, "whisper-cli"),
  whisper: join(outputRoot, "libwhisper.1.dylib"),
  ggml: join(outputRoot, "libggml.0.dylib"),
  ggmlBase: join(outputRoot, "libggml-base.0.dylib"),
  libomp: join(outputRoot, "libomp.dylib"),
};

copyFileSync(join(whisperPrefix, "bin", "whisper-cli"), files.cli);
copyFileSync(join(whisperPrefix, "lib", "libwhisper.1.dylib"), files.whisper);
copyFileSync(join(ggmlPrefix, "lib", "libggml.0.dylib"), files.ggml);
copyFileSync(join(ggmlPrefix, "lib", "libggml-base.0.dylib"), files.ggmlBase);
copyFileSync(join(libompPrefix, "lib", "libomp.dylib"), files.libomp);

for (const name of readdirSync(join(ggmlPrefix, "libexec"))) {
  if (!name.endsWith(".so")) continue;
  copyFileSync(join(ggmlPrefix, "libexec", name), join(backendDir, name));
}

installName([
  "-change",
  "@rpath/libwhisper.1.dylib",
  "@loader_path/libwhisper.1.dylib",
  "-change",
  join(ggmlPrefix, "lib", "libggml.0.dylib"),
  "@loader_path/libggml.0.dylib",
  "-change",
  join(ggmlPrefix, "lib", "libggml-base.0.dylib"),
  "@loader_path/libggml-base.0.dylib",
  files.cli,
]);
installName([
  "-id",
  "@loader_path/libwhisper.1.dylib",
  "-change",
  join(ggmlPrefix, "lib", "libggml.0.dylib"),
  "@loader_path/libggml.0.dylib",
  "-change",
  join(ggmlPrefix, "lib", "libggml-base.0.dylib"),
  "@loader_path/libggml-base.0.dylib",
  files.whisper,
]);
installName([
  "-id",
  "@loader_path/libggml.0.dylib",
  "-change",
  "@rpath/libggml-base.0.dylib",
  "@loader_path/libggml-base.0.dylib",
  files.ggml,
]);
installName([
  "-id",
  "@loader_path/libggml-base.0.dylib",
  "-change",
  join(libompPrefix, "lib", "libomp.dylib"),
  "@loader_path/libomp.dylib",
  files.ggmlBase,
]);
installName(["-id", "@loader_path/libomp.dylib", files.libomp]);

for (const name of readdirSync(backendDir)) {
  installName([
    "-change",
    "@rpath/libggml-base.0.dylib",
    "@loader_path/../libggml-base.0.dylib",
    "-change",
    join(libompPrefix, "lib", "libomp.dylib"),
    "@loader_path/../libomp.dylib",
    join(backendDir, name),
  ]);
}

const machoFiles = [
  files.cli,
  files.whisper,
  files.ggml,
  files.ggmlBase,
  files.libomp,
  ...readdirSync(backendDir).map((name) => join(backendDir, name)),
];
for (const path of machoFiles) {
  const linked = run("otool", ["-L", path]);
  if (linked.includes("/opt/homebrew/") || linked.includes("/usr/local/opt/")) {
    throw new Error(
      `[whisper] non-relocatable Homebrew dependency remains in ${path}`,
    );
  }
}

chmodSync(files.cli, 0o755);
for (const path of machoFiles) {
  sign(path);
}

copyFileSync(
  join(whisperPrefix, "LICENSE"),
  join(outputRoot, "LICENSE-whisper"),
);
copyFileSync(join(ggmlPrefix, "LICENSE"), join(outputRoot, "LICENSE-ggml"));
writeFileSync(
  join(outputRoot, "build-info.json"),
  `${JSON.stringify(
    {
      engine: "whisper.cpp",
      platform: process.platform,
      arch: process.arch,
      whisperPrefix,
      ggmlPrefix,
      libompPrefix,
    },
    null,
    2,
  )}\n`,
);

console.log(`[whisper] bundled macOS arm64 engine -> ${outputRoot}`);
