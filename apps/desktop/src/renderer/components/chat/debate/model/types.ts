import type { Stance } from "@/stores/execution";
import type { RunNode } from "@/stores/execution";
import type {
  DebateBriefInfo,
  DebateResultPayload,
  DebateSideInfo,
  DebateUserInterjection,
  DebateVerdict,
} from "@/types/events";

export type DebateForm = DebateResultPayload["form"];

/**
 * 一轮里的一方：身份 (名 + 稳定身份色) + 其辩手 run。`run` 收场/已裁判轮由 `run_id`
 * 直取，进行中当前轮由 run 树标签匹配；都解析到同一辩手节点 (发言全文在其
 * `agent.outputChunks`)。`stance` 仅 2 方对称攻防有值 (驱动左右对开)，多方为 null。
 */
export interface DebateSideModel {
  key: string;
  /** 语义 side key (`pro`/`con`/`a`…，= 契约 `DebateRoundSide.key`)，区别于 `key` (run_id，
   *  React key 用)。供 L3 交锋边「谁驳谁」按它精确高亮对应的发言格 (名字可能撞 / 不稳定)。 */
  sideKey: string;
  name: string;
  stance: Stance | null;
  /** 身份色 `var(--agent-N)` (按 name hash，live↔收场恒定)；内联使用，遵 color-tokens。 */
  colorVar: string;
  /** 该方辩手的模型覆写 (真·多模型辩论，`provider/model` 或空)：收场由 roster (`debate.sides`)
   *  按 sideKey 映射补回，进行中 roster 未到 → 空 (不显模型徽章)。{@link modelVendorLabel} 映射成
   *  友好厂商名供发言格标「豆包 / DeepSeek」。 */
  model: string;
  run: RunNode | null;
}

/**
 * 一条论点级交锋边 (L3 谁驳谁)，已解析成可直接渲染的展示态：`from`/`to` 双方的显示名 + 稳定
 * 身份色 + 反驳要点。由 {@link resolveClashes} 把契约的 `DebateClash` (语义 key 引用) 据本轮
 * `sides` 映射成名字/色，让叙事线把「平铺发言」升级为可读的交锋关系，而非靠用户脑补谁驳了谁。
 */
export interface DebateClashView {
  /** 语义 side key (匹配 {@link DebateSideModel.sideKey})，供点击交锋边时高亮对应发言格。 */
  fromKey: string;
  fromName: string;
  fromColorVar: string;
  toKey: string;
  toName: string;
  toColorVar: string;
  point: string;
}

/**
 * 一条质询问答（质询回合 P1）已解析成可渲染的展示态：被质询方 `target` 的显示名 + 身份色 +
 * 主持人的必答问题清单 + 该方作答的辩手 run（{@link DebateSideModel.run} 同源，取作答全文）。
 * 由 {@link resolveCrossExam} 把契约的 {@link DebateCrossExam}（语义 key + answer_run_id 引用）据
 * 本轮 `sides` 与执行图 runs 映射而成——让「主持人当面质询、某方回避/接招」在群聊里可见。
 */
export interface DebateCrossExamView {
  /** 被质询方语义 key（匹配 {@link DebateSideModel.sideKey}）。 */
  targetKey: string;
  targetName: string;
  targetColorVar: string;
  questions: string[];
  /** 该方作答的辩手 run（`answer_run_id` 解析）——作答全文在其 `agent.outputChunks`；未解析到（旧
   *  产物 / 作答失败无 run）为 null。 */
  answerRun: RunNode | null;
  /** 是否成功答出（回避 / 失败 → false，前端标注「未正面回答」）。 */
  ok: boolean;
}

/**
 * 一方某轮/累计的记分（记分裁判 P2）已解析成展示态：身份（名 + 稳定身份色）+ 三维分 + 罚分清单 +
 * 净分。由 {@link resolveScores}（逐轮）/ {@link tallyScores}（累计）把契约的 {@link DebateRoundScore}
 * （语义 key 引用）据本轮 `sides` 映射成名字/色——让「回避与被戳穿被记分、倾向由记分驱动」可见。
 */
export interface DebateScoreView {
  sideKey: string;
  name: string;
  colorVar: string;
  argument: number;
  engagement: number;
  evidence: number;
  penalties: string[];
  note: string;
  /** 净得分（三维和减罚分，后端算好、前端直用不重算，可为负）。 */
  total: number;
}

