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
  DebateClosing,
  DebateCrossExam,
  DebateResultPayload,
  DebateRoundScore,
  DebateRoundSide,
  DebateSideInfo,
  DebateUserInterjection,
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
 * 正反 2 方的**固定对垒色**（`pro`/`con` 语义 key → 专用辩论阵营 token）——取代「按名字 hash
 * 取色」：名字一撞 hash 就同色（真实会话里「加重派」「审慎派」双双落 `--agent-1` → 阵营分不开）。
 * 二元对抗是独立视觉语义，不走 `--agent-N` 身份色板，而用 `--debate-side-pro`（蓝）/
 * `--debate-side-con`（红）——一眼红蓝对垒、与并排左支持/右反对一致，且色相/彩度与状态色分离
 * （见 `packages/design-tokens/tokens.css` · color-tokens.mdc）。多方（圆桌 / 红队 / subject…）无
 * 对立轴 → 落回按名字 hash ({@link agentColorVar})。live↔收场同一 key 恒同色，跨群聊 / 简报一致。
 */
const DEBATE_STANCE_COLOR: Record<string, string> = {
  pro: "var(--debate-side-pro)",
  con: "var(--debate-side-con)",
};

/** 一方的身份色：正反 2 方走固定对垒色（按语义 key），其余按名字 hash。见 {@link DEBATE_STANCE_COLOR}。 */
export function debateSideColorVar(sideKey: string, name: string): string {
  return DEBATE_STANCE_COLOR[sideKey] ?? agentColorVar(name);
}

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
    // 收场权威：本轮承接的用户追问（verbatim 复盘）。缺省（旧产物 / 非交互）→ 空。
    userInterjections: round.user_interjections ?? [],
    // 质询回合（P1）/ 记分裁判（P2）：收场权威，据本轮 sides 解析名字/色、据 answer_run_id 解析
    // 作答 run。缺省（快速对碰 / 旧产物）→ 空，前端不渲染质询区 / 比分。
    crossExam: resolveCrossExam(round.cross_exam, round.sides, execution),
    scores: resolveScores(round.scores, round.sides),
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
        colorVar: debateSideColorVar(side.key, side.name),
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
    // 结辩收束（P4）：收场权威，据 run_id 从执行图解析各方结辩 run。缺省（快速对碰 / 圆桌 / 旧产物）→ 空。
    closings: resolveClosings(debate.closings, execution),
    opening: debate.opening ?? null,
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
    // 进行中无结辩（结辩是收场后一次性 beat，无 live 孪生）；收场由 settledModel 接管。
    closings: [],
    opening: null,
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
      // 进行中无 verbatim 追问 / 质询 / 记分（live 孪生均不带）；收场由 settledModel 接管。
      userInterjections: [],
      crossExam: [],
      scores: [],
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
    colorVar: debateSideColorVar(stance, name),
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
      // 进行中无 verbatim 追问 / 质询 / 记分（live 孪生均不带）；收场由 settledModel 接管。
      userInterjections: [],
      crossExam: [],
      scores: [],
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
    colorVar: debateSideColorVar(sideKey, role),
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
      fromColorVar: debateSideColorVar(c.from_key, fromName),
      toKey: c.to_key,
      toName,
      toColorVar: debateSideColorVar(c.to_key, toName),
      point: c.point,
    });
  }
  return out;
}

/** 把契约的 {@link DebateCrossExam}（语义 key + `answer_run_id` 引用）据本轮 `sides` 解析成可渲染的
 * {@link DebateCrossExamView}（被质询方名字 + 身份色 + 作答 run）。引用不到 side 的交换（防御性）丢弃；
 * `answer_run_id` 从执行图 runs 直取作答辩手节点（作答全文在其 agent.outputChunks，与发言格同源）。 */
function resolveCrossExam(
  cross: readonly DebateCrossExam[] | undefined,
  sides: readonly DebateRoundSide[],
  execution: Execution,
): DebateCrossExamView[] {
  if (!cross || cross.length === 0) return [];
  const keyToName = new Map(sides.map((s) => [s.key, s.name]));
  const out: DebateCrossExamView[] = [];
  for (const cx of cross) {
    const targetName = keyToName.get(cx.target);
    if (!targetName) continue;
    out.push({
      targetKey: cx.target,
      targetName,
      targetColorVar: debateSideColorVar(cx.target, targetName),
      questions: cx.questions ?? [],
      answerRun: execution.runs.find((r) => r.id === cx.answer_run_id) ?? null,
      ok: cx.ok,
    });
  }
  return out;
}

