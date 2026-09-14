/*
 * Promo STILLS source-of-truth — the 4 high-value collaboration diagrams used as
 * standalone promo screenshots (the领衔 App-shell composite is a separate Still, see
 * the curated-set note below), ported from the product manual (`MechanismContent.tsx`)
 * and rendered via Remotion `renderStill` (reusing the real AgentNode / EndpointNode
 * through GraphStage). The manual itself is left untouched — it stays tuned for
 * in-app reading (fit-to-width shrink, 520px cap), which is wrong for promo crops.
 *
 * Curated set (each proves a distinct, glance-legible, differentiating concept):
 *   fanout   并行扇出      — 纯并行（核心差异点）
 *   debate   圆桌辩论      — 主持人 + 正反两营对射 + CEO 裁决（头牌差异点）
 *   nested2  多层嵌套      — 委派分小队、深度 2，定格在「子队全员在跑」（团队感 + 活着）
 *   bigteam  团队协作全景  — 并行扇出 + 汇聚 + 圆桌辩论 + 嵌套一图（四形态全景·规模震撼）
 * 领衔图改用 App 外壳合成图（真实桌面壳 + hero 蝴蝶 DAG 执行中），见
 * `scenes/AppShellStill.tsx`——它满窗 1920×1080、不裁到图 bbox，故不在 STILL_DEFS 里：
 * 一张图同时回答「这是个真软件」+「一支团队正在里面并行协作」，补齐裸协作图缺的产品语境。
 * Dropped as low promo value / redundant: hero（并行+汇聚，与 fanout 同形且被 appshell/bigteam 覆盖）、
 * serial（线性链最不差异化）、running（与 fanout 同形）、revision（静图难 get）、nested（被 nested2 取代）。
 *
 * Two deliberate differences from the manual:
 *  1. No positions here — `scripts/precompute-stills-layout.mts` bakes each
 *     scenario's REAL ELK layout (incl. debate banding / sub-team drop / revision
 *     alignment) into `stillsLayout.ts`, so a still is layout-identical to the
 *     manual yet renders fully (no height cap, any DPI).
 *  2. Each scenario is frozen at a chosen HIGHLIGHT state (running + particle
 *     flow), not the manual's mostly-completed (一片绿) snapshot — the running
 *     "活着的并行" frame is what sells the product.
 *
 * Loosely typed `data: Record<string, unknown>` (same pattern as demo.ts) so this
 * module carries no `@/` runtime import and stays importable from the plain Node
 * precompute script under `tsx`.
 */

export type StillNodeType = "userInput" | "agent" | "captain";
export type StillEdgeKind = "dep" | "delegate" | "revision";
export type StillLayout = "leftright" | "tree";

export interface StillNode {
  id: string;
  type: StillNodeType;
  data: Record<string, unknown>;
}

export interface StillEdge {
  id: string;
  source: string;
  target: string;
  kind: StillEdgeKind;
}

export interface StillDef {
  /** Stable id → composition id `Still-<id>` + output `out/stills/<id>.png`. */
  id: string;
  label: string;
  /** ELK flow; serial chains read top-down with "tree" (matches the manual). */
  layout: StillLayout;
  /** Frame aspect (w/h) override; else derived from layout (4:3 land / 3:4 tree). */
  ratio?: number;
  nodes: StillNode[];
  edges: StillEdge[];
}

const INPUT_ID = "__input__";
const CAPTAIN_ID = "captain";

/** worker node: manual's AgentNodeData defaults, `extra` overrides per scenario. */
function agent(
  id: string,
  role: string,
  status: string,
  extra: Record<string, unknown> = {},
): StillNode {
  return {
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
  };
}

function input(label: string): StillNode {
  return {
    id: INPUT_ID,
    type: "userInput",
    data: { variant: "input", status: "completed", label },
  };
}

function captain(status: string, preview = ""): StillNode {
  return {
    id: CAPTAIN_ID,
    type: "captain",
    data: { variant: "captain", status, label: "", preview },
  };
}

