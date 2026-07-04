import type { ElkGraphLayout } from "@/lib/graph-layout-utils";
import type { RunStatus } from "@/stores/execution";
import type { GraphEdge } from "@/stores/graph";
export interface PreviewNode {
  id: string;
  type: "agent" | "userInput" | "captain";
  data: Record<string, unknown>;
}

export interface Scenario {
  title: string;
  desc: string;
  /** ELK 布局；缺省走左右流（与产品默认一致）。串行链用 "tree" 自上而下读。 */
  layout?: ElkGraphLayout;
  /** 进阶形态：默认折进「更多形态」（执行中态 / 多层嵌套 / 热修 / 超大团队），常用四式
   * （并行 / 串行 / 辩论 / 嵌套小队）常驻，避免画廊读起来像测试网格。 */
  advanced?: boolean;
  nodes: PreviewNode[];
  edges: GraphEdge[];
}

/** worker 节点：默认补齐 AgentNodeData 必填项，`extra` 覆盖差异化字段。 */
const agent = (
  id: string,
  role: string,
  status: RunStatus,
  extra: Record<string, unknown> = {},
): PreviewNode => ({
  id,
  type: "agent",
  data: {
    agentId: id,
    runId: id,
    role,
    status,
    isAnimating: status === "running",
    task: "",
    outputPreview: "",
    tokenCount: 0,
    toolCount: 0,
    focused: false,
    ...extra,
  },
});

const input = (label: string): PreviewNode => ({
  id: "__input__",
  type: "userInput",
  data: { variant: "input", status: "completed", label },
});

const captain = (id: string, status: RunStatus, preview = ""): PreviewNode => ({
  id,
  type: "captain",
  data: { variant: "captain", status, label: "", preview },
});

const edge = (
  source: string,
  target: string,
  kind: "dep" | "delegate" | "revision" = "dep",
): GraphEdge => ({ id: `${source}->${target}`, source, target, kind });

