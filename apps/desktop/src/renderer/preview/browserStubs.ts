import type { FsApi, FsResult, WorkspaceOpResult } from "@shared/ipc-contract";
import type { LogApi } from "@shared/log-contract";
import type { ProcessApi } from "@shared/process-contract";
import type { PtyApi } from "@shared/pty-contract";
import type { SidecarApi } from "@shared/sidecar-contract";
import type { UpdaterApi } from "@shared/updater-contract";
import type { WindowApi } from "@shared/window-contract";

// The desktop renderer reaches native capability through four preload-injected
// globals. In a plain browser there is no Electron preload, so we install benign stubs
// BEFORE the app boots and mark the browser runtime via `window.__WEB__`. Two browser
// entries import this: the production web client (main.webapp.tsx) and the offline
// screenshot / preview harness (main.web.tsx). In both, native fs/sidecar are genuinely
// absent, so these empty / failing defaults are the correct "degraded" behavior —
// capability proxies (lib/capabilities) gate local-only features off via `__WEB__`
// rather than calling these. Each global installs only if absent, so this module is a
// no-op inside the real Electron shell.

const noop = (): void => {};
const fail = (): FsResult<never> => ({
  ok: false,
  reason: "web-preview",
  code: "error",
});

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
  grantSessionRun: async () => {},
  reveal: async () => fail(),
  openPath: async () => fail(),
  copyPath: async () => fail(),
};

const sidecarApi: SidecarApi = {
  startTurn: async () => {
    throw new Error("sidecar unavailable in web preview");
  },
  cancel: async () => {},
  respond: async () => ({ resolved: false }),
  runRedirect: async () => {},
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

const logApi: LogApi = {
  write: noop,
};

const processApi: ProcessApi = {
  list: async () => ({ processes: [] }),
  stop: async (req) => ({
    process_id: req.process_id,
    status: "exited",
    output: "",
    exit_code: -1,
  }),
  read: async (req) => ({
    process_id: req.process_id,
    status: "exited",
    output: "",
  }),
  killConversation: async () => {},
  onEvent: () => noop,
};

const ptyApi: PtyApi = {
  spawn: async () => ({
    ok: false,
    error: { kind: "WorkspaceIOError", detail: "web-preview" },
  }),
  input: async () => ({
    ok: false,
    error: { kind: "WorkspaceIOError", detail: "web-preview" },
  }),
  resize: async () => ({
    ok: false,
    error: { kind: "WorkspaceIOError", detail: "web-preview" },
  }),
  kill: async () => ({
    ok: false,
    error: { kind: "WorkspaceIOError", detail: "web-preview" },
  }),
  list: async () => ({ sessions: [] }),
  read: async () => ({
    ok: false,
    error: { kind: "WorkspaceIOError", detail: "web-preview" },
  }),
  killConversation: async () => {},
  onEvent: () => noop,
};

const windowApi: WindowApi = {
  minimize: noop,
  maximize: noop,
  close: noop,
  applyFramePreset: async () => {},
  getFramePreset: async () => "free" as const,
};

if (typeof window !== "undefined") {
  if (!window.fsApi) window.fsApi = fsApi;
  if (!window.sidecarApi) window.sidecarApi = sidecarApi;
  if (!window.updaterApi) window.updaterApi = updaterApi;
  if (!window.logApi) window.logApi = logApi;
  if (!window.processApi) window.processApi = processApi;
  if (!window.ptyApi) window.ptyApi = ptyApi;
  if (!window.windowApi) window.windowApi = windowApi;
  // Mark the browser runtime (no native fs/sidecar/updater/window): capability proxies
  // (lib/capabilities) read this so the app creates cloud — never local — conversations
  // and routes turns to the cloud SSE path. Shared by the production web client
  // (main.webapp.tsx) and the offline preview (main.web.tsx). Set only by these browser
  // entries, so the real Electron shell never sees it. (Offline preview ALSO sets
  // __WEB_PREVIEW__ via markPreview to skip auth; the web client keeps real auth.)
  window.__WEB__ = true;
}
