import type { DebateSignal } from "@/components/ui/tone-presets";
import { agentColorVar } from "@/lib/agentIdentity";
import {
  type DebateGroup,
  type Execution,
  type RunNode,
  STANCE_META,
  type Stance,
  debateGroups,
  debateLiveRounds,
} from "@/stores/execution";
import type {
  DebateBriefInfo,
  DebateClash,
  DebateResultPayload,
  DebateRoundSide,
  DebateSideInfo,
  DebateVerdict,
} from "@/types/events";

/**
 * 辩论视图模型 (方案 A · 单一来源) —— 把「进行中」(transport-only `debateRounds` +
 * 辩手 run 树) 与「收场」(权威 `debate_result`) **收敛成同一个规范化模型**，让一个常驻
 * 外壳全程渲染、不再 live↔收场 卸载重挂 (跳跃的根因)。
 *
 * 这能成立是因为后端**故意**把进行中逐轮 ({@link DebateNarrativeRound}) 与收场逐轮
 * ({@link DebateRoundInfo}) 设计成同构孪生 (辩论编排设计.md §7.4 · `verdict` 可空是唯一
 * 差别)；两套前端树本是实现产物，违背了数据模型意图。
 *
 * **固有接缝 (非补丁)**：进行中、当前那一轮 (只定了焦点、尚未裁判) 没有权威的
 * round→`run_id` 映射——主持人是「先报焦点、再派辩手」，宣布焦点时辩手 run 尚未创建。
 * 故这一轮的发言**必须**从 run 树按 `round`/`stance` 标签取回 ({@link debateGroups} /
 * {@link debateLiveRounds})；已裁判轮与收场轮则走 `run_id` 直取。本模块把两路归一。
 */

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
  settled: boolean;
}

/** 把一个回合的 {@link Execution} 归一成 {@link DebateModel}；非辩论 / 进行中尚无任何
 * 轮次 → null (不渲染)。收场以 `debate` 为权威；否则从 `debateRounds` + run 树重建。 */
export function toDebateModel(execution: Execution): DebateModel | null {
  if (execution.debate) {
    return settledModel(execution, execution.debate);
  }
  return liveModel(execution);
}

/** 收场：以权威 `debate_result` 为准，逐轮 `sides` 由 `run_id` 直取辩手节点。 */
function settledModel(
  execution: Execution,
  debate: DebateResultPayload,
): DebateModel {
  // roster (debate.sides) 是模型覆写的权威源：按语义 key 映射，让每轮发言格按 sideKey 补回模型
  // (真·多模型辩论的「谁是哪个模型」)。进行中无 roster → 该路不经此、模型留空。
  const modelBySideKey = new Map(
    debate.sides.map((s) => [s.key, s.model ?? ""]),
  );
  const rounds: DebateRoundModel[] = debate.rounds.map((round) => ({
    roundNo: round.round_no,
    focus: round.focus,
    summary: round.summary,
    verdict: round.verdict,
    inFlight: false,
    clashes: resolveClashes(round.clashes, round.sides),
    sides: round.sides.map((side): DebateSideModel => {
      const run = execution.runs.find((r) => r.id === side.run_id) ?? null;
      return {
        // 收场逐轮发言格的 React key 必须 = 进行中的 `run.id`，二者跨 live→收场 复用同一
        // 实例 → 发言不重挂/不闪。后端两路本就同 id：进行中第 k 轮辩手 run 与收场
        // `side.run_id` 均为 `{moderator}_r{k}_{side.key}` (首轮为同一 build_run_plan 节点 id)。
        key: side.run_id || side.key,
        sideKey: side.key,
        name: side.name,
        stance: run?.stance ?? null,
        colorVar: agentColorVar(side.name),
        model: modelBySideKey.get(side.key) ?? "",
        run,
      };
    }),
  }));
  return {
    form: debate.form,
    motion: debate.motion,
    stopReason: debate.stop_reason,
    moderatorRunId: debate.moderator_run_id,
    narrativeFirst: debate.narrative_first,
    rounds,
    brief: debate.brief,
    sides: debate.sides,
    settled: true,
  };
}

/** 进行中：2 方走 {@link debateGroups} 左右对开，多方走 {@link debateLiveRounds}；逐轮的
 * 焦点/小结/裁判 由 `debateRounds` (主持人增量) 按轮号合并。无任何轮次 → null。 */