/** 把契约的本轮记分 dict（`sideKey` → {@link DebateRoundScore}）据本轮 `sides` 解析成可渲染的
 * {@link DebateScoreView}[]（按 `sides` 声明序，带名字 + 身份色）。引用不到 side 的记分（防御性）丢弃。 */
function resolveScores(
  scores: Record<string, DebateRoundScore> | undefined,
  sides: readonly DebateRoundSide[],
): DebateScoreView[] {
  if (!scores) return [];
  const out: DebateScoreView[] = [];
  for (const side of sides) {
    const sc = scores[side.key];
    if (!sc) continue;
    out.push({
      sideKey: side.key,
      name: side.name,
      colorVar: debateSideColorVar(side.key, side.name),
      argument: sc.argument,
      engagement: sc.engagement,
      evidence: sc.evidence,
      penalties: sc.penalties ?? [],
      note: sc.note,
      total: sc.total,
    });
  }
  return out;
}

/** 把契约的 {@link DebateClosing}（语义 key + `run_id` 引用）解析成可渲染的 {@link DebateClosingView}
 * （身份名 + 稳定身份色 + 结辩 run）。名字取契约自带（后端 roster 权威），色按 key+name 与发言格同源；
 * `run_id` 从执行图 runs 直取结辩辩手节点（陈词全文在其 agent.outputChunks，与发言格 / 质询作答同源）。 */
function resolveClosings(
  closings: readonly DebateClosing[] | undefined,
  execution: Execution,
): DebateClosingView[] {
  if (!closings || closings.length === 0) return [];
  return closings.map((c) => ({
    sideKey: c.key,
    name: c.name,
    colorVar: debateSideColorVar(c.key, c.name),
    run: execution.runs.find((r) => r.id === c.run_id) ?? null,
    ok: c.ok,
  }));
}

/**
 * 把各轮各方的 {@link DebateScoreView} 累加成每方一个【累计分】（记分裁判 P2，镜像后端
 * `tally_scores`）——三维逐轮相加、罚分全场并起、净分累加，`note` 累计无意义留空。收场「记分总览」
 * 据此呈现势均力敌 / 谁占优（净分驱动 leaning，与实际交锋对齐）。无任何记分（未开启 P2）→ 空数组。
 * 名字/色取该方末次出现的（跨轮稳定）。按各方首次出现序排列（与阵营条一致）。
 */
export function tallyScores(rounds: DebateRoundModel[]): DebateScoreView[] {
  const tally = new Map<string, DebateScoreView>();
  for (const round of rounds) {
    for (const sc of round.scores) {
      const agg = tally.get(sc.sideKey);
      if (!agg) {
        tally.set(sc.sideKey, {
          ...sc,
          penalties: [...sc.penalties],
          note: "",
        });
      } else {
        agg.argument += sc.argument;
        agg.engagement += sc.engagement;
        agg.evidence += sc.evidence;
        agg.penalties.push(...sc.penalties);
        agg.total += sc.total;
        agg.name = sc.name;
        agg.colorVar = sc.colorVar;
      }
    }
  }
  return [...tally.values()];
}

/** 一条扁平旧批次轮 (无主持人逐轮叙事)：轮号 0 且无焦点。消费方据此免去逐轮外壳。 */
export function isFlatRound(round: DebateRoundModel): boolean {
  return round.roundNo < 1 && !round.focus;
}

/** 参辩名册的一方：语义 `sideKey` + 展示名 + 身份色——站队 / 拍板按 `sideKey` 记录用户取舍。 */
export interface DebateRosterSide {
  sideKey: string;
  name: string;
  colorVar: string;
}

/**
 * 从各轮发言**并集**出参辩名册（按语义 `sideKey` 去重、跨轮稳定；`key`=run_id 每轮不同不可用）。
 * live↔收场同一套，故直播段即可用（彼时 `model.sides` roster 尚为空）——站队气泡投票 / 拍板按方
 * 据此定位。空 `sideKey`（多方进行中 narr 未到的发言）跳过。
 */
