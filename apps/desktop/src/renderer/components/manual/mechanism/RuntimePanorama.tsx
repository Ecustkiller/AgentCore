import { CheckCircle2, ChevronRight, Package, Workflow } from "lucide-react";
import { Fragment } from "react";

// 实现入口（喂 AI，不渲染）：Prepare=runtime/pipeline.py · Execute=runtime/engine.py·runs/ ·
// Finalize=conversation/service.py
const PHASES: { title: string; icon: typeof Package; desc: string }[] = [
  {
    title: "Prepare",
    icon: Package,
    desc: "装配 CEO 工具集（只读/检索 + delegate）、注入会话历史；历史只回放文本，工具 I/O 不进 LLM 上下文。",
  },
  {
    title: "Execute（ReAct 循环）",
    icon: Workflow,
    desc: "CEO 思考 →（按需）delegate 组团 → WaveScheduler 跑 DAG → worker 执行 → CEO 收尾；收敛治理防机械循环。",
  },
  {
    title: "Finalize",
    icon: CheckCircle2,
    desc: "消息落库、用量计费、标题生成；断连也「能存多少存多少」，不全有或全无。",
  },
];

/** ① 运行时全景：Prepare → Execute → Finalize 三阶段。 */
export function RuntimePanorama() {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
      {PHASES.map((p, i) => {
        const Icon = p.icon;
        return (
          <Fragment key={p.title}>
            <div className="flex-1 rounded-xl border border-border bg-card p-4">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon size={16} />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                {p.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {p.desc}
              </p>
            </div>
            {i < PHASES.length - 1 && (
              <ChevronRight
                size={16}
                className="hidden shrink-0 self-center text-muted-foreground lg:block"
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
