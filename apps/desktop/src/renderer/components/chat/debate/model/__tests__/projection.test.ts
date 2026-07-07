import type { AgentState, Execution, RunNode } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import { toDebateModel } from "../projection";

function baseExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    status: "running",
    runs: [],
    agents: [],
    frames: [],
    debate: null,
    debateRounds: [],
    debateDecisions: [],
    teamNotes: [],
    ...overrides,
  } as Execution;
}

describe("toDebateModel live cross-exam", () => {
  it("projects in-flight cross-exam from _cx_ runs and run_context before debate_round", () => {
    const execution = baseExecution({
      runs: [
        {
          id: "mod_r1_pro",
          agentId: "mod_r1_pro",
          status: "completed",
          stance: "pro",
          group: "debate:debate",
          round: 1,
          revision: 1,
          revisionOf: null,
          parentRunId: null,
          kind: "agent",
          receivedContext: [],
        } as unknown as RunNode,
        {
          id: "mod_r1_con",
          agentId: "mod_r1_con",
          status: "completed",
          stance: "con",
          group: "debate:debate",
          round: 1,
          revision: 1,
          revisionOf: null,
          parentRunId: null,
          kind: "agent",
          receivedContext: [],
        } as unknown as RunNode,
        {
          id: "mod_r1_cx_pro",
          agentId: "mod_r1_cx_pro",
          status: "running",
          stance: "pro",
          group: "debate:debate",
          round: 1,
          revision: 2,
          revisionOf: "mod_r1_pro",
          parentRunId: "mod_r1_pro",
          kind: "agent",
          receivedContext: [
            {
              channel: "cross_exam",
              heading: "第 1 轮 · 质询（必须正面回答）",
              body: "- 收益口径是否含尾部风险？\n- 熔断后成本谁承担？",
              chars: 30,
              truncated: false,
              source_role: "",
              source_run_id: "",
              fidelity: "",
              files: [],
            },
          ],
        } as unknown as RunNode,
      ],
      agents: [
        {
          id: "mod_r1_pro",
          role: "支持方",
          status: "completed",
          outputChunks: ["立论全文"],
          reasoningChunks: [],
          currentRunId: null,
          toolProgress: null,
        } as unknown as AgentState,
        {
          id: "mod_r1_cx_pro",
          role: "支持方",
          status: "working",
          outputChunks: ["作答：口径未含尾部"],
          reasoningChunks: [],
          currentRunId: "mod_r1_cx_pro",
          toolProgress: null,
        } as unknown as AgentState,
      ],
      debateRounds: [
        {
          round_no: 1,
          focus: "收益与风险",
          summary: "",
          verdict: null,
          sides: [],
          clashes: [],
        },
      ],
    });

    const model = toDebateModel(execution);
    expect(model).not.toBeNull();
    if (!model) throw new Error("expected debate model");
    expect(model.settled).toBe(false);
    const round = model.rounds[0];
    expect(round).toBeDefined();
    if (!round) throw new Error("expected round");
    expect(round.crossExam).toHaveLength(1);
    expect(round.crossExam[0].targetKey).toBe("pro");
    expect(round.crossExam[0].exchanges).toHaveLength(2);
    expect(round.crossExam[0].exchanges[0].question).toContain("尾部风险");
    expect(round.crossExam[0].answerRun?.status).toBe("running");
  });

  it("prefers debate_round cross_exam over run reconstruction after round completes", () => {
    const execution = baseExecution({
      runs: [
        {
          id: "mod_r1_cx_pro",
          agentId: "mod_r1_cx_pro",
          status: "completed",
          stance: "pro",
          group: "debate:debate",
          round: 1,
          revision: 2,
          revisionOf: "mod_r1_pro",
          parentRunId: "mod_r1_pro",
          kind: "agent",
          receivedContext: [
            {
              channel: "cross_exam",
              heading: "质询",
              body: "- Q1?",
              chars: 4,
              truncated: false,
              source_role: "",
              source_run_id: "",
              fidelity: "",
              files: [],
            },
          ],
        } as unknown as RunNode,
      ],
      agents: [
        {
          id: "mod_r1_cx_pro",
          role: "支持方",
          status: "completed",
          outputChunks: ["流式启发式可能不同的全文"],
          reasoningChunks: [],
          currentRunId: null,
          toolProgress: null,
        } as unknown as AgentState,
      ],
      debateRounds: [
        {
          round_no: 1,
          focus: "焦点",
          summary: "小结",
          verdict: {
            real_clash: true,
            new_arguments: false,
            converged: true,
            stop_reason: "converged",
            rationale: "r",
          },
          sides: [
            { key: "pro", name: "支持方", run_id: "mod_r1_pro", ok: true },
          ],
          clashes: [],
          cross_exam: [
            {
              target: "pro",
              questioner: "",
              exchanges: [
                { question: "Q1?", answer: "后端解析的权威答案", ok: true },
              ],
              answer_run_id: "mod_r1_cx_pro",
            },
          ],
        },
      ],
    });

    const model = toDebateModel(execution);
    expect(model).not.toBeNull();
    const answer = model?.rounds[0]?.crossExam[0]?.exchanges[0]?.answer;
    expect(answer).toBe("后端解析的权威答案");
  });
});
