import type {
  WorkspaceEditDoc,
  WorkspaceWriteInput,
  WorkspaceWriteOutcome,
} from "@/api/workspace";

/**
 * The write half of a file browser's data source (改名 / 移动 / 删除 / 新建文件夹 / 编辑).
 *
 * Injected like `FileBrowserSource` so addressing stays in the page: the 文件 tab
 * talks to `/v1/workspaces/{ws_id}/…`, the chat's file page to the per-conversation
 * alias. **Omit it entirely to keep the browser read-only** — that is how a local
 * workspace (bytes live on the user's desktop; the server answers 409) shows no
 * write affordances at all instead of buttons that always fail.
 */
export interface FileBrowserOps {
  /** Rename or relocate one entry. 改名 = 同目录内的 move；后端拒绝覆盖同名。 */
  move: (src: string, dst: string) => Promise<void>;
  /** Soft-delete into `AgentCore/trash` — restorable from 软删区, never a hard erase. */
  remove: (path: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  /** Whole text + the mtime baseline a conditional save needs. */
  readForEdit: (path: string) => Promise<WorkspaceEditDoc>;
  /** Conditional write; a `conflict` outcome means nothing was written. */
  writeText: (
    path: string,
    input: WorkspaceWriteInput,
  ) => Promise<WorkspaceWriteOutcome>;
}
