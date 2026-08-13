import {
  EMPTY_SELECTION,
  type SelectedItem,
  type TreeSelection,
  clickIntent,
  dropFromSelection,
  flattenVisibleRows,
  selectRow,
  selectionForContextMenu,
  topLevelSelection,
} from "@/components/files/fileTreeSelection";
import type { FileNode } from "@/lib/fileSource";
import { describe, expect, it } from "vitest";

function item(path: string, isDir = false): SelectedItem {
  return { path, isDir };
}

const VISIBLE: SelectedItem[] = [
  item("dir", true),
  item("dir/a.md"),
  item("dir/b.md"),
  item("c.md"),
  item("d.md"),
];

function paths(sel: TreeSelection): string[] {
  return sel.items.map((i) => i.path);
}

const PLAIN = { toggle: false, range: false };
const TOGGLE = { toggle: true, range: false };
const RANGE = { toggle: false, range: true };

describe("clickIntent", () => {
  it("Ctrl 与 Cmd 都是加减选，Shift 是连选", () => {
    expect(
      clickIntent({ ctrlKey: true, metaKey: false, shiftKey: false }),
    ).toEqual({
      toggle: true,
      range: false,
    });
    expect(
      clickIntent({ ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toEqual({
      toggle: true,
      range: false,
    });
    expect(
      clickIntent({ ctrlKey: false, metaKey: false, shiftKey: true }),
    ).toEqual({
      toggle: false,
      range: true,
    });
  });
});

describe("selectRow", () => {
  it("普通点击 = 单选并把锚点挪过来", () => {
    const sel = selectRow(EMPTY_SELECTION, item("c.md"), PLAIN, VISIBLE);
    expect(paths(sel)).toEqual(["c.md"]);
    expect(sel.anchor).toBe("c.md");

    const next = selectRow(sel, item("d.md"), PLAIN, VISIBLE);
    expect(paths(next)).toEqual(["d.md"]);
  });

  it("Ctrl 点击加减同一行，选区按可见顺序排（不是点选先后）", () => {
    let sel = selectRow(EMPTY_SELECTION, item("d.md"), PLAIN, VISIBLE);
    sel = selectRow(sel, item("dir/a.md"), TOGGLE, VISIBLE);
    expect(paths(sel)).toEqual(["dir/a.md", "d.md"]);

    sel = selectRow(sel, item("d.md"), TOGGLE, VISIBLE);
    expect(paths(sel)).toEqual(["dir/a.md"]);
  });

  it("Shift 从锚点连选（含反向），并保留锚点以便继续改范围", () => {
    const anchored = selectRow(
      EMPTY_SELECTION,
      item("dir/a.md"),
      PLAIN,
      VISIBLE,
    );
    const down = selectRow(anchored, item("d.md"), RANGE, VISIBLE);
    expect(paths(down)).toEqual(["dir/a.md", "dir/b.md", "c.md", "d.md"]);
    expect(down.anchor).toBe("dir/a.md");

    // 锚点不动，改选更小的范围
    const shrunk = selectRow(down, item("dir/b.md"), RANGE, VISIBLE);
    expect(paths(shrunk)).toEqual(["dir/a.md", "dir/b.md"]);

    // 反向连选也从锚点算起
    const up = selectRow(
      selectRow(EMPTY_SELECTION, item("c.md"), PLAIN, VISIBLE),
      item("dir"),
      RANGE,
      VISIBLE,
    );
    expect(paths(up)).toEqual(["dir", "dir/a.md", "dir/b.md", "c.md"]);
  });

  it("锚点已不在可见行里（折叠 / 筛掉）时 Shift 退化成单选，不连出看不见的一段", () => {
    const stale: TreeSelection = {
      items: [item("gone.md")],
      anchor: "gone.md",
    };
    const sel = selectRow(stale, item("c.md"), RANGE, VISIBLE);
    expect(paths(sel)).toEqual(["c.md"]);
  });
});

describe("selectionForContextMenu", () => {
  it("右键点在选区内保持整批，点在选区外收敛成单选", () => {
    const multi: TreeSelection = {
      items: [item("c.md"), item("d.md")],
      anchor: "d.md",
    };
    expect(paths(selectionForContextMenu(multi, item("c.md")))).toEqual([
      "c.md",
      "d.md",
    ]);
    expect(paths(selectionForContextMenu(multi, item("dir/a.md")))).toEqual([
      "dir/a.md",
    ]);
  });
});

describe("topLevelSelection", () => {
  it("祖先已选中的后代要剔掉，否则父目录一删，子项就成了我们自己造的假失败", () => {
    const picked = [item("dir", true), item("dir/a.md"), item("c.md")];
    expect(topLevelSelection(picked).map((i) => i.path)).toEqual([
      "dir",
      "c.md",
    ]);
  });

  it("同名前缀不算后代（dir2 不是 dir 的子项）", () => {
    const picked = [item("dir", true), item("dir2/a.md")];
    expect(topLevelSelection(picked).map((i) => i.path)).toEqual([
      "dir",
      "dir2/a.md",
    ]);
  });
});

describe("dropFromSelection", () => {
  const sel: TreeSelection = {
    items: [item("dir", true), item("dir/a.md"), item("c.md")],
    anchor: "dir/a.md",
  };

  it("搬走的行连同后代一起摘掉，锚点跟着作废", () => {
    const next = dropFromSelection(sel, ["dir"]);
    expect(paths(next)).toEqual(["c.md"]);
    expect(next.anchor).toBeNull();
  });

  it("没搬走的行原样留下，锚点也不动", () => {
    const next = dropFromSelection(sel, ["c.md"]);
    expect(paths(next)).toEqual(["dir", "dir/a.md"]);
    expect(next.anchor).toBe("dir/a.md");
  });

  it("同名前缀不算后代；没命中任何一行时返回原选区", () => {
    expect(paths(dropFromSelection(sel, ["dir2"]))).toEqual([
      "dir",
      "dir/a.md",
      "c.md",
    ]);
    expect(dropFromSelection(sel, [])).toBe(sel);
  });
});

describe("flattenVisibleRows", () => {
  const tree: Record<string, FileNode[]> = {
    "": [
      { path: "dir", name: "dir", isDir: true },
      { path: "AgentCore", name: "AgentCore", isDir: true },
      { path: "c.md", name: "c.md", isDir: false },
    ],
    dir: [
      { path: "dir/sub", name: "sub", isDir: true },
      { path: "dir/a.md", name: "a.md", isDir: false },
    ],
    "dir/sub": [{ path: "dir/sub/deep.md", name: "deep.md", isDir: false }],
  };
  const childrenOf = (d: string) => tree[d];

  it("展开的目录把子层紧跟在自己后面（与渲染顺序一致），未展开的不下探", () => {
    expect(
      flattenVisibleRows({
        childrenOf,
        expanded: new Set(["dir"]),
      }).map((i) => i.path),
    ).toEqual(["dir", "dir/sub", "dir/a.md", "AgentCore", "c.md"]);

    expect(
      flattenVisibleRows({
        childrenOf,
        expanded: new Set(["dir", "dir/sub"]),
      }).map((i) => i.path),
    ).toEqual([
      "dir",
      "dir/sub",
      "dir/sub/deep.md",
      "dir/a.md",
      "AgentCore",
      "c.md",
    ]);
  });

  it("筛选态只留命中项；根层被藏起来的目录不算可见行", () => {
    expect(
      flattenVisibleRows({
        childrenOf,
        expanded: new Set(["dir"]),
        filterVisible: new Set(["dir", "dir/a.md"]),
      }).map((i) => i.path),
    ).toEqual(["dir", "dir/a.md"]);

    expect(
      flattenVisibleRows({
        childrenOf,
        expanded: new Set(),
        hideRootDirs: ["AgentCore"],
      }).map((i) => i.path),
    ).toEqual(["dir", "c.md"]);
  });
});
