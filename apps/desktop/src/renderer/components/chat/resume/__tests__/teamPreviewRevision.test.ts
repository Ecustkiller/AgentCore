import { describe, expect, it } from "vitest";
import {
  lookupPreviousTeamPreviewPayload,
  snapshotFromPayload,
  snapshotFromResume,
  teamPreviewRevisionDiff,
} from "../teamPreviewRevision";

const researcher = {
  run_id: "r1",
  role: "研究员",
  task: "调研",
  depends_on: [] as string[],
  write_capability: "can_write_files" as const,
};

const writer = {
  run_id: "r2",
  role: "撰写员",
  task: "写报告",
  depends_on: ["r1"],
  write_capability: "text_only" as const,
};

function resume(over: Record<string, unknown> = {}) {
  return {
    primitive: "delegate" as const,
    workers: [researcher],
    motion: "",
    sides: [],
    ...over,
  };
}

describe("snapshotFromPayload", () => {
  it("空 stub / 无编制形状按缺失", () => {
    expect(snapshotFromPayload(null)).toBeNull();
    expect(snapshotFromPayload({})).toBeNull();
    expect(snapshotFromPayload({ checkpoint_id: "cp1" })).toBeNull();
  });

  it("有 primitive 即可成快照", () => {
    expect(snapshotFromPayload({ primitive: "delegate" })).toEqual({
      primitive: "delegate",
      workers: [],
      motion: "",
      sides: [],
    });
  });
});

describe("lookupPreviousTeamPreviewPayload", () => {
  it("缺 id / 错 kind / 空 payload → null", () => {
    const byId = new Map<
      string,
      { kind?: string; payload?: Record<string, unknown> }
    >([
      ["cp-empty", { kind: "team_preview", payload: {} }],
      ["cp-ask", { kind: "ask_user", payload: { primitive: "delegate" } }],
    ]);
    expect(lookupPreviousTeamPreviewPayload(undefined, byId)).toBeNull();
    expect(lookupPreviousTeamPreviewPayload("cp-missing", byId)).toBeNull();
    expect(lookupPreviousTeamPreviewPayload("cp-empty", byId)).toBeNull();
    expect(lookupPreviousTeamPreviewPayload("cp-ask", byId)).toBeNull();
  });
});

describe("teamPreviewRevisionDiff", () => {
  it("上一版缺失 → unavailable，不编造 diff", () => {
    expect(
      teamPreviewRevisionDiff({
        primitive: "delegate",
        current: snapshotFromResume(resume()),
        previousPayload: null,
      }),
    ).toEqual({ status: "unavailable", lines: [] });
    expect(
      teamPreviewRevisionDiff({
        primitive: "delegate",
        current: snapshotFromResume(resume()),
        previousPayload: {},
      }),
    ).toEqual({ status: "unavailable", lines: [] });
  });

  it("primitive 对不上 → unavailable", () => {
    expect(
      teamPreviewRevisionDiff({
        primitive: "delegate",
        current: snapshotFromResume(resume()),
        previousPayload: {
          primitive: "debate",
          motion: "该不该上四天工作制？",
          sides: [],
        },
      }),
    ).toEqual({ status: "unavailable", lines: [] });
  });

  it("编制相同 → ready 但空行（不写无变化）", () => {
    const diff = teamPreviewRevisionDiff({
      primitive: "delegate",
      current: snapshotFromResume(resume({ workers: [researcher, writer] })),
      previousPayload: {
        primitive: "delegate",
        workers: [researcher, writer],
      },
    });
    expect(diff.status).toBe("ready");
    expect(diff.lines).toEqual([]);
  });

  it("成员增删 + 职责 / 写盘 / 步骤", () => {
    const diff = teamPreviewRevisionDiff({
      primitive: "delegate",
      current: snapshotFromResume(
        resume({
          workers: [
            {
              ...researcher,
              task: "先做竞品",
              write_capability: "text_only",
              depends_on: ["r2"],
            },
            writer,
          ],
        }),
      ),
      previousPayload: {
        primitive: "delegate",
        workers: [researcher],
      },
    });
    expect(diff.status).toBe("ready");
    expect(diff.lines).toEqual([
      "新增 撰写员",
      "研究员：角色/职责有变",
      "研究员：写盘能力有变",
      "研究员：计划步骤有变",
    ]);
  });

  it("run_id 换了但角色仍对得上 → 不当成整队替换", () => {
    const diff = teamPreviewRevisionDiff({
      primitive: "delegate",
      current: snapshotFromResume(
        resume({
          workers: [
            { ...researcher, run_id: "r1b" },
            { ...writer, run_id: "r2b", depends_on: ["r1b"] },
          ],
        }),
      ),
      previousPayload: {
        primitive: "delegate",
        workers: [researcher, writer],
      },
    });
    expect(diff.status).toBe("ready");
    expect(diff.lines).toEqual([]);
  });

  it("辩论：辩题 / 立场 / 辩手", () => {
    const diff = teamPreviewRevisionDiff({
      primitive: "debate",
      current: {
        primitive: "debate",
        workers: [],
        motion: "该不该上四天工作制？",
        sides: [
          { key: "pro", name: "正方", stance: "应推广并立法" },
          { key: "con", name: "反方", stance: "暂缓" },
          { key: "chair", name: "观察方", stance: "中立记录" },
        ],
      },
      previousPayload: {
        primitive: "debate",
        motion: "要不要试点四天工作制？",
        sides: [
          { key: "pro", name: "正方", stance: "应推广" },
          { key: "con", name: "反方", stance: "暂缓" },
        ],
      },
    });
    expect(diff.status).toBe("ready");
    expect(diff.lines).toEqual([
      "辩题有变",
      "新增辩手 观察方",
      "正方：立场有变",
    ]);
  });
});
