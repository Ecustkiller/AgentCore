import type { components } from "@/types/api.generated";
import type { DebateModel } from "./model";

/**
 * 续辩种子（结构化补轮·B / 可逆叫停，辩论编排设计.md §6.6）。
 *
 * = 云链路 `SendMessageRequest.debate_seed` 同一生成类型（snake_case，逐字对齐引擎
 * `DebateSeed.from_payload`）；sidecar 链路经 IPC 原样透传。从一场【已收场】的辩论视图模型
 * （{@link DebateModel}）投影成的最小形：只带过程摘要（逐轮焦点/小结）+ 简报关键项，**不带
 * 辩手全文**（全文体量大、随辩手 run 走执行事件，续辩不需要）。
 */
export type DebateSeed = components["schemas"]["DebateSeedInput"];

/**
 * 把一场【已收场】的辩论投影成续辩种子；进行中 / 无实质内容 → `null`（不播种）。
 *
 * 「无实质内容」与引擎 `from_payload` 的回退口径一致：没有任何轮次摘要、最强论点、未决分歧
 * 时不值得播种（续辩退化成全新辩论）。逐轮只取有焦点 / 小结的轮，避免把空轮喂进种子。
 */
export function projectDebateSeed(model: DebateModel): DebateSeed | null {
  if (!model.settled) return null;

  const rounds = model.rounds
    .filter((r) => r.focus || r.summary)
    .map((r) => ({ round_no: r.roundNo, focus: r.focus, summary: r.summary }));

  const brief = model.brief;
  const seedBrief = {
    crux: brief?.crux ?? "",
    leaning: brief?.leaning ?? "",
    strongest_points: brief?.strongest_points ?? {},
    value_disputes: brief?.value_disputes ?? [],
    open_questions: brief?.open_questions ?? [],
  };

  const hasSubstance =
    rounds.length > 0 ||
    Object.keys(seedBrief.strongest_points).length > 0 ||
    seedBrief.value_disputes.length > 0 ||
    seedBrief.open_questions.length > 0;
  if (!hasSubstance) return null;

  return {
    motion: model.motion ?? "",
    rounds,
    brief: seedBrief,
  };
}
