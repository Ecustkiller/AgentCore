import {
  type DebateModel,
  toDebateModel,
} from "@/components/chat/debate/model";
import { Button } from "@/components/ui";
import {
  type Execution,
  type RevisionChain,
  isDebate,
  revisionChains,
} from "@/stores/execution";
import { Columns2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ComparePane } from "./ComparePane";
import {
  ArenaPlaceholder,
  DebateOverview,
  DebateVerdict,
} from "./DebateOverview";
import { RevisionOverview } from "./RevisionOverview";
import { type ResolvedCell, debateCells, revisionCells } from "./cells";

/** 本回合的对比形态：正反 2 方辩论 → 逐轮擂台矩阵；定向唤回修订 → 版本轨；两者皆无 → 不出。
 * 多轮辩论的每轮后端即用「续写 revision」建模，故两者数据本就重叠——辩论回合优先走擂台矩阵
 * （更富语义：脊 / 交锋 / 终审），版本轨只承载「非正反辩论」的修订链。 */
type CompareShape = "debate" | "revision";

/**
 * 统一「对比」透镜（前端UX设计.md §4.1/§4.2）—— 把原「对比擂台」（辩论逐轮左右对开）与「版本对比」
 * （定向唤回版本链）**收敛成同一个透镜**：一层**形态自适应纵览**（辩论=擂台矩阵含脊/交锋/终审；
 * 修订=版本轨）+ 一层**内容自适应精读**（点任意两格 → 同一个 {@link ComparePane}：读作编辑给真·文本
 * diff、否则 2-up 渲染）。二者共享格子外壳、pick-two 选择、对比面——不是两个透镜、也不是加模式开关，
 * 而是「一个对比透镜、纵览随形态变、对比面随内容变」。
 *
 * 挂载于画布放大态的「对比」页（{@link import("../../graph/CanvasZoomedTurn").CanvasZoomedTurn}）与聚焦
 * 节点脚抽屉（{@link import("../../graph/FocusedTurnNode").FocusedTurnNode}，仅非辩论修订）。纯投影：读
 * 同一份 {@link Execution}，live / 回放渲染一致。
 */
