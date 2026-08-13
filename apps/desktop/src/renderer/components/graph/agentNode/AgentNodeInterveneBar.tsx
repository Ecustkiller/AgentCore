/**
 * 节点上的按人干预条 —— 「只改这个人的方向 / 只停这个人」就挂在用户正在看的那张卡上。
 *
 * 之前这两件事只在「展开协作图 → 点中节点 → 打开右坞 → 找到入口 → 展开文本框」之后
 * 才够得着，于是图上按人显示每个队员在干什么、用户能操作的却只有整轮。入口回到节点，
 * 看到谁跑偏就当场处理。
 *
 * **跟随注意力，不常驻**（零噪音）：鼠标停在这张卡上、这张卡是右坞当前钉住的那位，或
 * 改方向草稿开着——满足其一才现身，其余时间完全不占视觉。
 */

import { RunInterveneControls } from "@/components/graph/RunInterveneControls";
import { runActCapabilities } from "@/components/graph/planCapabilities";
import { useConversationStore } from "@/stores/conversation";
import {
  projectRuntime,
  useExecutionScope,
  useExecutionStore,
} from "@/stores/execution";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGraphNodeHovered } from "../graphHover";
import type { AgentNodeData } from "./shared";

export function AgentNodeInterveneBar({ d }: { d: AgentNodeData }) {
  const messageId = useExecutionScope();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const hovered = useGraphNodeHovered();
  const [composerOpen, setComposerOpen] = useState(false);

  // projectRuntime 会在缓存底座上叠新对象，整只回传会让 getSnapshot 每次比较不等
  // （React 无限重渲染）——选择器里先归约成原始值再浅比较。
  const { executionId, redirectCapable } = useExecutionStore(
    useShallow((s) => {
      const rt = messageId ? s.byId[messageId] : undefined;
      const execution = rt ? projectRuntime(rt) : null;
      return {
        executionId: execution?.id ?? null,
        redirectCapable:
          execution != null &&
          runActCapabilities(execution, d.runId).runRedirect,
      };
    }),
  );

  // 没有会话 / 没有执行 = 结构上无从提交（离线预览、空图），与「来晚了」无关，不出条。
  if (!conversationId || !executionId) return null;

  // 只在注意力落到这张卡时挂出来：鼠标停在卡上、这张卡是右坞钉住的那位，或改方向
  // 草稿开着。整条不渲染而非透明隐藏——隐形按钮仍会进 Tab 序，等于另一种「摸不着」。
  if (!hovered && !d.focused && !composerOpen) return null;

  return (
    // 悬在卡片下沿之外：卡内是「他正在干什么」，盖住它等于为了能操作而看不见要判断的东西。
    // 条本身不接事件（按钮各自 stopPropagation），`nodrag nopan` 只挡画布的拖拽/平移。
    <div className="nodrag nopan absolute top-full right-0 z-20 mt-1 flex items-center rounded-lg border border-border/70 bg-card/95 px-1 py-0.5 shadow-md backdrop-blur">
      <RunInterveneControls
        variant="node"
        conversationId={conversationId}
        executionId={executionId}
        runId={d.runId}
        runStatus={d.status}
        role={d.role}
        redirectCapable={redirectCapable}
        output={d.outputPreview}
        onComposerOpenChange={setComposerOpen}
      />
    </div>
  );
}
