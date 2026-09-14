/**
 * CLI for promo_capture.mjs
 *
 *   node scripts/promo_capture.mjs <full|clip> --tape <id> [--out <path>]
 */

const COMMANDS = ["full", "clip"];

export function printHelp() {
  console.log(`Usage: node promo_capture.mjs <command> --tape <id> [options]

Commands:
  full   Director capture: structural stills + one still per tape chapter
  clip   SPEED=1 streaming clip + sequence frames

Required:
  --tape <id>          Demo-tape stem (or env PROMO_TAPE)

Options:
  --out <path>         Output root (default: apps/promo/assets/<tape>)
  --help, -h           Show this help

Env: PROMO_API PROMO_USER PROMO_PASS PROMO_PORT PROMO_SPEED
     PROMO_GAP PROMO_OVERWRITE PROMO_WIPE PROMO_HEADED
`);
}

/**
 * @param {string[]} argv process.argv.slice(2)
 */
export function parseCli(argv) {
  const out = {
    help: false,
    command: undefined,
    tape: undefined,
    out: undefined,
  };

  if (argv.length === 0) {
    out.help = true;
    return out;
  }

  let i = 0;
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    out.help = true;
    return out;
  }
  if (COMMANDS.includes(first)) {
    out.command = first;
    i = 1;
  } else if (first?.startsWith("-")) {
    // allow `… --help` without command
  } else {
    throw new Error(
      `Unknown command: ${first} (use: ${COMMANDS.join(" | ")} | --help)`,
    );
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--tape") out.tape = argv[++i];
    else if (a?.startsWith("--tape=")) out.tape = a.slice("--tape=".length);
    else if (a === "--out") out.out = argv[++i];
    else if (a?.startsWith("--out=")) out.out = a.slice("--out=".length);
    else throw new Error(`Unknown arg: ${a} (see --help)`);
  }

  return out;
}

export { COMMANDS };
