// 「记忆已更新」卡 (Agent记忆与知识系统 §1.6「记忆更新对话内可见」; 手机端全新实现，对标桌面
// components/chat/MemoryUpdateCard.tsx)。AI 离线消化对话后，把「记了什么」逐条挂在对话尾部：
// 读侧 (consult_memory) 本就内联可见，这张卡让写侧 (offline consolidation) 也可见可审。
//
// 减能力 (手机无 per-user firehose): 桌面是「加载窗口 + 实时推送」双管；手机只在(重)开对话/刷新
// 时随最新窗口的 memory_updates 一并取（消化本就是离线异步、晚于回合，故载入态呈现是合理 lite）。
// 点「在 AI 记忆中查看」跳到精简记忆页（手机记忆是单页，不按叶子深链——控制随可见而至即可）。
import type { MemoryUpdate } from "@/api/conversations";
import { Brain, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

const ACTION_META: Record<string, { label: string; cls: string }> = {
  add: { label: "新增", cls: "mem-add" },
  update: { label: "更新", cls: "mem-update-on" },
  remove: { label: "移除", cls: "mem-remove" },
};

function scopeLabel(scope: string): string {
  return scope === "project" ? "本项目" : "全局";
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function MemoryUpdateCard({ updates }: { updates: MemoryUpdate[] }) {
  const navigate = useNavigate();
  const withItems = updates.filter((u) => u.items.length > 0);
  if (withItems.length === 0) return null;

  return (
    <div className="mem-updates">
      {withItems.map((u) => (
        <div key={u.id} className="mem-update">
          <div className="mem-update-head">
            <Brain size={15} className="mem-update-icon" aria-hidden />
            <span className="mem-update-title">记忆已更新</span>
            <span className="mem-update-count">{u.items.length} 项</span>
            <span className="mem-update-when">{formatWhen(u.createdAt)}</span>
          </div>
          <ul className="mem-update-list">
            {u.items.map((it) => {
              const meta = ACTION_META[it.action] ?? {
                label: it.action,
                cls: "mem-update-other",
              };
              const leaf = it.section ? `${it.file} · ${it.section}` : it.file;
              const removed = it.action === "remove";
              return (
                <li
                  key={`${it.action}:${it.file}:${it.section}:${it.content}`}
                  className="mem-item"
                >
                  <span className={`mem-action ${meta.cls}`}>{meta.label}</span>
                  <div className="mem-item-body">
                    <div className="mem-item-meta">
                      <span className="mem-item-leaf">{leaf}</span>
                      <span className="mem-item-scope">
                        {scopeLabel(it.scope)}
                      </span>
                    </div>
                    {it.content && (
                      <p
                        className={`mem-item-text${
                          removed ? " mem-item-removed" : ""
                        }`}
                      >
                        {it.content}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="mem-update-link"
            onClick={() => navigate("/memory")}
          >
            在「AI 记忆」中查看
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
