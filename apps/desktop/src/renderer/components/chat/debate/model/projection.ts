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
  DebateClash,
  DebateClosing,
  DebateCrossExam,
  DebateNarrativeRound,
  DebateResultPayload,
  DebateRoundScore,
  DebateRoundSide,
} from "@/types/events";
import { parseCrossExamResponse } from "./crossExamParse";
import { debateSideColorVar } from "./labels";
import type {
  DebateClashView,
  DebateClosingView,
  DebateCrossExamView,
  DebateForm,
  DebateModel,
  DebateRosterSide,
  DebateRoundModel,
  DebateScoreView,
  DebateSideModel,
} from "./types";

/** 质询作答 run id 后缀：``{moderator}_r{round}_cx_{side_key}``（与 DebateTool 同策）。 */
const CX_RUN_ID_RE = /_r(\d+)_cx_(.+)$/;

function parseCrossExamRunId(
  runId: string,
): { roundNo: number; targetKey: string } | null {
  const m = runId.match(CX_RUN_ID_RE);
  if (!m) return null;
  return { roundNo: Number(m[1]), targetKey: m[2] };
}

/** 从质询作答 run 的 ``run_context`` 块解析主持人发出的必答问题列表。 */
function crossExamQuestionsFromRun(run: RunNode): string[] {
  const block = run.receivedContext.find((b) => b.channel === "cross_exam");
  if (!block?.body.trim()) return [];
  return block.body
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

/** 进行中：从执行图里的 ``_cx_`` 作答 run 重建本轮质询载荷（问题来自 run_context，作答来自
 * outputChunks 经 {@link parseCrossExamResponse} 解析）。``debate_round.cross_exam`` 未到时
 * 这是 live 质询区的唯一数据源——收场后改走结构化 ``exchanges[]``。 */
function liveCrossExamPayload(
  execution: Execution,
  roundNo: number,
): DebateCrossExam[] {
  const out: DebateCrossExam[] = [];
  for (const run of execution.runs) {
    const parsed = parseCrossExamRunId(run.id);
    if (!parsed || parsed.roundNo !== roundNo) continue;
    const questions = crossExamQuestionsFromRun(run);
    if (questions.length === 0) continue;
    const blob = runOutputText(execution, run);
    out.push({
      target: parsed.targetKey,
      questioner: "",
      exchanges: parseCrossExamResponse(questions, blob),
      answer_run_id: run.id,
    });
  }
  return out;
}

/** 为本轮质询解析 side 名录：优先 narr.sides，不足时从发言格 / 作答 run 补全。 */
function roundSidesForCrossExam(
  execution: Execution,
  narr: DebateNarrativeRound | null,
  sideModels: DebateSideModel[],
): DebateRoundSide[] {
  const byKey = new Map<string, DebateRoundSide>();
  for (const s of narr?.sides ?? []) {
    if (s.key) byKey.set(s.key, s);
  }
  for (const s of sideModels) {
    if (!s.sideKey || byKey.has(s.sideKey)) continue;
    byKey.set(s.sideKey, {
      key: s.sideKey,
      name: s.name,
      run_id: s.run?.id ?? "",
      ok: s.run?.status === "completed",
    });
  }
  for (const run of execution.runs) {
    const parsed = parseCrossExamRunId(run.id);
    if (!parsed || byKey.has(parsed.targetKey)) continue;
    const agent = execution.agents.find((a) => a.id === run.agentId);
    byKey.set(parsed.targetKey, {
      key: parsed.targetKey,
      name: agent?.role ?? parsed.targetKey,
      run_id: run.id,
      ok: run.status === "completed",
    });
  }
  return [...byKey.values()];
}

/** 进行中质询投影：``debate_round.cross_exam`` 权威优先；质询 beat 进行中则从 ``_cx_`` run 重建。 */
function resolveLiveCrossExam(
  execution: Execution,
  roundNo: number,
  narr: DebateNarrativeRound | null,
  sideModels: DebateSideModel[],
): DebateCrossExamView[] {
  const sides = roundSidesForCrossExam(execution, narr, sideModels);
  const payload =
    narr && narr.cross_exam.length > 0
      ? narr.cross_exam
      : liveCrossExamPayload(execution, roundNo);
  return resolveCrossExam(payload, sides, execution);
}

function runOutputText(execution: Execution, run: RunNode | null): string {
  if (!run) return "";
  const agent = execution.agents.find((a) => a.id === run.agentId);
  return agent ? agent.outputChunks.join("") : "";
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
  // roster (debate.sides) 仅身份/立场；辩手 model 从 run 节点取（MVP 统一 turn model，§7.5）。
  const rounds: DebateRoundModel[] = debate.rounds.map((round) => ({
    roundNo: round.round_no,
    focus: round.focus,
    summary: round.summary,
    verdict: round.verdict,
    inFlight: false,
    clashes: resolveClashes(round.clashes, round.sides),
    userInterjections: round.user_interjections,
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
        model: run?.model ?? "",
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
    closings: resolveClosings(debate.closings, execution),
    opening: debate.opening || null,
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
      // 进行中无 verbatim 追问 / 记分（live 孪生均不带）；质询由 resolveLiveCrossExam 重建。
      userInterjections: [],
      crossExam: resolveLiveCrossExam(execution, roundNo, narr, sides),
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
    model: run.model ?? "",
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
    const sideModels = runs.map((run) =>
      multiSide(run, execution, keyByRunId.get(run.id) ?? ""),
    );
    rounds.push({
      roundNo,
      focus: narr?.focus ?? "",
      summary: narr?.summary ?? "",
      verdict: narr?.verdict ?? null,
      inFlight: !narr?.verdict,
      clashes: resolveClashes(narr?.clashes, narr?.sides ?? []),
      sides: sideModels,
      // 进行中无 verbatim 追问 / 记分（live 孪生均不带）；质询由 resolveLiveCrossExam 重建。
      userInterjections: [],
      crossExam: resolveLiveCrossExam(execution, roundNo, narr, sideModels),
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
    model: run.model ?? "",
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
 * {@link DebateCrossExamView}（被质询方名字 + 身份色 + 逐条 Q↔A + 作答 run）。引用不到 side 的交换
 * （防御性）丢弃。权威路径直接消费 ``exchanges[]``；live 流式在 answer 未落盘时从 run blob 补全 JSON 作答。 */
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
    const answerRun =
      execution.runs.find((r) => r.id === cx.answer_run_id) ?? null;
    const blob = runOutputText(execution, answerRun);
    const streaming = answerRun?.status === "running";

    let exchanges = cx.exchanges ?? [];
    if (streaming && blob && exchanges.some((ex) => !ex.answer.trim())) {
      // live 流式：契约已有问题列表但 answer 尚未落盘，从 run blob 补全。
      const parsed = parseCrossExamResponse(
        exchanges.map((e) => e.question),
        blob,
      );
      exchanges = exchanges.map((ex, i) =>
        ex.answer.trim() ? ex : (parsed[i] ?? ex),
      );
    }

    out.push({
      targetKey: cx.target,
      targetName,
      targetColorVar: debateSideColorVar(cx.target, targetName),
      exchanges: exchanges.map((ex) => ({
        question: ex.question,
        answer: ex.answer,
        ok: ex.ok,
      })),
      answerRun,
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