export function TurnCompare({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  const chains = useMemo(() => revisionChains(execution), [execution]);
  const debateModel = useMemo(() => toDebateModel(execution), [execution]);
  // 正反 2 方辩论（form==="debate"）→ 擂台矩阵；否则有修订链 → 版本轨。多方圆桌 / 红队（form!=debate）
  // 也走版本轨（其每轮亦是续写 revision，chains 非空）。
  const isTwoSideDebate = isDebate(execution) && debateModel?.form === "debate";
  const shape: CompareShape | null = isTwoSideDebate
    ? "debate"
    : chains.length > 0
      ? "revision"
      : null;

  // 当前形态的可选取单元（display order）——供 A/B pair 解析与默认对定序共用同一顺序。
  const cells = useMemo<ResolvedCell[]>(() => {
    if (shape === "debate" && debateModel)
      return debateCells(execution, debateModel);
    if (shape === "revision") return revisionCells(execution, chains);
    return [];
  }, [shape, execution, debateModel, chains]);

  // 对比模式：单链恰 2 版的经典修订（原始 × 最新）直接进对比开 diff；其余默认关（辩论先读矩阵）。
  const [compareMode, setCompareMode] = useState<boolean>(
    shape === "revision" &&
      chains.length === 1 &&
      chains[0].versions.length === 2,
  );
  const [pair, setPair] = useState<[string, string]>(() =>
    defaultPair(shape, cells, chains, debateModel),
  );

  if (shape === null) return null;
  if (shape === "debate") {
    // 擂台需收场 roster（含立场）才能起列头；进行中 / 非 2 方给占位（无工具栏、无对比）。
    const ready =
      !!debateModel?.settled && (debateModel.sides?.length ?? 0) === 2;
    if (!ready || !debateModel) {
      return <ArenaPlaceholder settled={!!debateModel?.settled} />;
    }
  }

  const pick = (runId: string) =>
    // 保留最近点的两个不同格（新点 → B / 右槽）。
    setPair(([a, b]) => (a === runId || b === runId ? [a, b] : [b, runId]));

  const toggleCompare = () =>
    setCompareMode((on) => {
      const next = !on;
      if (next) setPair(defaultPair(shape, cells, chains, debateModel));
      return next;
    });

  // display order 定序：同数组里下标小者为 A（同一场里早轮 / 同链低版本在前），对比面与格子徽章一致。
  const byId = new Map(cells.map((c) => [c.run.id, c]));
  const idxOf = (id: string) => cells.findIndex((c) => c.run.id === id);
  const ordered: [string, string] =
    idxOf(pair[0]) <= idxOf(pair[1]) ? [pair[0], pair[1]] : [pair[1], pair[0]];
  const ra = byId.get(ordered[0]) ?? null;
  const rb = byId.get(ordered[1]) ?? null;

  const summary =
    shape === "debate" && debateModel
      ? `${debateModel.rounds.length} 轮 · 正反对比`
      : chains.length > 1
        ? `${chains.length} 方 · 共 ${chains.reduce((n, c) => n + c.versions.length, 0)} 版`
        : `${chains[0]?.versions.length ?? 0} 版`;
  const hint = compareMode
    ? shape === "debate"
      ? "点发言选 A / B（可跨轮跨方）"
      : "点版本卡选 A / B（可跨方）"
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{summary}</span>
        {hint && (
          <span className="text-xs text-muted-foreground/70">{hint}</span>
        )}
        <div className="flex-1" />
        <Button
          variant={compareMode ? "primary" : "neutral"}
          size="sm"
          onClick={toggleCompare}
        >
          {compareMode ? <X size={13} /> : <Columns2 size={13} />}
          {compareMode
            ? "退出对比"
            : shape === "debate"
              ? "对比发言"
              : "对比两版"}
        </Button>
      </div>

      {shape === "debate" && debateModel ? (
        <DebateOverview
          model={debateModel}
          execution={execution}
          messageId={messageId}
          compareMode={compareMode}
          pair={ordered}
          onPick={pick}
        />
      ) : (
        <RevisionOverview
          chains={chains}
          execution={execution}
          messageId={messageId}
          compareMode={compareMode}
          pair={ordered}
          onPick={pick}
        />
      )}

      {compareMode && <ComparePane a={ra} b={rb} messageId={messageId} />}

      {/* 擂台读完（可选对比后）末尾补主持人终审，与群聊主视图同构——在此较真完也能直接读到裁决。 */}
      {shape === "debate" && debateModel && (
        <DebateVerdict
          model={debateModel}
          execution={execution}
          messageId={messageId}
        />
      )}
    </div>
  );
}

/**
 * 进入对比时的预选对：
 *  - 修订：≥2 链 → 各取前两链的最新（撰写员终稿 × 审阅员终稿…）；单链 → 原始 × 最新（经典 diff）。
 *  - 辩论：末轮的 正方 × 反方（支持方最新发言 × 反对方最新发言）；退化则取头两格。
 */
function defaultPair(
  shape: CompareShape | null,
  cells: ResolvedCell[],
  chains: RevisionChain[],
  model: DebateModel | null,
): [string, string] {
  if (cells.length === 0) return ["", ""];
  const latestRun = (c: RevisionChain) =>
    c.versions[c.versions.length - 1].run.id;
  if (shape === "revision") {
    if (chains.length >= 2) return [latestRun(chains[0]), latestRun(chains[1])];
    const c = chains[0];
    return [c.versions[0].run.id, latestRun(c)];
  }
  if (shape === "debate" && model) {
    for (let i = model.rounds.length - 1; i >= 0; i--) {
      const r = model.rounds[i];
      const pro = r.sides.find((s) => s.stance === "pro" && s.run);
      const con = r.sides.find((s) => s.stance === "con" && s.run);
      if (pro?.run && con?.run) return [pro.run.id, con.run.id];
    }
  }
  return [cells[0].run.id, cells[Math.min(1, cells.length - 1)].run.id];
}