function edge(
  source: string,
  target: string,
  kind: StillEdgeKind = "dep",
): StillEdge {
  return { id: `${source}->${target}`, source, target, kind };
}

export const STILL_DEFS: StillDef[] = [
  // ① 并行扇出 — 3 路里 2 跑 1 完，入边粒子在流。
  {
    id: "fanout",
    label: "并行扇出",
    layout: "leftright",
    nodes: [
      input("把这个需求拆成三块并行做"),
      agent("w1", "文件操作员", "completed", {
        task: "创建 greeting.txt 并写入测试输出",
        durationMs: 4200,
        toolCount: 3,
        modelPreference: "fast",
      }),
      agent("w2", "文件操作员", "running", {
        task: "创建测试笔记文件并记录测试过程",
        outputPreview: "正在写入测试过程记录…",
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("w3", "脚本编写员", "running", {
        task: "编写多行打印脚本并验证可运行",
        outputPreview: "正在编写并验证脚本…",
        toolCount: 5,
        modelPreference: "strong",
      }),
      captain("pending"),
    ],
    edges: [
      edge(INPUT_ID, "w1"),
      edge(INPUT_ID, "w2"),
      edge(INPUT_ID, "w3"),
      edge("w1", CAPTAIN_ID),
      edge("w2", CAPTAIN_ID),
      edge("w3", CAPTAIN_ID),
    ],
  },

  // ② 圆桌辩论 — 主持人定题 → 正方两人 / 反方两人同时 running、流式预览互相反驳 →
  // CEO 裁决。中列 4 个立场把图「拉高」到近 4:3，对射轴穿过辩论带（正营顶 ↔ 反营底，
  // 沿用影片圆桌辩论的连线画法）；主持人独占一列，故略宽于纯两方版（这是有意取舍）。
  {
    id: "debate",
    label: "圆桌辩论",
    layout: "leftright",
    nodes: [
      input("评估是否采用激进重构方案"),
      agent("mod", "主持人", "running", {
        task: "组织正反方就成本与时机正面交锋",
        outputPreview: "本轮焦点：激进重构收益 vs 稳健迭代风险，请各方正面回应…",
        modelPreference: "strong",
      }),
      // 正营（pro）
      agent("pro1", "架构师", "running", {
        stance: "pro",
        task: "论证采用激进重构的长期收益",
        outputPreview: "反驳稳健派：低估了技术债的长期复利成本…",
        modelPreference: "strong",
      }),
      agent("pro2", "增长策略", "running", {
        stance: "pro",
        task: "从增长角度支持激进重构",
        outputPreview: "关键路径可并行，激进方案更快兑现增长…",
        modelPreference: "fast",
      }),
      // 反营（con）
      agent("con1", "稳健派", "running", {
        stance: "con",
        task: "主张按里程碑稳健迭代",
        outputPreview: "反驳激进派：忽视了交付与回归风险的概率…",
        modelPreference: "strong",
      }),
      agent("con2", "成本分析", "running", {
        stance: "con",
        task: "评估算力与维护成本",
        outputPreview: "每一步都要保留可回退边界，控制一次性成本…",
        modelPreference: "fast",
      }),
      captain("pending"),
    ],
    edges: [
      edge(INPUT_ID, "mod"),
      edge("mod", "pro1"),
      edge("mod", "pro2"),
      edge("mod", "con1"),
      edge("mod", "con2"),
      edge("pro1", CAPTAIN_ID),
      edge("pro2", CAPTAIN_ID),
      edge("con1", CAPTAIN_ID),
      edge("con2", CAPTAIN_ID),
    ],
  },

  // ③ 多层嵌套（depth ≤ 2）— 子树整体下沉，组长已分派完，末层两名工程师都在跑。
  {
    id: "nested2",
    label: "多层嵌套",
    layout: "leftright",
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
      agent("eng1", "前端工程师", "running", {
        task: "实现预览页布局与卡片样式",
        outputPreview: "正在实现卡片样式与响应式栅格…",
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
      captain("pending"),
    ],
    edges: [
      edge(INPUT_ID, "mpm"),
      edge("mpm", "lead", "delegate"),
      edge("lead", "eng1", "delegate"),
      edge("lead", "eng2", "delegate"),
      edge("mpm", CAPTAIN_ID),
    ],
  },

  // ④ 团队协作全景（产品研发 · 团队的团队）— 五路并行调研 → PM 汇聚 → 决策圆桌（主持人定题 +
  // 正方2/反方2 对射辩论 → 方案决策一锤裁定）→ 两位方案负责人各自拉起一支子队（产品设计 →
  // 交互 / 视觉，技术架构 → 后端 / 数据）→ CEO 汇总。一张图覆盖并行扇出 + 汇聚 + 圆桌辩论 +
  // 嵌套委派四种协作形态，用高度换层数收窄画幅。定格在「圆桌 + 执行」并行波：五路调研 + PM
  // 已完成（绿），圆桌（主持人 + 四辩手 + 方案决策）+ 两位负责人 + 四个子任务全部 running（蓝，
  // 对射轴线进行中），CEO 待起。圆桌是「四方对射 → 方案决策单点裁定(4→1) → 双线落地(1→2)」的
  // 沙漏：辩论产出一个结论而非两条工作线，裁决再驱动整波执行（带状布局保证正反两营不交叉）。
  {
    id: "bigteam",
    label: "团队协作全景",
    layout: "leftright",
    nodes: [
      input("组建一支团队，把这个产品从调研做到方案"),
      // 波1 并行调研（五路，已完成）
      agent("m1", "市场调研", "completed", {
        task: "扫描目标市场规模与增长曲线",
        durationMs: 4200,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("m2", "竞品分析", "completed", {
        task: "拆解 3 家竞品的能力边界与定价",
        durationMs: 5600,
        toolCount: 3,
        modelPreference: "strong",
      }),
      agent("m3", "用户研究", "completed", {
        task: "访谈目标用户、提炼核心痛点",
        durationMs: 4800,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("m4", "技术预研", "completed", {
        task: "调研关键技术可行性与选型空间",
        durationMs: 5200,
        toolCount: 2,
        modelPreference: "strong",
      }),
      agent("m5", "风险评估", "completed", {
        task: "识别合规与交付风险并给出缓解",
        durationMs: 5000,
        toolCount: 2,
        modelPreference: "strong",
      }),
      // 波2 汇聚
      agent("pm", "产品经理", "completed", {
        task: "综合调研，定义产品方向与优先级",
        durationMs: 6400,
        toolCount: 1,
        modelPreference: "strong",
      }),
      // 波3 决策圆桌（主持人定题 + 正方2/反方2 同时辩论，对射轴线进行中）
      agent("mod", "主持人", "running", {
        task: "就产品方向组织正反方正面交锋",
        outputPreview: "本轮焦点：激进重构 vs 稳健迭代，请正反方正面回应…",
        modelPreference: "strong",
      }),
      agent("pro1", "激进派", "running", {
        stance: "pro",
        task: "论证一次到位重构的长期收益",
        outputPreview: "反驳稳健派：低估了技术债的长期复利…",
        modelPreference: "strong",
      }),
      agent("pro2", "增长视角", "running", {
        stance: "pro",
        task: "从增长角度支持激进方案",
        outputPreview: "关键路径可并行，更快兑现增长…",
        modelPreference: "fast",
      }),
      agent("con1", "稳健派", "running", {
        stance: "con",
        task: "主张按里程碑稳健迭代",
        outputPreview: "反驳激进派：忽视了交付与回归风险…",
        modelPreference: "strong",
      }),
      agent("con2", "成本视角", "running", {
        stance: "con",
        task: "评估算力与维护成本上限",
        outputPreview: "每一步都保留可回退边界，控制一次性成本…",
        modelPreference: "fast",
      }),
      // 方案决策：汇总正反结论、一锤裁定方向（圆桌的单一裁决出口，再驱动双线执行）
      agent("decide", "方案决策", "running", {
        task: "汇总正反结论，定夺产品方向",
        outputPreview: "采纳激进派的长期收益、保留稳健派的回退边界：定为分阶段重构…",
        modelPreference: "strong",
      }),
      // 波4 两位方案负责人（执行中，各带一支子队）
      agent("pd", "产品设计", "running", {
        task: "统筹产品方案与交互框架",
        outputPreview: "正在拆解核心流程的关键界面…",
        toolCount: 2,
        modelPreference: "strong",
      }),
      agent("arch", "技术架构", "running", {
        task: "统筹技术骨架与系统边界",
        outputPreview: "正在权衡 DAG 调度与共享工作区方案…",
        toolCount: 1,
        modelPreference: "strong",
      }),
      // 波5 子队（产品设计 → 交互 / 视觉，技术架构 → 后端 / 数据）
      agent("ix", "交互设计", "running", {
        task: "细化关键路径的交互与状态反馈",
        outputPreview: "正在打磨多 Agent 进度可视化…",
        toolCount: 1,
        modelPreference: "fast",
        isSubtask: true,
      }),
      agent("vd", "视觉规范", "running", {
        task: "定义色板、图标与组件规范",
        outputPreview: "正在统一节点状态配色…",
        toolCount: 1,
        modelPreference: "fast",
        isSubtask: true,
      }),
      agent("be", "后端选型", "running", {
        task: "评估后端框架与消息通道",
        outputPreview: "正在对比候选框架…",
        toolCount: 2,
        modelPreference: "fast",
        isSubtask: true,
      }),
      agent("dm", "数据建模", "running", {
        task: "设计核心数据模型与索引",
        outputPreview: "正在建模会话与运行态…",
        toolCount: 1,
        modelPreference: "fast",
        isSubtask: true,
      }),
      captain("pending"),
    ],
    edges: [
      edge(INPUT_ID, "m1"),
      edge(INPUT_ID, "m2"),
      edge(INPUT_ID, "m3"),
      edge(INPUT_ID, "m4"),
      edge(INPUT_ID, "m5"),
      edge("m1", "pm"),
      edge("m2", "pm"),
      edge("m3", "pm"),
      edge("m4", "pm"),
      edge("m5", "pm"),
      edge("pm", "mod"),
      edge("mod", "pro1"),
      edge("mod", "pro2"),
      edge("mod", "con1"),
      edge("mod", "con2"),
      edge("pro1", "decide"),
      edge("pro2", "decide"),
      edge("con1", "decide"),
      edge("con2", "decide"),
      edge("decide", "pd"),
      edge("decide", "arch"),
      edge("pd", "ix", "delegate"),
      edge("pd", "vd", "delegate"),
      edge("arch", "be", "delegate"),
      edge("arch", "dm", "delegate"),
      edge("pd", CAPTAIN_ID),
      edge("arch", CAPTAIN_ID),
    ],
  },
];

// ⑤ 团队协作全景·方图 — bigteam 的移动端孪生：同一张图、同样的 20 节点与连线，只把 ELK
// 流向从 leftright 改成 top-down（tree），从「8 列超宽」收成「最宽一排 5 个」的近方形，缩到
// 手机屏宽后节点约大 30%；按 1:1 方图裁切（见 Root / stillRatio：top-down 后内容近 1.27:1，
// 方图留白最少、最饱满）。对射轴线会自动转成横版（四辩手在此排成一行）。复用 bigteam 的
// nodes/edges（只读引用，不复制），仅 id/label/ratio/layout 不同——横版做网页头图、方图做
// 手机分享，各取所长。
const bigteamDef = STILL_DEFS.find((d) => d.id === "bigteam");
if (bigteamDef) {
  STILL_DEFS.push({
    ...bigteamDef,
    id: "bigteam-tall",
    label: "团队协作全景·方图",
    layout: "tree",
    ratio: 1,
  });
}

/** Scenario ids in render order (keep `scripts/render-stills.mjs` in sync). */
export const STILL_IDS: string[] = STILL_DEFS.map((d) => d.id);
