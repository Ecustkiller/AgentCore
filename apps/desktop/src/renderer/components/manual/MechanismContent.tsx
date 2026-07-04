/**
 * 运行机制内容块（产品手册「运行机制」组的 4 个内容件）。
 *
 * 由 `pages/toolbox/manual/`（`ManualShell.tsx` 全屏壳）组合渲染——本模块只提供内容件，全屏壳 / 顶栏 /
 * 左侧目录 / Esc 退出都归手册页。原「团队运行机制」独立页（`/toolbox/mechanism`）已并入
 * 产品手册（IA 见 `docs/04-前端/前端UX设计.md §十二`）。
 *
 * 五件：① `HeroGraph` 看团队跑一遍（领衔活图：真实节点跑一遍 pending→running→completed
 * 生命周期，逐波点亮 + 入边粒子 + 终态闪，narration 随波推进）② `GraphLegend` 图例
 * ③ `RuntimePanorama` 运行时全景 ④ `CollaborationTurnFlow` 协作回合主线
 * ⑤ `MechanismScenarios` 机制场景——后三/四件都是 **真实**
 * `AgentNode`/`EndpointNode`/`StepEdge` + **真实** ELK 布局 + **真实** `WaveLanes` 波次泳道 +
 * 内嵌 fit-to-width（所见即聊天内嵌协作图）。共用 `EmbeddedGraphCanvas` 渲染核（hero 喂动态
 * statuses、场景喂静态 statuses）；机制场景 4 个常用形态常驻、其余「更多形态」点开再挂，
 * 按需懒挂载（`LazyMount`）避免一次性挂多个 ReactFlow。
 *
 * 开发 / AI 价值靠源码自身：各数据块（PHASES / TURN_FLOW / SCENARIOS）旁以注释保留实现入口。
 * SSE 事件族见 `docs/03-AI核心/执行引擎架构设计.md §十二` + `runtime/events.py`·
 * `types/events.ts`；前端执行态见 `docs/04-前端 §9.x`。
 */
export { RuntimePanorama } from "./mechanism/RuntimePanorama";
export { CollaborationTurnFlow } from "./mechanism/CollaborationTurnFlow";
export { GraphLegend } from "./mechanism/GraphLegend";
export { HeroGraph } from "./mechanism/HeroGraph";
export { MechanismScenarios } from "./mechanism/MechanismScenarios";