function liveModel(execution: Execution): DebateModel | null {
  const groups = debateGroups(execution);
  const rounds =
    groups.length > 0
      ? liveTwoSideRounds(execution, groups)
      : liveMultiSideRounds(execution);
  if (rounds.length === 0) return null;
  return {
    form: liveForm(execution),
    motion: null,
    stopReason: null,
    moderatorRunId: null,
    narrativeFirst: false,
    rounds,
    brief: null,
    sides: null,
    settled: false,
  };
}

const DEBATE_GROUP_PREFIX = "debate:";

/** 进行中形态：从辩手 run 的 `group=debate:{form}` 标签推导 (收场前无 `debate_result`)。 */
function liveForm(execution: Execution): DebateForm {
  const tagged = execution.runs.find((r) =>
    r.group?.startsWith(DEBATE_GROUP_PREFIX),
  );
  const raw = tagged?.group?.slice(DEBATE_GROUP_PREFIX.length);
  if (raw === "red_team" || raw === "roundtable" || raw === "debate") {
    return raw;
  }
  return "debate";
}

function narrativeFor(execution: Execution, roundNo: number) {
  return execution.debateRounds.find((r) => r.round_no === roundNo) ?? null;
}

/** 2 方正反进行中逐轮：跨 group 按轮号归一 (现状单 group)。无 round 标记的旧批次落到
 * 轮号 0 = 一条扁平正/反轮 ({@link DebateRoundModel} 由消费方据 `roundNo<1 && !focus` 判扁平)。 */
function liveTwoSideRounds(
  execution: Execution,
  groups: DebateGroup[],
): DebateRoundModel[] {
  const roundNos = new Set<number>();
  for (const group of groups) {
    for (const bucket of group.rounds) roundNos.add(bucket.round);
  }
  for (const round of execution.debateRounds) roundNos.add(round.round_no);

  const rounds: DebateRoundModel[] = [];
  for (const roundNo of [...roundNos].sort((a, b) => a - b)) {
    const sides: DebateSideModel[] = [];
    for (const group of groups) {
      const bucket = group.rounds.find((b) => b.round === roundNo);
      if (!bucket) continue;
      for (const run of bucket.pro) sides.push(twoSide(run, "pro"));
      for (const run of bucket.con) sides.push(twoSide(run, "con"));
    }
    const narr = narrativeFor(execution, roundNo);
    rounds.push({
      roundNo,
      focus: narr?.focus ?? "",
      summary: narr?.summary ?? "",
      verdict: narr?.verdict ?? null,
      inFlight: !narr?.verdict,
      clashes: resolveClashes(narr?.clashes, narr?.sides ?? []),
      sides,
    });
  }
  return rounds;
}

function twoSide(run: RunNode, stance: Stance): DebateSideModel {
  const name = STANCE_META[stance].label;
  // 2 方正反的语义 key 即 stance (pro/con)，与裁判 clash 的 from/to key 同名 → 可精确高亮。
  return {
    key: run.id,
    sideKey: stance,
    name,
    stance,
    colorVar: agentColorVar(name),
    // 进行中无 roster（模型覆写权威源），故留空；收场由 settledModel 按 sideKey 补回。
    model: "",
    run,
  };
}

/** 多方 (圆桌 / 红队 / 3+方) 进行中逐轮：发言由 {@link debateLiveRounds} (续写 revision
 * 重建) 提供，焦点/小结/裁判 由 `debateRounds` 按轮号合并。无 stance → 不分左右。 */
function liveMultiSideRounds(execution: Execution): DebateRoundModel[] {
  const speech = debateLiveRounds(execution);
  const roundNos = new Set<number>();
  for (const round of speech) roundNos.add(round.round);
  for (const round of execution.debateRounds) roundNos.add(round.round_no);

  const rounds: DebateRoundModel[] = [];
  for (const roundNo of [...roundNos].sort((a, b) => a - b)) {
    const runs = speech.find((r) => r.round === roundNo)?.runs ?? [];
    const narr = narrativeFor(execution, roundNo);
    // 多方进行中发言格来自 run 树 (无语义 key)，靠本轮 narr.sides 的 run_id→key 反查补回，
    // 让 L3 交锋边能按语义 key 高亮对应发言格 (与收场同口径)。
    const keyByRunId = new Map(
      (narr?.sides ?? []).map((s) => [s.run_id, s.key]),
    );
    rounds.push({
      roundNo,
      focus: narr?.focus ?? "",
      summary: narr?.summary ?? "",
      verdict: narr?.verdict ?? null,
      inFlight: !narr?.verdict,
      clashes: resolveClashes(narr?.clashes, narr?.sides ?? []),
      sides: runs.map((run) =>
        multiSide(run, execution, keyByRunId.get(run.id) ?? ""),
      ),
    });
  }
  return rounds;
}

