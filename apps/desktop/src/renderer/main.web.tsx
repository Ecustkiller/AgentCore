// Plain-browser entry for the screenshot harness (scripts/shoot.mjs) and
// `pnpm dev:web`. Installs the Electron-global stubs first (side-effect import,
// runs before ./main), then boots the real renderer unchanged.
import "./preview/browserStubs";
import "./main";
