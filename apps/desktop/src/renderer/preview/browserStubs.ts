import type { FsApi, FsResult, WorkspaceOpResult } from "@shared/ipc-contract";
import type { SidecarApi } from "@shared/sidecar-contract";
import type { UpdaterApi } from "@shared/updater-contract";

// The desktop renderer reaches native capability through four preload-injected
// globals. In a plain browser (the screenshot harness / `pnpm dev:web`) there is no
// Electron preload, so we install benign stubs BEFORE the app boots. The preview
// route only replays recorded events and never exercises real fs/sidecar, so
// empty / failing defaults suffice. Each global is installed only if absent, so this
// module is a no-op inside the real Electron shell.

const noop = (): void => {};
const fail = (): FsResult<never> => ({ ok: false, reason: "web-preview" });

const fsApi: FsApi = {
  addRoot: async () => null,
  ensureDefaultRoot: async () => ({ id: "web-preview", name: "Web 预览" }),
  listRoots: async () => [],
  removeRoot: async () => {},
  listDir: async () => ({ ok: true, data: [] }),
  listFiles: async () => ({ ok: true, data: [] }),
  readFile: async () => fail(),
  readTextFile: async () => fail(),
  writeFile: async () => ({
    ok: false,
    reason: "error",
    message: "web-preview",
  }),
  rename: async () => fail(),
  move: async () => fail(),
  copy: async () => fail(),
  create: async () => fail(),
  delete: async () => fail(),
  watch: async () => {},
  unwatch: async () => {},
  onChanged: () => noop,
  workspaceOp: async (): Promise<WorkspaceOpResult> => ({
    ok: false,
    error: { kind: "WebPreview", detail: "unavailable in web preview" },
  }),
  reveal: async () => fail(),
  openPath: async () => fail(),
  copyPath: async () => fail(),
};

const sidecarApi: SidecarApi = {
  startTurn: async () => {
    throw new Error("sidecar unavailable in web preview");
  },
  cancel: async () => {},
  respond: async () => {},
  resume: async () => {
    throw new Error("sidecar unavailable in web preview");
  },
  listPaused: async () => [],
  probe: async () => {},
  onEvent: () => noop,
  onStatus: () => noop,
};

const updaterApi: UpdaterApi = {
  configure: async () => {},
  check: async () => {},
  quitAndInstall: async () => {},
  getStatus: async () => ({ phase: "unsupported" }),
  onStatus: () => noop,
};

const windowApi = {
  minimize: noop,
  maximize: noop,
  close: noop,
};

if (typeof window !== "undefined") {
  if (!window.fsApi) window.fsApi = fsApi;
  if (!window.sidecarApi) window.sidecarApi = sidecarApi;
  if (!window.updaterApi) window.updaterApi = updaterApi;
  if (!window.windowApi) window.windowApi = windowApi;
  // Mark this as an offline, backend-less run so AuthGate skips auth bootstrap and
  // renders the app (incl. #/preview) without a server. Set only here, so the real
  // Electron shell never sees it.
  window.__WEB_PREVIEW__ = true;
}
