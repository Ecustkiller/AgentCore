/**
 * Tape capture — any demo tape → stills / clips under apps/video/assets/<tape>
 *
 *   node scripts/video_capture.mjs full --tape <id> [--out <path>]
 *   node scripts/video_capture.mjs clip --tape <id> [--out <path>]
 *
 * Prereq:
 *   cd apps/desktop && $env:VITE_API_URL='http://localhost:8015'; pnpm build:webapp
 *   Backend on VIDEO_API with DEMO_TAPE_REPLAY_ENABLED=true
 */

import { parseCli, printHelp } from "./video_capture/cli.mjs";
import { run as runFull } from "./video_capture/cmd/full.mjs";
import { run as runClip } from "./video_capture/cmd/clip.mjs";

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(String(e?.message || e));
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (cli.help || !cli.command) {
    printHelp();
    process.exitCode = cli.help ? 0 : 2;
    return;
  }

  const opts = { tape: cli.tape, out: cli.out };

  if (cli.command === "full") {
    await runFull(opts);
  } else if (cli.command === "clip") {
    await runClip(opts);
  } else {
    printHelp();
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