export const SCENARIOS: Scenario[] = [
  {
    title: "并行扇出（fan-out）",
    desc: "三个 worker 的 depends_on 均为空 → WaveScheduler 判为同一波、asyncio 并发起跑；全部完成后 CEO 汇聚点收尾。并行度是数据（depends_on）不是模式。",
    // 实现：runs/wave.py
    nodes: [
      input("把这个需求拆成三块并行做"),
      agent("w1", "文件操作员", "completed", {
        task: "创建 greeting.txt 并写入测试输出",
        durationMs: 4200,
        toolCount: 3,
        modelPreference: "fast",
      }),
      agent("w2", "文件操作员", "completed", {
        task: "创建测试笔记文件并记录测试过程",
        durationMs: 5100,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("w3", "脚本编写员", "completed", {
        task: "编写多行打印脚本并验证可运行",
        durationMs: 6800,
        toolCount: 5,
        modelPreference: "strong",
      }),
      captain(
        "cap",
        "completed",
        "三个文件都已在工作区根目录创建完成，均可直接查看与运行。",
      ),
    ],
    edges: [
      edge("__input__", "w1"),
      edge("__input__", "w2"),
      edge("__input__", "w3"),
      edge("w1", "cap"),
      edge("w2", "cap"),
      edge("w3", "cap"),
    ],
  },
  {
    title: "串行流水线（depends_on 链）",
    layout: "tree",
    desc: "调研 → 分析 → 撰写：每个节点 depends_on 上一个，调度器逐个解锁；上游 RunState.content 按 result_handling（默认全文）注入下游。树形布局自上而下读更顺。",
    // 实现：runs/executor.py
    nodes: [
      input("调研近 7 日成本趋势并产出一段摘要"),
      agent("s1", "调研员", "completed", {
        task: "检索成本相关数据源与口径",
        durationMs: 3400,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("s2", "数据分析师", "completed", {
        task: "汇总近 7 日成本趋势、定位异常点",
        durationMs: 5200,
        toolCount: 1,
        modelPreference: "strong",
      }),
      agent("s3", "文案", "completed", {
        task: "据分析结论撰写一段可读摘要",
        durationMs: 2600,
        modelPreference: "fast",
      }),
      captain("scap", "completed", "成本趋势摘要已生成，关键异常已标注。"),
    ],
    edges: [
      edge("__input__", "s1"),
      edge("s1", "s2"),
      edge("s2", "s3"),
      edge("s3", "scap"),
    ],
  },
  {
    title: "执行中（流式输出 · 待定 · 深度思考）",
    advanced: true,
    desc: "运行中节点带脉冲 + run_output 流式预览 + 光标，入边走 primary 粒子流；未解锁节点灰显 pending；reasoning=max 的 worker 带「深度」徽章。",
    // 实现：runtime/events.py
    nodes: [
      input("分析近 7 日成本趋势并产出一段摘要"),
      agent("r1", "调研员", "running", {
        task: "检索最佳实践",
        outputPreview:
          "正在检索 React Flow 自定义节点的最佳实践，已找到 3 篇相关文档，正在归纳关键结论",
        toolCount: 2,
        modelPreference: "strong",
        reasoningEffort: "max",
      }),
      agent("r2", "数据分析师", "completed", {
        task: "汇总近 7 日成本趋势数据",
        durationMs: 3200,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("r3", "文案", "pending", {
        task: "根据分析结论撰写一段摘要",
        modelPreference: "fast",
      }),
      captain("cap2", "pending", ""),
    ],
    edges: [
      edge("__input__", "r1"),
      edge("__input__", "r2"),
      edge("__input__", "r3"),
      edge("r1", "cap2"),
      edge("r2", "cap2"),
      edge("r3", "cap2"),
    ],
  },
  {
    title: "辩论 / 审查（正方 · 反方）",
    desc: "带 stance 标记的普通 AGENT DAG（非独立模式）。ELK considerModelOrder 把正 / 反分带对置，再汇聚到 CEO 裁决；立场徽章用 primary 令牌、与状态色解耦。",
    // 实现：lib/elk-layout.ts
    nodes: [
      input("评估是否采用激进重构方案"),
      agent("pro", "架构师", "completed", {
        stance: "pro",
        task: "论证采用激进重构方案的收益与可行性",
        durationMs: 5000,
        modelPreference: "strong",
      }),
      agent("con", "架构师", "completed", {
        stance: "con",
        task: "论证保持稳健迭代、反对激进重构的理由",
        durationMs: 4800,
        modelPreference: "strong",
      }),
      captain(
        "cap3",
        "completed",
        "综合正反双方论点，建议分阶段推进：先在隔离分支验证关键风险，再决定是否全量切换。",
      ),
    ],
    edges: [
      edge("__input__", "pro"),
      edge("__input__", "con"),
      edge("pro", "cap3"),
      edge("con", "cap3"),
    ],
  },
  {
    title: "嵌套小队（can_delegate，一层）+ 失败",
    desc: "项目经理被标 can_delegate → 获得绑定自身的 delegate，再带一支小队（虚线委派边 + 子任务徽章）。子 worker 失败按 on_failure 处理，红环 + 红叉，不拖垮整 DAG。",
    // 实现：runs/executor.py
    nodes: [
      input("实现一个新设置页，前端 + 测试分工完成"),
      agent("pm", "项目经理", "completed", {
        task: "拆解任务并协调子团队",
        durationMs: 8000,
        toolCount: 1,
        modelPreference: "strong",
      }),
      agent("fe", "前端开发", "completed", {
        task: "实现页面组件与样式",
        durationMs: 6000,
        toolCount: 4,
        modelPreference: "strong",
        isSubtask: true,
      }),
      agent("qa", "测试", "failed", {
        task: "为新页面编写单元测试",
        modelPreference: "fast",
        isSubtask: true,
      }),
      captain(
        "cap4",
        "completed",
        "页面主体已完成并通过自测；测试子任务失败，待修复后补单测。",
      ),
    ],
    edges: [
      edge("__input__", "pm"),
      edge("pm", "fe", "delegate"),
      edge("pm", "qa", "delegate"),
      edge("pm", "cap4"),
    ],
  },
  {
    title: "多层嵌套（depth ≤ 2）+ 子树整体下沉",
    advanced: true,
    desc: "CEO(0) → worker(1) → sub-worker(2)：深度 2 永不再获 delegate（硬上限封死递归）。整条委派子树作为整体下沉到主干线之下，CEO 汇聚点恒在末层、不被横穿。",
    // 实现：runs/constants.py
    nodes: [
      input("拆解并实现协作图，前端再分一层小队"),
      agent("mpm", "项目经理", "completed", {
        task: "拆解任务、协调前端小队",
        durationMs: 9000,
        toolCount: 1,
        modelPreference: "strong",
      }),
      agent("lead", "前端组长", "completed", {
        task: "细分前端工作并分派给队员",
        durationMs: 6500,
        toolCount: 2,
        modelPreference: "strong",
        isSubtask: true,
      }),
      agent("eng1", "前端工程师", "completed", {
        task: "实现预览页布局与卡片样式",
        durationMs: 5200,
        toolCount: 4,
        modelPreference: "fast",
        isSubtask: true,
      }),
      agent("eng2", "前端工程师", "running", {
        task: "接入真实 ELK 布局并联调",
        outputPreview: "正在把 fit-to-width 接到内嵌画布，已联通 2/3…",
        toolCount: 2,
        modelPreference: "fast",
        isSubtask: true,
      }),
      captain("mcap", "pending", ""),
    ],
    edges: [
      edge("__input__", "mpm"),
      edge("mpm", "lead", "delegate"),
      edge("lead", "eng1", "delegate"),
      edge("lead", "eng2", "delegate"),
      edge("mpm", "mcap"),
    ],
  },
  {
    title: "多轮热修（修订 vN 版本链）",
    advanced: true,
    desc: "后续消息要求返工时，CEO 经 revise 唤回原队员带现场记忆续写，图上挂一条点线「修订 vN」版本链——是同一节点的新版本，不是新队员（留人双 miss 才回落重派）。",
    // 实现：tools/builtin/revise.py
    nodes: [
      input("把上一版报告的第 2 章重写得更详细"),
      agent("orig", "撰写员", "completed", {
        task: "撰写报告初稿",
        durationMs: 6400,
        toolCount: 2,
        modelPreference: "strong",
      }),
      agent("rev", "撰写员", "completed", {
        task: "按反馈重写第 2 章并扩充论据",
        durationMs: 3800,
        toolCount: 1,
        modelPreference: "strong",
        isRevision: true,
        revision: 2,
      }),
      captain("rcap", "completed", "已交付重写后的第 2 章，其余章节沿用初稿。"),
    ],
    edges: [
      edge("__input__", "orig"),
      edge("orig", "rcap"),
      edge("orig", "rev", "revision"),
    ],
  },
  {
    title: "超大团队（9 路并行 · 执行中）",
    advanced: true,
    desc: "并行度拉满（max_parallel = 10 上限内）：横向填满列宽、纵向超过内嵌高度上限(520) → 顶对齐 + 底部渐隐示意「还有更多」，看全图进全屏。也用来检验小缩放下节点是否仍可读。",
    // 实现：runs/wave.py
    nodes: [
      input("把这份长报告拆成 9 块并行润色"),
      agent("b1", "润色员", "completed", {
        task: "润色第 1 章：引言",
        durationMs: 2600,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b2", "润色员", "completed", {
        task: "润色第 2 章：背景",
        durationMs: 3100,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b3", "润色员", "completed", {
        task: "润色第 3 章：方法",
        durationMs: 4200,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("b4", "润色员", "completed", {
        task: "润色第 4 章：实验",
        durationMs: 3800,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b5", "润色员", "completed", {
        task: "润色第 5 章：结果",
        durationMs: 2900,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b6", "润色员", "completed", {
        task: "润色第 6 章：讨论",
        durationMs: 3300,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("b7", "润色员", "running", {
        task: "润色第 7 章：相关工作",
        outputPreview: "正在统一术语与时态，已处理 12 处表述，剩余约 1/3…",
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b8", "润色员", "pending", {
        task: "润色第 8 章：局限性",
        modelPreference: "fast",
      }),
      agent("b9", "校对员", "failed", {
        task: "全文交叉引用与编号校对",
        modelPreference: "strong",
      }),
      captain("bcap", "pending", ""),
    ],
    edges: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"].flatMap(
      (id) => [edge("__input__", id), edge(id, "bcap")],
    ),
  },
];
