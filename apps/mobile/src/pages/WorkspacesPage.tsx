import { getTokens } from "@/api/client";
import { type WorkspaceSummary, listWorkspaces } from "@/api/workspaces";
import { Brain, ChevronRight, Cloud, Folder, ScrollText } from "lucide-react";
// 文件 tab home — the cross-workspace file overview (手机端布局重构 · 跨工作区文件总览).
//
// Lists the user's CLOUD workspaces (= folders); tapping one drills into its file tree
// (/files/:wsId). The mobile counterpart of the desktop 文件 hub, minus the desktop-only
// halves: LOCAL workspaces live on the user's machine (reached over desktop IPC; the server
// refuses file ops with 409), so the phone hides them — a 减法 boundary, surfaced as a note
// when the user has local-only workspaces. A workspace's *contents* are editable on the phone
// (see WorkspaceFilesPage), but the workspace **lifecycle** — 新建 / 重命名 / 删除 a workspace,
// 绑定本机文件夹 — stays a desktop task, so this list has no management actions. Re-fetches on
// each visit (the tab remounts), so files just produced in a chat appear without a refresh.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export function WorkspacesPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    listWorkspaces()
      .then((ws) => {
        if (!cancelled) setItems(ws);
      })
      .catch((e) => {
        if (cancelled) return;
        if (!getTokens()) {
          navigate("/login", { replace: true });
          return;
        }
        setError(e instanceof Error ? e.message : "加载工作区失败");
        setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const clouds = items?.filter((w) => w.location === "cloud") ?? [];
  const hasLocalOnly =
    items !== null &&
    clouds.length === 0 &&
    items.some((w) => w.location === "local");

  return (
    <div className="screen">
      <header className="bar">
        <span>文件</span>
      </header>

      <div className="list">
        <button
          type="button"
          className="file-row"
          onClick={() => navigate("/memory")}
        >
          <span className="file-icon" aria-hidden>
            <Brain size={16} />
          </span>
          <span className="file-row-main">
            <span className="file-name">全局设定</span>
            <span className="file-sub">画像、偏好与主题笔记</span>
          </span>
          <span className="file-chevron" aria-hidden>
            <ChevronRight size={18} />
          </span>
        </button>

        <button
          type="button"
          className="file-row"
          onClick={() => navigate("/rules")}
        >
          <span className="file-icon" aria-hidden>
            <ScrollText size={16} />
          </span>
          <span className="file-row-main">
            <span className="file-name">规则</span>
            <span className="file-sub">常驻 / 按需 · 指导 AI 做事</span>
          </span>
          <span className="file-chevron" aria-hidden>
            <ChevronRight size={18} />
          </span>
        </button>

        {items === null && !error && <p className="muted hint">加载中…</p>}
        {error && <p className="error hint">{error}</p>}
        {items !== null && clouds.length === 0 && !error && (
          <div className="file-empty">
            <p className="file-empty-title">
              {hasLocalOnly ? "还没有云端工作区" : "还没有工作区"}
            </p>
            <p className="muted hint">
              {hasLocalOnly
                ? "本地工作区请在桌面端查看。开始云端对话并产出文件后，会出现在这里。"
                : "开始对话并产出文件后，工作区会出现在这里。"}
            </p>
          </div>
        )}
        {clouds.map((ws) => (
          <button
            key={ws.wsId}
            type="button"
            className="file-row"
            onClick={() =>
              navigate(`/files/${encodeURIComponent(ws.wsId)}`, {
                state: { name: ws.name },
              })
            }
          >
            {/* 手机只列云端：云标识并进文件夹图标角标，避免「云端工作区」独占一行 */}
            <span className="file-icon file-icon-cloud-ws" aria-hidden>
              <Folder size={16} />
              <Cloud size={9} className="file-icon-badge" />
            </span>
            <span className="file-name">{ws.name}</span>
            {!ws.hasFiles && <span className="file-tag">空</span>}
            <span className="file-chevron" aria-hidden>
              <ChevronRight size={18} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