export function debateRoster(rounds: DebateRoundModel[]): DebateRosterSide[] {
  const seen = new Map<string, DebateRosterSide>();
  for (const round of rounds) {
    for (const s of round.sides) {
      if (s.sideKey && !seen.has(s.sideKey)) {
        seen.set(s.sideKey, {
          sideKey: s.sideKey,
          name: s.name,
          colorVar: s.colorVar,
        });
      }
    }
  }
  return [...seen.values()];
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

/** 一轮的「人话」状态展示态：`label` 是融合后的一句话、`hint` 是悬浮解释（它怎么判出来 / 怎么读）。 */
export interface RoundVerdictView {
  label: string;
  hint: string;
}

/**
 * 把一轮裁判的两个**正交**维度（`real_clash` × `converged`）与收尾原因（`stop_reason`）融成
 * **一句人话**轮状态 + 悬浮解释——根治「各说各话 + 已收敛」并列读起来自相矛盾（用户反馈）：
 *  - **未收敛** → 讲这一轮打成什么样、下一步往哪走；
 *  - **已收敛** → 直接讲【为什么到此为止 / 用户该带走什么】，尤其口味/价值之争（AI 判不了、该交
 *    用户拍板）——把后端每轮已带的 `stop_reason` 兑现成人话，而非压成笼统「已收敛」。
 *
 * `label` / `hint` 同源单一 switch（不漂移）：`label` 入 pill / 脊、`hint` 入 tooltip。
 * 形态感知：圆桌「各方并非针锋相对」是常态（不说「各说各话」、讲铺光谱）、红队是单向施压。
 * 配色仍由 {@link roundSignal} 决定（收敛绿 / 交锋蓝 / 平淡灰），此函数只产**文案**。
 */
export function describeRoundVerdict(
  verdict: DebateVerdict,
  form: DebateForm,
): RoundVerdictView {
  if (verdict.converged) {
    switch (verdict.stop_reason) {
      case "focus_clarified":
        return {
          label: "价值之争 · AI 判不了，看你拍板",
          hint: "分歧落在价值 / 偏好上、没有事实对错，AI 帮不了你做这个选择——交给你拍板。",
        };
      case "red_team_exhausted":
        return {
          label: "风险已挖尽 · 可定夺",
          hint: "风险已基本挖尽、方案方也回应过，可据此定夺。",
        };
      case "all_failed":
        return {
          label: "发言失败 · 提前终止",
          hint: "本轮各方均未产出有效发言，辩论提前终止。",
        };
      default:
        if (form === "roundtable") {
          return {
            label: "观点光谱已铺满 · 见结论",
            hint: "各视角已铺开、不再冒出本质上的新视角，可看结论的观点地图。",
          };
        }
        return verdict.real_clash
          ? {
              label: "交锋充分 · 可出结论",
              hint: "双方已正面交锋、不再产生新论点，可以出结论了。",
            }
          : {
              label: "无更多新论点 · 可收尾",
              hint: "不再产生新论点，辩论可以收尾。",
            };
    }
  }
  if (form === "roundtable") {
    return {
      label: "观点还在铺开",
      hint: "各视角还在补充，观点光谱尚未铺满。",
    };
  }
  if (form === "red_team") {
    return verdict.real_clash
      ? {
          label: "红队施压中 · 方案在回应",
          hint: "红队正在挑刺施压、方案方在回应修补，风险还在挖。",
        }
      : {
          label: "风险还在挖深",
          hint: "风险尚未挖尽，红队还在深挖。",
        };
  }
  return verdict.real_clash
    ? {
        label: "正面交锋 · 还有的辩",
        hint: "双方已针锋相对回应彼此，但仍有新论点，继续辩。",
      }
    : {
        label: "各自亮立场 · 待逼出交锋",
        hint: "本轮双方各自陈述、还没真正接火，下一轮逼出交锋。",
      };
}

/** 辩论收场原因 → 中文（镜像后端 STOP_REASONS）。未知原样渲染。 */
const STOP_LABELS: Record<string, string> = {
  converged: "已收敛",
  focus_clarified: "已澄清为价值之争",
  red_team_exhausted: "风险已挖尽",
  max_rounds: "达轮次上限",
  all_failed: "发言失败提前终止",
  user_concluded: "你叫停出结论",
};

/** 辩论收场原因的人话标签（流末终审 + 右轨裁决台共用；`null` → 「已收场」）。 */
export function stopLabel(reason: string | null): string {
  if (!reason) return "已收场";
  return STOP_LABELS[reason] ?? reason;
}

/**
 * 一句「这是什么」功能说明（形态感知）——给首次用户讲清这场辩论能给他什么，贴在辩论室 / 擂台标题
 * 下。正反给决策简报、红队给风险清单、圆桌给观点地图（与 {@link describeRoundVerdict} 同口径）。
 */
export function debateFormBlurb(form: DebateForm): string {
  switch (form) {
    case "red_team":
      return "红队多角度挑刺施压、方案方回应修补，最后给你按严重度排好的风险清单与加固建议。";
    case "roundtable":
      return "多个 AI 各执一个视角碰撞，最后给你一张铺开各方立场的观点地图，而非强行裁定对错。";
    default:
      return "两个 AI 各执正反、多轮交锋，最后给你一份带倾向与置信度的决策简报——不是单个 AI 的一面之词。";
  }
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
