import { describe, expect, it } from "vitest";
import { buildAgentNodePresentation } from "../presentation";
import {
  type AgentNodeData,
  buildRevisionBadge,
  revisionFaceHint,
  revisionFeedbackSummary,
  revisionVersionBadge,
  statusFaceLabel,
} from "../shared";

describe("statusFaceLabel", () => {
  it("shows 排队中 for pending and ready", () => {
    expect(statusFaceLabel("pending", null).text).toBe("排队中");
    expect(statusFaceLabel("ready", null).text).toBe("排队中");
  });

  it("shows live elapsed for running workers", () => {
    const face = statusFaceLabel("running", null, 45);
    expect(face.text).toBe("执行中 · 45s");
    expect(face.tickElapsed).toBe(true);
  });

  it("omits elapsed suffix before 1 second", () => {
    expect(statusFaceLabel("running", null, 0).text).toBe("执行中");
  });

  it("shows completion duration for finished runs", () => {
    expect(statusFaceLabel("completed", 45_000).text).toBe("已完成 · 45s");
    expect(statusFaceLabel("completed", null).text).toBe("已完成");
  });

  it("shows failure and cancelled states", () => {
    expect(statusFaceLabel("failed", null).text).toBe("失败");
    expect(statusFaceLabel("cancelled", null).text).toBe("已停止");
  });
});

describe("revisionVersionBadge", () => {
  it("returns vN for hot-fix revision nodes only", () => {
    expect(revisionVersionBadge(0)).toBeNull();
    expect(revisionVersionBadge(1)).toBeNull();
    expect(revisionVersionBadge(2)).toBe("v2");
    expect(revisionVersionBadge(3)).toBe("v3");
  });
});

describe("revisionFeedbackSummary", () => {
  it("reads body from channel=revision", () => {
    expect(
      revisionFeedbackSummary([
        { channel: "task", body: "起草" },
        { channel: "revision", body: "  补一段风险对冲，并收紧结论口径。  " },
      ]),
    ).toBe("补一段风险对冲，并收紧结论口径。");
  });

  it("returns null when revision block missing or empty", () => {
    expect(revisionFeedbackSummary([{ channel: "task", body: "起草" }])).toBeNull();
    expect(
      revisionFeedbackSummary([{ channel: "revision", body: "   " }]),
    ).toBeNull();
    expect(revisionFeedbackSummary(undefined)).toBeNull();
  });
});

describe("buildRevisionBadge", () => {
  it("hot-fix keeps pencil semantics (vN + 热修修订 title)", () => {
    expect(
      buildRevisionBadge({
        isRevision: true,
        revision: 2,
        isDebate: false,
      }),
    ).toEqual({
      kind: "hotfix",
      label: "v2",
      title: "热修修订 v2",
    });
  });

  it("debate continuation uses 第 N 轮 (round preferred)", () => {
    expect(
      buildRevisionBadge({
        isRevision: true,
        revision: 2,
        round: 3,
        isDebate: true,
      }),
    ).toEqual({
      kind: "debate",
      label: "第 3 轮",
      title: "第 3 轮",
    });
  });

  it("debate falls back to revision when round missing", () => {
    expect(
      buildRevisionBadge({
        isRevision: true,
        revision: 2,
        round: 0,
        isDebate: true,
      })?.label,
    ).toBe("第 2 轮");
  });

  it("skips v1 / non-revision", () => {
    expect(
      buildRevisionBadge({ isRevision: false, revision: 2, isDebate: false }),
    ).toBeNull();
    expect(
      buildRevisionBadge({ isRevision: true, revision: 1, isDebate: false }),
    ).toBeNull();
  });
});

function baseNode(extra: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    agentId: "a1",
    role: "撰写员",
    runId: "r1",
    status: "completed",
    isAnimating: false,
    task: "起草",
    outputPreview: "",
    tokenCount: 0,
    toolCount: 0,
    focused: false,
    ...extra,
  };
}

describe("buildAgentNodePresentation revision face", () => {
  it("hot-fix V2 exposes 按指示 hint and hotfix badge", () => {
    const p = buildAgentNodePresentation(
      baseNode({
        isRevision: true,
        revision: 2,
        revisionSummary: "补一段风险对冲",
      }),
    );
    expect(p.revisionBadge).toEqual({
      kind: "hotfix",
      label: "v2",
      title: "热修修订 v2",
    });
    expect(p.revisionFaceHint).toBe("按指示：补一段风险对冲");
    expect(p.peekTags).toContain("热修修订 v2");
  });

  it("debate continuation badge is 第 N 轮 without 热修修订", () => {
    const p = buildAgentNodePresentation(
      baseNode({
        isRevision: true,
        revision: 2,
        round: 2,
        stance: "pro",
        revisionSummary: "应被忽略的热修文案",
      }),
    );
    expect(p.revisionBadge).toEqual({
      kind: "debate",
      label: "第 2 轮",
      title: "第 2 轮",
    });
    expect(p.revisionFaceHint).toBeNull();
    expect(p.peekTags).toContain("第 2 轮");
    expect(p.peekTags.some((t) => t.includes("热修"))).toBe(false);
  });

  it("debate via group=debate:* without stance", () => {
    const p = buildAgentNodePresentation(
      baseNode({
        isRevision: true,
        revision: 2,
        round: 2,
        group: "debate:topic-1",
      }),
    );
    expect(p.revisionBadge?.kind).toBe("debate");
    expect(p.revisionBadge?.label).toBe("第 2 轮");
  });
});

describe("revisionFaceHint", () => {
  it("prefixes 按指示", () => {
    expect(revisionFaceHint("收紧结论")).toBe("按指示：收紧结论");
    expect(revisionFaceHint(null)).toBeNull();
  });
});
