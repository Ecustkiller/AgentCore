import {
  CROSS_SOURCE_UNSUPPORTED,
  applyBridgedTransfer,
  resolveBridgedTransfer,
} from "@/components/files/fileTreeTransfer";
import type { FolderMeta } from "@/services/folders";
import { wsCopyFile, wsListFiles, wsMoveFile } from "@/services/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workspaces", () => ({
  wsMoveFile: vi.fn(async () => {}),
  wsCopyFile: vi.fn(async () => {}),
  wsListFiles: vi.fn(async () => ({ files: [], truncated: false })),
}));

function cloud(id: string, relPath: string): FolderMeta {
  return {
    id,
    name: relPath.split("/").pop() ?? relPath,
    mode: "cloud",
    localRootId: null,
    localSubpath: null,
    relPath,
    parentRelPath: relPath.includes("/")
      ? relPath.slice(0, relPath.lastIndexOf("/"))
      : null,
  };
}

// 设计/ ├ 图标/ └ 图表/ ；文档/ 是另一棵顶层树；本机/ 不在云端树里。
const FOLDERS: FolderMeta[] = [
  cloud("f-design", "设计"),
  cloud("f-icon", "设计/图标"),
  cloud("f-chart", "设计/图表"),
  cloud("f-docs", "文档"),
  {
    id: "f-local",
    name: "本机",
    mode: "local",
    localRootId: "root-1",
    localSubpath: "",
    relPath: null,
    parentRelPath: null,
  },
];

const ws = (id: string) => `workspace:folder:${id}`;

beforeEach(() => {
  vi.mocked(wsMoveFile).mockClear();
  vi.mocked(wsCopyFile).mockClear();
  vi.mocked(wsListFiles).mockClear();
});

describe("跨源搬运的桥（父子云文件夹在盘上本就是一棵树）", () => {
  it("父 → 子：借父工作区一次 move，子文件夹名成为目标前缀", () => {
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-design"), path: "稿件/a.png" },
        { sourceId: ws("f-icon"), dir: "" },
        FOLDERS,
      ),
    ).toEqual({
      wsId: "folder:f-design",
      srcPath: "稿件/a.png",
      dstDir: "图标",
    });
  });

  it("子 → 父：同一个桥，方向反过来", () => {
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-icon"), path: "a.png" },
        { sourceId: ws("f-design"), dir: "归档" },
        FOLDERS,
      ),
    ).toEqual({
      wsId: "folder:f-design",
      srcPath: "图标/a.png",
      dstDir: "归档",
    });
  });

  it("兄弟 → 兄弟：桥是它们的共同父文件夹", () => {
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-icon"), path: "a.png" },
        { sourceId: ws("f-chart"), dir: "季度" },
        FOLDERS,
      ),
    ).toEqual({
      wsId: "folder:f-design",
      srcPath: "图标/a.png",
      dstDir: "图表/季度",
    });
  });

  it("两个顶层文件夹之间没有公共工作区可借——不假装能做", () => {
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-icon"), path: "a.png" },
        { sourceId: ws("f-docs"), dir: "" },
        FOLDERS,
      ),
    ).toBeNull();
  });

  it("本机 ↔ 云端不桥接（既有端点表达不了，不偷偷下载再上传）", () => {
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-local"), path: "a.png" },
        { sourceId: ws("f-icon"), dir: "" },
        FOLDERS,
      ),
    ).toBeNull();
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-icon"), path: "a.png" },
        { sourceId: "workspace:conv:c1", dir: "" },
        FOLDERS,
      ),
    ).toBeNull();
  });

  it("同源不桥接（各自的 FileSource 直接 move 即可）", () => {
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-icon"), path: "a.png" },
        { sourceId: ws("f-icon"), dir: "sub" },
        FOLDERS,
      ),
    ).toBeNull();
  });

  it("中间层缺记录时退到更外层的祖先当桥（它物理上照样含住两端）", () => {
    const stale = FOLDERS.filter((f) => f.id !== "f-icon").concat(
      cloud("f-deep", "设计/图标/线性"),
    );
    expect(
      resolveBridgedTransfer(
        { sourceId: ws("f-deep"), path: "a.png" },
        { sourceId: ws("f-chart"), dir: "" },
        stale,
      ),
    ).toEqual({
      wsId: "folder:f-design",
      srcPath: "图标/线性/a.png",
      dstDir: "图表",
    });
  });

  it("接不上时的说明写清了能做什么、不能做什么", () => {
    expect(CROSS_SOURCE_UNSUPPORTED).toContain("同一个顶层文件夹");
  });
});

describe("落地一次桥接搬运", () => {
  const bridge = {
    wsId: "folder:f-design",
    srcPath: "图标/a.png",
    dstDir: "图表",
  };

  it("移动走既有 move 端点，撞名交给服务端报（不静默改名）", async () => {
    await applyBridgedTransfer(bridge, "move");
    expect(wsMoveFile).toHaveBeenCalledWith(
      "folder:f-design",
      "图标/a.png",
      "图表/a.png",
    );
    expect(wsCopyFile).not.toHaveBeenCalled();
  });

  it("复制沿用树内粘贴的去重口径，可对同一处重复粘贴", async () => {
    vi.mocked(wsListFiles).mockResolvedValueOnce({
      files: [{ path: "图表/a.png", isDir: false, sizeBytes: 1, mtimeMs: 1 }],
      truncated: false,
    });
    await applyBridgedTransfer(bridge, "copy");
    expect(wsCopyFile).toHaveBeenCalledWith(
      "folder:f-design",
      "图标/a.png",
      "图表/a 副本.png",
    );
  });

  it("搬进自己子树被挡下，不发请求", async () => {
    await expect(
      applyBridgedTransfer(
        { wsId: "folder:f-design", srcPath: "图标", dstDir: "图标/子" },
        "move",
      ),
    ).rejects.toThrow("不能搬到自身或其子目录");
    expect(wsMoveFile).not.toHaveBeenCalled();
  });

  it("原地移动是空操作", async () => {
    await applyBridgedTransfer(
      { wsId: "folder:f-design", srcPath: "图标/a.png", dstDir: "图标" },
      "move",
    );
    expect(wsMoveFile).not.toHaveBeenCalled();
  });
});