/**
 * 一方的【结辩陈词】（阶段化发言角色 P4 · 结辩收束）已解析成可渲染的展示态：身份（名 + 稳定身份色）+
 * 结辩辩手 run（陈词全文在其 `agent.outputChunks`，与发言格同源）+ 是否成功产出。由 {@link resolveClosings}
 * 把契约的 {@link DebateClosing}（语义 key + run_id 引用）据执行图 runs 映射而成——让「辩已辩尽、各方最后
 * 亮胜负手」在收场处可见（辩手自己的 advocacy 收束，与裁判中立的 `brief.decisive` 正交并存）。
 */
export interface DebateClosingView {
  sideKey: string;
  name: string;
  colorVar: string;
  /** 结辩辩手 run（`run_id` 解析）——陈词全文在其 `agent.outputChunks`；未解析到（旧产物 / 失败无 run）
   *  为 null。 */
  run: RunNode | null;
  /** 是否成功产出结辩（失败 / 无 session → false，前端标「未产出结辩」）。 */
  ok: boolean;
}

/**
 * 一轮的规范化单元——无论 live (verdict 可空、发言流式) 还是收场 (verdict 必有、全文已定)
 * 都是这一个形状。`inFlight` = 该轮尚未裁判 (live 的当前轮)。`clashes` = 本轮 L3 交锋边
 * (已解析名字/色)，进行中当前轮恒空 (尚未裁判)。
 */
export interface DebateRoundModel {
  roundNo: number;
  focus: string;
  summary: string;
  verdict: DebateVerdict | null;
  sides: DebateSideModel[];
  clashes: DebateClashView[];
  inFlight: boolean;
  /** 驱动本轮的用户【追问】(辩论编排设计.md §6.3)。收场以
   *  权威 `debate_result.rounds[*].user_interjections` 为准；进行中恒空——live 孪生
   *  {@link DebateNarrativeRound} 刻意不携带（守 conformance 不动），追问在收场复盘可见。 */
  userInterjections: DebateUserInterjection[];
  /** 本轮质询环节的问答（质询回合 P1）。收场以权威 `debate_result.rounds[*].cross_exam` 为准；
   *  进行中恒空——live 孪生刻意不携带（与 `userInterjections` 同策），质询在收场复盘可见。 */
  crossExam: DebateCrossExamView[];
  /** 本轮记分裁判的各方得分（记分裁判 P2）。收场以权威 `debate_result.rounds[*].scores` 为准；
   *  进行中恒空（live 孪生不携带）。空=未开启记分（快速对碰 / 旧产物），前端不渲染比分。 */
  scores: DebateScoreView[];
}

/**
 * 规范化的辩论视图模型——常驻外壳据此渲染。`settled` (收场) 才有 `motion`/`brief`/`sides`
 * (roster)/`stopReason`，进行中为 null，让壳头/简报/辩题在收场处**淡入**而非整卡重挂。
 */
export interface DebateModel {
  form: DebateForm;
  motion: string | null;
  stopReason: string | null;
  moderatorRunId: string | null;
  narrativeFirst: boolean;
  rounds: DebateRoundModel[];
  brief: DebateBriefInfo | null;
  sides: DebateSideInfo[] | null;
  /** 各方结辩陈词（阶段化发言角色 P4 · 结辩收束）：收场以权威 `debate_result.closings` 为准、据 run_id
   *  解析陈词 run；进行中恒空（结辩是收场后一次性 beat，live 无孪生）。空=未开启结辩（快速对碰 / 圆桌 /
   *  旧产物），前端不渲染结辩区。 */
  closings: DebateClosingView[];
  /** 主持人开场白（收场权威产出）：顶部「会说话的主持人」气泡。空/缺省（进行中、旧产物、未产出）→
   *  由 {@link DebateStream} 回落到 motion+首轮焦点拼出的模板开场白，故这里 null 不代表不渲染开场。 */
  opening: string | null;
  settled: boolean;
}

/** 参辩名册的一方：语义 `sideKey` + 展示名 + 身份色——站队 / 拍板按 `sideKey` 记录用户取舍。 */
export interface DebateRosterSide {
  sideKey: string;
  name: string;
  colorVar: string;
}

/** 一轮的「人话」状态展示态：`label` 是融合后的一句话、`hint` 是悬浮解释（它怎么判出来 / 怎么读）。 */
export interface RoundVerdictView {
  label: string;
  hint: string;
}
