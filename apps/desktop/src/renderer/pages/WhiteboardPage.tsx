import { Excalidraw, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { resolveDark } from "@/lib/theme";
import { useUIStore } from "@/stores/ui";
import { type ComponentProps, useCallback, useMemo, useRef } from "react";

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawAPI = Parameters<NonNullable<ExcalidrawProps["excalidrawAPI"]>>[0];
type SceneChange = NonNullable<ExcalidrawProps["onChange"]>;

// M1 占位持久化：先落 localStorage 把「刷新不丢」跑通，后续切到后端 /v1/boards
// （实施文档 §四 数据模型 / §六 M1）。键名带版本号，便于日后场景迁移。
const STORAGE_KEY = "agentcore:whiteboard:local:v1";

function loadInitialData(): ExcalidrawProps["initialData"] {
  // 默认开启网格（gridModeEnabled）；固定 ON 以覆盖历史场景里未持久化网格状态的情况。
  const withGrid: ExcalidrawProps["initialData"] = {
    appState: { gridModeEnabled: true },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return withGrid;
    // restore 把裸 JSON 补全成合法 scene（collaborators 等字段不靠 JSON 还原）。
    const restored = restore(JSON.parse(raw), null, null);
    restored.appState.gridModeEnabled = true;
    return restored;
  } catch {
    return withGrid;
  }
}

export function WhiteboardPage() {
  const theme = useUIStore((s) => s.theme);
  // 持有 Excalidraw 命令式 API（实施文档 §三）：M2 的 AI ops / 存盘经此读写场景。
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // initialData 仅在挂载时读取一次，故用 useMemo 读一次本地场景。
  const initialData = useMemo(loadInitialData, []);

  // onChange 触发频繁，防抖 ~1.5s 再写本地（实施文档 §四：autosave 防抖 ~1.5s）。
  const handleChange = useCallback<SceneChange>((elements, appState, files) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          serializeAsJSON(elements, appState, files, "local"),
        );
      } catch {
        // 配额满 / 隐私模式下写失败：M1 占位存储静默放过，后端落库为最终方案。
      }
    }, 1500);
  }, []);

  return (
    <div className="absolute inset-0">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        initialData={initialData}
        // 强制简体中文：Excalidraw 默认跟随浏览器/英文，本 app 全中文界面故固定 zh-CN。
        langCode="zh-CN"
        onChange={handleChange}
        theme={resolveDark(theme) ? "dark" : "light"}
      />
    </div>
  );
}