function multiSide(
  run: RunNode,
  execution: Execution,
  sideKey: string,
): DebateSideModel {
  const role =
    execution.agents.find((a) => a.id === run.agentId)?.role ?? run.agentId;
  return {
    key: run.id,
    sideKey,
    name: role,
    stance: null,
    colorVar: agentColorVar(role),
    // 进行中无 roster；收场由 settledModel 按 sideKey 补回模型。
    model: "",
    run,
  };
}

/** 把契约的 {@link DebateClash} (语义 key 引用) 据本轮 `sides` 解析成可渲染的
 * {@link DebateClashView} (名字 + 身份色)。引用不到 side 的边 (理论上后端已校验，防御性) 丢弃,
 * 名字/色与 {@link DebateSideModel} 同源 ({@link agentColorVar} by name)，让交锋边与发言格同色。 */
function resolveClashes(
  clashes: readonly DebateClash[] | undefined,
  sides: readonly DebateRoundSide[],
): DebateClashView[] {
  if (!clashes || clashes.length === 0) return [];
  const keyToName = new Map(sides.map((s) => [s.key, s.name]));
  const out: DebateClashView[] = [];
  for (const c of clashes) {
    const fromName = keyToName.get(c.from_key);
    const toName = keyToName.get(c.to_key);
    if (!fromName || !toName) continue;
    out.push({
      fromKey: c.from_key,
      fromName,
      fromColorVar: agentColorVar(fromName),
      toKey: c.to_key,
      toName,
      toColorVar: agentColorVar(toName),
      point: c.point,
    });
  }
  return out;
}

/** 一条扁平旧批次轮 (无主持人逐轮叙事)：轮号 0 且无焦点。消费方据此免去逐轮外壳。 */
export function isFlatRound(round: DebateRoundModel): boolean {
  return round.roundNo < 1 && !round.focus;
}

/**
 * 一轮的「交锋信号」(verdict 派生) —— 驱动时间线轴点 / 收敛信号带的配色与语义，让一轮在
 * 「认知推进线」上一眼读出状态：在飞 > 收敛 > 有交锋 > 各说各话 (色板见 `debateSignalDot`)。
 */
export function roundSignal(round: DebateRoundModel): DebateSignal {
  if (round.inFlight) return "inflight";
  if (round.verdict?.converged) return "converged";
  if (round.verdict?.real_clash) return "clash";
  return "quiet";
}

/**
 * 该方是否需要单独显示模型徽章 —— 当一方的**身份名已经包含厂商名**时（后端 roster 取名回退成
 * 模型名，如「原生DeepSeek」并排「DeepSeek」徽章 = 噪音），抑制徽章避免重复；身份名是语义立场
 * （「甜党」「支持方」）时才显，让「谁是哪个模型」这一维真正有信息量、不冗余（用户反馈的「乱」之一）。
 */
export function shouldShowModelBadge(
  name: string,
  model: string | null | undefined,
): boolean {
  const label = modelVendorLabel(model);
  if (!label) return false;
  return !name.toLowerCase().includes(label.toLowerCase());
}

/** 厂商前缀 / 模型名 → 友好厂商名（真·多模型辩论的「谁是哪个模型」展示）。`provider/model` 前缀
 *  优先（doubao/kimi/zhipu）；无前缀按模型名识别（DeepSeek 是默认 provider、无前缀）。空 → null
 *  （不显徽章）。兜底返回前缀或原串，未知模型也给出可读名。映射随接入新厂商在此一处扩展。 */
export function modelVendorLabel(
  model: string | null | undefined,
): string | null {
  const m = (model ?? "").trim();
  if (!m) return null;
  const byPrefix: Record<string, string> = {
    doubao: "豆包",
    kimi: "Kimi",
    zhipu: "智谱",
    deepseek: "DeepSeek",
  };
  const prefix = m.includes("/") ? m.slice(0, m.indexOf("/")) : "";
  if (prefix) return byPrefix[prefix] ?? prefix;
  if (/^deepseek/i.test(m)) return "DeepSeek";
  if (/^doubao/i.test(m)) return "豆包";
  if (/^glm/i.test(m)) return "智谱";
  if (/^kimi/i.test(m)) return "Kimi";
  return m;
}
